'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeName,
  scoreResult,
  tolerantNameMatches,
  scoreTolerantResult,
  isLabeledCase,
  scoreLabeledCase,
  parseArguments,
  validateCases,
  selectCases,
  formatCsv,
  formatMarkdown,
  formatVerboseRows,
  writeMarkdownReport,
} = require('../eval/run-eval');
const { getModelSettings } = require('../meta');

test('evaluation names ignore case, accents, and repeated whitespace', () => {
  assert.equal(normalizeName('  Épreuve   Témoin A '), 'epreuve temoin a');
  assert.notEqual(normalizeName('Niflu-gel'), normalizeName('Niflugel'));
});

test('tolerant name matching accepts prefix phrases and bounded spelling differences', () => {
  assert.equal(tolerantNameMatches('Curacné', 'Curacné G20'), true);
  assert.equal(tolerantNameMatches('Codexial', 'Codexial Cold Cream'), true);
  assert.equal(tolerantNameMatches('Fervix', 'Fervex'), true);
  assert.equal(tolerantNameMatches('Niflugel', 'Niflugel'), true);
});

test('tolerant matching does not fuzzy-match names shorter than five letters', () => {
  assert.equal(tolerantNameMatches('Urie', 'Urée'), false);
  assert.equal(tolerantNameMatches('Arzi', 'Arsi'), false);
});

test('evaluation separates correct, uncertain, and false confident readings', () => {
  const score = scoreResult(
    ['Épreuve Témoin A', 'Second Sample'],
    {
      image_quality: 'good',
      detected_drugs: [
        { name: 'Epreuve Temoin A', confidence: 0.95 },
        { name: 'Unexpected Sample', confidence: 0.9 },
      ],
      uncertain: [{ name: 'SECOND SAMPLE' }],
    },
  );

  assert.deepEqual(score, {
    correct: ['epreuve temoin a'],
    uncertain: ['second sample'],
    falseConfident: ['unexpected sample'],
    missed: [],
    ambiguous: [],
  });
});

test('unlabeled cases are excluded from both scoring modes', () => {
  const expectedEmpty = { id: 'case-unlabeled-empty', image: 'unlabeled.png', expected: [] };
  const explicitlyUnlabeled = {
    id: 'case-unlabeled-flag',
    image: 'unlabeled-flag.png',
    expected: ['TEST-ONLY-NAME'],
    labeled: false,
  };
  const result = {
    detected_drugs: [{ name: 'TEST-ONLY-NAME', confidence: 0.99 }],
    uncertain: [],
  };

  assert.equal(isLabeledCase(expectedEmpty), false);
  assert.equal(isLabeledCase(explicitlyUnlabeled), false);
  assert.equal(scoreLabeledCase(expectedEmpty, result), null);
  assert.equal(scoreLabeledCase(explicitlyUnlabeled, result), null);
  assert.deepEqual(scoreLabeledCase({
    id: 'case-labeled',
    image: 'labeled.png',
    expected: ['TEST-ONLY-NAME'],
  }, result).strict.correct, ['test-only-name']);
});

test('strict scoring remains unchanged while tolerant scoring allows the requested variants', () => {
  const expected = ['Curacné', 'Fervix', 'Urie'];
  const result = {
    detected_drugs: [
      { name: 'Curacné G20', confidence: 0.9 },
      { name: 'Fervex', confidence: 0.85 },
      { name: 'Urée', confidence: 0.9 },
    ],
    uncertain: [],
  };
  assert.deepEqual(scoreResult(expected, result), {
    correct: [],
    uncertain: [],
    falseConfident: ['curacne g20', 'fervex', 'uree'],
    missed: ['curacne', 'fervix', 'urie'],
    ambiguous: [],
  });
  assert.deepEqual(scoreTolerantResult(expected, result), {
    correct: ['curacne', 'fervix'],
    uncertain: [],
    falseConfident: ['uree'],
    missed: ['urie'],
    ambiguous: [],
  });
});

test('false-confident readings require confidence of at least 0.7', () => {
  const score = scoreResult(['TEST-ONLY-EXPECTED'], {
    detected_drugs: [
      { name: 'TEST-ONLY-WRONG-HIGH', confidence: 0.7 },
      { name: 'TEST-ONLY-WRONG-LOW', confidence: 0.69 },
    ],
  });
  assert.deepEqual(score.falseConfident, ['test-only-wrong-high']);
});

