// Overlays and side panels: modal stack, score sheet, last trick, hand summary,
// game over, settings, manual, bot picker, menu, info popovers and chat.
import { createCard } from './cards.js';
import { sound } from './sound.js';
import { SECTIONS, renderManual } from './manual.js';
import {
  app, h, $$, icon, prefs, savePrefs, store, toast, dur, posOf, isWij, teamCls, teamName,
  nameOf, suitSym, suitName, suitText, isRed, roemTotal, roemText, variantText, countUp, avatar, suitify,
} from './util.js';

const PLAYING = new Set(['trump', 'bid', 'play']);
const stack = [];

// ---------- modal stack ----------

export function openModal({ id = '', title = '', body = [], cls = '', closable = true, onClose = null, label = '' }) {
  if (id) byId(id)?.close(true);
  const back = document.activeElement;
  const m = { id, onClose };
  const head = title ? h('header', { class: 'dlg-head' },
    m.titleEl = h('h2', { text: title }),
    closable ? h('button', { class: 'icon-btn dlg-x', type: 'button', 'aria-label': 'Sluiten', title: 'Sluiten', onclick: () => m.close() }, icon('close')) : null) : null;
  m.body = h('div', { class: 'dlg-body' }, body);
  m.dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || label, tabIndex: -1 }, head, m.body);
  m.root = h('div', { class: 'modal ' + cls },
    h('div', { class: 'backdrop', onclick: closable ? () => m.close() : null }), m.dlg);
  m.closable = closable;
  m.close = (quiet = false) => {
    const i = stack.indexOf(m);
    if (i < 0) return;
    stack.splice(i, 1);
    m.root.classList.remove('open');
    setTimeout(() => m.root.remove(), dur(240) + 10);
    if (!quiet) m.onClose?.();
    if (back?.isConnected && !stack.length) back.focus?.({ preventScroll: true });
  };
  document.getElementById('modals').append(m.root);
  stack.push(m);
  requestAnimationFrame(() => {
    m.root.classList.add('open');
    if (!m.root.classList.contains('passive')) m.dlg.focus({ preventScroll: true });
  });
  return m;
}

const byId = id => stack.find(m => m.id === id);
export const isOpen = () => stack.some(m => !m.root.classList.contains('passive')) || chatOpen;
export function closeAll() {
  for (const m of [...stack]) m.close(true);
  setChat(false);
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const top = [...stack].reverse().find(m => m.closable);
  if (top) { top.close(); e.preventDefault(); return; }
  if (chatOpen) { setChat(false); e.preventDefault(); }
});

// Small explanation popover for ⓘ buttons.
export function info(title, text) {
  sound.play('click');
  openModal({ id: 'info', title, cls: 'm-info', body: [].concat(text).map(t => h('p', { text: t })) });
}

export function infoBtn(title, text) {
  return h('button', {
    class: 'info-btn', type: 'button', title: `Uitleg: ${title}`, 'aria-label': `Uitleg: ${title}`,
    onclick: e => { e.stopPropagation(); info(title, text); },
  }, icon('info'));
}

// ---------- tool buttons (top bars) ----------

const TOOLS = {
  last: ['history', 'Laatste slag', 'Laatste slag: bekijk wie wat speelde', () => openLastTrick()],
  score: ['score', 'Scorebord', 'Scorebord: alle potjes en de stand', () => openScoreSheet()],
  chat: ['chat', 'Chat', 'Chat met de tafel', () => toggleChat()],
  help: ['help', 'Handleiding', 'Handleiding: bediening, spelregels, roem en tips', () => openManual()],
  settings: ['settings', 'Instellingen', 'Instellingen: geluid, kaarten, animaties en je naam', () => openSettings()],
  sound: ['soundOn', 'Geluid', 'Geluid aan of uit', () => toggleSound()],
  menu: ['menu', 'Meer', 'Meer: scorebord, handleiding, instellingen', () => openMenu()],
};

export function toolButtons(names) {
  return names.map(n => {
    const [ic, label, title, fn] = TOOLS[n];
    const b = h('button', { class: 'tb tb-' + n, type: 'button', title, 'aria-label': label, onclick: () => { sound.unlock(); fn(); } },
      n === 'sound' ? icon(sound.isMuted() ? 'soundOff' : 'soundOn') : icon(ic));
    if (n === 'chat') b.append(h('span', { class: 'chat-badge', hidden: true }));
    return b;
  });
}

export function setLastEnabled(on) {
  for (const b of $$('.tb-last')) b.disabled = !on;
}

function toggleSound() {
  sound.setMuted(!sound.isMuted());
  if (!sound.isMuted()) sound.play('click');
  refreshSound();
  toast(sound.isMuted() ? 'Geluid uit' : 'Geluid aan', { ms: 1200 });
}

