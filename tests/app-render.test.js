'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const publicDirectory = path.join(__dirname, '../public');
const renderStart = appSource.indexOf('function renderResult(');
const renderEnd = appSource.indexOf('\nasync function showResult(', renderStart);
const showResultStart = renderEnd + 1;
const showResultEnd = appSource.indexOf('\nfunction startPolling(', showResultStart);
const sampleStart = appSource.indexOf('async function handleSample() {');
const sampleEnd = appSource.indexOf('\nasync function resetAll()', sampleStart);

test('all locale files are valid UTF-8 JSON and static page keys exist in English', () => {
  for (const locale of ['en', 'fr', 'fon']) {
    const bytes = fs.readFileSync(path.join(publicDirectory, `i18n/${locale}.json`));
    const text = bytes.toString('utf8');
    assert.deepEqual(Buffer.from(text, 'utf8'), bytes, `${locale}.json should be valid UTF-8`);
    assert.equal(typeof JSON.parse(text), 'object', `${locale}.json should be valid JSON`);
  }
  const html = fs.readFileSync(path.join(publicDirectory, 'index.html'), 'utf8');
  const english = require('../public/i18n/en.json');
  const keys = [...new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]))];
  assert.deepEqual(keys.filter((key) => !(key in english)), []);
});

function createRenderer(language = 'en') {
  assert.notEqual(renderStart, -1, 'renderResult should exist');
  assert.ok(renderEnd > renderStart, 'renderResult should have a function boundary');

  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      '<div id="result-content"></div>' +
      '<div id="sample-banner" hidden></div>' +
      '<div id="mock-banner" hidden></div>' +
      '<div id="error" hidden></div>' +
      '<img id="thumb">' +
      '<section id="step-result" hidden></section>' +
      '<section id="step-pick"></section>' +
    '</body></html>',
    { runScripts: 'outside-only', url: 'https://pharmaclear.test/' },
  );
  const { window } = dom;
  window.$ = (id) => window.document.getElementById(id);
  window.show = (id, visible) => { window.$(id).hidden = !visible; };
  window.makeElement = (tag, className, text) => {
    const element = window.document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  window.addField = (parent, label, value) => {
    if (value === undefined || value === null || String(value).trim() === '') return;
    const row = window.document.createElement('div');
    const name = window.document.createElement('strong');
    name.textContent = `${label}: `;
    row.append(name, window.document.createTextNode(String(value)));
    parent.appendChild(row);
  };
  window.safeSourceLink = (url, title) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
    const link = window.document.createElement('a');
    link.href = url;
    link.textContent = title || url;
    return link;
  };
  window.language = language;
  const translations = require(`../public/i18n/${language}.json`);
  const english = require('../public/i18n/en.json');
  window.t = (key, values = {}) => (translations[key] || english[key] || key).replace(
    /\{(\w+)\}/g,
    (_, name) => String(values[name] ?? ''),
  );
  window.console = { error() {} };
  window.eval(`${appSource.slice(renderStart, renderEnd)}\nwindow.renderResult = renderResult;`);
  return dom;
}

const renderCases = [
  ['error result', { status: 'error', error: 'Synthetic test error.' }],
  ['not a prescription', { status: 'not_a_prescription' }],
  ['only confident readings', {
    status: 'success',
    detected_drugs: [{ name: 'SAMPLE-ONLY-READ' }],
  }],
  ['only uncertain readings', {
    status: 'success',
    uncertain: [{ name: 'SAMPLE-ONLY-UNCERTAIN', confidence: 0.3 }],
  }],
  ['verified alert, uncertainty, and confident reading', {
    status: 'success',
    detected_drugs: [{ name: 'SAMPLE-ONLY-READ' }],
    uncertain: [{ name: 'SAMPLE-ONLY-UNCERTAIN', confidence: 0.3 }],
    interactions: [{
      status: 'verified',
      review_status: 'unreviewed',
      drug_a: 'SAMPLE-ONLY-A',
      drug_b: 'SAMPLE-ONLY-B',
      severity: 'caution',
      summary_en: 'TEST ONLY: synthetic summary.',
      source: {
        display_name_en: 'TEST ONLY source',
        display_name_fr: 'Source TEST ONLY',
        publication_date: '2025-10',
        title: 'TEST ONLY',
        url: 'https://example.invalid/',
        accessed: '2026-10-31',
      },
    }],
  }],
  ['empty arrays', {
    status: 'success',
    detected_drugs: [],
    uncertain: [],
    interactions: [],
  }],
  ['missing optional fields', { status: 'success' }],
];

