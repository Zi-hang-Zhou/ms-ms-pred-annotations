const state = {
  cases: [],
  currentCase: null,
  currentSpectrumId: null,
  selectedPeakId: null,
  selectedCandidateId: null,
  annotations: new Map(),
  showAllPeaks: true,
  dirty: false,
};

const els = {
  annotator: document.getElementById("annotatorInput"),
  caseSearch: document.getElementById("caseSearch"),
  statusFilter: document.getElementById("statusFilter"),
  caseList: document.getElementById("caseList"),
  caseTitle: document.getElementById("caseTitle"),
  caseMeta: document.getElementById("caseMeta"),
  saveBtn: document.getElementById("saveBtn"),
  overviewPanel: document.getElementById("overviewPanel"),
  progressSnapshot: document.getElementById("progressSnapshot"),
  featureMap: document.getElementById("featureMap"),
  featureMapSubtitle: document.getElementById("featureMapSubtitle"),
  resetFeatureMapBtn: document.getElementById("resetFeatureMapBtn"),
  spectrumTabs: document.getElementById("spectrumTabs"),
  spectrumPlot: document.getElementById("spectrumPlot"),
  peakReadout: document.getElementById("peakReadout"),
  statusSelect: document.getElementById("statusSelect"),
  finalSmiles: document.getElementById("finalSmiles"),
  finalFormula: document.getElementById("finalFormula"),
  finalAdduct: document.getElementById("finalAdduct"),
  finalConfidence: document.getElementById("finalConfidence"),
  finalInchi: document.getElementById("finalInchi"),
  finalInchikey: document.getElementById("finalInchikey"),
  globalNotes: document.getElementById("globalNotes"),
  modelEvidencePanel: document.getElementById("modelEvidencePanel"),
  modelEvidenceMeta: document.getElementById("modelEvidenceMeta"),
  formulaEvidence: document.getElementById("formulaEvidence"),
  candidateEvidenceList: document.getElementById("candidateEvidenceList"),
  predictedPeakEvidence: document.getElementById("predictedPeakEvidence"),
  useCandidateBtn: document.getElementById("useCandidateBtn"),
  assignmentBody: document.getElementById("assignmentBody"),
  showTopPeaksBtn: document.getElementById("showTopPeaksBtn"),
  showAllPeaksBtn: document.getElementById("showAllPeaksBtn"),
  layoutResizeHandle: document.getElementById("layoutResizeHandle"),
  toast: document.getElementById("toast"),
};

const peakTooltip = document.createElement("div");
peakTooltip.className = "peak-tooltip";
document.body.appendChild(peakTooltip);

const ASSIGNMENT_TYPES = [
  "",
  "precursor",
  "isotope",
  "fragment",
  "neutral_loss",
  "adduct_related",
  "noise",
  "unassigned",
  "ambiguous",
];

const CONFIDENCES = ["", "high", "medium", "low", "ambiguous"];
const UPPER_PANEL_HEIGHT_KEY = "annotationUpperPanelHeight";
const MIN_UPPER_PANEL_HEIGHT = 250;
const MIN_ASSIGNMENT_HEIGHT = 280;

function init() {
  els.annotator.value = localStorage.getItem("annotator") || "";
  els.annotator.addEventListener("input", () => {
    localStorage.setItem("annotator", els.annotator.value);
    markDirty();
  });
  els.caseSearch.addEventListener("input", renderCaseList);
  els.statusFilter.addEventListener("change", renderCaseList);
  els.resetFeatureMapBtn.addEventListener("click", resetFeatureMapView);
  els.saveBtn.addEventListener("click", saveAnnotation);
  els.useCandidateBtn.addEventListener("click", useSelectedCandidate);
  els.showTopPeaksBtn.addEventListener("click", () => {
    state.showAllPeaks = false;
    renderAssignments();
  });
  els.showAllPeaksBtn.addEventListener("click", () => {
    state.showAllPeaks = true;
    renderAssignments();
  });

  [
    els.statusSelect,
    els.finalSmiles,
    els.finalFormula,
    els.finalAdduct,
    els.finalConfidence,
    els.finalInchi,
    els.finalInchikey,
    els.globalNotes,
  ].forEach((el) => el.addEventListener("input", markDirty));

  setupLayoutResize();
  loadCases();
}

