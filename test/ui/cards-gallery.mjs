// Builds the card gallery (test/ui/cards-gallery.html): every face and back at
// several sizes, two- and four-colour decks, a fanned hand and the state classes.
import { SUITS, RANKS, cardName, cardShort, createCard, createBack, suitIcon } from '../../platform/web/js/cards.js';

const main = document.getElementById('gallery');
const SUIT_ORDER = ['S', 'H', 'C', 'D'];
const RANK_ORDER = Object.keys(RANKS).sort((a, b) => '23456789TJQKA'.indexOf(a) - '23456789TJQKA'.indexOf(b));
const ALL = SUIT_ORDER.flatMap((s) => RANK_ORDER.map((r) => r + s));

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function section(title, extraClass) {
  main.append(el('h2', null, title));
  const box = el('section', extraClass);
  main.append(box);
  return box;
}

function deck(title, width, opts = {}) {
  const box = section(title, opts.fourColor ? 'four-color' : '');
  box.style.setProperty('--card-w', `${width}px`);
  for (const s of SUIT_ORDER) {
    const row = el('div', width < 70 ? 'row tight' : 'row');
    for (const r of RANK_ORDER) row.append(createCard(r + s));
    box.append(row);
  }
}

deck('Alle kaarten — 90 px', 90);
deck('140 px', 140);
deck('60 px', 60);
deck('40 px', 40);
deck('30 px', 30);
deck('24 px', 24);
deck('Vierkleurig — 60 px', 60, { fourColor: true });
deck('Vierkleurig — 90 px', 90, { fourColor: true });

{
  const box = section('Achterkant — 40, 60, 90, 140 px');
  for (const color of ['blue', 'red']) {
    const row = el('div', 'row');
    for (const w of [40, 60, 90, 140]) {
      const b = createBack({ color });
      b.style.setProperty('--card-w', `${w}px`);
      row.append(b);
    }
    box.append(row);
  }
  const row = el('div', 'row');
  row.id = 'sizes';
  row.append(el('span', 'label', 'sm / md / lg'));
  for (const size of ['sm', 'md', 'lg']) row.append(createCard('KH', { size }));
  for (const size of ['sm', 'md', 'lg']) row.append(createBack({ size }));
  box.append(row);
}

function fan(title, width, codes, fourColor) {
  const box = section(title, fourColor ? 'four-color' : '');
  const f = el('div', 'fan');
  f.style.setProperty('--card-w', `${width}px`);
  const n = codes.length;
  codes.forEach((code, i) => {
    const c = createCard(code);
    c.style.left = `${40 + i * width * 0.3}px`;
    c.style.transform = `rotate(${(i - (n - 1) / 2) * 3}deg)`;
    if (i === 3) c.classList.add('selected');
    f.append(c);
  });
  box.append(f);
}

const HAND = ['JH', '9H', 'AH', 'TH', 'AS', 'TS', 'KC', 'QD'];
fan('Hand in waaier — 64 px (telefoon)', 64, HAND);
fan('Hand in waaier — 110 px (desktop)', 110, ['7S', '8S', 'TC', 'JC', 'QC', 'AD', '9D', 'KH']);
fan('Hand in waaier — 52 px, vierkleurig', 52, HAND, true);

{
  const box = section('Toestanden', 'row states');
  box.style.setProperty('--card-w', '90px');
  const states = [
    ['', 'normaal'], ['legal', 'legal'], ['selected', 'selected'], ['disabled', 'disabled'],
    ['hint', 'hint'], ['winner', 'winner'], ['legal selected', 'legal + selected'], ['selectable', 'selectable'],
  ];
  for (const [cls, label] of states) {
    const cell = el('div', 'cell');
    const c = createCard('QS');
    if (cls) c.classList.add(...cls.split(' '));
    cell.append(c, el('span', null, label));
    box.append(cell);
  }
}

{
  const box = section('Kleursymbolen voor de interface');
  const dark = el('div', 'dark-ui');
  dark.style.setProperty('--kj-ink-black', '#f2efe6');
  dark.style.setProperty('--kj-ink-red', '#ff6b78');
  for (const s of SUIT_ORDER) dark.append(suitIcon(s));
  dark.append(el('span', null, ' · '));
  for (const s of SUIT_ORDER) dark.append(suitIcon(s, { colored: true }));
  const light = el('div', 'dark-ui four-color');
  light.style.background = '#f4efe2';
  light.style.color = '#333';
  for (const s of SUIT_ORDER) light.append(suitIcon(s, { colored: true }));
  const names = el('div', 'row');
  names.append(el('span', null, ALL.slice(0, 8).map((c) => `${cardShort(c)} = ${cardName(c)}`).join(' · ')));
  box.append(dark, el('span', null, '  '), light, names);
}

document.body.dataset.ready = '1';
console.log(`gallery: ${main.querySelectorAll('.card').length} cards, ${Object.keys(SUITS).length} suits`);
