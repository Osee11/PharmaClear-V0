require('./env'); // charge .env avant tout le reste

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { analyzePrescription, UpstreamError, ModelOutputError, CONFIG } = require('./meta');

const PORT = Number(process.env.PORT) || 3000;
// Sans clé API (ou avec PHARMA_MOCK=1) : mode simulation, aucun appel à Meta.
const MOCK = process.env.PHARMA_MOCK === '1' || !CONFIG.apiKey;

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)),
});

function mockResult() {
  return {
    status: 'success - MOCK',
    detected_drugs: [
      { name: 'Paracetamol', dosage: '500mg' },
      { name: 'Ibuprofene', dosage: '200mg' },
    ],
    uncertain: [],
    explanations: {
      fon: 'Amon, ma nu Paracetamol kpodo Ibuprofene kpo oo, ... E na do xo mè wli wé.',
      fr: 'Attention : Ne prenez pas Paracétamol et Ibuprofène ensemble à jeun, risque de maux de ventre.',
      en: 'Warning: Avoid taking Paracetamol and Ibuprofen together on an empty stomach.',
    },
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: MOCK ? 'mock' : 'meta', model: MOCK ? null : CONFIG.model });
});

app.post('/api/analyze', upload.single('prescription'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'aucune image valide reçue (champ "prescription", jpeg/png/webp)' });
  }
  const file = req.file;
  console.log(`Image reçue : ${file.size} octets (${file.mimetype})`);

  try {
    if (MOCK) return res.json(mockResult());

    const buffer = await fs.promises.readFile(file.path);
    const result = await analyzePrescription(buffer, file.mimetype);
    console.log(`Analyse terminée : ${result.detected_drugs.length} lu(s), ${result.uncertain.length} à vérifier`);
    return res.json(result);
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
    fs.promises.unlink(file.path).catch(() => {});
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

app.listen(PORT, () => {
  console.log(`PharmaClear tourne sur http://localhost:${PORT}`);
  console.log(MOCK
    ? 'MODE SIMULATION : pas de clé API (ou PHARMA_MOCK=1). Aucun appel à Meta.'
    : `MODE RÉEL : modèle ${CONFIG.model}, effort ${CONFIG.effort}, seuil de confiance ${CONFIG.confMin}`);
});