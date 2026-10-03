import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const python = process.env.PYTHON || ".venv/bin/python";
const temporary = mkdtempSync("/private/tmp/owlet-inactive-data-");
const captures = mkdtempSync("/private/tmp/owlet-inactive-review-");
const database = join(temporary, "synthetic.db");
const port = 18513;
function fixture(state = "monitoring", age = 0) {
  rmSync(database, { force: true });
  const result = spawnSync(
    python,
    [
      "tests/live_fixture.py",
      database,
      "--state",
      state === "no_reading" ? "monitoring" : state,
      "--age-seconds",
      String(age),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  if (state === "no_reading") {
    const zero = spawnSync(
      python,
      [
        "-c",
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE vitals SET heart_rate=0, oxygen_saturation=0 WHERE sample_ts=(SELECT MAX(sample_ts) FROM vitals)'); c.commit(); c.close()",
        database,
      ],
      { encoding: "utf8" },
    );
    assert.equal(zero.status, 0, zero.stderr);
  }
}
fixture("charging");
const server = spawn(
  python,
  ["server.py", "--port", String(port), "--db", database, "--timezone", "Europe/London"],
  { stdio: "ignore" },
);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE,
  headless: true,
});
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    timezoneId: "Europe/London",
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Sock is charging"),
  );
  await page.screenshot({ path: join(captures, "charging-390.png") });
  assert.equal(
    await page.locator(".overview").isVisible(),
    false,
    "charging still exposes oversized empty vital panels",
  );
  const history = page.getByRole("link", {
    name: "View latest recorded night",
  });
  await history.waitFor();
  assert.equal(await history.getAttribute("href"), "/week");
  const bounds = await history.boundingBox();
  assert(
    bounds.y >= 0 && bounds.y + bounds.height < 782,
    "history action is below the first phone screen",
  );
  assert.equal(await page.locator("#deviceFacts").isVisible(), false);
  await page.getByText("Device details", { exact: true }).focus();
  await page.keyboard.press("Enter");
  assert(
    await page.locator("#deviceFacts").isVisible(),
    "Device details cannot be opened with the keyboard",
  );
  assert.match(
    await page.locator("#deviceDetails").textContent(),
    /Raw signal.*4/,
  );
  const nights = await (
    await page.request.get(`http://127.0.0.1:${port}/api/nights?days=all`)
  ).json();
  await history.click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#nightTitle").textContent.includes("Loading"),
  );
  await page.waitForURL(`**/week?date=${nights.nights[0].night}`);
  await page.close();

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 360, height: 780 },
    { width: 1440, height: 1000 },
    { width: 195, height: 422 },
  ]) {
    for (const kind of [
      "monitoring",
      "charging",
      "sock_off",
      "base_off",
      "no_reading",
      "stale",
      "failed",
      "no_data",
      "lookup_failure",
    ]) {
      fixture(
        kind === "failed" || kind === "lookup_failure" ? "charging" : kind,
      );
      const current = await browser.newPage({
        viewport,
        timezoneId: "Europe/London",
      });
      if (kind === "lookup_failure")
        await current.route("**/api/nights?**", (route) => route.abort());
      await current.goto(`http://127.0.0.1:${port}/`);
      await current.waitForFunction(
        () =>
          !document.querySelector("#status").textContent.includes("Loading"),
      );
      if (kind === "failed") {
        await current.route("**/api/latest", (route) => route.abort());
        await current.evaluate(() =>
          document.dispatchEvent(new Event("visibilitychange")),
        );
        await current.waitForFunction(() =>
          document
            .querySelector("#status")
            .textContent.includes("Update failed"),
        );
      }
      if (kind !== "monitoring")
        await current.waitForFunction(
          () =>
            document.querySelector("#historyMessage").hidden ||
            !document
              .querySelector("#historyMessage")
              .textContent.includes("Checking"),
        );
      await current.waitForTimeout(150);
      assert.equal(
        await current.locator(".overview").isVisible(),
        kind === "monitoring",
        `${kind} vital visibility at ${viewport.width}`,
      );
      assert(
        await current.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${kind} horizontal overflow at ${viewport.width}`,
      );
      if (kind === "no_data") {
        assert.match(
          await current.locator("#historyStatus").textContent(),
          /No recorded nights yet/,
        );
        assert.equal(
          await current
            .getByRole("link", { name: "View latest recorded night" })
            .isVisible(),
          false,
        );
      }
      if (kind === "lookup_failure") {
        assert.match(
          await current.locator("#historyStatus").textContent(),
          /could not be checked/,
        );
        await current
          .getByRole("button", { name: "Retry history lookup" })
          .scrollIntoViewIfNeeded();
      }
      if (kind === "charging") {
        const visibleText = await current.locator("main").innerText();
        // The recording-context detail quotes raw device reports ("charging
        // 0"). Those are data, not the explanation this check guards.
        const explanationText = await current.evaluate(() => {
          const main = document.querySelector("main").cloneNode(true);
          main.querySelectorAll(".context-detail").forEach((e) => e.remove());
          document.body.append(main);
          const text = main.innerText;
          main.remove();
          return text;
        });
        assert.equal(
          (explanationText.match(/charging/gi) || []).length,
          1,
          "charging explanation is repeated",
        );
        assert.match(visibleText, /Battery 82%/);
        const action = current.getByRole("link", {
          name: "View latest recorded night",
        });
        if (viewport.width === 390) {
          const actionBounds = await action.boundingBox();
          assert(
            actionBounds.y + actionBounds.height <= 782,
            "latest night is not visible before scrolling",
          );
        }
        await action.focus();
        assert(
          await action.evaluate((node) => node === document.activeElement),
          "history action cannot receive keyboard focus",
        );
      }
      await current.screenshot({
        path: join(captures, `${kind}-${viewport.width}.png`),
      });
      await current.close();
    }
  }

  fixture("charging");
  const lifecycle = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  let historyRequests = 0;
  lifecycle.on("request", (request) => {
    if (request.url().includes("/api/nights")) historyRequests++;
  });
  await lifecycle.route("**/api/nights?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await lifecycle.goto(`http://127.0.0.1:${port}/`);
  await lifecycle
    .getByText("Checking for recorded nights…", { exact: true })
    .waitFor();
  assert.equal(
    await lifecycle
      .getByRole("link", { name: "View latest recorded night" })
      .isVisible(),
    false,
    "history link exposed before lookup",
  );
  await lifecycle.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await lifecycle
    .getByRole("link", { name: "View latest recorded night" })
    .waitFor();
  await lifecycle.waitForTimeout(5200);
  assert.equal(
    historyRequests,
    1,
    "history was requested repeatedly during age updates or polling",
  );
  await lifecycle.close();

  const retry = await browser.newPage();
  await retry.route("**/api/nights?**", (route) => route.abort());
  await retry.goto(`http://127.0.0.1:${port}/`);
  await retry.getByRole("button", { name: "Retry history lookup" }).waitFor();
  await retry.unroute("**/api/nights?**");
  await retry.getByRole("button", { name: "Retry history lookup" }).click();
  await retry
    .getByRole("link", { name: "View latest recorded night" })
    .waitFor();
  await retry.close();

  const timeout = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  await timeout.route("**/api/nights?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    await route.continue().catch(() => {});
  });
  await timeout.goto(`http://127.0.0.1:${port}/`);
  await timeout
    .getByRole("button", { name: "Retry history lookup" })
    .waitFor({ timeout: 9500 });
  assert.equal(
    await timeout
      .getByRole("link", { name: "View latest recorded night" })
      .isVisible(),
    false,
    "timed out history lookup exposed an unverified action",
  );
  await timeout.close();

  const firstFailure = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  await firstFailure.route("**/api/latest", (route) => route.abort());
  await firstFailure.goto(`http://127.0.0.1:${port}/`);
  await firstFailure
    .getByText("Unable to load recorded readings", { exact: true })
    .waitFor();
  assert.equal(await firstFailure.locator(".overview").isVisible(), false);
  assert.equal(
    await firstFailure.locator("#status").getAttribute("data-age-seconds"),
    null,
    "first failure invented a sample age",
  );
  await firstFailure
    .getByRole("link", { name: "View latest recorded night" })
    .waitFor();
  await firstFailure.screenshot({
    path: join(captures, "first-request-failed-390.png"),
  });
  await firstFailure.close();

  fixture("no_data");
  const gainedHistory = await browser.newPage();
  await gainedHistory.goto(`http://127.0.0.1:${port}/`);
  await gainedHistory
    .getByText("No recorded nights yet.", { exact: true })
    .waitFor();
  fixture("charging");
  await gainedHistory.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await gainedHistory
    .getByRole("link", { name: "View latest recorded night" })
    .waitFor({ timeout: 3000 });
  fixture("no_data");
  await gainedHistory.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await gainedHistory
    .getByText("No recorded nights yet.", { exact: true })
    .waitFor({ timeout: 3000 });
  assert.equal(
    await gainedHistory
      .getByRole("link", { name: "View latest recorded night" })
      .isVisible(),
    false,
    "empty recorder retained a cached history link",
  );
  await gainedHistory.close();
  console.log(`Inactive browser acceptance passed; captures: ${captures}`);
} finally {
  await browser.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  rmSync(temporary, { recursive: true, force: true });
}