export function refreshSound() {
  for (const b of $$('.tb-sound')) {
    b.replaceChildren(icon(sound.isMuted() ? 'soundOff' : 'soundOn'));
    b.classList.toggle('muted', sound.isMuted());
  }
}

function openMenu() {
  const s = app.s;
  const item = (ic, text, fn, cls = '') => h('button', { class: 'menu-item ' + cls, type: 'button', onclick: () => { m.close(true); fn(); } }, icon(ic), h('span', { text }));
  const m = openModal({
    id: 'menu', cls: 'm-menu', label: 'Menu', body: [
      item('score', 'Scorebord', openScoreSheet),
      item('history', 'Laatste slag', openLastTrick),
      item('help', 'Handleiding', () => openManual()),
      item('settings', 'Instellingen', openSettings),
      item(sound.isMuted() ? 'soundOff' : 'soundOn', sound.isMuted() ? 'Geluid aanzetten' : 'Geluid uitzetten', toggleSound),
      s ? item('leave', 'Spel verlaten', () => confirmLeave(), 'danger') : null,
    ],
  });
}

function confirmLeave() {
  const s = app.s;
  const running = s && s.phase !== 'lobby' && s.phase !== 'gameOver';
  const m = openModal({
    id: 'leave', title: 'Spel verlaten?', cls: 'm-confirm', body: [
      h('p', { text: running ? 'Een AI-speler neemt je plaats aan tafel over.' : 'Je verlaat de tafel.' }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Blijven'),
        h('button', { class: 'btn btn-danger', type: 'button', onclick: () => { m.close(true); app.leave(); } }, 'Verlaten')),
    ],
  });
}

// ---------- mini cards and trick review ----------

function mini(code, cls = '') {
  const c = createCard(code, { size: 'sm' });
  if (cls) c.classList.add(cls);
  return c;
}

function trickTile(s, t, i) {
  const wij = isWij(s, t.winner);
  const roem = roemTotal(t.roem);
  return h('div', { class: 'mt ' + (wij ? 'wij' : 'zij'), title: `Slag ${i + 1}: ${nameOf(s, t.winner)} neemt de slag${roem ? `, roem ${roemText(t.roem)}` : ''}` },
    h('span', { class: 'mt-n', text: i + 1 }),
    h('span', { class: 'mt-cards' }, t.cards.map(pc => mini(pc.card, pc.seat === t.winner ? 'winner' : ''))),
    h('span', { class: 'mt-pts' }, h('b', { text: t.points ?? '' }), roem ? h('i', { text: `+${roem}` }) : null));
}

function review(s, tricks) {
  return h('div', { class: 'review' }, (tricks || []).map((t, i) => trickTile(s, t, i)));
}

// ---------- score sheet ----------

export function openScoreSheet() {
  const s = app.s;
  if (!s) return;
  sound.play('click');
  const m = openModal({ id: 'score', title: 'Scorebord', cls: 'm-score', body: [] });
  m.refresh = () => { m.body.replaceChildren(scoreBody(app.s, m)); };
  m.refresh();
}

