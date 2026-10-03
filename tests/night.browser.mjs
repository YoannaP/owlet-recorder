import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const playwright = (() => {
  try {
    return require("playwright");
  } catch (error) {
    if (!process.env.PLAYWRIGHT_MODULE) throw error;
    return require(process.env.PLAYWRIGHT_MODULE);
  }
})();
const python = process.env.PYTHON || ".venv/bin/python";
const port = 18403;
const temporary = mkdtempSync(join(tmpdir(), "owlet-night-browser-"));
const database = join(temporary, "owlet.db");
let server;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const fixture = spawnSync(python, ["tests/night_fixture.py", database], {
  encoding: "utf8",
});
if (fixture.status) throw new Error(fixture.stderr);
server = spawn(
  python,
  ["server.py", "--port", String(port), "--db", database, "--timezone", "Europe/London"],
  {
    stdio: ["ignore", "ignore", "pipe"],
  },
);
async function waitForServer() {
  for (let index = 0; index < 80; index += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/week`)).ok) return;
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("fixture service did not start");
}
const launch = process.env.CHROME_EXECUTABLE
  ? { executablePath: process.env.CHROME_EXECUTABLE, headless: true }
  : { headless: true };
const browser = await playwright.chromium.launch(launch);
try {
  await waitForServer();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "America/Los_Angeles",
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/week?date=1900-01-01`);
  await page.waitForFunction(() =>
    document
      .querySelector("#status span")
      .textContent.includes("No readings recorded for this night"),
  );
  assert(
    !(await page.locator("main").textContent()).includes("Loading"),
    "empty night retained loading copy",
  );
  assert(
    await page.locator("#expand").isDisabled(),
    "empty night left chart controls enabled",
  );
  await page.goto(`http://127.0.0.1:${port}/week?date=2026-09-11`);
  await page.waitForSelector("#plot.js-plotly-plot");
  assert(
    await page.locator("#older").isEnabled(),
    "older available history was cut off",
  );
  await page.locator("#older").click();
  await page.waitForFunction(() =>
    nightTitle.textContent.includes("1 January"),
  );
  assert(
    (await page.locator("h1").textContent()).includes("1 January"),
    "an available night older than 800 days cannot be selected",
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/week?date=2026-09-13`);
  await page.waitForSelector("#plot.js-plotly-plot");
  await page.waitForFunction(() => chartValue.textContent.includes("132"));
  assert(
    (await page.locator("h1").textContent()).includes("13 September"),
    "direct date did not select the requested night",
  );
  assert(
    /\b8\s+h\s+18\s+m\b/.test(
      await page.locator("#recordedSleep").textContent(),
    ),
    "recorded sleep summary is wrong",
  );
  assert(
    /\b42\s+m missing\b/.test(
      await page.locator("#coverageCaption").textContent(),
    ),
    "coverage does not explain gaps",
  );
  assert(
    (await page.locator("#chartCaption").textContent()).includes(
      "Median recorded · Full night",
    ),
    "heart-rate label is imprecise",
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "phone layout has horizontal overflow",
  );
  const hr = await page.evaluate(() => ({
    traces: plot.data.length,
    width: plot.data[0].line.width,
    hover: plot.data[0].hovertemplate,
  }));
  assert(hr.traces > 1, "missing interval is connected as one trace");
  assert(
    hr.width === 1.4 && hr.hover.includes("%{customdata}"),
    "heart-rate plot style or date readout is wrong",
  );
  assert(
    await page.evaluate(
      () =>
        plot.data[0].customdata[0].includes("13 Sept") &&
        plot.data[0].customdata[0].includes("20:00") &&
        plot.data[0].customdata[0].includes("GMT+1"),
    ),
    "chart clock time followed the browser timezone instead of Europe/London",
  );

  await page.getByRole("tab", { name: "Oxygen" }).click();
  await page.waitForFunction(
    () =>
      plot.layout.yaxis.range?.[0] === 85 &&
      plot.layout.yaxis.range?.[1] === 101,
  );
  assert(
    (await page.locator("#chartCaption").textContent()).includes(
      "5th percentile · Full night",
    ),
    "oxygen percentile label is missing",
  );
  await page.getByRole("button", { name: "1h" }).click();
  await page.getByRole("button", { name: "Explore chart" }).click();
  await page.waitForFunction(
    () => expanded.open && expandedPlot.layout.xaxis.rangeslider.visible,
  );
  assert(
    (await page.locator("#expandedDate").textContent()).includes(
      "13 September",
    ),
    "expanded chart uses another date",
  );
  await page.getByRole("button", { name: "Close Explore" }).click();
  await page.waitForFunction(() => document.activeElement?.id === "expand");
  await page.getByRole("tab", { name: "Heart rate" }).click();

  await page.route("**/api/night?night=2026-09-12*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.getByRole("button", { name: "Previous night" }).click();
  await page.getByRole("button", { name: "Next night" }).click();
  await page.waitForTimeout(800);
  assert(
    (await page.locator("h1").textContent()).includes("13 September"),
    "late response overwrote the newer selection",
  );
  assert(
    (await page.locator("#chartValue").textContent()).includes("132"),
    "summary and selected date diverged after a late response",
  );
  assert(
    (await page
      .getByRole("button", { name: "All", exact: true })
      .getAttribute("aria-pressed")) === "true",
    "new night retained the old selected range button",
  );
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
  await page.unroute("**/api/night?night=2026-09-12*");
  await page.route("**/api/night?night=2026-09-12*", (route) => route.abort());
  await page.getByRole("button", { name: "Previous night" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#status")
      .textContent.includes("Unable to load this recorded night"),
  );
  assert(
    !(await page.locator("#status").textContent()).includes("No readings"),
    "request failure is presented as an empty night",
  );

  const dst = await context.newPage();
  await dst.goto(`http://127.0.0.1:${port}/week?date=2026-10-24`);
  await dst.waitForSelector("#plot.js-plotly-plot");
  await dst.waitForFunction(() => plot.data[0]?.x?.length > 1000);
  const dstFull = await dst.evaluate(() => {
    const points = plot.data.flatMap((trace) => trace.x);
    const labels = plot.data.flatMap((trace) => trace.customdata);
    const range = plot.layout.xaxis.range.map((value) =>
      typeof value === "number" ? value : Date.parse(`${value}Z`),
    );
    return {
      points,
      labels,
      range,
      monotonic: points.every(
        (point, index) => !index || point > points[index - 1],
      ),
    };
  });
  assert(dstFull.monotonic, "DST points are not monotonic instants");
  assert(
    dstFull.points.at(-1) - dstFull.points[0] === 24 * 3600000 + 59 * 60000,
    "clock-change night was compressed to 24 hours",
  );
  assert(
    dstFull.range[0] === dstFull.points[0] &&
      dstFull.range[1] === dstFull.points.at(-1),
    "full chart range does not match the actual point instants",
  );
  assert(
    dstFull.labels.some(
      (label) => label.includes("01:00") && label.includes("GMT+1"),
    ) &&
      dstFull.labels.some(
        (label) => label.includes("01:00") && !label.includes("GMT+1"),
      ),
    "repeated clock hour does not distinguish its UTC offsets",
  );
  await dst.getByRole("button", { name: "1h" }).click();
  await dst.getByRole("tab", { name: "Oxygen" }).click();
  await dst.waitForFunction(() => {
    const parse = (value) =>
      typeof value === "number" ? value : Date.parse(`${value}Z`);
    const range = plot.layout.xaxis.range.map(parse);
    const last = plot.data.at(-1).x.at(-1);
    return range[1] === last && range[1] - range[0] === 3600000;
  });
  await dst.getByRole("button", { name: "Explore chart" }).click();
  await dst.getByRole("button", { name: "Samples" }).click();
  await dst.waitForFunction(() =>
    plot.data.every((trace) => trace.mode === "markers"),
  );
  const compactRange = await dst.evaluate(() =>
    plot.layout.xaxis.range.map(String),
  );
  await dst.getByRole("button", { name: "Close Explore" }).click();
  await dst.getByRole("button", { name: "Explore chart" }).click();
  await dst.waitForFunction(() => expandedPlot?.data?.length > 0);
  const expandedRange = await dst.evaluate(() =>
    expandedPlot.layout.xaxis.range.map(String),
  );
  assert(
    JSON.stringify(compactRange) === JSON.stringify(expandedRange),
    "expanded DST chart did not retain the actual selected range",
  );
  const rangeHandle = dst.locator("#expandedPlot .rangeslider-grabarea-min");
  const handleBox = await rangeHandle.boundingBox();
  assert(handleBox, "expanded range selector handle is unavailable");
  await dst.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await dst.mouse.down();
  await dst.mouse.move(
    handleBox.x + handleBox.width / 2 - 45,
    handleBox.y + handleBox.height / 2,
    { steps: 10 },
  );
  await dst.mouse.up();
  await dst.waitForFunction(
    (before) =>
      JSON.stringify(expandedPlot.layout.xaxis.range.map(String)) !==
      JSON.stringify(before),
    expandedRange,
  );
  await dst.close();
  await context.close();

  const londonContext = await browser.newContext({
    viewport: { width: 980, height: 900 },
    timezoneId: "Europe/London",
  });
  const londonPage = await londonContext.newPage();
  await londonPage.goto(`http://127.0.0.1:${port}/week?date=2026-10-24`);
  await londonPage.waitForSelector("#plot.js-plotly-plot");
  await londonPage.waitForFunction(() => plot.data[0]?.x?.length > 1000);
  assert(
    await londonPage.evaluate(() => {
      const points = plot.data.flatMap((trace) => trace.x);
      return (
        points.at(-1) - points[0] === 24 * 3600000 + 59 * 60000 &&
        plot.data
          .flatMap((trace) => trace.customdata)
          .some((label) => label.includes("01:00") && label.includes("GMT+1"))
      );
    }),
    "London browser changed the DST instants or point labels",
  );
  await londonContext.close();

  const temperatureContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const temperaturePage = await temperatureContext.newPage();
  const temperatureErrors = [];
  temperaturePage.on("pageerror", (error) =>
    temperatureErrors.push(error.message),
  );
  await temperaturePage.goto(`http://127.0.0.1:${port}/week?date=2026-09-13`);
  await temperaturePage.waitForSelector("#plot.js-plotly-plot");
  await temperaturePage.locator("#tab-temp").click();
  await temperaturePage.waitForFunction(
    () => plot.data[0]?.meta?.unit === "°C assumed",
  );
  assert(
    await temperaturePage.evaluate(() => {
      const values = plot.data.flatMap((trace) => trace.y);
      return (
        values.filter((value) => value === null).length === 10 &&
        values.every((value) => value === null || value === 34) &&
        plot.data.length > 1 &&
        plot.data.every((trace) => trace.connectgaps === false)
      );
    }),
    "temperature changed raw values or bridged inactive/missing intervals",
  );
  assert(
    (await temperaturePage.locator("#chartCaption").textContent()).includes(
      "Celsius assumed",
    ),
    "compact temperature chart hides the unit assumption",
  );
  for (const width of [390, 320, 980]) {
    await temperaturePage.setViewportSize({ width, height: 844 });
    assert(
      await temperaturePage.locator("#tab-temp").isVisible(),
      "temperature tab is hidden",
    );
    assert(
      await temperaturePage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "temperature layout overflows horizontally",
    );
  }
  await temperaturePage.setViewportSize({ width: 390, height: 844 });
  await temperaturePage.screenshot({
    path: "/private/tmp/owlet-temperature-night.png",
    fullPage: true,
  });
  await temperaturePage.locator("#expand").click();
  await temperaturePage.waitForFunction(
    () => expandedPlot.data[0]?.meta?.unit === "°C assumed",
  );
  await temperaturePage.locator("#expandedPlot").focus();
  await temperaturePage.keyboard.press("Home");
  assert(
    (
      await temperaturePage
        .locator('[data-chart-status="expandedPlot"]')
        .textContent()
    ).includes("34 °C assumed"),
    "selected temperature lost its integer value or assumed-unit label",
  );
  assert(
    (await temperaturePage.locator("#expandedTitle").textContent()).includes(
      "Sock temperature",
    ),
    "expanded chart lost its metric title",
  );
  await temperaturePage
    .locator('#expandedControls [data-action="samples"]')
    .click();
  await temperaturePage.waitForFunction(() =>
    expandedPlot.data.every((trace) => trace.mode === "markers"),
  );
  await temperaturePage.locator("#closeExpanded").click();
  await temperaturePage.route("**/api/night?*", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.temperature_points = payload.temperature_points.map((point) => ({
      ...point,
      temp: null,
    }));
    await route.fulfill({ response, json: payload });
  });
  await temperaturePage.locator("#older").click();
  await temperaturePage.waitForFunction(
    () => !chartEmpty.hidden && chartEmpty.textContent.includes("No eligible"),
  );
  assert(
    await temperaturePage.locator("#expand").isDisabled(),
    "empty temperature chart can be expanded",
  );
  await temperaturePage.locator("#tab-hr").click();
  await temperaturePage.waitForFunction(
    () => !plot.hidden && plot.data[0]?.meta?.unit === "bpm",
  );
  assert(
    await temperaturePage.locator("#expand").isEnabled(),
    "empty temperature disabled other metrics",
  );
  await temperaturePage.goto(`http://127.0.0.1:${port}/week?date=2026-09-13`);
  await temperaturePage.waitForSelector("#plot.js-plotly-plot");
  await temperaturePage.locator("#tab-movement").click();
  await temperaturePage.waitForFunction(
    () => plot.data[0]?.meta?.unit === "reported units",
  );
  assert(
    await temperaturePage.evaluate(() => {
      const values = plot.data.flatMap((trace) => trace.y);
      return (
        values.filter((value) => value === null).length === 10 &&
        values.includes(0) &&
        values.every((value) => value === null || value === 0 || value === 1)
      );
    }),
    "movement was averaged or displayed during charging",
  );
  const contextSelect = temperaturePage.locator("#plot-context-period");
  await contextSelect.selectOption({ index: 4 });
  assert(
    (
      await contextSelect.locator("..").locator(".context-detail").textContent()
    ).includes("charging 2"),
    "context detail lost the reported charging code",
  );
  await temperaturePage.locator('[data-period="1"]').click();
  await temperaturePage.waitForFunction(
    () => document.querySelector("#plot-context-period").options.length === 1,
  );
  assert(
    (await contextSelect.textContent()).includes("05:00"),
    "context did not follow the selected chart range",
  );
  await temperaturePage.locator('[data-period="all"]').click();
  await temperaturePage.waitForFunction(
    () => document.querySelector("#plot-context-period").options.length === 7,
  );
  await contextSelect.selectOption({ index: 1 });
  assert(
    (
      await contextSelect.locator("..").locator(".context-detail").textContent()
    ).startsWith("Nothing recorded."),
    "collection gap was assigned a device state",
  );
  await contextSelect.scrollIntoViewIfNeeded();
  await temperaturePage.screenshot({
    path: "/private/tmp/owlet-recording-context.png",
  });
  await temperaturePage.locator("#tab-position").click();
  await temperaturePage.waitForFunction(
    () => plot.data[0]?.meta?.metric === "Reported position",
  );
  assert(
    await temperaturePage.evaluate(
      () =>
        JSON.stringify(plot.data.flatMap((trace) => trace.y)) ===
          JSON.stringify([3, 3, 4, 5, 5, 1, 0]) && plot.data.length === 2,
    ),
    "position labels or gap boundaries differ from the history response",
  );
  await temperaturePage.locator("#expand").click();
  await temperaturePage.waitForFunction(
    () => expandedPlot.data[0]?.meta?.metric === "Reported position",
  );
  await temperaturePage.locator("#expandedPlot").focus();
  await temperaturePage.keyboard.press("Home");
  assert(
    (
      await temperaturePage
        .locator('[data-chart-status="expandedPlot"]')
        .textContent()
    ).includes("Back"),
    "position readout exposed a numeric class instead of its label",
  );
  await temperaturePage.keyboard.press("End");
  assert(
    (
      await temperaturePage
        .locator('[data-chart-status="expandedPlot"]')
        .textContent()
    ).includes("Unknown"),
    "an unfamiliar position code was labelled tummy",
  );
  await temperaturePage.screenshot({
    path: "/private/tmp/owlet-position-explore.png",
  });
  await temperaturePage.locator("#closeExpanded").click();
  await temperaturePage.locator("#older").click();
  await temperaturePage.waitForFunction(
    () =>
      !chartEmpty.hidden &&
      chartEmpty.textContent.includes("No position history"),
  );
  assert(
    await temperaturePage.locator("#tab-movement").isEnabled(),
    "missing position history disabled movement",
  );
  assert(
    temperatureErrors.length === 0,
    `browser errors: ${temperatureErrors.join("; ")}`,
  );
  await temperatureContext.close();
  console.log("Night browser acceptance passed");
} finally {
  await browser.close();
  if (server && !server.killed) server.kill("SIGTERM");
  if (server?.exitCode === null)
    await new Promise((resolve) => server.once("exit", resolve));
  rmSync(temporary, { recursive: true, force: true });
}
