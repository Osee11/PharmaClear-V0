'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeName,
  scoreResult,
  parseArguments,
  validateCases,
  selectCases,
  formatCsv,
  formatMarkdown,
  writeMarkdownReport,
} = require('../eval/run-eval');

test('evaluation names ignore case, accents, and repeated whitespace', () => {
  assert.equal(normalizeName('  Épreuve   Témoin A '), 'epreuve temoin a');
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
    { only: 'fake-one', format: 'csv' },
  );
  assert.throws(() => parseArguments(['--only']), /requires a case id/);
  assert.throws(() => parseArguments(['--format', 'html']), /must be table, csv, or markdown/);
});

test('evaluation cases require unique ids and can be filtered by id', () => {
  const cases = [
    { id: 'fake-one', image: 'one.png', expected: ['SAMPLE-ONLY-A'] },
    { id: 'fake-two', image: 'two.png', expected: ['SAMPLE-ONLY-B'] },
  ];
  assert.doesNotThrow(() => validateCases(cases));
  assert.deepEqual(selectCases(cases, 'fake-two'), [cases[1]]);
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
    errors: 0,
    meanSeconds: 2.5,
  };
  assert.match(formatCsv(rows, summary), /SUMMARY,,1,0,0,0,0,2\.5,/);
  assert.match(formatMarkdown(rows, summary), /\| fake-one \| TEST-ONLY-EXPECTED \| TEST-ONLY-READ \|/);
  assert.match(formatMarkdown(rows, summary), /- Correct: 1/);
  assert.match(formatMarkdown(rows, summary), /- Mean time: 2\.5 s/);
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
    assert.match(report, /\| Case \| Expected \| Detected \| Uncertain \| Verdict \|/);
    assert.match(report, /- False-confident: 1/);
    assert.match(report, /- Mean time: 1\.3 s/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
