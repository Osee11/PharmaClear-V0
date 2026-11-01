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

function displayNames(items) {
  return Array.isArray(items)
    ? items
      .map((item) => item && typeof item.name === 'string' ? item.name.trim() : '')
      .filter(Boolean)
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
  const falseConfident = Array.isArray(result && result.detected_drugs)
    ? result.detected_drugs
      .filter((item) => item && typeof item.confidence === 'number' &&
        item.confidence >= 0.7 && !expected.includes(normalizeName(item.name)))
      .map((item) => normalizeName(item.name))
      .filter(Boolean)
    : [];
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

function levenshteinDistance(first, second) {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex++) {
    let diagonal = previous[0];
    previous[0] = firstIndex;
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex++) {
      const above = previous[secondIndex];
      previous[secondIndex] = Math.min(
        previous[secondIndex] + 1,
        previous[secondIndex - 1] + 1,
        diagonal + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[second.length];
}

function tolerantNameMatches(expectedName, candidateName) {
  const expected = normalizeName(expectedName);
  const candidate = normalizeName(candidateName);
  if (!expected || !candidate) return false;
  if (candidate === expected) return true;

  if (candidate.startsWith(expected)) {
    const nextCharacter = candidate[expected.length];
    if (nextCharacter === undefined || !/[\p{L}\p{N}]/u.test(nextCharacter)) {
      return true;
    }
  }

  const expectedLetterCount = (expected.match(/\p{L}/gu) || []).length;
  const maxDistance = expectedLetterCount >= 5 && expectedLetterCount <= 8
    ? 1
    : expectedLetterCount > 8 ? 2 : 0;
  return maxDistance > 0 && levenshteinDistance(expected, candidate) <= maxDistance;
}

function scoreTolerantResult(expectedNames, result) {
  const expected = [...new Set(expectedNames.map(normalizeName).filter(Boolean))];
  const detectedItems = Array.isArray(result && result.detected_drugs)
    ? result.detected_drugs.filter((item) => item && normalizeName(item.name))
    : [];
  const uncertainItems = Array.isArray(result && result.uncertain)
    ? result.uncertain.filter((item) => item && normalizeName(item.name))
    : [];
  const matchesAny = (expectedName, items) =>
    items.some((item) => tolerantNameMatches(expectedName, item.name));
  const correct = expected.filter((name) => matchesAny(name, detectedItems));
  const uncertain = expected.filter((name) =>
    !matchesAny(name, detectedItems) && matchesAny(name, uncertainItems));
  const missed = expected.filter((name) =>
    !matchesAny(name, detectedItems) && !matchesAny(name, uncertainItems));
  const falseConfident = detectedItems
    .filter((item) => typeof item.confidence === 'number' && item.confidence >= 0.7 &&
      !expected.some((name) => tolerantNameMatches(name, item.name)))
    .map((item) => normalizeName(item.name));
  const overlapping = expected.filter((name) =>
    matchesAny(name, detectedItems) && matchesAny(name, uncertainItems));

  return {
    correct,
    uncertain,
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

function verdictFor(scores) {
  return scores.falseConfident.length
    ? 'FALSE-CONFIDENT'
    : scores.uncertain.length
      ? 'UNCERTAIN'
      : scores.missed.length
        ? 'MISSED'
        : 'CORRECT';
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
  const options = { format: 'table', verbose: false };
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === '--only') {
      const id = args[++index];
      if (!id || id.startsWith('--')) throw new Error('--only requires a case id');
      options.only = options.only === undefined
        ? id
        : [...(Array.isArray(options.only) ? options.only : [options.only]), id];
    } else if (option === '--format') {
      const format = args[++index];
      if (!['table', 'csv', 'markdown'].includes(format)) {
        throw new Error('--format must be table, csv, or markdown');
      }
      options.format = format;
    } else if (option === '--verbose') {
      options.verbose = true;
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
        (item.labeled !== undefined && typeof item.labeled !== 'boolean') ||
        !Array.isArray(item.expected) ||
        item.expected.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error(`Case ${index + 1} must have a unique id, image, optional boolean labeled flag, and expected array of non-empty names`);
    }
    ids.add(item.id);
  }
}

function isLabeledCase(item) {
  return item.labeled !== false && item.expected.length > 0;
}

function formatAccuracy(correct, expected, percent) {
  return expected
    ? `${correct}/${expected} (${Number(percent || 0).toFixed(1)}%)`
    : `${correct}/0 (N/A)`;
}

function formatAccuracyPercent(expected, percent) {
  return expected ? `${Number(percent || 0).toFixed(1)}%` : 'N/A';
}

function scoreLabeledCase(item, result) {
  if (!isLabeledCase(item)) return null;
  return {
    strict: scoreResult(item.expected, result),
    tolerant: scoreTolerantResult(item.expected, result),
  };
}

function selectCases(cases, only) {
  const ids = only === undefined ? [] : Array.isArray(only) ? only : [only];
  const selected = ids.length ? cases.filter((item) => ids.includes(item.id)) : cases;
  const missing = ids.find((id) => !cases.some((item) => item.id === id));
  if (missing) {
    throw new Error(`No evaluation case has id "${missing}"`);
  }
  return selected;
}

function summaryLine(summary) {
  return `Summary (Strict): transcribed_cases=${summary.transcribedCases} ` +
    `unlabeled_cases=${summary.unlabeledCases} ` +
    `expected_names=${summary.expectedNames} correct=${formatAccuracy(
      summary.correct, summary.expectedNames, summary.strictAccuracyPercent)} ` +
    `uncertain=${summary.uncertain} false_with_confidence=${summary.falseWithConfidence} ` +
    `missed=${summary.missed} errors=${summary.errors} ` +
    `mean_time=${summary.meanSeconds.toFixed(1)}s ` +
    `tokens_input=${summary.inputTokens || 0} tokens_output=${summary.outputTokens || 0} ` +
    `tokens_reasoning=${summary.reasoningTokens || 0}`;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatCsv(rows, summary) {
  const accuracyRows = rows.filter((row) => row.labeled !== false);
  const columns = [
    'id', 'image', 'strict_verdict', 'tolerant_verdict',
    'strict_correct', 'strict_uncertain', 'strict_false_with_confidence', 'strict_missed',
    'tolerant_correct', 'tolerant_uncertain', 'tolerant_false_with_confidence',
    'tolerant_missed', 'errors', 'mean_time_seconds', 'status',
  ];
  const lines = [columns.join(',')];
  for (const row of accuracyRows) {
    lines.push([
      row.id, row.image, row.verdict, row.tolerantVerdict,
      row.correct, row.uncertain, row.false_with_confidence, row.missed,
      row.tolerantCorrect, row.tolerantUncertain,
      row.tolerantFalseWithConfidence, row.tolerantMissed,
      row.status.startsWith('ERROR:') ? 1 : 0, '', row.status,
    ].map(csvEscape).join(','));
  }
  lines.push([
    'SUMMARY', '', '', '',
    summary.correct, summary.uncertain, summary.falseWithConfidence, summary.missed,
    summary.tolerantCorrect, summary.tolerantUncertain,
    summary.tolerantFalseWithConfidence, summary.tolerantMissed, summary.errors,
    summary.meanSeconds.toFixed(1), '',
  ].map(csvEscape).join(','));
  return `${lines.join('\n')}\n`;
}

function formatMarkdown(rows, summary) {
  const cell = (value) => String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
  const accuracyRows = rows.filter((row) => row.labeled !== false);
  const robustnessRows = rows.filter((row) => row.labeled === false);
  const orderedRows = [...accuracyRows].sort((first, second) =>
    Number(second.false_with_confidence > 0) - Number(first.false_with_confidence > 0));
  const lines = [
    '# Reliability evaluation',
    '',
    '## Accuracy',
    '',
    `Transcribed cases: ${summary.transcribedCases || 0}; unlabeled cases: ${summary.unlabeledCases || 0}; ` +
      `expected names (scoring denominator): ${summary.expectedNames || 0}.`,
    '',
    '| Case | Expected | Detected | Uncertain | Strict | Tolerant |',
    '|---|---|---|---|---|---|',
    ...orderedRows.map((row) => `| ${cell(row.id)} | ${cell((row.expectedNames || []).join(', '))} | ` +
      `${cell((row.detectedNames || []).join(', '))} | ` +
      `${cell((row.uncertainNames || []).join(', '))} | ${cell(row.verdict || row.status)} | ` +
      `${cell(row.tolerantVerdict || row.status)} |`),
    '',
    '### Strict totals',
    '',
    `- Correct: ${summary.correct}/${summary.expectedNames || 0} expected names ` +
      `(${formatAccuracyPercent(summary.expectedNames, summary.strictAccuracyPercent)})`,
    `- Uncertain: ${summary.uncertain}`,
    `- False-confident: ${summary.falseWithConfidence}`,
    `- Missed: ${summary.missed}`,
    `- Errors: ${summary.errors}`,
    `- Mean time: ${summary.meanSeconds.toFixed(1)} s`,
    '',
    '### Tolerant totals',
    '',
    `- Correct: ${summary.tolerantCorrect || 0}/${summary.expectedNames || 0} expected names ` +
      `(${formatAccuracyPercent(summary.expectedNames, summary.tolerantAccuracyPercent)})`,
    `- Uncertain: ${summary.tolerantUncertain || 0}`,
    `- False-confident: ${summary.tolerantFalseWithConfidence || 0}`,
    `- Missed: ${summary.tolerantMissed || 0}`,
    `- Tokens: input=${summary.inputTokens || 0} output=${summary.outputTokens || 0} ` +
      `reasoning=${summary.reasoningTokens || 0} ` +
      `total=${(summary.inputTokens || 0) + (summary.outputTokens || 0)}`,
    '',
    '## Robustness (unlabeled images)',
    '',
    '| Case | Confident names read | Uncertain names | Status |',
    '|---|---:|---:|---|',
    ...robustnessRows.map((row) => `| ${cell(row.id)} | ${row.confidentCount || 0} | ` +
      `${row.uncertainCount || 0} | ${cell(row.status)} |`),
    '',
    `Descriptive totals: unlabeled images=${robustnessRows.length}; ` +
      `confident names read=${robustnessRows.reduce((total, row) => total + (row.confidentCount || 0), 0)}; ` +
      `uncertain names=${robustnessRows.reduce((total, row) => total + (row.uncertainCount || 0), 0)}; ` +
      `errors=${robustnessRows.filter((row) => String(row.status).startsWith('ERROR:')).length}.`,
  ];
  return `${lines.join('\n')}\n`;
}

async function writeMarkdownReport(rows, summary, reportPath = path.join(EVAL_DIR, 'results.md')) {
  await fs.writeFile(reportPath, formatMarkdown(rows, summary), 'utf8');
  return reportPath;
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
  const accuracyRows = rows.filter((row) => row.labeled !== false);
  const robustnessRows = rows.filter((row) => row.labeled === false);
  console.table(accuracyRows.map((row) => ({
    id: row.id,
    image: row.image,
    strict: row.verdict,
    tolerant: row.tolerantVerdict,
    strict_correct: row.correct,
    strict_uncertain: row.uncertain,
    strict_false_confident: row.false_with_confidence,
    strict_missed: row.missed,
    tolerant_correct: row.tolerantCorrect,
    tolerant_uncertain: row.tolerantUncertain,
    tolerant_false_confident: row.tolerantFalseWithConfidence,
    tolerant_missed: row.tolerantMissed,
    seconds: row.seconds,
    status: row.status,
  })));
  if (manualReview.length) {
    console.log('Manual review cases:', JSON.stringify(manualReview, null, 2));
  }
  console.log(summaryLine(summary));
  console.log(`Summary (Tolerant): transcribed_cases=${summary.transcribedCases} ` +
    `unlabeled_cases=${summary.unlabeledCases} expected_names=${summary.expectedNames} ` +
    `correct=${formatAccuracy(
      summary.tolerantCorrect || 0,
      summary.expectedNames,
      summary.tolerantAccuracyPercent,
    )} ` +
    `uncertain=${summary.tolerantUncertain || 0} ` +
    `false_with_confidence=${summary.tolerantFalseWithConfidence || 0} ` +
    `missed=${summary.tolerantMissed || 0}`);
  if (robustnessRows.length) {
    console.log('Robustness (unlabeled images):');
    console.table(robustnessRows.map((row) => ({
      id: row.id,
      confident_names_read: row.confidentCount,
      uncertain_names: row.uncertainCount,
      status: row.status,
    })));
    console.log(`Descriptive totals: unlabeled_images=${robustnessRows.length} ` +
      `confident_names_read=${robustnessRows.reduce((total, row) => total + row.confidentCount, 0)} ` +
      `uncertain_names=${robustnessRows.reduce((total, row) => total + row.uncertainCount, 0)}`);
  }
}

function formatVerboseRows(rows) {
  return rows.map((row) => {
    const expected = (row.expectedNames || []).join(', ') || '(none)';
    const showDrugs = (items) => JSON.stringify((items || []).map((item) => ({
      name: item && item.name,
      confidence: item && item.confidence,
    })));
    const responseDetails = (row.diagnostics || []).map((item) =>
      `attempt=${item.attempt} status=${item.status || 'unknown'} ` +
      `finish/stop=${item.finishReason || 'not reported'} ` +
      `incomplete_reason=${item.incompleteReason || 'none'} JSON=${item.jsonStatus} ` +
      `tokens(input/output/reasoning)=${item.inputTokens}/${item.outputTokens}/${item.reasoningTokens}`).join('; ');
    return [
      `Case ${row.id}: ${expected} → ${row.verdict || row.status}`,
      `  detected_drugs: ${showDrugs(row.detectedDrugs)}`,
      `  uncertain: ${showDrugs(row.uncertainDrugs)}`,
      `  response: ${responseDetails || 'no model response metadata'}`,
    ].join('\n');
  }).join('\n');
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
  let transcribedCases = 0;
  let unlabeledCases = 0;
  let expectedNamesTotal = 0;
  let correctTotal = 0;
  let uncertainTotal = 0;
  let falseConfidentTotal = 0;
  let missedTotal = 0;
  let errorsTotal = 0;
  let tolerantCorrectTotal = 0;
  let tolerantUncertainTotal = 0;
  let tolerantFalseConfidentTotal = 0;
  let tolerantMissedTotal = 0;
  let inputTokensTotal = 0;
  let outputTokensTotal = 0;
  let reasoningTokensTotal = 0;

  for (const item of cases) {
    const labeled = isLabeledCase(item);
    if (labeled) {
      transcribedCases++;
      expectedNamesTotal += new Set(item.expected.map(normalizeName).filter(Boolean)).size;
    } else {
      unlabeledCases++;
    }
    const imagePath = resolveImage(item.image);
    const buffer = await fs.readFile(imagePath);
    const started = performance.now();
    const diagnostics = [];
    attempted++;
    try {
      const result = await analyzePrescription(buffer, mimeType(imagePath), {
        onResponse: (response) => {
          diagnostics.push(response);
          inputTokensTotal += response.inputTokens;
          outputTokensTotal += response.outputTokens;
          reasoningTokensTotal += response.reasoningTokens;
        },
      });
      const elapsedMs = performance.now() - started;
      elapsedTotal += elapsedMs;
      const caseScores = scoreLabeledCase(item, result);
      if (!caseScores) {
        rows.push({
          id: item.id,
          image: item.image,
          labeled: false,
          expectedNames: [],
          detectedDrugs: result.detected_drugs || [],
          uncertainDrugs: result.uncertain || [],
          diagnostics,
          detectedNames: displayNames(result.detected_drugs),
          uncertainNames: displayNames(result.uncertain),
          confidentCount: Array.isArray(result.detected_drugs) ? result.detected_drugs.length : 0,
          uncertainCount: Array.isArray(result.uncertain) ? result.uncertain.length : 0,
          seconds: (elapsedMs / 1000).toFixed(1),
          status: result.status || 'unknown',
        });
        continue;
      }
      const scores = caseScores.strict;
      const tolerantScores = caseScores.tolerant;
      correctTotal += scores.correct.length;
      uncertainTotal += scores.uncertain.length;
      falseConfidentTotal += scores.falseConfident.length;
      missedTotal += scores.missed.length;
      tolerantCorrectTotal += tolerantScores.correct.length;
      tolerantUncertainTotal += tolerantScores.uncertain.length;
      tolerantFalseConfidentTotal += tolerantScores.falseConfident.length;
      tolerantMissedTotal += tolerantScores.missed.length;

      const row = {
        id: item.id,
        image: item.image,
        labeled: true,
        expectedNames: item.expected,
        detectedDrugs: result.detected_drugs || [],
        uncertainDrugs: result.uncertain || [],
        diagnostics,
        detectedNames: displayNames(result.detected_drugs),
        uncertainNames: displayNames(result.uncertain),
        correct: scores.correct.length,
        uncertain: scores.uncertain.length,
        false_with_confidence: scores.falseConfident.length,
        missed: scores.missed.length,
        tolerantCorrect: tolerantScores.correct.length,
        tolerantUncertain: tolerantScores.uncertain.length,
        tolerantFalseWithConfidence: tolerantScores.falseConfident.length,
        tolerantMissed: tolerantScores.missed.length,
        seconds: (elapsedMs / 1000).toFixed(1),
        status: result.status || 'unknown',
        verdict: verdictFor(scores),
        tolerantVerdict: verdictFor(tolerantScores),
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
        labeled,
        expectedNames: labeled ? item.expected : [],
        detectedDrugs: [],
        uncertainDrugs: [],
        diagnostics,
        detectedNames: [],
        uncertainNames: [],
        ...(labeled
          ? {
            correct: 0,
            uncertain: 0,
            false_with_confidence: 0,
            missed: item.expected.length,
            tolerantCorrect: 0,
            tolerantUncertain: 0,
            tolerantFalseWithConfidence: 0,
            tolerantMissed: item.expected.length,
          }
          : {}),
        seconds: (elapsedMs / 1000).toFixed(1),
        status: `ERROR: ${error.message}`,
        ...(labeled
          ? {
            verdict: `ERROR: ${error.message}`,
            tolerantVerdict: `ERROR: ${error.message}`,
          }
          : { confidentCount: 0, uncertainCount: 0 }),
      });
      if (labeled) {
        errorsTotal++;
        manualReview.push({ id: item.id, image: item.image, error: error.message });
      }
    }
  }

  const strictAccuracyPercent = expectedNamesTotal
    ? correctTotal / expectedNamesTotal * 100
    : 0;
  const tolerantAccuracyPercent = expectedNamesTotal
    ? tolerantCorrectTotal / expectedNamesTotal * 100
    : 0;
  const summary = {
    cases: transcribedCases,
    totalCases: attempted,
    transcribedCases,
    unlabeledCases,
    expectedNames: expectedNamesTotal,
    correct: correctTotal,
    strictAccuracyPercent,
    uncertain: uncertainTotal,
    falseWithConfidence: falseConfidentTotal,
    missed: missedTotal,
    errors: errorsTotal,
    tolerantCorrect: tolerantCorrectTotal,
    tolerantAccuracyPercent,
    tolerantUncertain: tolerantUncertainTotal,
    tolerantFalseWithConfidence: tolerantFalseConfidentTotal,
    tolerantMissed: tolerantMissedTotal,
    meanSeconds: attempted ? elapsedTotal / attempted / 1000 : 0,
    inputTokens: inputTokensTotal,
    outputTokens: outputTokensTotal,
    reasoningTokens: reasoningTokensTotal,
  };
  rows.sort((first, second) =>
    Number(second.false_with_confidence > 0) - Number(first.false_with_confidence > 0));
  await writeMarkdownReport(rows, summary);
  printReport(rows, summary, options.format || 'table', manualReview);
  if (options.verbose) console.log(formatVerboseRows(rows));
  console.log('Saved eval/results.md');
  return { rows, summary, manualReview };
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node eval/run-eval.js [--only <id> ...] [--format table|csv|markdown] [--verbose]');
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
};