test('evaluation flags the same expected name as both confident and uncertain', () => {
  const score = scoreResult(
    ['Sample Alpha'],
    {
      image_quality: 'good',
      detected_drugs: [{ name: 'Sample Alpha' }],
      uncertain: [{ name: 'sample alpha' }],
    },
  );

  assert.deepEqual(score.ambiguous, ['sample alpha']);
});

test('evaluation options select a case and a report format', () => {
  assert.deepEqual(
    parseArguments(['--only', 'fake-one', '--format', 'csv']),
    { only: 'fake-one', format: 'csv', verbose: false },
  );
  assert.deepEqual(parseArguments(['--verbose']), { format: 'table', verbose: true });
  assert.deepEqual(
    parseArguments(['--only', 'fake-one', '--only', 'fake-two']),
    { only: ['fake-one', 'fake-two'], format: 'table', verbose: false },
  );
  assert.throws(() => parseArguments(['--only']), /requires a case id/);
  assert.throws(() => parseArguments(['--format', 'html']), /must be table, csv, or markdown/);
});

test('model reasoning and output-token settings are configurable and validated', () => {
  assert.deepEqual(getModelSettings({}), { effort: 'low', maxOutputTokens: 4000 });
  assert.deepEqual(getModelSettings({
    MODEL_REASONING_EFFORT: 'high',
    MODEL_MAX_OUTPUT_TOKENS: '6000',
  }), { effort: 'high', maxOutputTokens: 6000 });
  assert.throws(() => getModelSettings({ MODEL_REASONING_EFFORT: 'extreme' }), /must be low, medium, or high/);
  assert.throws(() => getModelSettings({ MODEL_MAX_OUTPUT_TOKENS: '0' }), /positive integer/);
});

test('verbose evaluation output includes model readings, confidence, and response completion metadata', () => {
  const output = formatVerboseRows([{
    id: 'case-01',
    expectedNames: ['TEST-ONLY-EXPECTED'],
    verdict: 'MISSED',
    detectedDrugs: [{ name: 'TEST-ONLY-READ', confidence: 0.62 }],
    uncertainDrugs: [{ name: 'TEST-ONLY-UNCERTAIN', confidence: 0.3 }],
    diagnostics: [{
      attempt: 1,
      status: 'incomplete',
      finishReason: null,
      incompleteReason: 'max_output_tokens',
      jsonStatus: 'invalid_or_incomplete',
    }],
  }]);
  assert.match(output, /TEST-ONLY-EXPECTED → MISSED/);
  assert.match(output, /detected_drugs:.*TEST-ONLY-READ.*0\.62/);
  assert.match(output, /uncertain:.*TEST-ONLY-UNCERTAIN.*0\.3/);
  assert.match(output, /incomplete_reason=max_output_tokens JSON=invalid_or_incomplete/);
});

test('evaluation cases require unique ids and can be filtered by id', () => {
  const cases = [
    { id: 'fake-one', image: 'one.png', expected: ['SAMPLE-ONLY-A'] },
    { id: 'fake-two', image: 'two.png', expected: ['SAMPLE-ONLY-B'] },
  ];
  assert.doesNotThrow(() => validateCases(cases));
  assert.doesNotThrow(() => validateCases([
    { id: 'unlabeled', image: 'unlabeled.png', expected: [] },
    { id: 'unlabeled-flag', image: 'unlabeled-flag.png', expected: [], labeled: false },
  ]));
  assert.deepEqual(selectCases(cases, 'fake-two'), [cases[1]]);
  assert.deepEqual(selectCases(cases, ['fake-one', 'fake-two']), cases);
  assert.throws(() => selectCases(cases, 'missing'), /No evaluation case has id/);
  assert.throws(() => validateCases([cases[0], cases[0]]), /unique id/);
});

test('evaluation reports can be exported as CSV or Markdown', () => {
  const rows = [{
    id: 'fake-one',
    image: 'one.png',
    expectedNames: ['TEST-ONLY-EXPECTED'],
    detectedNames: ['TEST-ONLY-READ'],
    uncertainNames: [],
    correct: 1,
    uncertain: 0,
    false_with_confidence: 0,
    missed: 0,
    tolerantCorrect: 1,
    tolerantUncertain: 0,
    tolerantFalseWithConfidence: 0,
    tolerantMissed: 0,
    seconds: '2.5',
    status: 'success',
    verdict: 'CORRECT',
  }];
  const summary = {
    cases: 1,
    correct: 1,
    uncertain: 0,
    falseWithConfidence: 0,
    missed: 0,
    tolerantCorrect: 1,
    tolerantUncertain: 0,
    tolerantFalseWithConfidence: 0,
    tolerantMissed: 0,
    errors: 0,
    meanSeconds: 2.5,
  };
  assert.match(formatCsv(rows, summary), /strict_verdict,tolerant_verdict/);
  assert.match(formatCsv(rows, summary), /SUMMARY,,,,1,0,0,0,1,0,0,0,0,2\.5,/);
  assert.match(formatMarkdown(rows, summary), /\| fake-one \| TEST-ONLY-EXPECTED \| TEST-ONLY-READ \|/);
  assert.match(formatMarkdown(rows, summary), /- Correct: 1/);
  assert.match(formatMarkdown(rows, summary), /- Mean time: 2\.5 s/);
});

