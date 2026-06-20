#!/usr/bin/env python3
"""Merge ICEBERG raw prediction output into annotation-platform case dirs.

This script assumes you already have blind case directories containing:

  <case_id>/metadata.json
  <case_id>/experimental_spectra_long.csv

It adds assisted-mode evidence files from an ICEBERG prediction HDF5 plus the
labels TSV that was used to run ICEBERG:

  iceberg_candidates.csv
  iceberg_predicted_spectra_long.csv
  iceberg_collision_matching.csv
  formula_predictions.csv

The HDF5 alone is usually not enough: candidate SMILES/adduct/formula are in
the labels TSV, while the experimental spectrum is in the base case directory.
"""
from __future__ import annotations

import argparse
import ast
import csv
import json
import math
import shutil
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import h5py
import numpy as np

try:
    from rdkit import Chem
    from rdkit import RDLogger

    RDLogger.DisableLog("rdApp.*")
except Exception:  # pragma: no cover - dependency error is handled at runtime
    Chem = None


def read_labels(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as fp:
        sample = fp.read(4096)
        fp.seek(0)
        dialect = csv.Sniffer().sniff(sample, delimiters="\t,")
        return list(csv.DictReader(fp, dialect=dialect))


def case_dirs(base: Path) -> dict[str, Path]:
    if (base / "metadata.json").exists():
        return {base.name: base}
    out = {}
    for child in sorted(base.iterdir()):
        if child.is_dir() and (child / "metadata.json").exists():
            out[child.name] = child
    return out


def group_labels(
    rows: list[dict[str, str]],
    case_id: str | None,
    case_id_column: str,
) -> dict[str, list[dict[str, str]]]:
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        cid = case_id or row.get(case_id_column, "").strip()
        if not cid:
            raise SystemExit(
                "Labels do not contain a case id. Pass --case-id for a single-case "
                "ICEBERG run, or pass --case-id-column for multi-case labels."
            )
        grouped[cid].append(row)
    return dict(grouped)


def parse_collision_values(value: str) -> list[float]:
    if not value:
        return []
    try:
        parsed = ast.literal_eval(value)
    except Exception:
        try:
            return [float(value)]
        except ValueError:
            return []
    if isinstance(parsed, (list, tuple)):
        vals = []
        for item in parsed:
            try:
                vals.append(float(item))
            except (TypeError, ValueError):
                pass
        return vals
    try:
        return [float(parsed)]
    except (TypeError, ValueError):
        return []


def safe_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def inchikey_from_smiles(smiles: str) -> str:
    if not smiles or Chem is None:
        return ""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return ""
    return Chem.MolToInchiKey(mol)


def read_experimental_peaks(case_dir: Path) -> list[tuple[float, float]]:
    peaks = []
    with (case_dir / "experimental_spectra_long.csv").open(newline="") as fp:
        reader = csv.DictReader(fp)
        for row in reader:
            mz = safe_float(row.get("mz"))
            inten = safe_float(row.get("intensity_display") or row.get("intensity_raw"))
            if mz is None or inten is None:
                continue
            peaks.append((mz, inten))
    return peaks


def infer_collision_from_case(case_dir: Path) -> float | None:
    with (case_dir / "experimental_spectra_long.csv").open(newline="") as fp:
        reader = csv.DictReader(fp)
        for row in reader:
            return safe_float(row.get("collision_energy_ev")) or safe_float(
                row.get("collision_value_nce")
            )
    return None


def entropy(vec: np.ndarray) -> float:
    vals = vec[vec > 0]
    if vals.size == 0:
        return 0.0
    return float(-np.sum(vals * np.log(vals)))


def bin_peaks(peaks: list[tuple[float, float]], num_bins: int, upper_limit: float) -> np.ndarray:
    vec = np.zeros(num_bins, dtype=np.float64)
    if not peaks:
        return vec
    bin_width = upper_limit / num_bins
    for mz, inten in peaks:
        if mz < 0 or mz >= upper_limit or inten <= 0:
            continue
        idx = min(int(mz / bin_width), num_bins - 1)
        vec[idx] += inten
    total = vec.sum()
    if total > 0:
        vec /= total
    return vec


def entropy_distance(
    exp_peaks: list[tuple[float, float]],
    pred_peaks: list[tuple[float, float, float | None, str]],
    num_bins: int,
    upper_limit: float,
) -> float:
    exp_vec = bin_peaks(exp_peaks, num_bins, upper_limit)
    pred_vec = bin_peaks([(mz, inten) for mz, inten, _, _ in pred_peaks], num_bins, upper_limit)
    if exp_vec.sum() <= 0 or pred_vec.sum() <= 0:
        return 1.0
    midpoint = 0.5 * (exp_vec + pred_vec)
    return entropy(midpoint) - 0.5 * (entropy(exp_vec) + entropy(pred_vec))


def parse_ce_from_path(path: str) -> float | None:
    for part in path.split("/"):
        if "collision" not in part.lower():
            continue
        token = part.lower().replace("collision", "").strip()
        try:
            return float(token)
        except ValueError:
            return None
    return None


def hdf5_candidate_peaks(
    h5: h5py.File,
    candidate_name: str,
    spec_x: str,
    num_bins: int,
    upper_limit: float,
) -> list[tuple[float, float, float | None, str]]:
    root_name = f"pred_{candidate_name}"
    if root_name not in h5 and candidate_name in h5:
        root_name = candidate_name
    if root_name not in h5:
        return []

    peaks: list[tuple[float, float, float | None, str]] = []
    root = h5[root_name]
    bin_width = upper_limit / num_bins

    def visitor(name: str, obj: Any) -> None:
        if not isinstance(obj, h5py.Dataset):
            return
        if obj.name.endswith("/spec"):
            arr = obj[()]
            if arr.ndim != 2 or arr.shape[1] < 2:
                return
            ce = parse_ce_from_path(obj.name)
            use_binned = spec_x == "binned" or (
                spec_x == "auto" and "binned" in Path(h5.filename).name
            )
            for frag_id, (x_val, inten, *_) in enumerate(arr):
                if inten <= 0:
                    continue
                mz = float(x_val) * bin_width if use_binned else float(x_val)
                peaks.append((mz, float(inten), ce, str(frag_id)))
            return

        if obj.name.endswith("/f"):
            arr = obj[()]
            if arr.ndim != 2 or arr.shape[1] < 2:
                return
            ce = parse_ce_from_path(obj.name)
            for frag_id, row in enumerate(arr):
                mz, inten = float(row[0]), float(row[1])
                if inten <= 0:
                    continue
                peaks.append((mz, inten, ce, str(frag_id)))

    root.visititems(visitor)
    return peaks


def write_formula_predictions(
    case_dir: Path,
    case_id: str,
    rows: list[dict[str, str]],
    formula_col: str,
    adduct_col: str,
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    seen = set()
    formulas = []
    for row in rows:
        formula = row.get(formula_col, "").strip()
        adduct = row.get(adduct_col, "").strip()
        if not formula or (formula, adduct) in seen:
            continue
        seen.add((formula, adduct))
        formulas.append((formula, adduct))
    with (case_dir / "formula_predictions.csv").open("w", newline="") as fp:
        writer = csv.writer(fp)
        writer.writerow(["case_id", "source", "rank", "formula", "adduct", "score", "created_at"])
        for rank, (formula, adduct) in enumerate(formulas, 1):
            writer.writerow([case_id, "iceberg_labels", rank, formula, adduct, "", now])


def write_case_evidence(
    case_dir: Path,
    case_id: str,
    rows: list[dict[str, str]],
    h5: h5py.File,
    args: argparse.Namespace,
) -> int:
    exp_peaks = read_experimental_peaks(case_dir)
    scored = []
    by_candidate_peaks = {}
    for row in rows:
        candidate_name = row.get(args.candidate_id_column, "").strip()
        if not candidate_name:
            continue
        pred_peaks = hdf5_candidate_peaks(
            h5, candidate_name, args.spec_x, args.num_bins, args.upper_limit
        )
        by_candidate_peaks[candidate_name] = pred_peaks
        score = entropy_distance(exp_peaks, pred_peaks, args.num_bins, args.upper_limit)
        scored.append((score, candidate_name, row))

    scored.sort(key=lambda item: (math.inf if item[0] is None else item[0], item[1]))
    ranked = scored[: args.top_n]

    with (case_dir / "iceberg_candidates.csv").open("w", newline="") as fp:
        writer = csv.writer(fp)
        writer.writerow(
            [
                "case_id",
                "candidate_id",
                "rank",
                "entropy_distance",
                "smiles",
                "inchikey",
                "structure_key",
                "adduct",
                "predicted_spectrum_count",
            ]
        )
        for rank, (score, candidate_name, row) in enumerate(ranked, 1):
            smiles = row.get(args.smiles_column, "").strip()
            inchikey = row.get(args.inchikey_column, "").strip() if args.inchikey_column else ""
            if not inchikey:
                inchikey = inchikey_from_smiles(smiles)
            adduct = row.get(args.adduct_column, "").strip()
            writer.writerow(
                [
                    case_id,
                    f"candidate_{rank:03d}",
                    rank,
                    f"{score:.6f}",
                    smiles,
                    inchikey,
                    inchikey,
                    adduct,
                    1 if by_candidate_peaks.get(candidate_name) else 0,
                ]
            )

    with (case_dir / "iceberg_predicted_spectra_long.csv").open("w", newline="") as fp:
        writer = csv.writer(fp)
        writer.writerow(
            [
                "case_id",
                "candidate_id",
                "rank",
                "spectrum_id",
                "collision_energy_ev",
                "collision_label",
                "mz",
                "intensity",
                "frag_id",
            ]
        )
        for rank, (_, candidate_name, _) in enumerate(ranked, 1):
            for mz, inten, ce, frag_id in by_candidate_peaks.get(candidate_name, []):
                ce_label = "" if ce is None else f"{ce:g} eV"
                writer.writerow(
                    [
                        case_id,
                        f"candidate_{rank:03d}",
                        rank,
                        f"candidate_{rank:03d}_predicted_01",
                        "" if ce is None else f"{ce:.6g}",
                        ce_label,
                        f"{mz:.6f}",
                        f"{inten:.6f}",
                        frag_id,
                    ]
                )

    exp_ce = infer_collision_from_case(case_dir)
    pred_ces = sorted(
        {
            ce
            for _, candidate_name, _ in ranked
            for _, _, ce, _ in by_candidate_peaks.get(candidate_name, [])
            if ce is not None
        }
    )
    with (case_dir / "iceberg_collision_matching.csv").open("w", newline="") as fp:
        writer = csv.writer(fp)
        writer.writerow(
            [
                "case_id",
                "predicted_collision_energy_ev",
                "matched_experimental_collision_value_nce",
            ]
        )
        for ce in pred_ces or ([] if exp_ce is None else [exp_ce]):
            writer.writerow(
                [
                    case_id,
                    f"{ce:.6g}",
                    "" if exp_ce is None else f"{exp_ce:.6g}",
                ]
            )

    write_formula_predictions(case_dir, case_id, rows, args.formula_column, args.adduct_column)
    return len(ranked)


def copy_base_cases(base_cases: dict[str, Path], out_dir: Path, overwrite: bool) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    copied = {}
    for case_id, src in base_cases.items():
        dst = out_dir / case_id
        if dst.exists():
            if not overwrite:
                raise SystemExit(f"{dst} already exists. Pass --overwrite or choose a new --out.")
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        copied[case_id] = dst
    return copied


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pack ICEBERG HDF5 predictions into annotation case directories."
    )
    parser.add_argument("--base-cases", required=True, type=Path)
    parser.add_argument("--iceberg-hdf5", required=True, type=Path)
    parser.add_argument("--labels", required=True, type=Path, help="ICEBERG dataset-labels TSV/CSV")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--case-id", help="Use when the labels belong to one case")
    parser.add_argument("--case-id-column", default="case_id")
    parser.add_argument("--candidate-id-column", default="name")
    parser.add_argument("--smiles-column", default="smiles")
    parser.add_argument("--formula-column", default="formula")
    parser.add_argument("--adduct-column", default="ionization")
    parser.add_argument("--inchikey-column", default="inchikey")
    parser.add_argument("--top-n", type=int, default=20)
    parser.add_argument("--num-bins", type=int, default=15000)
    parser.add_argument("--upper-limit", type=float, default=1500.0)
    parser.add_argument(
        "--spec-x",
        choices=["auto", "mz", "binned"],
        default="auto",
        help="Interpret HDF5 /spec first column as m/z or bin index. Auto treats files named binned_* as bins.",
    )
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    base = case_dirs(args.base_cases)
    if not base:
        raise SystemExit(f"No case directories found under {args.base_cases}")
    grouped = group_labels(read_labels(args.labels), args.case_id, args.case_id_column)
    missing = sorted(set(grouped) - set(base))
    if missing:
        raise SystemExit(
            "Labels refer to cases that do not exist in --base-cases: "
            + ", ".join(missing[:10])
        )

    copied = copy_base_cases(base, args.out, args.overwrite)
    total = 0
    with h5py.File(args.iceberg_hdf5, "r") as h5:
        for case_id, rows in grouped.items():
            total += write_case_evidence(copied[case_id], case_id, rows, h5, args)

    print(f"Packed ICEBERG evidence for {len(grouped)} cases / {total} candidates -> {args.out}")


if __name__ == "__main__":
    main()
