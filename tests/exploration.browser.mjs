import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const python = process.env.PYTHON || ".venv/bin/python";
const port = 18512;
const temporary = mkdtempSync(join(tmpdir(), "owlet-exploration-"));
const database = join(temporary, "owlet.db");
const screenshots = "/private/tmp/owlet-ui-polish-exploration-screenshots";
mkdirSync(screenshots, { recursive: true });

const fixture = spawnSync(python, ["tests/night_fixture.py", database], {
  encoding: "utf8",
});
if (fixture.status) throw new Error(fixture.stderr);
const server = spawn(
  python,
  ["server.py", "--port", String(port), "--db", database, "--timezone", "Europe/London"],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/week`)).ok) break;
  } catch (error) {}
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE,
  headless: true,
});

async function range(page, id) {
  return page.evaluate((plotId) => {
    const values = document.getElementById(plotId).layout.xaxis.range;
    return values.map((value) => {
      if (typeof value === "number") return value;
      return Date.parse(String(value));
    });
  }, id);
}

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/week?date=2026-09-13`);
  await page.waitForSelector("#plot.js-plotly-plot");

  assert(
    (await page.locator("#chartControls button").count()) === 0,
    "compact chart still exposes its technical toolbar",
  );
  const explore = page.getByRole("button", { name: "Explore chart" });
  assert(await explore.isVisible(), "labelled Explore action is missing");
  const help = page.locator('[data-chart-help="plot"]');
  assert(
    await help.evaluate(
      (element) => element.getBoundingClientRect().height <= 1,
    ),
    "keyboard help competes with the compact chart before focus",
  );
  await page.locator("#plot").focus();
  assert(
    await help.evaluate(
      (element) => element.getBoundingClientRect().height > 1,
    ),
    "keyboard help does not appear when the chart receives focus",
  );
  await page.locator("#plot").press("Home");
  assert(
    (await page.locator('[data-chart-status="plot"]').textContent()).includes(
      "Heart rate:",
    ),
    "compact keyboard point inspection lost its exact readout",
  );

  await explore.click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !expanded.open);
  await page.waitForFunction(() => document.activeElement?.id === "expand");
  assert(
    await explore.evaluate((element) => element.matches(":focus")),
    "Escape did not restore focus to Explore",
  );
  await explore.click();
  await page.waitForSelector("#expandedPlot.js-plotly-plot");
  await page.getByRole("button", { name: "Samples", exact: true }).click();
  await page.waitForFunction(
    () =>
      expandedPlot.data?.length > 0 &&
      expandedPlot.data.every((trace) => trace.mode === "markers"),
  );
  await page.getByRole("button", { name: "Samples", exact: true }).click();
  await page.waitForFunction(
    () =>
      expandedPlot.data?.length > 0 &&
      expandedPlot.data.some((trace) => trace.mode.includes("lines")),
  );
  await page.getByRole("button", { name: "Close Explore" }).click();
  await page.waitForFunction(() => !expanded.open);
  assert(
    pageErrors.length === 0,
    `immediate Escape or reopening raised an error: ${pageErrors.join(" | ")}`,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await explore.click();
    await page.getByRole("button", { name: "Samples", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => expanded.open);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page
      .waitForFunction(
        () =>
          expanded.open &&
          expandedPlot.data?.length > 0 &&
          expandedPlot.querySelector(".scatterlayer"),
        null,
        { timeout: 3000 },
      )
      .catch(async () => {
        throw new Error(
          `reopened chart lost its rendered data: ${JSON.stringify(await page.evaluate(() => ({ open: expanded.open, data: expandedPlot.data?.length, classes: expandedPlot.className, focused: document.activeElement?.id })))}; errors: ${pageErrors.join(" | ")}`,
        );
      });
    await page.getByRole("button", { name: "Close Explore" }).click();
    await page.waitForFunction(() => document.activeElement?.id === "expand");
  }
  // Leave line presentation for the existing period/range assertions below.
  await explore.click();
  const samples = page.getByRole("button", { name: "Samples", exact: true });
  if ((await samples.getAttribute("aria-pressed")) === "true") {
    await samples.click();
    await page.waitForFunction(() =>
      expandedPlot.data.some((trace) => trace.mode.includes("lines")),
    );
  }
  await page.getByRole("button", { name: "Close Explore" }).click();
  await page.waitForFunction(() => document.activeElement?.id === "expand");

  await page.getByRole("button", { name: "1h" }).click();
  const periodRange = await range(page, "plot");
  await explore.click();
  await page.waitForSelector("#expandedPlot.js-plotly-plot");
  for (const name of ["Zoom", "Pan", "Samples", "Zoom in", "Zoom out", "Reset"])
    assert(
      await page.getByRole("button", { name, exact: true }).isVisible(),
      `${name} is missing from Explore`,
    );
  assert(
    (await page.getByRole("slider", { name: "Chart range start" }).count()) ===
      1,
    "Explore range handles are missing",
  );
  assert(
    JSON.stringify(await range(page, "expandedPlot")) ===
      JSON.stringify(periodRange),
    "Explore did not retain the selected period",
  );
  await page.screenshot({ path: `${screenshots}/night-explore-390x844.png` });

  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.waitForFunction((before) => {
    const current = expandedPlot.layout.xaxis.range.map((value) => {
      if (typeof value === "number") return value;
      return Date.parse(String(value));
    });
    return current[1] - current[0] < before[1] - before[0];
  }, periodRange);
  const inspectedRange = await range(page, "expandedPlot");
  await page.getByRole("button", { name: "Samples", exact: true }).click();
  await page.waitForFunction(() =>
    expandedPlot.data.every((trace) => trace.mode === "markers"),
  );
  const samplesRange = await range(page, "expandedPlot");
  assert(
    JSON.stringify(samplesRange) === JSON.stringify(inspectedRange),
    `Samples lost the inspected range: ${JSON.stringify({ inspectedRange, samplesRange })}`,
  );
  await page.getByRole("button", { name: "Close Explore" }).click();
  await page.waitForFunction((expected) => {
    const actual = plot.layout.xaxis.range.map((value) => {
      if (typeof value === "number") return value;
      return Date.parse(String(value));
    });
    return JSON.stringify(actual) === JSON.stringify(expected);
  }, inspectedRange);
  await page.waitForFunction(() => document.activeElement?.id === "expand");
  const compactInspectedRange = await range(page, "plot");
  assert(
    JSON.stringify(compactInspectedRange) === JSON.stringify(inspectedRange),
    `closing Explore lost the inspected range: ${JSON.stringify({ inspectedRange, compactInspectedRange })}`,
  );

  await explore.click();
  await page.waitForSelector("#expandedPlot.js-plotly-plot");
  assert(
    (await page
      .getByRole("button", { name: "Samples", exact: true })
      .getAttribute("aria-pressed")) === "true",
    "reopening Explore lost the Samples presentation",
  );
  assert(
    JSON.stringify(await range(page, "expandedPlot")) ===
      JSON.stringify(inspectedRange),
    "reopening Explore lost the inspected range",
  );
  await page.getByRole("button", { name: "Pan", exact: true }).click();
  assert(
    (await page
      .getByRole("button", { name: "Pan", exact: true })
      .getAttribute("aria-pressed")) === "true",
    "reopened Explore controls have no working listeners",
  );
  await page.evaluate(() => {
    window.owletPanEvents = [];
    expandedPlot.on("plotly_relayout", (event) =>
      window.owletPanEvents.push({ ...event }),
    );
  });
  const panBefore = await range(page, "expandedPlot");
  const drag = await page.locator("#expandedPlot .nsewdrag").boundingBox();
  await page.mouse.move(drag.x + drag.width * 0.55, drag.y + drag.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(
    drag.x + drag.width * 0.35,
    drag.y + drag.height * 0.5,
    { steps: 10 },
  );
  await page.mouse.up();
  await page.waitForFunction(
    (before) =>
      expandedPlot.layout.xaxis.range.some((value, index) => {
        if (typeof value === "number") return value !== before[index];
        const epoch = Date.parse(String(value));
        return epoch !== before[index];
      }),
    panBefore,
  );
  const panAfter = await range(page, "expandedPlot");
  const panSpan = panBefore[1] - panBefore[0];
  const panDelta = panAfter[0] - panBefore[0];
  const rawPan = await page.evaluate(() => ({
    range: expandedPlot.layout.xaxis.range,
    events: window.owletPanEvents,
  }));
  assert(
    Math.abs(panDelta) < panSpan * 0.5,
    `pointer pan shifted by more than half its window: ${JSON.stringify({ panBefore, panAfter, panDelta, rawPan })}`,
  );
  await page.getByRole("button", { name: "Close Explore" }).click();

  const failed = await context.newPage();
  await failed.goto(`http://127.0.0.1:${port}/`);
  await failed.waitForSelector("#plot.js-plotly-plot");
  await failed.getByRole("button", { name: "1h" }).click();
  await failed.getByRole("button", { name: "Explore chart" }).click();
  await failed.waitForSelector("#expandedPlot.js-plotly-plot");
  const livePeriodRange = await range(failed, "expandedPlot");
  await failed.getByRole("button", { name: "Zoom in", exact: true }).click();
  await failed.waitForFunction((before) => {
    const current = expandedPlot.layout.xaxis.range.map((value) =>
      new Date(value).getTime(),
    );
    return current[1] - current[0] < before[1] - before[0];
  }, livePeriodRange);
  await failed.getByRole("button", { name: "Samples", exact: true }).click();
  await failed.waitForFunction(() =>
    expandedPlot.data.every((trace) => trace.mode === "markers"),
  );
  const beforeRefresh = await range(failed, "expandedPlot");
  const refresh = failed.waitForResponse((response) =>
    response.url().includes("/api/series"),
  );
  await failed.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await refresh;
  await failed.waitForTimeout(250);
  assert(
    JSON.stringify(await range(failed, "expandedPlot")) ===
      JSON.stringify(beforeRefresh),
    "successful polling reset the Explore range",
  );
  assert(
    await failed.evaluate(() =>
      expandedPlot.data.every((trace) => trace.mode === "markers"),
    ),
    "successful polling reset the Samples presentation",
  );
  await failed.route("**/api/series?**", (route) => route.abort());
  await failed.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await failed.waitForFunction(
    () =>
      !expanded.open &&
      document.querySelector("#expand").disabled &&
      document.activeElement?.matches("[data-metric]"),
  );
  assert(
    (await failed.locator("#chartEmpty").textContent()).includes(
      "could not be loaded",
    ),
    "failed refresh left stale Explore content without an explanation",
  );
  await failed.close();

  const dstContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "Europe/London",
  });
  const dst = await dstContext.newPage();
  await dst.goto(`http://127.0.0.1:${port}/week?date=2026-10-24`);
  await dst.waitForSelector("#plot.js-plotly-plot");
  await dst.getByRole("button", { name: "Explore chart" }).click();
  await dst.waitForSelector("#expandedPlot.js-plotly-plot");
  const dstFullRange = await range(dst, "expandedPlot");
  const dstDrag = await dst.locator("#expandedPlot .nsewdrag").boundingBox();
  await dst.mouse.move(
    dstDrag.x + dstDrag.width * 0.515,
    dstDrag.y + dstDrag.height * 0.25,
  );
  await dst.mouse.down();
  await dst.mouse.move(
    dstDrag.x + dstDrag.width * 0.62,
    dstDrag.y + dstDrag.height * 0.75,
    { steps: 10 },
  );
  await dst.mouse.up();
  await dst.waitForFunction((full) => {
    const values = expandedPlot.layout.xaxis.range.map((value) =>
      typeof value === "number" ? value : Date.parse(value),
    );
    return values[1] - values[0] < (full[1] - full[0]) / 2;
  }, dstFullRange);
  const dstSelected = await dst.evaluate(() =>
    expandedPlot.layout.xaxis.range.map(String),
  );
  const dstSelectedEpoch = await range(dst, "expandedPlot");
  assert(
    dstSelectedEpoch[0] < Date.parse("2026-10-25T00:00:00Z") &&
      dstSelectedEpoch[1] > Date.parse("2026-10-25T02:00:00Z"),
    `selected range does not span both repeated 01:xx hours: ${JSON.stringify({ dstSelected, dstSelectedEpoch })}`,
  );
  await dst.getByRole("button", { name: "Close Explore" }).click();
  await dst.getByRole("button", { name: "Explore chart" }).click();
  await dst.waitForSelector("#expandedPlot.js-plotly-plot");
  const dstReopened = await dst.evaluate(() =>
    expandedPlot.layout.xaxis.range.map(String),
  );
  const dstReopenedEpoch = await range(dst, "expandedPlot");
  assert(
    JSON.stringify(dstReopenedEpoch) === JSON.stringify(dstSelectedEpoch),
    `repeated-hour range changed on close and reopen: ${JSON.stringify({ dstSelected, dstSelectedEpoch, dstReopened, dstReopenedEpoch })}`,
  );
  await dstContext.close();

  for (const size of [
    { width: 390, height: 844 },
    { width: 360, height: 780 },
    { width: 1440, height: 1000 },
    { width: 195, height: 422 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector("#plot.js-plotly-plot");
    await page.screenshot({
      path: `${screenshots}/live-${size.width}x${size.height}.png`,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#plot.js-plotly-plot");
  await page.getByRole("button", { name: "Explore chart" }).click();
  await page.waitForSelector("#expandedPlot.js-plotly-plot");
  rmSync(database, { force: true });
  const emptyFixture = spawnSync(
    python,
    ["tests/live_fixture.py", database, "--state", "no_data"],
    { encoding: "utf8" },
  );
  if (emptyFixture.status) throw new Error(emptyFixture.stderr);
  const emptyResponse = page.waitForResponse((response) =>
    response.url().includes("/api/series"),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  const response = await emptyResponse;
  assert(
    response.ok(),
    "empty series transition was not a successful response",
  );
  await page.waitForFunction(
    () =>
      !expanded.open &&
      document.querySelector("#expand").disabled &&
      !document.querySelector("#chartEmpty").hidden,
  );
  assert(
    (await page.locator("#chartEmpty").textContent()).includes(
      "Nothing was recorded",
    ),
    "successful empty refresh left stale Explore content visible",
  );
  assert(
    pageErrors.length === 0,
    `Explore interactions raised browser errors: ${pageErrors.join(" | ")}`,
  );
  await context.close();
  console.log(
    `Exploration browser acceptance passed; captures: ${screenshots}`,
  );
} finally {
  await browser.close();
  if (!server.killed) server.kill("SIGTERM");
  if (server.exitCode === null)
    await new Promise((resolve) => server.once("exit", resolve));
  rmSync(temporary, { recursive: true, force: true });
}
