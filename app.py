#!/usr/bin/env python3
"""Manual MS/MS structure annotation platform.

The app intentionally exposes only raw experimental spectra and basic feature
metadata by default. Candidate structures and model predictions are returned
only when ANNOTATION_ENABLE_MODEL_EVIDENCE=1 is set for assisted annotation.
Ground-truth fields are never intentionally exposed by API endpoints.
"""
from __future__ import annotations

import csv
import json
import os
import re
import tempfile
from functools import lru_cache
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, Response, abort, jsonify, render_template, request

try:
    from rdkit import Chem
    from rdkit.Chem import rdDepictor
    from rdkit.Chem.Draw import rdMolDraw2D

    RDKIT_AVAILABLE = True
except ImportError:
    Chem = None
    rdDepictor = None
    rdMolDraw2D = None
    RDKIT_AVAILABLE = False


APP_DIR = Path(__file__).resolve().parent
DEFAULT_CASE_DIR = APP_DIR / "example_cases"
CASE_DIR = Path(os.environ.get("ANNOTATION_CASE_DIR", DEFAULT_CASE_DIR)).resolve()
ANNOTATION_DIR = Path(
    os.environ.get("ANNOTATION_OUTPUT_DIR", APP_DIR / "annotations")
).resolve()
ANNOTATION_DIR.mkdir(parents=True, exist_ok=True)
ENABLE_MODEL_EVIDENCE = os.environ.get("ANNOTATION_ENABLE_MODEL_EVIDENCE", "").lower() in {
    "1",
    "true",
    "yes",
    "on",
}
MODEL_EVIDENCE_TOP_N = int(os.environ.get("ANNOTATION_MODEL_EVIDENCE_TOP_N", "20"))
MODEL_EVIDENCE_PEAKS_PER_CANDIDATE = int(
    os.environ.get("ANNOTATION_MODEL_EVIDENCE_PEAKS_PER_CANDIDATE", "12")
)

CASE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")

app = Flask(__name__)


def _safe_case_id(case_id: str) -> str:
    if not CASE_ID_RE.match(case_id):
        abort(400, "invalid case id")
    return case_id


def _case_path(case_id: str) -> Path:
    case_id = _safe_case_id(case_id)
    path = (CASE_DIR / case_id).resolve()
    if not path.is_dir() or CASE_DIR not in path.parents:
        abort(404, "case not found")
    return path


def _annotation_path(case_id: str) -> Path:
    case_id = _safe_case_id(case_id)
    return ANNOTATION_DIR / f"{case_id}.json"


def _read_json(path: Path) -> dict[str, Any]:
    with path.open() as fp:
        return json.load(fp)


def _public_feature_metadata(meta: dict[str, Any]) -> dict[str, Any]:
    feature = meta.get("feature", {})
    allowed = [
        "precursor_mz",
        "retention_time_min",
        "method",
        "sample",
        "instrument",
        "adduct",
        "fragmentation_method",
        "ion_mode",
    ]
    out = {key: feature[key] for key in allowed if key in feature}
    if "case_id" in meta:
        out["case_id"] = meta["case_id"]
    return out


def _read_spectra(case_path: Path) -> list[dict[str, Any]]:
    spectra: dict[str, dict[str, Any]] = {}
    csv_path = case_path / "experimental_spectra_long.csv"
    if not csv_path.exists():
        abort(500, "experimental_spectra_long.csv missing")

    with csv_path.open() as fp:
        reader = csv.DictReader(fp)
        for row in reader:
            spectrum_id = row.get("spectrum_id") or "spectrum_01"
            entry = spectra.setdefault(
                spectrum_id,
                {
                    "spectrum_id": spectrum_id,
                    "spectrum_type": row.get("spectrum_type", "ms2"),
                    "collision_label": row.get("collision_label", ""),
                    "collision_value_nce": _float_or_none(row.get("collision_value_nce")),
                    "collision_energy_ev": _float_or_none(row.get("collision_energy_ev")),
                    "peaks": [],
                },
            )
            mz = _float_or_none(row.get("mz"))
            intensity_raw = _float_or_none(row.get("intensity_raw"))
            intensity_display = _float_or_none(row.get("intensity_display"))
            if mz is None or intensity_raw is None:
                continue
            entry["peaks"].append(
                {
                    "peak_id": f"{spectrum_id}:{len(entry['peaks']) + 1}",
                    "mz": mz,
                    "intensity_raw": intensity_raw,
                    "intensity_display": intensity_display,
                }
            )

    out = []
    for spec in spectra.values():
        spec["peaks"].sort(key=lambda peak: peak["mz"])
        spec["peak_count"] = len(spec["peaks"])
        out.append(spec)
    out.sort(key=lambda spec: (
        spec.get("collision_value_nce") is None,
        spec.get("collision_value_nce") or spec.get("collision_energy_ev") or 0,
        spec["spectrum_id"],
    ))
    return out


