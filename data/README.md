# Interaction data

The production file `interactions.json` contains five documented medicine
pairs, all taken from one US FDA-listed ibuprofen label on DailyMed. The table
has **not** been reviewed by a pharmacist:

- `meta.reviewed_by_pharmacist` must remain `false`;
- `meta.last_reviewed` must remain `null`.

The listed pairs are ibuprofène with aspirine, furosémide, lithium,
méthotrexate, and warfarine. These entries are source documentation only; they
are not individualized treatment instructions.

The interface labels every alert with the source and publication date and
states that pharmacist review has not happened. `avoid`, `caution`, and
`monitor` are editorial display categories, not a clinical severity scale or
an individualized recommendation.

Each pair includes:

- `a` and `b`: the exact generic names documented by the source;
- `severity`: `avoid`, `caution`, or `monitor`;
- `summary_en` and `summary_fr`: sourced descriptions, each limited to 1000
  characters;
- optional `summary_fon_human`: a separate explanation written by a Fon
  speaker; it is never overwritten by machine translation;
- `source`: title, HTTP(S) URL, access date, display name, and publication date.

Names match by exact normalized name: letter case, accents, and repeated
whitespace are ignored. Pair order does not matter. Brand names and English
translations of the French generic names are not recognized unless a sourced
alias is explicitly added. An unmatched name or pair remains undocumented; it
must never be treated as safe.

Aliases require `brand`, `generic`, and a similarly sourced `source` object.
Only sourced aliases are applied.

Tests use synthetic names and sources in
`tests/fixtures/interactions.json`; never copy those fixtures into production.
