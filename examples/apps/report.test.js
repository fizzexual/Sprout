const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function harness() {
  class Element {
    constructor(text = '') { this.textContent = text; this.events = {}; this.attributes = {}; this.value = ''; }
    addEventListener(name, fn) { this.events[name] = fn; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    replaceChildren(child) { this.button = child; }
    click() { this.clicked = true; }
  }
  const headers = ['Order', 'Customer', 'Amount'].map(value => new Element(value));
  const rows = [['2', 'Ada', '120.50'], ['1', 'Lin', '9.00'], ['3', '=SUM(A1)', '5.00']].map(values => ({ cells: values.map(value => new Element(value)), textContent: values.join(' '), hidden: false }));
  const body = { rows, append(...next) { this.rows = next; } };
  const table = { tHead: { rows: [{ cells: headers }] }, tBodies: [body] };
  const elements = { orders: table, search: new Element(), 'report-status': new Element(), download: new Element() };
  const created = [], blobs = [];
  const document = { getElementById: id => elements[id], createElement() { const element = new Element(); created.push(element); return element; } };
  const sandbox = { document, Intl, Blob, URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:report'; }, revokeObjectURL() {} }, setTimeout() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'report.js'), 'utf8'), sandbox);
  return { elements, body, rows, headers, created, blobs };
}

test('offline report search filters rows and announces the visible count', () => {
  const h = harness(); h.elements.search.value = 'ada'; h.elements.search.events.input();
  assert.equal(h.rows.filter(row => !row.hidden).length, 1);
  assert.equal(h.elements['report-status'].textContent, '1 of 3 orders shown');
});

test('column controls sort numeric values and expose ascending/descending state', () => {
  const h = harness(); h.headers[0].button.events.click();
  assert.deepEqual(h.body.rows.map(row => row.cells[0].textContent), ['1', '2', '3']);
  assert.equal(h.headers[0].attributes['aria-sort'], 'ascending');
  h.headers[0].button.events.click();
  assert.deepEqual(h.body.rows.map(row => row.cells[0].textContent), ['3', '2', '1']);
  assert.equal(h.headers[0].attributes['aria-sort'], 'descending');
});

test('download exports visible rows and neutralizes spreadsheet formulas', async () => {
  const h = harness(); h.elements.search.value = 'sum'; h.elements.search.events.input();
  h.elements.download.events.click();
  const csv = await h.blobs[0].text();
  assert.match(csv, /"'=SUM\(A1\)"/); assert.doesNotMatch(csv, /Ada|Lin/);
  assert.equal(h.created[h.created.length - 1].download, 'filtered-orders.csv');
  h.rows[2].cells[1].textContent = '  =SUM(A1)';
  h.elements.download.events.click();
  assert.match(await h.blobs[1].text(), /"'  =SUM\(A1\)"/);
});
