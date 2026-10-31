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
  show('new-btn', step === 'result');
}

function updateNetworkStatus() {
  const status = $('network-status');
  const label = $('network-label');
  if (!navigator.onLine) {
    label.textContent = t('networkOffline');
    status.classList.remove('is-online');
    status.classList.add('is-offline');
  } else if (backendReachable === false) {
    label.textContent = t('networkServerUnavailable');
    status.classList.remove('is-online');
    status.classList.add('is-offline');
  } else if (backendReachable === null) {
    label.textContent = t('networkChecking');
    status.classList.remove('is-online', 'is-offline');
  } else {
    label.textContent = t('networkOnline');
    status.classList.remove('is-offline');
    status.classList.add('is-online');
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
  let currentStep = 0;
  if (state === 'sending') {
    title.textContent = t('sending');
    detail.textContent = t('reading');
    currentStep = 0;
  } else if (state === 'checking') {
    title.textContent = t('checkingInteractions');
    detail.textContent = '';
    currentStep = 2;
  } else if (state === 'resume') {
    title.textContent = t('resume');
    detail.textContent = t('reading');
    currentStep = 1;
  } else if (state === 'queued') {
    title.textContent = t('reading');
    detail.textContent = t('queuedDetail');
    currentStep = 1;
  } else if (state === 'retry') {
    title.textContent = t('retry');
    detail.textContent = t('retryDetail');
    currentStep = activeJob && activeJob.relayId ? 1 : 0;
  } else if (state === 'offline') {
    title.textContent = t('offlineProgress');
    detail.textContent = t('offlineDetail');
    currentStep = activeJob && activeJob.relayId ? 1 : 0;
  }
  document.querySelectorAll('[data-progress-step]').forEach((item, index) => {
    item.classList.toggle('is-current', index === currentStep);
    item.classList.toggle('is-complete', index < currentStep);
  });
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

  const icon = (name, className = 'icon') => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.appendChild(use);
    return svg;
  };
  const heading = (symbol, text) => {
    const node = makeElement('h2');
    node.append(icon(symbol), makeElement('span', null, text));
    return node;
  };
  const pill = (text, className = 'data-pill') => makeElement('span', className, text);
  const addDrug = (list, drug, isUncertain) => {
    const item = makeElement('li', 'drug-item');
    const name = makeElement('div', 'drug-name');
    name.append(icon('pill'), makeElement('strong', null,
      drug && typeof drug.name === 'string' && drug.name.trim()
        ? drug.name
        : t('noName')));
    item.appendChild(name);
    const pills = makeElement('div', 'drug-pills');
    for (const [field, labelKey] of [
      ['dosage', 'fieldDosage'],
      ['frequency', 'fieldFrequency'],
      ['duration', 'fieldDuration'],
    ]) {
      const value = drug && drug[field];
      if (value !== undefined && value !== null && String(value).trim()) {
        pills.appendChild(pill(`${t(labelKey)}: ${String(value)}`));
      } else if (isUncertain) {
        pills.appendChild(pill(t(`${labelKey}Missing`), 'data-pill data-pill--missing'));
      }
    }
    if (pills.childElementCount) item.appendChild(pills);

    if (isUncertain && Number.isFinite(drug && drug.confidence)) {
      const confidence = Number(drug.confidence);
      const level = confidence < 0.4 ? 'low' : confidence < 0.7 ? 'medium' : 'high';
      const row = makeElement('div', 'confidence-row');
      row.append(
        makeElement('span', 'confidence-label', t('confidenceLabel')),
        makeElement('span', `confidence-badge confidence-badge--${level}`, t(`confidence${level[0].toUpperCase()}${level.slice(1)}`)),
      );
      item.appendChild(row);
    }
    list.appendChild(item);
  };

  const summary = makeElement('section', 'result-summary');
  summary.appendChild(makeElement('h1', null, t('resultSummary')));
  const counts = makeElement('div', 'summary-counts');
  for (const [className, count, label] of [
    ['summary-count--alert', verified.length, 'alertCount'],
    ['summary-count--uncertain', uncertain.length, 'uncertainCount'],
    ['summary-count--read', detected.length, 'readCount'],
  ]) {
    const counter = makeElement('div', `summary-count ${className}`);
    counter.append(
      makeElement('strong', null, String(count)),
      makeElement('span', null, t(label)),
    );
    counts.appendChild(counter);
  }
  summary.appendChild(counts);
  cards.appendChild(summary);

  if (data.status === 'error') {
    cards.appendChild(makeElement('section', 'result-card result-card--error',
      data.error_code === 'daily_limit'
        ? t('dailyLimitReached')
        : data.error_code === 'analysis_limit_unavailable'
          ? t('dailyLimitUnavailable')
          : data.error || t('errorAnalysis')));
    box.appendChild(cards);
    return;
  }

  if (verified.length) {
    const interactionCard = makeElement('section', 'result-card result-card--verified');
    interactionCard.appendChild(heading('alert', t('verifiedTitle')));
    for (const interaction of verified) {
      const item = makeElement('article', 'interaction-entry');
      const drugs = makeElement('div', 'interaction-drugs');
      drugs.append(
        pill(interaction.drug_a || t('noName'), 'drug-pill'),
        makeElement('span', 'interaction-plus', '+'),
        pill(interaction.drug_b || t('noName'), 'drug-pill'),
      );
      item.appendChild(drugs);
      const meta = makeElement('div', 'interaction-meta');
      const severityKey = {
        avoid: 'severityAvoid',
        caution: 'severityCaution',
        monitor: 'severityMonitor',
      }[interaction.severity];
      meta.appendChild(makeElement('span', 'severity-badge',
        t('severity', { severity: severityKey ? t(severityKey) : '—' })));
      item.appendChild(meta);
      if (interaction.review_status === 'unreviewed') {
        const source = interaction.source || {};
        const sourceName = language === 'fr'
          ? source.display_name_fr || source.display_name_en || source.title || ''
          : source.display_name_en || source.display_name || source.title || '';
        const sourceDate = source.publication_date
          ? new Intl.DateTimeFormat(language === 'fr' ? 'fr' : 'en', {
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          }).format(new Date(`${source.publication_date}-01T00:00:00Z`))
          : source.accessed || '';
        item.appendChild(makeElement('p', 'unreviewed-note',
          t('unreviewedNote', { source: sourceName, date: sourceDate })));
        if (language === 'fon') {
          item.appendChild(makeElement('p', 'source-citation',
            t('sourceCitation', { source: sourceName, date: sourceDate })));
        }
      }

      const languageSelect = makeElement('select', 'explanation-picker');
      languageSelect.setAttribute('aria-label', t('interactionLanguage'));
      for (const [value, label] of [['en', 'EN'], ['fr', 'FR'], ['fon', 'Fon']]) {
        const option = makeElement('option', null, label);
        option.value = value;
        languageSelect.appendChild(option);
      }
      languageSelect.value = language;
      const explanation = makeElement('p', 'interaction-summary');
      const provenance = makeElement('p', 'fon-provenance');
      const renderExplanation = (selectedLanguage) => {
        let text = '';
        let origin = '';
        if (selectedLanguage === 'fr') {
          text = interaction.summary_fr || interaction.summary_en || '';
        } else if (selectedLanguage === 'fon') {
          if (typeof interaction.summary_fon_human === 'string' &&
              interaction.summary_fon_human.trim()) {
            text = interaction.summary_fon_human;
            origin = t('fonSpeakerProvenance');
          } else if (typeof interaction.summary_fon === 'string' &&
              interaction.summary_fon.trim()) {
            text = interaction.summary_fon;
            origin = t('fonDisclaimer');
          } else {
            text = t('fonUnavailable');
          }
        } else {
          text = interaction.summary_en || interaction.summary_fr || '';
        }
        explanation.textContent = text;
        provenance.textContent = origin;
        provenance.hidden = !origin;
      };
      renderExplanation(languageSelect.value);
      languageSelect.addEventListener('change', () => renderExplanation(languageSelect.value));
      item.append(languageSelect, explanation, provenance);

      const source = safeSourceLink(
        interaction.source_url || interaction.source?.url,
        interaction.source?.title || interaction.source || t('source'),
      );
      if (source) {
        source.className = 'source-button';
        source.prepend(icon('link'));
        source.appendChild(icon('arrow'));
        item.appendChild(source);
      }
      interactionCard.appendChild(item);
    }
    cards.appendChild(interactionCard);
  }

  const hasUncertainty = uncertain.length > 0 || data.status === 'not_a_prescription' ||
    (data.image_quality && data.image_quality !== 'good') ||
    (typeof data.notes === 'string' && data.notes.trim());
  if (hasUncertainty) {
    const uncertainCard = makeElement('section', 'result-card result-card--uncertain');
    uncertainCard.appendChild(heading('question', t('uncertainTitle')));
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
      for (const drug of uncertain) addDrug(list, drug, true);
      uncertainCard.appendChild(list);
      uncertainCard.appendChild(makeElement('p', null, t('unverifiedMedicines')));
    }
    cards.appendChild(uncertainCard);
  }

  if (detected.length) {
    const readCard = makeElement('section', 'result-card result-card--read');
    readCard.appendChild(heading('check', t('detectedTitle')));
    const list = makeElement('ul', 'drug-list');
    for (const drug of detected) addDrug(list, drug, false);
    readCard.appendChild(list);
    cards.appendChild(readCard);
  }

  if (unverifiedCount > 0) {
    const unverified = makeElement('p', 'interaction-unverified');
    unverified.append(
      icon('info'),
      makeElement('span', null, t('notVerifiedSummary', { count: unverifiedCount })),
    );
    cards.appendChild(unverified);
  }
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
  try {
    renderResult(result);
    showStep('result');
  } catch (error) {
    stopPolling();
    console.error('Could not display the result:', error);
    showError(t('resultDisplayFailure'));
    showStep('result');
  }
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
