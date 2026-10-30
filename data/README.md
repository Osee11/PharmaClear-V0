# Interaction table

The production file `interactions.json` starts empty intentionally. Do not add a
pair or alias from memory. Each entry must have a source title, HTTP(S) URL, and
access date, and must be reviewed by a pharmacist before a pair is enabled.

Pair entries require:

- `a` and `b`: generic names, written once per unordered pair
- `severity`: `avoid`, `caution`, or `monitor`
- `summary_en` and `summary_fr`: reviewed descriptions; each is limited to 1000
  characters
- `source`: `{ "title": "...", "url": "https://...", "accessed": "YYYY-MM-DD" }`

Aliases require `brand`, `generic`, and a similarly sourced `source` object.
Only sourced aliases are applied. Names are compared case-insensitively after
Unicode NFD accent removal and whitespace normalization.

Tests use only synthetic names and sources in
`tests/fixtures/interactions.json`; never copy those fixtures into production.
An unknown pair is returned as `not_verified`, not as safe.
