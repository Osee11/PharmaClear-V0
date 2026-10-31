# PharmaClear

PharmaClear is a prototype that transcribes prescription images and makes
uncertainty visible. It does not prescribe, diagnose, or establish that a
medicine combination is safe.

> **Prototype, not clinically validated.** Always compare every reading with
> the original prescription and ask a pharmacist when anything is unclear.

**Demo:** Not publicly deployed yet; no public demo URL is configured.

## What it does

- Separates confident transcriptions from uncertain or unreadable text.
- Checks medicine pairs only against a locally maintained, sourced interaction
  table. The production table is currently empty.
- Labels every pair without a table entry as unverified. No alert is not proof
  of safety.
- Keeps a compressed photo in the phone's IndexedDB queue while offline and
  resumes upload when the connection returns or the app is reopened. Analysis
  itself requires a network connection.
- Deletes processed photos after the result is received and retains relay
  results for 24 hours. Pending files in the C relay's `queue/` are not
  automatically deleted.

The patient-facing interface is English by default, with English, French, and
Fon language choices. Unprovided Fon interface text falls back to English.
Machine-generated Fon interaction translations are shown only for verified
alerts and are labelled **“Machine translation, please verify.”**

## Architecture

```text
Patient PWA
  ├─ IndexedDB photo queue when offline
  └─ HTTPS → Node.js API / same-origin relay proxy
                 ├─ per-IP request limit and daily analysis cap
                 ├─ C relay → disk queue → Node transcription
                 └─ Meta Responses API (transcription only)

Pharmacy counter → local C relay → Node.js → Meta Responses API
```

The Meta model transcribes the image; it is not the authority for interactions.
The model configured and tested in this repository is `muse-wonder-1.0` at
`https://api.meta.ai/v1/responses`. The sample button loads a synthetic
precomputed result and makes no API call.

## Local setup (about 5 minutes)

Requirements: Node.js 18+, npm, GCC, pthreads, and `curl`.

1. Copy `.env.example` to `.env`. Add `META_API_KEY` or `MODEL_API_KEY` only
   locally if you want to call the real API. Never commit `.env`.
2. From the project root:

   ```sh
   npm install
   npm run dev
   ```

3. In a second terminal:

   ```sh
   cd serveur_c
   gcc -Wall -Wextra -O2 -pthread -o serveur serveur.c
   PHARMA_BIND=127.0.0.1 ./serveur
   ```

4. Open `http://localhost:3000`. Node proxies relay traffic to the C service on
   port 8080.

Without an API key the server runs in simulation mode; set `PHARMA_MOCK=1` to
make that mode explicit. Simulation values use `TEST-ONLY` labels and are never
presented as a reading of the uploaded image.

For real API tests, use synthetic images only:

```sh
node lire.js public/samples/sample-prescription.png
```

The included sample is a synthetic prescription-style document. The real model
classified it as `not_a_prescription` with `image_quality: good`; this smoke
test confirms API access and response parsing, **not** prescription OCR
accuracy. The sample button displays that saved result without calling Meta.

## Patient and pharmacy-counter modes

- **Patient:** use the HTTPS Node page. Offline photos remain on the phone until
  upload succeeds; the page resumes on the `online` event or when reopened.
  Background Sync is not implemented, and iOS may require reopening the app.
- **Pharmacy counter:** the C relay accepts a photo, queues it locally, forwards
  it to Node, and serves the result. It handles one client at a time. Bind it
  to a trusted local interface and do not expose it directly to the public
  internet.

The PWA caches its shell and synthetic sample. Core page, script, style, and
translation requests use network-first caching, with cache fallback only when
the network request fails. The cache is versioned as
`pharmaclear-static-v6`.

## Verified interaction data

[`data/interactions.json`](./data/interactions.json) has no pairs or aliases by
default. Do not add entries from memory. Each pair requires:

- generic names `a` and `b`, and a severity (`avoid`, `caution`, or `monitor`);
- non-empty `summary_en` and `summary_fr`;
- a source title, HTTP(S) URL, and `accessed` date;
- pharmacist review before the production table can contain entries.

Names are matched after case folding, whitespace normalization, and NFD accent
removal. Pair order is irrelevant; a name that normalizes to itself is ignored.
Brand-to-generic aliases are applied only when the alias has its own source.
See [`data/README.md`](./data/README.md) for the format. Test-only values are
isolated in [`tests/fixtures/interactions.json`](./tests/fixtures/interactions.json)
and must never be copied into production data.

For a verified pair, English and French summaries come from the table. Fon is
translated from `summary_en` only for that verified alert, and the UI marks it
as machine translation requiring review. Translation failure leaves the
verified English/French summaries visible and reports that Fon is unavailable.
There are currently no verified alerts or Fon translations to demonstrate.

## Reliability evaluation

`eval/ground-truth.json` starts with an empty `cases` list. Add only fabricated
prescription images under `eval/images/` and record their expected medicine
names before running:

```json
{
  "cases": [
    {
      "image": "example.png",
      "expected": ["EXAMPLE-TEST-NAME"]
    }
  ]
}
```

Then run:

```sh
node eval/run-eval.js
```

The report includes correct, uncertain, false-with-confidence, missed names,
ambiguous cases for manual review, errors, and mean time. Image files under
`eval/images/` are ignored by Git. **No evaluation cases have been supplied, so
there is no measured OCR accuracy or false-confident rate yet.**

The API smoke test on the included synthetic image returned:

```json
{
  "status": "not_a_prescription",
  "image_quality": "good",
  "detected_drugs": [],
  "uncertain": [],
  "model": "muse-wonder-1.0"
}
```

This is not a measurement of handwritten-prescription performance.

## Access, quotas, and deployment

- `API_RATE_LIMIT` defaults to 20 requests per minute per client IP.
- `DAILY_ANALYSIS_LIMIT` defaults to 100 analyses per UTC day. Set it to `0`
  only to disable the cap. The counter is stored in the ignored
  `runtime/daily-analysis-usage.json` file so a Node restart does not reset it.
- `DEMO_ACCESS_CODE` is optional. When configured, the page asks for it and
  sends it in a request header; it is kept only for the browser session, not in
  the URL.
- `INTERNAL_RELAY_TOKEN` in Node must match `PHARMA_NODE_TOKEN` in the C relay.
  C sends it only on its server-to-server Node analysis request. A valid token
  bypasses the internal request's per-IP quota; patient uploads to
  `/relay/upload` remain rate-limited. Use a random 16–128 character
  URL-safe value and never send it to the browser.
- `RELAY_TOKEN` in Node and `PHARMA_TOKEN` in C are a separate Node-to-C relay
  credential. They are not interchangeable with the internal Node token.
- Set both `TLS_CERT_FILE` and `TLS_KEY_FILE` to enable direct HTTPS. A reverse
  proxy may terminate TLS instead. Configure `TRUST_PROXY` only with the
  address or range of the trusted proxy that connects to Node; do not trust
  arbitrary forwarded headers.

No hosting provider, TLS certificate, production secret, or public demo URL is
configured in this repository. Do not share a public link until HTTPS, access
code, relay binding, secrets, and the limits have been configured and tested.

## Tests

```sh
npm test
```

The tests cover evaluation scoring, accent/case normalization, pair ordering,
duplicate names, sourced aliases, invalid entries, and translation only for
verified pairs. The sample and test fixtures contain no real medicine names or
patient information.