def _read_model_evidence(case_path: Path) -> dict[str, Any] | None:
    if not ENABLE_MODEL_EVIDENCE:
        return None

    candidates_path = case_path / "iceberg_candidates.csv"
    predicted_path = case_path / "iceberg_predicted_spectra_long.csv"
    formulas_path = case_path / "formula_predictions.csv"
    if not candidates_path.exists():
        return None

    candidates: list[dict[str, Any]] = []
    with candidates_path.open() as fp:
        reader = csv.DictReader(fp)
        for row in reader:
            rank = _int_or_none(row.get("rank"))
            if rank is None or rank > MODEL_EVIDENCE_TOP_N:
                continue
            candidates.append(
                {
                    "candidate_id": row.get("candidate_id") or f"candidate_{rank:03d}",
                    "rank": rank,
                    "entropy_distance": _float_or_none(row.get("entropy_distance")),
                    "smiles": row.get("smiles", ""),
                    "inchikey": row.get("inchikey", ""),
                    "structure_key": row.get("structure_key", ""),
                    "adduct": row.get("adduct", ""),
                    "predicted_spectrum_count": _int_or_none(
                        row.get("predicted_spectrum_count")
                    ),
                    "predicted_peaks": [],
                }
            )
    candidates.sort(key=lambda item: item["rank"])

    by_candidate = {item["candidate_id"]: item for item in candidates}
    if predicted_path.exists() and by_candidate:
        grouped: dict[str, list[dict[str, Any]]] = {
            candidate_id: [] for candidate_id in by_candidate
        }
        with predicted_path.open() as fp:
            reader = csv.DictReader(fp)
            for row in reader:
                candidate_id = row.get("candidate_id")
                if candidate_id not in grouped:
                    continue
                mz = _float_or_none(row.get("mz"))
                intensity = _float_or_none(row.get("intensity"))
                if mz is None or intensity is None:
                    continue
                grouped[candidate_id].append(
                    {
                        "mz": mz,
                        "intensity": intensity,
                        "collision_energy_ev": _float_or_none(
                            row.get("collision_energy_ev")
                        ),
                        "collision_label": row.get("collision_label", ""),
                        "frag_id": row.get("frag_id", ""),
                    }
                )
        for candidate_id, peaks in grouped.items():
            top_peaks = sorted(peaks, key=lambda peak: peak["intensity"], reverse=True)[
                :MODEL_EVIDENCE_PEAKS_PER_CANDIDATE
            ]
            by_candidate[candidate_id]["predicted_peaks"] = sorted(
                top_peaks, key=lambda peak: peak["mz"]
            )

    formula_predictions: list[dict[str, Any]] = []
    if formulas_path.exists():
        with formulas_path.open() as fp:
            reader = csv.DictReader(fp)
            for row in reader:
                formula_predictions.append(
                    {
                        "source": row.get("source", ""),
                        "rank": _int_or_none(row.get("rank")),
                        "formula": row.get("formula", ""),
                        "adduct": row.get("adduct", ""),
                        "score": _float_or_none(row.get("score")),
                    }
                )

    return {
        "source": "iceberg",
        "enabled": True,
        "candidate_count": len(candidates),
        "top_n": MODEL_EVIDENCE_TOP_N,
        "predicted_peaks_per_candidate": MODEL_EVIDENCE_PEAKS_PER_CANDIDATE,
        "candidates": candidates,
        "formula_predictions": formula_predictions[:10],
    }


