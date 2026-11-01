'use strict';

const {
  normalizeName,
  selectConfidentDrugs,
  validateAiInteractionSuggestions,
} = require('./interactions');

function pairKey(first, second) {
  return [first, second].sort().join('\u0000');
}

function findUndocumentedPair(names, interactions) {
  const documented = new Set((interactions || [])
    .filter((item) => item && item.status === 'verified')
    .map((item) => pairKey(normalizeName(item.drug_a), normalizeName(item.drug_b))));
  for (let first = 0; first < names.length; first++) {
    for (let second = first + 1; second < names.length; second++) {
      if (!documented.has(pairKey(normalizeName(names[first]), normalizeName(names[second])))) {
        return [names[first], names[second]];
      }
    }
  }
  return null;
}

function hasUndocumentedPair(names, interactions) {
  return findUndocumentedPair(names, interactions) !== null;
}

function simulatedSuggestion(drugA, drugB) {
  return [{
    status: 'ai_suggested',
    source: 'model',
    review_status: 'ai_unverified',
    simulated: true,
    drug_a: drugA,
    drug_b: drugB,
    severity: 'caution',
    summary_en: 'SIMULATED interaction for interface testing only; this is not medical information.',
    summary_fr: 'Interaction SIMULÉE pour tester l’interface uniquement ; ceci n’est pas une information médicale.',
  }];
}

async function addAiInteractionSuggestions({
  detectedDrugs,
  documentedInteractions,
  dailyLimiter,
  suggest,
  documentedPairChecker,
  mock = false,
  limit = 200,
  onError = (error) => console.error('AI interaction suggestions unavailable:', error.message),
}) {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('AI interaction daily limit must be a non-negative integer');
  }
  if (!dailyLimiter || typeof dailyLimiter.consume !== 'function' ||
      typeof suggest !== 'function') {
    throw new TypeError('An AI interaction limiter and suggestion function are required');
  }
  const selected = selectConfidentDrugs(detectedDrugs);
  const names = selected.map((drug) => drug.name.trim());
  if (limit === 0 || names.length < 2) return [];

  const knownInteractions = [...(documentedInteractions || [])];
  let uncoveredPair = null;
  if (typeof documentedPairChecker === 'function') {
    try {
      for (let first = 0; first < names.length; first++) {
        for (let second = first + 1; second < names.length; second++) {
          const checked = await documentedPairChecker(names[first], names[second]);
          if (checked && checked.status === 'verified') {
            knownInteractions.push(checked, {
              ...checked,
              drug_a: names[first],
              drug_b: names[second],
            });
          } else if (!uncoveredPair) {
            uncoveredPair = [names[first], names[second]];
          }
        }
      }
    } catch (error) {
      onError(error);
      return [];
    }
  } else {
    uncoveredPair = findUndocumentedPair(names, knownInteractions);
  }
  if (!uncoveredPair) return [];

  let slot;
  try {
    slot = await dailyLimiter.consume();
  } catch (error) {
    onError(error);
    return [];
  }
  if (!slot.allowed) return [];

  if (mock) return simulatedSuggestion(uncoveredPair[0], uncoveredPair[1]);
  try {
    const response = await suggest(names);
    return validateAiInteractionSuggestions(response, names, knownInteractions);
  } catch (error) {
    onError(error);
    return [];
  }
}

module.exports = {
  addAiInteractionSuggestions,
  hasUndocumentedPair,
  simulatedSuggestion,
};
