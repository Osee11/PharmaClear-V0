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
const printStart = appSource.indexOf('function buildPrintReport(');
const printEnd = appSource.indexOf('\nfunction renderResult(', printStart);
const showResultStart = renderEnd + 1;
const showResultEnd = appSource.indexOf('\nfunction startPolling(', showResultStart);
const sampleStart = appSource.indexOf('async function handleSample() {');
const sampleEnd = appSource.indexOf('\nasync function resetAll()', sampleStart);
const accessStart = appSource.indexOf('async function checkDemoAccess(');
const accessEnd = appSource.indexOf('\nfunction requestDemoAccess()', accessStart);
const releasePreviewStart = appSource.indexOf('function releasePhotoPreview() {');
const releasePreviewEnd = appSource.indexOf('\nfunction setPhotoPreview(', releasePreviewStart);
const showStepStart = appSource.indexOf('function showStep(');
const showStepEnd = appSource.indexOf('\nfunction updateNetworkStatus(', showStepStart);

test('all locale files are valid UTF-8 JSON and static page keys exist in English', () => {
  for (const locale of ['en', 'fr', 'fon']) {
    const bytes = fs.readFileSync(path.join(publicDirectory, `i18n/${locale}.json`));
    const text = bytes.toString('utf8');
    assert.deepEqual(Buffer.from(text, 'utf8'), bytes, `${locale}.json should be valid UTF-8`);
    assert.equal(typeof JSON.parse(text), 'object', `${locale}.json should be valid JSON`);
  }
  const html = fs.readFileSync(path.join(publicDirectory, 'index.html'), 'utf8');
  const english = require('../public/i18n/en.json');
  const french = require('../public/i18n/fr.json');
  const fon = require('../public/i18n/fon.json');
  const keys = [...new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]))];
  assert.deepEqual(keys.filter((key) => !(key in english)), []);
  assert.equal(english.serverWakingUp, 'Server waking up…');
  assert.equal(french.serverWakingUp, 'Le serveur se réveille…');
  assert.equal(fon.serverWakingUp, '');
  assert.equal(english.photoAlt, 'Your prescription photo — tap to enlarge');
  assert.equal(french.photoAlt, 'Votre photo d’ordonnance — touchez pour agrandir');
  assert.equal(fon.photoAlt, '');
  assert.equal(fon.photoViewerTitle, '');
  assert.equal(fon.closePhotoViewer, '');
  assert.equal(fon.photoRetention, '');
  for (const key of [
    'aiSuggestedTitle',
    'aiSuggestedDisclaimer',
    'aiLanguageNote',
    'aiSimulated',
    'savePdf',
    'includePhoto',
    'printTitle',
    'printDate',
    'printReadTitle',
    'printUncertainTitle',
    'printNone',
    'printNoDocumented',
    'printUnreviewed',
    'severityLabel',
  ]) {
    assert.equal(typeof english[key], 'string');
    assert.equal(typeof french[key], 'string');
    assert.equal(fon[key], '');
  }
  assert.equal(
    english.photoRetention,
    'Deleted from our server right after analysis. On your phone, it stays only while you review it.',
  );
  assert.match(fs.readFileSync(path.join(publicDirectory, 'style.css'), 'utf8'),
    /@page\s*\{\s*size:\s*A4;\s*margin:\s*18mm;/);
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
      '<section id="print-report" hidden></section>' +
      '<input id="include-photo" type="checkbox">' +
      '<button id="thumb-preview" hidden><img id="thumb"></button>' +
      '<div id="photo-viewer" hidden><button id="photo-viewer-close"></button><img id="photo-viewer-image"></div>' +
      '<section id="step-result" hidden></section>' +
      '<section id="step-pick"></section>' +
      '<section id="step-progress"></section>' +
      '<div id="result-actions" hidden></div>' +
      '<div id="new-btn-sentinel"></div>' +
      '<button id="new-btn"></button>' +
      '<label id="include-photo-option" hidden><input id="include-photo" type="checkbox"></label>' +
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
  const translations = require(`../public/i18n/${language}.json`);
  const english = require('../public/i18n/en.json');
  window.language = language;
  window.translations = translations;
  window.englishTranslations = english;
  window.t = (key, values = {}) => (window.translations[key] || window.englishTranslations[key] || key).replace(
    /\{(\w+)\}/g,
    (_, name) => String(values[name] ?? ''),
  );
  window.console = { error() {} };
  window.latestResult = null;
  window.thumbObjectUrl = null;
  window.stickyCtaObserver = null;
  window.print = () => {};
  window.eval(
    `${appSource.slice(printStart, printEnd)}\n` +
    'window.buildPrintReport = buildPrintReport;' +
    'window.runPrintCurrentResult = printCurrentResult;',
  );
  window.eval(
    `${appSource.slice(renderStart, renderEnd)}\n` +
    'window.setRenderLanguage = (next, locale) => {' +
    'window.language = next; window.translations = locale;' +
    '}; window.renderResult = renderResult;',
  );
  return dom;
}

