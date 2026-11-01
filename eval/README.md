# OCR evaluation

`ground-truth.json` is the expected transcription for fictional test images.
Each case has a unique `id`, an `image` filename relative to the local,
Git-ignored `eval/images/` directory, and an `expected` array of medicine names.
Use `"expected": []` or `"labeled": false` for an image with no transcription
ground truth. Such cases are excluded from accuracy scoring and listed only in
the descriptive **Robustness (unlabeled images)** report section. Cases with
expected names are scored unless `"labeled": false` is explicitly set.
See `ground-truth.template.json` for three clearly marked TEST-ONLY examples.
Do not use real patient prescriptions or commit files from `eval/images/`.

Example format only (not an evaluation case):

```json
{
  "cases": [
    {
      "id": "fake-example",
      "image": "fake-example.png",
      "expected": ["EXAMPLE-ONLY-DRUG-A", "EXAMPLE-ONLY-DRUG-B"]
    }
  ]
}
```

## Run in five steps

1. Put each fictional prescription image in ignored `eval/images/` as `cas-01.jpg`, `cas-02.jpg`, and so on.
2. Fill `ground-truth.json` with each image filename and its exact expected medicine names.
3. Keep all image files synthetic; do not commit anything from `eval/images/`.
4. Run `node eval/run-eval.js` to call the configured model and generate `eval/results.md`.
5. Estimate about $0.02 per image; actual API cost can vary with model usage.

The checked-in case uses the synthetic sample image. To run it locally, copy the
public sample into the ignored evaluation-image directory:

```sh
mkdir -p eval/images
cp public/samples/sample-prescription.png eval/images/sample-ibuprofen-aspirin.png
node eval/run-eval.js
```

Select one case by its `id`, or print a CSV/Markdown report:

```sh
node eval/run-eval.js --only sample-ibuprofen-aspirin
node eval/run-eval.js --only sample-ibuprofen-aspirin --verbose
node eval/run-eval.js --only 01 --only 02 --only 04 --only 05 --verbose
node eval/run-eval.js --format csv
node eval/run-eval.js --format markdown
```

`--verbose` prints each expected name, verdict, returned `detected_drugs` and
`uncertain` names with confidence, plus API response completion/JSON diagnostics.
Set `MODEL_REASONING_EFFORT` to `low`, `medium`, or `high` (default `low`) and
`MODEL_MAX_OUTPUT_TOKENS` to a positive integer (default `4000`) to configure
the Meta Responses API request.

The Markdown report has separate **Accuracy** and **Robustness (unlabeled
images)** sections. Accuracy lists transcribed cases only and orders
false-confident cases first. Its summary gives the number of transcribed and
unlabeled cases and the expected-name denominator; strict and tolerant
correct-name ratios display the numerator and denominator (for example
`13/16`). Unlabeled cases report only descriptive counts of confident and
uncertain readings and status; they do not contribute to any score. Accuracy
shows separate **Strict** and **Tolerant** verdicts. Strict scoring requires an
exact match after accent, case, and whitespace normalization. Tolerant scoring
also accepts an expected name as a whole-word prefix of the detected name
(such as `Curacné` matching `Curacné G20`), or a Levenshtein distance of at
most 1 for 5–8-letter names and at most 2 for names longer than 8 letters.
Fuzzy matching is disabled for names shorter than 5 letters. Both modes show
their own correct, uncertain, false-confident, and missed totals; the existing
strict scoring rules remain unchanged. A sample result is not a measure of
clinical reliability.
