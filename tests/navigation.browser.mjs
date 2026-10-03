import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const python = process.env.PYTHON || ".venv/bin/python";
const port = 18510;
const temporary = mkdtempSync(join(tmpdir(), "owlet-navigation-"));
const database = join(temporary, "owlet.db");
const screenshots = "/private/tmp/owlet-ui-polish-navigation-screenshots";
mkdirSync(screenshots, { recursive: true });

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
    if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
  } catch (error) {}
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE,
  headless: true,
});

async function assertNoNavigationOverlap(page, label) {
  const result = await page.evaluate(async () => {
    const main = document.querySelector("main");
    const nav = document.querySelector("nav");
    const mainStyle = getComputedStyle(main);
    const mainScrolls = mainStyle.overflowY === "auto";
    const scrollElement = mainScrolls ? main : document.scrollingElement;
    const maximum = scrollElement.scrollHeight - scrollElement.clientHeight;
    const intersections = [];
    const offscreenNavigation = [];
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      scrollElement.scrollTop = maximum * fraction;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const navBox = nav.getBoundingClientRect();
      if (
        navBox.top < 0 ||
        navBox.bottom > innerHeight ||
        navBox.left < 0 ||
        navBox.right > innerWidth
      )
        offscreenNavigation.push({ fraction, box: navBox.toJSON() });
      const mainBox = main.getBoundingClientRect();
      const candidates = main.querySelectorAll(
        ".plot, .chart-meta, button, select, summary",
      );
      for (const candidate of candidates) {
        const box = candidate.getBoundingClientRect();
        const visibleBox = {
          left: Math.max(box.left, mainBox.left, 0),
          right: Math.min(box.right, mainBox.right, innerWidth),
          top: Math.max(box.top, mainBox.top, 0),
          bottom: Math.min(box.bottom, mainBox.bottom, innerHeight),
        };
        const visible =
          visibleBox.bottom > visibleBox.top &&
          visibleBox.right > visibleBox.left;
        const intersects =
          visible &&
          visibleBox.left < navBox.right &&
          visibleBox.right > navBox.left &&
          visibleBox.top < navBox.bottom &&
          visibleBox.bottom > navBox.top;
        if (intersects)
          intersections.push({
            fraction,
            target: candidate.id || candidate.className || candidate.tagName,
          });
      }
    }
    return {
      intersections,
      offscreenNavigation,
      mainScrolls,
      bodyOverflow: getComputedStyle(document.body).overflowY,
      windowScrollY: window.scrollY,
      documentScrollRange:
        document.scrollingElement.scrollHeight -
        document.scrollingElement.clientHeight,
      mainScrollTop: main.scrollTop,
      mainScrollHeight: main.scrollHeight,
      mainClientHeight: main.clientHeight,
      nav: nav.getBoundingClientRect().toJSON(),
      main: main.getBoundingClientRect().toJSON(),
    };
  });
  assert(
    result.intersections.length === 0,
    `${label} navigation intersects content: ${JSON.stringify(result)}`,
  );
  assert(
    result.offscreenNavigation.length === 0,
    `${label} navigation is outside the viewport: ${JSON.stringify(result.offscreenNavigation)}`,
  );
  assert(result.mainScrolls, `${label} main is not the scroll region`);
  assert(
    result.documentScrollRange === 0 && result.windowScrollY === 0,
    `${label} document can scroll behind main: ${JSON.stringify(result)}`,
  );
  assert(
    result.mainScrollHeight <= result.mainClientHeight ||
      result.mainScrollTop > 0,
    `${label} overflowing main content did not scroll`,
  );
  return result;
}

async function assertFocusedControlClear(page, label) {
  const target = page.locator("main summary").last();
  await target.focus();
  const geometry = await page.evaluate(() => {
    const target = document.activeElement.getBoundingClientRect();
    const main = document.querySelector("main").getBoundingClientRect();
    const nav = document.querySelector("nav").getBoundingClientRect();
    return {
      visible: target.top >= main.top && target.bottom <= main.bottom,
      intersects:
        target.left < nav.right &&
        target.right > nav.left &&
        target.top < nav.bottom &&
        target.bottom > nav.top,
    };
  });
  assert(geometry.visible, `${label} focused control is clipped`);
  assert(!geometry.intersects, `${label} navigation covers focused control`);
}

