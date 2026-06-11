#!/usr/bin/env python3
"""Blind manual MS/MS structure annotation platform.

The app intentionally exposes only raw experimental spectra and basic feature
metadata. Candidate structures, ground truth fields, and model predictions are
not returned by any API endpoint.
"""
from __future__ import annotations

import csv
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, abort, jsonify, render_template, request


APP_DIR = Path(__file__).resolve().parent
DEFAULT_CASE_DIR = APP_DIR / "example_cases"
CASE_DIR = Path(os.environ.get("ANNOTATION_CASE_DIR", DEFAULT_CASE_DIR)).resolve()
ANNOTATION_DIR = Path(
    os.environ.get("ANNOTATION_OUTPUT_DIR", APP_DIR / "annotations")
).resolve()
ANNOTATION_DIR.mkdir(parents=True, exist_ok=True)

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


def _float_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
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


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/config")
def api_config():
    return jsonify(
        {
            "case_dir": str(CASE_DIR),
            "annotation_dir": str(ANNOTATION_DIR),
            "mode": "blind_manual_raw_spectra_only",
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
        try:
            spectra = _read_spectra(path)
            spectrum_count = len(spectra)
            peak_count = sum(len(spec["peaks"]) for spec in spectra)
        except Exception:
            pass
        cases.append(
            {
                "case_id": case_id,
                "status": _case_status(case_id),
                "spectrum_count": spectrum_count,
                "peak_count": peak_count,
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
