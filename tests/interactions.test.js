'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addFonSummaries,
  checkDrugInteractions,
  createInteractionChecker,
  selectConfidentDrugs,
  validateAiInteractionSuggestions,
} = require('../interactions');
const {
  addAiInteractionSuggestions,
  addAiInteractionSuggestionsWhenEnabled,
  aiInteractionsEnabled,
} = require('../ai-interactions');
const fixture = require('./fixtures/interactions.json');

const fixtureChecker = createInteractionChecker(fixture);

test('AI interaction suggestions require explicit opt-in', () => {
  assert.equal(aiInteractionsEnabled({}), false);
  assert.equal(aiInteractionsEnabled({ AI_INTERACTIONS: '0' }), false);
  assert.equal(aiInteractionsEnabled({ AI_INTERACTIONS: '1' }), true);
});

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

test('production reference summaries are attributed facts rather than instructions', () => {
  const data = require('../data/interactions.json');
  assert.equal(data.pairs.length, 5);
  for (const pair of data.pairs) {
    assert.match(pair.summary_en, /^The US FDA drug label /);
    assert.match(pair.summary_fr, /^L’étiquette du médicament publiée par la FDA américaine /);
    assert.doesNotMatch(pair.summary_en, /\b(avoid|take|do not take|should|must)\b/i);
    assert.doesNotMatch(pair.summary_fr, /\b(éviter|prenez|prendre|doit|devrait)\b/i);
  }
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

test('AI interaction suggestions accept only strict JSON pairs from the submitted names', () => {
  const valid = JSON.stringify({
    pairs: [{
      a: 'TEST-ONLY-ALPHA',
      b: 'TEST-ONLY-BETA',
      severity: 'caution',
      summary_en: 'TEST ONLY: Synthetic summary.',
      summary_fr: 'TEST UNIQUEMENT : résumé synthétique.',
    }],
  });
  const [suggestion] = validateAiInteractionSuggestions(
    valid,
    ['TEST-ONLY-ALPHA', 'TEST-ONLY-BETA'],
  );
  assert.equal(suggestion.status, 'ai_suggested');
  assert.equal(suggestion.source, 'model');
  assert.equal(suggestion.review_status, 'ai_unverified');
  assert.equal(suggestion.source_url, undefined);
  assert.equal(validateAiInteractionSuggestions(
    valid.replace('TEST-ONLY-BETA', 'OUTSIDE-LIST'),
    ['TEST-ONLY-ALPHA', 'TEST-ONLY-BETA'],
  ).length, 0);
  assert.deepEqual(validateAiInteractionSuggestions(`${valid} trailing`, [
    'TEST-ONLY-ALPHA',
    'TEST-ONLY-BETA',
  ]), []);
});

test('AI interaction validation rejects unsafe phrasing, excessive summaries, and invalid schemas', () => {
  const makeResponse = (summary) => JSON.stringify({
    pairs: [{
      a: 'TEST-ONLY-ALPHA',
      b: 'TEST-ONLY-BETA',
      severity: 'monitor',
      summary_en: summary,
      summary_fr: 'TEST UNIQUEMENT.',
    }],
  });
  const names = ['TEST-ONLY-ALPHA', 'TEST-ONLY-BETA'];
  assert.deepEqual(validateAiInteractionSuggestions(
    makeResponse('This combination is safe.'),
    names,
  ), []);
  assert.deepEqual(validateAiInteractionSuggestions(
    makeResponse('First. Second. Third.'),
    names,
  ), []);
  const invalidEnum = JSON.parse(makeResponse('TEST ONLY.').replace('"monitor"', '"critical"'));
  assert.deepEqual(validateAiInteractionSuggestions(JSON.stringify(invalidEnum), names), []);
});

test('AI suggestions are deduplicated against documented pairs and duplicate model pairs', () => {
  const duplicate = {
    a: 'TEST-ONLY-ALPHA',
    b: 'TEST-ONLY-BETA',
    severity: 'caution',
    summary_en: 'TEST ONLY: Summary.',
    summary_fr: 'TEST UNIQUEMENT : résumé.',
  };
  const documented = [{
    status: 'verified',
    drug_a: 'TEST-ONLY-ALPHA',
    drug_b: 'TEST-ONLY-BETA',
  }];
  const result = validateAiInteractionSuggestions(JSON.stringify({
    pairs: [duplicate, { ...duplicate, a: 'TEST-ONLY-BETA', b: 'TEST-ONLY-ALPHA' }],
  }), ['TEST-ONLY-ALPHA', 'TEST-ONLY-BETA'], documented);
  assert.deepEqual(result, []);
});

test('only confident detected medicines are selected, sorted by confidence, and capped at eight', () => {
  const drugs = Array.from({ length: 10 }, (_, index) => ({
    name: `TEST-ONLY-${index}`,
    confidence: 0.7 + index / 100,
  }));
  const selected = selectConfidentDrugs(drugs);
  assert.equal(selected.length, 8);
  assert.equal(selected[0].name, 'TEST-ONLY-9');
  assert.equal(selectConfidentDrugs([{ name: 'TEST-ONLY-LOW', confidence: 0.69 }]).length, 0);
});

test('AI failure or invalid JSON leaves level-one interactions unchanged', async () => {
  const levelOne = [{ status: 'not_verified', drug_a: 'TEST-ONLY-ALPHA', drug_b: 'TEST-ONLY-BETA' }];
  let calls = 0;
  const result = await addAiInteractionSuggestions({
    detectedDrugs: [
      { name: 'TEST-ONLY-ALPHA', confidence: 0.9 },
      { name: 'TEST-ONLY-BETA', confidence: 0.8 },
    ],
    documentedInteractions: levelOne,
    dailyLimiter: { consume: async () => ({ allowed: true }) },
    suggest: async () => { calls++; return 'not-json'; },
    onError: assert.fail,
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, []);
  assert.deepEqual(levelOne, [{
    status: 'not_verified',
    drug_a: 'TEST-ONLY-ALPHA',
    drug_b: 'TEST-ONLY-BETA',
  }]);
});

test('AI interaction suggestions remain disabled without calling the model or quota', async () => {
  let modelCalls = 0;
  let quotaCalls = 0;
  const result = await addAiInteractionSuggestionsWhenEnabled(false, {
    detectedDrugs: [
      { name: 'TEST-ONLY-ALPHA', confidence: 0.9 },
      { name: 'TEST-ONLY-BETA', confidence: 0.8 },
    ],
    documentedInteractions: [],
    dailyLimiter: { consume: async () => { quotaCalls++; return { allowed: true }; } },
    suggest: async () => { modelCalls++; return '{"pairs":[]}'; },
  });
  assert.deepEqual(result, []);
  assert.equal(modelCalls, 0);
  assert.equal(quotaCalls, 0);
});

test('fewer than two confident medicines skip the AI call and the separate quota', async () => {
  let calls = 0;
  const result = await addAiInteractionSuggestions({
    detectedDrugs: [{ name: 'TEST-ONLY-ALPHA', confidence: 0.9 }],
    documentedInteractions: [],
    dailyLimiter: { consume: async () => { calls++; return { allowed: true }; } },
    suggest: async () => { calls++; return '{"pairs":[]}'; },
  });
  assert.deepEqual(result, []);
  assert.equal(calls, 0);
});

test('mock mode returns one explicitly simulated suggestion without calling the model', async () => {
  let modelCalls = 0;
  let quotaCalls = 0;
  const result = await addAiInteractionSuggestions({
    detectedDrugs: [
      { name: 'TEST-ONLY-ALPHA', confidence: 0.9 },
      { name: 'TEST-ONLY-BETA', confidence: 0.8 },
    ],
    documentedInteractions: [],
    dailyLimiter: { consume: async () => { quotaCalls++; return { allowed: true }; } },
    suggest: async () => { modelCalls++; return '{"pairs":[]}'; },
    mock: true,
  });
  assert.equal(modelCalls, 0);
  assert.equal(quotaCalls, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].simulated, true);
  assert.equal(result[0].review_status, 'ai_unverified');
  assert.equal(result[0].source, 'model');
  assert.equal(result[0].source_url, undefined);
});

test('AI daily limit blocks suggestions without modifying documented results', async () => {
  let modelCalls = 0;
  const levelOne = [{ status: 'verified', drug_a: 'TEST-ONLY-A', drug_b: 'TEST-ONLY-B' }];
  const result = await addAiInteractionSuggestions({
    detectedDrugs: [
      { name: 'TEST-ONLY-A', confidence: 0.9 },
      { name: 'TEST-ONLY-B', confidence: 0.8 },
      { name: 'TEST-ONLY-C', confidence: 0.7 },
    ],
    documentedInteractions: levelOne,
    dailyLimiter: { consume: async () => ({ allowed: false }) },
    suggest: async () => { modelCalls++; return '{"pairs":[]}'; },
  });
  assert.deepEqual(result, []);
  assert.equal(modelCalls, 0);
  assert.deepEqual(levelOne, [{ status: 'verified', drug_a: 'TEST-ONLY-A', drug_b: 'TEST-ONLY-B' }]);
});

test('AI suggestions skip pairs documented under canonical names', async () => {
  let quotaCalls = 0;
  const result = await addAiInteractionSuggestions({
    detectedDrugs: [
      { name: 'TEST-ONLY-BRAND-A', confidence: 0.9 },
      { name: 'TEST-ONLY-BRAND-B', confidence: 0.8 },
    ],
    documentedInteractions: [],
    documentedPairChecker: async () => ({
      status: 'verified',
      drug_a: 'TEST-ONLY-GENERIC-A',
      drug_b: 'TEST-ONLY-GENERIC-B',
    }),
    dailyLimiter: { consume: async () => { quotaCalls++; return { allowed: true }; } },
    suggest: async () => { assert.fail('Covered pairs must not be sent to the model'); },
  });
  assert.deepEqual(result, []);
  assert.equal(quotaCalls, 0);
});