function scoreBody(s, m) {
  const w = s.you % 2;
  const rows = (s.scores || []).map((r, i, all) => {
    const last = i === all.length - 1 && s.prevHand?.tricks?.length;
    const cell = team => {
      const nat = r.nat && r.playingTeam === team;
      const pit = r.pit && (r.nat ? 1 - r.playingTeam : r.playingTeam) === team;
      return h('td', { class: 'num ' + (team === w ? 'wij' : 'zij') + (nat ? ' is-nat' : '') + (pit ? ' is-pit' : '') },
        nat ? h('span', { class: 'tag tag-nat', text: 'nat' }) : null,
        pit ? h('span', { class: 'tag tag-pit', text: 'pit' }) : null,
        h('b', { text: r.score[team] }),
        r.roem?.[team] && !r.nat ? h('small', { text: `+${r.roem[team]} roem` }) : null);
    };
    return h('tr', { class: last ? 'tap' : '', onclick: last ? () => showReview(s, m, r) : null, title: last ? 'Tik om de slagen van dit potje te zien' : '' },
      h('td', { class: 'n', text: r.hand }),
      h('td', { class: 'tr' },
        h('span', { class: 'suit' + (isRed(r.trump) ? ' red' : ''), text: suitSym(r.trump) }),
        h('span', { class: 'by ' + (r.playingTeam === w ? 'wij' : 'zij'), text: r.trumpBy === s.you ? 'jij' : teamName(s, r.playingTeam) })),
      cell(w), cell(1 - w));
  });
  let live = null;
  if (PLAYING.has(s.phase) && s.trump) {
    const hp = s.handPoints || [0, 0];
    const hr = s.handRoem || [0, 0];
    const tw = s.tricksWon || [0, 0];
    const c = t => h('td', { class: 'num ' + (t === w ? 'wij' : 'zij') }, h('b', { text: hp[t] }), hr[t] ? h('small', { text: `+${hr[t]} roem` }) : null, h('small', { text: `${tw[t]} ${tw[t] === 1 ? 'slag' : 'slagen'}` }));
    live = h('tr', { class: 'live' },
      h('td', { class: 'n', text: s.handNo }),
      h('td', { class: 'tr' }, h('span', { class: 'suit' + (isRed(s.trump) ? ' red' : ''), text: suitSym(s.trump) }), h('span', { class: 'by', text: 'bezig' })),
      c(w), c(1 - w));
  }
  const total = s.total || [0, 0];
  const empty = !rows.length && !live;
  return h('div', { class: 'score-wrap' },
    h('table', { class: 'scoresheet' },
      h('thead', {}, h('tr', {},
        h('th', { class: 'n', text: '#' }), h('th', { text: 'Troef' }),
        h('th', { class: 'wij' }, 'Wij', h('small', { text: teamNamesShort(s, w) })),
        h('th', { class: 'zij' }, 'Zij', h('small', { text: teamNamesShort(s, 1 - w) })))),
      h('tbody', {}, rows, live,
        empty ? h('tr', {}, h('td', { colSpan: 4, class: 'empty', text: 'Nog geen potjes gespeeld.' })) : null),
      h('tfoot', {}, h('tr', {},
        h('td', { colSpan: 2, text: `Totaal na ${s.scores?.length || 0} van ${s.hands || s.opts?.hands || 16}` }),
        h('td', { class: 'num wij' }, h('b', { text: total[w] })),
        h('td', { class: 'num zij' }, h('b', { text: total[1 - w] }))))),
    h('p', { class: 'legend' },
      h('span', { class: 'tag tag-nat', text: 'nat' }), ' de spelende partij haalde niet meer dan de helft. ',
      h('span', { class: 'tag tag-pit', text: 'pit' }), ' alle acht slagen: 100 roem extra.',
      s.prevHand?.tricks?.length ? ' Tik op het laatste potje om de slagen te zien.' : ''));
}

function teamNamesShort(s, team) {
  const out = [];
  for (let seat = team; seat < 4; seat += 2) out.push(seat === s.you ? 'jij' : (s.players[seat]?.name || 'vrij').replace(/ \(AI\)$/, ''));
  return out.join(' & ');
}

function showReview(s, m, r) {
  sound.play('click');
  m.titleEl.textContent = `Potje ${r.hand}: de slagen`;
  m.body.replaceChildren(
    h('button', { class: 'btn btn-ghost btn-sm back-btn', type: 'button', onclick: () => { m.titleEl.textContent = 'Scorebord'; m.refresh(); } }, icon('back'), 'Terug naar scorebord'),
    resultLine(s, s.prevHand.result),
    review(s, s.prevHand.tricks));
}

function resultLine(s, r) {
  if (!r) return null;
  const w = s.you % 2;
  return h('p', { class: 'result-line' },
    h('span', { class: 'suit' + (isRed(r.trump) ? ' red' : ''), text: suitSym(r.trump) }),
    ` ${nameOf(s, r.trumpBy)} speelde ${suitName(r.trump)}. `,
    h('b', { class: 'wij', text: `Wij ${r.score[w]}` }), ' · ', h('b', { class: 'zij', text: `Zij ${r.score[1 - w]}` }),
    r.nat ? h('span', { class: 'tag tag-nat', text: 'nat' }) : null,
    r.pit ? h('span', { class: 'tag tag-pit', text: 'pit' }) : null);
}

// ---------- last trick ----------

export function openLastTrick() {
  const s = app.s;
  if (!s) return;
  const t = s.lastTrick;
  if (!t?.cards?.length) { toast('Er is nog geen slag gespeeld'); return; }
  sound.play('click');
  const cross = h('div', { class: 'cross' });
  for (const pc of t.cards) {
    const pos = posOf(pc.seat, s.you);
    cross.append(h('div', { class: `cross-slot cs-${pos} ${teamCls(s, pc.seat)}` + (pc.seat === t.winner ? ' win' : '') },
      mini(pc.card, pc.seat === t.winner ? 'winner' : ''),
      h('span', { class: 'cs-name', text: nameOf(s, pc.seat) }),
      pc.seat === t.leader ? h('span', { class: 'cs-lead', text: 'kwam uit' }) : null));
  }
  const roem = roemTotal(t.roem);
  openModal({
    id: 'last', title: 'Laatste slag', cls: 'm-last', body: [
      cross,
      h('p', { class: 'last-sum ' + teamCls(s, t.winner) },
        h('b', { text: `${nameOf(s, t.winner)} nam de slag` }),
        h('span', { text: ` · ${t.points} punten` }),
        roem ? h('span', { class: 'gold', text: ` · roem: ${roemText(t.roem)}` }) : null),
    ],
  });
}

