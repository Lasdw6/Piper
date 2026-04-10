const state = {
  benchmarks: [],
  currentId: null,
  currentDetail: null,
  selectedTaskIndex: null,
  refreshTimer: null
};

const elements = {
  benchmarkSelect: document.getElementById("benchmark-select"),
  benchmarkList: document.getElementById("benchmark-list"),
  benchmarkTitle: document.getElementById("benchmark-title"),
  benchmarkSubtitle: document.getElementById("benchmark-subtitle"),
  statusPill: document.getElementById("status-pill"),
  overviewCards: document.getElementById("overview-cards"),
  liveProgressPanel: document.getElementById("live-progress-panel"),
  liveProgressLabel: document.getElementById("live-progress-label"),
  liveProgressSummary: document.getElementById("live-progress-summary"),
  liveTaskTableBody: document.querySelector("#live-task-table tbody"),
  comparisonTableBody: document.querySelector("#comparison-table tbody"),
  scenarioTableBody: document.querySelector("#scenario-table tbody"),
  taskTableBody: document.querySelector("#task-table tbody"),
  refreshButton: document.getElementById("refresh-button")
};

elements.benchmarkSelect.addEventListener("change", async (event) => {
  await loadBenchmark(event.target.value);
});

elements.refreshButton.addEventListener("click", async () => {
  await bootstrap(true);
});

elements.taskTableBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-task-index]");
  if (!row) return;
  const index = parseInt(row.dataset.taskIndex, 10);
  const task = state.currentDetail?.tasks[index];
  if (!task) return;

  const prev = elements.taskTableBody.querySelector("tr.task-selected");
  if (prev) prev.classList.remove("task-selected");
  row.classList.add("task-selected");
  state.selectedTaskIndex = index;
  renderRunExplorer(task);
});

bootstrap(false).catch((error) => {
  console.error(error);
  elements.benchmarkTitle.textContent = "Failed to load benchmarks";
  elements.benchmarkSubtitle.textContent = String(error);
});

async function bootstrap(preserveSelection) {
  const previous = preserveSelection ? state.currentId : null;
  state.benchmarks = await fetchJson("/api/benchmarks");
  renderBenchmarkList();
  renderComparisonTable();

  const nextId = previous && state.benchmarks.some((item) => item.id === previous)
    ? previous
    : state.benchmarks[0]?.id;

  if (nextId) {
    elements.benchmarkSelect.value = nextId;
    await loadBenchmark(nextId);
  }
}

async function loadBenchmark(id) {
  state.currentId = id;
  state.currentDetail = await fetchJson(`/api/benchmark?id=${encodeURIComponent(id)}`);
  elements.benchmarkSelect.value = id;
  renderBenchmarkList();
  renderDetail();
  scheduleAutoRefresh();
}

function renderBenchmarkList() {
  elements.benchmarkSelect.innerHTML = "";
  elements.benchmarkList.innerHTML = "";

  for (const benchmark of state.benchmarks) {
    const option = document.createElement("option");
    option.value = benchmark.id;
    option.textContent = benchmark.label;
    elements.benchmarkSelect.append(option);

    const button = document.createElement("button");
    button.type = "button";
    button.className = `benchmark-item${benchmark.id === state.currentId ? " active" : ""}`;
    button.innerHTML = `
      <div class="stack">
        <strong>${escapeHtml(benchmark.label)}</strong>
        <span class="mini">${benchmark.status} · updated ${formatDate(benchmark.updatedAt)}</span>
        ${
          benchmark.progress
            ? `<span class="mini">progress ${benchmark.progress.completedRuns}/${benchmark.progress.totalRuns} · ${benchmark.progress.percentComplete.toFixed(1)}%</span>`
            : ""
        }
        <span class="mini">
          ${benchmark.overall ? `${benchmark.overall.pairCount} pairs · ${formatPercent(benchmark.overall.tokenReductionRate)} main tokens` : "No summary yet"}
        </span>
      </div>
    `;
    button.addEventListener("click", () => loadBenchmark(benchmark.id));
    elements.benchmarkList.append(button);
  }
}

