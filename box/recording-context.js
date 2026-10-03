window.OwletContext = (() => {
  const colors = {
    "Readings recorded": "#b8c8c2",
    "Charging reported": "#b1a17d",
    "Sock off reported": "#859bb2",
    "Base off reported": "#857e94",
    "Reading unavailable": "#7a9393",
    "Device state unknown": "#68767c",
    "State change between reports": "#7b8580",
    "Nothing recorded": "#28373d",
  };
  const elements = new WeakMap();
  const ns = "http://www.w3.org/2000/svg";

  function render(plot, intervals, timezone) {
    const axis = plot._fullLayout?.xaxis;
    if (plot.hidden || !axis?.range || !intervals.length) {
      const existing = elements.get(plot);
      if (existing) existing.container.hidden = true;
      return;
    }
    let view = elements.get(plot);
    if (!view) {
      const container = document.createElement("section");
      container.className = "recording-context";
      container.setAttribute("aria-label", "Recording context");
      const strip = document.createElementNS(ns, "svg");
      strip.classList.add("context-strip");
      strip.setAttribute("viewBox", "0 0 1000 16");
      strip.setAttribute("preserveAspectRatio", "none");
      strip.setAttribute("aria-hidden", "true");
      const label = document.createElement("label");
      const select = document.createElement("select");
      select.id = `${plot.id}-context-period`;
      label.htmlFor = select.id;
      label.textContent = "Recording context · Select a period";
      const detail = document.createElement("p");
      detail.className = "context-detail";
      detail.setAttribute("aria-live", "polite");
      container.append(strip, label, select, detail);
      plot.after(container);
      view = { container, strip, select, detail };
      elements.set(plot, view);
    }
    const [start, end] = axis.range.map((value) => Number(value) / 1000);
    if (!(end > start)) {
      view.container.hidden = true;
      return;
    }
    const visible = intervals.filter(
      (item) => item.end > start && item.start < end,
    );
    // A window of unbroken readings has nothing to explain, so only show the
    // strip when a recorded interval in view is something else. Blank padding
    // before the first or after the last report is not a gap in the recording.
    if (visible.every((item) => item.label === "Readings recorded")) {
      view.container.hidden = true;
      return;
    }
    const blank = (a, b) => ({
      start: a,
      end: b,
      label: "Nothing recorded",
      synthetic: true,
    });
    if (!visible.length) visible.push(blank(start, end));
    else {
      if (visible[0].start > start)
        visible.unshift(blank(start, visible[0].start));
      if (visible.at(-1).end < end)
        visible.push(blank(visible.at(-1).end, end));
    }
    const format = (seconds) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone || "UTC",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      }).format(seconds * 1000);
    const old = view.select.value;
    view.select.replaceChildren();
    view.strip.replaceChildren();
    view.strip.style.marginLeft = `${axis._offset}px`;
    view.strip.style.width = `${axis._length}px`;
    visible.forEach((item, index) => {
      const a = Math.max(start, item.start),
        b = Math.min(end, item.end);
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", (1000 * (a - start)) / (end - start));
      rect.setAttribute("width", (1000 * (b - a)) / (end - start));
      rect.setAttribute("height", 16);
      rect.setAttribute(
        "fill",
        colors[item.label] || colors["Device state unknown"],
      );
      view.strip.append(rect);
      const option = document.createElement("option");
      option.value = `${item.start}:${item.end}`;
      option.textContent = `${format(a)} to ${format(b)} · ${item.label}`;
      view.select.append(option);
    });
    const flag = (value) =>
      value == null
        ? "unknown"
        : value === 0
          ? "no"
          : value === 1
            ? "yes"
            : `code ${value}`;
    const report = (row) =>
      row
        ? `${format(row.sample_ts)}: charging ${row.charging ?? "unknown"}, sock off ${flag(row.sock_off)}, base on ${flag(row.base_station_on)}, battery ${row.battery_percentage == null ? "unknown" : `${row.battery_percentage}%`}.`
        : "No recorded device report at this boundary.";
    const show = () => {
      const item = visible[view.select.selectedIndex];
      if (!item) return;
      view.detail.textContent = `${item.label}. ${report(item.before)} ${report(item.after)} Reports are sampled; gaps do not identify a cause.`;
    };
    // Keep the user's choice across redraws by interval start: the newest
    // interval's end moves with every poll. Otherwise default to the largest
    // recorded interval in view, not whatever sliver sits at the left edge.
    const keep = [...view.select.options].find(
      (option) => option.value.split(":")[0] === old.split(":")[0],
    );
    if (old && keep) view.select.value = keep.value;
    else {
      const span = (item) =>
        item.synthetic
          ? -1
          : Math.min(end, item.end) - Math.max(start, item.start);
      view.select.selectedIndex = visible.reduce(
        (best, item, index) =>
          span(item) > span(visible[best]) ? index : best,
        0,
      );
    }
    view.select.onchange = show;
    view.strip.onclick = (event) => {
      const box = view.strip.getBoundingClientRect();
      const time =
        start + ((event.clientX - box.left) / box.width) * (end - start);
      const index = visible.findIndex(
        (item) => item.start <= time && time <= item.end,
      );
      if (index >= 0) {
        view.select.selectedIndex = index;
        show();
      }
    };
    show();
    view.container.hidden = false;
  }
  return { render };
})();
