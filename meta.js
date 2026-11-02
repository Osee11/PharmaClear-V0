// Lecture d'une ordonnance avec le modèle Meta (API "Responses").
// Ce module est utilisé par server.js ET par tools/lire.js.
require('./env');

function getModelSettings(environment) {
  const effort = environment.MODEL_REASONING_EFFORT || environment.META_EFFORT || 'low';
  const maxOutputTokens = environment.MODEL_MAX_OUTPUT_TOKENS === undefined
    ? 4000
    : Number(environment.MODEL_MAX_OUTPUT_TOKENS);
  if (!['low', 'medium', 'high'].includes(effort)) {
    throw new Error('MODEL_REASONING_EFFORT must be low, medium, or high');
  }
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error('MODEL_MAX_OUTPUT_TOKENS must be a positive integer');
  }
  return { effort, maxOutputTokens };
}

const CONFIG = {
  apiKey: process.env.META_API_KEY || process.env.MODEL_API_KEY || '',
  apiUrl: process.env.META_API_URL || 'https://api.meta.ai/v1/responses',
  model: process.env.META_MODEL || 'muse-wonder-1.0',
  ...getModelSettings(process.env),
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
    max_output_tokens: CONFIG.maxOutputTokens, // les tokens de raisonnement comptent dans cette limite
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

async function suggestDrugInteractions(drugNames) {
  if (!Array.isArray(drugNames) || drugNames.length < 2 || drugNames.length > 8 ||
      drugNames.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new TypeError('Two to eight confident medicine names are required');
  }
  const prompt = 'You are assisting with a prototype. For the given medicine names, ' +
    'list ONLY well-established, widely documented drug–drug interactions between two of them. ' +
    'If you are not sure, omit the pair. Do not give dosing advice. Do not say a combination is safe. ' +
    'Return JSON only: {"pairs":[{"a":"name","b":"name","severity":"avoid|caution|monitor",' +
    '"summary_en":"text","summary_fr":"text"}]}. Max 5 pairs, each summary ≤ 2 sentences.\n' +
    `Medicine names: ${JSON.stringify(drugNames)}`;
  const body = {
    model: CONFIG.model,
    reasoning: { effort: CONFIG.effort },
    max_output_tokens: CONFIG.maxOutputTokens,
    instructions: 'Return only the requested JSON object, without markdown or commentary.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
  };
  let response;
  try {
    response = await fetch(CONFIG.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.apiKey}`, 
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONFIG.timeoutMs),
    });
  } catch (error) {
    throw new UpstreamError(`Interaction suggestion network error: ${error.message}`, true);
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 300);
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new UpstreamError(`Interaction suggestion API HTTP ${response.status}: ${text}`, retryable);
  }
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new UpstreamError('Interaction suggestion API returned invalid JSON', true);
  }
  if (data.usage) {
    const reasoning = data.usage.output_tokens_details &&
      data.usage.output_tokens_details.reasoning_tokens;
    console.log(`[meta] interaction suggestions tokens entrée=${data.usage.input_tokens} ` +
      `sortie=${data.usage.output_tokens} raisonnement=${reasoning}`);
  }
  return extractText(data);
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
async function analyzePrescription(buffer, mime, { onResponse } = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const data = await callMeta(buffer, mime);
    if (data.usage) {
      const reasoning = data.usage.output_tokens_details && data.usage.output_tokens_details.reasoning_tokens;
      console.log(`[meta] tokens entrée=${data.usage.input_tokens} sortie=${data.usage.output_tokens} raisonnement=${reasoning}`);
    }
    const text = extractText(data);
    const parsed = parseModelJson(text);
    if (onResponse) {
      const outputItems = Array.isArray(data.output) ? data.output : [];
      const finishReason = data.finish_reason || data.stop_reason ||
        outputItems.map((item) => item.finish_reason || item.stop_reason).find(Boolean) || null;
      onResponse({
        attempt,
        status: data.status || null,
        incompleteReason: data.incomplete_details && data.incomplete_details.reason || null,
        finishReason,
        jsonStatus: parsed ? 'valid' : text.trim() ? 'invalid_or_incomplete' : 'missing',
        inputTokens: data.usage && Number(data.usage.input_tokens) || 0,
        outputTokens: data.usage && Number(data.usage.output_tokens) || 0,
        reasoningTokens: data.usage && data.usage.output_tokens_details
          ? Number(data.usage.output_tokens_details.reasoning_tokens) || 0
          : 0,
      });
    }
    if (parsed) return normalize(parsed);
    console.warn(`[meta] sortie du modèle inexploitable (essai ${attempt}/2)`);
  }
  throw new ModelOutputError('le modèle n\'a pas renvoyé de JSON exploitable');
}

module.exports = {
  analyzePrescription,
  suggestDrugInteractions,
  UpstreamError,
  ModelOutputError,
  CONFIG,
  getModelSettings,
  TRANSCRIPTION_INSTRUCTIONS: INSTRUCTIONS,
  TRANSCRIPTION_PROMPT: PROMPT,
};
