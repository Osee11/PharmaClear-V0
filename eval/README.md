# OCR evaluation

`ground-truth.json` is the expected transcription for fictional test images.
Each case has a unique `id`, an `image` filename relative to the local,
Git-ignored `eval/images/` directory, and an `expected` array of medicine names.
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
node eval/run-eval.js --format csv
node eval/run-eval.js --format markdown
```

The Markdown report lists false-confident cases first, then shows expected,
detected, uncertain, and verdict for each case. Its totals count correct,
uncertain, false-confident, and missed names and report mean model time. A
sample result is not a measure of clinical reliability.
