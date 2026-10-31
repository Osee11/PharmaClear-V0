'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function createDailyAnalysisLimiter({ limit, filePath, now = () => new Date() }) {
  let queue = Promise.resolve();

  function serialize(operation) {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readUsage(date) {
    let current;
    try {
      current = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { date, count: 0 };
      throw error;
    }

    if (!current || typeof current.date !== 'string' ||
        !Number.isSafeInteger(current.count) || current.count < 0 ||
        current.date !== date) {
      return { date, count: 0 };
    }
    return current;
  }

  async function writeUsage(usage) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryFile = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(usage)}\n`, { mode: 0o600 });
    await fs.rename(temporaryFile, filePath);
  }

  async function consume() {
    const date = now().toISOString().slice(0, 10);
    if (limit === 0) {
      return { allowed: true, reservation: { date, counted: false, refunded: false } };
    }

    return serialize(async () => {
      const usage = await readUsage(date);
      if (usage.count >= limit) return { allowed: false, remaining: 0 };
      const next = { date, count: usage.count + 1 };
      await writeUsage(next);
      return {
        allowed: true,
        remaining: limit - next.count,
        reservation: { date, counted: true, refunded: false },
      };
    });
  }

  async function refund(reservation) {
    if (!reservation || !reservation.counted || reservation.refunded) return false;
    const refunded = await serialize(async () => {
      const usage = await readUsage(reservation.date);
      if (usage.count === 0) return false;
      await writeUsage({ date: usage.date, count: usage.count - 1 });
      return true;
    });
    reservation.refunded = true;
    return refunded;
  }

  return { consume, refund };
}

module.exports = { createDailyAnalysisLimiter };
