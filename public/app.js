'use strict';

const params = new URLSearchParams(location.search);

// Adresse du relais : même machine que cette page, port 8080.
// On peut la forcer avec ?relay=http://192.168.1.20:8080
const RELAY = params.get('relay') ||
  (location.protocol === 'https:' ? '/relay'
    : location.hostname ? `${location.protocol}//${location.hostname}:8080`
                     : 'http://localhost:8080');
// Si le serveur C est lancé avec PHARMA_TOKEN, ouvrir la page avec ?token=...
const TOKEN = params.get('token') || '';

const MAX_SIDE = 1600;      // une photo de téléphone dépasse souvent 5 Mo : on la réduit
const JPEG_QUALITY = 0.85;
const POLL_MS = 2000;
const STORAGE_KEY = 'pharmaclear:lastId';
const THUMB_KEY = 'pharmaclear:lastThumb';
const THUMB_SIDE = 700;     // petite miniature gardée pour la reprise après rechargement
const JOB_DB = 'pharmaclear';
const JOB_STORE = 'pending';

const $ = (id) => document.getElementById(id);

function relayHeaders(extra) {
  const h = Object.assign({}, extra);
  if (TOKEN) h['X-Token'] = TOKEN;
  return h;
}

async function fetchTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function saveId(id) { try { localStorage.setItem(STORAGE_KEY, id); } catch (e) { /* stockage indisponible */ } }
function loadId()   { try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; } }
function clearId()  { try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* rien */ } }
function saveThumb(u) { try { localStorage.setItem(THUMB_KEY, u); } catch (e) { /* trop gros ou indisponible */ } }
function loadThumb()  { try { return localStorage.getItem(THUMB_KEY); } catch (e) { return null; } }
function clearThumb() { try { localStorage.removeItem(THUMB_KEY); } catch (e) { /* rien */ } }

function openJobDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(JOB_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(JOB_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('impossible d’ouvrir le stockage local'));
  });
}

async function saveJob(job) {
  const db = await openJobDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(JOB_STORE, 'readwrite');
    transaction.objectStore(JOB_STORE).put(job);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('impossible d’enregistrer la photo localement'));
    transaction.onabort = () => reject(transaction.error || new Error('enregistrement local annulé'));
  });
  db.close();
}

async function loadJobs() {
  const db = await openJobDb();
  const jobs = await new Promise((resolve, reject) => {
    const request = db.transaction(JOB_STORE, 'readonly').objectStore(JOB_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('impossible de lire la file locale'));
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
    transaction.onerror = () => reject(transaction.error || new Error('impossible de supprimer la photo locale'));
    transaction.onabort = () => reject(transaction.error || new Error('suppression locale annulée'));
  });
  db.close();
}

function show(id, visible) { $(id).hidden = !visible; }

function showError(msg) {
  $('error').textContent = msg;
  show('error', true);
}

function showStep(step) { // 'pick' | 'progress' | 'result'
  show('step-pick', step === 'pick');
  show('step-progress', step === 'progress');
  show('step-result', step === 'result');
}

async function checkRelay() {
  const el = $('relay');
  try {
    const r = await fetchTimeout(RELAY + '/health', {}, 3000);
    if (!r.ok) throw new Error('health');
    el.textContent = 'Relais connecté';
    el.className = 'pill pill-ok';
  } catch (e) {
    el.textContent = 'Relais injoignable';
    el.className = 'pill pill-bad';
  }
}

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch (e) { /* on essaie autrement */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image illisible')); };
    img.src = url;
  });
}

function drawScaled(src, w, h, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';               // fond blanc (utile pour les PNG transparents)
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function prepareImage(file) {
  const src = await loadBitmap(file);
  const w = src.naturalWidth || src.width;
  const h = src.naturalHeight || src.height;
  const canvas = drawScaled(src, w, h, MAX_SIDE);
  const thumbDataUrl = drawScaled(src, w, h, THUMB_SIDE).toDataURL('image/jpeg', 0.7);

  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve({ blob: b, thumbDataUrl })
                           : reject(new Error('compression impossible'))),
                  'image/jpeg', JPEG_QUALITY);
  });
}

function setProgress(state) {
  const title = $('status-title');
  const detail = $('status-detail');
  $('spinner').classList.remove('stopped');
  if (state === 'sending') {
    title.textContent = 'Envoi de la photo au relais…';
    detail.textContent = '';
  } else if (state === 'queued') {
    title.textContent = 'Photo reçue, en file d\'attente';
    detail.textContent = 'Elle est analysée dès que possible. Si le réseau est coupé, ' +
                         'elle est gardée et part automatiquement au retour du réseau.';
  } else if (state === 'retry') {
    title.textContent = 'Relais injoignable…';
    detail.textContent = 'La photo est gardée sur ce téléphone. Nouvelle tentative automatique au retour du réseau.';
  } else if (state === 'offline') {
    title.textContent = 'Hors connexion : photo gardée sur ce téléphone';
    detail.textContent = 'Elle sera envoyée automatiquement quand le réseau et le relais seront disponibles.';
  } else if (state === 'resume') {
    title.textContent = 'Reprise du suivi de l\'ordonnance…';
    detail.textContent = '';
  }
}

