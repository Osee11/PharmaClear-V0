'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRANSCRIPTION_INSTRUCTIONS,
  TRANSCRIPTION_PROMPT,
} = require('../meta');

test('Meta transcription prompt requests only text visible on the prescription', () => {
  assert.match(TRANSCRIPTION_INSTRUCTIONS, /only job is to TRANSCRIBE what is written/i);
  assert.match(TRANSCRIPTION_PROMPT, /"name": string|null/);
  assert.match(TRANSCRIPTION_PROMPT, /"dosage": string|null/);
  assert.match(TRANSCRIPTION_PROMPT, /"frequency": string|null/);
  assert.match(TRANSCRIPTION_PROMPT, /"duration": string|null/);
  assert.match(TRANSCRIPTION_PROMPT, /Copy the drug name exactly as written/);
  assert.doesNotMatch(TRANSCRIPTION_PROMPT, /\b(interaction|severity|recommendation|advice)\b/i);
});

test('Meta module does not expose a generated Fon interaction-summary translator', () => {
  assert.equal(require('../meta').translateInteractionSummaryToFon, undefined);
});
