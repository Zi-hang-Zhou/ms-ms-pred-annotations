const state = {
  cases: [],
  currentCase: null,
  currentSpectrumId: null,
  selectedPeakId: null,
  annotations: new Map(),
  showAllPeaks: false,
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
  assignmentBody: document.getElementById("assignmentBody"),
  showTopPeaksBtn: document.getElementById("showTopPeaksBtn"),
  showAllPeaksBtn: document.getElementById("showAllPeaksBtn"),
  toast: document.getElementById("toast"),
};

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

function init() {
  els.annotator.value = localStorage.getItem("annotator") || "";
  els.annotator.addEventListener("input", () => {
    localStorage.setItem("annotator", els.annotator.value);
    markDirty();
  });
  els.caseSearch.addEventListener("input", renderCaseList);
  els.statusFilter.addEventListener("change", renderCaseList);
  els.saveBtn.addEventListener("click", saveAnnotation);
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

  loadCases();
}

async function loadCases() {
  const resp = await fetch("/api/cases");
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();
  state.cases = data.cases;
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
    div.addEventListener("click", () => loadCase(item.case_id));
    div.innerHTML = `
      <div class="case-row">
        <div class="case-id">${escapeHtml(item.case_id)}</div>
        <span class="badge ${escapeHtml(item.status)}">${statusLabel(item.status)}</span>
      </div>
      <div class="brand-subtitle">${item.spectrum_count} spectra · ${item.peak_count} peaks</div>
    `;
    els.caseList.appendChild(div);
  }
}

async function loadCase(caseId) {
  if (state.dirty && !confirm("Current case has unsaved changes. Continue?")) return;
  const resp = await fetch(`/api/cases/${encodeURIComponent(caseId)}`);
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();
  state.currentCase = data;
  state.currentSpectrumId = data.spectra[0]?.spectrum_id || null;
  state.selectedPeakId = null;
  state.annotations = new Map();
  loadAnnotationIntoState(data.annotation);
  fillForm(data.annotation);
  state.dirty = false;
  els.saveBtn.disabled = false;
  renderCaseList();
  renderCase();
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
  renderAssignments();
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
  const height = 330;
  const pad = { left: 48, right: 18, top: 16, bottom: 34 };
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
    const assigned = state.annotations.has(p.peak_id);
    const selected = state.selectedPeakId === p.peak_id;
    const cls = `peak-line${assigned ? " assigned" : ""}${selected ? " selected" : ""}`;
    svg += `<line class="${cls}" data-peak-id="${escapeAttr(p.peak_id)}" x1="${px.toFixed(2)}" y1="${axisY}" x2="${px.toFixed(2)}" y2="${py.toFixed(2)}">`;
    svg += `<title>${p.mz.toFixed(4)} · rel ${(p.intensity_raw / intMax).toFixed(3)}</title></line>`;
  }
  svg += `</svg>`;
  els.spectrumPlot.innerHTML = svg;
  els.spectrumPlot.querySelectorAll(".peak-line").forEach((line) => {
    line.addEventListener("click", () => selectPeak(line.dataset.peakId));
  });
}

function renderAssignments() {
  const spec = currentSpectrum();
  if (!spec) return;
  const ranked = [...spec.peaks].sort((a, b) => b.intensity_raw - a.intensity_raw);
  const visible = state.showAllPeaks ? ranked : ranked.slice(0, 30);
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