async function loadCases() {
  const resp = await fetch("/api/cases");
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();
  state.cases = data.cases;
  renderOverview();
  renderCaseList();
  if (state.cases.length) {
    loadCase(state.cases[0].case_id);
  }
}

function renderCaseList() {
  const q = els.caseSearch.value.trim().toLowerCase();
  const status = els.statusFilter.value;
  const filtered = state.cases.filter((item) => {
    if (q && !item.case_id.toLowerCase().includes(q)) return false;
    if (status !== "all" && item.status !== status) return false;
    return true;
  });
  els.caseList.innerHTML = "";
  for (const item of filtered) {
    const div = document.createElement("div");
    div.className = "case-item" + (state.currentCase?.case_id === item.case_id ? " active" : "");
    div.title = item.case_id;
    div.addEventListener("click", () => loadCase(item.case_id));
    div.innerHTML = `
      <div class="case-row">
        <div class="case-id">${escapeHtml(item.case_id)}</div>
        <span class="badge ${escapeHtml(item.status)}">${statusLabel(item.status)}</span>
      </div>
      <div class="brand-subtitle">${item.spectrum_count} spectra · ${item.peak_count} peaks</div>
      ${caseEvidenceHtml(item)}
    `;
    els.caseList.appendChild(div);
  }
}

function caseEvidenceHtml(item) {
  const summary = item.model_evidence_summary;
  if (!summary) return "";
  const formula = summary.top_formula?.formula || "";
  const adduct = summary.top_formula?.adduct || summary.top_candidate?.adduct || "";
  const smiles = summary.top_candidate?.smiles || "";
  const dist = summary.top_candidate?.entropy_distance;
  const formulaText = formula ? `${formula} ${adduct}`.trim() : "formula unavailable";
  const distText = dist === null || dist === undefined ? "" : ` · dist ${formatNumber(dist, 3)}`;
  return `
    <div class="case-evidence">
      <div>Top formula: <span class="mono">${escapeHtml(formulaText)}</span></div>
      <div>ICEBERG #1${escapeHtml(distText)}: <span class="mono">${escapeHtml(smiles)}</span></div>
    </div>
  `;
}

async function loadCase(caseId) {
  if (state.dirty && !confirm("Current case has unsaved changes. Continue?")) return;
  const resp = await fetch(`/api/cases/${encodeURIComponent(caseId)}`);
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();
  state.currentCase = data;
  state.currentSpectrumId = data.spectra[0]?.spectrum_id || null;
  state.selectedPeakId = null;
  state.selectedCandidateId = data.model_evidence?.candidates?.[0]?.candidate_id || null;
  state.annotations = new Map();
  loadAnnotationIntoState(data.annotation);
  fillForm(data.annotation);
  state.dirty = false;
  els.saveBtn.disabled = false;
  renderCaseList();
  renderCase();
}

function renderOverview() {
  const cases = state.cases || [];
  if (!cases.length) {
    els.overviewPanel.classList.add("hidden");
    return;
  }
  els.overviewPanel.classList.remove("hidden");

  const statusCounts = countBy(cases, (item) => item.status || "not_started");
  const evidenceCount = cases.filter((item) => item.model_evidence_available).length;
  const confidenceCounts = countBy(cases, (item) => item.final_confidence || "unset");
  els.progressSnapshot.innerHTML = [
    metricCard("Cases", cases.length),
    metricCard("Complete", statusCounts.complete || 0),
    metricCard("In review", statusCounts.review || 0),
    metricCard("Model evidence", evidenceCount),
    metricCard("High confidence", confidenceCounts.high || 0),
  ].join("");

  renderFeatureMap();
}

