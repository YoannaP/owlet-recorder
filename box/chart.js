window.OwletChart = (() => {
  const metrics = {
    hr: { name: "Heart rate", unit: "bpm", range: null, dtick: 20, minor: 5 },
    ox: { name: "Oxygen", unit: "%", range: [85, 101], dtick: 5, minor: 1 },
    temp: {
      name: "Sock temperature",
      unit: "°C assumed",
      range: null,
      dtick: 1,
      decimals: 0,
    },
    movement: {
      name: "Movement",
      unit: "reported units",
      range: null,
      dtick: 5,
      decimals: 0,
    },
    position: {
      name: "Reported position",
      unit: "",
      range: [-0.4, 5.4],
      tickvals: [0, 1, 2, 3, 4, 5],
      ticktext: ["Unknown", "Moving", "Undetected", "Back", "Side", "Tummy"],
    },
    sleep: {
      name: "Reported sleep",
      unit: "",
      range: [-0.45, 3.45],
      tickvals: [0, 1, 2, 3],
      ticktext: ["Unknown", "Awake", "Light", "Deep"],
    },
  };
  const sleepPositions = { 0: 0, 1: 1, 8: 2, 15: 3 };
  const sleepPosition = (value) =>
    value == null ? null : (sleepPositions[value] ?? 0);

  function segments(rows, gapAfter) {
    const groups = [];
    let group = [];
    rows.forEach((row, index) => {
      if (index && row.t - rows[index - 1].t > gapAfter) {
        groups.push(group);
        group = [];
      }
      group.push(row);
    });
    if (group.length) groups.push(group);
    return groups;
  }

  function controls(state, { periods = false } = {}) {
    const preset = (value, label) => {
      const active = !state.manualRange && state.period === value;
      return `<button data-period="${value}" class="${active ? "active" : ""}" aria-pressed="${active}">${label}</button>`;
    };
    const presets = periods
      ? `<div class="periods" aria-label="Chart time range">${preset("1", "1h")}${preset("3", "3h")}${preset("all", "All")}</div>`
      : "";
    return `<div class="chart-controls">${presets}<div class="toolgroup"><button data-action="zoom" aria-pressed="${state.dragmode === "zoom"}">Zoom</button><button data-action="pan" aria-pressed="${state.dragmode === "pan"}">Pan</button><button data-action="samples" aria-pressed="${state.style === "samples"}" title="Show each returned observation without connecting lines">Samples</button></div><div class="toolgroup"><button data-action="in" aria-label="Zoom in">＋</button><button data-action="out" aria-label="Zoom out">−</button><button data-action="reset">Reset</button></div></div>`;
  }

  function epoch(value) {
    if (typeof value === "number") return value;
    if (value instanceof Date) return value.getTime();
    const text = String(value);
    // Plotly emits offsetless date-axis ranges in the browser's local wall
    // time. Forcing those strings to UTC adds or removes the local offset.
    return Date.parse(text);
  }

  function formatter(timeZone, options) {
    return new Intl.DateTimeFormat("en-GB", {
      ...(timeZone ? { timeZone } : {}),
      ...options,
    });
  }

  function tickLabels(range, state, count) {
    const start = epoch(range[0]);
    const end = epoch(range[1]);
    const yearFormat = formatter(state.timezone, { year: "numeric" });
    const crossesYear = yearFormat.format(start) !== yearFormat.format(end);
    const monthYearTicks =
      crossesYear && count === 2 && end - start > 365 * 86400000;
    const format = formatter(
      state.timezone,
      state.axisDateOnly
        ? {
            ...(monthYearTicks ? {} : { day: "numeric" }),
            month: "short",
            ...(crossesYear ? { year: "numeric" } : {}),
          }
        : { hour: "2-digit", minute: "2-digit", hour12: false },
    );
    const values = Array.from(
      { length: count },
      (_, index) => start + ((end - start) * index) / (count - 1),
    );
    const labels = values.map((value) => format.format(value));
    const duplicates = new Set(
      labels.filter((label, index) => labels.indexOf(label) !== index),
    );
    const offsetFormat = formatter(state.timezone, {
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "shortOffset",
      hour12: false,
    });
    return {
      tickmode: "array",
      tickvals: values,
      ticktext: labels.map((label, index) =>
        duplicates.has(label) ? offsetFormat.format(values[index]) : label,
      ),
      tickangle: 0,
    };
  }

  function tickCount(width, expanded) {
    const available = Math.max(180, Number(width) || window.innerWidth - 80);
    return Math.max(2, Math.min(expanded ? 9 : 7, Math.floor(available / 92)));
  }

  function continuousAxis(metric, values) {
    if (metric.range) return { range: metric.range, dtick: metric.dtick };
    if (!values.length) return { dtick: metric.dtick };
    const low = Math.min(...values);
    const high = Math.max(...values);
    const minimumSpan =
      metric.unit === "bpm" ? 20 : metric.unit === "h" ? 2 : 4;
    const span = Math.max(minimumSpan, (high - low) * 1.25);
    const centre = (low + high) / 2;
    const stepCandidates = [0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100];
    const step =
      stepCandidates.find(
        (candidate) => span / candidate >= 3 && span / candidate <= 7,
      ) || metric.dtick;
    const start = Math.floor((centre - span / 2) / step) * step;
    const end = Math.ceil((centre + span / 2) / step) * step;
    return {
      range: [start, end],
      tickmode: "array",
      tickvals: Array.from(
        { length: Math.round((end - start) / step) + 1 },
        (_, index) => start + index * step,
      ),
    };
  }

  function pointLabel(timestamp, state) {
    return new Intl.DateTimeFormat(state.timezone ? "en-GB" : "en-US", {
      ...(state.timezone ? { timeZone: state.timezone } : {}),
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "shortOffset",
      hour12: false,
    }).format(timestamp * 1000);
  }

  function spec(rows, gapAfter, state, expanded) {
    const metric = metrics[state.metric];
    const isSleep = state.metric === "sleep";
    const categorical = isSleep || state.metric === "position";
    const axis = {
      showline: true,
      linecolor: "#aabbb43d",
      linewidth: 1,
      mirror: expanded ? "ticks" : false,
      ticks: "inside",
      ticklen: 5,
      tickwidth: 1,
      tickcolor: "#b3c1bc80",
      tickfont: { size: expanded ? 12 : 11, color: "#bcc5c3" },
      zeroline: false,
      automargin: true,
      showgrid: true,
      gridcolor: "#c4d1cc12",
      gridwidth: 1,
    };
    const traces = segments(rows, gapAfter).map((group) => ({
      type: "scatter",
      mode:
        state.style === "samples"
          ? "markers"
          : group.length === 1
            ? "markers"
            : state.lineMode || "lines",
      x: group.map((row) => row.t * 1000),
      y: group.map((row) =>
        isSleep ? sleepPosition(row.sleep) : row[state.metric],
      ),
      customdata: group.map((row) =>
        categorical
          ? [
              pointLabel(row.t, state),
              (isSleep ? sleepPosition(row.sleep) : row.position) == null
                ? "Missing"
                : metric.ticktext[
                    isSleep ? sleepPosition(row.sleep) : row.position
                  ],
            ]
          : pointLabel(row.t, state),
      ),
      meta: {
        metric: metric.name,
        unit: metric.unit,
        sleep: isSleep,
        categorical,
        decimals: metric.decimals ?? 1,
        times: group.map((row) => pointLabel(row.t, state)),
        context: group.map((row) => state.pointContext?.(row) || ""),
      },
      connectgaps: false,
      line: {
        color: "#ffffff",
        width: categorical ? 1.5 : 1.4,
        shape: categorical ? "hv" : "linear",
        simplify: false,
      },
      marker: { color: "#ffffff", size: expanded ? 4 : 3 },
      hovertemplate: categorical
        ? `<b>%{customdata[1]}</b><br>%{customdata[0]}<extra></extra>`
        : `<b>%{y:.${metric.decimals ?? 1}f} ${metric.unit}</b><br>%{customdata}<extra></extra>`,
    }));
    const fullRange = rows.length
      ? [rows[0].t * 1000, rows.at(-1).t * 1000]
      : null;
    const metricValues = rows
      .map((row) => row[state.metric])
      .filter((value) => value != null && Number.isFinite(Number(value)));
    const valueAxis = continuousAxis(metric, metricValues.map(Number));
    return {
      data: traces,
      layout: {
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
        margin: { l: 12, r: 46, t: 34, b: expanded ? 55 : 40 },
        font: {
          family: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
          color: "#a4afb1",
          size: 11,
        },
        showlegend: false,
        dragmode: expanded ? state.dragmode : false,
        hovermode: "closest",
        hoverdistance: 28,
        spikedistance: -1,
        hoverlabel: {
          bgcolor: "#202c30",
          bordercolor: "#6e827c",
          font: { color: "#f4f0e9", size: 12 },
          align: "left",
        },
        xaxis: {
          ...axis,
          // Epoch milliseconds keep the two occurrences of a repeated local
          // DST hour distinct during pointer and keyboard range changes.
          type: "linear",
          range: state.range || fullRange,
          ...tickLabels(
            state.range || fullRange,
            state,
            tickCount(window.innerWidth - (expanded ? 80 : 110), expanded),
          ),
          showgrid: expanded,
          fixedrange: false,
          showspikes: true,
          spikemode: "across",
          spikesnap: "data",
          spikecolor: "#bccbc080",
          spikethickness: 1,
          spikedash: "dot",
          rangeslider: expanded
            ? {
                visible: true,
                thickness: 0.1,
                bgcolor: "#1a2528",
                bordercolor: "#aabbb43d",
                borderwidth: 1,
              }
            : { visible: false },
        },
        yaxis: {
          ...axis,
          type: "linear",
          ...valueAxis,
          side: "right",
          fixedrange: true,
          ...(metric.tickvals
            ? {
                tickmode: "array",
                tickvals: metric.tickvals,
                ticktext: metric.ticktext,
              }
            : {
                minor: {
                  ticks: "inside",
                  ticklen: 2.5,
                  tickwidth: 1,
                  tickcolor: "#b3c1bc50",
                  showgrid: false,
                  dtick: metric.minor,
                },
              }),
        },
        annotations: metric.unit
          ? [
              {
                xref: "paper",
                yref: "paper",
                x: 1,
                y: 1,
                xanchor: "right",
                yanchor: "bottom",
                yshift: 12,
                text: metric.unit,
                showarrow: false,
                font: { size: 11, color: "#aab8b3" },
              },
            ]
          : [],
      },
      config: {
        responsive: true,
        displayModeBar: false,
        scrollZoom: expanded,
        doubleClick: expanded ? "reset" : false,
      },
      fullRange,
    };
  }

  // `hourPresets`: state.period is a chart window in hours ("1", "3") or
  // "all". Trends uses state.period for the loaded span in days instead and
  // leaves this off, so its period never becomes a chart range.
  function controller({
    state,
    rows,
    plots,
    onPeriod,
    onSelect,
    hourPresets = false,
  }) {
    let operations = Promise.resolve();
    const enqueue = (operation) => {
      operations = operations
        .catch(() => {})
        .then(async () => {
          await operation();
        });
      return operations;
    };
    const readyPlots = () =>
      plots().filter((plot) => plot?.layout?.xaxis && plot?.data);
    const fullRange = () => {
      const values = rows();
      return values.length
        ? [values[0].t * 1000, values.at(-1).t * 1000]
        : null;
    };
    // Relayouts issued by this controller must not read back as manual
    // gestures, or a preset would silently turn into a pinned window.
    let programmatic = false;
    const quietly = async (operation) => {
      programmatic = true;
      try {
        await operation();
      } finally {
        programmatic = false;
      }
    };
    // The range a preset means right now. Presets follow the latest sample
    // on every redraw; only a manual gesture pins the window.
    const presetRange = () => {
      const full = fullRange();
      if (!hourPresets || !full || !Number(state.period)) return null;
      return [full[1] - Number(state.period) * 3600000, full[1]];
    };
    const follow = () => {
      if (!state.manualRange) state.range = presetRange();
      return state.range;
    };
    const pinRange = (range) => {
      state.range = range;
      state.manualRange = true;
      clearSelectionOutside(range);
      onPeriod(null);
    };
    const rememberRange = (event) => {
      if (programmatic) return false;
      if (event["xaxis.autorange"]) {
        state.range = null;
        state.manualRange = false;
        clearSelectionOutside(null);
        onPeriod(state.period);
        return true;
      }
      if (event["xaxis.range"]) {
        pinRange(event["xaxis.range"].map(epoch));
        return true;
      }
      if (event["xaxis.range[0]"] != null && event["xaxis.range[1]"] != null) {
        pinRange([event["xaxis.range[0]"], event["xaxis.range[1]"]].map(epoch));
        return true;
      }
      return false;
    };
    const tickUpdate = (range, plot) =>
      Object.fromEntries(
        Object.entries(
          tickLabels(
            range,
            state,
            tickCount(plot?.clientWidth, plot?.id === "expandedPlot"),
          ),
        ).map(([key, value]) => [`xaxis.${key}`, value]),
      );
    const rangeUpdate = (range, plot) => ({
      "xaxis.range": range,
      ...tickUpdate(range, plot),
    });
    const accessibleTime = (value) =>
      formatter(state.timezone, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "shortOffset",
        hour12: false,
      }).format(epoch(value));
    const selectionAnnotation = (trace, pointNumber) => ({
      x: trace.x[pointNumber],
      y: trace.y[pointNumber],
      xref: "x",
      yref: "y",
      text: "●",
      showarrow: false,
      font: { color: "#ffffff", size: 18 },
      bordercolor: "#172124",
      borderwidth: 2,
      bgcolor: "#ffffff00",
    });
    const unitAnnotations = (plot) =>
      (plot.layout.annotations || []).filter(
        (annotation) => !annotation.meta?.owletSelection,
      );
    const showSelection = (plot, trace, pointNumber, text) => {
      const output = plot.parentElement.querySelector(
        `[data-chart-status="${plot.id}"]`,
      );
      if (output) output.textContent = text;
      const marker = selectionAnnotation(trace, pointNumber);
      marker.meta = { owletSelection: true };
      return Plotly.relayout(plot, {
        annotations: [...unitAnnotations(plot), marker],
      }).then(() => {
        Plotly.Fx.hover(plot, [
          {
            curveNumber: plot.data.indexOf(trace),
            pointNumber,
          },
        ]);
      });
    };
    const clearSelection = () => {
      state.selection = null;
      document.querySelectorAll("[data-chart-status]").forEach((output) => {
        output.textContent = "No observation selected.";
      });
      return enqueue(() =>
        Promise.all(
          readyPlots().map((plot) => {
            Plotly.Fx.unhover(plot);
            return Plotly.relayout(plot, {
              annotations: unitAnnotations(plot),
            });
          }),
        ),
      );
    };
    const clearSelectionOutside = (range) => {
      if (
        state.selection &&
        range &&
        (state.selection.time < range[0] || state.selection.time > range[1])
      )
        clearSelection();
    };
    const pointDetails = (trace, pointNumber) => {
      const custom = trace.customdata?.[pointNumber];
      const time = trace.meta?.times?.[pointNumber] || custom;
      const value =
        trace.meta?.categorical || trace.meta?.sleep
          ? custom?.[1]
          : `${Number(trace.y[pointNumber]).toFixed(trace.meta?.decimals ?? 1)} ${trace.meta?.unit || ""}`.trim();
      const context = trace.meta?.context?.[pointNumber];
      return {
        custom,
        text: `${trace.meta?.metric || "Reading"}: ${value}, ${time}${context ? `, ${context}` : ""}`,
      };
    };
    const announcePoint = (plot, curveNumber, pointNumber) => {
      const trace = plot.data[curveNumber];
      if (!trace || pointNumber < 0 || pointNumber >= trace.x.length) return;
      if (
        trace.y[pointNumber] == null ||
        !Number.isFinite(Number(trace.y[pointNumber]))
      )
        return;
      const details = pointDetails(trace, pointNumber);
      state.selection = {
        metric: state.metric,
        time: epoch(trace.x[pointNumber]),
      };
      const selections = readyPlots().flatMap((candidate) => {
        const match = candidate.data
          .flatMap((item) =>
            item.x.map((x, candidatePoint) => ({
              item,
              candidatePoint,
              time: epoch(x),
            })),
          )
          .find((point) => point.time === state.selection.time);
        return match
          ? [
              showSelection.bind(
                null,
                candidate,
                match.item,
                match.candidatePoint,
                details.text,
              ),
            ]
          : [];
      });
      enqueue(() => Promise.all(selections.map((selection) => selection())));
      onSelect?.({
        time: state.selection.time,
        customdata: details.custom,
        value: trace.y[pointNumber],
      });
      Plotly.Fx.hover(plot, [{ curveNumber, pointNumber }]);
    };
    const inspectablePoints = (plot) => {
      const range = (state.range || fullRange()).map(epoch);
      return plot.data
        .flatMap((trace, curveNumber) =>
          trace.x.map((value, pointNumber) => ({
            curveNumber,
            pointNumber,
            time: epoch(value),
            value: trace.y[pointNumber],
          })),
        )
        .filter(
          (point) =>
            Number.isFinite(point.time) &&
            point.value != null &&
            Number.isFinite(Number(point.value)) &&
            point.time >= range[0] &&
            point.time <= range[1],
        )
        .sort((left, right) => left.time - right.time);
    };
    const wireChartKeyboard = (plot) => {
      plot.tabIndex = 0;
      plot.setAttribute("role", "application");
      if (!plot.getAttribute("aria-label"))
        plot.setAttribute(
          "aria-label",
          `Interactive ${plot.data[0]?.meta?.metric || "recorded readings"} chart`,
        );
      const statusId = `${plot.id}-chart-status`;
      let help = plot.parentElement.querySelector(
        `[data-chart-help="${plot.id}"]`,
      );
      if (!help) {
        help = document.createElement("p");
        help.className = "chart-keyboard-help";
        help.dataset.chartHelp = plot.id;
        help.id = `${plot.id}-chart-help`;
        help.textContent =
          "Focus chart, then use Left and Right arrows to inspect recorded points.";
        plot.insertAdjacentElement("afterend", help);
      }
      let output = plot.parentElement.querySelector(
        `[data-chart-status="${plot.id}"]`,
      );
      if (!output) {
        output = document.createElement("p");
        output.className = "chart-readout";
        output.dataset.chartStatus = plot.id;
        output.id = statusId;
        output.setAttribute("aria-live", "polite");
        output.textContent = "No observation selected.";
        help.insertAdjacentElement("afterend", output);
      }
      plot.setAttribute("aria-describedby", `${help.id} ${statusId}`);
      if (!plot.dataset.owletKeyboard) {
        plot.dataset.owletKeyboard = "true";
        plot.addEventListener("keydown", (event) => {
          if (event.target !== plot) return;
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          const points = inspectablePoints(plot);
          if (!points.length) return;
          event.preventDefault();
          let index = Math.max(
            0,
            Math.min(points.length - 1, Number(plot.dataset.pointIndex || 0)),
          );
          if (event.key === "Home") index = 0;
          else if (event.key === "End") index = points.length - 1;
          else
            index = Math.max(
              0,
              Math.min(
                points.length - 1,
                index + (event.key === "ArrowRight" ? 1 : -1),
              ),
            );
          plot.dataset.pointIndex = String(index);
          announcePoint(
            plot,
            points[index].curveNumber,
            points[index].pointNumber,
          );
        });
      }
      if (plot.owletPointClick)
        plot.removeListener?.("plotly_click", plot.owletPointClick);
      plot.owletPointClick = (event) => {
        const point = event.points?.[0];
        if (point) announcePoint(plot, point.curveNumber, point.pointNumber);
      };
      plot.on("plotly_click", plot.owletPointClick);
      if (plot.owletRangeRedraw)
        plot.removeListener?.("plotly_afterplot", plot.owletRangeRedraw);
      plot.owletRangeRedraw = () => wireRangeSlider(plot);
      plot.on("plotly_afterplot", plot.owletRangeRedraw);
      if (!plot.owletResizeObserver) {
        plot.owletWidth = Math.round(plot.getBoundingClientRect().width);
        plot.owletResizeObserver = new ResizeObserver((entries) => {
          const width = Math.round(entries[0]?.contentRect.width || 0);
          if (!width || width === plot.owletWidth) return;
          plot.owletWidth = width;
          labelAxis(plot);
        });
        plot.owletResizeObserver.observe(plot);
      }
    };
    const labelAxis = (plot) => {
      const range = state.range || fullRange();
      if (!plot?.layout?.xaxis || !range) return Promise.resolve();
      return enqueue(() => Plotly.relayout(plot, tickUpdate(range, plot)));
    };
    const setPeriod = (period) => {
      state.period = period;
      state.manualRange = false;
      const full = fullRange();
      state.range = presetRange();
      clearSelectionOutside(state.range);
      onPeriod(period);
      if (!full) return Promise.resolve();
      return enqueue(() =>
        quietly(() =>
          Promise.all(
            readyPlots().map((plot) =>
              Plotly.relayout(plot, rangeUpdate(state.range || full, plot)),
            ),
          ),
        ),
      );
    };
    const syncRange = (range) => {
      pinRange(range.map(epoch));
      return enqueue(() =>
        quietly(() =>
          Promise.all(
            readyPlots().map((plot) =>
              Plotly.relayout(plot, rangeUpdate(state.range, plot)),
            ),
          ),
        ),
      );
    };
    const wireRangeSlider = (plot) => {
      const slide = plot.querySelector(".rangeslider-slidebox");
      if (!slide) return;
      ["min", "max"].forEach((edge) => {
        const handle = plot.querySelector(`.rangeslider-grabarea-${edge}`);
        if (!handle) return;
        if (!handle.dataset.owletHitTarget) {
          handle.setAttribute(
            "x",
            String(Number(handle.getAttribute("x")) - 17),
          );
          handle.setAttribute("width", "44");
          handle.dataset.owletHitTarget = "true";
        }
        const height = Number(handle.getAttribute("height"));
        if (height < 24) {
          handle.setAttribute(
            "y",
            String(Number(handle.getAttribute("y")) - (24 - height) / 2),
          );
          handle.setAttribute("height", "24");
        }
        handle.tabIndex = 0;
        handle.setAttribute("role", "slider");
        handle.setAttribute(
          "aria-label",
          `Chart range ${edge === "min" ? "start" : "end"}`,
        );
        const updateAria = () => {
          const range = (state.range || fullRange()).map(epoch);
          const full = fullRange();
          const value = edge === "min" ? range[0] : range[1];
          handle.setAttribute(
            "aria-valuemin",
            String(edge === "min" ? full[0] : range[0]),
          );
          handle.setAttribute(
            "aria-valuemax",
            String(edge === "min" ? range[1] : full[1]),
          );
          handle.setAttribute("aria-valuenow", String(value));
          handle.setAttribute("aria-valuetext", accessibleTime(value));
          handle.setAttribute("aria-orientation", "horizontal");
        };
        updateAria();
        if (handle.dataset.owletRange) return;
        handle.dataset.owletRange = "true";
        handle.addEventListener("keydown", (event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.stopPropagation();
          event.preventDefault();
          const full = fullRange();
          if (!full || full[0] === full[1]) return;
          const range = (state.range || full).map(epoch);
          const index = edge === "min" ? 0 : 1;
          const minimumGap = Math.min(60000, full[1] - full[0]);
          const limit = index ? range[0] + minimumGap : range[1] - minimumGap;
          const step = Math.max(1, Math.round((full[1] - full[0]) / 100));
          if (event.key === "Home") range[index] = index ? limit : full[0];
          else if (event.key === "End") range[index] = index ? full[1] : limit;
          else {
            const direction = event.key === "ArrowRight" ? 1 : -1;
            range[index] = Math.max(
              index ? limit : full[0],
              Math.min(
                index ? full[1] : limit,
                range[index] + direction * step,
              ),
            );
          }
          pinRange(range);
          enqueue(async () => {
            await Plotly.relayout(plot, rangeUpdate(range, plot));
            wireRangeSlider(plot);
            plot.querySelector(`.rangeslider-grabarea-${edge}`)?.focus();
          });
        });
        handle.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          const initialX = event.clientX;
          let currentX = initialX;
          const initial = (state.range || fullRange()).map(epoch);
          const full = fullRange();
          const width = slide.getBoundingClientRect().width;
          const move = (moveEvent) => {
            currentX = moveEvent.clientX;
          };
          const finish = (commit) => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            document.removeEventListener("pointercancel", cancel);
            if (!commit) return;
            const delta = ((currentX - initialX) / width) * (full[1] - full[0]);
            const range = [...initial];
            const minimumGap = Math.min(60000, full[1] - full[0]);
            if (edge === "min")
              range[0] = Math.max(
                full[0],
                Math.min(initial[0] + delta, range[1] - minimumGap),
              );
            else
              range[1] = Math.min(
                full[1],
                Math.max(initial[1] + delta, range[0] + minimumGap),
              );
            pinRange(range);
            enqueue(() => Plotly.relayout(plot, rangeUpdate(range, plot)));
          };
          const up = () => finish(true);
          const cancel = () => finish(false);
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", up, { once: true });
          document.addEventListener("pointercancel", cancel, { once: true });
        });
      });
    };
    const render = (element, chart) =>
      enqueue(async () => {
        const selection = state.selection;
        const range = (state.range || chart.fullRange || []).map(epoch);
        if (
          selection &&
          (selection.metric !== state.metric ||
            !range.length ||
            selection.time < range[0] ||
            selection.time > range[1])
        )
          clearSelection();
        await Plotly.react(element, chart.data, chart.layout, chart.config);
        wireChartKeyboard(element);
        wireRangeSlider(element);
        if (state.selection) {
          const match = element.data
            .flatMap((trace) =>
              trace.x.map((x, pointNumber) => ({
                trace,
                pointNumber,
                time: epoch(x),
              })),
            )
            .find(
              (point) =>
                point.time === state.selection.time &&
                point.trace.y[point.pointNumber] != null &&
                Number.isFinite(Number(point.trace.y[point.pointNumber])),
            );
          if (match)
            await showSelection(
              element,
              match.trace,
              match.pointNumber,
              pointDetails(match.trace, match.pointNumber).text,
            );
          else clearSelection();
        }
      });
    const wire = (root) => {
      root
        .querySelectorAll("[data-period]")
        .forEach((button) =>
          button.addEventListener("click", () =>
            setPeriod(button.dataset.period),
          ),
        );
      root.querySelectorAll("[data-action]").forEach((button) =>
        button.addEventListener("click", async () => {
          const action = button.dataset.action;
          if (action === "samples") {
            state.style = state.style === "line" ? "samples" : "line";
            await enqueue(() =>
              Promise.all(
                readyPlots().map((plot) =>
                  Plotly.restyle(
                    plot,
                    "mode",
                    state.style === "samples"
                      ? "markers"
                      : plot.data.map((trace) =>
                          trace.x.length === 1
                            ? "markers"
                            : state.lineMode || "lines",
                        ),
                  ),
                ),
              ),
            );
            document
              .querySelectorAll('[data-action="samples"]')
              .forEach((item) =>
                item.setAttribute("aria-pressed", state.style === "samples"),
              );
            return;
          }
          if (action === "zoom" || action === "pan") {
            state.dragmode = action;
            await enqueue(() =>
              Promise.all(
                readyPlots()
                  .filter((plot) => plot.id === "expandedPlot")
                  .map((plot) => Plotly.relayout(plot, { dragmode: action })),
              ),
            );
            document
              .querySelectorAll('[data-action="zoom"],[data-action="pan"]')
              .forEach((item) =>
                item.setAttribute(
                  "aria-pressed",
                  item.dataset.action === action,
                ),
              );
            return;
          }
          if (action === "reset") {
            setPeriod("all");
            return;
          }
          const plot = plots().at(-1);
          const fullDates = fullRange();
          if (!plot?.layout?.xaxis?.range || !fullDates) return;
          const current = plot.layout.xaxis.range.map(epoch);
          const full = fullDates;
          const width = Math.min(
            full[1] - full[0],
            Math.max(
              600000,
              (current[1] - current[0]) * (action === "in" ? 0.5 : 2),
            ),
          );
          const left = Math.max(
            full[0],
            Math.min((current[0] + current[1] - width) / 2, full[1] - width),
          );
          pinRange([left, left + width]);
          await enqueue(() =>
            quietly(() =>
              Plotly.relayout(plot, rangeUpdate(state.range, plot)),
            ),
          );
        }),
      );
    };
    const closeExpanded = async (dialog, opener) => {
      const plot = dialog.querySelector(".expanded-plot");
      // Gestures inside the dialog already pinned state.range through
      // rememberRange and the slider handlers. An untouched dialog leaves the
      // preset in charge, so the main chart keeps following new samples.
      const full = fullRange();
      if (full) {
        const range = (state.manualRange && state.range) || follow() || full;
        await enqueue(() =>
          quietly(() =>
            Promise.all(
              readyPlots()
                .filter((ready) => ready !== plot)
                .map((ready) =>
                  Plotly.relayout(ready, rangeUpdate(range, ready)),
                ),
            ),
          ),
        );
      }
      // A newer dialog owns this plot and its focus now.
      if (dialog.open) return;
      Plotly.purge(plot);
      delete plot.dataset.rangeListener;
      if (opener?.disabled)
        document.querySelector("[data-metric]:not(:disabled)")?.focus();
      else opener?.focus();
    };
    return {
      closeExpanded,
      follow,
      fullRange,
      labelAxis,
      rememberRange,
      render,
      setPeriod,
      syncRange,
      wire,
      clearSelection,
    };
  }
  // Close a modal dialog when a click lands on its backdrop. Both the press
  // and the release must be outside the dialog box, so a drag that starts on
  // the plot and ends past the edge does not dismiss the view.
  function closeOnBackdrop(dialog) {
    const outside = (event) => {
      if (event.target !== dialog) return false;
      const box = dialog.getBoundingClientRect();
      return (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      );
    };
    let pressedOutside = false;
    dialog.addEventListener("pointerdown", (event) => {
      pressedOutside = outside(event);
    });
    dialog.addEventListener("click", (event) => {
      if (pressedOutside && outside(event) && dialog.open) dialog.close();
      pressedOutside = false;
    });
  }
  return { closeOnBackdrop, controller, controls, metrics, spec };
})();