function createAccessHarness(url, validCode) {
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      '<section id="access-panel" hidden></section>' +
      '<p id="access-error" hidden></p>' +
      '<input id="access-code">' +
    '</body></html>',
    { runScripts: 'outside-only', url },
  );
  const { window } = dom;
  window.console = { error() {} };
  window.fetch = async (path, options = {}) => {
    assert.equal(path, '/api/access');
    const sentCode = options.headers?.['X-Demo-Access-Code'] || '';
    return {
      ok: true,
      json: async () => ({ required: true, authorized: sentCode === validCode }),
    };
  };
  window.eval(
    `const ACCESS_CODE_KEY = 'pharmaclear:demo-access-code';` +
    `let demoAccessCode = ''; let activeJob = null;` +
    `function $(id) { return document.getElementById(id); }` +
    `function show(id, visible) { $(id).hidden = !visible; }` +
    `function t(key) { return key; }` +
    `function showStep() {} function startPolling() {}` +
    appSource.slice(accessStart, accessEnd) +
    `window.initializeDemoAccess = initializeDemoAccess;`,
  );
  return dom;
}

test('valid URL access code unlocks the app and is removed from the address', async (t) => {
  const dom = createAccessHarness('https://pharmaclear.test/?code=valid-demo&keep=1#home', 'valid-demo');
  t.after(() => dom.window.close());
  const { window } = dom;

  await window.initializeDemoAccess();

  assert.equal(window.document.getElementById('access-panel').hidden, true);
  assert.equal(window.sessionStorage.getItem('pharmaclear:demo-access-code'), 'valid-demo');
  assert.equal(window.location.href, 'https://pharmaclear.test/?keep=1#home');
});

test('invalid URL access code shows the entry form, removes the stored code, and clears the address', async (t) => {
  const dom = createAccessHarness('https://pharmaclear.test/?code=wrong-demo&keep=1', 'valid-demo');
  t.after(() => dom.window.close());
  const { window } = dom;

  await window.initializeDemoAccess();

  assert.equal(window.document.getElementById('access-panel').hidden, false);
  assert.equal(window.document.getElementById('access-error').textContent, 'accessInvalid');
  assert.equal(window.sessionStorage.getItem('pharmaclear:demo-access-code'), null);
  assert.equal(window.location.href, 'https://pharmaclear.test/?keep=1');
});

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