// ---------- trump / variant info ----------

export function openTrumpInfo() {
  const s = app.s;
  if (!s) return;
  sound.play('click');
  const o = s.opts || {};
  const w = s.you % 2;
  const parts = [];
  if (s.trump && s.playingTeam >= 0) {
    parts.push(h('div', { class: 'ti-trump' + (isRed(s.trump) ? ' red' : '') },
      h('span', { class: 'ti-sym', text: suitSym(s.trump) }),
      h('div', {}, h('b', { text: `${suitName(s.trump)} is troef` }),
        h('span', { text: `Gekozen door ${nameOf(s, s.trumpBy, false)}${s.trumpBy === s.you ? ' (jij)' : ''}. ${teamName(s, s.playingTeam)} spelen en moeten meer dan de helft halen.` }))));
  } else {
    parts.push(h('p', { text: s.turned ? `Gedraaid: ${suitText(s.turned)}. Nog niemand speelt.` : 'Er is nog geen troef gekozen.' }));
  }
  if (PLAYING.has(s.phase) && s.trump) {
    const hp = s.handPoints || [0, 0];
    const hr = s.handRoem || [0, 0];
    parts.push(h('p', { class: 'ti-now' }, 'Dit potje: ',
      h('b', { class: 'wij', text: `Wij ${hp[w]}${hr[w] ? ` + ${hr[w]} roem` : ''}` }), ' · ',
      h('b', { class: 'zij', text: `Zij ${hp[1 - w]}${hr[1 - w] ? ` + ${hr[1 - w]} roem` : ''}` })));
  }
  parts.push(h('div', { class: 'ti-variant' },
    h('h3', { text: `Variant: ${variantText(o)}` }),
    h('p', { text: o.trumpMode === 'gedraaid'
      ? 'Gedraaid (vrij): er wordt een kleur gedraaid. Om de beurt zeg je spelen of passen. Past iedereen, dan moet de voorhand een andere kleur kiezen.'
      : 'Utrechts (verplicht): de voorhand moet troef kiezen en speelt dan.' }),
    h('p', { text: o.rules === 'rotterdams'
      ? 'Rotterdams: kun je niet bekennen, dan moet je altijd troeven, ook als je maat de slag heeft.'
      : 'Amsterdams: kun je niet bekennen en heeft je maat de slag, dan hoef je niet te troeven.' }),
    h('p', { class: 'muted', text: `${s.hands || o.hands || 16} potjes · AI ${o.ai || 'normaal'} · tempo ${o.tempo || 'normaal'}` })));
  openModal({ id: 'trumpinfo', title: 'Troef en variant', cls: 'm-info', body: parts });
}

// ---------- settings ----------

function toggleRow(label, sub, on, fn) {
  const input = h('input', { type: 'checkbox', checked: on, onchange: e => fn(e.target.checked) });
  return h('label', { class: 'set-row' }, h('span', { class: 'set-txt' }, h('b', { text: label }), sub ? h('small', { text: sub }) : null),
    h('span', { class: 'switch' }, input, h('i')));
}

export function segmented(choices, value, fn, name = '') {
  const wrap = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': name });
  const btns = choices.map(([v, label]) => h('button', {
    type: 'button', class: 'seg-btn', role: 'radio', 'aria-checked': String(v === value),
    onclick: () => { for (const b of btns) b.setAttribute('aria-checked', String(b === btn(v))); sound.play('click'); fn(v); },
  }, label));
  const btn = v => btns[choices.findIndex(c => c[0] === v)];
  wrap.append(...btns);
  return wrap;
}

export function applyPrefs() {
  document.body.classList.toggle('four-color', !!prefs.fourColor);
  document.body.classList.toggle('reduced', !!prefs.reduced);
}

