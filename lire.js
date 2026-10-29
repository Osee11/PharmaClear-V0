// Test rapide SANS le serveur ni la page :
//   node lire.js chemin/vers/ordonnance.jpg
// Affiche ce que le modèle a lu. C'est aussi ton premier test avec la vraie clé.
const fs = require('fs');
const path = require('path');
const { analyzePrescription, CONFIG } = require('./meta');

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('Usage : node tools/lire.js photo.jpg'); process.exit(1); }
  if (!CONFIG.apiKey) { console.error('MODEL_API_KEY ou META_API_KEY absente : renseigne le fichier .env'); process.exit(1); }

  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const t0 = Date.now();
  try {
    const result = await analyzePrescription(fs.readFileSync(file), mime);
    console.log(JSON.stringify(result, null, 2));
    console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)} s, modèle ${CONFIG.model}, effort ${CONFIG.effort})`);
  } catch (e) {
    console.error('ECHEC :', e.message);
    process.exit(2);
  }
}
main();