def _read_model_evidence_summary(case_path: Path) -> dict[str, Any] | None:
    if not ENABLE_MODEL_EVIDENCE:
        return None

    candidates_path = case_path / "iceberg_candidates.csv"
    formulas_path = case_path / "formula_predictions.csv"
    if not candidates_path.exists():
        return None

    top_candidate = None
    with candidates_path.open() as fp:
        reader = csv.DictReader(fp)
        for row in reader:
            top_candidate = {
                "candidate_id": row.get("candidate_id", ""),
                "rank": _int_or_none(row.get("rank")),
                "entropy_distance": _float_or_none(row.get("entropy_distance")),
                "smiles": row.get("smiles", ""),
                "inchikey": row.get("inchikey", ""),
                "adduct": row.get("adduct", ""),
            }
            break

    top_formula = None
    if formulas_path.exists():
        with formulas_path.open() as fp:
            reader = csv.DictReader(fp)
            for row in reader:
                top_formula = {
                    "rank": _int_or_none(row.get("rank")),
                    "formula": row.get("formula", ""),
                    "adduct": row.get("adduct", ""),
                    "score": _float_or_none(row.get("score")),
                    "source": row.get("source", ""),
                }
                break

    if not top_candidate and not top_formula:
        return None

    return {
        "source": "iceberg",
        "top_candidate": top_candidate,
        "top_formula": top_formula,
    }


def _float_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _read_annotation(case_id: str) -> dict[str, Any] | None:
    path = _annotation_path(case_id)
    if not path.exists():
        return None
    return _read_json(path)


def _case_status(case_id: str) -> str:
    annotation = _read_annotation(case_id)
    if not annotation:
        return "not_started"
    return annotation.get("status") or "in_progress"


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as fp:
        json.dump(payload, fp, indent=2, sort_keys=True)
        fp.write("\n")
        tmp_name = fp.name
    Path(tmp_name).replace(path)


@lru_cache(maxsize=4096)
def _render_structure_svg(smiles: str, width: int, height: int) -> str:
    if not RDKIT_AVAILABLE:
        abort(503, "RDKit is not installed")
    if len(smiles) > 2000:
        abort(400, "SMILES is too long")

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        abort(400, "invalid SMILES")
    rdDepictor.Compute2DCoords(mol)

    drawer = rdMolDraw2D.MolDraw2DSVG(width, height)
    opts = drawer.drawOptions()
    opts.clearBackground = False
    opts.padding = 0.06
    drawer.DrawMolecule(mol)
    drawer.FinishDrawing()
    svg = drawer.GetDrawingText()
    return svg.replace("svg:", "")


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/structure.svg")
def api_structure_svg():
    smiles = request.args.get("smiles", "").strip()
    if not smiles:
        abort(400, "missing smiles")
    width = min(max(_int_or_none(request.args.get("w")) or 220, 80), 640)
    height = min(max(_int_or_none(request.args.get("h")) or 150, 60), 480)
    svg = _render_structure_svg(smiles, width, height)
    return Response(svg, mimetype="image/svg+xml")


@app.get("/api/config")
def api_config():
    return jsonify(
        {
            "case_dir": str(CASE_DIR),
            "annotation_dir": str(ANNOTATION_DIR),
            "mode": "assisted_with_model_evidence"
            if ENABLE_MODEL_EVIDENCE
            else "blind_manual_raw_spectra_only",
            "model_evidence_enabled": ENABLE_MODEL_EVIDENCE,
        }
    )


