// The game table: top bar, seats, trick, centre stage, prompt and hand, plus
// the animation for every server event (deal, play, trick, collect, ...).
import { createCard, createBack, cardShort } from './cards.js';
import { sound } from './sound.js';
import {
  app, h, clear, prefs, savePrefs, toast, wait, dur, anim, sleep, EASE, POS, posOf, isWij, teamCls, teamName,
  nameOf, suitSym, suitName, suitText, isRed, roemTotal, ROEM_NAMES, fillAvatar, countUp, icon, suitify, cap, playerName,
} from './util.js';
import * as panels from './panels.js';

const E = {};             // fixed elements
const seats = {};         // pos → seat parts
const slots = {};         // pos → trick slot
const handEls = new Map(); // card code → element in the hand
let handOrder = [];       // codes in display order
let selected = '';        // lifted card (touch, keyboard)
let selectedBy = '';      // 'tap' or 'key': how it was lifted
let pending = null;       // {card, flight, placed, at} our play awaiting the server
let pendingAction = false; // trump/bid sent, awaiting the server
let actionAt = 0;         // when pendingAction was sent
let heldTrick = null;     // completed trick kept on the table until "collect"
let tip = '';             // training explanation after a trick, until our next card
let dismissed = '';       // training hint closed with ✕ (JSON of s.hint)
let drag = null;
let stageKey = '';

const PLAYING = new Set(['trump', 'bid', 'play']);
// A move still unanswered this long after it was sent did not arrive.
const STUCK_MS = 1500;
const LIFT_HINTS = 3;     // times the swipe is mentioned after lifting a card
const touch = matchMedia('(pointer: coarse)');

// ---------- build ----------

export function init() {
  const root = document.getElementById('game');
  E.top = h('header', { class: 'topbar' });
  buildTopbar(E.top);

  E.table = h('div', { class: 'table', id: 'table' });
  E.felt = h('div', { class: 'felt', 'aria-hidden': 'true' });
  E.table.append(E.felt);
  for (const pos of POS) E.table.append(buildSeat(pos));

  E.center = h('div', { class: 'center' });
  E.trick = h('div', { class: 'trick', 'aria-label': 'Slag op tafel', role: 'group' });
  for (const pos of POS) E.trick.append(slots[pos] = h('div', { class: 'slot slot-' + pos }));
  E.center.append(E.trick);
  E.stage = h('div', { class: 'stage' });
  E.fx = h('div', { class: 'fx', 'aria-live': 'polite' });
  E.table.append(E.center, E.stage, E.fx);

  E.coach = h('div', { class: 'coach', hidden: true },
    E.coachIcon = h('span', { class: 'coach-ico', 'aria-hidden': 'true', text: '💡' }),
    h('div', { class: 'coach-body' },
      E.coachTxt = h('div', { class: 'coach-txt' }, E.coachLbl = h('b', { class: 'coach-lbl' }), E.coachText = h('span')),
      E.coachMore = h('button', { class: 'coach-more', type: 'button', hidden: true, 'aria-expanded': 'false', onclick: toggleCoach })),
    h('button', { class: 'coach-x', type: 'button', 'aria-label': 'Sluiten', onclick: closeCoach }, icon('close')));
  E.rule = h('div', { class: 'rule', 'aria-live': 'polite' });
  E.prompt = h('div', { class: 'prompt' }, seats.bottom.root, E.rule, ...panels.toolButtons(['last']), E.coach);
  E.hand = h('div', { class: 'hand', role: 'group', 'aria-label': 'Jouw kaarten' });
  E.table.append(E.prompt, E.hand);

  root.append(E.top, E.table);
  bindHand();
  new ResizeObserver(() => layoutHand()).observe(E.hand);
  addEventListener('resize', fitCoach);
  document.addEventListener('keydown', onKey);
}

function buildTopbar(bar) {
  E.pill = h('button', { class: 'score-pill', type: 'button', title: 'Scorebord: alle potjes en de stand', onclick: () => panels.openScoreSheet() },
    h('span', { class: 'sp sp-wij' },
      h('span', { class: 'sp-lbl', text: 'Wij' }), E.wijNum = h('span', { class: 'sp-num', text: '0' }),
      E.wijNames = h('span', { class: 'sp-names' })),
    h('span', { class: 'sp sp-zij' },
      h('span', { class: 'sp-lbl', text: 'Zij' }), E.zijNum = h('span', { class: 'sp-num', text: '0' }),
      E.zijNames = h('span', { class: 'sp-names' })));
  E.potje = h('div', { class: 'potje', title: 'Het hoeveelste potje van het spel' },
    h('span', { class: 'potje-lbl', text: 'Potje' }), h('span', { class: 'potje-n' }, E.potjeN = h('b', { text: '1' }), '/', E.potjeT = h('span', { text: '16' })));
  E.badge = h('button', { class: 'trump-badge', type: 'button', title: 'Troef: tik voor details over troef en spelvariant', onclick: () => panels.openTrumpInfo() },
    E.badgeSym = h('span', { class: 'tb-sym', text: '?' }),
    E.badgeLbl = h('span', { class: 'tb-lbl', text: 'Troef' }));
  bar.append(E.pill, E.potje, E.badge, h('span', { class: 'spacer' }),
    ...panels.toolButtons(['last', 'score', 'chat', 'help', 'settings', 'sound', 'menu']));
}

function buildSeat(pos) {
  const S = {};
  S.root = h('div', { class: 'seat seat-' + pos },
    h('div', { class: 'seat-id' },
      S.ring = h('span', { class: 'ring' },
        S.av = h('span', { class: 'avatar' }),
        S.chip = h('span', { class: 'dealer-chip', title: 'Gever: deze speler heeft gedeeld', text: 'G', hidden: true }),
        S.ttag = h('span', { class: 'trump-tag', hidden: true, title: 'Koos troef' })),
      h('span', { class: 'plate' },
        S.name = h('span', { class: 'nm' }),
        S.status = h('span', { class: 'st', hidden: true }))),
    S.backs = h('div', { class: 'backs', 'aria-hidden': 'true' }),
    S.bubble = h('div', { class: 'bubble', hidden: true }));
  seats[pos] = S;
  return S.root;
}

