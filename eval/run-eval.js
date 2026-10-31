'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { analyzePrescription, CONFIG } = require('../meta');

const EVAL_DIR = __dirname;
const IMAGE_DIR = path.join(EVAL_DIR, 'images');

function normalizeName(value) {
  return typeof value === 'string'
    ? value.normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .trim().toLocaleLowerCase('en').replace(/\s+/g, ' ')
    : '';
}

function namesFrom(items) {
  return Array.isArray(items)
    ? items.map((item) => normalizeName(item && item.name)).filter(Boolean)
    : [];
}

function scoreResult(expectedNames, result) {
  const expected = [...new Set(expectedNames.map(normalizeName).filter(Boolean))];
  const detected = namesFrom(result && result.detected_drugs);
  const uncertain = namesFrom(result && result.uncertain);
  const detectedSet = new Set(detected);
  const uncertainSet = new Set(uncertain);
  const correct = expected.filter((name) => detectedSet.has(name));
  const uncertainExpected = expected.filter((name) =>
    !detectedSet.has(name) && uncertainSet.has(name));
  const missed = expected.filter((name) =>
    !detectedSet.has(name) && !uncertainSet.has(name));
  const falseConfident = detected.filter((name) => !expected.includes(name));
  const overlapping = expected.filter((name) =>
    detectedSet.has(name) && uncertainSet.has(name));

  return {
    correct,
    uncertain: uncertainExpected,
    falseConfident,
    missed,
    ambiguous: [...new Set([
      ...overlapping,
      ...(result && result.image_quality && result.image_quality !== 'good'
        ? [`image_quality=${result.image_quality}`]
        : []),
    ])],
  };
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  throw new Error(`Unsupported image extension: ${ext || '(none)'}`);
}

function resolveImage(image) {
  if (typeof image !== 'string' || image.trim() === '') {
    throw new Error('Each case requires an image path relative to eval/images/');
  }
  const resolved = path.resolve(IMAGE_DIR, image);
  if (!resolved.startsWith(`${IMAGE_DIR}${path.sep}`)) {
    throw new Error(`Image path must stay inside eval/images/: ${image}`);
  }
  return resolved;
}

function parseArguments(args) {
  const options = { format: 'table' };
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === '--only') {
      const id = args[++index];
      if (!id || id.startsWith('--')) throw new Error('--only requires a case id');
      options.only = id;
    } else if (option === '--format') {
      const format = args[++index];
      if (!['table', 'csv', 'markdown'].includes(format)) {
        throw new Error('--format must be table, csv, or markdown');
      }
      options.format = format;
    } else if (option === '--help') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return options;
}

function validateCases(cases) {
  const ids = new Set();
  for (const [index, item] of cases.entries()) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() ||
        ids.has(item.id) || typeof item.image !== 'string' ||
        !Array.isArray(item.expected) ||
        item.expected.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error(`Case ${index + 1} must have a unique id, image, and expected array of non-empty names`);
    }
    ids.add(item.id);
  }
}

function selectCases(cases, only) {
  const selected = only ? cases.filter((item) => item.id === only) : cases;
  if (only && selected.length === 0) {
    throw new Error(`No evaluation case has id "${only}"`);
  }
  return selected;
}

function summaryLine(summary) {
  return `Summary: cases=${summary.cases} correct=${summary.correct} ` +
    `uncertain=${summary.uncertain} false_with_confidence=${summary.falseWithConfidence} ` +
    `missed=${summary.missed} errors=${summary.errors} ` +
    `mean_time=${summary.meanSeconds.toFixed(1)}s`;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatCsv(rows, summary) {
  const columns = [
    'id', 'image', 'correct', 'uncertain', 'false_with_confidence',
    'missed', 'errors', 'mean_time_seconds', 'status',
  ];
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push([
      row.id, row.image, row.correct, row.uncertain,
      row.false_with_confidence, row.missed,
      row.status.startsWith('ERROR:') ? 1 : 0, '', row.status,
    ].map(csvEscape).join(','));
  }
  lines.push([
    'SUMMARY', '', summary.correct, summary.uncertain,
    summary.falseWithConfidence, summary.missed, summary.errors,
    summary.meanSeconds.toFixed(1), '',
  ].map(csvEscape).join(','));
  return `${lines.join('\n')}\n`;
}

