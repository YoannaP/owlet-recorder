# owlet-recorder: notes for contributors and coding agents

Records an Owlet Dream Sock's reported vitals into SQLite and serves Live,
Night and Trends. Read `README.md` for setup and `docs/owlet-api.md` for what
is known about Owlet's cloud. `CONTEXT.md` is the vocabulary.

## The rule that matters most

This is a **record, not a monitor**. It polls Owlet's cloud after the fact and
can stop silently. Every page says the Owlet app and base station remain the
alarm. Keep it that way: no alarms, no health scores, no clinical
interpretation.

## Honesty cues

- Gaps must read as gaps. Never draw a line or fill across missing data.
- "Not monitoring" (charging, sock off, base off) must never render as `0 bpm`.
- Show coverage alongside any summary number.
- Label anything unverified as such (skin temperature is "Celsius assumed").
- Oxygen sits at 99–100 all night. Keep its axis fixed (85–101) rather than
  auto-ranging, or ordinary flicker looks like cliffs. The signal is dips and
  the low percentile, not the average.
- Daily maximum heart rate pins near 200 whenever the baby cries. Use
  percentiles (p5/p50/p95), not min/max.

## Privacy

- Never commit `.owlet_tokens`, `data/`, or any recording. Fixtures in
  `tests/` are generated.
- Logs carry counts only, never vitals. `--log-vitals` is for local debugging.
- The web app has no authentication. It binds loopback; never `0.0.0.0`. It
  only answers allowed `Host` names (DNS-rebinding protection) and serves only
  page assets (`.html`, `.js`, `.css`) directly in `box/`; keep both checks
  when adding routes, and never put a private file with those extensions there.
- Log errors with `owlet_client.describe()`, never the exception message: it
  can carry request URLs, the device serial or headers.

## Gotchas

- `charging` is not a boolean (it reads `2` on the base). Use the server's
  `monitoring` flag.
- Plotly `fill:'tozeroy'`/`'tonexty'` ignores nulls and paints across a gap;
  `connectgaps:false` does not help. Split each unbroken run into its own trace.
- Plotly infers a date axis from a series with leading nulls and discards the
  range. Pin `type:'linear'` on value axes.
- Pages and assets must send `Cache-Control: no-cache`, or browsers serve a
  stale copy and a deployed change looks like it never landed.
- Screenshots of Plotly can look blank mid-render. Verify by reading
  `el.data`/`el.layout` in the page.
- A night is local noon to noon in the configured time zone (`--timezone` /
  `OWLET_TIMEZONE`). Test across midnight and DST changes.

## Checks

```sh
uv run python -m unittest discover -s tests -p 'test_*.py'
npm run test:browser
bash -c 'source box/ui-assets.sh; validate_ui_assets box'
```

A new front-end file must be added to `box/ui-assets.sh`, or the deploy scripts
refuse to ship it.
