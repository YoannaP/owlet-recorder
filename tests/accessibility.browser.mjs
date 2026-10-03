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
const port = 18413;
const temporary = mkdtempSync(join(tmpdir(), "owlet-accessibility-"));
const database = join(temporary, "owlet.db");
const fixture = spawnSync(python, ["tests/sleep_fixture.py", database], {
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
const browser = await playwright.chromium.launch(
  process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE, headless: true }
    : { headless: true },
);
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/week?date=2026-09-13`);
  const chart = page.locator("#plot");
  await page.waitForSelector("#plot.js-plotly-plot");
  await chart.focus();
  assert(
    await chart.evaluate((element) => element.matches(":focus")),
    "chart is not keyboard focusable",
  );
  assert(
    (await chart.getAttribute("aria-describedby")).includes("plot-chart-help"),
    "chart does not expose its arrow-key instructions",
  );
  assert(
    await chart.getAttribute("aria-label"),
    "chart application has no accessible name",
  );
  await chart.press("Home");
  const first = await page.locator('[data-chart-status="plot"]').textContent();
  assert(
    first.includes("Heart rate:") &&
      first.includes("bpm") &&
      first.includes("GMT"),
    `point announcement lacks exact metric, unit, time, or offset: ${first}`,
  );
  await chart.press("ArrowRight");
  const second = await page.locator('[data-chart-status="plot"]').textContent();
  assert(
    first !== second,
    "Right Arrow did not inspect the next recorded point",
  );
  await chart.press("End");
  await page.getByRole("tab", { name: "Reported sleep" }).click();
  await page.waitForFunction(() => plot.data[0]?.line?.shape === "hv");
  await chart.focus();
  await chart.press("ArrowLeft");
  await chart.press("Home");
  const afterMissing = await page
    .locator('[data-chart-status="plot"]')
    .textContent();
  assert(
    afterMissing.includes("Reported sleep:") &&
      !afterMissing.includes("Missing") &&
      !afterMissing.includes("null"),
    "keyboard inspection announced an absent sleep state as a value",
  );

  const opener = page.getByRole("button", { name: "Explore chart" });
  await opener.click();
  const start = page.getByRole("slider", { name: "Chart range start" });
  await start.waitFor({ state: "visible" });
  const before = Number(await start.getAttribute("aria-valuenow"));
  const handleBox = await start.boundingBox();
  assert(
    handleBox.width >= 44,
    `range handle hit target is only ${handleBox.width}px wide`,
  );
  assert(
    (await start.getAttribute("aria-valuetext")).includes("GMT"),
    "range handle does not expose its timestamp and offset",
  );
  const announcementBeforeHandle = await page
    .locator('[data-chart-status="expandedPlot"]')
    .textContent();
  assert(
    announcementBeforeHandle.includes("Reported sleep:"),
    "Explore did not retain the first selected sleep observation",
  );
  await start.press("ArrowRight");
  await page.waitForFunction(
    (value) =>
      Number(
        document
          .querySelector('[aria-label="Chart range start"]')
          .getAttribute("aria-valuenow"),
      ) > value,
    before,
  );
  const moved = Number(
    await page
      .getByRole("slider", { name: "Chart range start" })
      .getAttribute("aria-valuenow"),
  );
  assert(moved > before, "range start did not move with Right Arrow");
  assert(
    (await page.locator('[data-chart-status="expandedPlot"]').textContent()) ===
      "No observation selected.",
    "range-handle key must clear the excluded observation, not inspect another point",
  );
  assert(
    Number(
      await page
        .getByRole("slider", { name: "Chart range start" })
        .getAttribute("aria-valuemax"),
    ) ===
      Number(
        await page
          .getByRole("slider", { name: "Chart range end" })
          .getAttribute("aria-valuenow"),
      ),
    "range start maximum does not match the current end handle",
  );
  await page.getByRole("slider", { name: "Chart range start" }).press("Home");
  const minimum = Number(
    await page
      .getByRole("slider", { name: "Chart range start" })
      .getAttribute("aria-valuemin"),
  );
  assert(
    Number(
      await page
        .getByRole("slider", { name: "Chart range start" })
        .getAttribute("aria-valuenow"),
    ) === minimum,
    "Home did not move range start to the first observation",
  );
  await page.getByRole("button", { name: "Close Explore" }).click();
  await page.waitForFunction(() => document.activeElement?.id === "expand");
  assert(
    await opener.evaluate((element) => element.matches(":focus")),
    "expanded-chart focus did not return to its opener",
  );

  await opener.click();
  await page.getByRole("button", { name: "Samples" }).click();
  await page.waitForFunction(() =>
    plot.data.every((trace) => trace.mode === "markers"),
  );
  await page.getByRole("button", { name: "Close Explore" }).click();
  await chart.scrollIntoViewIfNeeded();
  const sample = page.locator("#plot .scatterlayer .point").nth(2);
  const sampleBox = await sample.boundingBox();
  assert(sampleBox, "sample point is unavailable for touch inspection");
  const beforeTap = await page
    .locator('[data-chart-status="plot"]')
    .textContent();
  await page.touchscreen.tap(
    sampleBox.x + sampleBox.width / 2,
    sampleBox.y + sampleBox.height / 2,
  );
  await page.waitForFunction(
    (before) =>
      document.querySelector('[data-chart-status="plot"]').textContent !==
      before,
    beforeTap,
  );
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
  await context.close();
  console.log("Chart accessibility browser acceptance passed");
} finally {
  await browser.close();
  if (!server.killed) server.kill("SIGTERM");
  if (server.exitCode === null)
    await new Promise((resolve) => server.once("exit", resolve));
  rmSync(temporary, { recursive: true, force: true });
}