export function openSettings() {
  sound.play('click');
  const name = h('input', { type: 'text', class: 'field', maxLength: 20, value: store.get('name', ''), placeholder: 'Je naam', autocomplete: 'nickname', enterKeyHint: 'done' });
  name.addEventListener('change', () => {
    const v = name.value.trim().slice(0, 20);
    if (v) { store.set('name', v); toast('Naam opgeslagen', { sub: app.code ? 'Geldt vanaf je volgende spel.' : '' }); }
  });
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: sound.getVolume?.() ?? 0.6, class: 'range', 'aria-label': 'Volume' });
  vol.addEventListener('input', () => sound.setVolume(Number(vol.value)));
  vol.addEventListener('change', () => sound.play('card'));
  const body = [
    h('section', { class: 'set-group' },
      h('h3', { text: 'Geluid' }),
      toggleRow('Geluidseffecten', 'Kaarten, troef, roem en je beurt', !sound.isMuted(), on => { sound.setMuted(!on); refreshSound(); if (on) sound.play('click'); }),
      h('div', { class: 'set-row' }, h('span', { class: 'set-txt' }, h('b', { text: 'Volume' })), vol)),
    h('section', { class: 'set-group' },
      h('h3', { text: 'Kaarten' }),
      toggleRow('Vierkleurenspel', 'Klaveren groen en ruiten blauw: makkelijker uit elkaar te houden', prefs.fourColor, on => { prefs.fourColor = on; savePrefs(); applyPrefs(); }),
      h('div', { class: 'set-row col' }, h('span', { class: 'set-txt' }, h('b', { text: 'Kaart spelen op een touchscreen' }),
        h('small', { text: 'Met een muis speel je altijd met één klik.' })),
      segmented([['one', 'Eén tik'], ['two', 'Twee tikken']], prefs.tap, v => { prefs.tap = v; savePrefs(); }, 'Kaart spelen')),
      h('p', { class: 'set-note', text: 'Twee tikken: eerste tik tilt de kaart op, tweede tik (of omhoog vegen) speelt hem.' })),
    h('section', { class: 'set-group' },
      h('h3', { text: 'Weergave' }),
      toggleRow('Minder animaties', 'Kortere en rustigere bewegingen', prefs.reduced, on => { prefs.reduced = on; savePrefs(); applyPrefs(); })),
    h('section', { class: 'set-group' },
      h('h3', { text: 'Jij' }),
      h('label', { class: 'set-row col' }, h('span', { class: 'set-txt' }, h('b', { text: 'Naam' })), name)),
  ];
  if (app.code && app.s) {
    body.push(h('section', { class: 'set-group' },
      h('button', { class: 'btn btn-danger btn-block', type: 'button', onclick: () => { m.close(true); confirmLeave(); } }, icon('leave'), 'Spel verlaten')));
  }
  const m = openModal({ id: 'settings', title: 'Instellingen', cls: 'm-settings', body });
}

// ---------- manual ----------