let pollTimer = null;
let activeJob = null;

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function showJobThumb(job) {
  const thumb = $('thumb');
  if (thumb.src.startsWith('blob:')) URL.revokeObjectURL(thumb.src);
  thumb.src = job.blob ? URL.createObjectURL(job.blob) : (job.thumbDataUrl || '');
  show('thumb', Boolean(thumb.src));
}

async function failJob(job, message) {
  stopPolling();
  try {
    await deleteJob(job.id);
  } catch (e) {
    console.error('Suppression de la photo en attente impossible :', e);
    showError('La demande a échoué et sa copie locale n’a pas pu être supprimée. ' +
              'Supprime les données du site depuis les paramètres du navigateur.');
    showStep('pick');
    return;
  }
  activeJob = null;
  clearId();
  clearThumb();
  showError(message);
  showStep('pick');
}

async function showResult(result) {
  stopPolling();
  if (activeJob) {
    try {
      await deleteJob(activeJob.id);
    } catch (e) {
      console.error('Suppression de la photo locale après résultat impossible :', e);
      showError('Résultat reçu, mais la copie locale n’a pas pu être supprimée. ' +
                'Supprime les données du site depuis les paramètres du navigateur.');
    }
  }
  activeJob = null;
  clearId();
  clearThumb();
  const thumb = $('thumb');
  if (thumb.src.startsWith('blob:')) URL.revokeObjectURL(thumb.src);
  thumb.removeAttribute('src');
  show('thumb', false);
  const box = $('result-content');
  box.replaceChildren();

  const r = result || {};
  show('mock-banner', typeof r.status === 'string' && r.status.toUpperCase().includes('MOCK'));
  if (r.status === 'error') {
    showError(r.error || 'L’analyse n’a pas abouti. Montrez l’ordonnance au pharmacien.');
    showStep('result');
    return;
  }

  const wrap = el('div', 'result');

  const drugs = Array.isArray(r.detected_drugs) ? r.detected_drugs : [];
  const uncertain = Array.isArray(r.uncertain) ? r.uncertain : [];
  wrap.appendChild(el('h3', null, 'Lectures estimées par le modèle (à confirmer)'));
  if (drugs.length === 0 && uncertain.length === 0) {
    wrap.appendChild(el('p', null, 'Aucun médicament n\'a pu être lu avec certitude. ' +
                                   'Montrez l\'ordonnance au pharmacien.'));
  }
  if (drugs.length > 0) {
    const ul = el('ul');
    drugs.forEach((d) => {
      const label = [d.name, d.dosage].filter(Boolean).join(' - ');
      ul.appendChild(el('li', null, label));
    });
    wrap.appendChild(ul);
    wrap.appendChild(el('p', null, 'Comparez avec l\'ordonnance papier : si un nom ne correspond pas, ' +
                                   'ne vous fiez pas à ce résultat.'));
  }

  if (uncertain.length > 0) {
    wrap.appendChild(el('h3', null, 'À vérifier avec un pharmacien'));
    const ul = el('ul');
    uncertain.forEach((d) => {
      const label = [d.name, d.dosage, d.frequency, d.duration].filter(Boolean).join(' - ');
      ul.appendChild(el('li', null, label || 'Médicament illisible'));
    });
    wrap.appendChild(ul);
    wrap.appendChild(el('p', null, 'Ces médicaments incertains ne sont pas inclus dans la vérification des interactions.'));
  }

  const interactionChecks = Array.isArray(r.interactions) ? r.interactions : [];
  wrap.appendChild(el('h3', null, 'Interactions médicamenteuses'));
  if (interactionChecks.length === 0) {
    wrap.appendChild(el('p', null, 'Interaction non vérifiée. La base ne permet pas de confirmer ' +
                                   'les interactions ; l’absence d’alerte ne signifie pas absence de risque.'));
  } else {
    const list = el('ul');
    interactionChecks.forEach((check) => {
      if (check.status === 'verified') {
        const source = [check.source, check.verified_on].filter(Boolean).join(' — ');
        list.appendChild(el('li', null,
          `${check.drug_a} + ${check.drug_b} : interaction documentée (${check.severity}) — ${source}`));
      } else {
        list.appendChild(el('li', null,
          `${check.drug_a || 'Médicament inconnu'} + ${check.drug_b || 'médicament inconnu'} : interaction non vérifiée.`));
      }
    });
    wrap.appendChild(list);
    if (interactionChecks.some((check) => check.status === 'not_verified')) {
      wrap.appendChild(el('p', null, 'La base est limitée : l’absence d’alerte ne signifie pas absence de risque.'));
    }
  }

  const hasVerifiedAlert = interactionChecks.some((check) => check.status === 'verified');
  const expl = hasVerifiedAlert && r.explanations && typeof r.explanations === 'object'
    ? r.explanations
    : {};
  const langs = Object.keys(expl);
  if (langs.length > 0) {
    wrap.appendChild(el('h3', null, 'Explications'));
    langs.forEach((code) => {
      const block = el('div', 'lang');
      block.appendChild(el('strong', null, LANG_LABELS[code] || code));
      block.appendChild(el('span', null, String(expl[code])));
      wrap.appendChild(block);
    });
    wrap.appendChild(el('p', null, 'Traduction automatique, à vérifier. Ne remplace pas un avis médical.'));
  }

  box.appendChild(wrap);
  showStep('result');
}

