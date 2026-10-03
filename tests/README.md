# Local verification

These checks run the real HTTP service against temporary SQLite records and render the bundled Plotly in a browser. They do not read a real recording, contact Owlet, or need account credentials.

Install Python dependencies with `uv sync` and browser-test dependencies with `npm ci`. Then run the HTTP checks:

```sh
uv run python -m unittest discover -s tests -p 'test_*.py'
```

Browser tests use `PYTHON` for the Python executable, defaulting to `.venv/bin/python`. Install the default browser with `npx playwright install chromium`, or set `CHROME_EXECUTABLE` to use an installed Chrome or Chromium binary. For example, on macOS:

```sh
CHROME_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
```

Browser tests create isolated browser sessions and loopback fixture servers. They must be permitted to launch subprocesses and bind loopback ports. Run the suite once at a time from a checkout to avoid fixture-port collisions.

The eleven browser suites cover Live freshness and polling, selected-night history and daylight-saving boundaries, Trends drill-through, reported sleep, and shared keyboard/touch inspection. The UI polish regressions also check reserved navigation space, first-screen plot visibility, compact/Explore controls, rapid dialog reopening, inactive-state history lookup, responsive axes, and selected-observation readouts through refresh, metric changes, and range changes. The typography matrix checks hierarchy, complete metric labels, text size, contrast, navigation icons and touch-target hit areas across normal and enlarged layouts.

Run an individual suite through its `test:browser:<name>` package script. The tests drive the served pages with pointer, touch, and keyboard input. Chart data and layout observations check exact values and retained ranges; tests do not manufacture Plotly events or replace the chart controller.

These are Chromium checks with emulated phone input, not physical-iPhone or Safari acceptance. The enlarged-layout checks use a halved CSS viewport to exercise reflow and scroll reachability, not a physical browser's zoom control. Visual acceptance also requires inspecting the captured pages; passing geometry and interaction assertions alone is insufficient.

Check delivery syntax and local asset completeness without contacting a server:

```sh
bash -n box/deploy.sh box/push-ui.sh box/ui-assets.sh
shellcheck -x box/deploy.sh box/push-ui.sh box/ui-assets.sh
bash -c 'source box/ui-assets.sh; validate_ui_assets box'
```

Fixtures use `--timezone Europe/London` because it has DST changes to test against; the app itself defaults to UTC.
