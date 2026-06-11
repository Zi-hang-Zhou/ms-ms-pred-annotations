# Blind MS/MS Structure Annotation Platform

This is a small local web app for manual structural elucidation annotation.

It is designed for the workflow where annotators receive only the raw test-case
spectra and basic acquisition metadata. It intentionally does **not** show
candidate SMILES, ground truth, ICEBERG predictions, model ranks, or any other
answer-like information.

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
`--keep-formula`.(IF your mgf has it in your metadata)


## Outputs

One JSON file is saved per case:

```text
annotations/<case_id>.json
```

Exports:

- `http://127.0.0.1:7861/api/export/final_structures.csv`
- `http://127.0.0.1:7861/api/export/annotations.json`

## Blindness Boundary

The `/api/cases/<case_id>` endpoint returns only:

- public feature metadata
- experimental spectra peak lists
- the current saved manual annotation, if any