function formatMarkdown(rows, summary) {
  const lines = [
    '| ID | Image | Correct | Uncertain | False with confidence | Missed | Status | Seconds |',
    '|---|---|---:|---:|---:|---:|---|---:|',
    ...rows.map((row) =>
      `| ${row.id} | ${row.image} | ${row.correct} | ${row.uncertain} | ` +
      `${row.false_with_confidence} | ${row.missed} | ${row.status.replace(/\|/g, '\\|')} | ${row.seconds} |`),
    '',
    summaryLine(summary),
  ];
  return `${lines.join('\n')}\n`;
}

function printReport(rows, summary, format, manualReview) {
  if (format === 'csv') {
    process.stdout.write(formatCsv(rows, summary));
    return;
  }
  if (format === 'markdown') {
    process.stdout.write(formatMarkdown(rows, summary));
    return;
  }
  console.table(rows);
  if (manualReview.length) {
    console.log('Manual review cases:', JSON.stringify(manualReview, null, 2));
  }
  console.log(summaryLine(summary));
}

async function run(options = {}) {
  const groundTruthPath = path.join(EVAL_DIR, 'ground-truth.json');
  const groundTruth = JSON.parse(await fs.readFile(groundTruthPath, 'utf8'));
  if (!groundTruth || !Array.isArray(groundTruth.cases)) {
    throw new Error('ground-truth.json must contain a cases array');
  }
  validateCases(groundTruth.cases);
  const cases = selectCases(groundTruth.cases, options.only);
  if (cases.length > 0 && !CONFIG.apiKey) {
    throw new Error('META_API_KEY or MODEL_API_KEY is required for evaluation.');
  }

  const rows = [];
  const manualReview = [];
  let elapsedTotal = 0;
  let attempted = 0;
  let correctTotal = 0;
  let uncertainTotal = 0;
  let falseConfidentTotal = 0;
  let missedTotal = 0;
  let errorsTotal = 0;

  for (const item of cases) {
    const imagePath = resolveImage(item.image);
    const buffer = await fs.readFile(imagePath);
    const started = performance.now();
    attempted++;
    try {
      const result = await analyzePrescription(buffer, mimeType(imagePath));
      const elapsedMs = performance.now() - started;
      elapsedTotal += elapsedMs;
      const scores = scoreResult(item.expected, result);
      correctTotal += scores.correct.length;
      uncertainTotal += scores.uncertain.length;
      falseConfidentTotal += scores.falseConfident.length;
      missedTotal += scores.missed.length;

      const row = {
        id: item.id,
        image: item.image,
        correct: scores.correct.length,
        uncertain: scores.uncertain.length,
        false_with_confidence: scores.falseConfident.length,
        missed: scores.missed.length,
        seconds: (elapsedMs / 1000).toFixed(1),
        status: result.status || 'unknown',
      };
      rows.push(row);
      if (scores.ambiguous.length || scores.uncertain.length) {
        manualReview.push({
          id: item.id,
          image: item.image,
          expected_uncertain: scores.uncertain,
          ambiguous: scores.ambiguous,
        });
      }
    } catch (error) {
      const elapsedMs = performance.now() - started;
      elapsedTotal += elapsedMs;
      rows.push({
        id: item.id,
        image: item.image,
        correct: 0,
        uncertain: 0,
        false_with_confidence: 0,
        missed: item.expected.length,
        seconds: (elapsedMs / 1000).toFixed(1),
        status: `ERROR: ${error.message}`,
      });
      errorsTotal++;
      manualReview.push({ id: item.id, image: item.image, error: error.message });
    }
  }

  const summary = {
    cases: attempted,
    correct: correctTotal,
    uncertain: uncertainTotal,
    falseWithConfidence: falseConfidentTotal,
    missed: missedTotal,
    errors: errorsTotal,
    meanSeconds: attempted ? elapsedTotal / attempted / 1000 : 0,
  };
  printReport(rows, summary, options.format || 'table', manualReview);
  return { rows, summary, manualReview };
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node eval/run-eval.js [--only <id>] [--format table|csv|markdown]');
    } else {
      run(options).catch((error) => {
        console.error(`Evaluation failed: ${error.message}`);
        process.exitCode = 1;
      });
    }
  } catch (error) {
    console.error(`Evaluation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  normalizeName,
  scoreResult,
  parseArguments,
  validateCases,
  selectCases,
  formatCsv,
  formatMarkdown,
};
