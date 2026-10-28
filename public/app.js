'use strict';

const params = new URLSearchParams(location.search);

// Adresse du relais : même machine que cette page, port 8080.
// On peut la forcer avec ?relay=http://192.168.1.20:8080
const RELAY = params.get('relay') ||
  (location.hostname ? `${location.protocol}//${location.hostname}:8080`
                     : 'http://localhost:8080');
// Si le serveur C est lancé avec PHARMA_TOKEN, ouvrir la page avec ?token=...
const TOKEN = params.get('token') || '';

const MAX_SIDE = 1600;      // une photo de téléphone dépasse souvent 5 Mo : on la réduit
const JPEG_QUALITY = 0.85;
const POLL_MS = 2000;
const STORAGE_KEY = 'pharmaclear:lastId';
const THUMB_KEY = 'pharmaclear:lastThumb';
const THUMB_SIDE = 700;     // petite miniature gardée pour la reprise après rechargement

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
    detail.textContent = 'Nouvelle tentative en cours. Vérifiez que vous êtes sur le même Wi-Fi.';
  } else if (state === 'resume') {
    title.textContent = 'Reprise du suivi de l\'ordonnance…';
    detail.textContent = '';
  }
}

let pollTimer = null;

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function startPolling(id) {
  stopPolling();
  const tick = async () => {
    try {
      const r = await fetchTimeout(`${RELAY}/status/${encodeURIComponent(id)}`,
                                   { headers: relayHeaders() }, 8000);
      if (r.status === 404) {
        clearId();
        showError('Cette ordonnance est introuvable sur le relais. Renvoyez-la.');
        showStep('pick');
        return;
      }
      if (r.status === 401) {
        showError('Accès refusé par le relais (token invalide).');
        showStep('pick');
        return;
      }
      const data = await r.json();
      if (data.status === 'done') {
        showResult(data.result);
        return;
      }
      setProgress('queued');
    } catch (e) {
      setProgress('retry');
    }
    pollTimer = setTimeout(tick, POLL_MS);
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

function showResult(result) {
  stopPolling();
  clearId();
  clearThumb();
  const box = $('result-content');
  box.replaceChildren();

  const r = result || {};
  show('mock-banner', typeof r.status === 'string' && r.status.toUpperCase().includes('MOCK'));

  const wrap = el('div', 'result');

  const drugs = Array.isArray(r.detected_drugs) ? r.detected_drugs : [];
  wrap.appendChild(el('h3', null, 'Médicaments lus sur l\'ordonnance'));
  if (drugs.length === 0) {
    wrap.appendChild(el('p', null, 'Aucun médicament n\'a pu être lu avec certitude. ' +
                                   'Montrez l\'ordonnance au pharmacien.'));
  } else {
    const ul = el('ul');
    drugs.forEach((d) => {
      const label = [d.name, d.dosage].filter(Boolean).join(' - ');
      ul.appendChild(el('li', null, label));
    });
    wrap.appendChild(ul);
    const ref = $('thumb').hidden ? 'l\'ordonnance papier' : 'la photo ci-dessus';
    wrap.appendChild(el('p', null, 'Comparez avec ' + ref + ' : si un nom ne correspond pas, ' +
                                   'ne vous fiez pas à ce résultat.'));
  }

  const expl = r.explanations && typeof r.explanations === 'object' ? r.explanations : {};
  const langs = Object.keys(expl);
  if (langs.length > 0) {
    wrap.appendChild(el('h3', null, 'Explications'));
    langs.forEach((code) => {
      const block = el('div', 'lang');
      block.appendChild(el('strong', null, LANG_LABELS[code] || code));
      block.appendChild(el('span', null, String(expl[code])));
      wrap.appendChild(block);
    });
  }

  box.appendChild(wrap);
  showStep('result');
}

async function handleFile(file) {
  if (!file) return;
  show('error', false);
  showStep('progress');
  setProgress('sending');

  let blob, thumbDataUrl;
  try {
    ({ blob, thumbDataUrl } = await prepareImage(file));
  } catch (e) {
    showError('Impossible de lire cette image. Essayez avec une autre photo.');
    showStep('pick');
    return;
  }

  const thumb = $('thumb');
  if (thumb.src.startsWith('blob:')) URL.revokeObjectURL(thumb.src);
  thumb.src = URL.createObjectURL(blob);
  show('thumb', true);

  try {
    const r = await fetchTimeout(RELAY + '/upload', {
      method: 'POST',
      headers: relayHeaders({ 'Content-Type': 'image/jpeg' }),
      body: blob,
    }, 30000);

    if (!r.ok) {
      let msg = 'Le relais a refusé la photo (code ' + r.status + ').';
      try { const j = await r.json(); if (j.error) msg = 'Le relais a refusé la photo : ' + j.error; } catch (e) { /* garde le message par défaut */ }
      showError(msg);
      showStep('pick');
      return;
    }

    const data = await r.json();
    saveId(data.id);
    saveThumb(thumbDataUrl);
    setProgress('queued');
    startPolling(data.id);
  } catch (e) {
    showError('Impossible de joindre le relais. Vérifiez que le serveur C tourne ' +
              'et que vous êtes sur le même Wi-Fi que l\'ordinateur.');
    showStep('pick');
  }
}

function resetAll() {
  stopPolling();
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

// Si la page est rechargée pendant qu'une ordonnance est en cours, on reprend le suivi.
const pendingId = loadId();
if (pendingId) {
  const savedThumb = loadThumb();
  if (savedThumb) { $('thumb').src = savedThumb; show('thumb', true); }
  showStep('progress');
  setProgress('resume');
  startPolling(pendingId);
}