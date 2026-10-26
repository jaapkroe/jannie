// Overlays and side panels: modal stack, score sheet, last trick, hand summary,
// game over, settings, manual, bot picker, menu, info popovers and chat.
import { createCard, cardShort } from './cards.js';
import { sound } from './sound.js';
import { SECTIONS, renderManual } from './manual.js';
import {
  app, h, $$, icon, prefs, savePrefs, store, toast, dur, posOf, seatCount, mySide, isWij, teamCls, teamName,
  scorerOrder, scorerName, myScorer, nameOf, suitSym, suitName, suitText, isRed, roemTotal, roemText, variantText, countUp, avatar,
  playerName, suitify, cap, handHeadline,
  reviewVerdict, luckText, pointsText, momentWhere, strongLine, missedLine, outcomeLine, timeText, reviewHistory,
} from './util.js';

const PLAYING = new Set(['auction', 'discard', 'trump', 'bid', 'play']);
const stack = [];
const fine = matchMedia('(pointer: fine)');
const touch = matchMedia('(pointer: coarse)');
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

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
    syncHistory();
  };
  document.getElementById('modals').append(m.root);
  stack.push(m);
  requestAnimationFrame(() => {
    if (!stack.includes(m)) return; // closed again within the frame
    m.root.classList.add('open');
    if (!m.root.classList.contains('passive')) m.dlg.focus({ preventScroll: true });
  });
  syncHistory();
  return m;
}

const byId = id => stack.find(m => m.id === id);
const passive = m => m.root.classList.contains('passive');
export const isOpen = () => stack.some(m => !passive(m)) || chatOpen;
export function closeAll() {
  for (const m of [...stack]) m.close(true);
  setChat(false);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Tab') { trapFocus(e); return; }
  if (e.key !== 'Escape') return;
  const top = [...stack].reverse().find(m => m.closable);
  if (top) { top.close(); e.preventDefault(); return; }
  if (chatOpen) { setChat(false); e.preventDefault(); }
});

// Tab and Shift+Tab stay inside the top dialog; the table behind the
// backdrop is out of reach until it closes. Passive overlays (hand summary,
// game over) leave the chat beside them usable.
function trapFocus(e) {
  const top = [...stack].reverse().find(m => !passive(m));
  if (!top) return;
  const items = [...top.dlg.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && el.getClientRects().length);
  const ae = document.activeElement;
  if (!items.length) { e.preventDefault(); top.dlg.focus(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  if (!top.dlg.contains(ae)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (e.shiftKey && (ae === first || ae === top.dlg)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && ae === last) { e.preventDefault(); first.focus(); }
}

// Focuses the main button of an overlay for keyboard users (not on touch
// screens: no focus ring there), unless they are busy elsewhere (typing in
// the chat beside it, another dialog).
function focusMain(btn) {
  if (touch.matches) return;
  requestAnimationFrame(() => {
    if (btn.closest('.modal.open') && !btn.disabled && !isOpen() && focusFree()) btn.focus({ preventScroll: true });
  });
}

// Nothing has the focus, or only something on its way out (the button of
// the hand summary that is closing as the next overlay opens).
export function focusFree() {
  const ae = document.activeElement;
  return !ae || ae === document.body || !ae.isConnected || !!ae.closest('#modals .modal:not(.open)');
}

// ---------- back button ----------

// Every closable overlay (modal or chat drawer) and, while at a table, one
// sentinel entry get a history entry: the Android back gesture then closes
// the top overlay, and at the table asks before leaving, instead of leaving
// the page (or the installed app). history.state.kj is an entry's depth.
let depth = 0;      // our entries above the page's own
let expect = -1;    // depth a traversal we started will arrive at
let expectTimer = 0;
let syncTimer = 0;

const inRoom = () => document.body.classList.contains('in-room');
const overlays = () => stack.filter(m => m.closable).length + (chatOpen ? 1 : 0);
const wanted = () => (inRoom() ? 1 : 0) + overlays();

// Brings the history in line with what is open, once the current task is
// done (closing the menu and opening the score sheet is no change).
export function syncHistory() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(applyHistory, 0);
}

function applyHistory() {
  if (expect >= 0) return; // our own traversal is still under way
  const want = wanted();
  while (depth < want) history.pushState({ kj: ++depth }, '');
  if (depth > want) {
    expect = want;
    clearTimeout(expectTimer);
    expectTimer = setTimeout(() => { expect = -1; }, 1500); // the browser had nothing to go back to
    history.go(want - depth);
    depth = want;
  }
}

// The entries share the URL they were pushed with; keep it right for now.
function fixUrl() {
  const path = app.code ? '/' + app.code : '/';
  if (location.pathname !== path) history.replaceState(history.state, '', path);
}

addEventListener('popstate', e => {
  const d = Number(e.state?.kj) || 0;
  if (expect >= 0 && d === expect) {
    expect = -1;
    clearTimeout(expectTimer);
  } else {
    // The user went back (or forward): close overlays from the top until
    // what is open fits; back past the sentinel at the table asks first.
    expect = -1;
    depth = d;
    while (wanted() > d && overlays()) closeTop();
    if (inRoom() && d === 0 && !overlays()) confirmLeave();
  }
  fixUrl();
  syncHistory();
});

function closeTop() {
  const top = [...stack].reverse().find(m => m.closable);
  if (top) top.close();
  else setChat(false);
}

history.replaceState({ kj: 0 }, '');

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
  sound: ['soundOn', 'Geluid', 'Geluid aan', () => toggleSound()], // a toggle: soundState sets icon, tooltip, aria-pressed
  menu: ['menu', 'Meer', 'Meer: scorebord, handleiding, instellingen', () => openMenu()],
  expert: ['search', 'Expert', 'Expert: terugkijken, de redenering van de AI en commentaar', () => openExpert({ hand: app.s?.handNo, step: 'end' })],
};

export function toolButtons(names) {
  return names.map(n => {
    const [ic, label, title, fn] = TOOLS[n];
    const b = h('button', { class: 'tb tb-' + n, type: 'button', title, 'aria-label': label, onclick: () => { sound.unlock(); fn(); } }, icon(ic));
    if (n === 'chat') b.append(h('span', { class: 'chat-badge', hidden: true }));
    if (n === 'sound') soundState(b);
    if (n === 'expert') b.hidden = true; // shown in an expert game (table.js)
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
  for (const b of $$('.tb-sound')) soundState(b);
}

// The sound button is a toggle: pressed while the sound is on. Its icon and
// tooltip say which it is now ("Geluid aan", "Geluid uit"); the label
// stays "Geluid", so a screen reader says "Geluid, ingedrukt".
function soundState(b) {
  const on = !sound.isMuted();
  b.replaceChildren(icon(on ? 'soundOn' : 'soundOff'));
  b.classList.toggle('muted', !on);
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Geluid aan' : 'Geluid uit';
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
      app.call?.inCall() ? item('hangup', 'Ophangen', () => app.call.hangup())
        : app.call?.possible() && app.call.supported() ? item('phone', 'Bellen', () => app.call.openSheet()) : null,
      s ? item('leave', 'Spel verlaten', () => confirmLeave(), 'danger') : null,
    ],
  });
}