export function openManual(tab) {
  sound.play('click');
  const content = h('div', { class: 'man-scroll' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const btns = SECTIONS.map(sec => h('button', {
    class: 'tab', type: 'button', role: 'tab', dataset: { id: sec.id }, onclick: () => show(sec.id),
  }, sec.title));
  tabs.append(...btns);
  function show(id) {
    for (const b of btns) b.setAttribute('aria-selected', String(b.dataset.id === id));
    content.replaceChildren();
    try {
      content.append(renderManual(id));
    } catch {
      content.append(h('p', { text: 'Dit deel van de handleiding kon niet worden geladen.' }));
    }
    content.scrollTop = 0;
    prefs.tab = id;
    savePrefs();
    btns.find(b => b.dataset.id === id)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  openModal({ id: 'manual', title: 'Handleiding', cls: 'm-manual', body: [tabs, content] });
  const start = tab || prefs.tab;
  show(SECTIONS.some(x => x.id === start) ? start : SECTIONS[0].id);
}

// ---------- bot picker (lobby) ----------

export function openBotPicker(seat, s, { canSit = false } = {}) {
  sound.play('click');
  const pick = id => { m.close(true); sound.play('join'); app.send({ t: 'bot', seat, id }); };
  const cur = s.players[seat];
  const items = [];
  if (canSit) items.push(h('button', { class: 'bot-item sit', type: 'button', onclick: () => { m.close(true); app.send({ t: 'sit', seat }); } },
    h('span', { class: 'avatar' }, icon('enter')), h('span', { class: 'bot-txt' }, h('b', { text: 'Zelf hier gaan zitten' }), h('small', { text: 'Verhuis naar deze plaats' }))));
  items.push(h('button', { class: 'bot-item random', type: 'button', onclick: () => pick('') },
    h('span', { class: 'avatar', text: '🎲' }), h('span', { class: 'bot-txt' }, h('b', { text: 'Willekeurig' }), h('small', { text: 'Verras me maar' }))));
  for (const p of s.roster || []) {
    const taken = s.players.some(x => x?.bot && x.botId === p.id);
    items.push(h('button', { class: 'bot-item', type: 'button', disabled: taken && cur?.botId !== p.id, onclick: () => pick(p.id) },
      avatar({ bot: true, emoji: p.emoji, color: p.color }),
      h('span', { class: 'bot-txt' }, h('b', { text: `${p.name} (AI)` }), h('small', { text: taken ? 'Zit al aan tafel' : p.bio }))));
  }
  const m = openModal({ id: 'bots', title: cur?.bot ? 'Andere AI-speler kiezen' : 'AI-speler kiezen', cls: 'm-bots', body: h('div', { class: 'bot-list' }, items) });
}

// ---------- hand summary ----------

export function sync(s, ev) {
  if (s.phase === 'handEnd') showSummary(s, ev);
  else byId('summary')?.close(true);
  if (s.phase === 'gameOver') showGameOver(s, ev);
  else byId('over')?.close(true);
  if (s.phase === 'lobby') { byId('score')?.close(true); byId('last')?.close(true); }
  byId('score')?.refresh?.();
}

function summaryTitle(s, r) {
  const w = s.you % 2;
  const we = r.playingTeam === w;
  if (r.pit) return { t: 'Pit!', sub: r.pitTeam === w ? 'Wij halen alle acht slagen: 100 roem extra' : 'Zij halen alle acht slagen', cls: 'pit' };
  if (r.nat) return { t: 'Nat!', sub: we ? 'Wij spelen en halen het niet. Alle punten naar Zij.' : 'Zij spelen en halen het niet. Alle punten voor Wij!', cls: we ? 'nat bad' : 'nat good' };
  return { t: 'Gehaald!', sub: we ? 'Wij spelen en halen het.' : 'Zij spelen en halen het.', cls: we ? 'good' : 'neutral' };
}

function showSummary(s, ev) {
  const r = (ev?.type === 'handEnd' && ev.result) || s.prevHand?.result;
  if (!r) return;
  let m = byId('summary');
  if (!m) {
    const w = s.you % 2;
    const T = summaryTitle(s, r);
    const fresh = ev?.type === 'handEnd';
    const nums = [];
    const num = (v, cls) => { const el = h('b', { class: cls, text: fresh ? 0 : v }); if (fresh) nums.push([el, v]); else el.dataset.n = v; return el; };
    const row = (label, a, b, cls = '') => h('tr', { class: cls }, h('th', { text: label }), h('td', { class: 'wij' }, num(a)), h('td', { class: 'zij' }, num(b)));
    const total = s.total || [0, 0];
    const tricks = s.prevHand?.tricks || [];
    const ready = h('div', { class: 'ready-list' });
    const ring = countdownRing();
    const go = h('button', { class: 'btn btn-go btn-big', type: 'button', onclick: () => { sound.play('click'); app.send({ t: 'ready' }); go.disabled = true; go.lastChild.textContent = 'Wachten op de rest'; } },
      ring.el, h('span', { text: s.handNo >= s.hands ? 'Naar de uitslag' : 'Volgend potje' }));
    m = openModal({
      id: 'summary', cls: 'm-summary passive', closable: false, label: 'Uitslag van het potje', body: [
        h('div', { class: 'sum-head ' + T.cls },
          h('div', { class: 'sum-title', text: T.t }),
          h('div', { class: 'sum-sub', text: T.sub }),
          h('div', { class: 'sum-meta' },
            h('span', { class: 'suit' + (isRed(r.trump) ? ' red' : ''), text: suitSym(r.trump) }),
            ` ${nameOf(s, r.trumpBy)} speelde ${suitName(r.trump)} · potje ${s.handNo} van ${s.hands}`)),
        h('table', { class: 'sum-table' },
          h('thead', {}, h('tr', {}, h('th'), h('th', { class: 'wij', text: 'Wij' }), h('th', { class: 'zij', text: 'Zij' }))),
          h('tbody', {},
            row('Punten', r.points[w], r.points[1 - w]),
            row('Roem', r.roem[w], r.roem[1 - w]),
            row('Erbij', r.score[w], r.score[1 - w], 'sum-score'),
            row('Stand', total[w], total[1 - w], 'sum-total'))),
        r.nat ? h('p', { class: 'sum-why' }, infoBtn('Nat', [
          'De spelende partij moet meer dan de helft van alle punten plus roem halen. Lukt dat niet, dan gaan ze nat.',
          'Bij nat krijgt de tegenpartij alle 162 punten en alle roem van beide partijen.',
        ]), r.playingTeam === w ? ' Waarom nat? Wij haalden niet meer dan de helft.' : ' Zij haalden niet meer dan de helft.') : null,
        tricks.length ? h('div', { class: 'sum-review' }, h('h3', { text: 'De slagen' }), review(s, tricks)) : null,
        h('div', { class: 'sum-foot' }, go, ready),
      ],
    });
    m.go = go;
    m.ready = ready;
    m.ring = ring;
    if (fresh) setTimeout(() => nums.forEach(([el, v]) => countUp(el, v, 1100)), dur(350));
  }
  m.ring.set(s.nextAt);
  const mine = s.players[s.you]?.ready;
  if (mine) { m.go.disabled = true; m.go.lastChild.textContent = 'Wachten op de rest'; }
  m.ready.replaceChildren(...s.players.map((p, seat) => p && !p.bot ? h('span', { class: 'ready-chip ' + (p.ready ? 'on ' : '') + teamCls(s, seat) },
    p.ready ? icon('check') : null, nameOf(s, seat)) : null).filter(Boolean));
}

function countdownRing() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('class', 'ring-cd');
  svg.setAttribute('aria-hidden', 'true');
  const C = 2 * Math.PI * 15;
  const bg = document.createElementNS(NS, 'circle');
  const fg = document.createElementNS(NS, 'circle');
  for (const c of [bg, fg]) { c.setAttribute('cx', 18); c.setAttribute('cy', 18); c.setAttribute('r', 15); }
  bg.setAttribute('class', 'ring-bg');
  fg.setAttribute('class', 'ring-fg');
  fg.setAttribute('stroke-dasharray', C.toFixed(2));
  svg.append(bg, fg);
  let at = 0;
  let a = null;
  return {
    el: svg,
    set(nextAt) {
      if (!nextAt || nextAt === at) return;
      at = nextAt;
      const left = Math.max(0, Math.min(60000, nextAt - Date.now()));
      a?.cancel();
      fg.style.strokeDashoffset = '0';
      if (left > 0 && fg.animate) a = fg.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: C }], { duration: left, fill: 'forwards' });
    },
  };
}

