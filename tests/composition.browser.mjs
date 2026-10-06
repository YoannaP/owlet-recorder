import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const python = process.env.PYTHON || ".venv/bin/python";
const temporary = mkdtempSync(join(tmpdir(), "owlet-composition-data-"));
const screenshots = mkdtempSync(join(tmpdir(), "owlet-composition-review-"));
const port = 18511;
const failures = [];
const measurements = [];
let server;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE,
  headless: true,
});
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
}

try {
  for (const kind of ["live", "night"]) {
    const database = join(temporary, `${kind}.db`);
    const args = [`tests/${kind}_fixture.py`, database];
    if (kind === "live") args.push("--state", "monitoring");
    const fixture = spawnSync(python, args, { encoding: "utf8" });
    if (fixture.status) throw new Error(fixture.stderr);
    server = spawn(
      python,
      [
        "server.py",
        "--port",
        String(port),
        "--db",
        database,
        "--timezone",
        "Europe/London",
      ],
      {
        stdio: "ignore",
      },
    );
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 360, height: 780 },
      { width: 1440, height: 1000 },
    ]) {
      const page = await browser.newPage({
        viewport,
        timezoneId: "Europe/London",
      });
      const route = kind === "live" ? "/" : "/week?date=2026-09-13";
      await page.goto(`http://127.0.0.1:${port}${route}`);
      await page.waitForSelector("#plot.js-plotly-plot");
      await page.waitForFunction(
        () =>
          !document.querySelector("#status").textContent.includes("Loading"),
      );
      const result = await page.evaluate(() => {
        const main = document.querySelector("main").getBoundingClientRect();
        const isRendered = (element) => {
          if (!element?.getClientRects().length) return false;
          for (
            let current = element;
            current;
            current = current.parentElement
          ) {
            const style = getComputedStyle(current);
            if (
              style.display === "none" ||
              style.visibility !== "visible" ||
              Number(style.opacity) === 0
            )
              return false;
          }
          return true;
        };
        const withinContent = (element) => {
          const bounds = element.getBoundingClientRect();
          return (
            isRendered(element) &&
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.left >= Math.max(main.left, 0) &&
            bounds.right <= Math.min(main.right, innerWidth) &&
            bounds.top >= Math.max(main.top, 0) &&
            bounds.bottom <= Math.min(main.bottom, innerHeight)
          );
        };
        // The SVG plotting background measures data space, excluding axes,
        // Plotly margins and the outer chart container.
        const plotElement = document.querySelector("#plot .bglayer .bg");
        const plot = plotElement.getBoundingClientRect();
        const visible = Math.max(
          0,
          Math.min(plot.bottom, main.bottom, innerHeight) -
            Math.max(plot.top, main.top, 0),
        );
        const ticks = [...document.querySelectorAll("#plot .xtick text")].map(
          (node) => node.getBoundingClientRect().bottom,
        );
        const captions = [...document.querySelectorAll(".status, .caption")]
          .filter((node) => node.getBoundingClientRect().height)
          .map((node) => ({
            text: node.textContent,
            size: parseFloat(getComputedStyle(node).fontSize),
          }));
        return {
          visible,
          plotTop: plot.top,
          plotBottom: plot.bottom,
          plotVisible:
            isRendered(plotElement) &&
            plot.width > 0 &&
            plot.left >= Math.max(main.left, 0) &&
            plot.right <= Math.min(main.right, innerWidth),
          axisBottom: Math.max(...ticks),
          contentBottom: main.bottom,
          contextVisible: [
            ...document.querySelectorAll(
              'h1, #status, .overview .reading-label, .overview .value, .overview .caption:not(.repeats-age), .metric-tabs [aria-selected="true"]',
            ),
          ].every(withinContent),
          captions,
          horizontalOverflow:
            document.querySelector("main").scrollWidth >
            document.querySelector("main").clientWidth,
        };
      });
      const label = `${kind}-${viewport.width}`;
      measurements.push({ label, ...result });
      await page.screenshot({ path: join(screenshots, `${label}.png`) });
      check(
        result.plotVisible && result.visible >= 160,
        `${label}: only ${result.visible.toFixed(1)}px actual plot visible`,
      );
      check(!result.horizontalOverflow, `${label}: horizontal overflow`);
      check(
        result.contextVisible,
        `${label}: destination, recording context or readings hidden`,
      );
      check(
        result.captions.every(({ size }) => size >= 13),
        `${label}: status or caption text below 13px`,
      );
      if (viewport.width === 1440) {
        check(
          result.plotBottom <= result.contentBottom &&
            result.axisBottom <= result.contentBottom,
          `${label}: complete chart and time labels require scrolling`,
        );
      }
      if (kind === "night") {
        await page.goto(`http://127.0.0.1:${port}/trends`);
        await page.waitForSelector("#plot.js-plotly-plot");
        await page.screenshot({
          path: join(screenshots, `trends-${viewport.width}.png`),
        });
        check(
          await page.evaluate(
            () =>
              document.querySelector("main").scrollWidth <=
              document.querySelector("main").clientWidth,
          ),
          `Trends-${viewport.width}: horizontal overflow`,
        );
      }
      await page.close();
    }
    // Half-sized CSS viewport exercises the available layout space at 200%
    // enlargement without distorting the reserved 100dvh shell.
    const enlarged = await browser.newPage({
      viewport: { width: 195, height: 422 },
      timezoneId: "Europe/London",
    });
    await enlarged.goto(
      `http://127.0.0.1:${port}${kind === "live" ? "/" : "/week?date=2026-09-13"}`,
    );
    await enlarged.waitForSelector("#plot.js-plotly-plot");
    await enlarged.screenshot({
      path: join(screenshots, `${kind}-200-percent.png`),
    });
    check(
      await enlarged.evaluate(
        () =>
          document.querySelector("main").scrollWidth <=
          document.querySelector("main").clientWidth,
      ),
      `${kind} enlarged: horizontal content overflow`,
    );
    const opener = enlarged.getByRole("button", { name: "Explore chart" });
    await opener.focus();
    await opener.press("Enter");
    const close = enlarged.getByRole("button", {
      name: "Close Explore",
    });
    await close.focus();
    await close.press("Enter");
    check(
      await enlarged.evaluate(() => document.activeElement?.id === "expand"),
      `${kind} enlarged: expansion lost keyboard focus`,
    );
    await enlarged.locator("footer").scrollIntoViewIfNeeded();
    check(
      await enlarged.locator("footer").evaluate((footer) => {
        const bounds = footer.getBoundingClientRect();
        const main = document.querySelector("main").getBoundingClientRect();
        return bounds.top >= main.top && bounds.bottom <= main.bottom;
      }),
      `${kind} enlarged: record warning unreachable`,
    );
    await enlarged.close();
    await stopServer();
  }
  writeFileSync(
    join(screenshots, "measurements.json"),
    JSON.stringify(measurements, null, 2),
  );
  console.log(`Composition review: ${screenshots}`);
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("Composition browser acceptance passed");
} finally {
  await browser.close();
  await stopServer();
  rmSync(temporary, { recursive: true, force: true });
}
