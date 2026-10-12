'use strict';
// Synthetic prior Node rules authored here. BigInt is the amount/identifier model.
const ID = /^[1-9][0-9]{0,18}(?![\s\S])/;
const PRICE = /^(?:0|[1-9][0-9]*)\.[0-9]{2}(?![\s\S])/;
const TAGS = new Set(['$sprout.integer', '$sprout.decimal', '$sprout.bytes']);
const map = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  !(Object.keys(value).length === 1 && TAGS.has(Object.keys(value)[0]));

function schema(request) {
  const errors = []; let truncated = false;
  const reject = path => {
    if (errors.length < 64) errors.push({ path, code: 'validation', message: 'Input does not match the declared field schema.' });
    else truncated = true;
  };
  const text = (value, path, min = 0, max = 1048576, allowed) => {
    if (typeof value !== 'string') return reject(path);
    if (allowed && !allowed.includes(value)) reject(path);
    const length = Array.from(value).length;
    if (length < min || length > max) reject(path);
  };
  const record = (value, path, fields) => {
    if (!map(value) || Object.keys(value).length > 128) return reject(path);
    for (const [key, check] of fields) {
      if (truncated) return;
      if (!Object.hasOwn(value, key)) reject([...path, key]); else check(value[key], [...path, key]);
    }
    const known = new Set(fields.map(([key]) => key));
    for (const key of Object.keys(value)) {
      if (truncated) return;
      if (!known.has(key)) reject([...path, '<unknown>']);
    }
  };
  const quantity = (value, path) => { if (typeof value !== 'number' || !Number.isFinite(value)) reject(path); };
  const member = (value, path) => { if (typeof value !== 'boolean') reject(path); };
  const lines = (value, path) => {
    if (!Array.isArray(value) || value.length > 10000) return reject(path);
    if (value.length < 1 || value.length > 32) reject(path);
    for (let index = 0; index < value.length && !truncated; index++) record(value[index], [...path, index], [
      ['sku_id', (v, p) => text(v, p, 1, 19)], ['quantity', quantity], ['unit_price', (v, p) => text(v, p, 4, 10)]]);
  };
  record(request, [], [['order_id', (v, p) => text(v, p, 1, 19)],
    ['currency', (v, p) => text(v, p, 0, 1048576, ['USD'])], ['member', member],
    ['shipping', (v, p) => text(v, p, 0, 1048576, ['standard', 'express'])], ['lines', lines]]);
  return { errors, truncated };
}

function evaluate(request) {
  const result = { ok: false, quote: null, decisions: [], errors: [], truncated: false };
  const checked = schema(request);
  if (checked.errors.length || checked.truncated) return { ...result,
    errors: checked.errors.slice(0, 16), truncated: checked.truncated || checked.errors.length > 16 };
  const reject = (path, code, message) => {
    if (result.errors.length < 16) result.errors.push({ path, code, message }); else result.truncated = true;
  };
  const identifier = (value, path) => {
    if (!ID.test(value)) reject(path, 'id_format', 'ID requires canonical positive decimal digits without a sign or leading zeros.');
    else if (BigInt(value) > 9223372036854775807n) reject(path, 'id_range', 'ID exceeds the positive signed-int64 range.');
    else return BigInt(value);
    return null;
  };
  const orderId = identifier(request.order_id, ['order_id']);
  const seen = new Set(), lines = []; let gross = 0n, units = 0n;
  request.lines.forEach((line, index) => {
    const sku = identifier(line.sku_id, ['lines', index, 'sku_id']);
    if (sku !== null) {
      if (seen.has(sku)) reject(['lines', index, 'sku_id'], 'duplicate_sku', 'SKU must be unique within the basket.');
      seen.add(sku);
    }
    const validQuantity = Number.isInteger(line.quantity) && line.quantity >= 1 && line.quantity <= 1000;
    if (!validQuantity) reject(['lines', index, 'quantity'], 'quantity_range', 'Quantity requires a whole ordinary number from 1 to 1000.');
    let price = null;
    if (!PRICE.test(line.unit_price)) reject(['lines', index, 'unit_price'], 'price_format', 'Price requires canonical nonnegative decimal text with exactly two fractional digits.');
    else {
      price = BigInt(line.unit_price.replace('.', ''));
      if (price > 100000000n) { reject(['lines', index, 'unit_price'], 'price_range', 'Unit price exceeds 1000000.00 USD.'); price = null; }
    }
    if (sku !== null && validQuantity && price !== null) {
      const quantity = BigInt(line.quantity), amount = price * quantity;
      units += quantity; gross += amount;
      lines.push({ sku_id: sku, quantity, unit_price: price, gross: amount });
    }
  });
  if (result.errors.length) return result;

  const offers = [{ rule: 'high_value', eligible: gross >= 50000n, rate_bps: 1000n },
    { rule: 'value', eligible: gross >= 20000n, rate_bps: 750n },
    { rule: 'bulk', eligible: units >= 20n, rate_bps: 750n },
    { rule: 'member', eligible: request.member, rate_bps: 500n }];
  const winner = offers.filter(offer => offer.eligible).reduce((best, offer) =>
    offer.rate_bps > best.rate_bps ? offer : best, { rule: 'none', rate_bps: 0n });
  // BigInt truncating division independently implements nonnegative half-up cents.
  const discount = (gross * winner.rate_bps + 5000n) / 10000n;
  const net = gross - discount;
  const shippingRule = request.shipping === 'express' ? 'express_fixed' : net >= 10000n ? 'standard_free' : 'standard_paid';
  const shipping = shippingRule === 'express_fixed' ? 1499n : shippingRule === 'standard_free' ? 0n : 499n;
  const decisions = offers.map(offer => ({ ...offer, selected: offer.rule === winner.rule }));
  decisions.push({ rule: 'discount', code: winner.rule, rate_bps: winner.rate_bps, rounding: 'half_up_once' },
    { rule: 'shipping', code: shippingRule });
  return { ok: true, quote: { order_id: orderId, currency: 'USD', lines, units, gross, discount, net, shipping, total: net + shipping },
    decisions, errors: [], truncated: false };
}

function semantic(result) {
  if (!result.ok) return result;
  const exact = value => { if (typeof value !== 'bigint') throw new TypeError('Expected BigInt'); return String(value); };
  const quote = result.quote;
  return { ...result, quote: { order_id: exact(quote.order_id), currency: quote.currency, units: exact(quote.units),
    lines: quote.lines.map(line => Object.fromEntries(Object.entries(line).map(([key, value]) => [key, exact(value)]))),
    ...Object.fromEntries(['gross', 'discount', 'net', 'shipping', 'total'].map(key => [key, exact(quote[key])])) },
    decisions: result.decisions.map(item => Object.hasOwn(item, 'rate_bps') ? { ...item, rate_bps: exact(item.rate_bps) } : item) };
}

module.exports = { evaluate, semantic };
if (require.main === module) {
  const fs = require('node:fs');
  process.stdout.write(JSON.stringify(semantic(evaluate(JSON.parse(fs.readFileSync(0, 'utf8'))))) + '\n');
}
