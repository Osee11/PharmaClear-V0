// Lecture d'une ordonnance avec le modèle Meta (API "Responses").
// Ce module est utilisé par server.js ET par tools/lire.js.
require('./env');

const CONFIG = {
  apiKey: process.env.META_API_KEY || process.env.MODEL_API_KEY || '',
  apiUrl: process.env.META_API_URL || 'https://api.meta.ai/v1/responses',
  model: process.env.META_MODEL || 'muse-wonder-1.0',
  effort: process.env.META_EFFORT || 'low',
  confMin: Number(process.env.CONF_MIN) || 0.7,
  timeoutMs: 50000, // doit rester sous les 60 s de curl dans le serveur C
};

// Erreur côté service Meta. retryable = true : réseau coupé, 429, 5xx
// -> le serveur Node répond 503 et le relais C réessaiera plus tard.
class UpstreamError extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

// Le modèle a répondu, mais pas dans un format exploitable (même après 2 essais).
class ModelOutputError extends Error {}

const INSTRUCTIONS =
  'You read photos of handwritten or printed medical prescriptions, mostly in French, ' +
  'from West Africa. Your only job is to TRANSCRIBE what is written. ' +
  'Never invent, complete or "correct" a word you cannot read. ' +
  'If a word is partly illegible, give your best reading with a LOW confidence. ' +
  'Reply with one single JSON object and nothing else: no markdown, no commentary. ' +
  'Never give medical advice.';

const PROMPT =
  'Read this prescription image and return JSON with exactly this shape:\n' +
  '{"is_prescription": boolean, "image_quality": "good" | "poor" | "unreadable", ' +
  '"drugs": [{"name": string|null, "dosage": string|null, "frequency": string|null, ' +
  '"duration": string|null, "confidence": number}], "notes": string}\n' +
  'Rules: one entry per medicine line. Copy the drug name exactly as written (brand or generic). ' +
  'dosage like "500 mg". frequency as written (for example "2 fois par jour" or "1-0-1"). ' +
  'duration as written. confidence (0 to 1) is how sure you are of the DRUG NAME specifically. ' +
  'Use null for anything that is not written or not legible. ' +
  'If the image is not a prescription, set is_prescription to false and drugs to []. ' +
  'notes: one short sentence about reading problems, or an empty string.';

async function callMeta(buffer, mime) {
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  const body = {
    model: CONFIG.model,
    reasoning: { effort: CONFIG.effort },
    max_output_tokens: 8000, // les tokens de raisonnement comptent dans cette limite
    instructions: INSTRUCTIONS,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: PROMPT },
          { type: 'input_image', image_url: dataUrl },
        ],
      },
    ],
  };

  let resp;
  try {
    resp = await fetch(CONFIG.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONFIG.timeoutMs),
    });
  } catch (e) {
    throw new UpstreamError(`réseau ou délai dépassé : ${e.message}`, true);
  }

  if (!resp.ok) {
    const txt = (await resp.text().catch(() => '')).slice(0, 300);
    const retryable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
    throw new UpstreamError(`API Meta HTTP ${resp.status} : ${txt}`, retryable);
  }
  try {
    return await resp.json();
  } catch (e) {
    throw new UpstreamError('réponse Meta illisible (pas du JSON)', true);
  }
}

// Récupère le texte de la réponse (format "Responses" : liste d'éléments "output").
function extractText(data) {
  if (data && typeof data.output_text === 'string') return data.output_text;
  let out = '';
  for (const item of (data && data.output) || []) {
    if (item.type !== 'message') continue;
    for (const c of item.content || []) {
      if (c.type === 'output_text' && typeof c.text === 'string') out += c.text;
    }
  }
  return out;
}

// Extrait l'objet JSON même si le modèle l'entoure de ```json ... ```
function parseModelJson(text) {
  if (!text) return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1));
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    return null;
  }
}

function clean(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim().slice(0, max || 80);
  return s || null;
}

function clamp01(n) {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

// Couche sécurité : on ne montre comme "lu" que ce dont le modèle est assez sûr.
// Le reste va dans "uncertain" : la page demandera de le faire vérifier.
function normalize(p) {
  const quality = ['good', 'poor', 'unreadable'].includes(p.image_quality) ? p.image_quality : 'poor';
  if (p.is_prescription === false) {
    return { status: 'not_a_prescription', image_quality: quality,
             detected_drugs: [], uncertain: [], model: CONFIG.model };
  }
  const detected = [];
  const uncertain = [];
  const list = Array.isArray(p.drugs) ? p.drugs.slice(0, 30) : [];
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    const item = {
      name: clean(d.name, 80),
      dosage: clean(d.dosage, 40),
      frequency: clean(d.frequency, 60),
      duration: clean(d.duration, 40),
      confidence: clamp01(Number(d.confidence)),
    };
    if (item.name && item.confidence >= CONFIG.confMin && quality !== 'unreadable') {
      detected.push(item);
    } else {
      uncertain.push(item);
    }
  }
  return { status: 'success', image_quality: quality, detected_drugs: detected,
           uncertain, notes: clean(p.notes, 300), model: CONFIG.model };
}

// Fonction principale : photo (Buffer) -> résultat prêt pour la page.
async function analyzePrescription(buffer, mime) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const data = await callMeta(buffer, mime);
    if (data.usage) {
      const reasoning = data.usage.output_tokens_details && data.usage.output_tokens_details.reasoning_tokens;
      console.log(`[meta] tokens entrée=${data.usage.input_tokens} sortie=${data.usage.output_tokens} raisonnement=${reasoning}`);
    }
    const parsed = parseModelJson(extractText(data));
    if (parsed) return normalize(parsed);
    console.warn(`[meta] sortie du modèle inexploitable (essai ${attempt}/2)`);
  }
  throw new ModelOutputError('le modèle n\'a pas renvoyé de JSON exploitable');
}

module.exports = { analyzePrescription, UpstreamError, ModelOutputError, CONFIG };