// ---------- render ----------

export function render(s, o = {}) {
  if (!s) return;
  app.view = s;
  if (!PLAYING.has(s.phase)) { selected = ''; pendingAction = false; }
  renderTop(s);
  for (let seat = 0; seat < 4; seat++) renderSeat(s, seat, o);
  renderTrick(s);
  renderStage(s);
  renderPrompt(s);
  renderHand(s, o);
}

// The team's two names in the score pill; each shortens on its own and
// keeps its "(AI)".
function setTeamNames(el, s, team) {
  const names = [];
  for (let seat = team; seat < 4; seat += 2) names.push(seat === s.you ? 'jij' : s.players[seat]?.name || 'vrij');
  const all = names.join(' & ');
  if (el.title === all) return;
  el.title = all;
  el.replaceChildren(playerName(names[0]), h('span', { class: 'pname-sep', text: ' & ' }), playerName(names[1]));
}

function renderTop(s) {
  const w = s.you % 2;
  countUp(E.wijNum, s.total?.[w] ?? 0);
  countUp(E.zijNum, s.total?.[1 - w] ?? 0);
  setTeamNames(E.wijNames, s, w);
  setTeamNames(E.zijNames, s, 1 - w);
  E.potjeN.textContent = s.handNo || 1;
  E.potjeT.textContent = s.hands || s.opts?.hands || 16;

  const known = !!s.trump && s.playingTeam >= 0;
  // The turned suit shows once it has been turned up (after the deal pause).
  const sym = known ? s.trump : s.phase === 'bid' && s.turn < 0 ? null : s.turned;
  E.badge.dataset.suit = sym || '';
  E.badge.className = 'trump-badge' + (sym && isRed(sym) ? ' red' : '') + (known ? ' known ' + teamCls(s, s.trumpBy) : ' unknown');
  E.badgeSym.textContent = sym ? suitSym(sym) : '?';
  E.badgeLbl.textContent = known ? (s.trumpBy === s.you ? 'Jij' : teamName(s, s.playingTeam)) : s.turned ? '?' : 'Troef';
  E.badge.title = known
    ? `Troef is ${suitName(s.trump)}, gekozen door ${nameOf(s, s.trumpBy, false)}. Tik voor details.`
    : 'Er is nog geen troef gekozen. Tik voor details over de spelvariant.';
  panels.setLastEnabled(!!s.lastTrick?.cards?.length);
}

function renderSeat(s, seat, o) {
  const pos = posOf(seat, s.you);
  const S = seats[pos];
  const p = s.players[seat];
  const turn = s.turn === seat && PLAYING.has(s.phase);
  const cls = ['seat', 'seat-' + pos, teamCls(s, seat)];
  if (turn) cls.push('turn');
  if (!p) cls.push('empty');
  if (p?.bot) cls.push('bot');
  if (p?.away) cls.push('away');
  if (p && !p.bot && !p.connected) cls.push('offline');
  const keep = S.root.classList.contains('talking') ? ' talking' : '';
  S.root.className = cls.join(' ') + keep;
  fillAvatar(S.av, p);
  S.name.textContent = p ? (pos === 'bottom' ? `${p.name}` : p.name) : 'Vrij';
  S.root.title = p ? `${p.name} · ${isWij(s, seat) ? 'Wij' : 'Zij'}${seat === s.you ? ' (jij)' : ''}` : 'Lege plaats';
  S.chip.hidden = s.dealer !== seat || s.phase === 'lobby';
  const status = p?.away ? 'AI speelt even mee' : p && !p.bot && !p.connected ? 'verbinding weg' : '';
  S.status.hidden = !status;
  S.status.textContent = status;

  const tt = s.trump && s.trumpBy === seat && PLAYING.has(s.phase);
  S.ttag.hidden = !tt;
  if (tt) {
    S.ttag.textContent = suitSym(s.trump);
    S.ttag.classList.toggle('red', isRed(s.trump));
  }

  if (pos === 'bottom') return;
  const open = s.hands4?.[seat];
  if (open && PLAYING.has(s.phase) && !o.dealing) renderOpenHand(S, open);
  else setBacks(S, o.backs ? o.backs[seat] : PLAYING.has(s.phase) ? (p?.cards ?? 0) : 0);
}

function setBacks(S, n) {
  if (S.backs.classList.contains('open')) { clear(S.backs); S.backs.classList.remove('open'); }
  const have = S.backs.children.length;
  for (let i = have; i < n; i++) S.backs.append(createBack());
  for (let i = have; i > n; i--) S.backs.lastElementChild.remove();
  S.backs.dataset.n = n;
}

function renderOpenHand(S, cards) {
  if (!S.backs.classList.contains('open')) { clear(S.backs); S.backs.classList.add('open'); }
  const key = cards.join(',');
  if (S.backs.dataset.key === key) return;
  S.backs.dataset.key = key;
  clear(S.backs);
  for (const c of cards) S.backs.append(createCard(c, { size: 'sm' }));
  S.backs.dataset.n = cards.length;
}

function shownTrick(s) {
  if (s.trick?.cards?.length) return s.trick;
  return heldTrick;
}

// Small deterministic tilt per card so the trick looks hand-placed.
function tilt(code) {
  let x = 0;
  for (const ch of code) x = (x * 31 + ch.charCodeAt(0)) % 997;
  return (x % 11) - 5;
}

function trickCard(code) {
  const el = createCard(code);
  el.style.setProperty('--r', tilt(code) + 'deg');
  return el;
}

