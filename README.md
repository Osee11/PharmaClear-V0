# PharmaClear

PharmaClear transcribes photographed prescriptions and keeps uncertain readings visible alongside sourced drug-label information.

## Try the demo

URL: `<DEPLOY_URL>` · Demo code: `<DEMO_CODE>`

1. Open the URL and enter the demo code.
2. Choose English, French, or Fon.
3. Select **Try a sample prescription** or take a photo.
4. Review the transcription, uncertain readings, and cited source information.

First load may take about a minute if the free server was asleep. When offline, a photo is queued on the device and analysis resumes when the network returns. Analysis itself requires a network connection.

The sample uses the fictional [prescription image](./public/samples/sample-prescription.png).

## What it does

- Transcribes medicine names and visible dosage instructions, displays the model's confidence, and separates uncertain names.
- Looks up medicine pairs in a deterministic, sourced reference table.
- Provides English, French, and Fon interface choices; queues photos for later upload while offline.
- Keeps the submitted photo available in the result view for enlargement, and offers a browser print dialog for saving a result as PDF.

## Hackathon scope

Before the hackathon (October 20, through commit `84d58ef`, tagged `pre-hackathon-mockup`), the repository contained a minimal skeleton: a 41-line Express server with a simulated pipeline using hard-coded medicine names, no AI call, and no real interaction check, plus a placeholder page.

Built during the hackathon from October 26 onward: the Meta Responses API integration (`muse-wonder-1.0`), the C relay and disk queue, the offline PWA, the sourced interaction table, an AI-suggested (unverified) interaction tier, the Fon interface and summaries, the evaluation harness and results, photo preview and zoom, PDF export, Docker and hosting setup, and the English README.

The initial plan (SAM 3.1 + Muse Spark) was replaced by a single vision-capable model, `muse-wonder-1.0`.

### Scope changes since the application

The application concept described a pipeline with SAM 3.1 segmentation, Llama 4, Fon voice output, an anti-counterfeit QR code, and WhatsApp delivery. During the hackathon, we built a narrower working version:

- One vision-capable model (`muse-wonder-1.0`) replaced the proposed SAM 3.1 and Llama 4 chain; it reads the prescription directly.
- Built: an offline photo queue, a C relay with a disk queue, a sourced interaction reference, an English/French/Fon interface, and an evaluation harness.
- Not built (future work): Fon voice output, QR verification, and WhatsApp delivery.

## How this was built

PharmaClear was designed, directed, and tested by Osée in Benin. AI tools were used under his direction. Meta AI was the first AI assistant used at the start of the project. GitHub Copilot Agent and Claude were used for architecture review, audits, and implementation of several critical parts of the project. All Fon-language text was written by the author, who is a Fon speaker. Test prescriptions were transcribed and checked by the author.

## Scope and safety

PharmaClear transcribes what is written, shows uncertainty, cites information from a documented source, and displays the interface in English, French, or Fon.

It does not generate medical advice, diagnose, recommend treatment or a dose, or evaluate a person. It is not a medical device or a substitute for reading the original prescription.

Reference information from a drug label. Not medical advice. Ask a pharmacist.

## Engineering highlights

- A confidence threshold of `0.7` separates readings shown as confident from uncertain readings.
- Interaction lookup uses a deterministic table and does not depend on the transcription model.
- The PWA keeps offline uploads in IndexedDB; the C relay has a disk-backed queue.
- The current evaluation reports 12/16 correct names in both strict and tolerant modes, with 3 uncertain, 0 false-confident, and 1 missed.
- The model reasoning effort can be set to `low`, `medium`, or `high`; the configured default is `low`. The checked-in evaluation report does not contain a comparable three-setting run, so no measured gain is claimed here.
- Node temporary uploads are removed after request handling; the C relay removes queued photos after receiving a result. The API rate limit defaults to 20 requests per minute per client IP.

## Results

The tables below reproduce the latest [evaluation report](./eval/results.md), including both comparison modes.

| Case | Expected | Detected | Uncertain | Strict | Tolerant |
|---|---|---|---|---|---|
| sample-ibuprofen-aspirin | Ibuprofène, Aspirine | Ibuprofène, Aspirine |  | CORRECT | CORRECT |
| 01 | Curacné, Azix, Aclin gel | Curacné, Azix, Aclin gel |  | CORRECT | CORRECT |
| 02 | Paracetamol, Fervex, Arzi | Paracetamol | Fervex, Angi | UNCERTAIN | UNCERTAIN |
| 03 | Antiangineux, Hypotenseur | Antiangineux, Hypotenseur |  | CORRECT | CORRECT |
| 04 | Urée, Glycerine, Acide lactique, Codexial Cold Cream | Urée, Acide lactique | Glycérine, Codexial Cold cream | UNCERTAIN | UNCERTAIN |
| 05 | Baume Saint Bernard, Niflugel | Baume Saint Bernard, Niflugel | Bandes Velpeau | CORRECT | CORRECT |

