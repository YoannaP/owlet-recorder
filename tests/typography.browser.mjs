import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const python = process.env.PYTHON || ".venv/bin/python";
const data = mkdtempSync("/private/tmp/owlet-typography-data-");
const captures = mkdtempSync("/private/tmp/owlet-typography-review-");
const port = 18515;
const failures = [];
const contrastMeasurements = [];
let server;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE,
  headless: true,
});
async function audit(page, label) {
  const targets = await page.evaluate(() =>
    [
      ...(document.querySelector("dialog[open]") || document).querySelectorAll(
        "a, button, summary, select, [role=slider]",
      ),
    ]
      .filter((node) => node.getClientRects().length && !node.disabled)
      .map((node) => {
        const box = node.getBoundingClientRect();
        return {
          label: node.getAttribute("aria-label") || node.textContent.trim(),
          width: box.width,
          height: box.height,
          primary: node.matches(
            "nav a, #expand, #closeExpanded, #latestNight, #openNight, #expandedOpenNight",
          ),
        };
      }),
  );
  for (const target of targets) {
    const minimum = target.primary ? 44 : 24;
    if (target.width < minimum || target.height < minimum)
      failures.push(
        `${label}: target ${target.label} is ${target.width}×${target.height}, needs ${minimum}`,
      );
  }
  const bitmap = await page.screenshot();
  const contrast = await page.evaluate(
    async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const luminance = (rgb) =>
        rgb
          .slice(0, 3)
          .map((value) => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          })
          .reduce(
            (sum, value, index) =>
              sum + value * [0.2126, 0.7152, 0.0722][index],
            0,
          );
      return [
        ...(
          document.querySelector("dialog[open]") || document
        ).querySelectorAll(
          ".status span, .caption, .reading-label, #battery, .chart-meta span, footer, nav a, button, summary, .chart-readout, .eyebrow, .value, .chart-stat, h1, h2",
        ),
      ]
        .filter((node) => {
          const box = node.getBoundingClientRect();
          return (
            node.getClientRects().length &&
            !node.disabled &&
            box.left >= 0 &&
            box.top >= 0 &&
            box.right <= innerWidth &&
            box.bottom <= innerHeight
          );
        })
        .map((node) => {
          const box = node.getBoundingClientRect(),
            style = getComputedStyle(node);
          const foreground = style.color.match(/[\d.]+/g).map(Number);
          // Sample empty padding above glyphs in the actual rendered background,
          // retaining the ambient gradient instead of assuming a flat CSS color.
          const background = [
            ...context.getImageData(
              Math.floor(
                box.left + (node.matches("nav a") ? box.width / 2 : 3),
              ),
              Math.floor(box.top + 1),
              1,
              1,
            ).data,
          ];
          const a = luminance(foreground),
            b = luminance(background);
          const indicators = [
            ...(node.matches(":focus-visible") ? [style.outlineColor] : []),
            ...(node.matches('.metric-tabs [aria-selected="true"]')
              ? [style.borderBottomColor]
              : []),
          ].map((color) => {
            const value = luminance(color.match(/[\d.]+/g).map(Number));
            return (Math.max(value, b) + 0.05) / (Math.min(value, b) + 0.05);
          });
          return {
            text: node.textContent.trim().slice(0, 60),
            ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
            minimum: parseFloat(style.fontSize) >= 24 ? 3 : 4.5,
            indicators,
          };
        });
    },
    `data:image/png;base64,${bitmap.toString("base64")}`,
  );
  for (const item of contrast)
    if (item.ratio < item.minimum)
      failures.push(
        `${label}: contrast ${item.ratio.toFixed(2)} for ${item.text}`,
      );
  contrastMeasurements.push(...contrast);
  for (const item of contrast)
    if (item.indicators.some((value) => value < 3))
      failures.push(
        `${label}: focus/current indicator below3:1 for ${item.text}`,
      );
  for (const handle of await page.getByRole("slider").all()) {
    if (!(await handle.isVisible())) continue;
    await handle.scrollIntoViewIfNeeded();
    const reachable = await handle.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      return [-11.5, 0, 11.5].every((x) =>
        [-11.5, 0, 11.5].every((y) =>
          node.contains(document.elementFromPoint(center.x + x, center.y + y)),
        ),
      );
    });
    if (!reachable)
      failures.push(
        `${label}: ${await handle.getAttribute("aria-label")} does not expose an actual reachable 24px hit area`,
      );
  }
  const overlap = await page.evaluate(() => {
    const chart =
      document.querySelector("dialog[open] #expandedPlot") ||
      document.querySelector("#plot");
    const ticks = [...chart.querySelectorAll(".xtick text")]
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, text: node.textContent };
      })
      .sort((a, b) => a.left - b.left);
    return {
      ticks,
      width: chart.querySelector(".bglayer .bg")?.getBoundingClientRect().width,
      overlaps: ticks.some(
        (tick, index) => index && tick.left < ticks[index - 1].right - 0.5,
      ),
    };
  });
  if (overlap.overlaps)
    failures.push(
      `${label}: horizontal time labels overlap ${JSON.stringify(overlap)}`,
    );
}
try {
  for (const kind of ["live", "night"]) {
    const database = `${data}/${kind}.db`;
    const fixture = spawnSync(
      python,
      [
        `tests/${kind}_fixture.py`,
        database,
        ...(kind === "live" ? ["--state", "monitoring"] : []),
      ],
      { encoding: "utf8" },
    );
    assert.equal(fixture.status, 0, fixture.stderr);
    server = spawn(
      python,
      ["server.py", "--port", String(port), "--db", database, "--timezone", "Europe/London"],
      { stdio: "ignore" },
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const route of kind === "live"
      ? ["/"]
      : ["/week?date=2026-09-13", "/trends"]) {
      const destination =
        route === "/" ? "live" : route.startsWith("/week") ? "night" : "trends";
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 360, height: 780 },
        { width: 1440, height: 1000 },
        { width: 195, height: 422 },
      ]) {
        const page = await browser.newPage({
          viewport,
          timezoneId: "Europe/London",
        });
        await page.goto(`http://127.0.0.1:${port}${route}`);
        await page.waitForSelector("#plot.js-plotly-plot");
        await page.waitForFunction(
          () =>
            !document.querySelector("#status").textContent.includes("Loading"),
        );
        const clipped = await page.evaluate(() => {
          const list = document
            .querySelector('[role="tablist"]')
            .getBoundingClientRect();
          return [...document.querySelectorAll('[role="tab"]')]
            .filter((tab) => {
              const box = tab.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(tab);
              return (
                box.left < list.left ||
                box.right > list.right + 1 ||
                [...range.getClientRects()].some(
                  (text) => text.left < box.left || text.right > box.right + 1,
                )
              );
            })
            .map((tab) => tab.textContent.trim());
        });
        if (clipped.length)
          failures.push(
            `${destination} ${viewport.width}: clipped metrics ${clipped.join(", ")}`,
          );
        if (destination === "night") {
          const hierarchy = await page.evaluate(() => {
            const sleep = document.querySelector("#recordedSleep");
            const coverage = document.querySelector("#coverage");
            return {
              sleep: parseFloat(getComputedStyle(sleep).fontSize),
              coverage: parseFloat(getComputedStyle(coverage).fontSize),
              context: document.querySelector("#coverageCaption").textContent,
              adjacent: coverage.parentElement.contains(
                document.querySelector("#coverageCaption"),
              ),
            };
          });
          if (hierarchy.coverage > hierarchy.sleep * 0.7)
            failures.push(
              `Night ${viewport.width}: coverage ${hierarchy.coverage}px competes with sleep ${hierarchy.sleep}px`,
            );
          assert(
            hierarchy.adjacent &&
              hierarchy.context.includes("20:00 to 06:00") &&
              hierarchy.context.includes("42 m missing"),
            "coverage interval/missing context is not adjacent and readable",
          );
        }
        const typeAndIcons = await page.evaluate(() => {
          const small = [
            ...document.querySelectorAll(
              ".status, .caption, .chart-meta, .reading-label, .device, footer, nav a, .periods button, .metric-tabs button",
            ),
          ]
            .filter(
              (node) =>
                node.getClientRects().length &&
                parseFloat(getComputedStyle(node).fontSize) < 13,
            )
            .map(
              (node) =>
                `${node.tagName}.${node.className}: ${getComputedStyle(node).fontSize}`,
            );
          const links = [...document.querySelectorAll("nav a")];
          const icons = links.map(
            (link) => link.querySelector("svg")?.innerHTML,
          );
          const units = [
            ...document.querySelectorAll(".chart-stat small"),
          ].filter(
            (unit) =>
              parseFloat(getComputedStyle(unit).fontSize) >
              parseFloat(getComputedStyle(unit.parentElement).fontSize) * 0.6,
          );
          return {
            small,
            icons,
            labels: links.map((link) => link.textContent.trim()),
            units: units.length,
          };
        });
        if (typeAndIcons.small.length)
          failures.push(
            `${destination} ${viewport.width}: small essential text ${typeAndIcons.small.join(", ")}`,
          );
        if (
          typeAndIcons.icons.some((icon) => !icon) ||
          new Set(typeAndIcons.icons).size !== 3
        )
          failures.push(
            `${destination}: navigation icons are not distinct code-native SVGs`,
          );
        if (typeAndIcons.units)
          failures.push(`${destination}: chart units compete with values`);
        await page.screenshot({
          path: `${captures}/${destination}-${viewport.width}.png`,
        });
        await page.getByRole("link", { name: "Live", exact: true }).focus();
        assert(
          await page
            .locator("nav a[aria-current]")
            .evaluate((node) =>
              getComputedStyle(node).textDecorationLine.includes("underline"),
            ),
          "current destination has no non-color marker",
        );
        assert(
          await page
            .getByRole("link", { name: "Live", exact: true })
            .evaluate((node) => getComputedStyle(node).outlineStyle !== "none"),
          "navigation focus is not visible",
        );
        await audit(page, `${destination} ${viewport.width}`);
        await page.getByRole("button", { name: "Explore chart" }).click();
        await page.waitForSelector("#expandedPlot.js-plotly-plot");
        await audit(page, `${destination} expanded ${viewport.width}`);
        if (viewport.width === 1440) {
          await page.setViewportSize({ width: 195, height: 422 });
          await page.waitForFunction(
            () =>
              document
                .querySelector("#expandedPlot .svg-container")
                .getBoundingClientRect().width < 195,
          );
          await page.waitForTimeout(200);
          await audit(page, `${destination} resized expanded195`);
          await page.screenshot({
            path: `${captures}/${destination}-expanded-resized-195.png`,
          });
        }
        assert(
          await page
            .locator(".toolgroup button")
            .evaluateAll((nodes) =>
              nodes.every(
                (node) => parseFloat(getComputedStyle(node).fontSize) >= 13,
              ),
            ),
          "Explore tools have undersized type",
        );
        await page.close();
      }
    }
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    server = null;
  }
  const cases = [
    { name: "charging", fixture: "live", state: "charging", route: "/" },
    { name: "stale", fixture: "live", state: "stale", route: "/" },
    { name: "failed", fixture: "live", state: "monitoring", route: "/" },
    ...["/", "/week", "/trends"].map((route, index) => ({
      name: `empty-${index}`,
      fixture: "live",
      state: "no_data",
      route,
    })),
    { name: "narrow", fixture: "night", route: "/week?date=2026-09-11" },
    { name: "dst", fixture: "night", route: "/week?date=2026-10-24" },
    { name: "long-history", fixture: "night", route: "/trends" },
  ];
  for (const item of cases) {
    const database = `${data}/${item.name}.db`;
    const fixture = spawnSync(
      python,
      [
        `tests/${item.fixture}_fixture.py`,
        database,
        ...(item.state ? ["--state", item.state] : []),
      ],
      { encoding: "utf8" },
    );
    assert.equal(fixture.status, 0, fixture.stderr);
    server = spawn(
      python,
      ["server.py", "--port", String(port), "--db", database, "--timezone", "Europe/London"],
      { stdio: "ignore" },
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 360, height: 780 },
      { width: 1440, height: 1000 },
      { width: 195, height: 422 },
    ]) {
      const page = await browser.newPage({
        viewport,
        timezoneId: "Europe/London",
      });
      await page.goto(`http://127.0.0.1:${port}${item.route}`);
      await page.waitForFunction(
        () =>
          !document.querySelector("#status").textContent.includes("Loading"),
      );
      if (item.state !== "no_data")
        await page.waitForSelector("#plot.js-plotly-plot");
      if (item.name === "failed") {
        await page.route("**/api/latest", (route) => route.abort());
        await page.evaluate(() =>
          document.dispatchEvent(new Event("visibilitychange")),
        );
        await page.waitForFunction(() =>
          document
            .querySelector("#status")
            .textContent.includes("Update failed"),
        );
      }
      if (item.name === "long-history") {
        await page.getByRole("button", { name: "All", exact: true }).click();
        await page.waitForFunction(() =>
          document
            .querySelector("#resolution")
            .textContent.includes("All history"),
        );
      }
      await page.waitForTimeout(150);
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${item.name} ${viewport.width}: horizontal overflow`,
      );
      await page.screenshot({
        path: `${captures}/${item.name}-${viewport.width}.png`,
      });
      await audit(page, `${item.name} ${viewport.width}`);
      if (item.name === "long-history" && viewport.width === 195) {
        await page.getByRole("button", { name: "Explore chart" }).click();
        await page.waitForSelector("#expandedPlot.js-plotly-plot");
        await audit(page, "long-history expanded195");
        await page.screenshot({
          path: `${captures}/long-history-expanded-195.png`,
        });
      }
      if (item.name === "charging" && viewport.width === 390) {
        const link = await page
          .getByRole("link", { name: "View latest recorded night" })
          .boundingBox();
        assert(
          link && link.y + link.height < 782,
          "inactive action moved below the first phone viewport",
        );
      }
      await page.close();
    }
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    server = null;
  }
  console.log(`Typography captures: ${captures}`);
  console.log(
    `Lowest sampled normal-text contrast: ${Math.min(...contrastMeasurements.filter((item) => item.minimum === 4.5).map((item) => item.ratio)).toFixed(2)}:1; focus/current indicator: ${Math.min(...contrastMeasurements.flatMap((item) => item.indicators)).toFixed(2)}:1`,
  );
  assert.deepEqual(failures, []);
  console.log("Typography browser acceptance passed");
} finally {
  await browser.close();
  if (server?.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  rmSync(data, { recursive: true, force: true });
}