try {
  const sizes = [
    { width: 390, height: 844 },
    { width: 360, height: 780 },
    { width: 1440, height: 1000 },
  ];
  const routes = ["/", "/week?date=2026-09-13", "/trends"];
  for (const size of sizes) {
    const context = await browser.newContext({ viewport: size });
    const page = await context.newPage();
    for (const route of routes) {
      await page.goto(`http://127.0.0.1:${port}${route}`);
      await page.waitForSelector("#plot.js-plotly-plot");
      const label = `${route} at ${size.width}x${size.height}`;
      const layout = await assertNoNavigationOverlap(page, label);
      if (size.width <= 600) {
        assert(layout.mainScrolls, `${label} main is not the scroll region`);
        assert(
          layout.windowScrollY === 0,
          `${label} window scrolled behind main`,
        );
        assert(layout.mainScrollTop > 0, `${label} main did not scroll`);
        assert(
          layout.main.bottom <= layout.nav.top,
          `${label} mobile navigation is inside the content viewport`,
        );
      } else {
        assert(
          layout.nav.bottom <= layout.main.top,
          `${label} desktop navigation does not sit above content`,
        );
      }
      await assertFocusedControlClear(page, label);
    }
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector("#plot.js-plotly-plot");
    await page.screenshot({
      path: `${screenshots}/live-${size.width}x${size.height}.png`,
    });
    await context.close();
  }

  // A 195x422 CSS viewport matches the layout space available when a
  // 390x844 page is enlarged to 200%, without scaling the 100dvh shell.
  const zoomContext = await browser.newContext({
    viewport: { width: 195, height: 422 },
  });
  const zoomPage = await zoomContext.newPage();
  for (const route of routes) {
    await zoomPage.goto(`http://127.0.0.1:${port}${route}`);
    await zoomPage.waitForSelector("#plot.js-plotly-plot");
    await assertNoNavigationOverlap(zoomPage, `${route} at 200% equivalent`);
    await assertFocusedControlClear(zoomPage, `${route} at 200% equivalent`);
  }
  await zoomPage.goto(`http://127.0.0.1:${port}/week?date=2026-09-13`);
  await zoomPage.waitForSelector("#plot.js-plotly-plot");
  const zoomLayout = await assertNoNavigationOverlap(
    zoomPage,
    "Night at 200% equivalent",
  );
  assert(zoomLayout.mainScrolls, "200% Night main is not scrollable");
  assert(
    zoomLayout.mainScrollHeight > zoomLayout.mainClientHeight,
    "200% Night content has no reachable scroll range",
  );

  const opener = zoomPage.getByRole("button", { name: "Explore chart" });
  await assertFocusedControlClear(zoomPage, "Night at 200% equivalent");
  await opener.click();
  const close = zoomPage.getByRole("button", { name: "Close Explore" });
  const closeBox = await close.boundingBox();
  assert(
    closeBox &&
      closeBox.y >= 0 &&
      closeBox.y + closeBox.height <= 422 &&
      closeBox.x >= 0 &&
      closeBox.x + closeBox.width <= 195,
    `200% dialog close button is outside the viewport: ${JSON.stringify(closeBox)}`,
  );
  await close.focus();
  assert(await close.evaluate((element) => element.matches(":focus")));
  await close.press("Enter");
  await zoomPage.waitForFunction(() => document.activeElement?.id === "expand");
  assert(await opener.evaluate((element) => element.matches(":focus")));
  await zoomPage.screenshot({ path: `${screenshots}/night-200-percent.png` });
  await zoomContext.close();
  console.log(`Navigation browser acceptance passed; captures: ${screenshots}`);
} finally {
  await browser.close();
  if (!server.killed) server.kill("SIGTERM");
  if (server.exitCode === null)
    await new Promise((resolve) => server.once("exit", resolve));
  rmSync(temporary, { recursive: true, force: true });
}