function renderTrick(s) {
  const t = shownTrick(s);
  const want = new Map();
  const done = !!t && t.cards.length === 4 && t.winner >= 0;
  (t?.cards || []).forEach((pc, i) => want.set(posOf(pc.seat, s.you), { code: pc.card, i, win: done && pc.seat === t.winner }));
  if (pending?.placed && !want.has('bottom')) want.set('bottom', { code: pending.card, i: want.size, win: false });
  for (const pos of POS) {
    const slot = slots[pos];
    const w = want.get(pos);
    let cur = slot.firstElementChild;
    if (!w) {
      if (cur) clear(slot);
      continue;
    }
    if (!cur || cur.dataset.card !== w.code) {
      clear(slot);
      slot.append(cur = trickCard(w.code));
    }
    slot.style.zIndex = w.win ? 20 : 10 + w.i;
    cur.classList.toggle('winner', w.win);
  }
  E.trick.classList.toggle('done', done);
}

function renderStage(s) {
  const my = s.turn === s.you;
  let key = '';
  if (s.phase === 'trump' && !shownTrick(s)) key = my ? `trump-me-${s.forced}-${s.turned}` : s.turn >= 0 ? `trump-wait-${s.turn}` : '';
  else if (s.phase === 'bid' && s.turn >= 0) key = `bid-${my}-${s.turn}-${s.turned}`;
  const hintKey = s.hint ? JSON.stringify(s.hint) : '';
  if (key + '|' + hintKey + '|' + pendingAction === stageKey) return;
  stageKey = key + '|' + hintKey + '|' + pendingAction;
  clear(E.stage);
  E.stage.className = 'stage' + (key ? ' on' : '') + (my ? ' mine' : '');
  if (!key) return;
  if (s.phase === 'trump') E.stage.append(my ? trumpPanel(s) : waitPanel(s, 'kiest troef'));
  else E.stage.append(bidPanel(s, my));
  if (my && !pendingAction) focusStage();
}

// Keyboard users land on the choice at once (the advised one in training);
// on touch screens a focus ring would only distract.
function focusStage() {
  if (touch.matches || panels.isOpen() || !panels.focusFree()) return;
  const btn = E.stage.querySelector('button.advised:not(:disabled)') || E.stage.querySelector('button:not(:disabled)');
  btn?.focus({ preventScroll: true });
}

// The training hint for a trump or bid choice, inside the panel: the coach
// bubble above the hand would sit underneath it.
function panelHint(s) {
  if (!s.hint?.text) return null;
  return h('div', { class: 'panel-hint' },
    h('span', { class: 'ph-ico', 'aria-hidden': 'true', text: '💡' }),
    h('span', {}, h('b', { text: 'Tip ' }), suitify(s.hint.text)));
}