function renderComparisonTable() {
  elements.comparisonTableBody.innerHTML = "";

  for (const benchmark of state.benchmarks) {
    const row = document.createElement("tr");
    const overall = benchmark.overall;
    const costReduction = overall
      ? 1 - (overall.compressedCost ?? 0) / Math.max(overall.baselineCost ?? 0, 0.000001)
      : 0;

    row.innerHTML = `
      <td>${escapeHtml(benchmark.label)}</td>
      <td><span class="pill ${benchmark.status === "post-eval" ? "pass" : "fail"}">${benchmark.status}</span></td>
      <td>${overall ? overall.pairCount : "—"}</td>
      <td class="mini">${overall ? `${formatPercent(overall.baselineSuccessRate)} → ${formatPercent(overall.compressedSuccessRate)}` : "—"}</td>
      <td>
        ${
          overall
            ? renderDeltaBlock("Change", formatPercent(overall.tokenReductionRate), trendClass(overall.tokenReductionRate))
            : "—"
        }
      </td>
      <td>
        ${
          overall
            ? renderDeltaBlock("Change", formatPercent(overall.peakReductionRate), trendClass(overall.peakReductionRate))
            : "—"
        }
      </td>
      <td class="mini">${overall ? `${formatCurrency(overall.baselineCost)} → ${formatCurrency(overall.compressedCost)} <span class="mono-delta ${trendClass(costReduction)}">${formatPercent(costReduction)}</span>` : "—"}</td>
    `;
    elements.comparisonTableBody.append(row);
  }
}

function renderDetail() {
  const detail = state.currentDetail;
  if (!detail) {
    return;
  }

  state.selectedTaskIndex = null;
  document.getElementById("run-explorer-panel").hidden = true;

  elements.benchmarkTitle.textContent = detail.label;
  elements.benchmarkSubtitle.textContent = `Updated ${formatDate(detail.updatedAt)} · ${detail.tasks.length} task pairs`;
  elements.statusPill.textContent = detail.status;
  elements.statusPill.className = `status-pill ${detail.status === "post-eval" ? "good" : detail.status === "running" ? "running" : "neutral"}`;

  renderOverviewCards(detail.summary?.overall);
  renderLiveProgress(detail.live);
  renderScenarioTable(detail.summary?.byScenario ?? []);
  renderTaskTable(detail.tasks);
}

function renderLiveProgress(live) {
  if (!live) {
    elements.liveProgressPanel.hidden = true;
    elements.liveProgressSummary.innerHTML = "";
    elements.liveTaskTableBody.innerHTML = "";
    return;
  }

  elements.liveProgressPanel.hidden = false;
  elements.liveProgressLabel.textContent =
    `${live.progress.completedRuns}/${live.progress.totalRuns} runs complete · updated ${formatDate(live.progress.updatedAt)}`;
  elements.liveProgressSummary.innerHTML = `
    <article class="metric-card live-metric">
      <p class="label">Current Run</p>
      <h3>${escapeHtml(live.progress.currentRunId ?? "idle")}</h3>
      <p class="muted">${escapeHtml(live.progress.lastFinishedRunId ? `Last finished: ${live.progress.lastFinishedRunId}` : "No completed runs yet")}</p>
    </article>
    <article class="metric-card live-metric">
      <p class="label">Completion</p>
      <h3>${live.progress.percentComplete.toFixed(1)}%</h3>
      <p class="muted">${formatNumber(live.progress.completedRuns)} of ${formatNumber(live.progress.totalRuns)} run variants</p>
    </article>
  `;

  elements.liveTaskTableBody.innerHTML = live.tasks
    .map((task) => {
      const completed = task.variants.length;
      const variantBadges = task.variants
        .map(
          (variant) => `
            <span class="live-variant">
              <span class="variant-chip ${variantClass(variant.variantId)}">${escapeHtml(variant.variantId)}</span>
              <span class="mini">${formatNumber(variant.totalTokens)} tok</span>
            </span>
          `
        )
        .join("");

      const statusText = task.variants
        .map((variant) => `${variant.variantId}: ${variant.submissionStatus || "done"}`)
        .join(" · ");

      return `
        <tr>
          <td>
            <div class="stack">
              <strong>${escapeHtml(task.instanceId)}</strong>
              <span class="mini">${escapeHtml(task.repo)}</span>
            </div>
          </td>
          <td>
            <div class="stack">
              <strong>${completed} variant${completed === 1 ? "" : "s"}</strong>
              <div class="live-variant-row">${variantBadges || '<span class="mini">—</span>'}</div>
            </div>
          </td>
          <td><span class="mini">${escapeHtml(statusText || "queued")}</span></td>
        </tr>
      `;
    })
    .join("");
}

