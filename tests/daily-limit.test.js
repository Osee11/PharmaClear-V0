'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDailyAnalysisLimiter } = require('../daily-limit');

test('a failed analysis reservation can be refunded while successful work remains counted', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pharmaclear-quota-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'daily-usage.json');
  const limiter = createDailyAnalysisLimiter({
    limit: 1,
    filePath,
    now: () => new Date('2026-10-31T12:00:00.000Z'),
  });

  const failedReservation = await limiter.consume();
  assert.equal(failedReservation.allowed, true);
  assert.equal((await limiter.consume()).allowed, false);

  assert.equal(await limiter.refund(failedReservation.reservation), true);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
    date: '2026-10-31',
    count: 0,
  });
  assert.equal(await limiter.refund(failedReservation.reservation), false);

  const successfulReservation = await limiter.consume();
  assert.equal(successfulReservation.allowed, true);
  assert.equal((await limiter.consume()).allowed, false);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
    date: '2026-10-31',
    count: 1,
  });
});
