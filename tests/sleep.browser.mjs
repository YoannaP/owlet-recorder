import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const playwright = process.env.PLAYWRIGHT_MODULE
  ? require(process.env.PLAYWRIGHT_MODULE)
  : require("playwright");
const python = process.env.PYTHON || ".venv/bin/python";
const port = 18410;
const temporary = mkdtempSync(join(tmpdir(), "owlet-sleep-browser-"));
const database = join(temporary, "owlet.db");
let server;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const fixture = spawnSync(python, ["tests/sleep_fixture.py", database], {
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
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return;
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
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "America/Los_Angeles",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#plot.js-plotly-plot");
  await page.getByRole("tab", { name: "Reported sleep" }).click();
  await page.waitForFunction(() => plot.data[0]?.line?.shape === "hv");
  const live = await page.evaluate(() => ({
    observations: plot.data.flatMap((trace) => trace.x).length,
    traces: plot.data.length,
    values: plot.data.flatMap((trace) => trace.y),
    labels: plot.layout.yaxis.ticktext,
    width: plot.data[0].line.width,
    shape: plot.data[0].line.shape,
  }));
  assert(live.observations === 9, "Live omitted reported observations");
  assert(live.traces === 2, "Live connected across the missing interval");
  assert(
    JSON.stringify(live.values) ===
      JSON.stringify([1, null, 2, 0, 3, 0, 2, 3, 1]),
    "Live changed a transition, missing value, or unknown state",
  );
  assert(
    live.labels.join("|") === "Unknown|Awake|Light|Deep",
    "Sleep categories are not explicit",
  );
  assert(
    live.width === 1.5 && live.shape === "hv",
    "Sleep is not a 1.5px step line",
  );
  await page.getByRole("button", { name: "1h" }).click();
  const range = await page.evaluate(() => plot.layout.xaxis.range.map(String));
  await page.getByRole("button", { name: "Explore chart" }).click();
  await page.getByRole("button", { name: "Samples" }).click();
  await page.waitForFunction(() =>
    plot.data.every((trace) => trace.mode === "markers"),
  );
  assert(
    (await page.evaluate(
      () => plot.data.flatMap((trace) => trace.x).length,
    )) === 9,
    "Live Samples differs from the line observations",
  );
  assert(
    (await page.evaluate(() => plot.data.flatMap((trace) => trace.y))).includes(
      null,
    ),
    "Live Samples turned a missing sleep state into a stage",
  );
  assert(
    JSON.stringify(range) ===
      JSON.stringify(
        await page.evaluate(() => plot.layout.xaxis.range.map(String)),
      ),
    "Live Samples reset the selected range",
  );
  await page.waitForFunction(() => expandedPlot?.data?.length === 2);
  assert(
    (await page.evaluate(
      () => expandedPlot.data.flatMap((trace) => trace.x).length,
    )) === 9,
    "Expanded Live differs from the compact observations",
  );

  const night = await context.newPage();
  await night.goto(`http://127.0.0.1:${port}/week?date=2026-09-13`);
  await night.waitForSelector("#plot.js-plotly-plot");
  await night.getByRole("tab", { name: "Reported sleep" }).click();
  await night.waitForFunction(() => plot.data[0]?.line?.shape === "hv");
  const firstNight = await night.evaluate(() => ({
    observations: plot.data.flatMap((trace) => trace.x).length,
    traces: plot.data.length,
    values: plot.data.flatMap((trace) => trace.y),
  }));
  assert(firstNight.observations === 8, "Night omitted reported observations");
  assert(
    firstNight.traces === 2,
    "Night connected across the missing interval",
  );
  assert(
    firstNight.values.filter((value) => value === 0).length === 2,
    "Night did not preserve code 0 and map unsupported code 42 to Unknown",
  );
  assert(
    firstNight.values.includes(null),
    "Night invented a stage for missing sleep data",
  );
  assert(
    (await night.locator("#chartCaption").textContent()).includes("Full night"),
    "Zoomable sleep chart replaced the audited full-night summary",
  );
  await night.getByRole("button", { name: "Previous night" }).click();
  await night.waitForFunction(
    () =>
      document.querySelector("h1").textContent.includes("12 September") &&
      plot.data.flatMap((trace) => trace.x).length === 3,
  );
  assert(
    (await night.locator("#resolution").textContent()).includes(
      "3 returned observations",
    ),
    "Selected date and sleep observations diverged",
  );
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
  await context.close();
  console.log("Reported sleep browser acceptance passed");
} finally {
  await browser.close();
  if (server && server.exitCode === null) server.kill("SIGTERM");
  rmSync(temporary, { recursive: true, force: true });
}