function metricCard(label, value) {
  return `
    <div class="metric-card">
      <div class="metric-value">${escapeHtml(value)}</div>
      <div class="metric-label">${escapeHtml(label)}</div>
    </div>
  `;
}

function countBy(items, fn) {
  return items.reduce((acc, item) => {
    const key = fn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function renderFeatureMap() {
  const rawPoints = (state.cases || [])
    .map((item, index) => {
      const feature = item.feature || {};
      const rt = Number(feature.retention_time_min);
      const mz = Number(feature.precursor_mz);
      if (!Number.isFinite(mz)) return null;
      return {
        ...item,
        index,
        rt: Number.isFinite(rt) ? rt : null,
        mz,
      };
    })
    .filter(Boolean);

  if (!rawPoints.length) {
    els.featureMapSubtitle.textContent = "No precursor m/z metadata available";
    els.featureMap.innerHTML = `<div class="empty-map">No precursor m/z metadata available</div>`;
    return;
  }

  const hasRt = rawPoints.some((point) => point.rt !== null);
  const points = rawPoints.map((point) => ({
    ...point,
    xValue: hasRt ? point.rt : point.index + 1,
  }));
  els.featureMapSubtitle.textContent = hasRt
    ? "RT vs precursor m/z · click a point to open a case"
    : "Case index vs precursor m/z · click a point to open a case";

  const width = Math.max(520, els.featureMap.clientWidth || 520);
  const height = 124;
  const pad = { left: 42, right: 14, top: 12, bottom: 26 };
  const xMin = Math.min(...points.map((p) => p.xValue));
  const xMax = Math.max(...points.map((p) => p.xValue));
  const mzMin = Math.min(...points.map((p) => p.mz));
  const mzMax = Math.max(...points.map((p) => p.mz));
  const x = (value) => pad.left + ((value - xMin) / Math.max(xMax - xMin, 1)) * (width - pad.left - pad.right);
  const y = (mz) => height - pad.bottom - ((mz - mzMin) / Math.max(mzMax - mzMin, 1)) * (height - pad.top - pad.bottom);

  let svg = `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`;
  svg += `<line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="#aab4c0"/>`;
  svg += `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" stroke="#aab4c0"/>`;
  svg += `<text x="${width / 2}" y="${height - 7}" text-anchor="middle" class="axis-label">${hasRt ? "RT" : "case index"}</text>`;
  svg += `<text x="12" y="${height / 2}" transform="rotate(-90 12 ${height / 2})" text-anchor="middle" class="axis-label">m/z</text>`;
  for (const point of points) {
    const active = state.currentCase?.case_id === point.case_id;
    const cls = `feature-point ${statusClass(point.status)}${active ? " active" : ""}${point.model_evidence_available ? " has-evidence" : ""}`;
    const xLabel = hasRt ? `RT ${formatNumber(point.rt, 2)}` : `case ${point.index + 1}`;
    svg += `<circle class="${cls}" data-case-id="${escapeAttr(point.case_id)}" cx="${x(point.xValue).toFixed(2)}" cy="${y(point.mz).toFixed(2)}" r="${active ? 5 : 3.5}"><title>${escapeHtml(point.case_id)} · ${escapeHtml(xLabel)} · m/z ${formatNumber(point.mz, 4)}</title></circle>`;
  }
  svg += `</svg>`;
  els.featureMap.innerHTML = svg;
  els.featureMap.querySelectorAll(".feature-point").forEach((point) => {
    point.addEventListener("click", () => loadCase(point.dataset.caseId));
  });
}

function loadAnnotationIntoState(annotation) {
  if (!annotation || !Array.isArray(annotation.peak_assignments)) return;
  for (const item of annotation.peak_assignments) {
    if (item.peak_id) {
      state.annotations.set(item.peak_id, { ...item });
    }
  }
}

function fillForm(annotation) {
  const final = annotation?.final_structure || {};
  els.statusSelect.value = annotation?.status || "in_progress";
  els.finalSmiles.value = final.smiles || "";
  els.finalFormula.value = final.formula || "";
  els.finalAdduct.value = final.adduct || "";
  els.finalConfidence.value = final.confidence || "";
  els.finalInchi.value = final.inchi || "";
  els.finalInchikey.value = final.inchikey || "";
  els.globalNotes.value = annotation?.global_notes || "";
}

function renderCase() {
  const c = state.currentCase;
  if (!c) return;
  els.caseTitle.textContent = c.case_id;
  els.caseMeta.textContent = formatFeature(c.feature);
  renderSpectrumTabs();
  renderSpectrum();
  renderModelEvidence();
  renderAssignments();
  renderFeatureMap();
}

function formatFeature(feature) {
  const parts = [];
  if (feature.precursor_mz !== undefined) parts.push(`precursor m/z ${Number(feature.precursor_mz).toFixed(4)}`);
  if (feature.retention_time_min !== undefined) parts.push(`RT ${Number(feature.retention_time_min).toFixed(3)} min`);
  if (feature.adduct) parts.push(`adduct ${feature.adduct}`);
  if (feature.instrument) parts.push(feature.instrument);
  if (feature.method) parts.push(feature.method);
  return parts.join(" · ");
}

function renderSpectrumTabs() {
  els.spectrumTabs.innerHTML = "";
  for (const spec of state.currentCase.spectra) {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (spec.spectrum_id === state.currentSpectrumId ? " active" : "");
    btn.textContent = spectrumLabel(spec);
    btn.addEventListener("click", () => {
      state.currentSpectrumId = spec.spectrum_id;
      state.selectedPeakId = null;
      renderCase();
    });
    els.spectrumTabs.appendChild(btn);
  }
}

function spectrumLabel(spec) {
  if (spec.collision_label) return spec.collision_label;
  if (spec.collision_energy_ev !== null && spec.collision_energy_ev !== undefined) {
    return `${Number(spec.collision_energy_ev).toFixed(1)} eV`;
  }
  return spec.spectrum_id;
}

function currentSpectrum() {
  return state.currentCase?.spectra.find((spec) => spec.spectrum_id === state.currentSpectrumId);
}

function renderSpectrum() {
  const spec = currentSpectrum();
  if (!spec) {
    els.spectrumPlot.innerHTML = "";
    return;
  }
  const peaks = spec.peaks;
  const width = Math.max(720, els.spectrumPlot.clientWidth || 720);
  const height = Math.max(120, els.spectrumPlot.clientHeight || 190);
  const pad = { left: 48, right: 18, top: 8, bottom: 26 };
  const mzMin = Math.min(...peaks.map((p) => p.mz));
  const mzMax = Math.max(...peaks.map((p) => p.mz));
  const intMax = Math.max(...peaks.map((p) => p.intensity_raw), 1);
  const x = (mz) => pad.left + ((mz - mzMin) / Math.max(mzMax - mzMin, 1)) * (width - pad.left - pad.right);
  const y = (inten) => height - pad.bottom - (inten / intMax) * (height - pad.top - pad.bottom);

  const axisY = height - pad.bottom;
  let svg = `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`;
  svg += `<line x1="${pad.left}" y1="${axisY}" x2="${width - pad.right}" y2="${axisY}" stroke="#aab4c0"/>`;
  svg += `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${axisY}" stroke="#aab4c0"/>`;
  svg += `<text x="${width / 2}" y="${height - 8}" text-anchor="middle" class="axis-label">m/z</text>`;
  svg += `<text x="12" y="${height / 2}" transform="rotate(-90 12 ${height / 2})" text-anchor="middle" class="axis-label">relative intensity</text>`;
  for (const p of peaks) {
    const px = x(p.mz);
    const py = y(p.intensity_raw);
    const rel = p.intensity_raw / intMax;
    const assigned = state.annotations.has(p.peak_id);
    const selected = state.selectedPeakId === p.peak_id;
    const cls = `peak-line${assigned ? " assigned" : ""}${selected ? " selected" : ""}`;
    svg += `<line class="${cls}" data-peak-id="${escapeAttr(p.peak_id)}" data-mz="${p.mz.toFixed(4)}" data-rel="${rel.toFixed(3)}" x1="${px.toFixed(2)}" y1="${axisY}" x2="${px.toFixed(2)}" y2="${py.toFixed(2)}"></line>`;
  }
  svg += `</svg>`;
  els.spectrumPlot.innerHTML = svg;
  els.spectrumPlot.querySelectorAll(".peak-line").forEach((line) => {
    line.addEventListener("click", () => selectPeak(line.dataset.peakId));
    line.addEventListener("mousemove", (event) => showPeakTooltip(event, line));
    line.addEventListener("mouseleave", hidePeakTooltip);
  });
}

function renderModelEvidence() {
  const evidence = state.currentCase?.model_evidence;
  if (!evidence || !Array.isArray(evidence.candidates) || evidence.candidates.length === 0) {
    els.modelEvidencePanel.classList.add("hidden");
    els.candidateEvidenceList.innerHTML = "";
    els.predictedPeakEvidence.innerHTML = "";
    return;
  }

  els.modelEvidencePanel.classList.remove("hidden");
  els.modelEvidenceMeta.textContent = `${evidence.candidate_count} candidates · top ${evidence.top_n} shown · ${evidence.predicted_peaks_per_candidate} predicted peaks each · loaded from ICEBERG files`;

  const formulas = evidence.formula_predictions || [];
  if (formulas.length) {
    els.formulaEvidence.innerHTML = formulas
      .slice(0, 3)
      .map((item) => {
        const rank = item.rank ? `#${item.rank}` : "";
        const score = item.score === null || item.score === undefined ? "" : ` · ${formatNumber(item.score, 4)}`;
        return `<span>${escapeHtml(rank)} ${escapeHtml(item.formula || "")} ${escapeHtml(item.adduct || "")}${escapeHtml(score)}</span>`;
      })
      .join("");
  } else {
    els.formulaEvidence.innerHTML = "";
  }

  els.candidateEvidenceList.innerHTML = "";
  for (const candidate of evidence.candidates) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "candidate-evidence-item" + (candidate.candidate_id === state.selectedCandidateId ? " active" : "");
    item.dataset.candidateId = candidate.candidate_id;
    item.innerHTML = `
      <div class="candidate-header">
        <span class="candidate-rank">#${candidate.rank}</span>
        <span class="candidate-score">dist ${formatNumber(candidate.entropy_distance, 4)}</span>
      </div>
      <img class="candidate-structure" src="${escapeAttr(structureUrl(candidate.smiles, 220, 120))}" alt="Candidate ${candidate.rank} structure" loading="lazy" draggable="false">
      <div class="candidate-smiles mono">${escapeHtml(candidate.smiles || "")}</div>
    `;
    item.querySelector(".candidate-structure")?.addEventListener("error", handleStructureImageError);
    item.addEventListener("click", () => {
      state.selectedCandidateId = candidate.candidate_id;
      renderModelEvidence();
    });
    els.candidateEvidenceList.appendChild(item);
  }

  renderPredictedPeaks();
}

function renderPredictedPeaks() {
  const candidate = selectedCandidate();
  if (!candidate) {
    els.predictedPeakEvidence.innerHTML = "";
    return;
  }
  const peaks = candidate.predicted_peaks || [];
  const rows = peaks.length
    ? peaks
        .map((peak) => {
          const ce = peak.collision_label || (peak.collision_energy_ev !== null && peak.collision_energy_ev !== undefined ? `${formatNumber(peak.collision_energy_ev, 1)} eV` : "");
          return `<tr><td>${formatNumber(peak.mz, 4)}</td><td>${formatNumber(peak.intensity, 3)}</td><td>${escapeHtml(ce)}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="3">No predicted peaks available</td></tr>`;
  els.predictedPeakEvidence.innerHTML = `
    <div class="selected-candidate-card">
      <img class="selected-candidate-structure" src="${escapeAttr(structureUrl(candidate.smiles, 320, 180))}" alt="Selected candidate structure" draggable="false">
      <div class="selected-candidate-meta">
        <div class="candidate-rank">ICEBERG #${candidate.rank}</div>
        <div class="candidate-score">entropy distance ${formatNumber(candidate.entropy_distance, 4)}</div>
        <div class="candidate-smiles mono">${escapeHtml(candidate.smiles || "")}</div>
      </div>
    </div>
    <div class="predicted-title">Selected #${candidate.rank} predicted peaks</div>
    <table>
      <thead><tr><th>m/z</th><th>Rel.</th><th>CE</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  els.predictedPeakEvidence
    .querySelector(".selected-candidate-structure")
    ?.addEventListener("error", handleStructureImageError);
}

function handleStructureImageError(event) {
  const placeholder = document.createElement("div");
  placeholder.className = "structure-placeholder";
  placeholder.textContent = "structure unavailable";
  event.currentTarget.replaceWith(placeholder);
}

function structureUrl(smiles, width, height) {
  if (!smiles) return "";
  const params = new URLSearchParams({
    smiles,
    w: String(width),
    h: String(height),
  });
  return `/api/structure.svg?${params.toString()}`;
}

function selectedCandidate() {
  const candidates = state.currentCase?.model_evidence?.candidates || [];
  return candidates.find((item) => item.candidate_id === state.selectedCandidateId) || candidates[0] || null;
}

function useSelectedCandidate() {
  const candidate = selectedCandidate();
  if (!candidate) return;
  els.finalSmiles.value = candidate.smiles || "";
  els.finalAdduct.value = candidate.adduct || els.finalAdduct.value;
  if (candidate.inchikey) els.finalInchikey.value = candidate.inchikey;
  const topFormula = state.currentCase?.model_evidence?.formula_predictions?.[0];
  if (topFormula?.formula && !els.finalFormula.value.trim()) {
    els.finalFormula.value = topFormula.formula;
  }
  const note = `ICEBERG starting point: rank ${candidate.rank}, entropy distance ${formatNumber(candidate.entropy_distance, 4)}.`;
  els.globalNotes.value = els.globalNotes.value.trim()
    ? `${els.globalNotes.value.trim()}\n${note}`
    : note;
  markDirty();
  flashFinalStructureFields();
  showToast("Filled Final Structure fields");
}

function resetFeatureMapView() {
  els.caseSearch.value = "";
  els.statusFilter.value = "all";
  renderCaseList();
  renderFeatureMap();
  const firstCaseId = state.cases[0]?.case_id;
  if (firstCaseId && state.currentCase?.case_id !== firstCaseId) {
    loadCase(firstCaseId);
  }
  showToast("Filters cleared; feature map reset");
}

function flashFinalStructureFields() {
  const fields = [
    els.finalSmiles,
    els.finalFormula,
    els.finalAdduct,
    els.finalInchikey,
    els.globalNotes,
  ];
  els.finalSmiles.scrollIntoView({ block: "nearest", behavior: "smooth" });
  for (const field of fields) {
    field.classList.remove("field-flash");
    void field.offsetWidth;
    field.classList.add("field-flash");
  }
}

function setupLayoutResize() {
  const savedHeight = Number(localStorage.getItem(UPPER_PANEL_HEIGHT_KEY));
  if (Number.isFinite(savedHeight) && savedHeight > 0) {
    setUpperPanelHeight(savedHeight, false);
  }

  els.layoutResizeHandle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    document.body.classList.add("resizing-layout");
    els.layoutResizeHandle.setPointerCapture(event.pointerId);

    const onPointerMove = (moveEvent) => {
      const gridTop = document.querySelector(".content-grid").getBoundingClientRect().top;
      setUpperPanelHeight(moveEvent.clientY - gridTop, true);
    };

    const onPointerUp = () => {
      document.body.classList.remove("resizing-layout");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  });

  els.layoutResizeHandle.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const current = getUpperPanelHeight();
    setUpperPanelHeight(current + (event.key === "ArrowDown" ? 24 : -24), true);
  });

  window.addEventListener("resize", () => {
    setUpperPanelHeight(getUpperPanelHeight(), false);
    renderSpectrum();
  });
}

function getUpperPanelHeight() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--upper-panel-height");
  return Number.parseFloat(raw) || 330;
}

function setUpperPanelHeight(height, persist) {
  const workspace = document.querySelector(".workspace");
  const topbar = document.querySelector(".topbar");
  const maxHeight = Math.max(
    MIN_UPPER_PANEL_HEIGHT,
    workspace.clientHeight - topbar.offsetHeight - MIN_ASSIGNMENT_HEIGHT - 34
  );
  const nextHeight = Math.min(Math.max(height, MIN_UPPER_PANEL_HEIGHT), maxHeight);
  document.documentElement.style.setProperty("--upper-panel-height", `${Math.round(nextHeight)}px`);
  if (persist) {
    localStorage.setItem(UPPER_PANEL_HEIGHT_KEY, String(Math.round(nextHeight)));
  }
  if (state.currentCase) {
    window.requestAnimationFrame(renderSpectrum);
  }
}

function renderAssignments() {
  const spec = currentSpectrum();
  if (!spec) return;
  const ranked = [...spec.peaks].sort((a, b) => b.intensity_raw - a.intensity_raw);
  const visible = state.showAllPeaks ? ranked : ranked.slice(0, 30);
  els.showTopPeaksBtn.textContent = `Top peaks by intensity (${Math.min(30, ranked.length)}/${ranked.length})`;
  els.showAllPeaksBtn.textContent = `All peaks (${ranked.length})`;
  visible.sort((a, b) => a.mz - b.mz);
  const intMax = Math.max(...spec.peaks.map((p) => p.intensity_raw), 1);
  els.assignmentBody.innerHTML = "";

  for (const peak of visible) {
    const ann = state.annotations.get(peak.peak_id) || defaultPeakAnnotation(peak, spec);
    const tr = document.createElement("tr");
    tr.className = state.selectedPeakId === peak.peak_id ? "selected" : "";
    tr.dataset.peakId = peak.peak_id;
    tr.innerHTML = `
      <td class="num-cell">${peak.mz.toFixed(4)}</td>
      <td class="num-cell">${(peak.intensity_raw / intMax).toFixed(3)}</td>
      <td>${selectHtml("assignment_type", ASSIGNMENT_TYPES, ann.assignment_type)}</td>
      <td><textarea data-field="fragment_structure" class="mono" rows="1">${escapeHtml(ann.fragment_structure || "")}</textarea></td>
      <td><input data-field="fragment_formula" class="mono" value="${escapeAttr(ann.fragment_formula || "")}"></td>
      <td><input data-field="neutral_loss" class="mono" value="${escapeAttr(ann.neutral_loss || "")}"></td>
      <td><input data-field="theoretical_mz" class="mono" value="${escapeAttr(ann.theoretical_mz || "")}"></td>
      <td>${selectHtml("confidence", CONFIDENCES, ann.confidence)}</td>
      <td><textarea data-field="evidence_note" rows="1">${escapeHtml(ann.evidence_note || "")}</textarea></td>
    `;
    tr.addEventListener("click", (event) => {
      if (event.target.matches("input, textarea, select")) return;
      selectPeak(peak.peak_id);
    });
    tr.querySelectorAll("input, textarea, select").forEach((input) => {
      input.addEventListener("input", () => updatePeakAnnotation(peak, spec, tr));
      input.addEventListener("change", () => updatePeakAnnotation(peak, spec, tr));
    });
    els.assignmentBody.appendChild(tr);
  }
}

function defaultPeakAnnotation(peak, spec) {
  return {
    peak_id: peak.peak_id,
    spectrum_id: spec.spectrum_id,
    mz: peak.mz,
    intensity_raw: peak.intensity_raw,
    assignment_type: "",
    fragment_structure: "",
    fragment_formula: "",
    neutral_loss: "",
    theoretical_mz: "",
    confidence: "",
    evidence_note: "",
  };
}

function updatePeakAnnotation(peak, spec, tr) {
  const ann = defaultPeakAnnotation(peak, spec);
  tr.querySelectorAll("[data-field]").forEach((input) => {
    ann[input.dataset.field] = input.value;
  });
  state.annotations.set(peak.peak_id, ann);
  markDirty();
  renderSpectrum();
}

function selectHtml(field, values, selected) {
  const opts = values
    .map((value) => `<option value="${escapeAttr(value)}"${value === selected ? " selected" : ""}>${value || "unset"}</option>`)
    .join("");
  return `<select data-field="${field}">${opts}</select>`;
}

function selectPeak(peakId) {
  state.selectedPeakId = peakId;
  const spec = currentSpectrum();
  const peak = spec?.peaks.find((p) => p.peak_id === peakId);
  if (peak) {
    const max = Math.max(...spec.peaks.map((p) => p.intensity_raw), 1);
    els.peakReadout.textContent = `${spectrumLabel(spec)} · m/z ${peak.mz.toFixed(4)} · rel ${(peak.intensity_raw / max).toFixed(3)}`;
  }
  renderSpectrum();
  renderAssignments();
  const row = els.assignmentBody.querySelector(`tr[data-peak-id="${cssEscape(peakId)}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}

function showPeakTooltip(event, line) {
  peakTooltip.innerHTML = `m/z ${escapeHtml(line.dataset.mz)}<br>rel ${escapeHtml(line.dataset.rel)}`;
  peakTooltip.style.display = "block";
  const offset = 14;
  peakTooltip.style.left = `${event.clientX + offset}px`;
  peakTooltip.style.top = `${event.clientY + offset}px`;
}

function hidePeakTooltip() {
  peakTooltip.style.display = "none";
}

function collectAnnotation() {
  return {
    annotator: els.annotator.value.trim(),
    status: els.statusSelect.value,
    final_structure: {
      smiles: els.finalSmiles.value.trim(),
      formula: els.finalFormula.value.trim(),
      adduct: els.finalAdduct.value.trim(),
      confidence: els.finalConfidence.value,
      inchi: els.finalInchi.value.trim(),
      inchikey: els.finalInchikey.value.trim(),
    },
    global_notes: els.globalNotes.value.trim(),
    peak_assignments: [...state.annotations.values()].filter((ann) => {
      return [
        "assignment_type",
        "fragment_structure",
        "fragment_formula",
        "neutral_loss",
        "theoretical_mz",
        "confidence",
        "evidence_note",
      ].some((key) => String(ann[key] || "").trim() !== "");
    }),
  };
}

async function saveAnnotation() {
  if (!state.currentCase) return;
  const payload = collectAnnotation();
  const resp = await fetch(`/api/cases/${encodeURIComponent(state.currentCase.case_id)}/annotation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    showToast(`Save failed: ${await resp.text()}`);
    return;
  }
  const data = await resp.json();
  state.dirty = false;
  const item = state.cases.find((c) => c.case_id === state.currentCase.case_id);
  if (item) item.status = data.annotation.status;
  if (item) item.final_confidence = data.annotation.final_structure?.confidence || "";
  renderOverview();
  renderCaseList();
  showToast("Saved annotation");
}

function markDirty() {
  state.dirty = true;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function statusLabel(status) {
  return {
    not_started: "not started",
    in_progress: "in progress",
    review: "review",
    complete: "complete",
  }[status] || status;
}

function statusClass(status) {
  return String(status || "not_started").replace(/[^A-Za-z0-9_-]/g, "_");
}

function formatNumber(value, digits) {
  if (value === null || value === undefined || value === "") return "";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return num.toFixed(digits);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener("resize", () => renderSpectrum());

init();