// Mid-game the seat stays empty until someone joins in it, or until the
// others agree that an AI takes it (design §6); alone with bots there is
// nobody to ask.
export function confirmLeave() {
  const s = app.s;
  const running = s && s.phase !== 'lobby' && s.phase !== 'gameOver';
  const others = s && s.players.some((p, seat) => p && !p.bot && !p.left && seat !== s.you);
  const m = openModal({
    id: 'leave', title: 'Spel verlaten?', cls: 'm-confirm', body: [
      h('p', { text: running && others ? 'De anderen beslissen samen of een AI-speler je plaats inneemt.' : 'Je verlaat de tafel.' }),
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

// One trick of a finished hand: the cards in play order (the first came
// out), each underlined in its team's colour. Tapping it shows who played
// what at the seats, as for the last trick.
function trickTile(s, t, i, owner) {
  const wij = isWij(s, t.winner);
  const roem = roemTotal(t.roem);
  const what = `Slag ${i + 1}: ${nameOf(s, t.winner)} nam de slag${roem ? `, roem: ${roemText(t.roem)}` : ''}`;
  return h('button', {
    class: 'mt ' + (wij ? 'wij' : 'zij'), type: 'button', title: `${what}. Tik om te zien wie wat speelde.`, 'aria-label': what,
    onclick: () => openTrick(s, t, i, owner),
  },
    h('span', { class: 'mt-n', text: i + 1 }),
    h('span', { class: 'mt-cards' }, t.cards.map(pc => {
      const c = mini(pc.card, pc.seat === t.winner ? 'winner' : '');
      c.dataset.team = teamCls(s, pc.seat);
      return c;
    })),
    h('span', { class: 'mt-pts' }, h('b', { text: t.points ?? '' }), roem ? h('i', { text: `+${roem}` }) : null));
}

function review(s, tricks, owner) {
  return h('div', { class: 'review' }, (tricks || []).map((t, i) => trickTile(s, t, i, owner)));
}

// A trick laid out at the seats: whose card is whose, who came out, who won.
function trickCross(s, t) {
  const cross = h('div', { class: 'cross' });
  for (const pc of t.cards) {
    const pos = posOf(s, pc.seat);
    cross.append(h('div', { class: `cross-slot cs-${pos} ${teamCls(s, pc.seat)}` + (pc.seat === t.winner ? ' win' : '') },
      mini(pc.card, pc.seat === t.winner ? 'winner' : ''),
      playerName(nameOf(s, pc.seat), { cls: 'cs-name', title: true }),
      pc.seat === t.leader ? h('span', { class: 'cs-lead', text: 'kwam uit' }) : null));
  }
  const roem = roemTotal(t.roem);
  return [cross,
    h('p', { class: 'last-sum ' + teamCls(s, t.winner) },
      h('b', { text: `${nameOf(s, t.winner)} nam de slag` }),
      h('span', { text: ` · ${t.points} punten` }),
      roem ? h('span', { class: 'gold', text: ` · roem: ${roemText(t.roem)}` }) : null)];
}

function openTrick(s, t, i, owner) {
  sound.play('click');
  const m = openModal({ id: 'trick', title: `Slag ${i + 1}`, cls: 'm-last', body: trickCross(s, t) });
  m.owner = owner;
}

// ---------- score sheet ----------

export function openScoreSheet() {
  const s = app.s;
  if (!s) return;
  sound.play('click');
  const m = openModal({ id: 'score', title: 'Scorebord', cls: 'm-score', body: [] });
  m.view = 'score';
  // Runs on every update; the review of a hand stays put until "Terug".
  m.refresh = () => {
    if (m.view !== 'score') return;
    m.titleEl.textContent = 'Scorebord';
    m.body.replaceChildren(scoreBody(app.s, m));
  };
  m.refresh();
}

// The side a scorer played on in a finished hand r (see util.sideOf):
// its team with four players, itself with two, with three 0 for the
// soloist (r.trumpBy) and 1 for the other two.
function rowSide(s, r, k) {
  const n = seatCount(s);
  return n === 3 ? (k === r.trumpBy ? 0 : 1) : k;
}

// What is shown of hand r in scorer k's column: nat and pit for the side
// that went nat or made pit; roem for a side that kept it (with three
// players only the soloist's, as the other two share theirs).
function rowMarks(s, r, k) {
  const side = rowSide(s, r, k);
  const nat = r.nat && r.playingTeam === side;
  const pit = r.pit && (r.nat ? 1 - r.playingTeam : r.playingTeam) === side;
  const roem = !r.nat && !(seatCount(s) === 3 && side === 1) ? r.roem?.[side] || 0 : 0;
  return { nat, pit, roem };
}

// Who played a hand, under its trump suit: jij, Wij/Zij with four players,
// else the player's face (as in the score pill), and the bid with three.
function playedBy(s, r) {
  if (r.trumpBy === s.you) return 'jij';
  if (seatCount(s) === 4) return r.playingTeam === s.you % 2 ? 'Wij' : 'Zij';
  return scorerName(s, r.trumpBy);
}

function scoreBody(s, m) {
  const order = scorerOrder(s);
  const mine = myScorer(s);
  const three = seatCount(s) === 3;
  const run = new Array(s.total?.length || order.length).fill(0); // the stand after each potje
  const cls = k => (k === mine ? 'wij' : 'zij');
  const rows = (s.scores || []).map((r, i, all) => {
    const last = i === all.length - 1 && s.prevHand?.tricks?.length;
    const gains = r.gains || r.score;
    gains.forEach((g, k) => { run[k] += g; });
    const stand = [...run];
    const cell = k => {
      const { nat, pit, roem } = rowMarks(s, r, k);
      return h('td', { class: 'num ' + cls(k) + (nat ? ' is-nat' : '') + (pit ? ' is-pit' : '') },
        nat ? h('span', { class: 'tag tag-nat', text: 'nat' }) : null,
        pit ? h('span', { class: 'tag tag-pit', text: 'pit' }) : null,
        h('b', { text: gains[k] }),
        roem ? h('small', { text: `+${roem} roem` }) : null,
        h('small', { class: 'stand', text: `stand ${stand[k]}` }));
    };
    const ours = seatCount(s) === 4 ? r.playingTeam === s.you % 2 : r.trumpBy === s.you;
    return h('tr', { class: last ? 'tap' : '', onclick: last ? () => showReview(s, m, r) : null, title: last ? 'Tik om de slagen van dit potje te zien' : '' },
      h('td', { class: 'n', text: r.hand }),
      h('td', { class: 'tr' },
        h('span', { class: 'suit' + (isRed(r.trump) ? ' red' : ''), text: suitSym(r.trump) }),
        three && r.bid ? h('span', { class: 'bid', text: r.bid }) : null,
        h('span', { class: 'by ' + (ours ? 'wij' : 'zij'), text: playedBy(s, r) })),
      order.map(cell));
  });
  let live = null;
  if (PLAYING.has(s.phase) && s.trump) {
    const hp = s.handPoints || [0, 0];
    const hr = s.handRoem || [0, 0];
    const tw = s.tricksWon || [0, 0];
    // Points so far per side; the soloist's two opponents share theirs.
    const c = k => {
      const t = seatCount(s) === 4 ? k : seatCount(s) === 2 ? k : (k === s.soloist ? 0 : 1);
      return h('td', { class: 'num ' + cls(k) }, h('b', { text: hp[t] }), hr[t] ? h('small', { text: `+${hr[t]} roem` }) : null,
        h('small', { text: `${tw[t]} ${tw[t] === 1 ? 'slag' : 'slagen'}${three && t === 1 ? ' samen' : ''}` }));
    };
    live = h('tr', { class: 'live' },
      h('td', { class: 'n', text: s.handNo }),
      h('td', { class: 'tr' }, h('span', { class: 'suit' + (isRed(s.trump) ? ' red' : ''), text: suitSym(s.trump) }), h('span', { class: 'by', text: 'bezig' })),
      order.map(c));
  }
  const total = s.total || run;
  const empty = !rows.length && !live;
  const cols = 2 + order.length;
  return h('div', { class: 'score-wrap' },
    h('table', { class: 'scoresheet cols-' + order.length },
      h('thead', {}, h('tr', {},
        h('th', { class: 'n', text: '#' }), h('th', { text: 'Troef' }),
        order.map(k => h('th', { class: cls(k) }, scorerName(s, k), teamNamesEl(s, k))))),
      h('tbody', {}, rows, live,
        empty ? h('tr', {}, h('td', { colSpan: cols, class: 'empty', text: 'Nog geen potjes gespeeld.' })) : null),
      h('tfoot', {}, h('tr', {},
        h('td', { colSpan: 2, text: `Totaal na ${s.scores?.length || 0} van ${s.hands || s.opts?.hands || 16}` }),
        order.map(k => h('td', { class: 'num ' + cls(k) }, h('b', { text: total[k] })))))),
    h('p', { class: 'legend' },
      h('span', { class: 'tag tag-nat', text: 'nat' }),
      three ? ' wie alleen speelde, haalde het bod niet. ' : ' de spelende partij haalde niet meer dan de helft. ',
      h('span', { class: 'tag tag-pit', text: 'pit' }), ' alle slagen: 100 roem extra.',
      three ? ' Wie niet alleen speelt, krijgt de helft van wat de twee samen halen.' : '',
      s.prevHand?.tricks?.length ? ' Tik op het laatste potje om de slagen te zien.' : ''));
}

// The names behind a score, one per line, AI players as "Naam (AI)": a
// team's two with four players, else the one player's.
function teamNamesEl(s, k) {
  const names = [];
  const seats = seatCount(s) === 4 ? [k, k + 2] : [k];
  for (const seat of seats) names.push(seat === s.you ? 'jij' : s.players[seat]?.name || 'vrij');
  return h('small', { class: 'team-names', title: names.join(' & ') }, names.map(n => h('span', { text: n })));
}

// s as it was in the hand of result r: with three players the soloist
// decides who played together, and the next hand has another one.
function asInHand(s, r) {
  return seatCount(s) === 3 && r ? { ...s, soloist: r.trumpBy } : s;
}

function showReview(s, m, r) {
  sound.play('click');
  m.view = 'review';
  m.titleEl.textContent = `Potje ${r.hand}: de slagen`;
  const res = s.prevHand.result;
  m.body.replaceChildren(
    h('button', { class: 'btn btn-ghost btn-sm back-btn', type: 'button', onclick: () => { m.view = 'score'; m.refresh(); } }, icon('back'), 'Terug naar scorebord'),
    resultLine(s, res),
    review(asInHand(s, res), s.prevHand.tricks, 'score'),
    h('p', { class: 'legend', text: seatCount(s) === 4 ? 'De kaarten liggen in speelvolgorde, gekleurd per koppel. Tik op een slag om te zien wie wat speelde.'
      : 'De kaarten liggen in speelvolgorde, gekleurd per kant. Tik op een slag om te zien wie wat speelde.' }));
}

function resultLine(s, r) {
  if (!r) return null;
  const order = scorerOrder(s);
  const gains = r.gains || r.score;
  const parts = order.flatMap((k, i) => [i ? ' · ' : null,
    h('b', { class: k === myScorer(s) ? 'wij' : 'zij', text: `${scorerName(s, k)} ${gains[k]}` })]).filter(Boolean);
  const bid = seatCount(s) === 3 && r.bid ? ` alleen voor ${r.bid}` : '';
  return h('p', { class: 'result-line' },
    h('span', { class: 'suit' + (isRed(r.trump) ? ' red' : ''), text: suitSym(r.trump) }),
    ` ${nameOf(s, r.trumpBy)} speelde ${suitName(r.trump)}${bid}. `,
    ...parts,
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
  openModal({ id: 'last', title: 'Laatste slag', cls: 'm-last', body: trickCross(s, t) });
}

// ---------- trump / variant info ----------

// Reads what the badge shows: during the trump banner the table already
// shows the new trump, while app.s follows once the banner is done.
export function openTrumpInfo() {
  const s = app.view || app.s;
  if (!s) return;
  sound.play('click');
  const o = s.opts || {};
  const n = seatCount(s);
  const parts = [];
  if (s.trump && s.playingTeam >= 0) {
    const maker = `Gekozen door ${nameOf(s, s.trumpBy, false)}${s.trumpBy === s.you ? ' (jij)' : ''}.`;
    const task = n === 3 ? `${s.trumpBy === s.you ? 'Jij speelt' : `${nameOf(s, s.trumpBy, false)} speelt`} alleen en moet minstens ${s.bid} punten halen, roem telt mee.`
      : n === 2 ? `${s.trumpBy === s.you ? 'Jij speelt en moet' : `${nameOf(s, s.trumpBy, false)} speelt en moet`} meer dan de helft halen.`
        : `${teamName(s, s.playingTeam)} spelen en moeten meer dan de helft halen.`;
    parts.push(h('div', { class: 'ti-trump' + (isRed(s.trump) ? ' red' : '') },
      h('span', { class: 'ti-sym', text: suitSym(s.trump) }),
      h('div', {}, h('b', { text: cap(`${suitName(s.trump)} is troef`) }), h('span', { text: `${maker} ${task}` }))));
  } else if (n === 3 && s.phase === 'auction') {
    parts.push(h('p', { text: s.bidder >= 0 ? `Er wordt geboden. Hoogste bod: ${s.bid} van ${nameOf(s, s.bidder, false)}.` : 'Er wordt geboden. Nog geen bod.' }));
  } else {
    parts.push(h('p', { text: s.turned ? `Gedraaid: ${suitText(s.turned)}. Nog niemand speelt.` : 'Er is nog geen troef gekozen.' }));
  }
  if (PLAYING.has(s.phase) && s.trump) {
    const hp = s.handPoints || [0, 0];
    const hr = s.handRoem || [0, 0];
    const w = n === 4 ? s.you % 2 : mySide(s);
    const label = side => (n === 4 ? (side === w ? 'Wij' : 'Zij') : teamName(s, side));
    parts.push(h('p', { class: 'ti-now' }, 'Dit potje: ',
      h('b', { class: 'wij', text: `${label(w)} ${hp[w]}${hr[w] ? ` + ${hr[w]} roem` : ''}` }), ' · ',
      h('b', { class: 'zij', text: `${label(1 - w)} ${hp[1 - w]}${hr[1 - w] ? ` + ${hr[1 - w]} roem` : ''}` })));
  }
  const rules = h('p', { text: o.rules === 'rotterdams'
    ? 'Rotterdams: kun je niet bekennen, dan moet je altijd troeven, ook als je maat de slag heeft.'
    : 'Amsterdams: kun je niet bekennen en heeft je maat de slag, dan hoef je niet te troeven.' });
  const trump = h('p', { text: o.trumpMode === 'gedraaid'
    ? 'Gedraaid (vrij): er wordt een kleur gedraaid. Om de beurt zeg je spelen of passen. Past iedereen, dan moet de voorhand een andere kleur kiezen.'
    : 'Utrechts (verplicht): de voorhand moet troef kiezen en speelt dan.' });
  const variant = n === 3 ? [
    h('p', { text: 'Met z\'n drieën: ieder voor zich, tien kaarten elk en twee dicht op tafel. Wie het hoogst biedt, pakt die twee, legt er twee weg (hun punten tellen voor hem of haar), kiest troef en speelt alleen. Haalt die het bod (roem telt mee), dan krijgt ieder wat hij haalde en delen de andere twee hun punten; anders is het nat en delen zij alles.' }),
    rules,
  ] : n === 2 ? [
    h('p', { text: 'Met z\'n tweeën: ieder speelt van acht stapeltjes van twee kaarten op tafel. Je speelt een open kaart; de kaart eronder gaat open als de slag af is. Roem in je acht open kaarten na de troefkeus telt voor jou.' }),
    trump,
  ] : [trump, rules];
  parts.push(h('div', { class: 'ti-variant' },
    h('h3', { text: `Variant: ${variantText(o)}` }),
    ...variant,
    h('p', { class: 'muted', text: `${s.hands || o.hands || 16} potjes · AI ${o.ai || 'normaal'} · tempo ${o.tempo || 'normaal'}` })));
  openModal({ id: 'trumpinfo', title: 'Troef en variant', cls: 'm-info', body: parts });
}

// ---------- settings ----------

export function toggleRow(label, sub, on, fn) {
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

// Toggle buttons for agreements that combine: values is an object of
// booleans by key; fn hears the whole object after every change.
export function toggles(choices, values, fn, name = '') {
  const now = { ...values };
  const wrap = h('div', { class: 'seg seg-multi', role: 'group', 'aria-label': name });
  wrap.append(...choices.map(([k, label]) => h('button', {
    type: 'button', class: 'seg-btn', 'aria-pressed': String(!!now[k]),
    onclick: e => {
      now[k] = !now[k];
      e.currentTarget.setAttribute('aria-pressed', String(now[k]));
      sound.play('click');
      fn({ ...now });
    },
  }, label)));
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
      h('h3', { text: 'Bellen' }),
      toggleRow('Bellen voorstellen', 'Bij een spel met andere spelers vragen of je meebelt', store.json('call', {}).ask !== false,
        on => store.setJSON('call', { ...store.json('call', {}), ask: on }))),
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
  // On a phone only a few tabs fit: faded edges show that the bar scrolls,
  // and every section ends with a button to the next one.
  const edges = () => {
    const max = tabs.scrollWidth - tabs.clientWidth;
    tabs.classList.toggle('more-l', tabs.scrollLeft > 4);
    tabs.classList.toggle('more-r', tabs.scrollLeft < max - 4);
  };
  tabs.addEventListener('scroll', edges, { passive: true });
  function show(id) {
    for (const b of btns) b.setAttribute('aria-selected', String(b.dataset.id === id));
    content.replaceChildren();
    try {
      content.append(renderManual(id, { icon }));
    } catch {
      content.append(h('p', { text: 'Dit deel van de handleiding kon niet worden geladen.' }));
    }
    const next = SECTIONS[SECTIONS.findIndex(x => x.id === id) + 1];
    if (next) {
      content.append(h('div', { class: 'man-next' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => show(next.id) }, `Volgende: ${next.title}`, icon('forward'))));
    }
    content.scrollTop = 0;
    prefs.tab = id;
    savePrefs();
    btns.find(b => b.dataset.id === id)?.scrollIntoView({ block: 'nearest', inline: 'center' });
    requestAnimationFrame(edges);
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
  else {
    byId('summary')?.close(true);
    if (byId('trick')?.owner === 'summary') byId('trick').close(true);
  }
  if (s.phase === 'gameOver') {
    showGameOver(s, ev);
    byId('replay')?.refresh?.(s);
  } else {
    byId('over')?.close(true);
    byId('review')?.close(true);
    // The expert looks back while the match runs.
    if (s.expert) byId('replay')?.refresh?.(s);
    else byId('replay')?.close(true);
    if (byId('trick')?.owner === 'review') byId('trick').close(true);
  }
  if (s.phase === 'lobby') { byId('score')?.close(true); byId('last')?.close(true); }
  byId('score')?.refresh?.();
}

function showSummary(s, ev) {
  const r = (ev?.type === 'handEnd' && ev.result) || s.prevHand?.result;
  if (!r) return;
  let m = byId('summary');
  if (!m) {
    const n = seatCount(s);
    const w = n === 4 ? s.you % 2 : n === 2 ? s.you : r.trumpBy === s.you ? 0 : 1;
    const T = handHeadline(r, w, s);
    const fresh = ev?.type === 'handEnd';
    const nums = [];
    const num = (v, cls) => { const el = h('b', { class: cls, text: fresh ? 0 : v }); if (fresh) nums.push([el, v]); else el.dataset.n = v; return el; };
    const tricks = s.prevHand?.tricks || [];
    const ready = h('div', { class: 'ready-list' });
    const ring = countdownRing();
    const go = h('button', { class: 'btn btn-go btn-big', type: 'button', onclick: () => { sound.play('click'); app.send({ t: 'ready' }); go.disabled = true; go.lastChild.textContent = 'Wachten op de rest'; } },
      ring.el, h('span', { text: s.handNo >= (s.opts.from || s.hands) ? 'Naar de uitslag' : 'Volgend potje' }));
    m = openModal({
      id: 'summary', cls: 'm-summary passive', closable: false, label: 'Uitslag van het potje', body: [
        h('div', { class: 'sum-head ' + T.cls },
          h('div', { class: 'sum-title' + (T.t.length > 16 ? ' long' : ''), text: T.t }),
          h('div', { class: 'sum-sub', text: T.sub }),
          h('div', { class: 'sum-meta' },
            h('span', { class: 'suit' + (isRed(r.trump) ? ' red' : ''), text: suitSym(r.trump) }),
            ` ${nameOf(s, r.trumpBy)} speelde ${suitName(r.trump)} · potje ${s.handNo} van ${s.hands}`)),
        sumTable(s, r, w, num),
        seatCount(s) === 3 ? discardLine(s, r) : natWhy(s, r, w),
        tricks.length ? h('div', { class: 'sum-review' + (n !== 4 ? ` sum-review-${n}` : '') }, h('h3', {}, 'De slagen', h('small', { text: ' · tik voor wie wat speelde' })),
          review(asInHand(s, r), tricks, 'summary')) : null,
        h('div', { class: 'sum-foot' }, go, ready,
          s.expert ? h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => openExpert({ hand: s.handNo }) },
            icon('search'), 'Dit potje terugkijken') : null),
      ],
    });
    m.go = go;
    m.ready = ready;
    m.ring = ring;
    if (fresh) setTimeout(() => nums.forEach(([el, v]) => countUp(el, v, 1100)), dur(350));
    focusMain(go);
  }
  m.ring.set(s.nextAt);
  m.ring.el.toggleAttribute('hidden', !s.nextAt); // training: no countdown
  const mine = s.players[s.you]?.ready;
  if (mine) { m.go.disabled = true; m.go.lastChild.textContent = 'Wachten op de rest'; }
  // Who is ready, when there is anyone to wait for; alone with bots the
  // chip would only say "Jij" and cost a phone a row of tricks. Who left
  // is no longer at the table.
  const chips = s.players.map((p, seat) => p && !p.bot && !p.left ? h('span', { class: 'ready-chip ' + (p.ready ? 'on ' : '') + teamCls(s, seat) },
    p.ready ? icon('check') : null, nameOf(s, seat)) : null).filter(Boolean);
  m.ready.replaceChildren(...(chips.length > 1 ? chips : []));
  m.ready.hidden = chips.length < 2;
}

// The summary's numbers: per side with four and two players (Wij/Zij, Jij
// and the other), with three per player, the two who played together
// sharing their side's points and roem.
function sumTable(s, r, w, num) {
  const total = s.total || [];
  const n = seatCount(s);
  if (n !== 3) {
    const lbl = side => (n === 4 ? (side === w ? 'Wij' : 'Zij') : side === w ? 'Jij' : nameOf(s, side));
    const row = (label, a, b, cls = '') => h('tr', { class: cls }, h('th', { text: label }), h('td', { class: 'wij' }, num(a)), h('td', { class: 'zij' }, num(b)));
    const gains = r.gains || r.score;
    return h('table', { class: 'sum-table' },
      h('thead', {}, h('tr', {}, h('th'), h('th', { class: 'wij' }, playerName(lbl(w))), h('th', { class: 'zij' }, playerName(lbl(1 - w))))),
      h('tbody', {},
        row('Punten', r.points[w], r.points[1 - w]),
        row('Roem', r.roem[w], r.roem[1 - w]),
        row('Erbij', gains[w], gains[1 - w], 'sum-score'),
        row('Stand', total[w] ?? 0, total[1 - w] ?? 0, 'sum-total')));
  }
  const order = scorerOrder(s);
  const cls = k => (k === myScorer(s) ? 'wij' : 'zij');
  const side = k => (k === r.trumpBy ? 0 : 1);
  const row = (label, val, rcls = '', shared = false) => h('tr', { class: rcls }, h('th', { text: label }),
    order.map(k => h('td', { class: cls(k) + (shared && side(k) === 1 ? ' shared' : '') }, num(val(k)))));
  // The players by their faces, as in the score pill: three names do not
  // fit a phone.
  const face = k => {
    if (k === s.you) return 'Jij';
    const p = s.players[k];
    return p?.bot ? p.emoji || '🤖' : (p?.name || '?').trim().charAt(0).toUpperCase();
  };
  return h('table', { class: 'sum-table sum-three' },
    h('thead', {}, h('tr', {}, h('th'), order.map(k => h('th', { class: cls(k), title: nameOf(s, k, false) },
      h('span', { class: 'face', text: face(k) }), h('small', { class: 'role', text: side(k) === 0 ? 'alleen' : 'samen' }))))),
    h('tbody', {},
      row('Punten', k => r.points[side(k)], '', true),
      row('Roem', k => r.roem[side(k)], '', true),
      row('Erbij', k => r.gains[k], 'sum-score'),
      row('Stand', k => total[k] ?? 0, 'sum-total')));
}

// Three players: what the soloist laid away (its points counted for the
// soloist), with the rule for playing alone behind an ⓘ. The headline
// already says what was bid and made.
function discardLine(s, r) {
  const pts = (r.discards || []).reduce((n, c) => n + cardPoints(c, r.trump), 0);
  return h('p', { class: 'sum-why' }, infoBtn('Alleen spelen', [
    'Wie alleen speelt, moet minstens het bod halen: punten plus roem, de weggelegde kaarten meegeteld.',
    'Gehaald: ieder krijgt wat hij haalde, en de andere twee delen hun punten, ieder de helft. Nat: wie alleen speelde krijgt niets en de andere twee delen alle 162 punten en alle roem.',
  ]), ' Weggelegd: ', suitify(r.discards.map(c => cardShort(c)).join(' ')), ` (${pts} ${pts === 1 ? 'punt' : 'punten'}).`);
}

// Card points (design §2), for the discards.
function cardPoints(code, trump) {
  const rank = code[0];
  if (code[1] === trump) return { J: 20, 9: 14, A: 11, T: 10, K: 4, Q: 3 }[rank] ?? 0;
  return { A: 11, T: 10, K: 4, Q: 3, J: 2 }[rank] ?? 0;
}

// Why a hand went nat, with the rule behind an ⓘ.
function natWhy(s, r, w) {
  if (!r.nat) return null;
  const n = seatCount(s);
  const we = r.playingTeam === w;
  const sub = n === 4 ? (we ? ' Waarom nat? Wij haalden niet meer dan de helft.' : ' Zij haalden niet meer dan de helft.')
    : we ? ' Waarom nat? Je haalde niet meer dan de helft.' : ` ${nameOf(s, 1 - w)} haalde niet meer dan de helft.`;
  return h('p', { class: 'sum-why' }, infoBtn('Nat', [
    n === 4 ? 'De spelende partij moet meer dan de helft van alle punten plus roem halen. Lukt dat niet, dan gaan ze nat.'
      : 'Wie speelt, moet meer dan de helft van alle punten plus roem halen. Lukt dat niet, dan is het nat.',
    'Bij nat krijgt de tegenpartij alle 162 punten en alle roem van beide kanten.',
  ]), sub);
}

export function countdownRing() {
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
  const w = myScorer(s);
  const total = (ev?.type === 'gameOver' && ev.total) || s.total || [0, 0];
  const winner = ev?.type === 'gameOver' ? ev.winner : s.winner;
  const won = winner === w;
  // A shared first place is a draw for those who share it.
  const draw = winner === -1 && total[w] === Math.max(...total);
  const title = draw ? 'Gelijkspel' : won ? 'Gewonnen!' : 'Verloren';
  const sub = draw ? 'Precies gelijk. Dat zie je niet vaak!' : won ? 'Wat een spel. Gefeliciteerd!' : 'Volgende keer beter. Nog een partij?';
  const host = s.host === s.you;
  // A rematch is a whole new partij of potjes; sent once, until it is refused.
  // "lobby" takes the table back to Klaarzetten (same code) to change seats
  // or rules; training and the expert mode have no lobby.
  let sent = false;
  const label = hst => (sent ? 'Even wachten…' : hst ? 'Nog een partij' : 'Wachten op de host');
  const send = t => {
    if (sent) return;
    sent = true;
    sound.play('click');
    app.send({ t });
    m.refresh(app.s);
  };
  const again = h('button', { class: 'btn btn-go btn-big', type: 'button', disabled: !host, onclick: () => send('rematch') }, label(host));
  const setup = h('button', { class: 'btn btn-ghost btn-block btn-setup', type: 'button', hidden: !host || s.training || !!s.expert, onclick: () => send('lobby') },
    icon('users'), 'Spelers of regels wijzigen');
  const rv = h('button', { class: 'review-line', type: 'button', onclick: () => openReview() });
  reviewLine(rv, s.review);
  const m = openModal({
    id: 'over', cls: 'm-over passive' + (won ? ' won' : draw ? ' draw' : ' lost'), closable: false, label: title, body: [
      h('div', { class: 'over-emoji', 'aria-hidden': 'true', text: draw ? '🤝' : won ? '🏆' : '🃏' }),
      h('div', { class: 'over-title', text: title }),
      h('div', { class: 'over-sub', text: sub }),
      h('div', { class: 'over-score' + (total.length > 2 ? ' many' : '') }, scorerOrder(s).flatMap((k, i) => [
        i ? h('div', { class: 'os-vs', text: '–' }) : null,
        h('div', { class: 'os ' + (k === w ? 'wij' : 'zij') + (winner === k ? ' top' : '') },
          h('span', { text: scorerName(s, k) }), h('b', { text: total[k] }), seatCount(s) === 4 ? teamNamesEl(s, k) : null),
      ]).filter(Boolean)),
      rv,
      s.prevHand?.result ? h('div', { class: 'over-last' }, h('small', { text: 'Laatste potje' }), resultLine(s, s.prevHand.result)) : null,
      h('div', { class: 'btn-col' },
        again,
        setup,
        s.expert ? h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => openExpert() }, icon('search'), 'Potjes terugkijken') : null,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => openScoreSheet() }, icon('score'), 'Scorebord'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => app.leave() }, icon('leave'), 'Naar start'))),
    ],
  });
  m.refresh = st => {
    const hst = st.host === st.you;
    again.disabled = !hst || sent;
    again.textContent = label(hst);
    setup.hidden = !hst || st.training || !!st.expert;
    setup.disabled = sent;
    reviewLine(rv, st.review);
    m.root.classList.toggle('with-review', !!st.review);
  };
  m.root.classList.toggle('with-review', !!s.review);
  m.reset = () => {
    sent = false;
    if (app.s) m.refresh(app.s);
  };
  if (won && ev?.type === 'gameOver') confetti(m.root);
  if (host) focusMain(again);
}

