'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addFonSummaries,
  checkDrugInteractions,
  createInteractionChecker,
} = require('../interactions');
const fixture = require('./fixtures/interactions.json');

const fixtureChecker = createInteractionChecker(fixture);

test('unknown pairs are explicitly unverified in production data', async () => {
  const result = await checkDrugInteractions([
    { name: 'TEST-ONLY-ALPHA' },
    { name: 'TEST-ONLY-BETA' },
  ]);

  assert.equal(result.status, 'not_verified');
  assert.deepEqual(result.checks, [{
    status: 'not_verified',
    drug_a: 'TEST-ONLY-ALPHA',
    drug_b: 'TEST-ONLY-BETA',
  }]);
});

test('a single medicine is not reported as interaction-free', async () => {
  const result = await checkDrugInteractions([{ name: 'TEST-ONLY-ALPHA' }]);

  assert.equal(result.status, 'not_verified');
  assert.deepEqual(result.checks, []);
});

test('fixture pair lookup ignores case and diacritics', async () => {
  const result = await fixtureChecker.checkDrugInteraction(
    'Epreuve Temoin A',
    'substance epreuve b',
  );

  assert.equal(result.status, 'verified');
  assert.equal(result.summary_en, 'TEST ONLY: synthetic fixture summary.');
});

test('pair matching is independent of input order', async () => {
  const forward = await fixtureChecker.checkDrugInteraction(
    'Épreuve Témoin A',
    'Substance Épreuve B',
  );
  const reverse = await fixtureChecker.checkDrugInteraction(
    'Substance Épreuve B',
    'Épreuve Témoin A',
  );

  assert.deepEqual(reverse, forward);
});

test('names normalizing to the same value are ignored', async () => {
  const result = await fixtureChecker.checkDrugInteractions([
    { name: 'Épreuve Témoin A' },
    { name: 'Epreuve temoin a' },
  ]);

  assert.equal(result.status, 'not_verified');
  assert.deepEqual(result.checks, []);
});

test('a brand alias is used only when its source is present', async () => {
  const result = await fixtureChecker.checkDrugInteraction(
    'TEST BRAND ALPHA',
    'Substance Épreuve B',
  );

  assert.equal(result.status, 'verified');
  assert.equal(result.drug_a, 'Épreuve Témoin A');
});

test('Fon translation is requested only for verified interactions', async () => {
  let translated = null;
  const input = [
    { status: 'not_verified', drug_a: 'TEST-ONLY-ALPHA', drug_b: 'TEST-ONLY-BETA' },
    await fixtureChecker.checkDrugInteraction('Épreuve Témoin A', 'Substance Épreuve B'),
  ];
  const result = await addFonSummaries(input, async (summary) => {
    translated = summary;
    return 'TEST ONLY: traduction synthétique.';
  });

  assert.equal(translated, 'TEST ONLY: synthetic fixture summary.');
  assert.equal(result[0].summary_fon, undefined);
  assert.equal(result[1].summary_fon, 'TEST ONLY: traduction synthétique.');
});

test('failed Fon translation leaves the verified source summaries intact and reports status', async () => {
  const interaction = await fixtureChecker.checkDrugInteraction(
    'Épreuve Témoin A',
    'Substance Épreuve B',
  );
  const errors = [];
  const [result] = await addFonSummaries([interaction], async () => {
    throw new Error('synthetic translation failure');
  }, (error) => errors.push(error.message));

  assert.equal(result.summary_en, interaction.summary_en);
  assert.equal(result.summary_fr, interaction.summary_fr);
  assert.equal(result.summary_fon_status, 'unavailable');
  assert.deepEqual(errors, ['synthetic translation failure']);
});

test('invalid input and missing required summaries are rejected', async () => {
  await assert.rejects(() => checkDrugInteractions(null), TypeError);
  await assert.rejects(
    () => fixtureChecker.checkDrugInteraction({}, 'Substance Épreuve B'),
    TypeError,
  );
  assert.throws(() => createInteractionChecker({
    ...fixture,
    pairs: [{ ...fixture.pairs[0], summary_fr: '' }],
  }), /summary_en\/summary_fr/);
});
