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

async function run() {
  const groundTruthPath = path.join(EVAL_DIR, 'ground-truth.json');
  const groundTruth = JSON.parse(await fs.readFile(groundTruthPath, 'utf8'));
  if (!groundTruth || !Array.isArray(groundTruth.cases)) {
    throw new Error('ground-truth.json must contain a cases array');
  }
  if (groundTruth.cases.length === 0) {
    console.log('No evaluation cases. Add fake prescription images under eval/images/ and list them in ground-truth.json.');
    console.log('Summary: cases=0 correct=0 uncertain=0 false_with_confidence=0 missed=0 errors=0 mean_time=0.0s');
    return;
  }
  if (!CONFIG.apiKey) {
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

  for (const [index, item] of groundTruth.cases.entries()) {
    if (!item || !Array.isArray(item.expected) ||
        item.expected.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error(`Case ${index + 1} must have an expected array of non-empty names`);
    }

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
          image: item.image,
          expected_uncertain: scores.uncertain,
          ambiguous: scores.ambiguous,
        });
      }
    } catch (error) {
      const elapsedMs = performance.now() - started;
      elapsedTotal += elapsedMs;
      rows.push({
        image: item.image,
        correct: 0,
        uncertain: 0,
        false_with_confidence: 0,
        missed: item.expected.length,
        seconds: (elapsedMs / 1000).toFixed(1),
        status: `ERROR: ${error.message}`,
      });
      errorsTotal++;
      manualReview.push({ image: item.image, error: error.message });
    }
  }

  console.table(rows);
  if (manualReview.length) {
    console.log('Manual review cases:', JSON.stringify(manualReview, null, 2));
  }

  const meanSeconds = attempted ? elapsedTotal / attempted / 1000 : 0;
  console.log(
    `Summary: cases=${attempted} correct=${correctTotal} uncertain=${uncertainTotal} ` +
    `false_with_confidence=${falseConfidentTotal} missed=${missedTotal} ` +
    `errors=${errorsTotal} mean_time=${meanSeconds.toFixed(1)}s`,
  );
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Evaluation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { normalizeName, scoreResult };
