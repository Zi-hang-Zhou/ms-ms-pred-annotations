# Blind MS/MS Structure Annotation Platform

This is a small local web app for manual structural elucidation annotation.

The app can run in an assisted evidence mode where ICEBERG candidates and
predicted spectra are shown as a starting point for manual review. Use this mode
only when model evidence is allowed for the annotation task.

The assisted mode is organized like a lightweight project dashboard: it shows a
progress snapshot, an RT vs precursor m/z feature map, the feature catalog, and
per-case ICEBERG evidence before the annotator saves a final manual structure.

## What Annotators Can Enter

For each case, annotators can save:

- final structure SMILES
- formula, adduct, InChI, InChIKey
- confidence and reasoning notes
- per-peak assignments:
  - precursor / isotope / fragment / neutral loss / adduct-related / noise / ambiguous
  - fragment structure note or fragment SMILES
  - fragment formula
  - neutral loss
  - theoretical m/z
  - confidence
  - evidence note

## Install

```bash
cd ms-ms-pred-annotations
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Collaborator Quick Start With Provided ICEBERG Assets

Use this workflow when the project owner provides a zipped assisted-case bundle,
for example `assisted_cases.zip`. This bundle should already contain one folder
per test case, with raw spectra plus ICEBERG starting-point evidence.

First clone and install the app:

```bash
git clone https://github.com/Zi-hang-Zhou/ms-ms-pred-annotations.git
cd ms-ms-pred-annotations
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Put the provided asset under `data/` and unzip it:

```bash
mkdir -p data
unzip /path/to/assisted_cases.zip -d data/
```

After unzipping, the case directory should look like this:

```text
data/assisted_cases/
  case_001/
    metadata.json
    experimental_spectra_long.csv
    iceberg_candidates.csv
    iceberg_predicted_spectra_long.csv
    formula_predictions.csv
  case_002/
    ...
```

Start the local annotation app:

```bash
ANNOTATION_CASE_DIR=data/assisted_cases \
ANNOTATION_OUTPUT_DIR=annotations_collaborator \
ANNOTATION_ENABLE_MODEL_EVIDENCE=1 \
PORT=7861 \
python app.py
```

Open:

```text
http://127.0.0.1:7861
```

The annotator should now see the raw MS/MS spectrum, ICEBERG candidate
structures, candidate SMILES, formula predictions, and predicted peak evidence.
Click **Fill final structure** to copy the selected ICEBERG candidate into the
manual final-structure fields, then edit or replace it as needed.

Click **Save** after each case. Saved annotations are written locally to:

```text
annotations_collaborator/<case_id>.json
```

Export final results while the app is still running:

```text
http://127.0.0.1:7861/api/export/final_structures.csv
http://127.0.0.1:7861/api/export/annotations.json
```


## Run With the Included Demo Case

```bash
python app.py
```

Open:

```text
http://127.0.0.1:7861
```

The default case directory is:

```text
example_cases
```

The default annotation output directory is:

```text
annotations
```

The included demo case also contains small synthetic ICEBERG-style evidence
files, so you can preview assisted mode without any private dataset:

```bash
ANNOTATION_ENABLE_MODEL_EVIDENCE=1 python app.py
```

In assisted demo mode, open `http://127.0.0.1:7861` and select
`case_demo_001`. The Final Structure panel will show demo candidate structures,
candidate SMILES, formula predictions, and predicted peak evidence.

## Run With Your Own Cases

Point `ANNOTATION_CASE_DIR` to a directory containing one subdirectory per case:

```bash
ANNOTATION_CASE_DIR=/path/to/cases \
ANNOTATION_OUTPUT_DIR=/path/to/annotations \
PORT=7861 \
python app.py
```

Example case layout:

```text
cases/
  case_001/
    metadata.json
    experimental_spectra_long.csv
  case_002/
    metadata.json
    experimental_spectra_long.csv
```

`metadata.json` should contain only public/blind metadata, for example:

```json
{
  "case_id": "case_001",
  "feature": {
    "precursor_mz": 181.0713,
    "retention_time_min": 3.42,
    "method": "LC-MS/MS",
    "instrument": "QTOF",
    "adduct": "[M+H]+",
    "ion_mode": "positive"
  }
}
```

`experimental_spectra_long.csv` must contain at least:

```text
case_id,spectrum_id,spectrum_type,collision_label,collision_value_nce,collision_energy_ev,peak_count,mz,intensity_raw,intensity_display
```

Rows are one peak per line. Multiple spectra for the same case are represented
with different `spectrum_id` values.

## Convert an MGF File

If your spectra are in MGF format, convert them into case directories first:

```bash
python scripts/convert_mgf_to_cases.py \
  --mgf /path/to/spectra.mgf \
  --out converted_cases \
  --prefix msnlib
```

Then run the app on the converted cases:

```bash
ANNOTATION_CASE_DIR=converted_cases python app.py
```

Or specify a custom annotation output directory:

```bash
ANNOTATION_CASE_DIR=converted_cases \
ANNOTATION_OUTPUT_DIR=annotations_msnlib \
python app.py
```

For a quick test:

```bash
python scripts/convert_mgf_to_cases.py \
  --mgf /path/to/spectra.mgf \
  --out converted_cases_smoke \
  --prefix msnlib \
  --limit 5
```

By default, the converter omits structure-like MGF fields such as `SMILES`,
`INCHI`, `INCHIKEY`, and `INCHI_AUX`. It also omits `FORMULA` unless you pass
`--keep-formula`, if `FORMULA` is present in the MGF metadata.

## Build Assisted Cases From Raw Files

Use this workflow only if the provided asset is not already an assisted-case
bundle. For example, the asset may contain:

