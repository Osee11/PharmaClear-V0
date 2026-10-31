# OCR evaluation

`ground-truth.json` is the expected transcription for fabricated test images.
Each case has a unique `id`, an `image` filename relative to the local,
Git-ignored `eval/images/` directory, and an `expected` array of medicine names.
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

The report counts correct, uncertain, false-with-confidence, and missed names,
and reports the mean model time. A sample result is not a measure of clinical
reliability.
