import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const python = process.env.PYTHON || ".venv/bin/python";
const port = 18514;
const temporary = mkdtempSync(join(tmpdir(), "owlet-chart-details-"));
const screenshots =
  process.env.CHART_DETAILS_SCREENSHOTS ||
  "/private/tmp/owlet-chart-details-screenshots";
const checking = (name) =>
  !process.env.CHART_DETAILS_CASE || process.env.CHART_DETAILS_CASE === name;
mkdirSync(screenshots, { recursive: true });
const database = join(temporary, "owlet.db");
let server;

const fixture = spawnSync(python, ["tests/night_fixture.py", database], {
  encoding: "utf8",
});
if (fixture.status) throw new Error(fixture.stderr);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/week`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("fixture server did not start");
}

function axisDetails() {
  const rectangles = (selector) =>
    [...document.querySelectorAll(selector)]
      .filter((node) => node.textContent.trim())
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, text: node.textContent };
      })
      .sort((left, right) => left.left - right.left);
  const x = rectangles("#plot .xtick text");
  return {
    x,
    y: rectangles("#plot .ytick text"),
    horizontal: [...document.querySelectorAll("#plot .xtick text")].every(
      (node) => !node.getAttribute("transform")?.includes("rotate"),
    ),
    overlap: x.some((tick, index) => index && tick.left < x[index - 1].right),
  };
}

server = spawn(
  python,
  ["server.py", "--port", String(port), "--db", database, "--timezone", "Europe/London"],
  { stdio: "ignore" },
);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE,
  headless: true,
});

try {
  await waitForServer();
  for (const viewport of [
    { width: 360, height: 780 },
    { width: 390, height: 844 },
    { width: 1440, height: 1000 },
  ]) {
    const page = await browser.newPage({
      viewport,
      timezoneId: "Europe/London",
    });
    await page.goto(`http://127.0.0.1:${port}/week?date=2026-09-13`);
    await page.waitForSelector("#plot.js-plotly-plot");
    const compact = await page.evaluate(axisDetails);
    assert(compact.horizontal, `${viewport.width}: compact labels rotated`);
    assert(!compact.overlap, `${viewport.width}: compact labels overlap`);
    assert(
      compact.y.length >= 3,
      `${viewport.width}: fewer than three value ticks`,
    );
    const summaryUnitGap = await page.evaluate(() => {
      const summary = document.querySelector("#chartValue");
      const number = document.createRange();
      number.selectNodeContents(summary.firstChild);
      const unit = document.createRange();
      const text = summary.querySelector("small").firstChild;
      unit.setStart(text, text.textContent.indexOf("bpm"));
      unit.setEnd(text, text.textContent.length);
      return (
        unit.getBoundingClientRect().left - number.getBoundingClientRect().right
      );
    });
    if (checking("units"))
      assert(
        summaryUnitGap >= 3,
        `Night summary has no visual separation before bpm: ${summaryUnitGap}px`,
      );
    await page.getByRole("button", { name: "Explore chart" }).click();
    await page.waitForSelector("#expandedPlot.js-plotly-plot");
    const expanded = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("#expandedPlot .xtick text")];
      const boxes = nodes.map((node) => node.getBoundingClientRect());
      return {
        horizontal: nodes.every(
          (node) => !node.getAttribute("transform")?.includes("rotate"),
        ),
        overlap: boxes.some(
          (box, index) => index && box.left < boxes[index - 1].right,
        ),
      };
    });
    assert(expanded.horizontal, `${viewport.width}: Explore labels rotated`);
    assert(!expanded.overlap, `${viewport.width}: Explore labels overlap`);
    if (viewport.width === 1440) {
      await page.locator("#expandedPlot").focus();
      await page.keyboard.press("Home");
      const beforeResize = await page
        .locator('[data-chart-status="expandedPlot"]')
        .textContent();
      const rangeBeforeResize = await page.evaluate(
        () => expandedPlot.layout.xaxis.range,
      );
      await page.setViewportSize({ width: 360, height: 780 });
      await page.waitForFunction(
        () =>
          document
            .querySelector("#expandedPlot .svg-container")
            .getBoundingClientRect().width < 360,
      );
      await page.waitForTimeout(500);
      const narrowTicks = await page.evaluate(() =>
        [...document.querySelectorAll("#expandedPlot .xtick text")].map(
          (node) => {
            const b = node.getBoundingClientRect();
            return { left: b.left, right: b.right, text: node.textContent };
          },
        ),
      );
      await page.screenshot({
        path: join(screenshots, "night-resized-desktop-to-phone.png"),
      });
      if (checking("resize"))
        assert(
          !narrowTicks.some(
            (tick, index) => index && tick.left < narrowTicks[index - 1].right,
          ),
          `Resizing Explore from desktop to phone retained overlapping ticks: ${JSON.stringify(narrowTicks)}`,
        );
      assert(
        (await page
          .locator('[data-chart-status="expandedPlot"]')
          .textContent()) === beforeResize,
        "resize lost selected observation",
      );
      assert(
        JSON.stringify(
          await page.evaluate(() => expandedPlot.layout.xaxis.range),
        ) === JSON.stringify(rangeBeforeResize),
        "resize changed the selected time range",
      );
      await page.setViewportSize(viewport);
      await page.waitForFunction(
        () =>
          document
            .querySelector("#expandedPlot .svg-container")
            .getBoundingClientRect().width > 1000,
      );
      await page.waitForTimeout(500);
      if (checking("resize"))
        assert(
          (await page.locator("#expandedPlot .xtick text").count()) >
            narrowTicks.length,
          "widened Explore did not use space for more time labels",
        );
    }
    await page.screenshot({
      path: join(screenshots, `night-expanded-${viewport.width}.png`),
      fullPage: true,
    });
    await page.close();
  }

  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    timezoneId: "Europe/London",
    hasTouch: true,
  });
  await page.goto(`http://127.0.0.1:${port}/week?date=2026-10-24`);
  await page.waitForSelector("#plot.js-plotly-plot");
  assert(
    (await page.locator("#plot .ytick text").count()) >= 3,
    "flat 101 bpm night has fewer than three useful value ticks",
  );
  await page.locator("#plot").scrollIntoViewIfNeeded();
  const selectRepeatedHour = async (timestamp) => {
    await page.mouse.move(0, 0);
    const position = await page.evaluate((time) => {
      const bounds = plot.getBoundingClientRect();
      const axes = plot._fullLayout;
      return {
        x: bounds.left + axes.xaxis._offset + axes.xaxis.l2p(time),
        y: bounds.top + axes.yaxis._offset + axes.yaxis.l2p(101),
      };
    }, Date.parse(timestamp));
    await page.mouse.click(position.x, position.y);
  };
  await selectRepeatedHour("2026-10-25T00:30:00Z");
  await page.waitForFunction(() =>
    document
      .querySelector('[data-chart-status="plot"]')
      .textContent.includes("25 Oct 2026"),
  );
  const firstHour = await page
    .locator('[data-chart-status="plot"]')
    .textContent();
  await selectRepeatedHour("2026-10-25T01:30:00Z");
  await page.waitForFunction(
    (previous) =>
      document.querySelector('[data-chart-status="plot"]').textContent !==
      previous,
    firstHour,
    { timeout: 3000 },
  );
  const secondHour = await page
    .locator('[data-chart-status="plot"]')
    .textContent();
  assert(
    /25 Oct 2026, 01:\d{2}:00 GMT\+1/.test(firstHour),
    `first repeated hour ambiguous: ${firstHour}`,
  );
  assert(
    /25 Oct 2026, 01:\d{2}:00 GMT(?:\+0)?(?:,|$)/.test(secondHour),
    `second repeated hour ambiguous: ${secondHour}`,
  );
  assert(
    firstHour !== secondHour,
    "repeated-hour observations collapsed together",
  );
  if (checking("night-context"))
    assert(
      secondHour.includes("Night 2026-10-24, 100% coverage"),
      `Night point omitted available full-night coverage: ${secondHour}`,
    );
  await page.getByRole("button", { name: "Explore chart" }).click();
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('[data-chart-status="expandedPlot"]')
        .textContent.includes(expected) &&
      expandedPlot.layout.annotations.some(
        (annotation) => annotation.meta?.owletSelection,
      ),
    secondHour,
  );
  await page.getByRole("button", { name: "Close Explore" }).click();
  await page.waitForFunction(() => !expanded.open);
  await page.keyboard.press("ArrowRight");
  await page.getByRole("tab", { name: "Oxygen", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-chart-status="plot"]').textContent ===
      "No observation selected.",
  );
  assert(
    !(await page.locator("#plot .hoverlayer").textContent()).includes("bpm"),
    "previous metric hover value remained visible",
  );
  const oxygen = await page.evaluate(() => ({
    range: plot.layout.yaxis.range,
  }));
  assert(JSON.stringify(oxygen.range) === "[85,101]", "oxygen axis changed");
  await page.getByRole("button", { name: "Explore chart" }).click();
  await page.waitForSelector("#expandedPlot.js-plotly-plot");
  const reopenedMetricReadout = await page
    .locator('[data-chart-status="expandedPlot"]')
    .textContent();
  await page.screenshot({
    path: join(screenshots, "night-metric-reopen-regression.png"),
  });
  if (checking("metric"))
    assert(
      reopenedMetricReadout === "No observation selected.",
      `Reopening Oxygen retained a previous metric selection: ${reopenedMetricReadout}`,
    );
  await page.getByRole("button", { name: "Close Explore" }).click();
  await page.waitForFunction(() => !expanded.open);
  await page.getByRole("tab", { name: "Reported sleep", exact: true }).click();
  assert(
    (await page.evaluate(() => plot.layout.yaxis.ticktext)).join("|") ===
      "Unknown|Awake|Light|Deep",
    "sleep categories changed",
  );
  await page.screenshot({
    path: join(screenshots, "night-dst-selection-390.png"),
  });

  await page.goto(`http://127.0.0.1:${port}/trends`);
  await page.waitForSelector("#plot.js-plotly-plot");
  const point = page.locator("#plot .cartesianlayer .point").last();
  const box = await point.boundingBox();
  assert(box, "Trends observation marker missing");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() =>
    document
      .querySelector('[data-chart-status="plot"]')
      .textContent.includes("coverage"),
  );
  assert(
    (await page.locator('[data-chart-status="plot"]').textContent()).includes(
      "GMT",
    ),
    "Trends selected readout omitted exact time and offset",
  );
  assert(
    page.url().endsWith("/trends"),
    "touch inspection navigated immediately",
  );
  assert(
    await page.getByRole("button", { name: "Open Night" }).isEnabled(),
    "selected-night action disabled",
  );
  await page.screenshot({ path: join(screenshots, "trends-selected-390.png") });
  await page.getByRole("button", { name: "Explore chart" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-chart-status="expandedPlot"]')
      .textContent.includes("coverage"),
  );
  await page.getByRole("button", { name: "Close Explore" }).click();
  await page.getByRole("tab", { name: "Oxygen", exact: true }).click();
  await page.getByRole("button", { name: "Explore chart" }).click();
  await page.waitForSelector("#expandedPlot.js-plotly-plot");
  if (checking("trends-metric"))
    assert(
      (await page
        .locator('[data-chart-status="expandedPlot"]')
        .textContent()) === "No observation selected.",
      "Trends reopened Oxygen with a previous metric readout",
    );
  await page.getByRole("button", { name: "Close Explore" }).click();
  await page.getByRole("tab", { name: "Heart rate", exact: true }).click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#resolution").textContent.includes("All history"),
  );
  await page.screenshot({
    path: join(screenshots, "trends-long-history-390.png"),
    fullPage: true,
  });

  const enlarged = await browser.newPage({
    viewport: { width: 195, height: 422 },
    timezoneId: "Europe/London",
  });
  await enlarged.goto(`http://127.0.0.1:${port}/trends`);
  await enlarged.waitForSelector("#plot.js-plotly-plot");
  assert(
    !(await enlarged.evaluate(axisDetails)).overlap,
    "enlarged-layout time labels overlap",
  );
  await enlarged.screenshot({
    path: join(screenshots, "trends-enlarged-195x422.png"),
    fullPage: true,
  });
  await enlarged.close();
  await page.close();

  rmSync(database, { force: true });
  const liveFixture = spawnSync(
    python,
    ["tests/live_fixture.py", database, "--state", "monitoring"],
    { encoding: "utf8" },
  );
  assert(liveFixture.status === 0, liveFixture.stderr);
  const live = await browser.newPage({
    viewport: { width: 390, height: 844 },
    timezoneId: "Europe/London",
  });
  await live.goto(`http://127.0.0.1:${port}/`);
  await live.waitForSelector("#plot.js-plotly-plot");
  await live.locator("#plot").focus();
  await live.keyboard.press("Home");
  await live.waitForFunction(() =>
    document
      .querySelector('[data-chart-status="plot"]')
      .textContent.includes("bpm"),
  );
  const originalSelection = await live
    .locator('[data-chart-status="plot"]')
    .textContent();
  const update = spawnSync(
    python,
    [
      "-c",
      "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE vitals SET heart_rate=141'); c.commit(); c.close()",
      database,
    ],
    { encoding: "utf8" },
  );
  assert(update.status === 0, update.stderr);
  const refreshed = live.waitForResponse((response) =>
    response.url().includes("/api/series"),
  );
  await live.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await refreshed;
  if (checking("refresh"))
    await live.waitForFunction(
      () =>
        document
          .querySelector('[data-chart-status="plot"]')
          .textContent.includes("141.0 bpm"),
      null,
      { timeout: 3000 },
    );
  const refreshedSelection = await live
    .locator('[data-chart-status="plot"]')
    .textContent();
  if (checking("refresh"))
    assert(
      refreshedSelection !== originalSelection,
      "HTTP refresh retained the previous selected value",
    );
  if (checking("refresh")) {
    const hover = await live.locator("#plot .hoverlayer").textContent();
    assert(
      hover.includes("141.0 bpm") && !hover.includes("121.0 bpm"),
      `HTTP refresh retained a stale visible tooltip: ${hover}`,
    );
  }
  assert(
    refreshedSelection.split("bpm,")[1] === originalSelection.split("bpm,")[1],
    "refresh moved selection to a different returned timestamp",
  );
  await live.screenshot({
    path: join(screenshots, "live-refreshed-selection-390.png"),
  });
  await live.getByRole("tab", { name: "Oxygen", exact: true }).click();
  if (checking("live-metric"))
    assert(
      (await live.locator('[data-chart-status="plot"]').textContent()) ===
        "No observation selected.",
      "Live metric switch retained the previous HR readout",
    );
  await live.locator("#plot").focus();
  await live.keyboard.press("Home");
  await live.waitForFunction(() =>
    document
      .querySelector('[data-chart-status="plot"]')
      .textContent.includes("Oxygen:"),
  );
  const sentinel = spawnSync(
    python,
    [
      "-c",
      "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE vitals SET oxygen_saturation=255'); c.commit(); c.close()",
      database,
    ],
    { encoding: "utf8" },
  );
  assert(sentinel.status === 0, sentinel.stderr);
  const invalidRefreshed = live.waitForResponse((response) =>
    response.url().includes("/api/series"),
  );
  await live.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await invalidRefreshed;
  if (checking("null"))
    await live.waitForFunction(
      () =>
        document.querySelector('[data-chart-status="plot"]').textContent ===
        "No observation selected.",
      null,
      { timeout: 3000 },
    );
  await live.screenshot({
    path: join(screenshots, "live-missing-selected-value-390.png"),
  });
  await live.getByRole("tab", { name: "Heart rate", exact: true }).click();
  await live.getByRole("button", { name: "Explore chart" }).click();
  await live.waitForSelector("#expandedPlot.js-plotly-plot");
  const selectFirst = async () => {
    await live.locator("#expandedPlot").focus();
    await live.keyboard.press("Home");
    await live.waitForFunction(() =>
      document
        .querySelector('[data-chart-status="expandedPlot"]')
        .textContent.includes("bpm"),
    );
  };
  const noExpandedSelection = async (kind) => {
    if (checking(kind))
      await live.waitForFunction(
        () =>
          document.querySelector('[data-chart-status="expandedPlot"]')
            .textContent === "No observation selected.",
        null,
        { timeout: 3000 },
      );
  };
  await selectFirst();
  await live.getByRole("button", { name: "Zoom in", exact: true }).click();
  await noExpandedSelection("zoom");
  await live.getByRole("button", { name: "Reset", exact: true }).click();
  await live.getByRole("button", { name: "Zoom in", exact: true }).click();
  await selectFirst();
  await live.getByRole("button", { name: "Pan", exact: true }).click();
  const drag = await live.locator("#expandedPlot .nsewdrag").boundingBox();
  await live.mouse.move(drag.x + drag.width * 0.55, drag.y + drag.height * 0.5);
  await live.mouse.down();
  await live.mouse.move(
    drag.x + drag.width * 0.35,
    drag.y + drag.height * 0.5,
    { steps: 12 },
  );
  await live.mouse.up();
  await noExpandedSelection("pan");
  await live.getByRole("button", { name: "Reset", exact: true }).click();
  await selectFirst();
  const startHandle = live.getByRole("slider", {
    name: "Chart range start",
    exact: true,
  });
  await startHandle.focus();
  await live.keyboard.press("ArrowRight");
  await noExpandedSelection("slider");
  await selectFirst();
  const beforeZoomOut = await live
    .locator('[data-chart-status="expandedPlot"]')
    .textContent();
  await live.getByRole("button", { name: "Zoom out", exact: true }).click();
  assert(
    (await live.locator('[data-chart-status="expandedPlot"]').textContent()) ===
      beforeZoomOut,
    "compatible zoom-out lost the selected point",
  );
  await live.close();
  console.log(
    `Chart details browser acceptance passed; screenshots: ${screenshots}`,
  );
} finally {
  await browser.close();
  if (server?.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  rmSync(temporary, { recursive: true, force: true });
}
