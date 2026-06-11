#!/usr/bin/env python3
"""Convert an MGF file into blind annotation-platform case directories.

The output format is:

cases_out/
  <case_id>/
    metadata.json
    experimental_spectra_long.csv

This script does not write candidate structures, ground truth structures, or
model predictions. If the source MGF contains structure-like metadata such as
SMILES or InChIKey, those fields are intentionally omitted from metadata.json.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path
from typing import Any


STRUCTURE_LIKE_KEYS = {
    "SMILES",
    "INCHI",
    "INCHIKEY",
    "INCHI_AUX",
    "CANONICAL_SMILES",
    "STRUCTURE",
}

PUBLIC_META_KEYS = [
    "PEPMASS",
    "PRECURSOR_MZ",
    "PARENT_MASS",
    "CHARGE",
    "ADDUCT",
    "IONMODE",
    "INSTRUMENT_TYPE",
    "FRAGMENTATION_METHOD",
    "COLLISION_ENERGY",
    "RETENTION_TIME",
    "SPECTYPE",
    "MS_LEVEL",
    "ISOLATION_WINDOW",
    "IMS_TYPE",
    "ACQUISITION",
    "PRECURSOR_PURITY",
    "QUALITY_CHIMERIC",
    "QUALITY_EXPLAINED_INTENSITY",
    "QUALITY_EXPLAINED_SIGNALS",
    "USI",
    "SCANS",
    "FOLD",
]


def parse_mgf(path: Path):
    meta: dict[str, str] | None = None
    peaks: list[tuple[float, float]] = []
    with path.open(errors="replace") as fp:
        for raw in fp:
            line = raw.strip()
            if not line:
                continue
            if line == "BEGIN IONS":
                meta = {}
                peaks = []
                continue
            if line == "END IONS":
                if meta is not None:
                    yield meta, peaks
                meta = None
                peaks = []
                continue
            if meta is None:
                continue
            if "=" in line and not _looks_like_peak(line):
                key, value = line.split("=", 1)
                meta[key.strip().upper()] = value.strip()
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            try:
                peaks.append((float(parts[0]), float(parts[1])))
            except ValueError:
                continue


def _looks_like_peak(line: str) -> bool:
    first = line.split(maxsplit=1)[0]
    try:
        float(first)
        return True
    except ValueError:
        return False


def safe_case_id(raw_id: str, index: int, prefix: str) -> str:
    raw_id = raw_id.strip() if raw_id else ""
    if not raw_id:
        raw_id = f"{index:06d}"
    raw_id = re.sub(r"[^A-Za-z0-9_.:-]+", "_", raw_id)
    return f"{prefix}_{raw_id}" if prefix else raw_id


def float_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(str(value).split()[0])
    except ValueError:
        return None


def infer_collision_label(meta: dict[str, str]) -> str:
    ce = meta.get("COLLISION_ENERGY", "")
    if ce:
        return f"collision {ce}"
    return "collision unknown"


def write_case(
    out_dir: Path,
    case_id: str,
    meta: dict[str, str],
    peaks: list[tuple[float, float]],
    keep_formula: bool,
) -> None:
    case_dir = out_dir / case_id
    case_dir.mkdir(parents=True, exist_ok=True)

    precursor_mz = float_or_none(meta.get("PRECURSOR_MZ") or meta.get("PEPMASS"))
    retention_time = float_or_none(meta.get("RETENTION_TIME"))
    collision_energy = float_or_none(meta.get("COLLISION_ENERGY"))
    max_int = max((inten for _, inten in peaks), default=1.0) or 1.0
    collision_label = infer_collision_label(meta)

    feature: dict[str, Any] = {
        "precursor_mz": precursor_mz,
        "retention_time_min": retention_time,
        "method": meta.get("ACQUISITION") or "MGF import",
        "sample": meta.get("DESCRIPTION") or "",
        "instrument": meta.get("INSTRUMENT_TYPE") or "",
        "adduct": meta.get("ADDUCT") or "",
        "fragmentation_method": meta.get("FRAGMENTATION_METHOD") or "",
        "ion_mode": meta.get("IONMODE") or "",
    }
    if keep_formula and meta.get("FORMULA"):
        feature["formula"] = meta["FORMULA"]
    feature = {k: v for k, v in feature.items() if v not in (None, "")}

    public_meta = {
        key.lower(): meta[key]
        for key in PUBLIC_META_KEYS
        if key in meta and key not in STRUCTURE_LIKE_KEYS
    }
    if not keep_formula:
        public_meta.pop("formula", None)

    metadata = {
        "case_id": case_id,
        "source": "mgf_import",
        "feature": feature,
        "experimental_spectra_summary": [
            {
                "spectrum_id": "spectrum_01",
                "spectrum_type": "ms2",
                "collision_label": collision_label,
                "collision_value_nce": collision_energy,
                "collision_energy_ev": None,
                "peak_count": len(peaks),
            }
        ],
        "mgf_public_metadata": public_meta,
        "blinding": {
            "candidate_structures_removed": True,
            "ground_truth_structures_removed": True,
            "structure_like_mgf_fields_omitted": sorted(k for k in STRUCTURE_LIKE_KEYS if k in meta),
        },
    }

    with (case_dir / "metadata.json").open("w") as fp:
        json.dump(metadata, fp, indent=2, sort_keys=True)
        fp.write("\n")

    with (case_dir / "experimental_spectra_long.csv").open("w", newline="") as fp:
        writer = csv.writer(fp)
        writer.writerow(
            [
                "case_id",
                "spectrum_id",
                "spectrum_type",
                "collision_label",
                "collision_value_nce",
                "collision_energy_ev",
                "peak_count",
                "mz",
                "intensity_raw",
                "intensity_display",
            ]
        )
        for mz, inten in peaks:
            writer.writerow(
                [
                    case_id,
                    "spectrum_01",
                    "ms2",
                    collision_label,
                    "" if collision_energy is None else collision_energy,
                    "",
                    len(peaks),
                    f"{mz:.6f}",
                    f"{inten:.6f}",
                    f"{inten / max_int:.6f}",
                ]
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mgf", required=True, type=Path, help="Input MGF file")
    parser.add_argument("--out", required=True, type=Path, help="Output case directory")
    parser.add_argument("--prefix", default="mgf", help="Prefix for generated case ids")
    parser.add_argument("--limit", type=int, default=0, help="Only convert first N spectra")
    parser.add_argument(
        "--keep-formula",
        action="store_true",
        help="Keep FORMULA in feature metadata if present. Default omits formula for blind annotation.",
    )
    parser.add_argument(
        "--id-field",
        default="IDENTIFIER",
        help="MGF metadata field to use as case id, falling back to FEATURE_ID then index",
    )
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    count = 0
    for index, (meta, peaks) in enumerate(parse_mgf(args.mgf), start=1):
        if not peaks:
            continue
        raw_id = meta.get(args.id_field.upper()) or meta.get("FEATURE_ID") or f"{index:06d}"
        case_id = safe_case_id(raw_id, index, args.prefix)
        write_case(args.out, case_id, meta, peaks, keep_formula=args.keep_formula)
        count += 1
        if args.limit and count >= args.limit:
            break
    print(f"Converted {count} spectra -> {args.out}")


if __name__ == "__main__":
    main()
