import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
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
const chrome = process.env.CHROME_EXECUTABLE;
const python = process.env.PYTHON || ".venv/bin/python";
const port = 18402;
const temporary = mkdtempSync(join(tmpdir(), "owlet-live-browser-"));
const database = join(temporary, "owlet.db");
let server;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function fixture(state = "monitoring", ageSeconds = 0) {
  rmSync(database, { force: true });
  const result = spawnSync(
    python,
    [
      "tests/live_fixture.py",
      database,
      "--state",
      state,
      "--age-seconds",
      String(ageSeconds),
    ],
    { encoding: "utf8" },
  );
  if (result.status) throw new Error(result.stderr);
}
async function waitForServer() {
  for (let index = 0; index < 80; index += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return;
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("fixture service did not start");
}

fixture();
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
  { stdio: ["ignore", "ignore", "pipe"] },
);
const browser = await playwright.chromium.launch({
  executablePath: chrome,
  headless: true,
});
try {
  await waitForServer();
  const additions = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  const additionErrors = [];
  additions.on("pageerror", (error) => additionErrors.push(error.message));
  await additions.goto(`http://127.0.0.1:${port}/`);
  await additions.waitForSelector("#plot.js-plotly-plot");
  await additions.waitForFunction(
    () => !document.querySelector("#latestVitals").hidden,
  );
  // The fixture's collection gap is in view for temperature and movement, so
  // their context strip appears. Position history spans only the last 15
  // minutes, where nothing interrupted recording, so its strip stays hidden.
  for (const [metric, name, latest, context] of [
    ["temp", "Sock temperature", "34 °C assumed", true],
    ["movement", "Movement", "0 reported units", true],
    ["position", "Reported position", "Unknown", false],
  ]) {
    await additions.locator(`[data-metric="${metric}"]`).click();
    await additions.waitForFunction(
      (name) =>
        document.querySelector("#plot").data?.[0]?.meta?.metric === name,
      name,
    );
    assert(
      (await additions.locator("#metricLatest").textContent()).includes(latest),
      `${metric} latest readout missing`,
    );
    assert(
      (await additions.locator("#plot-context-period").isVisible()) === context,
      `${metric} context ${context ? "missing" : "shown without a gap in view"}`,
    );
  }
  assert(
    (await additions.locator("#metricLatest").textContent()).includes(
      "10 minutes ago",
    ),
    "position reused the vital timestamp",
  );
  assert(
    (await additions.locator("#metricLatest").textContent()).includes(
      "History may arrive later",
    ),
    "position delay not disclosed",
  );
  await additions.locator("#expand").click();
  await additions.waitForSelector("#expandedPlot.js-plotly-plot");
  await additions.locator("#expandedPlot").focus();
  await additions.keyboard.press("End");
  assert(
    (
      await additions
        .locator('[data-chart-status="expandedPlot"]')
        .textContent()
    ).includes("Unknown"),
    "position unknown code lost in Explore",
  );
  await additions.keyboard.press("Escape");
  for (const width of [195, 360, 390, 980]) {
    await additions.setViewportSize({ width, height: 844 });
    assert(
      await additions.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `Live additions overflow at ${width}`,
    );
  }
  await additions.setViewportSize({ width: 390, height: 844 });
  await additions.screenshot({
    path: "/private/tmp/owlet-live-position.png",
    fullPage: true,
  });
  await additions.route("**/api/series?**", (route) =>
    route.fulfill({ status: 500, body: "unavailable" }),
  );
  await additions.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await additions.waitForFunction(() =>
    document
      .querySelector("#metricLatest")
      .textContent.includes("History refresh failed"),
  );
  assert(
    await additions.locator(".recording-context").first().isHidden(),
    "context remains visible after failed refresh",
  );
  await additions.unroute("**/api/series?**");
  await additions.route("**/api/series?**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.position_points = [];
    await route.fulfill({ json: payload });
  });
  await additions.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await additions.waitForFunction(() =>
    document
      .querySelector("#chartEmpty")
      .textContent.includes("No position history"),
  );
  assert(
    await additions.locator("#expand").isDisabled(),
    "empty position can expand",
  );
  await additions.locator('[data-metric="movement"]').click();
  await additions.waitForFunction(
    () => !document.querySelector("#plot").hidden,
  );
  assert(additionErrors.length === 0, additionErrors.join("\n"));
  await additions.close();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "Europe/London",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  const delayed = await context.newPage();
  await delayed.route("**/api/series?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await delayed.goto(`http://127.0.0.1:${port}/`);
  assert(
    await delayed.locator("#expand").isDisabled(),
    "expand is active while chart readings load",
  );
  assert(
    (await delayed.getByRole("button", { name: "Zoom in" }).count()) === 0,
    "technical tools are exposed while readings load",
  );
  await delayed.waitForSelector("#plot.js-plotly-plot");
  assert(
    await delayed.locator("#expand").isEnabled(),
    "expand stayed disabled after readings loaded",
  );
  await delayed.close();

  // Advance real polling timers without reloading or visibility events.
  const polling = await context.newPage();
  await polling.clock.install();
  let seriesRequests = 0;
  await polling.route("**/api/series?**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    const offset = seriesRequests++ * 60;
    for (const row of payload.rows) row.t += offset;
    for (const row of payload.sleep_points) row.t += offset;
    await route.fulfill({ response, json: payload });
  });
  await polling.goto(`http://127.0.0.1:${port}/`);
  await polling.waitForSelector("#plot.js-plotly-plot");
  await polling.getByRole("button", { name: "1h", exact: true }).click();
  await polling.getByRole("button", { name: "All", exact: true }).click();
  const initialEnd = await polling.evaluate(() => plot.layout.xaxis.range[1]);
  await polling.clock.fastForward(10000);
  await polling.waitForFunction(
    (end) => plot.layout.xaxis.range[1] > end,
    initialEnd,
    { timeout: 3000 },
  );
  // Opening and closing Explore without a gesture must leave All in charge.
  await polling.locator("#expand").click();
  await polling.waitForFunction(
    () => expanded.open && expandedPlot.classList.contains("js-plotly-plot"),
  );
  await polling.getByRole("button", { name: "Close Explore" }).click();
  await polling.waitForFunction(() => !expanded.open);
  const untouchedEnd = await polling.evaluate(() => plot.layout.xaxis.range[1]);
  await polling.clock.fastForward(10000);
  await polling.waitForFunction(
    (end) => plot.layout.xaxis.range[1] > end,
    untouchedEnd,
    { timeout: 3000 },
  );
  assert(
    (await polling
      .getByRole("button", { name: "All", exact: true })
      .first()
      .getAttribute("aria-pressed")) === "true",
    "All lost its highlight after an untouched Explore",
  );
  // A preset window slides with new samples instead of pinning its end.
  await polling.getByRole("button", { name: "1h", exact: true }).click();
  const presetRange = await polling.evaluate(() =>
    plot.layout.xaxis.range.map(Number),
  );
  await polling.clock.fastForward(10000);
  await polling.waitForFunction(
    (end) => plot.layout.xaxis.range[1] > end,
    presetRange[1],
    { timeout: 3000 },
  );
  const slidRange = await polling.evaluate(() =>
    plot.layout.xaxis.range.map(Number),
  );
  assert(
    Math.abs(slidRange[1] - slidRange[0] - 3600000) < 1000 &&
      Math.abs(presetRange[1] - presetRange[0] - 3600000) < 1000,
    "the 1h preset did not keep a one-hour window while sliding",
  );
  await polling.getByRole("button", { name: "All", exact: true }).click();
  const stall = () => {};
  await polling.route("**/api/series?**", stall);
  await polling.route("**/api/latest", stall);
  const stalledSeries = polling.waitForRequest("**/api/series?**");
  await polling.clock.fastForward(10000);
  await stalledSeries;
  await polling.clock.fastForward(8000);
  await polling.waitForFunction(() =>
    document
      .querySelector("#resolution")
      .textContent.includes("Unable to refresh"),
  );
  assert(
    (await polling.locator("#status").textContent()).includes("Update failed"),
    "a stalled latest request did not report failure",
  );
  await polling.unroute("**/api/series?**", stall);
  await polling.unroute("**/api/latest", stall);
  await polling.clock.fastForward(10000);
  await polling.waitForFunction(
    () =>
      !document.querySelector("#plot").hidden &&
      document
        .querySelector("#resolution")
        .textContent.includes("returned observations") &&
      !document.querySelector("#status").textContent.includes("Update failed"),
  );
  await polling.close();

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#plot.js-plotly-plot");
  await page.waitForFunction(
    () =>
      document.querySelector("#heartRate").textContent.includes("bpm") &&
      document.querySelector("#status").textContent.includes("Latest recorded"),
  );
  assert(
    (await page.locator("#heartRate").textContent()).includes("bpm"),
    "heart rate and unit are visible",
  );
  assert(
    (await page.locator("#oxygen").textContent()).includes("%"),
    "oxygen and unit are visible",
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "phone layout has horizontal overflow",
  );
  const initial = await page.evaluate(() => ({
    traces: plot.data.length,
    width: plot.data[0].line.width,
    color: plot.data[0].line.color,
  }));
  assert(
    initial.traces === 2,
    `expected a visible gap as two traces, got ${initial.traces}`,
  );
  assert(
    initial.width === 1.4 && initial.color === "#ffffff",
    "trace is not pure white at 1.4px",
  );
  assert(
    await page.locator("#chartEmpty").isHidden(),
    "empty message is visible over populated readings",
  );

  await page.getByRole("button", { name: "1h" }).click();
  await page.waitForFunction(
    () =>
      plot.layout.xaxis.range &&
      new Date(plot.layout.xaxis.range[1]) -
        new Date(plot.layout.xaxis.range[0]) <
        3700000,
  );
  const selectedRange = await page.evaluate(() =>
    plot.layout.xaxis.range.map((value) => new Date(value).getTime()),
  );
  const refresh = page.waitForResponse((response) =>
    response.url().includes("/api/series"),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await refresh;
  await page.getByRole("button", { name: "Explore chart" }).click();
  await page
    .getByRole("button", { name: "Zoom in" })
    .waitFor({ state: "visible" });
  await page.waitForTimeout(500);
  assert(
    await page.getByRole("button", { name: "Zoom in" }).isEnabled(),
    `chart refresh failed: ${await page.locator("#resolution").textContent()} · ${errors.join(" | ")}`,
  );
  const refreshedRange = await page.evaluate(() =>
    plot.layout.xaxis.range.map((value) => new Date(value).getTime()),
  );
  assert(
    JSON.stringify(selectedRange) === JSON.stringify(refreshedRange),
    "series refresh reset the selected range",
  );

  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForFunction(
    (before) =>
      new Date(expandedPlot.layout.xaxis.range[1]) -
        new Date(expandedPlot.layout.xaxis.range[0]) <
      new Date(before[1]) - new Date(before[0]),
    selectedRange,
  );
  const zoomedRange = await page.evaluate(() =>
    expandedPlot.layout.xaxis.range.map((value) => new Date(value).getTime()),
  );
  await page.getByRole("button", { name: "Pan", exact: true }).click();
  const panBefore = zoomedRange;
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
      expandedPlot.layout.xaxis.range.some(
        (value, index) => new Date(value).getTime() !== before[index],
      ),
    panBefore,
  );
  const pannedRange = await page.evaluate(() =>
    expandedPlot.layout.xaxis.range.map((value) => new Date(value).getTime()),
  );
  assert(
    pannedRange[0] > zoomedRange[0] &&
      pannedRange[0] - zoomedRange[0] < (zoomedRange[1] - zoomedRange[0]) / 2,
    "A short pan jumped outside the expected time interval",
  );
  await page.getByRole("button", { name: "Samples" }).click();
  await page.waitForTimeout(300);
  const sampleState = await page.evaluate(() => ({
    modes: expandedPlot.data.map((trace) => trace.mode),
    points: document.querySelectorAll(
      "#expandedPlot .scatterlayer .points .point",
    ).length,
  }));
  assert(
    sampleState.modes.every((mode) => mode === "markers") &&
      sampleState.points > 0,
    `Samples did not show returned observations: ${JSON.stringify(sampleState)}`,
  );
  assert(
    JSON.stringify(pannedRange) ===
      JSON.stringify(
        await page.evaluate(() =>
          expandedPlot.layout.xaxis.range.map((value) =>
            new Date(value).getTime(),
          ),
        ),
      ),
    "Samples changed the selected range",
  );
  await page.getByRole("button", { name: "Close Explore" }).click();
  await page
    .waitForFunction(
      (expected) =>
        JSON.stringify(
          plot.layout.xaxis.range.map((value) => new Date(value).getTime()),
        ) === JSON.stringify(expected),
      pannedRange,
    )
    .catch(async (error) => {
      throw new Error(
        `Explore close lost panned range: expected ${JSON.stringify(pannedRange)}, actual ${JSON.stringify(await page.evaluate(() => plot.layout.xaxis.range))}; ${error.message}`,
      );
    });
  await page.locator("#plot").scrollIntoViewIfNeeded();
  const pointPosition = await page.evaluate(() => {
    const xaxis = plot._fullLayout.xaxis;
    const yaxis = plot._fullLayout.yaxis;
    const range = plot.layout.xaxis.range.map((value) =>
      new Date(value).getTime(),
    );
    // Inspect inside the drawing area, not a marker clipped at its boundary.
    const margin = (range[1] - range[0]) * 0.1;
    for (const trace of plot.data) {
      const index = trace.x.findIndex((value, pointIndex) => {
        const time = new Date(value).getTime();
        return (
          time >= range[0] + margin &&
          time <= range[1] - margin &&
          trace.y[pointIndex] != null &&
          Number.isFinite(Number(trace.y[pointIndex]))
        );
      });
      if (index >= 0) {
        const box = plot.getBoundingClientRect();
        return {
          x: box.x + xaxis._offset + xaxis.d2p(trace.x[index]),
          y: box.y + yaxis._offset + yaxis.d2p(trace.y[index]),
          value: trace.y[index],
          time: trace.x[index],
        };
      }
    }
    return null;
  });
  assert(pointPosition, "no visible sample was available for point inspection");
  await page.mouse.move(pointPosition.x, pointPosition.y);
  await page
    .waitForSelector("#plot .hoverlayer .hovertext")
    .catch(async (error) => {
      const target = await page.evaluate(
        ({ x, y }) => ({
          element: document.elementFromPoint(x, y)?.outerHTML.slice(0, 500),
          plot: plot.getBoundingClientRect().toJSON(),
          range: plot.layout.xaxis.range,
          values: plot.layout.yaxis.range,
        }),
        pointPosition,
      );
      await page.screenshot({
        path: "/private/tmp/owlet-live-hover-failure.png",
      });
      throw new Error(
        `Pointer hover failed: ${JSON.stringify({ pointPosition, target })}; ${error.message}`,
      );
    });
  const pointReadout = await page.locator("#plot .hoverlayer").textContent();
  assert(
    pointReadout.includes("bpm"),
    "point readout omits the heart-rate unit",
  );
  assert(/\w{3} \d{2}/.test(pointReadout), "point readout omits the date");

  await page.getByRole("tab", { name: "Oxygen", exact: true }).click();
  await page.waitForFunction(
    () =>
      plot.layout.yaxis.range?.[0] === 85 &&
      plot.layout.yaxis.range?.[1] === 101,
  );
  // Explore offers the same presets as the compact chart.
  await page.getByRole("button", { name: "Explore chart" }).click();
  await page.waitForFunction(
    () => expanded.open && expandedPlot.classList.contains("js-plotly-plot"),
  );
  await page.locator('#expandedControls [data-period="1"]').click();
  await page.waitForFunction(() => {
    const [start, end] = expandedPlot.layout.xaxis.range.map(Number);
    return Math.abs(end - start - 3600000) < 1000;
  });
  assert(
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-period="1"]')].every(
        (button) => button.getAttribute("aria-pressed") === "true",
      ),
    ),
    "the 1h preset chosen in Explore is not reflected on both charts",
  );
  // A click on the backdrop closes Explore, like the × button.
  await page.mouse.click(4, 4);
  await page.waitForFunction(() => !expanded.open);
  await page.waitForFunction(() => document.activeElement?.id === "expand");
  // The recording-context select starts on the largest recorded interval in view.
  assert(
    await page.evaluate(() => {
      const select = document.getElementById("plot-context-period");
      const options = [...select.options];
      const span = (option) => {
        const [start, end] = option.value.split(":").map(Number);
        return option.textContent.endsWith("Nothing recorded")
          ? -1
          : end - start;
      };
      const largest = options.reduce(
        (best, option, index) =>
          span(option) > span(options[best]) ? index : best,
        0,
      );
      return select.selectedIndex === largest;
    }),
    "recording context did not default to the largest recorded interval",
  );
  // Leave the 1h preset in place: the range-selector drag below widens it.
  const opener = page.getByRole("button", { name: "Explore chart" });
  await opener.click();
  await page.waitForFunction(
    () => expanded.open && expandedPlot.classList.contains("js-plotly-plot"),
  );
  assert(
    await page.evaluate(
      () => expandedPlot.layout.xaxis.rangeslider.visible === true,
    ),
    "expanded range selector is missing",
  );
  const sliderBefore = await page.evaluate(() =>
    expandedPlot.layout.xaxis.range.map((value) => new Date(value).getTime()),
  );
  const rangeHandle = page.locator("#expandedPlot .rangeslider-grabarea-min");
  await rangeHandle.scrollIntoViewIfNeeded();
  const handle = await rangeHandle.boundingBox();
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handle.x - 45, handle.y + handle.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const expandedRange = await page.evaluate(() =>
    expandedPlot.layout.xaxis.range.map((value) => new Date(value).getTime()),
  );
  const rangeSelectorChanged = expandedRange.some(
    (value, index) => value !== sliderBefore[index],
  );
  await page.getByRole("button", { name: "Close Explore" }).click();
  await page.waitForFunction(() => document.activeElement?.id === "expand");
  await page.waitForFunction(
    (expected) =>
      JSON.stringify(
        plot.layout.xaxis.range.map((value) => new Date(value).getTime()),
      ) === JSON.stringify(expected),
    expandedRange,
  );
  assert(
    JSON.stringify(expandedRange) ===
      JSON.stringify(
        await page.evaluate(() =>
          plot.layout.xaxis.range.map((value) => new Date(value).getTime()),
        ),
      ),
    "compact chart did not retain the range-selector window",
  );
  if (rangeSelectorChanged)
    assert(
      await page.evaluate(() =>
        [...document.querySelectorAll(".periods [data-period]")].every(
          (button) => button.getAttribute("aria-pressed") === "false",
        ),
      ),
      "a preset stayed highlighted after a manual range change",
    );
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);

  fixture("charging");
  await page.waitForTimeout(5200);
  assert(
    (await page.locator("#status").textContent()).includes("Sock is charging"),
    "charging state is not explicit",
  );
  assert(
    !(await page.locator(".overview").isVisible()) &&
      (await page.locator("#unavailableCopy").textContent()).includes(
        "unavailable",
      ),
    "charging exposed vital panels instead of explicit unavailable readings",
  );
  assert(
    JSON.stringify(expandedRange) ===
      JSON.stringify(
        await page.evaluate(() =>
          plot.layout.xaxis.range.map((value) => new Date(value).getTime()),
        ),
      ),
    "charging reset the manual chart range",
  );

  fixture("oxygen_sentinel");
  await page.waitForTimeout(5200);
  assert(
    await page.locator(".overview").isVisible(),
    "active vitals did not recover after charging",
  );
  assert(
    (await page.locator("#oxygen").textContent()).trim().startsWith("—"),
    "oxygen sentinel appeared as a reading",
  );
  assert(
    (await page.locator("#oxygenCaption").textContent()).includes(
      "unavailable",
    ),
    "oxygen sentinel lacks an unavailable label",
  );
  fixture("sock_off");
  await page.waitForTimeout(5200);
  assert(
    (await page.locator("#status").textContent()).includes("Sock is off"),
    "sock-off state is not explicit",
  );
  fixture("base_off");
  await page.waitForTimeout(5200);
  assert(
    (await page.locator("#status").textContent()).includes(
      "Base station is off",
    ),
    "base-off state is not explicit",
  );
  fixture("monitoring", 115);
  await page.waitForTimeout(5200);
  const ageBefore = Number(
    await page.locator("#status").getAttribute("data-age-seconds"),
  );
  await page.route("**/api/latest", (route) => route.abort());
  await page.waitForTimeout(6200);
  const ageAfter = Number(
    await page.locator("#status").getAttribute("data-age-seconds"),
  );
  assert(
    (await page.locator("#status").textContent()).includes("stale"),
    "failed polling did not identify a reading that became stale",
  );
  assert(
    (await page.locator("#status").textContent()).includes("Update failed"),
    "failed latest request is not explicit",
  );
  assert(
    ageAfter > ageBefore,
    "freshness stopped advancing after request failure",
  );

  await page.unroute("**/api/latest");
  fixture("monitoring");
  await page.waitForTimeout(5200);
  assert(
    await page.locator(".overview").isVisible(),
    "fresh active vitals did not recover after failed polling",
  );
  assert(
    !(await page.locator("#notice").isVisible()),
    "failure notice remained after recovery",
  );
  assert(
    JSON.stringify(expandedRange) ===
      JSON.stringify(
        await page.evaluate(() =>
          plot.layout.xaxis.range.map((value) => new Date(value).getTime()),
        ),
      ),
    "recovery reset the manual chart range",
  );
  fixture("no_data");
  await page.waitForTimeout(5200);
  assert(
    (await page.locator("#status").textContent()).includes(
      "No readings recorded yet",
    ),
    "no-data state is not distinct from a failed request",
  );
  const emptyRefresh = page.waitForResponse((response) =>
    response.url().includes("/api/series"),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await emptyRefresh;
  await page.waitForFunction(() => document.querySelector("#expand").disabled);
  assert(
    await page.locator("#expand").isDisabled(),
    "expand is active with no chart data",
  );
  assert(
    (await page.getByRole("button", { name: "Zoom in" }).count()) === 0,
    "technical tools are exposed with no chart data",
  );

  assert(
    rangeSelectorChanged,
    "expanded range-selector handle did not change the selected window",
  );

  await context.close();
  console.log("Live browser acceptance passed");
} finally {
  await browser.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([
      once(server, "exit"),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("fixture service did not stop")),
          5000,
        ),
      ),
    ]);
  }
  rmSync(temporary, { recursive: true, force: true });
}