test('photo inclusion option is shown only on the result screen when a preview exists', (t) => {
  const dom = createRenderer();
  t.after(() => dom.window.close());
  const { window } = dom;
  assert.ok(showStepEnd > showStepStart);
  window.eval(`${appSource.slice(showStepStart, showStepEnd)}\nwindow.runShowStep = showStep;`);

  window.runShowStep('progress');
  assert.equal(window.$('result-actions').hidden, true);
  assert.equal(window.$('include-photo-option').hidden, true);

  window.thumbObjectUrl = 'blob:prescription-test';
  window.runShowStep('result');
  assert.equal(window.$('result-actions').hidden, false);
  assert.equal(window.$('include-photo-option').hidden, false);

  window.runShowStep('pick');
  assert.equal(window.$('include-photo-option').hidden, true);
});

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
  window.releasePhotoPreview = () => {};
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
  window.releasePhotoPreview = () => {
    if (window.thumbObjectUrl) window.URL.revokeObjectURL(window.thumbObjectUrl);
    window.thumbObjectUrl = null;
  };
  window.setPhotoPreview = (blob) => {
    window.thumbObjectUrl = window.URL.createObjectURL(blob);
    window.$('thumb').src = window.thumbObjectUrl;
    window.$('thumb-preview').hidden = false;
  };
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
  assert.equal(window.$('thumb-preview').hidden, false);
  assert.equal(window.$('thumb').src, 'blob:sample');
  assert.equal(window.$('sample-banner').hidden, false);
  assert.match(window.$('sample-banner').textContent, /Sample result/);
  assert.match(window.$('result-content').textContent, /Ibuprofène/);
  assert.match(window.$('result-content').textContent, /Aspirine/);
});