for (const [label, result] of renderCases) {
  test(`renderResult does not throw for ${label}`, (t) => {
    const dom = createRenderer();
    t.after(() => dom.window.close());
    assert.doesNotThrow(() => dom.window.renderResult(result));
  });
}

test('showResult reports a clear message when result rendering fails', async (t) => {
  assert.ok(showResultEnd > showResultStart, 'showResult should have a function boundary');
  const dom = createRenderer();
  t.after(() => dom.window.close());
  const { window } = dom;
  let stopped = false;
  window.stopPolling = () => { stopped = true; };
  window.activeJob = null;
  window.clearId = () => {};
  window.clearThumb = () => {};
  window.thumbObjectUrl = null;
  window.latestResult = null;
  window.latestResultIsSample = false;
  window.renderResult = () => { throw new Error('synthetic render failure'); };
  window.showError = (message) => {
    window.$('error').textContent = message;
    window.$('error').hidden = false;
  };
  window.showStep = (step) => {
    window.$('step-result').hidden = step !== 'result';
    window.$('step-pick').hidden = step !== 'pick';
  };
  window.eval(`${appSource.slice(showResultStart, showResultEnd)}\nwindow.runShowResult = showResult;`);

  await window.runShowResult({ status: 'success'   });
  assert.equal(stopped, true);
  assert.equal(
    window.$('error').textContent,
    'Could not display the result. Show the paper prescription to a pharmacist.',
  );
  assert.equal(window.$('step-result').hidden, false);
});

test('sample result is labelled and loads only precomputed assets without an analysis call', async (t) => {
  assert.ok(sampleStart >= 0 && sampleEnd > sampleStart, 'handleSample should exist');
  const dom = createRenderer();
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  window.activeJob = null;
  window.latestResult = null;
  window.latestResultIsSample = false;
  window.thumbObjectUrl = null;
  window.URL.createObjectURL = () => 'blob:sample';
  window.showError = (message) => { throw new Error(message); };
  window.showStep = () => {};
  const sampleResult = require('../public/samples/sample-result.json');
  window.fetch = async (url) => {
    calls.push(url);
    if (url === '/samples/sample-prescription.png') {
      return { ok: true, blob: async () => ({ type: 'image/png' }) };
    }
    if (url === '/samples/sample-result.json') {
      return { ok: true, json: async () => sampleResult };
    }
    throw new Error(`Unexpected sample request: ${url}`);
  };
  window.eval(`${appSource.slice(sampleStart, sampleEnd)}\nwindow.handleSample = handleSample;`);

  await window.handleSample();

  assert.deepEqual(calls, [
    '/samples/sample-prescription.png',
    '/samples/sample-result.json',
  ]);
  assert.equal(window.latestResultIsSample, true);
  assert.equal(window.$('sample-banner').hidden, false);
  assert.match(window.$('sample-banner').textContent, /Sample result/);
  assert.match(window.$('result-content').textContent, /Ibuprofène/);
  assert.match(window.$('result-content').textContent, /Aspirine/);
});