function waitText(s, what) {
  return h('div', { class: 'wait-text' }, h('b', { text: nameOf(s, s.turn) }), ` ${what}`,
    h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
}

function waitPanel(s, what) {
  return h('div', { class: 'panel panel-wait' }, waitText(s, what));
}

function trumpPanel(s) {
  const forced = s.forced && s.turned;
  const btns = ['C', 'D', 'H', 'S'].map(c => {
    const off = forced && c === s.turned;
    const advised = s.hint?.suit === c;
    return h('button', {
      class: 'suit-btn' + (isRed(c) ? ' red' : '') + (advised ? ' advised' : ''), type: 'button', disabled: off || pendingAction,
      title: off ? 'De gedraaide kleur mag niet meer' : `Kies ${suitName(c)} als troef`,
      'aria-label': `${suitName(c)} als troef`, onclick: () => sendAction({ t: 'trump', suit: c }),
    }, h('span', { class: 'sym', text: suitSym(c) }), h('span', { class: 'nm', text: suitName(c) }));
  });
  return h('div', { class: 'panel panel-trump' },
    h('div', { class: 'panel-title', text: forced ? 'Iedereen paste: kies een andere troef' : 'Kies troef' }),
    h('div', { class: 'suit-btns' }, btns),
    panelHint(s),
    h('div', { class: 'panel-sub', text: forced ? `${suitText(s.turned)} mag niet meer. Jullie spelen en moeten de meeste punten halen.` : 'Jij komt uit. Jullie moeten daarna meer dan de helft van de punten halen.' }));
}

function bidPanel(s, my) {
  const c = s.turned;
  const card = h('div', { class: 'turned' + (isRed(c) ? ' red' : '') },
    h('span', { class: 'turned-lbl', text: 'Gedraaid' }),
    h('span', { class: 'turned-sym', text: suitSym(c) }),
    h('span', { class: 'turned-nm', text: suitName(c) }));
  if (!my) return h('div', { class: 'panel panel-bid' }, card, s.turn >= 0 ? waitText(s, 'denkt na') : null);
  const adv = s.hint && typeof s.hint.play === 'boolean' ? s.hint.play : null;
  return h('div', { class: 'panel panel-bid' }, card,
    h('div', { class: 'panel-title', text: `Spelen op ${suitName(c)}?` }),
    h('div', { class: 'bid-btns' },
      h('button', { class: 'btn btn-go' + (adv === true ? ' advised' : ''), type: 'button', disabled: pendingAction, onclick: () => sendAction({ t: 'bid', play: true }) }, 'Spelen'),
      h('button', { class: 'btn btn-pass' + (adv === false ? ' advised' : ''), type: 'button', disabled: pendingAction, onclick: () => sendAction({ t: 'bid', play: false }) }, 'Passen')),
    panelHint(s));
}

function sendAction(m) {
  if (pendingAction) return;
  sound.play('click');
  pendingAction = true;
  actionAt = performance.now();
  app.send(m);
  stageKey = '';
  renderStage(app.s);
}

function renderPrompt(s) {
  const my = s.turn === s.you;
  let text = '';
  let cls = 'rule';
  const lifted = s.phase === 'play' && my && !pending && selected && (s.legal || []).includes(selected) ? selected : '';
  if (lifted) { text = liftedText(lifted); cls += ' mine'; }
  else if (s.phase === 'play' && my && !pending) { text = s.rule || 'Jouw beurt: speel een kaart'; cls += ' mine'; }
  else if (s.phase === 'play' && s.turn >= 0 && !my) text = `${nameOf(s, s.turn)} is aan de beurt`;
  else if (s.phase === 'trump' && my) { text = 'Jij mag troef kiezen'; cls += ' mine'; }
  else if (s.phase === 'bid' && my) { text = 'Spelen of passen?'; cls += ' mine'; }
  E.rule.className = cls + (text ? '' : ' empty');
  if (E.rule.dataset.text !== text) {
    E.rule.dataset.text = text;
    E.rule.replaceChildren(suitify(text));
  }

  const key = s.hint?.text && PLAYING.has(s.phase) && my ? JSON.stringify(s.hint) : '';
  if (dismissed !== key) dismissed = ''; // a new hint shows again
  const hint = key && !dismissed ? s.hint.text : '';
  const show = hint || tip;
  E.coach.hidden = !show;
  // Trump and bid hints are in the panel; only short landscape screens,
  // where the coach sits in a free corner, keep the bubble (see app.css).
  E.coach.classList.toggle('on-stage', !!hint && s.phase !== 'play');
  if (show) {
    E.coach.classList.toggle('is-tip', !hint);
    E.coachIcon.textContent = hint ? '💡' : '👩‍🏫';
    E.coachLbl.textContent = hint ? 'Tip ' : 'Uitleg ';
    if (E.coachText.dataset.text !== show) {
      E.coachText.dataset.text = show;
      E.coachText.replaceChildren(suitify(show));
      E.coach.classList.remove('open'); // a new text starts short again
    }
  }
  fitCoach();
}

// On a short landscape screen the coach sits in the top-left corner, above
// the left seat: the player after you, whose turn ring must stay in view.
// A text too long for that room shows the lines that fit and "Lees verder";
// opened on purpose, it may cover the seat until "Minder" or ✕.
function fitCoach() {
  E.coach.style.removeProperty('--coach-lines');
  if (!shortLandscape.matches) E.coach.classList.remove('open'); // turned upright
  const open = E.coach.classList.contains('open');
  let clamped = false;
  if (shortLandscape.matches && !E.coach.hidden && !open) {
    E.coach.classList.remove('clamped');
    E.coachMore.hidden = true; // measured without it: it goes over the last line
    const over = coachBottom() - (seats.left.ring.getBoundingClientRect().top - COACH_GAP);
    if (over > 0) {
      const lh = parseFloat(getComputedStyle(E.coachTxt).lineHeight) || 16;
      E.coach.style.setProperty('--coach-lines', Math.max(2, Math.floor((E.coachTxt.clientHeight - over) / lh)));
      clamped = E.coachTxt.scrollHeight > E.coachTxt.clientHeight + 1;
    }
  }
  E.coach.classList.toggle('clamped', clamped);
  E.coachMore.hidden = !clamped && !open;
  E.coachMore.textContent = open ? 'Minder' : 'Lees verder';
  E.coachMore.setAttribute('aria-expanded', String(open));
}
const COACH_GAP = 8; // px kept free above the left seat's ring

// The coach's bottom edge as laid out, without its rise-in animation.
function coachBottom() {
  const par = E.coach.offsetParent;
  if (!par) return E.coach.getBoundingClientRect().bottom;
  return par.getBoundingClientRect().top + par.clientTop + E.coach.offsetTop + E.coach.offsetHeight;
}

function toggleCoach() {
  E.coach.classList.toggle('open');
  fitCoach();
}

// What the second tap does, once a card is lifted.
function liftedText(code) {
  const c = cardShort(code);
  if (selectedBy === 'key') return `Enter speelt ${c}`;
  return (prefs.lifts || 0) <= LIFT_HINTS ? `Tik nog eens om ${c} te spelen, of veeg hem omhoog` : `Tik nog eens om ${c} te spelen`;
}

function closeCoach() {
  const s = app.s;
  if (s?.hint?.text && !E.coach.classList.contains('is-tip')) dismissed = JSON.stringify(s.hint);
  tip = '';
  if (s) renderPrompt(s);
}

function renderHand(s, o = {}) {
  const codes = PLAYING.has(s.phase) ? (s.hand || []).filter(c => c !== pending?.card) : [];
  for (const [c, el] of handEls) {
    if (!codes.includes(c)) { el.remove(); handEls.delete(c); }
  }
  for (const c of codes) {
    if (handEls.has(c)) continue;
    const el = createCard(c);
    el.classList.add('hc');
    handEls.set(c, el);
    E.hand.append(el);
  }
  if (selected && !codes.includes(selected)) selected = '';
  handOrder = codes;
  const playing = s.phase === 'play' && s.turn === s.you && !pending;
  const legal = new Set(s.legal || []);
  codes.forEach((c, i) => {
    const el = handEls.get(c);
    el.classList.toggle('legal', playing && legal.has(c));
    el.classList.toggle('disabled', playing && !legal.has(c));
    el.classList.toggle('selected', c === selected);
    el.classList.toggle('hint', playing && s.hint?.card === c);
    el.classList.toggle('dealing', !!o.dealing);
    el.style.zIndex = i + 1;
  });
  E.hand.classList.toggle('my-turn', playing);
  E.table.classList.toggle('my-turn', s.turn === s.you && PLAYING.has(s.phase));
  layoutHand();
}

// Fans the hand so it always fits the available width.
function layoutHand() {
  const n = handOrder.length;
  if (!n) return;
  const els = handOrder.map(c => handEls.get(c));
  const W = E.hand.clientWidth;
  const cw = els[0].offsetWidth || 64;
  const ch = cw * 1.4;
  const fan = Math.min(2.6, 16 / n);
  // Rotated edge cards stick out by about ch·sin(edge angle).
  const pad = Math.max(6, W * 0.012) + ch * Math.sin(((n - 1) / 2) * fan * Math.PI / 180);
  const max = cw * (W > 700 ? 0.8 : 0.7);
  const step = n > 1 ? Math.max(cw * 0.2, Math.min(max, (W - 2 * pad - cw) / (n - 1))) : 0;
  const x0 = (W - (cw + step * (n - 1))) / 2;
  const k = cw / 70;
  els.forEach((el, i) => {
    const t = i - (n - 1) / 2;
    el.style.setProperty('--x', `${(x0 + i * step).toFixed(1)}px`);
    el.style.setProperty('--y', `${(t * t * 1.1 * k).toFixed(1)}px`);
    el.style.setProperty('--rot', `${(t * fan).toFixed(2)}deg`);
  });
}

// ---------- hand input ----------

function bindHand() {
  E.hand.addEventListener('pointerdown', e => {
    const el = e.target.closest('.card');
    if (!el || !el.dataset.card) return;
    sound.unlock();
    drag = { code: el.dataset.card, x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType, done: false };
    try { E.hand.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });
  E.hand.addEventListener('pointermove', e => {
    if (!drag || drag.done || e.pointerId !== drag.id || drag.type === 'mouse') return;
    if (drag.y - e.clientY > 30 && Math.abs(e.clientX - drag.x) < 70) {
      drag.done = true;
      tryPlay(drag.code);
    }
  });
  E.hand.addEventListener('pointerup', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (d.done || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 14) return;
    tap(d.code, d.type);
  });
  E.hand.addEventListener('pointercancel', () => { drag = null; });
  E.hand.addEventListener('contextmenu', e => e.preventDefault());
}

function tap(code, type) {
  const s = app.s;
  if (!s) return;
  const playing = s.phase === 'play' && s.turn === s.you && !pending;
  const legal = (s.legal || []).includes(code);
  if (playing && !legal) return illegal(code, s);
  // A forced card needs no second tap: there is nothing to get wrong.
  const forced = playing && s.legal.length === 1;
  if (type === 'mouse' || prefs.tap === 'one' || selected === code || forced) return tryPlay(code);
  selected = code;
  selectedBy = 'tap';
  if (playing && (prefs.lifts || 0) <= LIFT_HINTS) {
    prefs.lifts = (prefs.lifts || 0) + 1;
    savePrefs();
  }
  renderHand(s);
  renderPrompt(s);
}

function illegal(code, s) {
  sound.play('error');
  shake(handEls.get(code));
  toast('Die kaart mag nu niet', { sub: s.rule || '', kind: 'warn' });
}

function shake(el) {
  if (el) anim(el, [{ translate: '0 0' }, { translate: '-5px 0' }, { translate: '5px 0' }, { translate: '0 0' }], 260);
}

function tryPlay(code) {
  const s = app.s;
  if (!s || pending) return;
  const el = handEls.get(code);
  if (s.phase === 'play' && s.turn < 0) {
    // A pause: the trick is being collected, or play is about to start.
    toast(shownTrick(s)?.cards?.length === 4 ? 'Even geduld, de slag wordt opgehaald' : 'Even geduld, het spel gaat zo verder');
    return;
  }
  if (s.phase !== 'play' || s.turn !== s.you) {
    shake(el);
    toast(s.phase === 'play' ? `Wacht even: ${nameOf(s, s.turn)} is aan de beurt` : 'Je kunt nu nog geen kaart spelen');
    return;
  }
  if (!(s.legal || []).includes(code)) return illegal(code, s);
  const from = el.getBoundingClientRect();
  const rot = parseFloat(el.style.getPropertyValue('--rot')) || 0;
  pending = { card: code, placed: false, at: performance.now() };
  selected = '';
  // The previous trick's explanation has done its job: once the hint has
  // gone it must not come back over the new trick as if about this card.
  tip = '';
  sound.play('card');
  app.send({ t: 'play', card: code });
  const p = pending;
  p.flight = fly(code, from, slots.bottom, { rotFrom: rot, ms: 360 }).then(() => {
    if (pending === p) { p.placed = true; renderTrick(app.s); }
  });
  renderHand(s);
  renderPrompt(s);
}

function onKey(e) {
  const s = app.s;
  if (!s || document.body.dataset.screen !== 'game' || panels.isOpen()) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('button')) return;
  if (!handOrder.length || !PLAYING.has(s.phase)) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const playing = s.phase === 'play' && s.turn === s.you;
    const pool = playing && s.legal?.length ? handOrder.filter(c => s.legal.includes(c)) : handOrder;
    let i = pool.indexOf(selected);
    i = i < 0 ? (e.key === 'ArrowLeft' ? pool.length - 1 : 0) : (i + (e.key === 'ArrowLeft' ? -1 : 1) + pool.length) % pool.length;
    selected = pool[i];
    selectedBy = 'key';
    renderHand(s);
    renderPrompt(s);
  } else if ((e.key === 'Enter' || e.key === ' ') && selected) {
    e.preventDefault();
    tryPlay(selected);
  } else if (e.key === 'Escape' && selected) {
    selected = '';
    renderHand(s);
    renderPrompt(s);
  }
}