test('Markdown report separates accuracy from unlabeled-image robustness', () => {
  const rows = [
    {
      id: 'case-transcribed',
      labeled: true,
      expectedNames: ['TEST-ONLY-EXPECTED'],
      detectedNames: ['TEST-ONLY-EXPECTED'],
      uncertainNames: [],
      correct: 1,
      uncertain: 0,
      false_with_confidence: 0,
      missed: 0,
      tolerantCorrect: 1,
      tolerantUncertain: 0,
      tolerantFalseWithConfidence: 0,
      tolerantMissed: 0,
      verdict: 'CORRECT',
      tolerantVerdict: 'CORRECT',
    },
    {
      id: 'case-unlabeled',
      labeled: false,
      expectedNames: [],
      detectedNames: ['TEST-ONLY-READ'],
      uncertainNames: ['TEST-ONLY-UNCERTAIN'],
      confidentCount: 1,
      uncertainCount: 1,
      status: 'not_a_prescription',
    },
  ];
  const summary = {
    transcribedCases: 1,
    unlabeledCases: 1,
    expectedNames: 1,
    correct: 1,
    strictAccuracyPercent: 100,
    uncertain: 0,
    falseWithConfidence: 0,
    missed: 0,
    errors: 0,
    meanSeconds: 1,
    tolerantCorrect: 1,
    tolerantAccuracyPercent: 100,
    tolerantUncertain: 0,
    tolerantFalseWithConfidence: 0,
    tolerantMissed: 0,
  };
  const report = formatMarkdown(rows, summary);
  const accuracy = report.split('## Accuracy')[1].split('## Robustness (unlabeled images)')[0];
  const robustness = report.split('## Robustness (unlabeled images)')[1];

  assert.match(report, /## Accuracy/);
  assert.match(report, /## Robustness \(unlabeled images\)/);
  assert.match(report, /Transcribed cases: 1; unlabeled cases: 1; expected names \(scoring denominator\): 1/);
  assert.match(report, /Correct: 1\/1 expected names \(100\.0%\)/);
  assert.doesNotMatch(accuracy, /case-unlabeled/);
  assert.match(robustness, /\| case-unlabeled \| 1 \| 1 \| not_a_prescription \|/);
  assert.match(robustness, /Descriptive totals: unlabeled images=1; confident names read=1; uncertain names=1/);
  assert.doesNotMatch(robustness, /correct|false-confident|missed/i);
});

test('Markdown report writes a simulated reliability result with false-confident cases first', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pharmaclear-eval-'));
  const reportPath = path.join(directory, 'results.md');
  const rows = [
    {
      id: 'case-ok',
      expectedNames: ['TEST-ONLY-EXPECTED'],
      detectedNames: ['TEST-ONLY-EXPECTED'],
      uncertainNames: [],
      verdict: 'CORRECT',
      false_with_confidence: 0,
    },
    {
      id: 'case-false',
      expectedNames: ['TEST-ONLY-EXPECTED'],
      detectedNames: ['TEST-ONLY-WRONG'],
      uncertainNames: [],
      verdict: 'FALSE-CONFIDENT',
      false_with_confidence: 1,
    },
  ];
  const summary = {
    correct: 1,
    uncertain: 0,
    falseWithConfidence: 1,
    missed: 0,
    errors: 0,
    meanSeconds: 1.25,
  };
  try {
    assert.equal(await writeMarkdownReport(rows, summary, reportPath), reportPath);
    const report = await fs.readFile(reportPath, 'utf8');
    assert.ok(report.indexOf('case-false') < report.indexOf('case-ok'));
    assert.match(report, /\| Case \| Expected \| Detected \| Uncertain \| Strict \| Tolerant \|/);
    assert.match(report, /- False-confident: 1/);
    assert.match(report, /## Tolerant totals/);
    assert.match(report, /- Mean time: 1\.3 s/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
