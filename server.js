require('./env'); // charge .env avant tout le reste

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const {
  analyzePrescription,
  translateInteractionSummaryToFon,
  UpstreamError,
  ModelOutputError,
  CONFIG,
} = require('./meta');
const { addFonSummaries, checkDrugInteractions } = require('./interactions');

const PORT = Number(process.env.PORT) || 3000;
const RATE_LIMIT = Math.max(1, Number(process.env.API_RATE_LIMIT) || 20);
const DAILY_ANALYSIS_LIMIT = process.env.DAILY_ANALYSIS_LIMIT === undefined
  ? 100
  : Number(process.env.DAILY_ANALYSIS_LIMIT);
const RATE_WINDOW_MS = 60 * 1000;
const RELAY_URL = (process.env.RELAY_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const INTERNAL_RELAY_TOKEN = process.env.INTERNAL_RELAY_TOKEN || '';
const DEMO_ACCESS_CODE = process.env.DEMO_ACCESS_CODE || '';
const DAILY_USAGE_FILE = path.join(__dirname, 'runtime', 'daily-analysis-usage.json');
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || '';
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || '';
// Sans clé API (ou avec PHARMA_MOCK=1) : mode simulation, aucun appel à Meta.
const MOCK = process.env.PHARMA_MOCK === '1' || !CONFIG.apiKey;

if (!Number.isSafeInteger(DAILY_ANALYSIS_LIMIT) || DAILY_ANALYSIS_LIMIT < 0) {
  throw new Error('DAILY_ANALYSIS_LIMIT must be a non-negative integer');
}
if (INTERNAL_RELAY_TOKEN &&
    !/^[A-Za-z0-9._~-]{16,128}$/.test(INTERNAL_RELAY_TOKEN)) {
  throw new Error('INTERNAL_RELAY_TOKEN must be 16-128 URL-safe characters');
}

const app = express();
if (process.env.CORS_ORIGIN) app.use(cors({ origin: process.env.CORS_ORIGIN }));
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const requestWindows = new Map();
let dailyUsageQueue = Promise.resolve();

function secretMatches(expected, received) {
  if (!expected || typeof received !== 'string' || Buffer.byteLength(received) > 256) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function isInternalRelayRequest(req) {
  return secretMatches(INTERNAL_RELAY_TOKEN, req.get('X-Internal-Relay-Token'));
}

function requireDemoAccess(req, res, next) {
  if (!DEMO_ACCESS_CODE || secretMatches(DEMO_ACCESS_CODE, req.get('X-Demo-Access-Code'))) {
    return next();
  }
  return res.status(401).json({
    status: 'error',
    error_code: 'demo_access_required',
    error: 'A valid demo access code is required.',
  });
}

function requireAnalysisAccess(req, res, next) {
  if (isInternalRelayRequest(req)) return next();
  return requireDemoAccess(req, res, next);
}

function limitAnalyzeRequests(req, res, next) {
  const now = Date.now();
  const address = req.ip || req.socket.remoteAddress || 'unknown';
  let window = requestWindows.get(address);
  if (!window || now - window.startedAt >= RATE_WINDOW_MS) {
    if (!window && requestWindows.size >= 10000) {
      for (const [key, value] of requestWindows) {
        if (now - value.startedAt >= RATE_WINDOW_MS) requestWindows.delete(key);
      }
      if (requestWindows.size >= 10000) {
        return res.status(503).json({ status: 'error', error: 'limiteur de requêtes temporairement indisponible' });
      }
    }
    window = { startedAt: now, count: 0 };
    requestWindows.set(address, window);
  }
  if (window.count >= RATE_LIMIT) {
    res.set('Retry-After', String(Math.ceil((RATE_WINDOW_MS - (now - window.startedAt)) / 1000)));
    return res.status(429).json({ status: 'error', error: 'trop de demandes, réessayez plus tard' });
  }
  window.count++;
  return next();
}

function limitPublicAnalyzeRequests(req, res, next) {
  if (isInternalRelayRequest(req)) return next();
  return limitAnalyzeRequests(req, res, next);
}

async function consumeDailyAnalysisSlot() {
  if (DAILY_ANALYSIS_LIMIT === 0) return { allowed: true };

  const operation = dailyUsageQueue.then(async () => {
    const today = new Date().toISOString().slice(0, 10);
    let usage = { date: today, count: 0 };
    try {
      const current = JSON.parse(await fs.promises.readFile(DAILY_USAGE_FILE, 'utf8'));
      if (current && typeof current.date === 'string' &&
          Number.isSafeInteger(current.count) && current.count >= 0 &&
          current.date === today) {
        usage = current;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (usage.count >= DAILY_ANALYSIS_LIMIT) return { allowed: false };

    const nextUsage = { date: today, count: usage.count + 1 };
    await fs.promises.mkdir(path.dirname(DAILY_USAGE_FILE), { recursive: true });
    const temporaryFile = `${DAILY_USAGE_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryFile, `${JSON.stringify(nextUsage)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporaryFile, DAILY_USAGE_FILE);
    return { allowed: true, remaining: DAILY_ANALYSIS_LIMIT - nextUsage.count };
  });
  dailyUsageQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)),
});

async function proxyToRelay(route, options, res) {
  const headers = { ...options.headers };
  if (RELAY_TOKEN) headers['X-Token'] = RELAY_TOKEN;

  let upstream;
  try {
    upstream = await fetch(`${RELAY_URL}${route}`, {
      ...options,
      headers,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error('Erreur de connexion au relais C :', e.message);
    return res.status(503).json({ error: 'relais temporairement indisponible' });
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.set('Content-Type', contentType);
  return res.send(body);
}

app.get('/api/access', (req, res) => {
  res.json({
    required: Boolean(DEMO_ACCESS_CODE),
    authorized: !DEMO_ACCESS_CODE ||
      secretMatches(DEMO_ACCESS_CODE, req.get('X-Demo-Access-Code')),
  });
});

app.get('/relay/health', requireDemoAccess,
  (req, res) => proxyToRelay('/health', { method: 'GET' }, res));
app.post('/relay/upload', requireDemoAccess, limitAnalyzeRequests,
  express.raw({ type: '*/*', limit: '5mb' }),
  (req, res) => {
    const mime = req.get('content-type') || '';
    if (!/^image\/(jpeg|png|webp)$/.test(mime) ||
        !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'aucune image reçue' });
    }
    return proxyToRelay('/upload', {
      method: 'POST',
      headers: { 'Content-Type': mime },
      body: req.body,
    }, res);
  });
app.get('/relay/status/:id', requireDemoAccess, (req, res) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.params.id)) {
    return res.status(400).json({ error: 'id invalide' });
  }
  return proxyToRelay(`/status/${encodeURIComponent(req.params.id)}`, { method: 'GET' }, res);
});