// Server rejected our last action: put things back.
export function onError() {
  if (pending) {
    pending = null;
    if (app.s) render(app.s);
  }
  if (pendingAction) {
    pendingAction = false;
    stageKey = '';
    if (app.s) renderStage(app.s);
  }
}

// ---------- flights ----------

let flyLayer;
function layer() {
  flyLayer ??= document.getElementById('fly');
  return flyLayer;
}

// FLIP flight of a card (or back) from a source rect to a target element.
function fly(code, from, target, { rotFrom = 0, flip = false, back = false, ms = 400, fade = false } = {}) {
  const to = target.getBoundingClientRect();
  const d = dur(ms);
  if (!d || !to.width) return Promise.resolve();
  const w = to.width;
  let el;
  if (back) el = createBack();
  else if (flip) el = h('div', { class: 'flip' }, createCard(code), createBack());
  else el = createCard(code);
  el.classList.add('flyer');
  el.style.setProperty('--card-w', w + 'px');
  el.style.left = to.left + 'px';
  el.style.top = to.top + 'px';
  layer().append(el);
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const sc = Math.max(0.2, from.width / w);
  const rotTo = code && !back ? tilt(code) : 0;
  const yFrom = flip ? ' rotateY(180deg)' : '';
  const a = el.animate([
    { transform: `perspective(900px) translate(${dx}px, ${dy}px) rotate(${rotFrom}deg) scale(${sc})${yFrom}`, opacity: fade ? 0.4 : 1 },
    { transform: `perspective(900px) translate(0, 0) rotate(${rotTo}deg) scale(1)${flip ? ' rotateY(0deg)' : ''}`, opacity: 1 },
  ], { duration: d, easing: EASE, fill: 'forwards' });
  return a.finished.catch(() => {}).then(() => { el.remove(); });
}

