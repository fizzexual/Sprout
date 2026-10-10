/* All behavior runs locally. CSV data was escaped by Sprout before rendering. */
(() => {
  const table = document.getElementById('orders');
  const search = document.getElementById('search');
  const status = document.getElementById('report-status');
  const rows = Array.from(table.tBodies[0].rows);
  let sortColumn = -1, descending = false;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function filter() {
    const query = search.value.trim().toLocaleLowerCase();
    for (const row of rows) row.hidden = !row.textContent.toLocaleLowerCase().includes(query);
    status.textContent = `${rows.filter(row => !row.hidden).length} of ${rows.length} orders shown`;
  }
  search.addEventListener('input', filter);
  for (const [column, header] of Array.from(table.tHead.rows[0].cells).entries()) {
    const button = document.createElement('button'); button.type = 'button';
    const label = header.textContent; button.textContent = label;
    button.setAttribute('aria-label', `Sort by ${label}`);
    header.replaceChildren(button);
    button.addEventListener('click', () => {
      descending = sortColumn === column ? !descending : false; sortColumn = column;
      for (const cell of table.tHead.rows[0].cells) cell.removeAttribute('aria-sort');
      header.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
      rows.sort((left, right) => collator.compare(left.cells[column].textContent, right.cells[column].textContent) * (descending ? -1 : 1));
      table.tBodies[0].append(...rows); filter();
    });
  }
  document.getElementById('download').addEventListener('click', () => {
    // Prefix spreadsheet formulas; quoting alone does not prevent formula execution.
    const quote = value => '"' + (/^(?:\s*[=+\-@]|[\t\r\n])/.test(value) ? "'" + value : value).replace(/"/g, '""') + '"';
    const headers = Array.from(table.tHead.rows[0].cells, cell => cell.textContent);
    const visible = rows.filter(row => !row.hidden).map(row => Array.from(row.cells, cell => cell.textContent));
    const csv = [headers, ...visible].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'filtered-orders.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  filter();
})();