test('result cards appear only when applicable and in the required order', (t) => {
  const dom = createRenderer();
  t.after(() => dom.window.close());
  const { window } = dom;
  window.renderResult({
    status: 'success',
    interactions: [
      { status: 'verified', drug_a: 'TEST-ONLY-A', drug_b: 'TEST-ONLY-B', severity: 'caution',
        summary_en: 'TEST ONLY: synthetic alert.', summary_fr: 'TEST ONLY: alerte synthétique.',
        source: { title: 'TEST ONLY', url: 'https://example.invalid/' } },
      { status: 'not_verified', drug_a: 'TEST-ONLY-C', drug_b: 'TEST-ONLY-D' },
      { status: 'not_verified', drug_a: 'TEST-ONLY-E', drug_b: 'TEST-ONLY-F' },
    ],
    uncertain: [{ name: 'TEST-ONLY-UNCERTAIN', confidence: 0.3 }],
    detected_drugs: [{ name: 'TEST-ONLY-READ', dosage: 'TEST ONLY dose' }],
  });

  const result = window.document.querySelector('#result-content .result');
  assert.deepEqual(
    [...result.querySelectorAll('.result-card')].map((card) =>
      [...card.classList].find((name) => name.startsWith('result-card--'))),
    ['result-card--verified', 'result-card--uncertain', 'result-card--read'],
  );
  assert.equal(result.querySelectorAll('.interaction-unverified').length, 1);
  assert.match(result.querySelector('.interaction-unverified').textContent, /2/);
  assert.equal(result.querySelectorAll('.result-summary .summary-count strong')[0].textContent, '1');
  assert.equal(result.querySelectorAll('.result-summary .summary-count strong')[1].textContent, '1');
  assert.equal(result.querySelectorAll('.result-summary .summary-count strong')[2].textContent, '1');
  assert.ok(result.querySelector('.result-card--verified .source-button'));
  assert.ok(result.querySelector('.result-card--uncertain .confidence-badge--low'));
  assert.ok(result.querySelector('.result-card--uncertain .data-pill--missing'));
  assert.equal(result.querySelector('.result-card--read .data-pill--missing'), null);
  assert.ok(result.querySelector('.result-card--verified h2 svg[viewBox="0 0 24 24"]'));
});

test('no verified interaction card is rendered without a verified alert', (t) => {
  const dom = createRenderer();
  t.after(() => dom.window.close());
  dom.window.renderResult({
    status: 'success',
    interactions: [{ status: 'not_verified', drug_a: 'TEST-ONLY-A', drug_b: 'TEST-ONLY-B' }],
  });
  assert.equal(dom.window.document.querySelector('.result-card--verified'), null);
  assert.equal(dom.window.document.querySelectorAll('.interaction-unverified').length, 1);
});

test('verified alert explanation language selector distinguishes Fon provenance', (t) => {
  const dom = createRenderer();
  t.after(() => dom.window.close());
  const { window } = dom;
  window.renderResult({
    status: 'success',
    interactions: [{
      status: 'verified',
      drug_a: 'TEST-ONLY-A',
      drug_b: 'TEST-ONLY-B',
      severity: 'caution',
      summary_en: 'TEST ONLY: English fixture.',
      summary_fr: 'TEST ONLY: French fixture.',
      summary_fon_human: 'TEST ONLY: speaker-written fixture.',
      summary_fon: 'TEST ONLY: machine-translation fixture.',
      source: {
        display_name_en: 'TEST ONLY source',
        display_name_fr: 'TEST ONLY source FR',
        publication_date: '2025-10',
        accessed: '2026-10-31',
        title: 'TEST ONLY source',
        url: 'https://example.invalid/',
      },
    }],
  });
  const picker = window.document.querySelector('.explanation-picker');
  const explanation = window.document.querySelector('.interaction-summary');
  const provenance = window.document.querySelector('.fon-provenance');
  assert.equal(picker.value, 'en');
  picker.value = 'fr';
  picker.dispatchEvent(new window.Event('change'));
  assert.equal(explanation.textContent, 'TEST ONLY: French fixture.');
  picker.value = 'fon';
  picker.dispatchEvent(new window.Event('change'));
  assert.equal(explanation.textContent, 'TEST ONLY: speaker-written fixture.');
  assert.equal(provenance.textContent, 'Written by a Fon speaker');
  const interaction = {
    status: 'verified',
    drug_a: 'TEST-ONLY-A',
    drug_b: 'TEST-ONLY-B',
    severity: 'caution',
    summary_en: 'TEST ONLY: English fixture.',
    summary_fr: 'TEST ONLY: French fixture.',
    summary_fon: 'TEST ONLY: machine-translation fixture.',
  };
  window.renderResult({ status: 'success', interactions: [interaction] });
  const machinePicker = window.document.querySelector('.explanation-picker');
  machinePicker.value = 'fon';
  machinePicker.dispatchEvent(new window.Event('change'));
  assert.equal(
    window.document.querySelector('.interaction-summary').textContent,
    'TEST ONLY: machine-translation fixture.',
  );
  assert.equal(
    window.document.querySelector('.fon-provenance').textContent,
    'Machine translation, please verify.',
  );
});

