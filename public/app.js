'use strict';

const params = new URLSearchParams(location.search);
const DEBUG_RELAY = params.get('debug') === '1';
const RELAY = '/relay';
const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.85;
const POLL_MS = 2000;
const STORAGE_KEY = 'pharmaclear:lastId';
const THUMB_KEY = 'pharmaclear:lastThumb';
const THUMB_SIDE = 700;
const JOB_DB = 'pharmaclear';
const JOB_STORE = 'pending';
const LANGUAGES = ['en', 'fr', 'fon'];

const $ = (id) => document.getElementById(id);
let language = 'en';
let translations = {};
let englishTranslations = {};
let pollTimer = null;
let activeJob = null;
let latestResult = null;
let latestResultIsSample = false;
let thumbObjectUrl = null;
let demoAccessCode = '';
let backendReachable = null;

function t(key, values = {}) {
  const template = translations[key] || englishTranslations[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
}

function applyStaticTranslations() {
  document.documentElement.lang = language;
  document.title = `PharmaClear — ${t('tagline')}`;
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  $('language-select').setAttribute('aria-label', t('languageLabel'));
  $('thumb').alt = t('photoInstructions');
}

async function setLanguage(nextLanguage) {
  if (!LANGUAGES.includes(nextLanguage)) throw new Error('Unsupported language');
  const response = await fetch(`/i18n/${nextLanguage}.json`);
  if (!response.ok) throw new Error(`Could not load ${nextLanguage} translations (HTTP ${response.status})`);
  const data = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Invalid ${nextLanguage} translations`);
  }
  language = nextLanguage;
  translations = data;
  try { localStorage.setItem('pharmaclear:language', language); } catch (error) { /* preference is optional */ }
  $('language-select').value = language;
  applyStaticTranslations();
  updateNetworkStatus();
  if (latestResult) renderResult(latestResult, latestResultIsSample);
  if ($('step-progress').hidden === false && activeJob) setProgress('resume');
}

function relayHeaders(extra) {
  const headers = Object.assign({}, extra);
  if (demoAccessCode) headers['X-Demo-Access-Code'] = demoAccessCode;
  return headers;
}

async function checkDemoAccess(code) {
  const response = await fetch('/api/access', {
    headers: code ? { 'X-Demo-Access-Code': code } : {},
  });
  if (!response.ok) throw new Error(`Access check failed (HTTP ${response.status})`);
  return response.json();
}

async function submitDemoAccess() {
  const code = $('access-code').value.trim();
  try {
    const access = await checkDemoAccess(code);
    if (!access.authorized) {
      $('access-error').textContent = t('accessInvalid');
      show('access-error', true);
      return;
    }
    demoAccessCode = code;
    try { sessionStorage.setItem('pharmaclear:demo-access-code', code); } catch (error) { /* session only */ }
    show('access-panel', false);
    show('access-error', false);
    if (activeJob) {
      showStep('progress');
      startPolling(activeJob);
    }
  } catch (error) {
    console.error('Could not validate demo access code:', error);
    $('access-error').textContent = t('errorUnexpected');
    show('access-error', true);
  }
}

function requestDemoAccess() {
  stopPolling();
  show('access-panel', true);
  $('access-error').textContent = t('accessInvalid');
  show('access-error', true);
  showStep('pick');
}

async function fetchTimeout(url, options = {}, ms = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function saveId(id) { try { localStorage.setItem(STORAGE_KEY, id); } catch (error) { /* optional recovery hint */ } }
function loadId() { try { return localStorage.getItem(STORAGE_KEY); } catch (error) { return null; } }
function clearId() { try { localStorage.removeItem(STORAGE_KEY); } catch (error) { /* optional recovery hint */ } }
function saveThumb(value) { try { localStorage.setItem(THUMB_KEY, value); } catch (error) { /* optional preview */ } }
function loadThumb() { try { return localStorage.getItem(THUMB_KEY); } catch (error) { return null; } }
function clearThumb() { try { localStorage.removeItem(THUMB_KEY); } catch (error) { /* optional preview */ } }

function openJobDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(JOB_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(JOB_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local storage'));
  });
}

async function saveJob(job) {
  const db = await openJobDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(JOB_STORE, 'readwrite');
    transaction.objectStore(JOB_STORE).put(job);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Could not save the photo locally'));
    transaction.onabort = () => reject(transaction.error || new Error('Local save was cancelled'));
  });
  db.close();
}

async function loadJobs() {
  const db = await openJobDb();
  const jobs = await new Promise((resolve, reject) => {
    const request = db.transaction(JOB_STORE, 'readonly').objectStore(JOB_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not read the local queue'));
  });
  db.close();
  return jobs;
}

async function deleteJob(id) {
  const db = await openJobDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(JOB_STORE, 'readwrite');
    transaction.objectStore(JOB_STORE).delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Could not delete the local photo'));
    transaction.onabort = () => reject(transaction.error || new Error('Local deletion was cancelled'));
  });
  db.close();
}

function show(id, visible) { $(id).hidden = !visible; }

function showError(message) {
  $('error').textContent = message;
  show('error', true);
}

function showStep(step) {
  show('step-pick', step === 'pick');
  show('step-progress', step === 'progress');
  show('step-result', step === 'result');
}

function updateNetworkStatus() {
  if (!navigator.onLine) {
    $('network-status').textContent = t('networkOffline');
  } else if (backendReachable === false) {
    $('network-status').textContent = t('networkServerUnavailable');
  } else if (backendReachable === null) {
    $('network-status').textContent = t('networkChecking');
  } else {
    $('network-status').textContent = t('networkOnline');
  }
}

async function checkBackend() {
  if (!navigator.onLine) {
    backendReachable = false;
    updateNetworkStatus();
    return;
  }
  try {
    const response = await fetchTimeout('/api/health', { cache: 'no-store' }, 3000);
    backendReachable = response.ok;
  } catch (error) {
    backendReachable = false;
  }
  updateNetworkStatus();
}

async function checkRelay() {
  if (!DEBUG_RELAY) return;
  const detail = $('relay-detail');
  try {
    const response = await fetchTimeout(`${RELAY}/health`, {}, 3000);
    detail.textContent = response.ok
      ? 'Relay connected'
      : `Relay returned HTTP ${response.status}`;
  } catch (error) {
    detail.textContent = 'Relay unavailable';
  }
}

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch (error) { /* use image element fallback */ }
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Unreadable image')); };
    image.src = url;
  });
}

function drawScaled(source, width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function prepareImage(file) {
  const source = await loadBitmap(file);
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const canvas = drawScaled(source, width, height, MAX_SIDE);
  const thumbDataUrl = drawScaled(source, width, height, THUMB_SIDE)
    .toDataURL('image/jpeg', 0.7);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve({ blob, thumbDataUrl })
      : reject(new Error('Image compression failed'))), 'image/jpeg', JPEG_QUALITY);
  });
}

function setProgress(state) {
  const title = $('status-title');
  const detail = $('status-detail');
  $('spinner').classList.remove('stopped');
  if (state === 'sending' || state === 'resume') {
    title.textContent = state === 'resume' ? t('resume') : t('reading');
    detail.textContent = t('checkingInteractions');
  } else if (state === 'queued') {
    title.textContent = t('reading');
    detail.textContent = t('queuedDetail');
  } else if (state === 'retry') {
    title.textContent = t('retry');
    detail.textContent = t('retryDetail');
  } else if (state === 'offline') {
    title.textContent = t('offlineProgress');
    detail.textContent = t('offlineDetail');
  }
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function showJobThumb(job) {
  const thumb = $('thumb');
  if (thumbObjectUrl) URL.revokeObjectURL(thumbObjectUrl);
  thumbObjectUrl = job.blob ? URL.createObjectURL(job.blob) : null;
  thumb.src = thumbObjectUrl || job.thumbDataUrl || '';
  show('thumb', Boolean(thumb.src));
}

async function failJob(job, message) {
  stopPolling();
  try {
    await deleteJob(job.id);
  } catch (error) {
    console.error('Could not delete failed local photo:', error);
    showError(t('errorDeletePending'));
    showStep('pick');
    return;
  }
  activeJob = null;
  clearId();
  clearThumb();
  showError(message);
  showStep('pick');
}

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addField(parent, label, value) {
  if (value === undefined || value === null || String(value).trim() === '') return;
  const row = makeElement('div', null);
  const name = makeElement('strong', null, `${label}: `);
  row.append(name, document.createTextNode(String(value)));
  parent.appendChild(row);
}

function safeSourceLink(sourceUrl, title) {
  if (typeof sourceUrl !== 'string') return null;
  try {
    const url = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const link = makeElement('a', 'source-link', title || sourceUrl);
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  } catch (error) {
    return null;
  }
}

function renderResult(result, isSample = false) {
  const box = $('result-content');
  box.replaceChildren();
  const data = result && typeof result === 'object' ? result : {};
  show('sample-banner', isSample);
  $('sample-banner').textContent = t('sampleBanner');
  show('mock-banner', !isSample &&
    typeof data.status === 'string' && data.status.toUpperCase().includes('MOCK'));
  $('mock-banner').textContent = t('mockBanner');
  const interactions = Array.isArray(data.interactions) ? data.interactions : [];
  const verified = interactions.filter((item) => item && item.status === 'verified');
  const unverifiedCount = interactions.filter((item) => item && item.status === 'not_verified').length;
  const uncertain = Array.isArray(data.uncertain) ? data.uncertain : [];
  const detected = Array.isArray(data.detected_drugs) ? data.detected_drugs : [];
  const cards = makeElement('div', 'result');

  if (data.status === 'error') {
    cards.appendChild(makeElement('section', 'result-card result-card--plain',
      data.error_code === 'daily_limit'
        ? t('dailyLimitReached')
        : data.error_code === 'analysis_limit_unavailable'
          ? t('dailyLimitUnavailable')
          : data.error || t('errorAnalysis')));
    box.appendChild(cards);
    return;
  }

  const interactionCard = makeElement(
    'section',
    `result-card ${verified.length ? 'result-card--verified' : 'result-card--plain'}`,
  );
  const interactionHeading = makeElement('h2');
  interactionHeading.append(
    makeElement('span', 'card-icon', verified.length ? '!' : 'i'),
    makeElement('span', null, t('verifiedTitle')),
  );
  interactionCard.appendChild(interactionHeading);

  if (verified.length) {
    for (const interaction of verified) {
      const item = makeElement('div', 'interaction-item');
      const summary = language === 'fr'
        ? interaction.summary_fr
        : interaction.summary_en || interaction.summary_fr || interaction.text?.en || interaction.text?.fr;
      item.appendChild(makeElement('p', null,
        `${interaction.drug_a || ''} + ${interaction.drug_b || ''}`));
      if (summary) item.appendChild(makeElement('p', null, summary));
      item.appendChild(makeElement('p', null, t('severity', { severity: interaction.severity || '—' })));
      const source = safeSourceLink(
        interaction.source_url || interaction.source?.url,
        interaction.source?.title || interaction.source || t('source'),
      );
      if (source) item.appendChild(source);

      const fonExplanation = typeof interaction.summary_fon === 'string' &&
        interaction.summary_fon.trim();
      if (language === 'fon' && fonExplanation) {
        item.appendChild(makeElement('strong', null, t('explanation')));
        item.appendChild(makeElement('p', null, fonExplanation));
        item.appendChild(makeElement('p', 'lang-note', t('fonDisclaimer')));
      } else if (language === 'fon' && interaction.summary_fon_status === 'unavailable') {
        item.appendChild(makeElement('p', null, t('fonUnavailable')));
      }
      interactionCard.appendChild(item);
    }
  } else if (unverifiedCount > 0) {
    interactionCard.appendChild(makeElement('p', null,
      t('notVerifiedSummary', { count: unverifiedCount })));
  } else {
    interactionCard.appendChild(makeElement('p', null, t('noPairs')));
  }

  if (interactions.length && unverifiedCount > 0 && verified.length > 0) {
    interactionCard.appendChild(makeElement('p', null,
      t('notVerifiedSummary', { count: unverifiedCount })));
  }
  cards.appendChild(interactionCard);

  const uncertainCard = makeElement('section', 'result-card result-card--uncertain');
  const uncertainHeading = makeElement('h2');
  uncertainHeading.append(
    makeElement('span', 'card-icon', '?'),
    makeElement('span', null, t('uncertainTitle')),
  );
  uncertainCard.appendChild(uncertainHeading);
  if (data.status === 'not_a_prescription') {
    uncertainCard.appendChild(makeElement('p', null, t('notPrescription')));
  }
  if (data.image_quality && data.image_quality !== 'good') {
    uncertainCard.appendChild(makeElement('p', null,
      t('uncertainImage', { quality: data.image_quality })));
  }
  if (typeof data.notes === 'string' && data.notes.trim()) {
    uncertainCard.appendChild(makeElement('p', null, t('uncertainNotes', { notes: data.notes })));
  }
  if (uncertain.length) {
    const list = makeElement('ul', 'drug-list');
    for (const drug of uncertain) {
      const item = makeElement('li', 'drug-item');
      item.appendChild(makeElement('strong', null, drug && drug.name || t('noName')));
      addField(item, t('fieldDosage'), drug && drug.dosage);
      addField(item, t('fieldFrequency'), drug && drug.frequency);
      addField(item, t('fieldDuration'), drug && drug.duration);
      list.appendChild(item);
    }
    uncertainCard.appendChild(list);
    uncertainCard.appendChild(makeElement('p', null, t('unverifiedMedicines')));
  } else {
    uncertainCard.appendChild(makeElement('p', null, t('uncertainEmpty')));
  }
  cards.appendChild(uncertainCard);

  const readCard = makeElement('section', 'result-card result-card--read');
  const readHeading = makeElement('h2');
  readHeading.append(
    makeElement('span', 'card-icon', '✓'),
    makeElement('span', null, t('detectedTitle')),
  );
  readCard.appendChild(readHeading);
  if (detected.length) {
    const list = makeElement('ul', 'drug-list');
    for (const drug of detected) {
      const item = makeElement('li', 'drug-item');
      item.appendChild(makeElement('strong', null, drug && drug.name || t('noName')));
      addField(item, t('fieldDosage'), drug && drug.dosage);
      addField(item, t('fieldFrequency'), drug && drug.frequency);
      addField(item, t('fieldDuration'), drug && drug.duration);
      list.appendChild(item);
    }
    readCard.appendChild(list);
  } else {
    readCard.appendChild(makeElement('p', null, t('detectedEmpty')));
  }
  cards.appendChild(readCard);
  box.appendChild(cards);

}

async function showResult(result) {
  stopPolling();
  if (activeJob) {
    try {
      await deleteJob(activeJob.id);
    } catch (error) {
      console.error('Could not delete local photo after result:', error);
      showError(t('errorDeleteResult'));
    }
  }
  activeJob = null;
  clearId();
  clearThumb();
  if (thumbObjectUrl) URL.revokeObjectURL(thumbObjectUrl);
  thumbObjectUrl = null;
  $('thumb').removeAttribute('src');
  show('thumb', false);
  latestResult = result;
  latestResultIsSample = false;
  renderResult(result);
  showStep('result');
}

function startPolling(job) {
  stopPolling();
  let retryDelay = POLL_MS;
  const tick = async () => {
    try {
      if (!job.relayId) {
        if (!navigator.onLine) {
          setProgress('offline');
          pollTimer = setTimeout(tick, Math.min(30000, retryDelay));
          retryDelay = Math.min(30000, retryDelay * 2);
          return;
        }
        setProgress('sending');
        const upload = await fetchTimeout(`${RELAY}/upload`, {
          method: 'POST',
          headers: relayHeaders({ 'Content-Type': 'image/jpeg' }),
          body: job.blob,
        }, 30000);
        if (upload.status === 401) {
          requestDemoAccess();
          return;
        }
        if (upload.status === 429) {
          const seconds = Math.max(1, Number(upload.headers.get('Retry-After')) || 60);
          $('status-title').textContent = t('retry');
          $('status-detail').textContent = t('rateLimitWait', { seconds });
          pollTimer = setTimeout(tick, seconds * 1000);
          return;
        }
        if (upload.status === 400 || upload.status === 413) {
          let reason = t('errorRelay', { status: upload.status });
          try {
            const data = await upload.json();
            if (data.error) reason = data.error;
          } catch (error) { /* response may not be JSON */ }
          await failJob(job, reason);
          return;
        }
        if (!upload.ok) throw new Error(`Upload HTTP ${upload.status}`);
        const data = await upload.json();
        if (typeof data.id !== 'string' || !data.id) throw new Error(t('errorRelayId'));
        job.relayId = data.id;
        job.blob = null;
        await saveJob(job);
        saveId(job.relayId);
      }

      const response = await fetchTimeout(
        `${RELAY}/status/${encodeURIComponent(job.relayId)}`,
        { headers: relayHeaders() },
        8000,
      );
      if (response.status === 401) {
        requestDemoAccess();
        return;
      }
      if (response.status === 429) {
        const seconds = Math.max(1, Number(response.headers.get('Retry-After')) || 60);
        $('status-title').textContent = t('retry');
        $('status-detail').textContent = t('rateLimitWait', { seconds });
        pollTimer = setTimeout(tick, seconds * 1000);
        return;
      }
      if (response.status === 404) {
        await failJob(job, t('errorExpired'));
        return;
      }
      if (!response.ok) throw new Error(`Status HTTP ${response.status}`);
      const data = await response.json();
      if (data.status === 'done') {
        try {
          await showResult(data.result);
        } catch (error) {
          stopPolling();
          console.error('Relay returned a completed result, but the page could not render it:', error);
          showError(t('errorUnexpected'));
          showStep('result');
        }
        return;
      }
      retryDelay = POLL_MS;
      setProgress('queued');
    } catch (error) {
      console.warn('Relay request failed; retrying:', error.message);
      setProgress(navigator.onLine ? 'retry' : 'offline');
      retryDelay = Math.min(30000, retryDelay * 2);
    }
    pollTimer = setTimeout(tick, retryDelay);
  };
  tick();
}

async function handleFile(file) {
  if (!file) return;
  show('error', false);
  if (activeJob) {
    showError(t('errorActiveJob'));
    return;
  }

  let blob;
  let thumbDataUrl;
  try {
    ({ blob, thumbDataUrl } = await prepareImage(file));
  } catch (error) {
    showError(t('errorImage'));
    showStep('pick');
    return;
  }

  const id = (crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  activeJob = { id, blob, thumbDataUrl, relayId: null, createdAt: Date.now() };
  try {
    await saveJob(activeJob);
  } catch (error) {
    console.error('Could not save photo locally:', error);
    activeJob = null;
    showError(t('errorLocalStorage'));
    showStep('pick');
    return;
  }

  saveThumb(thumbDataUrl);
  showJobThumb(activeJob);
  showStep('progress');
  setProgress(navigator.onLine ? 'sending' : 'offline');
  startPolling(activeJob);
}

async function handleSample() {
  if (activeJob) {
    showError(t('errorActiveJob'));
    return;
  }
  show('error', false);
  try {
    const [imageResponse, resultResponse] = await Promise.all([
      fetch('/samples/sample-prescription.png'),
      fetch('/samples/sample-result.json'),
    ]);
    if (!imageResponse.ok || !resultResponse.ok) throw new Error(t('errorNoSample'));
    const [imageBlob, result] = await Promise.all([
      imageResponse.blob(),
      resultResponse.json(),
    ]);
    latestResult = result;
    latestResultIsSample = true;
    if (thumbObjectUrl) URL.revokeObjectURL(thumbObjectUrl);
    thumbObjectUrl = URL.createObjectURL(imageBlob);
    $('thumb').src = thumbObjectUrl;
    show('thumb', true);
    renderResult(result, true);
    showStep('result');
  } catch (error) {
    console.error('Could not load the precomputed synthetic sample:', error);
    showError(t('errorNoSample'));
    showStep('pick');
  }
}

async function resetAll() {
  stopPolling();
  if (activeJob) {
    try {
      await deleteJob(activeJob.id);
    } catch (error) {
      console.error('Could not delete pending local photo:', error);
      showError(t('errorLocalDelete'));
      return;
    }
    activeJob = null;
  }
  clearId();
  clearThumb();
  latestResult = null;
  latestResultIsSample = false;
  show('error', false);
  if (thumbObjectUrl) URL.revokeObjectURL(thumbObjectUrl);
  thumbObjectUrl = null;
  $('thumb').removeAttribute('src');
  show('thumb', false);
  $('cam').value = '';
  $('gal').value = '';
  showStep('pick');
}

async function resumePendingJob() {
  try {
    let jobs = await loadJobs();
    if (jobs.length === 0) {
      const oldId = loadId();
      if (oldId) {
        const legacyJob = {
          id: `legacy-${oldId}`,
          relayId: oldId,
          blob: null,
          thumbDataUrl: loadThumb(),
          createdAt: Date.now(),
        };
        await saveJob(legacyJob);
        clearId();
        clearThumb();
        jobs = [legacyJob];
      }
    }
    if (jobs.length === 0) return;
    jobs.sort((first, second) => first.createdAt - second.createdAt);
    activeJob = jobs[0];
    showJobThumb(activeJob);
    showStep('progress');
    setProgress(navigator.onLine ? 'resume' : 'offline');
    startPolling(activeJob);
  } catch (error) {
    console.error('Could not resume the local queue:', error);
    showError(t('errorLocalRead'));
  }
}

async function initialize() {
  $('debug-relay').hidden = !DEBUG_RELAY;
  try {
    demoAccessCode = sessionStorage.getItem('pharmaclear:demo-access-code') || '';
  } catch (error) { /* demo code is session-scoped */ }
  const savedLanguage = (() => {
    try { return localStorage.getItem('pharmaclear:language'); } catch (error) { return null; }
  })();
  try {
    const response = await fetch('/i18n/en.json');
    if (!response.ok) throw new Error(`Could not load English translations (HTTP ${response.status})`);
    englishTranslations = await response.json();
    await setLanguage(LANGUAGES.includes(savedLanguage) ? savedLanguage : 'en');
  } catch (error) {
    console.error('Could not initialize translations:', error);
    $('error').textContent = error.message;
    show('error', true);
  }

  try {
    const access = await checkDemoAccess(demoAccessCode);
    show('access-panel', access.required && !access.authorized);
  } catch (error) {
    console.error('Could not check demo access requirement:', error);
  }
  $('cam').addEventListener('change', (event) => handleFile(event.target.files[0]));
  $('gal').addEventListener('change', (event) => handleFile(event.target.files[0]));
  $('new-btn').addEventListener('click', resetAll);
  $('sample-btn').addEventListener('click', handleSample);
  $('access-submit').addEventListener('click', submitDemoAccess);
  $('access-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitDemoAccess();
  });
  $('language-select').addEventListener('change', async (event) => {
    try {
      await setLanguage(event.target.value);
    } catch (error) {
      console.error('Could not switch language:', error);
      event.target.value = language;
      showError(t('errorUnexpected'));
    }
  });
  window.addEventListener('online', () => {
    checkBackend();
    checkRelay();
    if (activeJob) startPolling(activeJob);
  });
  window.addEventListener('offline', () => {
    backendReachable = false;
    updateNetworkStatus();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js')
      .catch((error) => console.error('Could not register the offline cache:', error));
  }
  await checkBackend();
  setInterval(checkBackend, 4000);
  checkRelay();
  if (DEBUG_RELAY) setInterval(checkRelay, 4000);
  await resumePendingJob();
}

initialize();