function rectOf(el) {
  return el.getBoundingClientRect();
}

// Where cards come from / go to for a seat.
function seatRect(pos) {
  const S = seats[pos];
  if (pos !== 'bottom' && S.backs.children.length) return rectOf(S.backs.lastElementChild);
  return rectOf(S.av);
}

// ---------- events ----------

// Animates one event from the previously rendered state to `next`; the
// caller renders `next` afterwards.
export async function animate(ev, prev, next) {
  switch (ev.type) {
    case 'deal': return animDeal(ev, next);
    case 'turned': return animTurned(next);
    case 'bid': return animBid(ev, next);
    case 'trump': return animTrump(ev, next);
    case 'play': return animPlay(ev, prev, next);
    case 'trick': return animTrick(ev, next);
    case 'collect': return animCollect(ev, next);
    case 'handEnd': return animHandEnd(ev, next);
    case 'gameOver': sound.play(next.winner === -1 ? 'click' : next.winner === next.you % 2 ? 'win' : 'lose'); return;
    case 'join': case 'leave': case 'away': case 'back': return seatToast(ev, prev, next);
    default: return;
  }
}

async function animDeal(ev, next) {
  heldTrick = null;
  pending = null;
  pendingAction = false;
  selected = '';
  tip = '';
  dismissed = '';
  clear(E.fx);
  for (const pos of POS) clear(slots[pos]);
  const you = next.you;
  const dealer = ev.dealer ?? next.dealer;
  render(next, { dealing: true, backs: [0, 0, 0, 0] });
  if (!dur(100)) return;
  sound.play('shuffle');
  const src = seatRect(posOf(dealer, you));
  // Fit the 12 packets into ~85% of the server's deal pause for this tempo.
  const pause = { rustig: 2000, normaal: 1500, snel: 900 }[next.opts?.tempo] ?? 1500;
  const stagger = Math.max(25, (pause * 0.85 - 420) / 11);
  const counts = [0, 0, 0, 0];
  const flights = [];
  let k = 0;
  await wait(100);
  for (const n of [3, 2, 3]) {
    for (let j = 0; j < 4; j++) {
      const seat = (dealer + 1 + j) % 4;
      const from = counts[seat];
      counts[seat] += n;
      flights.push(sleep(dur(k++ * stagger)).then(() => packet(src, seat, posOf(seat, you), from, n, next)));
    }
  }
  await Promise.all(flights);
}

function packet(src, seat, pos, from, n, s) {
  sound.play('deal');
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const idx = from + i;
    if (pos === 'bottom') {
      const el = handEls.get(handOrder[idx]);
      if (!el) continue;
      jobs.push(sleep(dur(i * 30)).then(() => fly('', src, el, { back: true, ms: 320 })).then(() => el.classList.remove('dealing')));
    } else {
      const S = seats[pos];
      const target = S.backs.children[Math.min(idx, S.backs.children.length - 1)] || S.backs;
      jobs.push(sleep(dur(i * 30)).then(() => fly('', src, target.isConnected ? target : S.av, { back: true, ms: 320 })).then(() => {
        if (s.hands4?.[seat]) return;
        setBacks(S, Math.max(Number(S.backs.dataset.n) || 0, idx + 1));
      }));
    }
  }
  return Promise.all(jobs);
}

async function animTurned(next) {
  render(next);
  sound.play('card');
  const t = E.stage.querySelector('.turned');
  if (t) await anim(t, [{ transform: 'rotateY(90deg) scale(.6)', opacity: 0 }, { transform: 'rotateY(0) scale(1)', opacity: 1 }], 450);
  await wait(250);
}

async function animBid(ev, next) {
  bubble(next, ev.seat, ev.play ? 'Ik speel!' : 'Pas', ev.play ? 'go' : 'pass', 1800);
  sound.play(ev.play ? 'trump' : 'click');
  await wait(ev.play ? 250 : 450);
}

