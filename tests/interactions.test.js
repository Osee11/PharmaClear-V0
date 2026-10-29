'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDrugInteractions } = require('../interactions');

test('unknown pairs are explicitly unverified', () => {
  const result = checkDrugInteractions([
    { name: 'Paracetamol' },
    { name: 'Ibuprofene' },
  ]);

  assert.equal(result.status, 'not_verified');
  assert.deepEqual(result.checks, [{
    status: 'not_verified',
    drug_a: 'Paracetamol',
    drug_b: 'Ibuprofene',
  }]);
});

test('a single medicine is not reported as interaction-free', () => {
  const result = checkDrugInteractions([{ name: 'Paracetamol' }]);

  assert.equal(result.status, 'not_verified');
  assert.deepEqual(result.checks, []);
});

test('invalid input is rejected rather than treated as safe', () => {
  assert.throws(() => checkDrugInteractions(null), TypeError);
});
