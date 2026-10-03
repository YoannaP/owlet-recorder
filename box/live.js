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
    movementRows: [],
    positionRows: [],
    recordingContext: [],
    seriesFailed: false,
    observationGapAfter: 60,
    gapAfter: 45,
    vitalGapAfter: 45,
    sleepGapAfter: 60,
    vitalResolution: "",
    sleepResolution: "",
    latest: null,
    latestFetchFailed: false,
    noData: false,
    history: "loading",
  };
  let expandedOpener = null;
  let latestInFlight = false;
  let seriesInFlight = false;
  let historyInFlight = false;
  let historyCheckedAt = 0;
  const byId = (id) => document.getElementById(id);
  const ageSeconds = () =>
    state.latest
      ? Math.max(0, Math.round(Date.now() / 1000 - state.latest.sample_ts))
      : null;
  const ageText = (seconds) =>
    seconds < 90
      ? `${seconds} ${seconds === 1 ? "second" : "seconds"} ago`
      : seconds < 5400
        ? `${Math.round(seconds / 60)} minutes ago`
        : `${(seconds / 3600).toFixed(1)} hours ago`;
  const reasons = {
    charging: "Sock is charging",
    "sock off": "Sock is off",
    "base station off": "Base station is off",
    "no reading": "No valid reading",
  };
  function setValue(id, reading, unit) {
    byId(id).innerHTML =
      reading == null
        ? `—<small>${unit}</small>`
        : `${Math.round(reading)}<small>${unit}</small>`;
  }

  // Observed movement runs 0 to ~150 but sits at 0 most of the time and
  // rarely passes 100, so 100 is treated as "high" and anything above pins.
  const MOVEMENT_HIGH = 100;
  function setMovement(value, caption) {
    const meter = byId("movementMeter");
    const available = value != null;
    meter.classList.toggle("unavailable", !available);
    if (available) {
      const level = Math.min(Math.max(value, 0), MOVEMENT_HIGH);
      meter.style.setProperty("--level", `${(level / MOVEMENT_HIGH) * 100}%`);
      meter.setAttribute("aria-valuenow", String(level));
      meter.setAttribute(
        "aria-valuetext",
        level < MOVEMENT_HIGH / 3
          ? "Low"
          : level < (MOVEMENT_HIGH * 2) / 3
            ? "Moderate"
            : "High",
      );
    } else {
      meter.style.removeProperty("--level");
      meter.removeAttribute("aria-valuenow");
      meter.setAttribute("aria-valuetext", "Unavailable");
    }
    byId("movementCaption").textContent = caption;
  }

  function renderLatest() {
    renderMetricLatest();
    const status = byId("status");
    const notice = byId("notice");
    const unavailable =
      !state.latest ||
      !state.latest.monitoring ||
      state.latestFetchFailed ||
      ageSeconds() > 120;
    byId("latestVitals").hidden = unavailable;
    byId("inactiveReadings").hidden = !unavailable;
    if (!state.latest) {
      status.className = `status ${state.latestFetchFailed ? "failed" : "inactive"}`;
      status.querySelector("span").textContent = state.latestFetchFailed
        ? "Unable to load recorded readings"
        : state.noData
          ? "No readings recorded yet"
          : "Loading latest recorded reading…";
      setValue("heartRate", null, "bpm");
      setValue("oxygen", null, "%");
      byId("heartRateCaption").textContent = "No latest reading";
      byId("oxygenCaption").textContent = "No latest reading";
      setMovement(null, "No latest reading");
      byId("unavailableCopy").textContent =
        state.latestFetchFailed || state.noData
          ? "Heart rate and oxygen are unavailable."
          : "Waiting for the latest recorded reading.";
      notice.hidden = true;
      notice.textContent = "";
      delete status.dataset.ageSeconds;
      byId("battery").textContent = "Battery status unavailable";
      byId("deviceFacts").textContent = "No device status recorded.";
      return;
    }
    const latest = state.latest;
    const age = ageSeconds();
    const stale = age > 120;
    const inactive = !latest.monitoring;
    status.dataset.ageSeconds = String(age);
    status.className = `status ${state.latestFetchFailed ? `failed${stale ? " stale" : ""}` : stale ? "stale" : inactive ? "inactive" : ""}`;
    status.querySelector("span").textContent = state.latestFetchFailed
      ? `Update failed · ${inactive ? `${reasons[latest.not_monitoring_reason] || "Not monitoring"} · ` : ""}${stale ? "Latest reading is stale · " : ""}Last successful reading ${ageText(age)}`
      : stale
        ? `${inactive ? `${reasons[latest.not_monitoring_reason] || "Not monitoring"} · ` : ""}Latest recorded reading is stale · ${ageText(age)}`
        : inactive
          ? `${reasons[latest.not_monitoring_reason] || "Not monitoring"} · Last update ${ageText(age)}`
          : `Latest recorded reading · ${ageText(age)}`;
    notice.hidden = !(state.latestFetchFailed || stale);
    notice.textContent = state.latestFetchFailed
      ? "The latest request failed. Age continues from the last successful reading, so old data cannot appear current."
      : stale
        ? "The recorder or sock may be offline. This page is a record, not an alarm."
        : "";
    byId("unavailableCopy").textContent =
      "Heart rate and oxygen are unavailable.";
    if (unavailable) {
      setValue("heartRate", null, "bpm");
      setValue("oxygen", null, "%");
      byId("heartRateCaption").textContent = "Latest heart rate unavailable";
      byId("oxygenCaption").textContent = "Latest oxygen unavailable";
      setMovement(null, "Latest movement unavailable");
    } else {
      setValue("heartRate", latest.heart_rate, "bpm");
      const oxygenValid =
        latest.oxygen_saturation > 0 && latest.oxygen_saturation <= 100;
      setValue("oxygen", oxygenValid ? latest.oxygen_saturation : null, "%");
      byId("heartRateCaption").textContent = `Recorded ${ageText(age)}`;
      byId("oxygenCaption").textContent = !oxygenValid
        ? "Latest oxygen unavailable"
        : latest.oxygen_10_av > 0 && latest.oxygen_10_av < 101
          ? `10-minute average ${Math.round(latest.oxygen_10_av)}%`
          : "Latest recorded oxygen";
      setMovement(
        latest.eligible_movement,
        latest.eligible_movement == null
          ? "Latest movement unavailable"
          : `Recorded ${ageText(age)}`,
      );
    }
    const battery =
      latest.battery_percentage == null
        ? "unknown"
        : `${Math.round(latest.battery_percentage)}%`;
    const signal =
      latest.signal_strength == null
        ? "unknown"
        : Math.round(latest.signal_strength);
    byId("battery").textContent = `Battery ${battery}`;
    byId("deviceFacts").textContent =
      `Raw signal ${signal}. Reported sleep state: ${latest.sleep_label.toLowerCase()}. Device facts from the latest recorded reading.`;
  }

  function renderMetricLatest() {
    const element = byId("metricLatest");
    element.hidden = !["temp", "movement", "position"].includes(state.metric);
    if (element.hidden) return;
    if (state.metric === "position") {
      const last = state.positionRows.at(-1);
      element.textContent = !last
        ? "No position history archived in the last 12 hours."
        : `${state.seriesFailed ? "History refresh failed · " : ""}${OwletChart.metrics.position.ticktext[last.position]} · Recorded ${new Intl.DateTimeFormat("en-GB", { timeZone: state.timezone || "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(last.t * 1000)} · ${ageText(Math.max(0, Math.round(Date.now() / 1000 - last.t)))} · History may arrive later.`;
      return;
    }
    const value =
      state.latest?.[state.metric === "temp" ? "temp" : "eligible_movement"];
    const unavailable =
      !state.latest ||
      state.latestFetchFailed ||
      !state.latest.monitoring ||
      ageSeconds() > 120 ||
      value == null;
    element.textContent = unavailable
      ? `Latest ${state.metric === "temp" ? "sock temperature" : "movement"} unavailable.`
      : `${value} ${OwletChart.metrics[state.metric].unit} · Recorded ${ageText(ageSeconds())}`;
  }

  function hideContext() {
    document
      .querySelectorAll(".recording-context")
      .forEach((element) => (element.hidden = true));
  }

  function emptyMessage() {
    return state.metric === "position"
      ? "No position history archived in the last 12 hours."
      : ["temp", "movement"].includes(state.metric)
        ? `No eligible ${state.metric === "temp" ? "sock-temperature" : "movement"} readings in this window.`
        : "Nothing was recorded in this window.";
  }

  function renderHistory() {
    byId("latestNight").hidden = state.history !== "available";
    byId("retryHistory").hidden = state.history !== "failed";
    byId("historyMessage").hidden = state.history === "available";
    byId("historyMessage").textContent = {
      loading: "Checking for recorded nights…",
      empty: "No recorded nights yet.",
      failed: "Recorded nights could not be checked.",
      available: "",
    }[state.history];
  }
  async function checkHistory(force = false) {
    if (historyInFlight || (!force && Date.now() - historyCheckedAt < 60000))
      return;
    historyInFlight = true;
    historyCheckedAt = Date.now();
    state.history = "loading";
    renderHistory();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("/api/nights?days=all", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error();
      const payload = await response.json();
      if (!Array.isArray(payload.nights)) throw new Error();
      state.history = payload.nights.length ? "available" : "empty";
    } catch {
      state.history = "failed";
    } finally {
      clearTimeout(timeout);
      historyInFlight = false;
      renderHistory();
    }
  }

  async function pollLatest() {
    if (latestInFlight) return;
    latestInFlight = true;
    const previouslyEmpty = state.noData;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("/api/latest", {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json();
      if (response.status === 503 && payload.reason === "no data") {
        state.latest = null;
        state.noData = true;
        state.latestFetchFailed = false;
      } else if (!response.ok) throw new Error();
      else {
        state.latest = payload;
        state.noData = false;
        state.latestFetchFailed = false;
      }
    } catch (error) {
      state.latestFetchFailed = true;
    } finally {
      clearTimeout(timeout);
      latestInFlight = false;
    }
    renderLatest();
    const historyChanged = previouslyEmpty !== state.noData;
    if (
      historyChanged ||
      !state.latest ||
      !state.latest.monitoring ||
      state.latestFetchFailed ||
      ageSeconds() > 120
    )
      checkHistory(historyChanged);
  }
  async function draw(id = "plot", expanded = false) {
    if (!state.rows.length) return;
    const element = byId(id);
    // Presets track the newest sample on every redraw. Only a manual zoom or
    // pan pins the window, and follow() leaves that alone.
    chartController.follow();
    const chart = OwletChart.spec(state.rows, state.gapAfter, state, expanded);
    await chartController.render(element, chart);
    OwletContext.render(element, state.recordingContext, state.timezone);
    if (!element.dataset.contextListener) {
      element.on("plotly_afterplot", () =>
        OwletContext.render(element, state.recordingContext, state.timezone),
      );
      element.dataset.contextListener = "true";
    }
    if (!element.dataset.rangeListener) {
      element.on("plotly_relayout", (event) => {
        if (chartController.rememberRange(event))
          chartController.labelAxis(element);
      });
      element.dataset.rangeListener = "true";
    }
  }
  async function pollSeries() {
    if (seriesInFlight) return;
    seriesInFlight = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    setChartControlsEnabled(false);
    try {
      const response = await fetch("/api/series?hours=12", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error();
      const payload = await response.json();
      state.vitalRows = payload.rows;
      state.sleepRows = payload.sleep_points;
      state.temperatureRows = payload.temperature_points || [];
      state.movementRows = payload.movement_points || [];
      state.positionRows = payload.position_points || [];
      state.recordingContext = payload.recording_context || [];
      state.observationGapAfter = payload.observation_gap_after_s || 60;
      state.timezone = payload.timezone;
      state.seriesFailed = false;
      state.vitalGapAfter = payload.gap_after_s;
      state.sleepGapAfter = payload.sleep_gap_after_s;
      state.vitalResolution = payload.resolution;
      state.sleepResolution = payload.sleep_resolution;
      selectMetricRows();
      byId("resolution").textContent =
        `${state.rows.length} returned observations · ${currentResolution()}`;
      byId("chartEmpty").hidden = state.rows.length > 0;
      byId("plot").hidden = state.rows.length === 0;
      byId("chartEmpty").textContent = emptyMessage();
      renderMetricLatest();
      if (!state.rows.length) hideContext();
      if (state.rows.length) {
        await draw();
        if (byId("expanded").open) await draw("expandedPlot", true);
      } else if (byId("expanded").open) {
        byId("expanded").close();
      }
      setChartControlsEnabled(state.rows.length > 0);
      document.dispatchEvent(new CustomEvent("owlet-series-rendered"));
    } catch (error) {
      state.seriesFailed = true;
      hideContext();
      renderMetricLatest();
      byId("resolution").textContent = "Unable to refresh chart readings";
      byId("chartEmpty").textContent = "Chart readings could not be loaded.";
      byId("chartEmpty").hidden = false;
      byId("plot").hidden = true;
      setChartControlsEnabled(false);
      if (byId("expanded").open) byId("expanded").close();
    } finally {
      clearTimeout(timeout);
      seriesInFlight = false;
    }
  }
  function activePlots() {
    return [
      byId("plot"),
      ...(byId("expanded").open ? [byId("expandedPlot")] : []),
    ];
  }
  const chartController = OwletChart.controller({
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
  function selectMetricRows() {
    if (["temp", "movement", "position"].includes(state.metric)) {
      const rows = {
        temp: state.temperatureRows,
        movement: state.movementRows,
        position: state.positionRows,
      }[state.metric];
      state.rows = rows.some((row) => row[state.metric] != null) ? rows : [];
      state.gapAfter = state.observationGapAfter;
      return;
    }
    const sleep = state.metric === "sleep";
    state.rows = sleep ? state.sleepRows : state.vitalRows;
    state.gapAfter = sleep ? state.sleepGapAfter : state.vitalGapAfter;
  }
  function currentResolution() {
    if (state.metric === "temp") return "Original samples · Celsius assumed";
    if (state.metric === "movement") return "Original movement observations";
    if (state.metric === "position")
      return "Owlet position history · May arrive later";
    return state.metric === "sleep"
      ? state.sleepResolution
      : state.vitalResolution;
  }
  function setChartControlsEnabled(enabled) {
    document.querySelectorAll("[data-period], #expand").forEach((button) => {
      button.disabled = !enabled;
    });
  }
  document.querySelectorAll("[data-metric]").forEach((button) =>
    button.addEventListener("click", async () => {
      state.metric = button.dataset.metric;
      chartController.clearSelection();
      selectMetricRows();
      document
        .querySelectorAll("[data-metric]")
        .forEach((item) => item.setAttribute("aria-selected", item === button));
      byId("chartPanel").setAttribute("aria-labelledby", button.id);
      const metric = OwletChart.metrics[state.metric];
      byId("chartValue").textContent =
        { temp: "Temperature", position: "Position" }[state.metric] ||
        metric.name;
      const copy = {
        hr: [
          "Returned bucket averages",
          "Heart rate readings reported by Owlet.",
        ],
        ox: [
          "Returned bucket averages · Fixed 85 to 101% scale",
          "Oxygen readings reported by Owlet. The fixed scale keeps ordinary changes in proportion.",
        ],
        sleep: [
          "Reported observations · Unknown is shown explicitly",
          "Discrete sleep states reported by Owlet. Missing intervals stay blank.",
        ],
        temp: [
          "Sock sensor · Celsius assumed",
          "Experimental sock-sensor values assuming whole-degree Celsius. Units and accuracy are unverified. This is not body or room temperature. Missing and inactive readings stay blank.",
        ],
        movement: [
          "Reported index · Original samples",
          "Movement reported by the sock. Zero is a reported zero. The physical scale is undocumented; values are not movement counts or sleep stages.",
        ],
        position: [
          "Owlet history · Original observations",
          "Back, side and tummy labels come from Owlet's position-history API. Moving, undetected and unknown remain separate. This is a recorded estimate, not confirmation of posture. History may arrive later than vital readings.",
        ],
      }[state.metric];
      byId("chartCaption").textContent = copy[0];
      byId("metricExplanation").textContent = copy[1];
      byId("resolution").textContent =
        `${state.rows.length} returned observations · ${currentResolution()}`;
      byId("chartEmpty").hidden = state.rows.length > 0;
      byId("plot").hidden = state.rows.length === 0;
      byId("chartEmpty").textContent = emptyMessage();
      renderMetricLatest();
      if (!state.rows.length) hideContext();
      setChartControlsEnabled(state.rows.length > 0);
      if (state.rows.length) await draw();
    }),
  );
  document
    .querySelectorAll("[data-period]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        chartController.setPeriod(button.dataset.period),
      ),
    );
  byId("expand").addEventListener("click", async (event) => {
    expandedOpener = event.currentTarget;
    byId("expandedTitle").textContent = OwletChart.metrics[state.metric].name;
    byId("expandedControls").innerHTML = OwletChart.controls(state, {
      periods: true,
    });
    byId("expanded").showModal();
    await draw("expandedPlot", true);
    chartController.wire(byId("expandedControls"));
  });
  byId("closeExpanded").addEventListener("click", () =>
    byId("expanded").close(),
  );
  OwletChart.closeOnBackdrop(byId("expanded"));
  byId("expanded").addEventListener("close", () =>
    chartController.closeExpanded(byId("expanded"), expandedOpener),
  );
  setChartControlsEnabled(false);
  byId("retryHistory").addEventListener("click", () => checkHistory(true));
  pollLatest();
  pollSeries();
  renderLatest();
  setInterval(renderLatest, 1000);
  setInterval(pollLatest, 5000);
  setInterval(pollSeries, 10000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      pollLatest();
      pollSeries();
    }
  });
})();
