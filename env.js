// Lecture minimale du fichier .env (sans dépendance).
// Les variables déjà définies dans le terminal ne sont jamais écrasées.
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return; // pas de .env : on utilise le mode simulation
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadEnv(path.join(__dirname, '.env'));