// ---------- game over ----------

function showGameOver(s, ev) {
  if (byId('over')) {
    byId('over').refresh?.(s);
    return;
  }
  const w = s.you % 2;
  const total = (ev?.type === 'gameOver' && ev.total) || s.total || [0, 0];
  const winner = ev?.type === 'gameOver' ? ev.winner : s.winner;
  const won = winner === w;
  const draw = winner === -1;
  const title = draw ? 'Gelijkspel' : won ? 'Gewonnen!' : 'Verloren';
  const sub = draw ? 'Precies gelijk. Dat zie je niet vaak!' : won ? 'Wat een spel. Gefeliciteerd!' : 'Volgende keer beter. Nog een potje?';
  const host = s.host === s.you;
  const again = h('button', { class: 'btn btn-go btn-big', type: 'button', disabled: !host, onclick: () => { sound.play('click'); app.send({ t: 'rematch' }); } },
    host ? 'Nog een potje' : 'Wachten op de host');
  const m = openModal({
    id: 'over', cls: 'm-over passive' + (won ? ' won' : draw ? ' draw' : ' lost'), closable: false, label: title, body: [
      h('div', { class: 'over-emoji', 'aria-hidden': 'true', text: draw ? '🤝' : won ? '🏆' : '🃏' }),
      h('div', { class: 'over-title', text: title }),
      h('div', { class: 'over-sub', text: sub }),
      h('div', { class: 'over-score' },
        h('div', { class: 'os wij' + (winner === w ? ' top' : '') }, h('span', { text: 'Wij' }), h('b', { text: total[w] }), h('small', { text: teamNamesShort(s, w) })),
        h('div', { class: 'os-vs', text: '–' }),
        h('div', { class: 'os zij' + (winner === 1 - w ? ' top' : '') }, h('span', { text: 'Zij' }), h('b', { text: total[1 - w] }), h('small', { text: teamNamesShort(s, 1 - w) }))),
      s.prevHand?.result ? h('div', { class: 'over-last' }, h('small', { text: 'Laatste potje' }), resultLine(s, s.prevHand.result)) : null,
      h('div', { class: 'btn-col' },
        again,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => openScoreSheet() }, icon('score'), 'Scorebord'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => app.leave() }, icon('leave'), 'Naar start'))),
    ],
  });
  m.refresh = st => {
    const hst = st.host === st.you;
    again.disabled = !hst;
    again.textContent = hst ? 'Nog een potje' : 'Wachten op de host';
  };
  if (won && ev?.type === 'gameOver') confetti(m.root);
}

