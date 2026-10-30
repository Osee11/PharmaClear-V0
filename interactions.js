'use strict';

const table = require('./data/interactions.json');

function normalizeName(name) {
  return typeof name === 'string'
    ? name.normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
    : '';
}

function validateSource(source, label) {
  if (!source || typeof source !== 'object' ||
      typeof source.title !== 'string' || !source.title.trim() ||
      typeof source.url !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(source.accessed || '')) {
    throw new Error(`${label} requires a source title, URL, and YYYY-MM-DD accessed date`);
  }
  const date = new Date(`${source.accessed}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== source.accessed) {
    throw new Error(`${label} has an invalid source access date`);
  }
  let url;
  try {
    url = new URL(source.url);
  } catch (error) {
    throw new Error(`${label} has an invalid source URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} source URL must use HTTP or HTTPS`);
  }
}

function validateInteractionTable(candidate) {
  if (!candidate || typeof candidate !== 'object' ||
      !candidate.meta || typeof candidate.meta !== 'object' ||
      typeof candidate.meta.version !== 'string' ||
      !(candidate.meta.last_reviewed === null ||
        (typeof candidate.meta.last_reviewed === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(candidate.meta.last_reviewed) &&
          !Number.isNaN(Date.parse(`${candidate.meta.last_reviewed}T00:00:00Z`)) &&
          new Date(`${candidate.meta.last_reviewed}T00:00:00Z`).toISOString().slice(0, 10) === candidate.meta.last_reviewed)) ||
      typeof candidate.meta.reviewed_by_pharmacist !== 'boolean' ||
      !Array.isArray(candidate.aliases) ||
      !Array.isArray(candidate.pairs)) {
    throw new Error('data/interactions.json has an unsupported schema');
  }
  if (candidate.pairs.length && !candidate.meta.reviewed_by_pharmacist) {
    throw new Error('Interaction pairs require pharmacist review before they can be used');
  }

  const aliases = new Set();
  for (const [index, alias] of candidate.aliases.entries()) {
    const label = `Alias entry ${index + 1}`;
    if (!alias || typeof alias.brand !== 'string' ||
        !normalizeName(alias.brand) ||
        typeof alias.generic !== 'string' ||
        !normalizeName(alias.generic) ||
        normalizeName(alias.brand) === normalizeName(alias.generic)) {
      throw new Error(`${label} requires distinct brand and generic names`);
    }
    validateSource(alias.source, label);
    if (aliases.has(normalizeName(alias.brand))) {
      throw new Error(`${label} duplicates a brand alias`);
    }
    aliases.add(normalizeName(alias.brand));
  }

  const pairs = new Set();
  for (const [index, pair] of candidate.pairs.entries()) {
    const label = `Interaction entry ${index + 1}`;
    if (!pair ||
        typeof pair.a !== 'string' || !normalizeName(pair.a) ||
        typeof pair.b !== 'string' || !normalizeName(pair.b) ||
        normalizeName(pair.a) === normalizeName(pair.b) ||
        !['avoid', 'caution', 'monitor'].includes(pair.severity) ||
        typeof pair.summary_en !== 'string' || !pair.summary_en.trim() ||
        pair.summary_en.length > 1000 ||
        typeof pair.summary_fr !== 'string' || !pair.summary_fr.trim()) {
      throw new Error(`${label} requires distinct names, valid severity, and non-empty summary_en/summary_fr`);
    }
    if (pair.summary_fr.length > 1000) {
      throw new Error(`${label} summaries must be at most 1000 characters`);
    }
    validateSource(pair.source, label);
    const key = [normalizeName(pair.a), normalizeName(pair.b)].sort().join('\u0000');
    if (pairs.has(key)) throw new Error(`${label} duplicates an interaction pair`);
    pairs.add(key);
  }
}

function pairKey(first, second) {
  return [first, second].sort().join('\u0000');
}

function createInteractionChecker(sourceTable) {
  validateInteractionTable(sourceTable);
  const aliases = new Map(
    sourceTable.aliases.map((entry) => [normalizeName(entry.brand), normalizeName(entry.generic)]),
  );
  const verifiedPairs = new Map(
    sourceTable.pairs.map((entry) => [
      pairKey(normalizeName(entry.a), normalizeName(entry.b)),
      entry,
    ]),
  );
  const canonicalize = (name) => aliases.get(normalizeName(name)) || normalizeName(name);

  async function checkDrugInteraction(drugA, drugB) {
    if ((drugA !== null && drugA !== undefined && typeof drugA !== 'string') ||
        (drugB !== null && drugB !== undefined && typeof drugB !== 'string')) {
      throw new TypeError('drug names must be strings or null');
    }
    const nameA = canonicalize(drugA || '');
    const nameB = canonicalize(drugB || '');
    if (nameA && nameA === nameB) return null;

    const match = nameA && nameB
      ? verifiedPairs.get(pairKey(nameA, nameB))
      : null;
    if (!match) {
      return {
        status: 'not_verified',
        drug_a: typeof drugA === 'string' && drugA.trim() ? drugA.trim() : null,
        drug_b: typeof drugB === 'string' && drugB.trim() ? drugB.trim() : null,
      };
    }
    return {
      status: 'verified',
      drug_a: match.a,
      drug_b: match.b,
      severity: match.severity,
      summary_en: match.summary_en,
      summary_fr: match.summary_fr,
      source: { ...match.source },
    };
  }

  async function checkDrugInteractions(drugs) {
    if (!Array.isArray(drugs) ||
        drugs.some((drug) => !drug || typeof drug !== 'object' || Array.isArray(drug))) {
      throw new TypeError('drugs must be an array of medicine objects');
    }
    const pairs = [];
    for (let first = 0; first < drugs.length; first++) {
      for (let second = first + 1; second < drugs.length; second++) {
        pairs.push([drugs[first].name, drugs[second].name]);
      }
    }
    const checked = await Promise.all(
      pairs.map(([first, second]) => checkDrugInteraction(first, second)),
    );
    const checks = checked.filter(Boolean);
    return {
      status: checks.length && checks.every((check) => check.status === 'verified')
        ? 'verified'
        : 'not_verified',
      checks,
    };
  }

  return { checkDrugInteraction, checkDrugInteractions };
}

async function addFonSummaries(checks, translate, onError = () => {}) {
  if (!Array.isArray(checks) || typeof translate !== 'function') {
    throw new TypeError('checks and a translation function are required');
  }
  return Promise.all(checks.map(async (check) => {
    if (!check || check.status !== 'verified') return check;
    try {
      const summaryFon = await translate(check.summary_en);
      if (typeof summaryFon !== 'string' || !summaryFon.trim()) {
        throw new Error('Fon translation was empty');
      }
      return { ...check, summary_fon: summaryFon.trim() };
    } catch (error) {
      onError(error);
      return { ...check, summary_fon_status: 'unavailable' };
    }
  }));
}

const productionChecker = createInteractionChecker(table);

module.exports = {
  addFonSummaries,
  checkDrugInteraction: productionChecker.checkDrugInteraction,
  checkDrugInteractions: productionChecker.checkDrugInteractions,
  createInteractionChecker,
  normalizeName,
  validateInteractionTable,
};
