'use strict';
const path = require('node:path');
const { runSprout } = require('../../../integrations/node');

// Call outside the database transaction, then pass the returned value to Prisma.
async function normalizeDealValue(formEntry, options = {}) {
  const input = typeof formEntry === 'string' ? formEntry : null;
  const result = await runSprout(path.join(__dirname, 'deal-value.sprout'),
    { values: [input] }, { ...options, sandbox: true });
  if (!result || !Array.isArray(result.values) || result.values.length !== 1 ||
      typeof result.values[0] !== 'number' || !Number.isFinite(result.values[0])) {
    throw new TypeError('Sprout returned an invalid deal-value response.');
  }
  return result.values[0];
}
module.exports = { normalizeDealValue };
