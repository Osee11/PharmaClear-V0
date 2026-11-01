# Reliability evaluation

## Accuracy

Transcribed cases: 6; unlabeled cases: 9; expected names (scoring denominator): 16.

| Case | Expected | Detected | Uncertain | Strict | Tolerant |
|---|---|---|---|---|---|
| sample-ibuprofen-aspirin | Ibuprofène, Aspirine | Ibuprofène, Aspirine |  | CORRECT | CORRECT |
| 01 | Curacné, Azix, Aclin gel | Curacné, Azix, Aclin gel |  | CORRECT | CORRECT |
| 02 | Paracetamol, Fervex, Arzi | Paracetamol | Fervex, Angi | UNCERTAIN | UNCERTAIN |
| 03 | Antiangineux, Hypotenseur | Antiangineux, Hypotenseur |  | CORRECT | CORRECT |
| 04 | Urée, Glycerine, Acide lactique, Codexial Cold Cream | Urée, Acide lactique | Glycérine, Codexial Cold cream | UNCERTAIN | UNCERTAIN |
| 05 | Baume Saint Bernard, Niflugel | Baume Saint Bernard, Niflugel | Bandes Velpeau | CORRECT | CORRECT |

### Strict totals

- Correct: 12/16 expected names (75.0%)
- Uncertain: 3
- False-confident: 0
- Missed: 1
- Errors: 0
- Mean time: 6.6 s

### Tolerant totals

- Correct: 12/16 expected names (75.0%)
- Uncertain: 3
- False-confident: 0
- Missed: 1
- Tokens: input=13501 output=11589 reasoning=9206 total=25090

## Robustness (unlabeled images)

| Case | Confident names read | Uncertain names | Status |
|---|---:|---:|---|
| 06 | 0 | 3 | success |
| 07 | 0 | 5 | success |
| 08 | 0 | 3 | success |
| 09 | 0 | 1 | success |
| 10 | 1 | 1 | success |
| 11 | 0 | 5 | success |
| 12 | 0 | 0 | not_a_prescription |
| 13 | 6 | 0 | success |
| 14 | 1 | 4 | success |

Descriptive totals: unlabeled images=9; confident names read=8; uncertain names=22; errors=0.
