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
  table. The table currently contains five pairs from one US FDA-listed
  ibuprofen drug label; it has not been reviewed by a pharmacist.
- Labels every pair without a table entry as undocumented. No alert is not proof
  of safety.
- Keeps a compressed photo in the phone's IndexedDB queue while offline and
  resumes upload when the connection returns or the app is reopened. Analysis
  itself requires a network connection.
- Deletes processed photos after the result is received and retains relay
  results for 24 hours. Pending files in the C relay's `queue/` are not
  automatically deleted.

The patient-facing interface is English by default, with English, French, and
Fon language choices. Unprovided Fon interface text falls back to English.
Fon explanations written by a speaker are shown only for documented alerts
and are labelled **“Written by a Fon speaker.”** Automatic Fon translation is
only a fallback, is labelled **“Machine translation, please verify,”** and can
be disabled with `FON_MT=0`.

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

The included image is a clearly marked fictional test, with only the names
“Ibuprofène” and “Aspirine”; it contains no patient details, dosage, or
treatment instructions. The real `muse-wonder-1.0` pipeline read both names and
matched the pair to the locally documented interaction table. The checked-in
sample result is the unedited response from the full pipeline. Opening the
sample in the app displays that saved result without calling Meta.

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
`pharmaclear-static-v7`.

## Documented interaction data

[`data/interactions.json`](./data/interactions.json) contains five pairs taken
from one US FDA-listed ibuprofen label on DailyMed. The table is explicitly
**not reviewed by a pharmacist** (`reviewed_by_pharmacist: false`,
`last_reviewed: null`). Every displayed alert identifies its source and
publication date and clearly states that it has not yet been reviewed by a
pharmacist.

The pairs are ibuprofène with aspirine, furosémide, lithium, méthotrexate, and
warfarine.

The `avoid`, `caution`, and `monitor` values are editorial display categories,
not a validated clinical severity scale. Pair matching uses exact generic
names after ignoring case, accents, and repeated whitespace; pair order does
not matter. Brand names and English translations of the French generic names
are not recognized. Names or pairs absent from the table remain undocumented;
they are never represented as safe. No aliases are currently configured.
See [`data/README.md`](./data/README.md) for the source and schema.

English and French summaries come from the source table. Speaker-written Fon
summaries use the distinct `summary_fon_human` field and are never overwritten.
When no human summary is present, automatic translation is used only if
`FON_MT` is not `0`; translation failures or disabled translation leave the
documented English/French summaries available. Test-only values are isolated
in [`tests/fixtures/interactions.json`](./tests/fixtures/interactions.json)
and must never be copied into production data.

## Reliability evaluation

`eval/ground-truth.json` contains one synthetic case with expected medicine
names. `eval/images/` is Git-ignored; copy the public synthetic sample there
before running:

```sh
mkdir -p eval/images
cp public/samples/sample-prescription.png eval/images/sample-ibuprofen-aspirin.png
node eval/run-eval.js
```

Filter by case ID or export the same report as CSV/Markdown:

```sh
node eval/run-eval.js --only sample-ibuprofen-aspirin
node eval/run-eval.js --format csv
node eval/run-eval.js --format markdown
```

### Results

| Evaluation set | Images | Correct names | Uncertain | False with confidence | Missed | Errors | Mean time |
|---|---:|---:|---:|---:|---:|---:|---:|
| Synthetic printed sample | 1 | 2 | 0 | 0 | 0 | 0 | 4.4 s |

This is the measured result of one clean, synthetic printed image—not an
estimate of accuracy on real, handwritten, or patient prescriptions.

### Known limits

| Limit | Current status |
|---|---|
| Interaction coverage | Five pairs from one US FDA-listed ibuprofen label; not reviewed by a pharmacist. |
| OCR reliability | Measured on 1 synthetic printed image only; no real-prescription accuracy claim. |
| Network | OCR analysis requires an online connection; offline photos wait locally for upload. |
| iOS background upload | Background Sync is not implemented; reopening the app may be required. |

See [`eval/README.md`](./eval/README.md) for the ground-truth format and
evaluation options.

## Access, quotas, and deployment

- `API_RATE_LIMIT` defaults to 20 requests per minute per client IP.
- `DAILY_ANALYSIS_LIMIT` defaults to 100 analyses per UTC day. Set it to `0`
  only to disable the cap. The counter is stored in the ignored
  `runtime/daily-analysis-usage.json` file so a Node restart does not reset it.
  Only a completed analysis consumes a slot; retryable failures, rejected API
  requests, and unusable model output refund the reserved slot.
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
For container deployment on Render, Railway, or a VPS, see
[`DEPLOY.md`](./DEPLOY.md).

## Tests

```sh
npm test
```

The tests cover evaluation scoring and exports, accent/case normalization,
pair ordering, duplicate names, sourced aliases, invalid entries, daily-quota
refunds, documented versus unreviewed table status, and Fon translation
provenance. Test fixtures use synthetic medicine names and contain no patient
information.