// Confetti burst for a few seconds: small paper strips thrown up from the
// middle, each a compositor-only transform animation (no canvas, no timers
// per frame).
export function confetti(root) {
  const k = dur(1000) / 1000;
  if (!k) return;
  const layer = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  root.prepend(layer);
  const W = root.clientWidth || innerWidth;
  const H = root.clientHeight || innerHeight;
  const colors = ['#f2c14e', '#2bb3a3', '#ef6f5a', '#ffffff', '#7bd389', '#e84a5f'];
  const n = Math.round((W < 600 ? 70 : 110) * Math.min(1, k + 0.3));
  const life = 3600 * Math.max(0.5, k);
  const steps = 8;
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const p = h('i', { class: 'cf' });
    p.style.background = colors[i % colors.length];
    const w = 6 + Math.random() * 6;
    p.style.width = w + 'px';
    p.style.height = w / 2 + 'px';
    layer.append(p);
    // A throw under gravity, sampled into keyframes.
    const x0 = W * (0.25 + Math.random() * 0.5);
    const y0 = H * (0.35 + Math.random() * 0.1);
    const vx = (Math.random() - 0.5) * W * 0.9;
    const vy = -(0.5 + Math.random() * 0.7) * H;
    const g = 2.2 * H;
    const spin = (Math.random() - 0.5) * 1440;
    const frames = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + vx * t * 0.8;
      const y = y0 + vy * t + 0.5 * g * t * t;
      frames.push({ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(spin * t).toFixed(1)}deg)`, opacity: t < 0.75 ? 1 : (1 - t) * 4 });
    }
    const a = p.animate(frames, { duration: life * (0.8 + Math.random() * 0.4), easing: 'linear', fill: 'forwards' });
    jobs.push(a.finished.catch(() => {}));
  }
  Promise.all(jobs).then(() => layer.remove());
}

// ---------- chat ----------

let chatOpen = false;
let unread = 0;
let log = [];          // messages shown, to re-render once seats are known
const C = {};
const QUICK = ['👍', '😂', '😱', 'Mooi!', 'Nat!', 'Goed gespeeld!'];
const wideMQ = matchMedia('(min-width: 1200px)');

export function initChat() {
  C.list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite', 'aria-label': 'Chatberichten' });
  C.input = h('input', { type: 'text', class: 'field chat-input', maxLength: 200, placeholder: 'Zeg iets…', autocomplete: 'off', enterKeyHint: 'send', 'aria-label': 'Chatbericht' });
  const form = h('form', { class: 'chat-form', onsubmit: e => { e.preventDefault(); sendChat(C.input.value); } },
    C.input, h('button', { class: 'icon-btn chat-send', type: 'submit', 'aria-label': 'Versturen', title: 'Versturen' }, icon('send')));
  C.root = h('aside', { class: 'chat', id: 'chat', 'aria-label': 'Chat' },
    h('header', { class: 'chat-head' }, h('h2', { text: 'Chat' }),
      h('button', { class: 'icon-btn chat-x', type: 'button', 'aria-label': 'Chat sluiten', title: 'Sluiten', onclick: () => setChat(false) }, icon('close'))),
    C.list,
    h('div', { class: 'chat-quick' }, QUICK.map(q => h('button', { class: 'quick', type: 'button', onclick: () => sendChat(q) }, q))),
    form);
  C.scrim = h('div', { class: 'chat-scrim', onclick: () => setChat(false) });
  document.getElementById('app').append(C.scrim, C.root);
  wideMQ.addEventListener('change', () => { if (chatVisible()) clearUnread(); });
}

function sendChat(text) {
  const t = text.trim().slice(0, 200);
  if (!t) return;
  if (!app.code) { toast('Je zit nog niet aan een tafel'); return; }
  app.send({ t: 'chat', text: t });
  C.input.value = '';
}

const chatVisible = () => chatOpen || (wideMQ.matches && document.body.classList.contains('in-room'));

export function toggleChat() { setChat(!chatOpen); }

export function setChat(open) {
  if (open && wideMQ.matches && document.body.classList.contains('in-room')) {
    C.input.focus();
    return;
  }
  chatOpen = open;
  document.body.classList.toggle('chat-open', open);
  if (open) {
    clearUnread();
    C.list.scrollTop = C.list.scrollHeight;
    if (matchMedia('(pointer: fine)').matches) setTimeout(() => C.input.focus(), 50);
  }
}

function clearUnread() {
  unread = 0;
  badge();
}

function badge() {
  for (const b of $$('.chat-badge')) {
    b.hidden = !unread;
    b.textContent = unread > 9 ? '9+' : unread;
  }
}

function msgEl(m) {
  const s = app.s;
  const sys = m.sys || m.seat < 0;
  const mine = s && m.seat === s.you && !sys;
  const team = s && !sys && m.seat >= 0 ? teamCls(s, m.seat) : '';
  return h('div', { class: 'msg' + (sys ? ' sys' : '') + (mine ? ' mine' : '') + (m.bot ? ' bot' : '') },
    sys ? null : h('span', { class: 'msg-name ' + team, text: m.name || 'Speler' }),
    h('span', { class: 'msg-text' }, suitify(m.text)));
}

export function chatAdd(m, live = true) {
  const atEnd = C.list.scrollHeight - C.list.scrollTop - C.list.clientHeight < 40;
  log.push(m);
  C.list.append(msgEl(m));
  while (C.list.children.length > 120) { C.list.firstChild.remove(); log.shift(); }
  if (atEnd || m.seat === app.s?.you) C.list.scrollTop = C.list.scrollHeight;
  if (!live) return;
  const mine = app.s && m.seat === app.s.you && !m.sys;
  if (!mine) {
    if (!m.sys) sound.play('chat');
    if (!chatVisible()) { unread++; badge(); }
  }
}

export function chatSet(msgs) {
  log = [...(msgs || [])];
  C.list.replaceChildren(...log.map(msgEl));
  C.list.scrollTop = C.list.scrollHeight;
}

// Re-renders the log, e.g. once the first state tells who sits where.
export function chatRefresh() {
  chatSet(log);
}

export function chatReset() {
  log = [];
  C.list.replaceChildren();
  clearUnread();
  setChat(false);
}