// ---------- spelanalyse ----------

// The line under the final score that opens the review of the player's
// own play; the grades of the last choices may still be on their way.
function reviewLine(btn, r) {
  btn.hidden = !r;
  if (!r) return;
  btn.disabled = r.pending;
  if (r.pending) {
    btn.replaceChildren(h('span', { text: 'Jouw spelanalyse wordt berekend…' }));
    return;
  }
  reviewHistory(r);
  btn.replaceChildren(h('span', {}, 'Jouw spel volgens Juf Jannie: ', h('b', { text: `${r.pct}%` }), ` (${reviewVerdict(r.pct)})`), icon('forward'));
}

// The review (design §9 Spelanalyse): numbers and facts about the
// player's own play, for them alone, as Juf Jannie (the engine of the hints)
// sees it.
function openReview() {
  const s = app.s;
  const r = s?.review;
  if (!r || r.pending) return;
  sound.play('click');
  const prev = reviewHistory(r);
  const row = (label, value, ib = null) => h('tr', {}, h('th', {}, label, ib), h('td', { text: value }));
  const zetten = n => `${n}\u00a0${n === 1 ? 'zet' : 'zetten'}`;
  const moments = (title, list, total, line) => (list?.length ? h('section', { class: 'rv-sec' },
    h('h3', {}, title, total > list.length ? h('small', { text: ` · de ${list.length > 1 ? list.length + ' ' : ''}grootste van ${total}` }) : null),
    h('ul', { class: 'rv-list' }, list.map(m => h('li', {},
      h('button', {
        class: 'rv-moment', type: 'button', disabled: !r.replay?.[m.hand - 1],
        title: 'Tik om dit potje terug te kijken', onclick: () => (s.expert ? openExpert({ moment: m }) : openReplay(s, { hands: r.replay, moment: m })),
      }, h('span', { class: 'rv-where', text: momentWhere(m) }), line(m),
      h('span', { class: 'rv-sum' }, suitify(outcomeLine(m))), icon('forward')))))) : null);
  const sp = r.speed;
  openModal({
    id: 'review', title: 'Jouw spelanalyse', cls: 'm-review', body: [
      h('div', { class: 'rv-head' },
        h('small', { class: 'rv-who', text: 'Volgens Juf Jannie' }),
        h('div', { class: 'rv-pct' }, h('b', { text: `${r.pct}%` }), h('span', { text: `(${reviewVerdict(r.pct)})` }), infoBtn('Spelanalyse', [
          'Juf Jannie is de game engine van dit spel: dezelfde die de AI-spelers laat spelen en bij Oefenen de tips geeft. Dit is haar berekening, met alleen wat jij op dat moment wist.',
          'Bij elke keuze speelt ze het potje honderden keren uit, voor elke kaart, troefkleur of elk bod dat je had, telkens met een andere verdeling van de kaarten die je niet kon zien. Wat een keuze gemiddeld oplevert, is haar waarde.',
          'Punten zijn het verschil tussen de score van jullie koppel en die van de tegenstanders aan het eind van het potje. Een punt dat naar de tegenstanders gaat in plaats van naar jullie, telt dus twee keer. Gaat een potje nat, dan krijgen de tegenstanders alle punten: een keuze die de kans op nat groter maakt, kost gemiddeld veel, ook als de kaart zelf weinig punten waard is.',
          'Het blijft een schatting: Juf Jannie speelt de rest van het potje met eenvoudige regels uit.',
          'Het percentage zegt hoeveel van de punten die met je keuzes te winnen waren, je ook haalde. Je kaarten tellen niet mee: ook met slechte kaarten kun je 100% halen.',
          'Laten liggen: wat een betere keuze gemiddeld meer had opgeleverd. Verschillen van minder dan 5 punten tellen niet mee.',
          'Sterke zet: de beste keuze, terwijl de voor de hand liggende keuze minstens 10 punten minder opleverde.',
        ])),
        h('small', { text: (r.hands ? `${r.hands} ${r.hands === 1 ? 'potje' : 'potjes'} · ` : '') + `${r.choices} ${r.choices === 1 ? 'keuze' : 'keuzes'}` +
          (r.seed ? ` · seed ${r.seed}` : '') })),
      h('table', { class: 'rv-table' }, h('tbody', {},
        // A player who took a seat over during a hand has no dealt hand measured.
        r.hands ? row('Jouw kaarten', luckText(r.luck), infoBtn('Jouw kaarten', [
          'Wat je kaarten bij het delen gemiddeld per potje waard waren voor jouw koppel, vergeleken met een gemiddelde hand op dezelfde plaats aan tafel.',
        ])) : null,
        row('Sterke zetten', String(r.strongN)),
        row('Laten liggen', r.lostN ? `${pointsText(r.lost)} in ${zetten(r.lostN)}` : '0 punten'),
        r.leads[1] ? row('Uitkomen', `${r.leads[0]} van ${r.leads[1]} keer de beste kaart`) : null,
        r.trumps[1] ? row('Troefkeuze', `${r.trumps[0]} van ${r.trumps[1]} keer de beste keuze`) : null,
        row('Roem weggegeven', r.roem[1] ? `${r.roem[0]} (${r.roem[1]} keer)` : '0', infoBtn('Roem weggegeven', [
          'Roem die jouw kaart toevoegde aan de kaarten die al op tafel lagen, terwijl je een kaart had die minder roem gaf, in slagen die de tegenstanders haalden.',
        ])))),
      r.risky[0] ? h('p', { class: 'rv-risky', text: `Gespeeld met meer dan 40% kans op nat: ${r.risky[0]} keer, ${r.risky[1]} keer nat` }) : null,
      sp ? h('section', { class: 'rv-sec' }, h('h3', {}, 'Snelheid'),
        h('table', { class: 'rv-table' }, h('tbody', {},
          row('Bedenktijd per zet', timeText(sp.median), infoBtn('Bedenktijd', [
            'De tijd van het moment dat je aan de beurt was tot je kaart, troefkeuze of bod. Per zet staat de middelste van je tijden: de helft van je zetten ging sneller, de helft langzamer. Zo telt één lange pauze niet zwaar mee.',
            'Een beurt waarin je verbinding even weg was, telt niet mee. De AI-spelers tellen niet mee bij de anderen.',
          ])),
          row('Langste bedenktijd', `${timeText(sp.slowest.ms)} (${momentWhere(sp.slowest).toLowerCase()})`),
          row('De tafel wachtte op jou', timeText(sp.total)),
          sp.others ? row('Anderen per zet', timeText(sp.others.median)) : null,
          sp.others ? row('Jij wachtte op de anderen', timeText(sp.others.total)) : null))) : null,
      moments('Sterke zetten', r.strong, r.strongN, m => {
        const l = strongLine(m);
        return h('span', { class: 'rv-text' }, h('b', {}, suitify(l.what)), suitify(l.rest));
      }),
      moments('Laten liggen', r.missed, r.lostN, m => h('span', { class: 'rv-text' }, suitify(missedLine(m)))),
      r.replay?.length ? h('button', { class: 'btn btn-ghost btn-block rv-replay', type: 'button', onclick: () => (s.expert ? openExpert() : openReplay(s, { hands: r.replay })) },
        icon('history'), 'Potjes terugkijken') : null,
      prev.length ? h('p', { class: 'rv-prev' }, 'Vorige partijen ', h('b', { text: prev.map(p => `${p}%`).join(' · ') })) : null,
      h('p', { class: 'legend', text: 'Disclaimer: Dit is slechts de mening van Juf Jannie.' }),
      h('section', { class: 'rv-sec' }, h('h3', {}, 'Opmerkingen'),
        feedbackForm(() => ({}), 'Opmerking over dit spel of de analyse'),
        h('p', { class: 'legend', text: 'Je opmerking wordt met je naam bewaard, net als de partij zelf: hooguit 12 maanden, voor statistieken en om het spel te verbeteren.' })),
    ],
  });
}