async function mockResult() {
  const result = {
    status: 'success - MOCK',
    image_quality: 'good',
    notes: 'Synthetic TEST ONLY values; this is not a reading of the uploaded photo.',
    detected_drugs: [
      { name: 'TEST-ONLY-ALPHA', dosage: null, frequency: null, duration: null },
      { name: 'TEST-ONLY-BETA', dosage: null, frequency: null, duration: null },
    ],
    uncertain: [
      { name: 'TEST-ONLY-UNCERTAIN', dosage: null, frequency: null, duration: null },
    ],
  };
  const interactions = await checkDrugInteractions(result.detected_drugs);
  return {
    ...result,
    interaction_status: interactions.status,
    interactions: interactions.checks,
  };
}

function imageMatchesMime(buffer, mime) {
  if (mime === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === 'image/png') {
    return buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === 'image/webp') {
    return buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: MOCK ? 'mock' : 'meta', model: MOCK ? null : CONFIG.model });
});

app.post('/api/analyze', requireAnalysisAccess, limitPublicAnalyzeRequests,
  upload.single('prescription'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'aucune image valide reçue (champ "prescription", jpeg/png/webp)' });
  }
  const file = req.file;
  console.log(`Image reçue : ${file.size} octets (${file.mimetype})`);

  try {
    const buffer = await fs.promises.readFile(file.path);
    if (!imageMatchesMime(buffer, file.mimetype)) {
      return res.status(400).json({ status: 'error', error: 'le contenu ne correspond pas à une image valide' });
    }
    let dailySlot;
    try {
      dailySlot = await consumeDailyAnalysisSlot();
    } catch (error) {
      console.error('Could not read or update the daily analysis limit:', error.message);
      return res.json({
        status: 'error',
        error_code: 'analysis_limit_unavailable',
        error: 'The daily analysis limit could not be checked. Analysis was not run.',
      });
    }
    if (!dailySlot.allowed) {
      return res.json({
        status: 'error',
        error_code: 'daily_limit',
        error: 'The daily analysis limit has been reached. Please try again tomorrow.',
      });
    }
    if (MOCK) return res.json(await mockResult());

    const result = await analyzePrescription(buffer, file.mimetype);
    const interactions = await checkDrugInteractions(result.detected_drugs);
    const checks = await addFonSummaries(
      interactions.checks,
      translateInteractionSummaryToFon,
      (error) => console.error('Fon translation unavailable for a verified interaction:', error.message),
    );
    console.log(`Analyse terminée : ${result.detected_drugs.length} lu(s), ${result.uncertain.length} à vérifier`);
    return res.json({
      ...result,
      interaction_status: interactions.status,
      interactions: checks,
    });
  } catch (e) {
    if (e instanceof UpstreamError) {
      console.error('Erreur service Meta :', e.message);
      if (e.retryable) {
        // 503 : le relais C garde la photo en file et réessaiera.
        return res.status(503).json({ status: 'error', error: 'service d\'analyse indisponible, nouvelle tentative plus tard' });
      }
      // Erreur définitive (clé refusée, requête invalide) : réessayer ne servirait à rien.
      // On répond 200 avec un résultat "error" pour que le relais arrête de relancer.
      return res.json({ status: 'error', error: 'analyse refusée par le service (vérifiez la clé API)' });
    }
    if (e instanceof ModelOutputError) {
      console.error('Sortie du modèle inexploitable après 2 essais');
      return res.json({ status: 'error', error: 'la lecture n\'a pas abouti, reprenez la photo ou voyez le pharmacien' });
    }
    console.error('Erreur inattendue :', e);
    return res.status(500).json({ status: 'error', error: 'erreur interne' });
  } finally {
    // Données de santé : on ne garde jamais la photo sur le serveur Node.
    fs.promises.unlink(file.path).catch((e) => {
      console.error('Suppression de la photo temporaire impossible :', e);
    });
  }
});

// Erreurs de téléversement (fichier trop gros, etc.)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'erreur interne' });
});

if (Boolean(TLS_CERT_FILE) !== Boolean(TLS_KEY_FILE)) {
  throw new Error('TLS_CERT_FILE et TLS_KEY_FILE doivent être définis ensemble');
}

const server = TLS_CERT_FILE
  ? https.createServer({
      cert: fs.readFileSync(TLS_CERT_FILE),
      key: fs.readFileSync(TLS_KEY_FILE),
    }, app)
  : app;

server.listen(PORT, () => {
  console.log(`PharmaClear tourne sur ${TLS_CERT_FILE ? 'https' : 'http'}://localhost:${PORT}`);
  if (TLS_CERT_FILE) console.log('HTTPS activé avec le certificat configuré.');
  else console.warn('HTTP sans TLS : réservé au développement local ou à un proxy TLS de confiance.');
  console.log(MOCK
    ? 'MODE SIMULATION : pas de clé API (ou PHARMA_MOCK=1). Aucun appel à Meta.'
    : `MODE RÉEL : modèle ${CONFIG.model}, effort ${CONFIG.effort}, seuil de confiance ${CONFIG.confMin}`);
});