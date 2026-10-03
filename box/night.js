(() => {
  const state = {
    metric: "hr",
    period: "all",
    dragmode: "zoom",
    style: "line",
    range: null,
    rows: [],
    vitalRows: [],
    sleepRows: [],
    temperatureRows: [],
    temperatureGapAfter: 60,
    temperatureResolution: "",
    movementRows: [],
    positionRows: [],
    recordingContext: [],
    gapAfter: 450,
    vitalGapAfter: 450,
    sleepGapAfter: 60,
    vitalResolution: "",
    sleepResolution: "",
    timezone: null,
    summary: null,
    pointContext: () =>
      selected
        ? `Night ${selected}${state.summary ? `, ${Math.round(state.summary.coverage * 100)}% coverage` : ""}`
        : "",
  };
  let nights = [];
  let selected = null;
  let requestNumber = 0;
  let expandedOpener = null;
  const byId = (id) => document.getElementById(id);
  const timeFormat = () =>
    new Intl.DateTimeFormat("en-GB", {
      ...(state.timezone ? { timeZone: state.timezone } : {}),
      hour: "2-digit",
      minute: "2-digit",
    });
  const formatDate = (key) =>
    new Intl.DateTimeFormat("en-GB", {
      ...(state.timezone ? { timeZone: state.timezone } : {}),
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(new Date(`${key}T12:00:00Z`));
  const duration = (seconds) => {
    const minutes = Math.round(seconds / 60);
    return `${Math.floor(minutes / 60)}<small> h</small> ${minutes % 60}<small> m</small>`;
  };
  const activePlots = () => [
    byId("plot"),
    ...(byId("expanded").open ? [byId("expandedPlot")] : []),
  ];
  const controller = OwletChart.controller({
    state,
    rows: () => state.rows,
    plots: activePlots,
    hourPresets: true,
    onPeriod: (period) =>
      document.querySelectorAll("[data-period]").forEach((button) => {
        const active = button.dataset.period === period;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active);
      }),
  });

  function setSummary(summary) {
    byId("recordedSleep").innerHTML = duration(summary.sleep_s);
    byId("sleepCaption").textContent = "Light and deep states · Full night";
    byId("coverage").innerHTML =
      `${Math.round(summary.coverage * 100)}<small>%</small>`;
    byId("coverageCaption").textContent =
      `${timeFormat().format(new Date(summary.start * 1000))} to ${timeFormat().format(new Date(summary.end * 1000))} · ${duration(summary.gap_s).replaceAll(/<[^>]+>/g, "")} missing`;
  }

  function setMetricCopy(summary) {
    const copy = {
      hr: [
        `${summary.hr_median}<small> bpm</small>`,
        "Median recorded · Full night",
        "Median heart rate is the middle valid recorded value across the selected night.",
      ],
      ox: [
        `${summary.oxygen_p5}<small> %</small>`,
        "5th percentile · Full night",
        "The 5th percentile is the oxygen value at or below which 5% of valid readings fall. The chart stays fixed at 85 to 101%.",
      ],
      sleep: [
        duration(summary.sleep_s),
        "Light and deep states · Full night",
        "Discrete sleep states reported by Owlet. Unknown states are explicit and missing intervals stay blank.",
      ],
      temp: [
        "Experimental",
        "Sock sensor · Celsius assumed",
        "Stored sock-sensor values shown assuming whole-degree Celsius. Units and accuracy are unverified. This is not body or room temperature. Missing and inactive readings stay blank.",
      ],
      movement: [
        "Movement",
        "Reported index · Original samples",
        "Movement reported by the sock. Zero is a reported zero, not a missing reading. The physical scale is undocumented; values are not movement counts or sleep stages.",
      ],
      position: [
        "Reported position",
        "Owlet history · Original observations",
        "Back, side and tummy labels come from Owlet's position-history API. Moving, undetected and unknown remain separate. This is a recorded estimate, not confirmation of posture. History can arrive later than vital readings.",
      ],
    }[state.metric];
    byId("chartValue").innerHTML = copy[0];
    byId("chartCaption").textContent = copy[1];
    byId("metricExplanation").textContent = copy[2];
  }

  function selectMetricRows() {
    if (state.metric === "movement" || state.metric === "position") {
      const rows =
        state.metric === "movement" ? state.movementRows : state.positionRows;
      state.rows = rows.some((row) => row[state.metric] != null) ? rows : [];
      state.gapAfter = 60;
      return;
    }
    if (state.metric === "temp") {
      state.rows = state.temperatureRows.some((row) => row.temp != null)
        ? state.temperatureRows
        : [];
      state.gapAfter = state.temperatureGapAfter;
      return;
    }
    const sleep = state.metric === "sleep";
    state.rows = sleep ? state.sleepRows : state.vitalRows;
    state.gapAfter = sleep ? state.sleepGapAfter : state.vitalGapAfter;
  }

  function currentResolution() {
    if (state.metric === "movement") return "Original movement observations";
    if (state.metric === "position")
      return "Owlet position history · May arrive later";
    if (state.metric === "temp") return state.temperatureResolution;
    return state.metric === "sleep"
      ? state.sleepResolution
      : state.vitalResolution;
  }

  function chartControlsEnabled(enabled) {
    document
      .querySelectorAll("[data-metric], [data-period], #expand")
      .forEach((button) => {
        button.disabled = !enabled;
      });
  }

  function unavailableSummary(failed = false) {
    state.summary = null;
    byId("recordedSleep").textContent = "—";
    byId("coverage").textContent = "—";
    byId("chartValue").textContent = "—";
    byId("sleepCaption").textContent = "No summary available";
    byId("coverageCaption").textContent = "No interval available";
    byId("chartCaption").textContent = "No summary available";
    byId("resolution").textContent = failed
      ? "Readings unavailable"
      : "No recorded readings";
    byId("metricExplanation").textContent = "";
    chartControlsEnabled(false);
  }

  async function draw(id = "plot", expanded = false) {
    if (!state.rows.length) return;
    const element = byId(id);
    const chart = OwletChart.spec(state.rows, state.gapAfter, state, expanded);
    await controller.render(element, chart);
    OwletContext.render(element, state.recordingContext, state.timezone);
    if (!element.dataset.contextListener) {
      element.on("plotly_afterplot", () =>
        OwletContext.render(element, state.recordingContext, state.timezone),
      );
      element.dataset.contextListener = "true";
    }
    if (!element.dataset.rangeListener) {
      element.on("plotly_relayout", (event) => {
        if (controller.rememberRange(event)) controller.labelAxis(element);
      });
      element.dataset.rangeListener = "true";
    }
  }

  async function selectNight(key) {
    const thisRequest = ++requestNumber;
    selected = key;
    state.rows = [];
    state.vitalRows = [];
    state.sleepRows = [];
    state.temperatureRows = [];
    state.movementRows = [];
    state.positionRows = [];
    state.recordingContext = [];
    document
      .querySelectorAll(".recording-context")
      .forEach((element) => (element.hidden = true));
    controller.setPeriod("all");
    state.summary = null;
    chartControlsEnabled(false);
    byId("nightTitle").textContent = formatDate(key);
    byId("status").querySelector("span").textContent =
      "Loading selected night…";
    byId("recordedSleep").textContent = "—";
    byId("coverage").innerHTML = "—<small>%</small>";
    byId("sleepCaption").textContent = "Loading full night";
    byId("coverageCaption").textContent = "Loading interval";
    byId("chartValue").textContent = "—";
    byId("chartCaption").textContent = "Loading full-night summary";
    byId("resolution").textContent = "Loading readings…";
    byId("plot").hidden = true;
    byId("chartEmpty").hidden = true;
    byId("chartEmpty").textContent = "Nothing was recorded for this night.";
    if (byId("expanded").open) byId("expanded").close();
    history.replaceState(null, "", `/week?date=${key}`);
    const index = nights.findIndex((night) => night.night === key);
    byId("older").disabled = index < 0 || index === nights.length - 1;
    byId("newer").disabled = index <= 0;
    try {
      const response = await fetch(
        `/api/night?night=${encodeURIComponent(key)}&bucket=60`,
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (thisRequest !== requestNumber) return;
      if (!response.ok) throw new Error("request failed");
      if (!payload.ok) {
        unavailableSummary();
        byId("status").querySelector("span").textContent =
          "No readings recorded for this night";
        byId("notice").hidden = false;
        byId("notice").textContent = "Choose another recorded night.";
        byId("chartEmpty").hidden = false;
        return;
      }
      state.vitalRows = payload.points;
      state.sleepRows = payload.sleep_points;
      state.temperatureRows = payload.temperature_points || [];
      state.temperatureGapAfter = payload.temperature_gap_after_s;
      state.temperatureResolution = payload.temperature_resolution;
      state.movementRows = payload.movement_points || [];
      state.positionRows = payload.position_points || [];
      state.recordingContext = payload.recording_context || [];
      state.vitalGapAfter = payload.gap_after_s;
      state.sleepGapAfter = payload.sleep_gap_after_s;
      state.vitalResolution = payload.resolution;
      state.sleepResolution = payload.sleep_resolution;
      state.summary = payload.summary;
      selectMetricRows();
      state.timezone = payload.timezone;
      byId("nightTitle").textContent = formatDate(key);
      setSummary(payload.summary);
      setMetricCopy(payload.summary);
      byId("status").querySelector("span").textContent =
        `${Math.round(payload.summary.coverage * 100)}% recorded · ${payload.timezone}`;
      byId("notice").hidden = true;
      byId("resolution").textContent =
        `${state.rows.length} returned observations · ${currentResolution()}`;
      byId("chartEmpty").hidden = state.rows.length > 0;
      byId("plot").hidden = state.rows.length === 0;
      await draw();
      chartControlsEnabled(state.vitalRows.length > 0);
      byId("expand").disabled = !state.rows.length;
      if (state.metric === "temp")
        byId("chartEmpty").textContent =
          "No eligible sock-temperature readings for this night.";
      if (state.metric === "position")
        byId("chartEmpty").textContent =
          "No position history archived for this night yet.";
      if (state.metric === "movement")
        byId("chartEmpty").textContent =
          "No eligible movement readings for this night.";
      if (byId("expanded").open) await draw("expandedPlot", true);
    } catch (error) {
      if (thisRequest !== requestNumber) return;
      state.rows = [];
      unavailableSummary(true);
      byId("status").querySelector("span").textContent =
        "Unable to load this recorded night";
      byId("notice").hidden = false;
      byId("notice").textContent = "The request failed. Try this night again.";
      byId("chartEmpty").hidden = false;
      byId("plot").hidden = true;
    }
  }

  document.querySelectorAll("[data-metric]").forEach((button) =>
    button.addEventListener("click", async () => {
      state.metric = button.dataset.metric;
      controller.clearSelection();
      selectMetricRows();
      document
        .querySelectorAll("[data-metric]")
        .forEach((item) => item.setAttribute("aria-selected", item === button));
      byId("chartPanel").setAttribute("aria-labelledby", button.id);
      if (state.summary) setMetricCopy(state.summary);
      byId("resolution").textContent =
        `${state.rows.length} returned observations · ${currentResolution()}`;
      byId("chartEmpty").hidden = state.rows.length > 0;
      byId("chartEmpty").textContent =
        state.metric === "temp"
          ? "No eligible sock-temperature readings for this night."
          : "Nothing was recorded for this night.";
      byId("plot").hidden = state.rows.length === 0;
      if (state.metric === "position")
        byId("chartEmpty").textContent =
          "No position history archived for this night yet.";
      if (state.metric === "movement")
        byId("chartEmpty").textContent =
          "No eligible movement readings for this night.";
      document
        .querySelectorAll(".recording-context")
        .forEach((element) => (element.hidden = !state.rows.length));
      byId("expand").disabled = !state.rows.length;
      byId("expandedTitle").textContent = OwletChart.metrics[state.metric].name;
      await draw();
      if (byId("expanded").open) await draw("expandedPlot", true);
    }),
  );
  document
    .querySelectorAll("[data-period]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        controller.setPeriod(button.dataset.period),
      ),
    );
  chartControlsEnabled(false);
  byId("older").disabled = true;
  byId("newer").disabled = true;
  byId("older").addEventListener("click", () => {
    const index = nights.findIndex((night) => night.night === selected);
    if (nights[index + 1]) selectNight(nights[index + 1].night);
  });
  byId("newer").addEventListener("click", () => {
    const index = nights.findIndex((night) => night.night === selected);
    if (nights[index - 1]) selectNight(nights[index - 1].night);
  });
  byId("expand").addEventListener("click", async (event) => {
    if (!state.rows.length) return;
    expandedOpener = event.currentTarget;
    byId("expandedDate").textContent = formatDate(selected);
    byId("expandedTitle").textContent = OwletChart.metrics[state.metric].name;
    byId("expandedControls").innerHTML = OwletChart.controls(state, {
      periods: true,
    });
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

  fetch("/api/nights?days=all", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("request failed");
      return response.json();
    })
    .then((payload) => {
      nights = payload.nights;
      if (!nights.length) {
        unavailableSummary();
        byId("nightTitle").textContent = "No recorded nights";
        byId("status").querySelector("span").textContent =
          "No readings recorded yet";
        byId("chartEmpty").hidden = false;
        byId("plot").hidden = true;
        return;
      }
      const requested = new URLSearchParams(location.search).get("date");
      selectNight(requested || nights[0].night);
    })
    .catch(() => {
      unavailableSummary(true);
      byId("nightTitle").textContent = "Night unavailable";
      byId("status").querySelector("span").textContent =
        "Unable to load recorded nights";
      byId("notice").hidden = false;
      byId("notice").textContent = "The request failed. Try this page again.";
      byId("chartEmpty").hidden = false;
      byId("plot").hidden = true;
    });
})();