test('releasePhotoPreview revokes its object URL and clears the in-memory image reference', (t) => {
  assert.ok(releasePreviewEnd > releasePreviewStart, 'releasePhotoPreview should exist');
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="thumb-preview"><img id="thumb" src="blob:photo"></button></body></html>',
    { runScripts: 'outside-only', url: 'https://pharmaclear.test/' },
  );
  t.after(() => dom.window.close());
  const { window } = dom;
  const revoked = [];
  window.$ = (id) => window.document.getElementById(id);
  window.show = (id, visible) => { window.$(id).hidden = !visible; };
  window.URL.revokeObjectURL = (url) => revoked.push(url);
  window.eval(
    `${appSource.slice(releasePreviewStart, releasePreviewEnd)}\n` +
    `let thumbObjectUrl = 'blob:photo';\n` +
    'window.releasePreview = releasePhotoPreview;\n' +
    'window.previewUrl = () => thumbObjectUrl;',
  );

  window.releasePreview();

  assert.deepEqual(revoked, ['blob:photo']);
  assert.equal(window.previewUrl(), null);
  assert.equal(window.$('thumb').hasAttribute('src'), false);
  assert.equal(window.$('thumb-preview').hidden, true);
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

test('AI suggestions render as a separate unverified section after the documented-status note', (t) => {
  const dom = createRenderer();
  t.after(() => dom.window.close());
  const { window } = dom;
  window.renderResult({
    status: 'success',
    interaction_status: 'not_verified',
    interactions: [{
      status: 'not_verified',
      drug_a: 'TEST-ONLY-A',
      drug_b: 'TEST-ONLY-B',
    }],
    ai_suggested_interactions: [{
      status: 'ai_suggested',
      source: 'model',
      review_status: 'ai_unverified',
      drug_a: 'TEST-ONLY-A',
      drug_b: 'TEST-ONLY-B',
      severity: 'caution',
      summary_en: 'TEST ONLY: English suggested summary.',
      summary_fr: 'TEST UNIQUEMENT : résumé suggéré en français.',
    }],
  });
  const content = window.document.querySelector('#result-content');
  const note = content.querySelector('.interaction-unverified');
  const aiCard = content.querySelector('.result-card--ai');
  assert.ok(note);
  assert.match(note.textContent, /No documented interaction found — not verified/);
  assert.ok(aiCard);
  assert.ok(note.compareDocumentPosition(aiCard) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.match(aiCard.querySelector('h2').textContent, /AI-suggested interactions \(not verified\)/);
  assert.match(aiCard.querySelector('.ai-interaction-disclaimer').textContent,
    /Generated by an AI model from general knowledge\. Not checked against a source\. Ask a pharmacist\./);
  assert.equal(aiCard.querySelector('.source-button'), null);
  assert.doesNotMatch(aiCard.textContent, /\bsafe\b/i);

  window.setRenderLanguage('fr', require('../public/i18n/fr.json'));
  window.renderResult({
    status: 'success',
    interactions: [],
    ai_suggested_interactions: [{
      status: 'ai_suggested',
      review_status: 'ai_unverified',
      drug_a: 'TEST-ONLY-A',
      drug_b: 'TEST-ONLY-B',
      severity: 'avoid',
      summary_en: 'TEST ONLY: English summary.',
      summary_fr: 'TEST UNIQUEMENT : résumé français.',
    }],
  });
  assert.match(window.document.querySelector('.result-card--ai h2').textContent,
    /Interactions suggérées par l’IA \(non vérifiées\)/);
  assert.equal(
    window.document.querySelector('.ai-interaction-summary').textContent,
    'TEST UNIQUEMENT : résumé français.',
  );
});

test('Fon users see English-only AI suggestions and the language limitation notice', (t) => {
  const dom = createRenderer('fon');
  t.after(() => dom.window.close());
  dom.window.renderResult({
    status: 'success',
    interactions: [{ status: 'not_verified', drug_a: 'TEST-ONLY-A', drug_b: 'TEST-ONLY-B' }],
    ai_suggested_interactions: [{
      status: 'ai_suggested',
      review_status: 'ai_unverified',
      drug_a: 'TEST-ONLY-A',
      drug_b: 'TEST-ONLY-B',
      severity: 'monitor',
      summary_en: 'TEST ONLY: English summary.',
      summary_fr: 'TEST UNIQUEMENT : résumé français.',
    }],
  });
  const card = dom.window.document.querySelector('.result-card--ai');
  assert.match(card.querySelector('h2').textContent, /AI-suggested interactions/);
  assert.equal(card.querySelector('.ai-language-note').textContent,
    'Shown in English or French only');
  assert.equal(card.querySelector('.ai-interaction-summary').textContent,
    'TEST ONLY: English summary.');
  assert.match(card.querySelector('.ai-severity-badge').textContent, /Monitor/);
});

test('interaction explanations follow the global language and show Fon provenance', (t) => {
  const dom = createRenderer();
  t.after(() => dom.window.close());
  const { window } = dom;
  const result = {
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
  };
  window.renderResult(result);
  assert.equal(window.document.querySelector('.explanation-picker'), null);
  assert.equal(
    window.document.querySelector('.interaction-summary').textContent,
    'TEST ONLY: English fixture.',
  );
  window.language = 'fr';
  window.renderResult(result);
  assert.equal(
    window.document.querySelector('.interaction-summary').textContent,
    'TEST ONLY: French fixture.',
  );
  window.language = 'fon';
  window.renderResult(result);
  assert.equal(
    window.document.querySelector('.interaction-summary').textContent,
    'TEST ONLY: speaker-written fixture.',
  );
  assert.equal(
    window.document.querySelector('.fon-provenance').textContent,
    'Written by a Fon speaker',
  );
  window.renderResult({
    status: 'success',
    interactions: [{
      status: 'verified',
      drug_a: 'TEST-ONLY-A',
      drug_b: 'TEST-ONLY-B',
      severity: 'caution',
      summary_en: 'TEST ONLY: English fixture.',
      summary_fr: 'TEST ONLY: French fixture.',
      summary_fon: 'TEST ONLY: machine-translation fixture.',
    }],
  });
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

test('print report shows the no-documentation warning, omits unchecked photo, and prints locally', (t) => {
  const dom = createRenderer();
  t.after(() => dom.window.close());
  const { window } = dom;
  const result = {
    status: 'success',
    detected_drugs: [{
      name: 'TEST-ONLY-READ',
      dosage: '10 mg',
      frequency: 'once daily',
      duration: '5 days',
    }],
    uncertain: [{ name: 'TEST-ONLY-UNCERTAIN', confidence: 0.3 }],
    interactions: [{ status: 'not_verified', drug_a: 'TEST-ONLY-A', drug_b: 'TEST-ONLY-B' }],
  };
  let printCalls = 0;
  let networkCalls = 0;
  window.latestResult = result;
  window.thumbObjectUrl = 'blob:prescription-test';
  window.document.title = 'PharmaClear';
  window.print = () => { printCalls++; };
  window.fetch = () => { networkCalls++; throw new Error('Print must not fetch'); };
  window.runPrintCurrentResult();
  const report = window.$('print-report');
  assert.equal(report.hidden, false);
  assert.match(report.textContent, /No documented interaction found — not verified\./);
  assert.match(report.textContent, /This does not mean the combination is safe\./);
  assert.match(report.textContent, /TEST-ONLY-READ/);
  assert.match(report.textContent, /TEST-ONLY-UNCERTAIN/);
  assert.equal(report.querySelector('img'), null);
  assert.equal(printCalls, 1);
  assert.equal(networkCalls, 0);
  assert.match(window.document.title, /^PharmaClear-\d{4}-\d{2}-\d{2}-\d{4}$/);
  window.dispatchEvent(new window.Event('afterprint'));
  assert.equal(report.hidden, true);
  assert.equal(window.document.title, 'PharmaClear');
});

test('print report includes photo only on request and labels an unreviewed documented alert', (t) => {
  const dom = createRenderer();
  t.after(() => dom.window.close());
  const report = dom.window.buildPrintReport({
    status: 'success',
    detected_drugs: [],
    uncertain: [],
    interactions: [{
      status: 'verified',
      review_status: 'unreviewed',
      drug_a: 'TEST-ONLY-A',
      drug_b: 'TEST-ONLY-B',
      severity: 'avoid',
      summary_en: 'TEST ONLY: documented explanation.',
      source: {
        title: 'TEST ONLY source title',
        url: 'https://example.invalid/source',
      },
    }],
    ai_suggested_interactions: [{
      status: 'ai_suggested',
      review_status: 'ai_unverified',
      drug_a: 'TEST-ONLY-C',
      drug_b: 'TEST-ONLY-D',
      severity: 'monitor',
      summary_en: 'TEST ONLY: AI explanation.',
      summary_fr: 'TEST UNIQUEMENT : explication IA.',
    }],
  }, {
    includePhoto: true,
    photoUrl: 'blob:prescription-test',
    now: new Date(2026, 10, 1, 14, 5),
  });
  const text = report.textContent;
  assert.match(text, /Not yet reviewed by a pharmacist \(unreviewed\)\./);
  assert.match(text, /TEST ONLY source title/);
  assert.match(text, /https:\/\/example\.invalid\/source/);
  assert.match(text, /AI-suggested interactions \(not verified\)/);
  assert.match(text, /Generated by an AI model from general knowledge/);
  assert.equal(report.querySelector('img').src, 'blob:prescription-test');
  assert.match(text, /01,?\s*2026|1,?\s*2026|2026/);
});

test('Fon print report falls back to English and preserves Fon characters in source summaries', (t) => {
  const dom = createRenderer('fon');
  t.after(() => dom.window.close());
  const glyphs = 'ɛ ɔ ɖ Ɖ Ɛ Ð';
  const report = dom.window.buildPrintReport({
    status: 'success',
    detected_drugs: [],
    uncertain: [],
    interactions: [{
      status: 'verified',
      review_status: 'reviewed',
      drug_a: 'TEST-ONLY-A',
      drug_b: 'TEST-ONLY-B',
      severity: 'monitor',
      summary_fon_human: glyphs,
    }],
  });
  assert.match(report.textContent, /PharmaClear — Prescription reading summary/);
  assert.match(report.textContent, /Medicines read with confidence/);
  assert.ok(report.textContent.includes(glyphs));
});