// ---------- replay ----------

// The replay (design §9 Terugkijken): a hand card by card with every hand
// open, from a moment of the review (just before the player's card, or at
// the deal for a trump choice or bid), from the deal, or at {hand, step}
// (step 'end': after the latest card). A step is the number of cards
// played: at 4 × n trick n lies complete. hands are the hands to step
// through (review.replay, or the expert's hands, with the hand in play);
// source(st) gives them in a later state. The expert mode adds its tools
// (expert.js): tools.card(el, seat, card, ctx) for every card in the hands,
// tools.box(ctx) for what goes under the table, tools.onError() when the
// server refused something; ctx.render() shows the replay again.
export function openReplay(s, { hands, moment = null, at = null, source = null, tools = null }) {
  if (!hands?.length) return;
  sound.play('click');
  const seats = [0, 1, 2, 3].map(k => (s.you + k) % 4);
  const cardsOf = rh => rh.tricks.flatMap(t => t.cards);
  const indexOf = n => Math.max(0, hands.findIndex(x => x.hand === n));
  const before = m => {
    const t = m.trick ? hands[indexOf(m.hand)]?.tricks[m.trick - 1] : null;
    return t ? 4 * (m.trick - 1) + Math.max(0, t.cards.findIndex(pc => pc.seat === s.you)) : 0;
  };
  let hand = moment ? indexOf(moment.hand) : at ? indexOf(at.hand) : 0;
  let step = moment ? before(moment) : at?.step === 'end' ? cardsOf(hands[hand]).length : at?.step || 0;
  const m = openModal({ id: 'replay', title: tools ? 'Expert: terugkijken' : 'Terugkijken', cls: 'm-replay' + (tools ? ' m-expert' : ''), body: [] });
  // A later state: the same hand, following the cards of the hand in play
  // when the replay showed its latest one.
  m.refresh = st => {
    const fresh = source ? source(st) : st.review?.replay;
    if (!fresh?.length) return;
    const shown = hands[hand]?.hand;
    const atEnd = step === cardsOf(hands[hand]).length;
    s = st;
    hands = fresh;
    const k = hands.findIndex(x => x.hand === shown);
    if (k < 0) {
      hand = hands.length - 1;
      step = 0;
    } else {
      hand = k;
      if (atEnd) step = cardsOf(hands[k]).length;
    }
    render();
  };
  m.onError = () => tools?.onError?.();
  // The steps stay in view below the scrolling body.
  const bar = h('div', { class: 'rp-bar' });
  m.dlg.append(bar);
  const go = (hd, st) => {
    hand = Math.max(0, Math.min(hands.length - 1, hd));
    step = Math.max(0, Math.min(cardsOf(hands[hand]).length, st));
    const key = document.activeElement?.dataset?.key;
    render();
    if (key) m.dlg.querySelector(`[data-key="${key}"]:not(:disabled)`)?.focus({ preventScroll: true });
  };
  m.dlg.addEventListener('keydown', e => {
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest?.('textarea, input')) {
      e.preventDefault();
      go(hand, step + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  });

  function render() {
    const rh = hands[hand];
    const row = s.scores?.find(x => x.hand === rh.hand);
    const played = cardsOf(rh);
    const n = played.length;
    step = Math.min(step, n);
    const gone = new Set(played.slice(0, step).map(pc => pc.card));
    const ti = Math.ceil(step / 4) - 1; // the trick on the table; -1 before the first card
    const trick = rh.tricks[ti];
    const shown = trick ? trick.cards.slice(0, step - 4 * ti) : [];
    const complete = shown.length === 4;
    // The hand in play (expert): after its latest card it is whoever's turn it is now.
    const live = !row && rh.hand === s.handNo && PLAYING.has(s.phase);
    const next = step < n ? played[step].seat : live && s.turn >= 0 ? s.turn : -1;
    const trump = row ? { suit: row.trump, by: row.trumpBy } : live && s.trump ? { suit: s.trump, by: s.trumpBy } : null;
    const ctx = { s, rh, step, played, next, live, trick: Math.floor(step / 4) + 1, render };
    const mo = moment?.hand === rh.hand ? moment : null;
    const now = mo && step === before(mo);
    // The player's choice and the option it is measured against, marked in
    // their hand at the moment itself: the stronger of the two in gold.
    const playedCls = mo?.better ? 'rp-played' : 'rp-better';
    const marks = new Map();
    if (now && mo.played?.card) marks.set(mo.played.card, playedCls);
    if (now && (mo.better || mo.alt)?.card) marks.set((mo.better || mo.alt).card, mo.better ? 'rp-better' : 'rp-alt');

    const stand = [0, 0];
    rh.tricks.slice(0, Math.max(0, complete ? ti + 1 : ti)).forEach(t => { stand[t.winner % 2] += t.points + roemTotal(t.roem); });
    const wij = s.you % 2;

    const cross = h('div', { class: 'cross rp-cross' }, seats.map(seat => {
      const pc = shown.find(x => x.seat === seat);
      const win = complete && trick.winner === seat;
      return h('div', { class: `cross-slot cs-${posOf(s, seat)} ${teamCls(s, seat)}` + (win ? ' win' : '') + (seat === next && !complete ? ' turn' : '') },
        pc ? mini(pc.card, win ? 'winner' : '') : h('div', { class: 'rp-slot' }),
        playerName(nameOf(s, seat), { cls: 'cs-name', title: true }));
    }));
    const what = complete
      ? h('p', { class: 'last-sum rp-what ' + teamCls(s, trick.winner) },
        h('b', { text: `${nameOf(s, trick.winner)} neemt de slag` }),
        h('span', { text: ` · ${trick.points} punten` }),
        roemTotal(trick.roem) ? h('span', { class: 'gold', text: ` · roem: ${roemText(trick.roem)}` }) : null)
      : next >= 0 ? h('p', { class: 'last-sum rp-what' }, next === s.you ? 'Jij bent aan de beurt' : `${nameOf(s, next)} is aan de beurt`) : null;

    const card = (seat, c) => {
      const el = mini(c, marks.get(c) || '');
      tools?.card(el, seat, c, ctx);
      return el;
    };
    const hand4 = seat => h('div', { class: 'rp-hand ' + teamCls(s, seat) + (seat === next && !complete ? ' turn' : '') },
      playerName(nameOf(s, seat), { cls: 'rp-name', title: true }),
      h('div', { class: 'rp-cards' }, rh.cards[seat].filter(c => !gone.has(c)).map(c => card(seat, c))));
    const alt = mo && (mo.better || mo.alt);
    // replaceChildren would show a null as text.
    m.body.replaceChildren(...[
      h('div', { class: 'rp-head' },
        h('button', { class: 'icon-btn', type: 'button', dataset: { key: 'hand-prev' }, 'aria-label': 'Vorig potje', title: 'Vorig potje', disabled: hand === 0, onclick: () => go(hand - 1, 0) }, icon('back')),
        h('div', { class: 'rp-title' }, h('b', { text: `Potje ${rh.hand} van ${s.hands}` }),
          trump ? h('small', {}, suitify(`${suitSym(trump.suit)} troef · ${nameOf(s, trump.by)} speelt`)) : null),
        h('button', { class: 'icon-btn', type: 'button', dataset: { key: 'hand-next' }, 'aria-label': 'Volgend potje', title: 'Volgend potje', disabled: hand === hands.length - 1, onclick: () => go(hand + 1, 0) }, icon('forward'))),
      mo ? h('div', { class: 'rp-moment' + (now ? ' now' : '') },
        h('span', { class: 'rv-where', text: momentWhere(mo) }),
        h('span', { class: 'rv-text' }, suitify(mo.better ? missedLine(mo) : Object.values(strongLine(mo)).join(''))),
        h('span', { class: 'rv-sum' }, suitify(outcomeLine(mo))),
        now ? null : h('button', { class: 'btn btn-ghost btn-sm', type: 'button', dataset: { key: 'moment' }, onclick: () => go(hand, before(mo)) }, 'Naar dit moment')) : null,
      h('div', { class: 'rp-table' },
        cross,
        what,
        h('p', { class: 'rp-stand' }, step === 32 && row
          ? `Uitslag: Wij ${row.score[wij]} – Zij ${row.score[1 - wij]}` + (row.nat ? ` · ${row.playingTeam === wij ? 'Wij' : 'Zij'} nat` : row.pit ? ' · pit' : '')
          : `Stand in dit potje: Wij ${stand[wij]} – Zij ${stand[1 - wij]}`)),
      tools?.box(ctx) || null,
      h('div', { class: 'rp-hands' },
        hand4(s.you),
        now && marks.size ? h('p', { class: 'rp-legend' },
          h('span', {}, h('span', { class: 'rp-key ' + playedCls }), suitify(`${cardShort(mo.played.card)} gespeeld`)),
          alt?.card ? h('span', {}, h('span', { class: 'rp-key ' + (mo.better ? 'rp-better' : 'rp-alt') }),
            suitify(`${cardShort(alt.card)} ${mo.better ? 'beter volgens Juf Jannie' : 'voor de hand liggend'}`)) : null) : null,
        seats.slice(1).map(hand4)),
      h('p', { class: 'legend', text: 'Alle kaarten liggen open. Bij een keuze wist de speler alleen de eigen kaarten en wat er gespeeld was.' }),
    ].filter(Boolean));
    bar.replaceChildren(
      h('div', { class: 'rp-steps' },
        h('button', { class: 'btn btn-ghost', type: 'button', dataset: { key: 'prev' }, 'aria-label': 'Een kaart terug', title: 'Een kaart terug (←)', disabled: step === 0, onclick: () => go(hand, step - 1) }, icon('back')),
        h('span', { class: 'rp-pos', text: step === 0 ? 'Voor de eerste kaart' : `Slag ${ti + 1} · ${shown.length} van 4 kaarten` }),
        h('button', { class: 'btn btn-ghost', type: 'button', dataset: { key: 'next' }, 'aria-label': 'Een kaart verder', title: 'Een kaart verder (→)', disabled: step === n, onclick: () => go(hand, step + 1) }, icon('forward'))),
      h('div', { class: 'rp-tricks', role: 'group', 'aria-label': 'Slagen' }, rh.tricks.map((t, k) => {
        const open = t.cards.length < 4; // the trick in play
        return h('button', {
          class: 'rp-tn ' + (open ? 'open' : teamCls(s, t.winner)) + (k === ti ? ' on' : ''), type: 'button', dataset: { key: `t${k}` },
          'aria-label': `Slag ${k + 1}`, title: open ? `Slag ${k + 1}: wordt gespeeld` : `Slag ${k + 1}: ${nameOf(s, t.winner)} nam de slag`,
          onclick: () => go(hand, Math.min(4 * (k + 1), n)),
        }, String(k + 1));
      })));
  }
  render();
  return m;
}

// The expert's replay (expert.js, loaded when first needed), at {hand,
// step} or at a moment of the review.
export function openExpert(at = {}) {
  import('./expert.js').then(x => x.openPanel(at)).catch(() => toast('Laden lukte niet', { sub: 'Controleer je internet en probeer het nog eens.', kind: 'error' }));
}

// A free-text form that sends feedback (design §7) with what extra()
// returns (the expert: hand, trick and seat; else nothing, the game as a
// whole).
let feedbackWait = null; // the form waiting for its "saved"
export function feedbackForm(extra, label, placeholder = 'Wat viel je op? Wat klopt er volgens jou niet?') {
  const text = h('textarea', { class: 'field fb-text', maxLength: 2000, rows: 3, placeholder, 'aria-label': label });
  const status = h('span', { class: 'fb-status', role: 'status' });
  const send = h('button', {
    class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => {
      if (!text.value.trim()) { text.focus(); return; }
      sound.play('click');
      send.disabled = true;
      status.textContent = '';
      feedbackWait = {
        saved: () => { text.value = ''; status.textContent = 'Bewaard.'; send.disabled = false; },
        failed: () => { send.disabled = false; },
      };
      app.send({ t: 'feedback', text: text.value, ...extra() });
    },
  }, 'Versturen');
  text.addEventListener('input', () => { status.textContent = ''; });
  return h('div', { class: 'fb' }, text, h('div', { class: 'fb-row' }, send, status));
}

// The server kept what was sent (feedback).
export function onSaved() {
  feedbackWait?.saved();
  feedbackWait = null;
}

// The server refused something: a rematch in flight can be tried again,
// and so can feedback.
export function onError() {
  byId('over')?.reset?.();
  byId('replay')?.onError?.();
  feedbackWait?.failed();
  feedbackWait = null;
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
const QUICK = ['👍', '😂', '😱', '😭', 'Mooi!', 'Nat!', 'Goed gespeeld!'];
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
    if (fine.matches) setTimeout(() => C.input.focus(), 50);
  }
  syncHistory();
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
  return h('div', { class: 'msg' + (sys ? ' sys' : '') + (mine ? ' mine' : '') + (m.bot ? ' bot' : '') + (m.coach ? ' coach-msg' : '') },
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
    // Juf Jannie's explanations come with every trick in training: no sound.
    if (!m.sys && !m.coach) sound.play('chat');
    // The badge means a person wrote: system lines do not count, and bot
    // chatter already shows as a speech bubble at the table.
    if (!m.sys && !m.bot && m.seat >= 0 && !chatVisible()) { unread++; badge(); }
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
