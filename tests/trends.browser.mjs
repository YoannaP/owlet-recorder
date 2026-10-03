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
const port = 18409;
const temporary = mkdtempSync(join(tmpdir(), "owlet-trends-browser-"));
const database = join(temporary, "owlet.db");
let server;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const fixture = spawnSync(python, ["tests/trends_fixture.py", database], {
  encoding: "utf8",
});
if (fixture.status) throw new Error(fixture.stderr);
server = spawn(
  python,
  ["server.py", "--port", String(port), "--db", database, "--timezone", "Europe/London"],
  { stdio: ["ignore", "ignore", "pipe"] },
);
async function waitForServer() {
  for (let index = 0; index < 80; index += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/trends`)).ok) return;
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("fixture service did not start");
}
const browser = await playwright.chromium.launch(
  process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE, headless: true }
    : { headless: true },
);
try {
  await waitForServer();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    timezoneId: "America/Los_Angeles",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/trends`);
  await page.waitForSelector("#plot.js-plotly-plot");
  assert(
    (await page.locator("#status").textContent()).includes("3 recorded nights"),
    "seven-day history is wrong",
  );
  assert(
    await page.evaluate(() => plot.data.length === 2),
    "missing night is connected",
  );
  await page.getByRole("button", { name: "Explore chart" }).click();
  await page.waitForFunction(() => expanded.open);
  const fullRange = await page.evaluate(() =>
    expandedPlot.layout.xaxis.range.map((value) => new Date(value).getTime()),
  );
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForFunction((before) => {
    const range = expandedPlot.layout.xaxis.range.map((value) =>
      new Date(value).getTime(),
    );
    return range[1] - range[0] < before[1] - before[0];
  }, fullRange);
  const firstRange = await page.evaluate(() =>
    expandedPlot.layout.xaxis.range.map((value) => new Date(value).getTime()),
  );
  await page.getByRole("button", { name: "Close Explore" }).click();
  await page.waitForFunction(() => !expanded.open);
  await page.waitForFunction(
    (expected) =>
      plot.layout.xaxis.range
        .map((value) => new Date(value).getTime())
        .every((value, index) => value === expected[index]),
    firstRange,
  );
  assert(
    await page.evaluate(
      (expected) =>
        plot.layout.xaxis.range
          .map((value) => new Date(value).getTime())
          .every((value, index) => value === expected[index]),
      firstRange,
    ),
    "expanded range did not synchronize to the compact chart",
  );
  await page.getByRole("button", { name: "Explore chart" }).click();
  await page.waitForFunction(() => expanded.open);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.waitForFunction(
    (expected) =>
      JSON.stringify(
        expandedPlot.layout.xaxis.range.map((value) =>
          new Date(value).getTime(),
        ),
      ) === JSON.stringify(expected),
    fullRange,
  );
  const clickedNight = await page.evaluate(
    () => expandedPlot.data.at(-1).customdata.at(-1)[0],
  );
  const point = page.locator("#expandedPlot .cartesianlayer .point").last();
  await point.scrollIntoViewIfNeeded();
  const pointBox = await point.boundingBox();
  assert(pointBox, "expanded night point is not visible");
  // Plotly receives real pointer events through its drag layer above markers.
  await page.mouse.click(
    pointBox.x + pointBox.width / 2 - 1,
    pointBox.y + pointBox.height / 2,
  );
  await page.waitForFunction(
    (night) =>
      nightSelect.value === night &&
      document
        .querySelector('[data-chart-status="expandedPlot"]')
        .textContent.includes(`Night ${night}`),
    clickedNight,
  );
  assert(
    page.url().endsWith("/trends"),
    "inspecting a Trends point navigated before its readout could be read",
  );
  await page.getByRole("button", { name: "Open selected Night" }).click();
  await page.waitForURL(`**/week?date=${clickedNight}`);
  assert(
    new URL(page.url()).searchParams.get("date") === clickedNight,
    "reopened expanded chart lost its drill-down listener",
  );
  await page.goto(`http://127.0.0.1:${port}/trends`);
  await page.waitForSelector("#plot.js-plotly-plot");
  for (const label of [
    "Oxygen",
    "Recorded sleep",
    "Coverage",
    "Movement",
    "Sock temperature",
    "Position",
  ]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    assert(
      (await page.locator("#chartCaption").textContent()).includes("coverage"),
      `${label} left the shared night selection`,
    );
  }
  // The newest night is selected: half its recorded time reported movement,
  // its median sock temperature is 34, and half its archived postures are back.
  await page.getByRole("tab", { name: "Movement", exact: true }).click();
  assert(
    (await page.locator("#chartValue").textContent()).startsWith("50 %"),
    "movement share is not the recorded half",
  );
  await page
    .getByRole("tab", { name: "Sock temperature", exact: true })
    .click();
  assert(
    (await page.locator("#chartValue").textContent()).startsWith("34.0 °C") &&
      (await page.locator("#chartCaption").textContent()).includes(
        "Celsius assumed",
      ),
    "temperature median or caveat is missing",
  );
  await page.getByRole("tab", { name: "Position", exact: true }).click();
  const positionCaption = await page.locator("#chartCaption").textContent();
  assert(
    (await page.locator("#chartValue").textContent()).startsWith("50 %") &&
      positionCaption.includes("Back 50%") &&
      positionCaption.includes("Side 25%") &&
      positionCaption.includes("Tummy 25%"),
    `position shares are wrong: ${positionCaption}`,
  );
  await page.locator("#nightSelect").selectOption({ index: 1 });
  assert(
    (await page.locator("#chartValue").textContent()).startsWith("—") &&
      (await page.locator("#chartCaption").textContent()).includes(
        "No position history archived",
      ),
    "a night without archived positions was given a share",
  );
  assert(
    await page.evaluate(() =>
      plot.data.every((trace) => trace.y.filter((v) => v != null).length <= 1),
    ),
    "unarchived nights were plotted as a position share",
  );
  await page.getByRole("tab", { name: "Heart rate", exact: true }).click();
  await page.getByRole("button", { name: "30d" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("4 recorded nights"),
  );
  assert(
    (await page.locator("#resolution").textContent()).includes("30 days"),
    "period label did not change",
  );
  await page.route("**/api/nights?days=90", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ timezone: "Europe/London", nights: [] }),
    }),
  );
  await page.getByRole("button", { name: "90d" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#chartCaption")
      .textContent.includes("No observations"),
  );
  assert(
    await page.locator("#notice").isHidden(),
    "empty history looks like a request failure",
  );
  assert(
    await page.locator("#expand").isDisabled(),
    "empty history left chart controls enabled",
  );
  await page.unroute("**/api/nights?days=90");
  await page.route("**/api/nights?days=90", (route) => route.abort());
  await page.getByRole("button", { name: "90d" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#chartCaption")
      .textContent.includes("History unavailable"),
  );
  assert(
    !(await page.locator("#notice").isHidden()),
    "failed history looks empty",
  );
  assert(
    (await page.locator("#nightSelect option").count()) === 0,
    "failed request retained old nights",
  );
  await page.unroute("**/api/nights?days=90");
  await page.getByRole("button", { name: "All" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("5 recorded nights"),
  );
  await page.locator("#nightSelect").selectOption({ index: 2 });
  const selected = await page.locator("#nightSelect").inputValue();
  await page.getByRole("button", { name: "Open Night" }).click();
  await page.waitForURL(`**/week?date=${selected}`);
  assert(
    new URL(page.url()).searchParams.get("date") === selected,
    "alternate selection opened another night",
  );
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
  console.log("Trends browser acceptance passed");
} finally {
  await browser.close();
  if (server && !server.killed) server.kill("SIGTERM");
  if (server?.exitCode === null)
    await new Promise((resolve) => server.once("exit", resolve));
  rmSync(temporary, { recursive: true, force: true });
}