@app.get("/api/cases")
def api_cases():
    if not CASE_DIR.exists():
        abort(500, f"case dir does not exist: {CASE_DIR}")
    cases = []
    for path in sorted(CASE_DIR.iterdir()):
        if not path.is_dir():
            continue
        if not (path / "experimental_spectra_long.csv").exists():
            continue
        case_id = path.name
        peak_count = 0
        spectrum_count = 0
        meta_path = path / "metadata.json"
        meta = _read_json(meta_path) if meta_path.exists() else {"case_id": case_id}
        try:
            spectra = _read_spectra(path)
            spectrum_count = len(spectra)
            peak_count = sum(len(spec["peaks"]) for spec in spectra)
        except Exception:
            pass
        annotation = _read_annotation(case_id)
        final_structure = annotation.get("final_structure", {}) if annotation else {}
        cases.append(
            {
                "case_id": case_id,
                "status": (annotation.get("status") if annotation else None)
                or "not_started",
                "final_confidence": final_structure.get("confidence", ""),
                "spectrum_count": spectrum_count,
                "peak_count": peak_count,
                "feature": _public_feature_metadata(meta),
                "model_evidence_available": (path / "iceberg_candidates.csv").exists(),
                "model_evidence_summary": _read_model_evidence_summary(path),
            }
        )
    return jsonify({"cases": cases})


@app.get("/api/cases/<case_id>")
def api_case(case_id: str):
    path = _case_path(case_id)
    meta_path = path / "metadata.json"
    meta = _read_json(meta_path) if meta_path.exists() else {"case_id": case_id}
    return jsonify(
        {
            "case_id": case_id,
            "feature": _public_feature_metadata(meta),
            "spectra": _read_spectra(path),
            "annotation": _read_annotation(case_id),
            "model_evidence": _read_model_evidence(path),
        }
    )


@app.post("/api/cases/<case_id>/annotation")
def api_save_annotation(case_id: str):
    _case_path(case_id)
    payload = request.get_json(force=True, silent=False)
    if not isinstance(payload, dict):
        abort(400, "expected JSON object")

    now = datetime.now(timezone.utc).isoformat()
    annotation = {
        "case_id": case_id,
        "updated_at": now,
        "annotator": str(payload.get("annotator", "")).strip(),
        "status": payload.get("status") or "in_progress",
        "final_structure": payload.get("final_structure") or {},
        "global_notes": str(payload.get("global_notes", "")).strip(),
        "peak_assignments": payload.get("peak_assignments") or [],
        "schema_version": 1,
    }
    existing = _read_annotation(case_id)
    if existing and existing.get("created_at"):
        annotation["created_at"] = existing["created_at"]
    else:
        annotation["created_at"] = now

    _write_json_atomic(_annotation_path(case_id), annotation)
    return jsonify({"ok": True, "annotation": annotation})


@app.get("/api/export/annotations.json")
def api_export_annotations():
    annotations = []
    for path in sorted(ANNOTATION_DIR.glob("*.json")):
        annotations.append(_read_json(path))
    return jsonify({"annotations": annotations})


@app.get("/api/export/final_structures.csv")
def api_export_final_structures():
    rows = []
    for path in sorted(ANNOTATION_DIR.glob("*.json")):
        ann = _read_json(path)
        final = ann.get("final_structure", {})
        rows.append(
            {
                "case_id": ann.get("case_id", ""),
                "status": ann.get("status", ""),
                "annotator": ann.get("annotator", ""),
                "smiles": final.get("smiles", ""),
                "inchi": final.get("inchi", ""),
                "inchikey": final.get("inchikey", ""),
                "formula": final.get("formula", ""),
                "adduct": final.get("adduct", ""),
                "confidence": final.get("confidence", ""),
                "updated_at": ann.get("updated_at", ""),
            }
        )

    from io import StringIO

    buf = StringIO()
    fieldnames = [
        "case_id",
        "status",
        "annotator",
        "smiles",
        "inchi",
        "inchikey",
        "formula",
        "adduct",
        "confidence",
        "updated_at",
    ]
    writer = csv.DictWriter(buf, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
    return app.response_class(buf.getvalue(), mimetype="text/csv")


if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "").lower() in {"1", "true", "yes"}
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "7861")), debug=debug)
