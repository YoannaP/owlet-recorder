(() => {
  Object.assign(OwletChart.metrics, {
    hr_median: {
      name: "Median heart rate",
      unit: "bpm",
      range: null,
      dtick: 20,
      minor: 5,
    },
    oxygen_p5: {
      name: "Oxygen 5th percentile",
      unit: "%",
      range: [85, 101],
      dtick: 5,
      minor: 1,
    },
    sleep_hours: {
      name: "Recorded sleep",
      unit: "h",
      range: null,
      dtick: 1,
      minor: 0.25,
    },
    coverage_percent: {
      name: "Recording coverage",
      unit: "%",
      range: [0, 101],
      dtick: 20,
      minor: 5,
    },
    movement_active_percent: {
      name: "Movement reported",
      unit: "%",
      range: [0, 101],
      dtick: 20,
      minor: 5,
    },
    temp_median: {
      name: "Median sock temperature",
      unit: "°C",
      range: null,
      dtick: 1,
      minor: 0.5,
    },
    position_back_percent: {
      name: "Position on back",
      unit: "%",
      range: [0, 101],
      dtick: 20,
      minor: 5,
    },
  });
  const PERCENT_METRICS = new Set([
    "coverage_percent",
    "movement_active_percent",
    "position_back_percent",
  ]);
  const percent = (fraction) => (fraction == null ? null : fraction * 100);
  const metricNote = (row) => {
    if (state.metric === "movement_active_percent")
      return row.movement_active == null
        ? "No eligible movement readings"
        : "Share of recorded time with reported movement above zero";
    if (state.metric === "temp_median")
      return row.temp_median == null
        ? "No eligible sock-temperature readings"
        : "Celsius assumed · Not body or room temperature";
    if (state.metric === "position_back_percent")
      return row.position_observations
        ? `Back ${Math.round(percent(row.position_back))}% · Side ${Math.round(percent(row.position_side))}% · Tummy ${Math.round(percent(row.position_tummy))}% of ${row.position_observations} archived observations`
        : "No position history archived";
    return "";
  };

  const state = {
    metric: "hr_median",
    period: "7",
    dragmode: "zoom",
    style: "line",
    lineMode: "lines+markers",
    axisDateOnly: true,
    range: null,
    rows: [],
    gapAfter: 36 * 3600,
    timezone: "UTC",
  };
  let expandedOpener = null;
  let requestNumber = 0;
  const byId = (id) => document.getElementById(id);
  const activePlots = () => [
    byId("plot"),
    ...(byId("expanded").open ? [byId("expandedPlot")] : []),
  ];
  const dateFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const controller = OwletChart.controller({
    state,
    rows: () => state.rows,
    plots: activePlots,
    onPeriod: () => {},
    onSelect: ({ customdata }) => {
      const night = customdata?.[0];
      if (night) {
        selectReadout(state.rows.find((row) => row.night === night));
        byId("expandedOpenNight").disabled = false;
      }
    },
  });

  const formatValue = (row) => {
    const metric = OwletChart.metrics[state.metric];
    const value = row?.[state.metric];
    const decimals = PERCENT_METRICS.has(state.metric) ? 0 : 1;
    return value == null
      ? "—"
      : `${Number(value).toFixed(decimals)}<small> ${metric.unit}</small>`;
  };

  function setDataControlsEnabled(enabled) {
    document
      .querySelectorAll("[data-metric]")
      .forEach((control) => (control.disabled = !enabled));
    byId("expand").disabled = !enabled;
    byId("nightSelect").disabled = !enabled;
    byId("openNight").disabled = !enabled;
    byId("expandedOpenNight").disabled = !enabled;
  }

  function clearHistoryState(message, showEmpty) {
    controller.clearSelection();
    state.rows = [];
    state.range = null;
    state.manualRange = false;
    byId("nightSelect").replaceChildren();
    byId("chartValue").textContent = "—";
    byId("chartCaption").textContent = message;
    byId("plot").hidden = true;
    byId("chartEmpty").hidden = !showEmpty;
    setDataControlsEnabled(false);
  }

  function selectReadout(row) {
    if (!row) return;
    byId("nightSelect").value = row.night;
    byId("chartValue").innerHTML = formatValue(row);
    const note = metricNote(row);
    byId("chartCaption").textContent =
      `${dateFormat.format(new Date(row.t * 1000))} · ${Math.round(row.coverage_percent)}% coverage${note ? ` · ${note}` : ""}`;
  }

  function chartSpec(expanded) {
    const chart = OwletChart.spec(state.rows, state.gapAfter, state, expanded);
    const rowsByEpoch = new Map(state.rows.map((row) => [row.t * 1000, row]));
    chart.layout.xaxis.tickformat = "%d %b";
    chart.data.forEach((trace) => {
      trace.mode = state.style === "samples" ? "markers" : "lines+markers";
      trace.customdata = trace.x.map((value) => {
        const row = rowsByEpoch.get(new Date(value).getTime());
        return [row.night, Math.round(row.coverage_percent)];
      });
      trace.meta.context = trace.customdata.map(
        ([night, coverage]) => `Night ${night}, ${coverage}% coverage`,
      );
      trace.hovertemplate = `<b>%{y:.${PERCENT_METRICS.has(state.metric) ? 0 : 1}f} ${OwletChart.metrics[state.metric].unit}</b><br>Night %{customdata[0]}<br>%{customdata[1]}% coverage<extra></extra>`;
    });
    return chart;
  }

  async function draw(id = "plot", expanded = false) {
    if (!state.rows.length) return;
    const element = byId(id);
    await controller.render(element, chartSpec(expanded));
    if (!element.dataset.rangeListener) {
      element.on("plotly_relayout", (event) => {
        if (controller.rememberRange(event)) controller.labelAxis(element);
      });
      element.dataset.rangeListener = "true";
    }
  }

  async function loadPeriod(period) {
    const thisRequest = ++requestNumber;
    state.period = period;
    state.range = null;
    state.manualRange = false;
    document.querySelectorAll("[data-period]").forEach((button) => {
      const active = button.dataset.period === period;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active);
    });
    byId("status").querySelector("span").textContent =
      "Loading recorded nights…";
    byId("notice").hidden = true;
    byId("chartEmpty").textContent = "No recorded nights in this period.";
    clearHistoryState("Loading the selected period", false);
    try {
      const response = await fetch(`/api/nights?days=${period}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("request failed");
      const payload = await response.json();
      if (thisRequest !== requestNumber) return;
      state.timezone = payload.timezone;
      state.rows = payload.nights
        .slice()
        .reverse()
        .map((night) => ({
          ...night,
          t: night.window_start,
          sleep_hours: night.sleep_s / 3600,
          coverage_percent: night.coverage * 100,
          movement_active_percent: percent(night.movement_active),
          position_back_percent: percent(night.position_back),
        }));
      byId("nightSelect").replaceChildren(
        ...state.rows
          .slice()
          .reverse()
          .map((row) => new Option(row.night, row.night)),
      );
      byId("status").querySelector("span").textContent =
        `${state.rows.length} recorded ${state.rows.length === 1 ? "night" : "nights"} · ${payload.timezone}`;
      byId("resolution").textContent =
        `Nightly statistics · ${payload.timezone} · ${period === "all" ? "All history" : `${period} days`}`;
      byId("chartEmpty").hidden = state.rows.length > 0;
      byId("plot").hidden = state.rows.length === 0;
      setDataControlsEnabled(state.rows.length > 0);
      if (!state.rows.length) {
        byId("chartCaption").textContent = "No observations in this period";
        return;
      }
      selectReadout(state.rows.at(-1));
      await draw();
    } catch (error) {
      if (thisRequest !== requestNumber) return;
      byId("status").querySelector("span").textContent =
        "Unable to load recorded nights";
      byId("notice").hidden = false;
      byId("notice").textContent = "The request failed. Try this period again.";
      byId("chartEmpty").textContent = "Recorded nights could not be loaded.";
      clearHistoryState("History unavailable", true);
    }
  }

  document
    .querySelectorAll("[data-period]")
    .forEach((button) =>
      button.addEventListener("click", () => loadPeriod(button.dataset.period)),
    );
  document.querySelectorAll("[data-metric]").forEach((button) =>
    button.addEventListener("click", async () => {
      state.metric = button.dataset.metric;
      controller.clearSelection();
      document
        .querySelectorAll("[data-metric]")
        .forEach((item) => item.setAttribute("aria-selected", item === button));
      byId("chartPanel").setAttribute("aria-labelledby", button.id);
      byId("expandedTitle").textContent = OwletChart.metrics[state.metric].name;
      selectReadout(
        state.rows.find((row) => row.night === byId("nightSelect").value) ||
          state.rows.at(-1),
      );
      await draw();
      if (byId("expanded").open) await draw("expandedPlot", true);
    }),
  );
  byId("nightSelect").addEventListener("change", () =>
    selectReadout(
      state.rows.find((row) => row.night === byId("nightSelect").value),
    ),
  );
  byId("openNight").addEventListener("click", () => {
    if (byId("nightSelect").value)
      location.href = `/week?date=${encodeURIComponent(byId("nightSelect").value)}`;
  });
  byId("expandedOpenNight").addEventListener("click", () => {
    if (byId("nightSelect").value)
      location.href = `/week?date=${encodeURIComponent(byId("nightSelect").value)}`;
  });
  byId("expand").addEventListener("click", async (event) => {
    if (!state.rows.length) return;
    expandedOpener = event.currentTarget;
    byId("expandedTitle").textContent = OwletChart.metrics[state.metric].name;
    byId("expandedControls").innerHTML = OwletChart.controls(state);
    byId("expanded").showModal();
    await draw("expandedPlot", true);
    controller.wire(byId("expandedControls"));
  });
  byId("closeExpanded").addEventListener("click", () =>
    byId("expanded").close(),
  );
  OwletChart.closeOnBackdrop(byId("expanded"));
  byId("expanded").addEventListener("close", () =>
    controller.closeExpanded(byId("expanded"), expandedOpener),
  );
  loadPeriod("7");
})();
