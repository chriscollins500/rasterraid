const controls = document.getElementById('coverage-controls');
const filter = document.getElementById('coverage-filter');
const method = document.getElementById('coverage-method');
const status = document.getElementById('coverage-status');
const groups = [...document.querySelectorAll('[data-coverage-group]')];
const outline = document.querySelector('.page-outline');
const sectionLinks = new Map([...(outline?.querySelectorAll('a') ?? [])].map(link => [link.hash.slice(1), link.closest('li')]));
const areas = groups.map(group => ({ group, link: sectionLinks.get(group.querySelector('h2')?.id), rows: [...group.querySelectorAll('[data-coverage-row]')].map(row => ({
  row, content: row.textContent.toLocaleLowerCase(),
})) }));
const total = areas.reduce((count, group) => count + group.rows.length, 0);

function update() {
  const terms = filter.value.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  let count = 0;
  for (const { group, link, rows } of areas) {
    let matches = false;
    for (const { row, content } of rows) {
      const visible = (!method?.value || method.value === row.dataset.method) && terms.every(term => content.includes(term));
      row.hidden = !visible;
      if (visible) { matches = true; count++; }
    }
    group.hidden = !matches;
    if (link) link.hidden = !matches;
  }
  if (outline) outline.hidden = !count;
  status.textContent = count ? `${count} of ${total} search areas` : 'No matching search areas. Try another word or access type.';
}

filter.addEventListener('input', update);
method?.addEventListener('change', update);
controls.hidden = false;
update();
