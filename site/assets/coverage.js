const controls = document.getElementById('coverage-controls');
const filter = document.getElementById('coverage-filter');
const status = document.getElementById('coverage-status');
const groups = [...document.querySelectorAll('[data-coverage-group]')];
const areas = groups.map(group => ({ group, rows: [...group.querySelectorAll('[data-coverage-row]')].map(row => ({
  row, content: row.textContent.toLocaleLowerCase(),
})) }));
const total = areas.reduce((count, group) => count + group.rows.length, 0);

function update() {
  const terms = filter.value.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  let count = 0;
  for (const { group, rows } of areas) {
    let matches = false;
    for (const { row, content } of rows) {
      const visible = terms.every(term => content.includes(term));
      row.hidden = !visible;
      if (visible) { matches = true; count++; }
    }
    group.hidden = !matches;
  }
  status.textContent = count ? `${count} of ${total} search areas` : 'No matching search areas. Try another word.';
}

filter.addEventListener('input', update);
controls.hidden = false;
update();