async function animTrump(ev, next) {
  render(next);
  sound.play('trump');
  const who = nameOf(next, ev.seat);
  // Gedraaid: a "spelen" bid makes the turned suit trump.
  const text = ev.forced ? `${who} moest kiezen` : next.bids?.[ev.seat] === 1 ? `${who} speelt` : `${who} kiest`;
  const ban = h('div', { class: 'banner ' + teamCls(next, ev.seat) },
    h('span', { class: 'banner-sym' + (isRed(ev.suit) ? ' red' : ''), text: suitSym(ev.suit) }),
    h('span', { class: 'banner-text' }, h('small', { text }), h('b', { text: cap(`${suitName(ev.suit)} is troef`) })));
  E.fx.append(ban);
  anim(E.badge, [{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], 600, { delay: 500 });
  await anim(ban, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1.06)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)', opacity: 1 }], 420);
  await wait(800);
  await anim(ban, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(-12px)' }], 260, { fill: 'forwards' });
  ban.remove();
}

async function animPlay(ev, prev, next) {
  const pos = posOf(ev.seat, next.you);
  // Our card (sent here, or played for us while away): as in tryPlay.
  if (ev.seat === next.you) tip = '';
  if (ev.seat === next.you && pending?.card === ev.card) {
    await pending.flight;
    pending = null;
    return;
  }
  if (ev.seat === next.you) {
    pending = null;
    const el = handEls.get(ev.card);
    const from = el ? rectOf(el) : rectOf(E.hand);
    const rot = el ? parseFloat(el.style.getPropertyValue('--rot')) || 0 : 0;
    if (el) el.style.visibility = 'hidden';
    sound.play('card');
    await fly(ev.card, from, slots[pos], { rotFrom: rot, ms: 380 });
    return;
  }
  const S = seats[pos];
  let from;
  const openCard = S.backs.classList.contains('open') && [...S.backs.children].find(c => c.dataset.card === ev.card);
  if (openCard) {
    from = rectOf(openCard);
    openCard.style.visibility = 'hidden';
  } else {
    from = seatRect(pos);
    const n = Number(S.backs.dataset.n) || 0;
    if (n > 0) setBacks(S, n - 1);
  }
  sound.play('card');
  await fly(ev.card, from, slots[pos], { flip: !openCard, ms: 420 });
}

async function animTrick(ev, next) {
  if (!next.trick?.cards?.length && next.lastTrick?.cards?.length === 4) heldTrick = next.lastTrick;
  render(next);
  const wij = isWij(next, ev.winner);
  sound.play(wij ? 'trickWon' : 'trick');
  const roem = roemTotal(ev.roem);
  const win = E.trick.querySelector('.card.winner');
  if (win) {
    const r = win.getBoundingClientRect();
    const tr = E.table.getBoundingClientRect();
    const chip = h('div', { class: 'pts-chip ' + (wij ? 'wij' : 'zij'), text: `+${ev.points}` });
    chip.style.left = r.left - tr.left + r.width / 2 + 'px';
    chip.style.top = r.top - tr.top + 'px';
    E.table.append(chip);
    anim(chip, [{ transform: 'translate(-50%, 0) scale(.5)', opacity: 0 }, { transform: 'translate(-50%, -26px) scale(1)', opacity: 1, offset: 0.3 }, { transform: 'translate(-50%, -40px) scale(1)', opacity: 0 }], 1300).then(() => chip.remove());
  }
  if (roem) {
    sound.play('roem');
    roemBurst(ev.roem, roem, wij);
  }
  if (ev.last) await wait(300);
  await wait(roem ? 900 : 550);
}

function roemBurst(items, total, wij) {
  const names = items.map(r => ROEM_NAMES[r.kind] || r.kind).join(' + ');
  const el = h('div', { class: 'roem-burst ' + (wij ? 'wij' : 'zij') },
    h('b', { text: `+${total}` }), h('span', { text: `${names}!` }));
  E.fx.append(el);
  const ms = 1900;
  if (!dur(ms)) { setTimeout(() => el.remove(), 1200); return; }
  anim(el, [
    { transform: 'scale(.3) rotate(-8deg)', opacity: 0 },
    { transform: 'scale(1.15) rotate(2deg)', opacity: 1, offset: 0.18 },
    { transform: 'scale(1) rotate(0)', opacity: 1, offset: 0.3 },
    { transform: 'scale(1) translateY(-10px)', opacity: 1, offset: 0.8 },
    { transform: 'scale(.95) translateY(-30px)', opacity: 0 },
  ], ms, { fill: 'forwards' }).then(() => el.remove());
}

async function animCollect(ev, next) {
  const pos = posOf(ev.winner, next.you);
  const to = rectOf(seats[pos].av);
  const cards = POS.map(p => slots[p].firstElementChild).filter(Boolean);
  if (dur(100)) {
    await Promise.all(cards.map((c, i) => {
      const r = rectOf(c);
      const dx = to.left + to.width / 2 - (r.left + r.width / 2);
      const dy = to.top + to.height / 2 - (r.top + r.height / 2);
      const rt = c.style.getPropertyValue('--r') || '0deg';
      return anim(c, [
        { transform: `rotate(${rt})`, opacity: 1 },
        { transform: `translate(${dx * 0.15}px, ${dy * 0.15}px) rotate(${rt})`, opacity: 1, offset: 0.25 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${i * 9 - 12}deg) scale(.32)`, opacity: 0 },
      ], 480, { delay: i * 35, fill: 'forwards' });
    }));
  }
  heldTrick = null;
  for (const p of POS) clear(slots[p]);
}

async function animHandEnd(ev, next) {
  heldTrick = null;
  const r = ev.result || next.prevHand?.result;
  if (!r) return;
  const w = next.you % 2;
  if (r.pit) {
    sound.play('pit');
    await splash('Pit!', r.pitTeam === w ? 'Wij halen alle slagen' : 'Zij halen alle slagen', 'pit');
  } else if (r.nat) {
    sound.play('nat');
    await splash('Nat!', r.playingTeam === w ? 'Wij gaan nat' : 'Zij gaan nat', 'nat');
  } else {
    sound.play(r.score[w] >= r.score[1 - w] ? 'handWon' : 'handLost');
    await wait(250);
  }
}

async function splash(title, sub, kind) {
  const el = h('div', { class: 'splash splash-' + kind }, h('b', { text: title }), h('span', { text: sub }));
  E.fx.append(el);
  await anim(el, [{ transform: 'scale(2.2)', opacity: 0 }, { transform: 'scale(.95)', opacity: 1, offset: 0.55 }, { transform: 'scale(1)', opacity: 1 }], 520);
  await wait(900);
  await anim(el, [{ opacity: 1 }, { opacity: 0 }], 250, { fill: 'forwards' });
  el.remove();
}

function seatToast(ev, prev, next) {
  // Whoever left is only in the previous state: mid-game a bot already holds the seat.
  const p = ev.type === 'leave'
    ? prev?.players?.[ev.seat] || next.players?.[ev.seat]
    : next.players?.[ev.seat] || prev?.players?.[ev.seat];
  if (ev.seat === next.you) return;
  const name = p?.name || 'Een speler';
  const running = PLAYING.has(next.phase) || next.phase === 'handEnd';
  if (ev.type === 'join') { sound.play('join'); toast(`${name} doet mee`); }
  else if (ev.type === 'leave') toast(`${name} is vertrokken`, { sub: running ? 'Een AI-speler neemt de plaats over.' : '' });
  else if (ev.type === 'away') toast(`${name} is even weg`, { sub: next.players?.[ev.seat]?.away ? 'Een AI-speler speelt tijdelijk mee.' : '' });
  else if (ev.type === 'back') toast(`${name} is terug`);
}

// Speech bubble at a seat (bids, chat lines). Bubbles never pile up (on a
// short portrait screen the top seat's and a side seat's meet in between):
// a chat line in the way of another bubble waits until there is room (it
// is in the chat log meanwhile), and is dropped once it is old news. A bid
// ("Ik speel!", "Pas": in gedraaid the table's only record of it) shows at
// once; a chat bubble in its way ends early.
const BID_KINDS = new Set(['go', 'pass']);
const BUBBLE_WAIT_MS = 6000;
let waitingBubbles = []; // {pos, text, kind, ms, at}

export function bubble(s, seat, text, kind = '', ms = 0) {
  if (!s || seat == null || seat < 0 || document.body.dataset.screen !== 'game') return;
  const pos = posOf(seat, s.you);
  waitingBubbles = waitingBubbles.filter(b => b.pos !== pos); // the newer line wins
  showBubble({ pos, text, kind, ms, at: performance.now() });
}

function showBubble(b) {
  const S = seats[b.pos];
  clearTimeout(S.bubbleTimer);
  for (const a of S.bubble.getAnimations()) a.cancel();
  S.bubble.textContent = b.text;
  S.bubble.className = 'bubble' + (b.kind ? ' bubble-' + b.kind : '');
  S.bubble.style.maxWidth = b.pos === 'left' || b.pos === 'right' ? sideBubbleWidth(S, b.pos) : '';
  S.bubble.hidden = false;
  S.bubbleKind = b.kind;
  // Measured before the pop-in scales it; the others' rects were stored
  // the same way, so a bubble still popping in counts at full size.
  S.bubbleRect = S.bubble.getBoundingClientRect();
  const inWay = POS.filter(p => p !== b.pos && !seats[p].bubble.hidden && overlaps(S.bubbleRect, seats[p].bubbleRect));
  if (!BID_KINDS.has(b.kind) && inWay.length) {
    endBubble(S);
    waitingBubbles.push(b);
    return;
  }
  for (const p of inWay) if (!BID_KINDS.has(seats[p].bubbleKind)) endBubble(seats[p]);
  S.root.classList.add('talking');
  anim(S.bubble, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], 220);
  S.bubbleTimer = setTimeout(() => {
    endBubble(S);
    showWaitingBubbles();
  }, b.ms || Math.min(6000, 2200 + b.text.length * 45));
}

function endBubble(S) {
  clearTimeout(S.bubbleTimer);
  S.bubble.hidden = true;
  S.root.classList.remove('talking');
}

// A bubble ended: the lines waiting for room get their turn, oldest first.
function showWaitingBubbles() {
  const now = performance.now();
  const list = waitingBubbles;
  waitingBubbles = [];
  if (document.body.dataset.screen !== 'game') return;
  for (const b of list) if (now - b.at < BUBBLE_WAIT_MS) showBubble(b);
}

const overlaps = (a, b) => !!a && !!b && a.left < b.right + 2 && b.left < a.right + 2 && a.top < b.bottom + 2 && b.top < a.bottom + 2;

// A side seat talks upwards from its outer edge, or on a short landscape
// table sideways towards the middle (app.css). Either way the bubble stops
// short of the trick slot in its path (the partner's card above, or the
// side seat's own card), so it does not cover the trick. '' leaves the CSS
// maximum.
const shortLandscape = matchMedia('(orientation: landscape) and (max-height: 520px)');
function sideBubbleWidth(S, pos) {
  const seat = S.root.getBoundingClientRect();
  const beside = shortLandscape.matches;
  const slot = (beside ? slots[pos] : slots.top).getBoundingClientRect();
  if (!slot.width) return '';
  const from = beside ? (pos === 'left' ? seat.right + 8 : seat.left - 8) : (pos === 'left' ? seat.left + 2 : seat.right - 2);
  const room = (pos === 'left' ? slot.left - from : from - slot.right) - 10;
  return room < 200 ? Math.max(96, Math.floor(room)) + 'px' : '';
}

// Training explanation after a trick.
export function setTip(text) {
  tip = text || '';
  if (app.s) renderPrompt(app.s);
}

// After every update: an action we sent has been processed. A resync (ev
// null) can also show that it never arrived: then the table gives it back.
export function settle(next, ev = null) {
  const lost = !ev && next.turn === next.you;
  if (pending && !ev) {
    const inHand = (next.hand || []).includes(pending.card);
    if (!inHand || (lost && next.phase === 'play' && performance.now() - pending.at > STUCK_MS)) pending = null;
  }
  if (pendingAction && (next.turn !== next.you || !['trump', 'bid'].includes(next.phase) || (lost && performance.now() - actionAt > STUCK_MS))) {
    pendingAction = false;
    stageKey = '';
  }
}

// After a rejoin: forget everything sent but unanswered, so the resync
// that follows renders the table purely from the server's state.
export function resync() {
  pending = null;
  pendingAction = false;
  selected = '';
  stageKey = '';
  heldTrick = null;
  for (const pos of POS) clear(slots[pos]);
  for (const [, el] of handEls) el.style.visibility = '';
}

export function resetRoom() {
  app.view = null;
  heldTrick = null;
  pending = null;
  pendingAction = false;
  selected = '';
  tip = '';
  dismissed = '';
  stageKey = '';
  waitingBubbles = [];
  for (const pos of POS) endBubble(seats[pos]);
  clear(E.fx);
  for (const pos of POS) clear(slots[pos]);
  for (const [, el] of handEls) el.remove();
  handEls.clear();
  handOrder = [];
}

export function relayout() { layoutHand(); }