function scheduleAutoRefresh() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }

  if (state.currentDetail?.status !== "running" || !state.currentId) {
    return;
  }

  state.refreshTimer = setTimeout(async () => {
    if (!state.currentId) return;
    try {
      await bootstrap(true);
    } catch (error) {
      console.error(error);
    }
  }, 10000);
}

function renderOverviewCards(overall) {
  if (!overall) {
    elements.overviewCards.innerHTML = "";
    return;
  }

  const baselineMainTokens = overall.baselineMainTokens ?? overall.baselineTotalTokens ?? 0;
  const compressedMainTokens = overall.compressedMainTokens ?? overall.compressedTotalTokens ?? 0;
  const mainTokenReductionRate = overall.mainTokenReductionRate ?? overall.tokenReductionRate ?? 0;
  const baselinePeakInputTokens = overall.baselinePeakInputTokens ?? 0;
  const compressedPeakInputTokens = overall.compressedPeakInputTokens ?? 0;
  const peakReductionRate = overall.peakReductionRate ?? 0;
  const baselineMainCostTotal = overall.baselineMainCost?.totalCost ?? overall.baselineEstimatedCost?.totalCost ?? 0;
  const compressedMainCostTotal = overall.compressedMainCost?.totalCost ?? overall.compressedEstimatedCost?.totalCost ?? 0;
  const baselineSummaryCostTotal = overall.baselineSummaryCost?.totalCost ?? 0;
  const compressedSummaryCostTotal = overall.compressedSummaryCost?.totalCost ?? 0;
  const baselineSummaryTokens = overall.baselineSummaryTokens ?? 0;
  const compressedSummaryTokens = overall.compressedSummaryTokens ?? 0;
  const costReduction = 1 - compressedMainCostTotal / Math.max(baselineMainCostTotal, 0.000001);

  const cards = [
    {
      label: "Success Rate",
      baseline: formatPercent(overall.baselineSuccessRate),
      compressed: formatPercent(overall.compressedSuccessRate),
      baselineHover: "Summary model does not affect success rate directly.",
      compressedHover: "Summary model does not affect success rate directly.",
      note: renderDeltaText(overall.compressedSuccessRate - overall.baselineSuccessRate, false)
    },
    {
      label: "Main Model Tokens",
      baseline: formatNumber(baselineMainTokens),
      compressed: formatNumber(compressedMainTokens),
      baselineHover: summaryHoverText(baselineSummaryTokens, baselineSummaryCostTotal),
      compressedHover: summaryHoverText(compressedSummaryTokens, compressedSummaryCostTotal),
      note: `${formatPercent(mainTokenReductionRate)} change`,
      tone: trendClass(mainTokenReductionRate)
    },
    {
      label: "Peak Input",
      baseline: formatNumber(baselinePeakInputTokens),
      compressed: formatNumber(compressedPeakInputTokens),
      baselineHover: "Peak input uses main-model prompt tokens only.",
      compressedHover: "Peak input uses main-model prompt tokens only.",
      note: `${formatPercent(peakReductionRate)} change`,
      tone: trendClass(peakReductionRate)
    },
    {
      label: "Main Model Cost",
      baseline: formatCurrency(baselineMainCostTotal),
      compressed: formatCurrency(compressedMainCostTotal),
      baselineHover: summaryHoverText(baselineSummaryTokens, baselineSummaryCostTotal),
      compressedHover: summaryHoverText(compressedSummaryTokens, compressedSummaryCostTotal),
      note: `${formatPercent(costReduction)} change`,
      tone: trendClass(costReduction)
    }
  ];

  elements.overviewCards.innerHTML = cards
    .map(
      (card) => `
        <article class="metric-card">
          <p class="label">${escapeHtml(card.label)}</p>
          <div class="metric-pair">
            ${renderNamedMetric("Base", card.baseline, "baseline", card.baselineHover)}
            ${renderNamedMetric("Comp", card.compressed, "compressed", card.compressedHover)}
          </div>
          <span class="mono-delta ${card.tone ?? "neutral"}">${escapeHtml(card.note)}</span>
        </article>
      `
    )
    .join("");
}

