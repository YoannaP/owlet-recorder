// Record the README walkthrough from synthetic data.
//
//   uv run python scripts/demo_data.py data/demo.db --timezone America/New_York --live &
//   uv run python server.py --db data/demo.db --timezone America/New_York --port 8471 &
//   node scripts/record_demo.mjs http://127.0.0.1:8471 frames/
//
// Writes numbered PNG frames; scripts/make_gif.py turns them into docs/demo.gif.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const [base = "http://127.0.0.1:8471", out = "frames"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
const page = await browser.newPage({
  viewport: { width: 1280, height: 1130 },
  timezoneId: "America/New_York",
  colorScheme: "dark",
});

let frame = 0;
const snap = async () =>
  page.screenshot({ path: join(out, `${String(frame++).padStart(4, "0")}.png`) });
// Capture roughly every 250 ms for `ms`, so live updates and transitions show.
const hold = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await snap();
    await page.waitForTimeout(250);
  }
};
const plotReady = () =>
  page.waitForFunction(() => document.querySelector("#plot")?.data?.length > 0, null, {
    timeout: 15000,
  });
const click = async (selector, ms = 1400) => {
  await page.locator(selector).first().click();
  await hold(ms);
};

// Live: let a few five-second readings arrive, then explore ranges and metrics.
await page.goto(`${base}/`);
await plotReady();
await hold(6000);
await click('[data-period="1"]');
await click('[data-period="3"]');
await click('[data-period="all"]', 1000);
await click("#tab-ox");
await click("#tab-sleep");
await click("#tab-movement");
await click("#tab-position");
await click("#tab-hr", 3000);

// Night: last night in full, zoom to three hours, then step back a night.
await click('a[href="/week"]:visible', 0);
await plotReady();
await hold(2000);
await click("#tab-sleep");
await click('[data-period="3"]');
await click('[data-period="all"]', 1000);
await click("#older", 1800);
await click("#tab-hr", 2000);

// Trends: change the period and the statistic.
await click('a[href="/trends"]:visible', 0);
await plotReady();
await hold(1800);
await click('[data-period="7"]');
await click('[data-period="all"]');
await click("#tab-sleep_hours");
await click("#tab-oxygen_p5");
await click("#tab-hr_median", 2000);

// Back to Live to end on the moving view.
await click('a[href="/"]:visible', 0);
await plotReady();
await hold(5000);

await browser.close();
console.log(`${frame} frames in ${out}`);
