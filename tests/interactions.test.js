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
    review_status: 'unreviewed',
    drug_a: 'TEST-ONLY-ALPHA',
    drug_b: 'TEST-ONLY-BETA',
  }]);
});

test('a single medicine is not reported as interaction-free', async () => {
  const result = await checkDrugInteractions([{ name: 'TEST-ONLY-ALPHA' }]);

  assert.equal(result.status, 'not_verified');
  assert.deepEqual(result.checks, []);
});

test('a production table pair is returned as unreviewed without startup failure', async () => {
  const { addFonSummaries, checkDrugInteraction } = require('../interactions');
  const result = await checkDrugInteraction('Ibuprofène', 'Aspirine');

  assert.equal(result.status, 'verified');
  assert.equal(result.review_status, 'unreviewed');
  assert.equal(result.source.display_name_en, 'FDA drug label');
  const [withFon] = await addFonSummaries([result], async () => {
    assert.fail('A speaker-written summary must not call automatic translation');
  });
  assert.equal(withFon.summary_fon_human, result.summary_fon_human);
  assert.equal(withFon.summary_fon, undefined);
});

test('review status is calculated from the table metadata', async () => {
  const reviewedChecker = createInteractionChecker({
    ...fixture,
    meta: { ...fixture.meta, reviewed_by_pharmacist: true },
  });
  const result = await reviewedChecker.checkDrugInteraction(
    'Épreuve Témoin A',
    'Substance Épreuve B',
  );

  assert.equal(result.review_status, 'reviewed');
});

test('an empty interaction table is valid and starts without an error', async () => {
  const emptyChecker = createInteractionChecker({
    ...fixture,
    aliases: [],
    pairs: [],
  });
  const result = await emptyChecker.checkDrugInteraction('TEST-ONLY-A', 'TEST-ONLY-B');

  assert.equal(result.status, 'not_verified');
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

test('human Fon summaries skip automatic translation', async () => {
  const interaction = {
    ...(await fixtureChecker.checkDrugInteraction(
      'Épreuve Témoin A',
      'Substance Épreuve B',
    )),
    summary_fon_human: 'TEST ONLY: speaker-written fixture.',
  };
  let translationCalled = false;
  const [result] = await addFonSummaries([interaction], async () => {
    translationCalled = true;
    return 'TEST ONLY: automatic fixture.';
  });

  assert.equal(translationCalled, false);
  assert.equal(result.summary_fon_human, 'TEST ONLY: speaker-written fixture.');
  assert.equal(result.summary_fon, undefined);
});

test('automatic Fon translation can be disabled', async () => {
  const previous = process.env.FON_MT;
  process.env.FON_MT = '0';
  let translationCalled = false;
  const interaction = await fixtureChecker.checkDrugInteraction(
    'Épreuve Témoin A',
    'Substance Épreuve B',
  );
  try {
    const [result] = await addFonSummaries([interaction], async () => {
      translationCalled = true;
      return 'TEST ONLY: automatic fixture.';
    });
    assert.equal(translationCalled, false);
    assert.equal(result.summary_fon_status, 'disabled');
  } finally {
    if (previous === undefined) delete process.env.FON_MT;
    else process.env.FON_MT = previous;
  }
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