test('unreviewed alert includes source and date; reviewed alert omits the notice', (t) => {
  const dom = createRenderer();
  t.after(() => dom.window.close());
  const { window } = dom;
  const interaction = {
    status: 'verified',
    review_status: 'unreviewed',
    drug_a: 'TEST-ONLY-A',
    drug_b: 'TEST-ONLY-B',
    severity: 'avoid',
    summary_en: 'TEST ONLY: documented fixture.',
    source: {
      display_name_en: 'FDA drug label',
      display_name_fr: 'étiquetage FDA',
      publication_date: '2025-10',
      accessed: '2026-10-31',
      title: 'TEST ONLY: source citation.',
      url: 'https://example.invalid/',
    },
  };
  window.renderResult({ status: 'success', interactions: [interaction] });
  assert.equal(
    window.document.querySelector('.unreviewed-note').textContent,
    'Source: FDA drug label (Oct 2025). Not yet reviewed by a pharmacist.',
  );
  assert.match(window.document.querySelector('.severity-badge').textContent, /Avoid/);

  interaction.review_status = 'reviewed';
  window.renderResult({ status: 'success', interactions: [interaction] });
  assert.equal(window.document.querySelector('.unreviewed-note'), null);
});

test('French unreviewed notice localizes the pair source name and publication date', (t) => {
  const dom = createRenderer('fr');
  t.after(() => dom.window.close());
  dom.window.renderResult({
    status: 'success',
    interactions: [{
      status: 'verified',
      review_status: 'unreviewed',
      drug_a: 'TEST-ONLY-A',
      drug_b: 'TEST-ONLY-B',
      severity: 'caution',
      summary_en: 'TEST ONLY: English fixture.',
      summary_fr: 'TEST ONLY : fixture française.',
      source: {
        display_name_en: 'FDA drug label',
        display_name_fr: 'étiquetage FDA',
        publication_date: '2025-10',
        title: 'TEST ONLY source',
        url: 'https://example.invalid/',
      },
    }],
  });
  assert.equal(
    dom.window.document.querySelector('.unreviewed-note').textContent,
    "Source : étiquetage FDA (oct. 2025). Pas encore relu par un pharmacien.",
  );
  assert.match(dom.window.document.querySelector('.severity-badge').textContent, /À éviter|Prudence|À surveiller/);
});

test('Fon notice and documented severity use supplied localization data', (t) => {
  const dom = createRenderer('fon');
  t.after(() => dom.window.close());
  const interaction = require('../interactions').checkDrugInteraction;
  return interaction('Ibuprofène', 'Aspirine').then((result) => {
    dom.window.renderResult({ status: 'success', interactions: [result] });
    assert.equal(
      dom.window.document.querySelector('.unreviewed-note').textContent,
      require('../public/i18n/fon.json').unreviewedNote,
    );
    assert.match(
      dom.window.document.querySelector('.source-citation').textContent,
      /FDA drug label.*2025/,
    );
    const picker = dom.window.document.querySelector('.explanation-picker');
    picker.value = 'fon';
    picker.dispatchEvent(new dom.window.Event('change'));
    assert.equal(
      dom.window.document.querySelector('.interaction-summary').textContent,
      result.summary_fon_human,
    );
    assert.match(
      dom.window.document.querySelector('.severity-badge').textContent,
      new RegExp(require('../public/i18n/fon.json').severityAvoid),
    );
  });
});