| Latest-run summary | Value |
|---|---:|
| Transcribed cases | 6 |
| Unlabeled cases | 9 |
| Expected names (denominator) | 16 |
| Strict correct | 12/16 (75.0%) |
| Tolerant correct | 12/16 (75.0%) |
| Uncertain | 3 |
| False-confident | 0 |
| Missed | 1 |
| Errors | 0 |
| Mean time | 6.6 s |

The latest run also included 9 unlabeled images; descriptively, it returned 8 names read with confidence and 22 uncertain names across those images. Those unlabeled-image counts are not accuracy scores.

Small sample; the model's self-reported confidence is not calibrated. Reproduce with `node eval/run-eval.js`.

## Architecture

```mermaid
flowchart LR
  PWA["Patient PWA<br/>IndexedDB offline queue"] -->|HTTPS upload| Node["Node / Express"]
  Node -->|queue and poll| Relay["C relay<br/>disk queue; results up to 24 h"]
  Relay -->|analysis request| Node
  Node -->|image transcription| Meta["Meta Responses API<br/>muse-wonder-1.0"]
  Meta -->|transcription| Node
  Node -->|result| Relay
  Relay -->|poll result| Node
  Node -->|result| PWA
  Table["Deterministic interaction table<br/>data/interactions.json"] --> Node
  Table -.-> Note["The model never decides interaction lookup"]
```

The C relay queues uploads and forwards them to Node for transcription. The interaction table is evaluated separately from the image transcription.

## Safety & privacy

- Node removes its temporary upload after request handling. The C relay removes the queued photo after a result is received; while processing is pending, the relay retains the queued file for retries. The browser's offline queue holds a photo until upload succeeds, and the result-view photo is kept only in memory while that view is open.
- Relay results are retained for up to 24 hours, then cleaned up.
- The five documented interaction pairs come from a [DailyMed ibuprofen label](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=a266a3c6-932f-476f-ae93-48a785c92286), revised October 2025. The table has not been reviewed by a pharmacist. Pairs absent from the source table are not evaluated.
- Severity labels (`avoid`, `caution`, and `monitor`) are documented editorial categories, not a clinically validated scale.
- Tests and the included sample use fictional prescription images; no real patient photos are included.
- Limits default to 20 requests per minute per client IP and 100 completed analyses per UTC day (`DAILY_ANALYSIS_LIMIT`). The quota counter is stored in `runtime/`; it resets if the host's ephemeral filesystem is replaced or the instance restarts.

## Languages

The interface defaults to English and also offers French and Fon. Fon interface text and the five documented-interaction summaries were written by a Fon speaker and are labelled **“Written by a Fon speaker.”** The application does not generate Fon interaction text with the model.

## Known limits

- Confidence is self-reported by the model and is not calibrated.
- Results varied between the two observed runs by one name out of 16.
- Evaluation uses a small sample: 6 transcribed prescriptions.
- The documented interaction table contains only 5 pairs and uses French generic names; brand names and English names are not recognized by the table.
- A pharmacist has not reviewed the table; severity labels are documented editorial choices.
- Difficult handwriting may be reported as uncertain rather than resolved.
- The free hosting tier sleeps after 15 minutes without traffic, may take about one minute to wake, and its daily counter resets when the instance restarts.
- The prototype has not been clinically validated.

## Run locally / Deploy

Requirements: Node.js 18+, npm, GCC, pthreads, and `curl`.

1. Copy `.env.example` to `.env`. Add `META_API_KEY` or `MODEL_API_KEY` locally only if using the live API. Do not commit `.env`.
2. From the project root, install dependencies and start Node:

   ```sh
   npm install
   npm run dev
   ```

3. In a second terminal, compile and start the C relay:

   ```sh
   cd serveur_c
   gcc -Wall -Wextra -O2 -pthread -o serveur serveur.c
   PHARMA_BIND=127.0.0.1 ./serveur
   ```

4. Open `http://localhost:3000`. Node proxies relay traffic to the C service on port 8080.

Without an API key the server runs in simulation mode; set `PHARMA_MOCK=1` to make that mode explicit. See [DEPLOY.md](./DEPLOY.md) for container and hosting configuration. This project is distributed under the [MIT License](./LICENSE). No hosting provider or public demo URL is configured in this repository.

## Evaluation

Place fictional case images in the Git-ignored `eval/images/` directory, then run `node eval/run-eval.js`. The script writes the report to [`eval/results.md`](./eval/results.md). The indicative API cost is approximately $0.02 per image. See [eval/README.md](./eval/README.md) for the ground-truth format and options.