function startPolling(job) {
  stopPolling();
  const tick = async () => {
    try {
      if (!job.relayId) {
        if (!navigator.onLine) {
          setProgress('offline');
          pollTimer = setTimeout(tick, 5000);
          return;
        }
        const upload = await fetchTimeout(`${RELAY}/upload`, {
          method: 'POST',
          headers: relayHeaders({ 'Content-Type': 'image/jpeg' }),
          body: job.blob,
        }, 30000);
        if (upload.status === 400 || upload.status === 413) {
          let reason = `Le relais a refusé la photo (code ${upload.status}).`;
          try { const data = await upload.json(); if (data.error) reason = data.error; } catch (e) { /* réponse non JSON */ }
          await failJob(job, reason);
          return;
        }
        if (!upload.ok) throw new Error(`upload HTTP ${upload.status}`);
        const data = await upload.json();
        if (typeof data.id !== 'string' || !data.id) throw new Error('identifiant du relais manquant');
        job.relayId = data.id;
        job.blob = null;
        await saveJob(job);
        saveId(job.relayId);
      }

      const response = await fetchTimeout(`${RELAY}/status/${encodeURIComponent(job.relayId)}`,
                                          { headers: relayHeaders() }, 8000);
      if (response.status === 404) {
        await failJob(job, 'Cette ordonnance a expiré sur le relais. Renvoyez-la.');
        return;
      }
      if (!response.ok) throw new Error(`status HTTP ${response.status}`);
      const data = await response.json();
      if (data.status === 'done') {
        await showResult(data.result);
        return;
      }
      setProgress('queued');
    } catch (e) {
      setProgress(navigator.onLine ? 'retry' : 'offline');
    }
    pollTimer = setTimeout(tick, job.relayId ? POLL_MS : 5000);
  };
  tick();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const LANG_LABELS = { fr: 'Français', fon: 'Fon', en: 'English' };

async function handleFile(file) {
  if (!file) return;
  show('error', false);
  if (activeJob) {
    showError('Une ordonnance est déjà en cours. Attendez son résultat avant d’en envoyer une autre.');
    return;
  }

  let blob, thumbDataUrl;
  try {
    ({ blob, thumbDataUrl } = await prepareImage(file));
  } catch (e) {
    showError('Impossible de lire cette image. Essayez avec une autre photo.');
    showStep('pick');
    return;
  }

  const id = (crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  activeJob = { id, blob, thumbDataUrl, relayId: null, createdAt: Date.now() };
  try {
    await saveJob(activeJob);
  } catch (e) {
    console.error('Stockage local de la photo impossible :', e);
    activeJob = null;
    showError('Impossible de garder la photo sur ce téléphone. Vérifiez l’espace disponible et réessayez.');
    showStep('pick');
    return;
  }

  showJobThumb(activeJob);
  showStep('progress');
  setProgress(navigator.onLine ? 'sending' : 'offline');
  startPolling(activeJob);
}

async function resetAll() {
  stopPolling();
  if (activeJob) {
    try {
      await deleteJob(activeJob.id);
    } catch (e) {
      console.error('Suppression de la photo locale impossible :', e);
      showError('Impossible de supprimer la photo en attente du téléphone.');
      return;
    }
    activeJob = null;
  }
  clearId();
  clearThumb();
  show('error', false);
  const thumb = $('thumb');
  if (thumb.src.startsWith('blob:')) URL.revokeObjectURL(thumb.src);
  thumb.removeAttribute('src');
  show('thumb', false);
  $('cam').value = '';
  $('gal').value = '';
  showStep('pick');
}

$('cam').addEventListener('change', (e) => handleFile(e.target.files[0]));
$('gal').addEventListener('change', (e) => handleFile(e.target.files[0]));
$('new-btn').addEventListener('click', resetAll);

checkRelay();
setInterval(checkRelay, 4000);

window.addEventListener('online', () => {
  checkRelay();
  if (activeJob) startPolling(activeJob);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js')
    .catch((e) => console.error('Installation du cache hors ligne impossible :', e));
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
    jobs.sort((a, b) => a.createdAt - b.createdAt);
    activeJob = jobs[0];
    showJobThumb(activeJob);
    showStep('progress');
    setProgress(navigator.onLine ? 'resume' : 'offline');
    startPolling(activeJob);
  } catch (e) {
    console.error('Reprise de la file locale impossible :', e);
    showError('Impossible de lire la photo gardée sur ce téléphone. Ne fermez pas cette page et réessayez.');
  }
}

resumePendingJob();