function renderScenarioTable(scenarios) {
  elements.scenarioTableBody.innerHTML = scenarios
    .map(
      (scenario) => {
        const mainTokenReductionRate = scenario.mainTokenReductionRate ?? scenario.tokenReductionRate ?? 0;
        const baselineMainCostTotal = scenario.baselineMainCost?.totalCost ?? scenario.baselineEstimatedCost?.totalCost ?? 0;
        const compressedMainCostTotal = scenario.compressedMainCost?.totalCost ?? scenario.compressedEstimatedCost?.totalCost ?? 0;
        const baselineSummaryTokens = scenario.baselineSummaryTokens ?? 0;
        const compressedSummaryTokens = scenario.compressedSummaryTokens ?? 0;
        const baselineSummaryCostTotal = scenario.baselineSummaryCost?.totalCost ?? 0;
        const compressedSummaryCostTotal = scenario.compressedSummaryCost?.totalCost ?? 0;

        return `<tr>
          <td>${escapeHtml(scenario.label)}</td>
          <td class="mini">${scenario.pairCount}</td>
          <td class="mini">${formatPercent(scenario.baselineSuccessRate)} → <span class="${trendClass(scenario.compressedSuccessRate - scenario.baselineSuccessRate)}">${formatPercent(scenario.compressedSuccessRate)}</span></td>
          <td>${renderDeltaBlock("", formatPercent(mainTokenReductionRate), trendClass(mainTokenReductionRate))}</td>
          <td>${renderDeltaBlock("", formatPercent(scenario.peakReductionRate), trendClass(scenario.peakReductionRate))}</td>
          <td class="mini" title="${escapeHtml(summaryHoverText(baselineSummaryTokens, baselineSummaryCostTotal) + "\n" + summaryHoverText(compressedSummaryTokens, compressedSummaryCostTotal))}">${formatCurrency(baselineMainCostTotal)} → ${formatCurrency(compressedMainCostTotal)}</td>
        </tr>`;
      }
    )
    .join("");
}