```text
spectra.mgf
cand_labels.tsv
iceberg_out/binned_preds.hdf5
```

Convert the raw spectra first:

```bash
python scripts/convert_mgf_to_cases.py \
  --mgf data/raw_iceberg/spectra.mgf \
  --out data/base_cases \
  --prefix case
```

Then pack the ICEBERG output into annotation cases:

```bash
python scripts/pack_iceberg_outputs_to_cases.py \
  --base-cases data/base_cases \
  --iceberg-hdf5 data/raw_iceberg/iceberg_out/binned_preds.hdf5 \
  --labels data/raw_iceberg/cand_labels.tsv \
  --out data/assisted_cases \
  --case-id-column case_id \
  --top-n 20 \
  --overwrite
```

Then start the app with:

```bash
ANNOTATION_CASE_DIR=data/assisted_cases \
ANNOTATION_OUTPUT_DIR=annotations_collaborator \
ANNOTATION_ENABLE_MODEL_EVIDENCE=1 \
python app.py
```

## Pack Raw ICEBERG Output

If you have raw ICEBERG prediction output, first make blind case directories
from the experimental spectra, then merge the ICEBERG evidence into those cases.

The packer needs three inputs:

- base case directories containing `metadata.json` and `experimental_spectra_long.csv`
- the ICEBERG prediction HDF5, usually `preds.hdf5` or `binned_preds.hdf5`
- the ICEBERG `dataset-labels` TSV/CSV that was used for prediction, containing candidate SMILES

The HDF5 alone is not enough because it usually contains predicted spectra but
not the original experimental spectra or complete candidate metadata.

Single-case example:

```bash
python scripts/pack_iceberg_outputs_to_cases.py \
  --base-cases converted_cases/case_001 \
  --iceberg-hdf5 /path/to/iceberg_out/binned_preds.hdf5 \
  --labels /path/to/cand_labels.tsv \
  --out assisted_cases \
  --case-id case_001 \
  --top-n 20 \
  --overwrite
```

For multi-case labels, include a `case_id` column in the labels file, or pass
the column name:

```bash
python scripts/pack_iceberg_outputs_to_cases.py \
  --base-cases converted_cases \
  --iceberg-hdf5 /path/to/iceberg_out/binned_preds.hdf5 \
  --labels /path/to/cand_labels_with_case_id.tsv \
  --case-id-column case_id \
  --out assisted_cases \
  --top-n 20
```

The script writes:

```text
iceberg_candidates.csv
iceberg_predicted_spectra_long.csv
iceberg_collision_matching.csv
formula_predictions.csv
```

Then run the app on the packed cases:

```bash
ANNOTATION_CASE_DIR=assisted_cases \
ANNOTATION_ENABLE_MODEL_EVIDENCE=1 \
python app.py
```

## Run With ICEBERG Starting Points

If your case directories are ICEBERG bundles containing:

```text
iceberg_candidates.csv
iceberg_predicted_spectra_long.csv
formula_predictions.csv
```

you can show ICEBERG top candidates and predicted peaks in the UI:

```bash
ANNOTATION_CASE_DIR=/home/zihang/ms-pred/pipeline/bundles/msnlib_strict_100_paper \
ANNOTATION_OUTPUT_DIR=annotations_msnlib_iceberg \
ANNOTATION_ENABLE_MODEL_EVIDENCE=1 \
python app.py
```

Optional limits:

```bash
ANNOTATION_MODEL_EVIDENCE_TOP_N=20
ANNOTATION_MODEL_EVIDENCE_PEAKS_PER_CANDIDATE=12
```

In this mode, the Final Structure panel includes an "ICEBERG Starting Point"
section. Each ICEBERG candidate is shown with a RDKit-rendered 2D structure,
its SMILES, rank, entropy distance, and predicted peak evidence. Select a
candidate and click "Fill final structure" to fill the manual final-structure
fields with its SMILES, adduct, InChIKey, and a short note. This does not copy
anything to the system clipboard.

The UI does not generate or upload these candidates. They are loaded from the
ICEBERG output files already present in `ANNOTATION_CASE_DIR`. A fresh GitHub
clone will not automatically show top-20 candidates unless you provide those
ICEBERG bundle files and run with `ANNOTATION_ENABLE_MODEL_EVIDENCE=1`.

The case catalog also shows the top formula and ICEBERG rank-1 structure summary
for each feature, and the top overview panel tracks annotation progress and
available model evidence.

## Outputs

When an annotator clicks **Save**, one JSON file is saved per case under the
annotation output directory:

```text
annotations/<case_id>.json
```

If you run with a custom output directory, for example:

```bash
ANNOTATION_CASE_DIR=converted_cases \
ANNOTATION_OUTPUT_DIR=annotations_msnlib \
python app.py
```

then saved annotations are written to:

```text
annotations_msnlib/<case_id>.json
```

Export endpoints are available only while `python app.py` is still running:

- `http://127.0.0.1:7861/api/export/final_structures.csv`
- `http://127.0.0.1:7861/api/export/annotations.json`

Open these URLs in a browser to view or download the exported CSV/JSON

These endpoints summarize the saved local annotation JSON files. They do not
upload data anywhere.

## Blindness Boundary

In default blind mode, the `/api/cases/<case_id>` endpoint returns only:

- public feature metadata
- experimental spectra peak lists
- the current saved manual annotation, if any

It does not return candidate structures, ground truth structures, model scores,
or predicted spectra. Do not include those fields in `metadata.json` if the
deployment is intended to be blind.

When `ANNOTATION_ENABLE_MODEL_EVIDENCE=1`, the endpoint also returns
`model_evidence` parsed from ICEBERG files in each case directory. Ground-truth
structures are still not intentionally returned.
