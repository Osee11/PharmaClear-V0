'use strict';

const table = require('./data/interactions.json');

if (!table || table.schema_version !== 1 || !Array.isArray(table.interactions)) {
  throw new Error('data/interactions.json has an unsupported format');
}

for (const interaction of table.interactions) {
  if (!interaction ||
      typeof interaction.drug_a !== 'string' ||
      typeof interaction.drug_b !== 'string' ||
      typeof interaction.severity !== 'string' ||
      typeof interaction.source !== 'string' ||
      typeof interaction.source_url !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(interaction.verified_on || '')) {
    throw new Error('Every interaction entry requires drug names, severity, source, URL and verification date');
  }
}

function normalizeName(name) {
  return typeof name === 'string'
    ? name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
    : '';
}

function pairKey(first, second) {
  return [normalizeName(first), normalizeName(second)].sort().join('\u0000');
}

const verifiedPairs = new Map(
  table.interactions.map((entry) => [pairKey(entry.drug_a, entry.drug_b), entry]),
);

function checkDrugInteractions(drugs) {
  if (!Array.isArray(drugs)) {
    throw new TypeError('drugs must be an array');
  }

  const checks = [];
  for (let i = 0; i < drugs.length; i++) {
    for (let j = i + 1; j < drugs.length; j++) {
      const drugA = normalizeName(drugs[i] && drugs[i].name);
      const drugB = normalizeName(drugs[j] && drugs[j].name);
      const match = drugA && drugB ? verifiedPairs.get(pairKey(drugA, drugB)) : null;
      checks.push(match
        ? { status: 'verified', ...match }
        : {
            status: 'not_verified',
            drug_a: (drugs[i] && drugs[i].name) || null,
            drug_b: (drugs[j] && drugs[j].name) || null,
          });
    }
  }

  return {
    status: checks.some((check) => check.status === 'not_verified')
      ? 'not_verified'
      : checks.length > 0 ? 'verified' : 'not_verified',
    checks,
  };
}

module.exports = { checkDrugInteractions };