function renderTaskTable(tasks) {
  elements.taskTableBody.innerHTML = tasks
    .map((task, index) => {
      const compression = task.compressed.compression;
      const isSelected = state.selectedTaskIndex === index;
      return `
        <tr data-task-index="${index}"${isSelected ? ' class="task-selected"' : ''}>
          <td>
            <div class="stack">
              <strong>${escapeHtml(task.instanceId)}</strong>
              <span class="mini">${escapeHtml(task.repo)}</span>
            </div>
          </td>
          <td>${escapeHtml(task.scenarioBucket)}</td>
          <td>${renderVariantCell(task.baseline, "baseline")}</td>
          <td>${renderVariantCell(task.compressed, "compressed")}</td>
          <td class="${trendClass(task.tokenReductionRate)}">
            <div class="stack">
              <strong>${formatPercent(task.tokenReductionRate)}</strong>
              <span class="mini">input ${formatPercent(task.inputReductionRate)}</span>
            </div>
          </td>
          <td class="${trendClass(task.peakReductionRate)}">${formatPercent(task.peakReductionRate)}</td>
          <td class="${trendClass(task.costReductionRate)}">${formatPercent(task.costReductionRate)}</td>
          <td>
            ${
              compression
                ? `<div class="stack">
                    <span class="mini">archive ${formatMaybe(compression.archivedCount)}</span>
                    <span class="mini">retrieve ${formatMaybe(compression.retrievalCount)}</span>
                    <span class="mini">summary ${formatMaybe(compression.summaryCallCount)}</span>
                  </div>`
                : '<span class="mini">—</span>'
            }
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderVariantCell(run, variant) {
  const hover = `${formatNumber(run.totalTokens)} tok · in ${formatNumber(run.inputTokens)} out ${formatNumber(run.outputTokens)}\npeak ${formatNumber(run.peakInputTokens)} · ${run.submissionStatus ?? run.summary ?? ""}`;
  return `<div class="vcell" title="${escapeHtml(hover)}">
    <span class="pill ${run.resolved ? "pass" : "fail"}">${run.resolved ? "pass" : "fail"}</span>
    <span class="vtok">${fmtTok(run.totalTokens)}</span>
    <span class="vcost">${formatCurrency(run.cost.totalCost)}</span>
  </div>`;
}

function variantClass(variantId) {
  if (variantId === "baseline") return "baseline";
  if (variantId === "tool-only") return "compressed";
  if (variantId === "thresholded-hybrid") return "compressed";
  return "baseline";
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function fmtTok(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return String(Math.round(n));
}

function formatMaybe(value) {
  return typeof value === "number" ? formatNumber(value) : "—";
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 3
  }).format(value);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function renderNamedMetric(label, value, variant, hoverText) {
  return `<div class="metric-line ${variant}" title="${escapeHtml(hoverText ?? "")}">
    <span class="variant-chip ${variant}">${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
  </div>`;
}

function renderLabeledPair(baseline, compressed, baselineHover, compressedHover) {
  return `
    <div class="pair-block">
      <div class="pair-line baseline" title="${escapeHtml(baselineHover ?? "")}">
        <span class="variant-chip baseline">Baseline</span>
        <strong>${escapeHtml(baseline)}</strong>
      </div>
      <div class="pair-line compressed" title="${escapeHtml(compressedHover ?? "")}">
        <span class="variant-chip compressed">Compressed</span>
        <strong>${escapeHtml(compressed)}</strong>
      </div>
    </div>
  `;
}

function renderDeltaBlock(label, value, tone) {
  return `<span class="mono-delta ${tone}">${escapeHtml(value)}</span>`;
}

function renderDeltaText(value, invertGood) {
  const adjusted = invertGood ? -value : value;
  const direction = value > 0.01 ? "up" : value < -0.01 ? "down" : "flat";
  return `${formatPercent(Math.abs(value))} ${direction}`;
}

function summaryHoverText(summaryTokens, summaryCost) {
  return `Summary model tokens: ${formatNumber(summaryTokens)}\nSummary model cost: ${formatCurrency(summaryCost)}`;
}

function trendClass(value) {
  if (value > 0.01) {
    return "good";
  }
  if (value < -0.01) {
    return "bad";
  }
  return "neutral";
}


function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ── Run Explorer ─────────────────────────────────────────────────

function renderRunExplorer(task) {
  const panel = document.getElementById("run-explorer-panel");
  const content = document.getElementById("run-explorer-content");
  const label = document.getElementById("run-explorer-label");

  label.textContent = `${task.instanceId} — ${task.repo}`;
  panel.hidden = false;

  const bTurns = task.baseline.turns ?? [];
  const cTurns = task.compressed.turns ?? [];
  const bResponse = bTurns.filter((t) => t.kind === "response");
  const cResponse = cTurns.filter((t) => t.kind === "response");
  const cSummary = cTurns.filter((t) => t.kind === "summary");

  if (bResponse.length === 0 && cResponse.length === 0) {
    content.innerHTML = '<p class="muted explorer-empty">No per-turn data recorded for this run.</p>';
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }

  const summaryStrip = cSummary.length > 0 ? `
    <div class="summary-turn-strip">
      <p class="strip-heading">Compression model calls</p>
      <div class="summary-turn-row">
        ${cSummary.map((t, i) => `
          <div class="summary-turn-item">
            <span class="summary-turn-index">S${i + 1}</span>
            <span class="summary-turn-tokens">${formatNumber(t.inputTokens)} in · ${formatNumber(t.outputTokens)} out</span>
          </div>
        `).join("")}
      </div>
    </div>` : "";

  content.innerHTML = `
    <div class="explorer-charts">
      <div class="explorer-chart-block">
        <p class="chart-title">Input tokens per call</p>
        <div class="chart-legend">
              <span class="legend-dot legend-baseline-dot"></span><span>Baseline (${bResponse.length} calls)</span>
          <span class="legend-dot legend-compressed-dot"></span><span>Compressed (${cResponse.length} calls${cSummary.length > 0 ? ` + ${cSummary.length} summary` : ""})</span>
        </div>
        ${buildLineChart(bResponse, cResponse, "inputTokens")}
      </div>
      <div class="explorer-chart-block">
        <p class="chart-title">Output tokens per call</p>
        <div class="chart-legend">
          <span class="legend-dot legend-baseline-dot"></span><span>Baseline</span>
          <span class="legend-dot legend-compressed-dot"></span><span>Compressed</span>
        </div>
        ${buildLineChart(bResponse, cResponse, "outputTokens")}
      </div>
    </div>
    ${summaryStrip}
  `;

  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function buildLineChart(baseline, compressed, field) {
  const W = 560, H = 200;
  const ml = 56, mr = 16, mt = 18, mb = 36;
  const pw = W - ml - mr;
  const ph = H - mt - mb;

  const bVals = baseline.map((t) => t[field]);
  const cVals = compressed.map((t) => t[field]);
  const allVals = [...bVals, ...cVals];

  if (allVals.length === 0) return `<p class="muted">No data.</p>`;

  const maxVal = Math.max(...allVals, 1);
  const maxN   = Math.max(bVals.length, cVals.length, 2);
  const xp     = (i, n) => ml + (n <= 1 ? pw / 2 : (i / (maxN - 1)) * pw);
  const yp     = (v) => mt + ph - (v / maxVal) * ph;
  const fx     = (i, n) => xp(i, n).toFixed(1);
  const fy     = (v) => yp(v).toFixed(1);
  const fmt    = (v) => v >= 10000 ? `${(v/1000).toFixed(0)}k` : v >= 1000 ? `${(v/1000).toFixed(1)}k` : String(Math.round(v));

  // Y gridlines + labels
  const gridLines = [0.25, 0.5, 0.75, 1].map((r) => {
    const v = maxVal * r, y = yp(v).toFixed(1);
    return `<line x1="${ml}" y1="${y}" x2="${ml+pw}" y2="${y}" stroke="#1f1f1f" stroke-width="1"/>
            <text x="${ml-8}" y="${(yp(v)+4).toFixed(1)}" text-anchor="end" fill="#666" font-size="10" font-family="'Fira Code',monospace">${fmt(v)}</text>`;
  }).join("");

  // X axis labels
  const step = maxN > 20 ? 5 : maxN > 12 ? 3 : maxN > 8 ? 2 : 1;
  const xLabels = Array.from({ length: maxN }, (_, i) => {
    if (i % step !== 0 && i !== maxN - 1) return "";
    return `<text x="${xp(i,maxN).toFixed(1)}" y="${(mt+ph+16).toFixed(1)}" text-anchor="middle" fill="#555" font-size="10" font-family="'Fira Code',monospace">${i+1}</text>`;
  }).join("");

  const bColor = "#4d9fff", cColor = "#00C805";

  const area = (vals, color) => {
    if (vals.length < 2) return "";
    const top  = vals.map((v,i) => `${fx(i,vals.length)},${fy(v)}`).join(" ");
    const base = `${fx(vals.length-1,vals.length)},${(mt+ph).toFixed(1)} ${fx(0,vals.length)},${(mt+ph).toFixed(1)}`;
    return `<polygon points="${top} ${base}" fill="${color}" opacity="0.06"/>`;
  };

  const line = (vals, color, dash="") => {
    if (vals.length < 1) return "";
    const pts = vals.map((v,i) => `${fx(i,vals.length)},${fy(v)}`).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
  };

  const dots = (vals, color) =>
    vals.map((v,i) =>
      `<circle cx="${fx(i,vals.length)}" cy="${fy(v)}" r="3" fill="${color}" stroke="#0f0f0f" stroke-width="1.5"/>`
    ).join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="run-chart">
    <rect x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="#080808"/>
    ${gridLines}
    <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt+ph}" stroke="#2a2a2a" stroke-width="1"/>
    <line x1="${ml}" y1="${mt+ph}" x2="${ml+pw}" y2="${mt+ph}" stroke="#2a2a2a" stroke-width="1"/>
    ${area(bVals, bColor)}${area(cVals, cColor)}
    ${line(bVals, bColor, "5,3")}${line(cVals, cColor)}
    ${dots(bVals, bColor)}${dots(cVals, cColor)}
    ${xLabels}
    <text x="${(ml+pw/2).toFixed(1)}" y="${H-4}" text-anchor="middle" fill="#444" font-size="10" font-family="'Manrope',sans-serif">call #</text>
  </svg>`;
}
