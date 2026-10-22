// The game table: top bar, seats, trick, centre stage, prompt and hand, plus
// the animation for every server event (deal, play, trick, collect, ...).
import { createCard, createBack, cardShort } from './cards.js';
import { sound } from './sound.js';
import {
  app, h, clear, prefs, savePrefs, toast, wait, dur, anim, sleep, EASE, POS, posOf, seatCount, isWij, teamCls, teamName,
  scorerOrder, scorerName, myScorer, nameOf, suitSym, suitName, suitText, isRed, roemTotal, ROEM_NAMES, fillAvatar, countUp, icon,
  suitify, cap, playerName, shortLandscape, onKeyboard,
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
let pendingAction = false; // trump/bid/auction/discard sent, awaiting the server
let picked = [];          // three players, laying away: the cards chosen so far
let bidValue = 0;         // three players, our turn in the auction: the bid on offer
let actionAt = 0;         // when pendingAction was sent
let actionPhase = '';     // the phase it was sent in: the soloist keeps the turn from discard to trump
let talonHand = 0;        // three players: the hand whose talon still lies on the table (until the contract)
let pendingVote = null;   // {seat, left, ai, at} our answer to the takeover question, awaiting the server
let voteSentAt = -1e9;    // when we last answered the takeover question
let voteIds = 0;          // ids that tie the question's title and text to its panel and buttons
let rejoinSent = null;    // after a rejoin: {card, action} we sent just before the connection went
let heldTrick = null;     // completed trick kept on the table until "collect"
let tip = '';             // training explanation after a trick, until our next card
let dismissed = '';       // training hint closed with ✕ (JSON of s.hint)
let drag = null;
let stageKey = '';

const PLAYING = new Set(['auction', 'discard', 'trump', 'bid', 'play']);
// The bids of the three-player auction (design §2).
const MIN_BID = 80;
const BID_STEP = 10;
const MAX_BID = 300;
// A move still unanswered this long after it was sent did not arrive.
const STUCK_MS = 1500;
const STALE_MS = 5000; // a refusal this soon after our vote answers it
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
  // Three players: the two cards that lie closed on the table until the
  // auction is over.
  E.talon = h('div', { class: 'talon', hidden: true, title: 'De twee dichte kaarten op tafel: wie alleen speelt, pakt ze' },
    createBack(), createBack());
  E.center.append(E.trick, E.talon);
  E.stage = h('div', { class: 'stage' });
  E.fx = h('div', { class: 'fx', 'aria-live': 'polite' });
  // Says the takeover question aloud when it opens: on a touch screen the
  // focus does not move to the panel.
  E.ask = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  E.table.append(E.center, E.stage, E.fx, E.ask);

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
  onKeyboard(fitCoach); // the landscape layout comes or goes without a resize
  document.addEventListener('keydown', onKey);
}

function buildTopbar(bar) {
  // One part per score: Wij and Zij with four players, else every player
  // (see renderTop).
  E.pill = h('button', { class: 'score-pill', type: 'button', title: 'Scorebord: alle potjes en de stand', onclick: () => panels.openScoreSheet() });
  E.segs = [];
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
    S.piles = h('div', { class: 'piles', hidden: true }),
    S.bubble = h('div', { class: 'bubble', hidden: true }));
  seats[pos] = S;
  return S.root;
}

// ---------- render ----------

export function render(s, o = {}) {
  if (!s) return;
  app.view = s;
  if (!PLAYING.has(s.phase)) { selected = ''; pendingAction = false; }
  const n = seatCount(s);
  E.table.dataset.players = n;
  renderTop(s);
  for (const pos of POS) seats[pos].root.hidden = true;
  for (let seat = 0; seat < n; seat++) renderSeat(s, seat, o);
  renderTrick(s);
  renderTalon(s, o);
  renderStage(s);
  renderPrompt(s);
  renderHand(s, o);
}

// The names behind a score in the pill, each shortened on its own with its
// "(AI)" kept: a team's two with four players, else the player's.
function setScoreNames(el, s, k) {
  const names = [];
  if (seatCount(s) === 4) {
    for (let seat = k; seat < 4; seat += 2) names.push(seat === s.you ? 'jij' : s.players[seat]?.name || 'vrij');
  } else {
    names.push(k === s.you ? 'jij' : s.players[k]?.name || 'vrij');
  }
  const all = names.join(' & ');
  if (el.title === all) return;
  el.title = all;
  el.replaceChildren(...names.flatMap((nm, i) => [i ? h('span', { class: 'pname-sep', text: ' & ' }) : null, playerName(nm)]).filter(Boolean));
}

// The label of a score in the pill: Wij and Zij with four players, else
// Jij and the others' faces as on their seats (emoji or initial).
function scoreLabel(s, k) {
  if (seatCount(s) === 4 || k === s.you) return scorerName(s, k);
  const p = s.players[k];
  return p?.bot ? p.emoji || '🤖' : (p?.name || '?').trim().charAt(0).toUpperCase();
}

function renderTop(s) {
  const order = scorerOrder(s);
  while (E.segs.length > order.length) E.segs.pop().root.remove();
  while (E.segs.length < order.length) {
    const g = {};
    g.root = h('span', { class: 'sp' }, g.lbl = h('span', { class: 'sp-lbl' }), g.num = h('span', { class: 'sp-num', text: '0' }),
      g.names = h('span', { class: 'sp-names' }));
    E.pill.append(g.root);
    E.segs.push(g);
  }
  order.forEach((k, i) => {
    const g = E.segs[i];
    g.root.className = 'sp ' + (k === myScorer(s) ? 'sp-wij' : 'sp-zij');
    g.lbl.textContent = scoreLabel(s, k);
    countUp(g.num, s.total?.[k] ?? 0);
    setScoreNames(g.names, s, k);
  });
  E.pill.classList.toggle('three', order.length === 3);
  E.potjeN.textContent = s.handNo || 1;
  E.potjeT.textContent = s.hands || s.opts?.hands || 16;

  const known = !!s.trump && s.playingTeam >= 0;
  // The turned suit shows once it has been turned up (after the deal pause).
  const sym = known ? s.trump : s.phase === 'bid' && s.turn < 0 ? null : s.turned;
  E.badge.dataset.suit = sym || '';
  E.badge.className = 'trump-badge' + (sym && isRed(sym) ? ' red' : '') + (known ? ' known ' + teamCls(s, s.trumpBy) : ' unknown');
  E.badgeSym.textContent = sym ? suitSym(sym) : '?';
  E.badgeLbl.textContent = !known ? (s.turned ? '?' : 'Troef') : s.trumpBy === s.you ? 'Jij'
    : seatCount(s) === 4 ? teamName(s, s.playingTeam) : scoreLabel(s, s.trumpBy);
  E.badge.title = known
    ? `Troef is ${suitName(s.trump)}, gekozen door ${nameOf(s, s.trumpBy, false)}. Tik voor details.`
    : 'Er is nog geen troef gekozen. Tik voor details over de spelvariant.';
  panels.setLastEnabled(!!s.lastTrick?.cards?.length);
}

function renderSeat(s, seat, o) {
  const pos = posOf(s, seat);
  const S = seats[pos];
  S.root.hidden = false;
  const p = s.players[seat];
  const turn = s.turn === seat && PLAYING.has(s.phase);
  const cls = ['seat', 'seat-' + pos, teamCls(s, seat)];
  if (turn) cls.push('turn');
  if (!p) cls.push('empty');
  if (p?.bot) cls.push('bot');
  if (p?.away) cls.push('away');
  if (p?.left) cls.push('left');
  if (p && !p.bot && !p.connected) cls.push('offline');
  const keep = S.root.classList.contains('talking') ? ' talking' : '';
  S.root.className = cls.join(' ') + keep;
  fillAvatar(S.av, p);
  S.name.textContent = p ? (pos === 'bottom' ? `${p.name}` : p.name) : 'Vrij';
  S.root.title = p ? `${p.name}${seatCount(s) === 4 ? ` · ${isWij(s, seat) ? 'Wij' : 'Zij'}` : ''}${seat === s.you ? ' (jij)' : ''}` : 'Lege plaats';
  S.chip.hidden = s.dealer !== seat || s.phase === 'lobby';
  // A seat someone left keeps their name until a joiner or an AI takes it.
  const status = p?.left ? 'vertrokken' : p?.away ? 'AI speelt even mee' : p && !p.bot && !p.connected ? 'verbinding weg' : bidStatus(s, seat);
  S.status.hidden = !status;
  S.status.textContent = status;

  const tt = s.trump && s.trumpBy === seat && PLAYING.has(s.phase);
  S.ttag.hidden = !tt;
  if (tt) {
    S.ttag.textContent = suitSym(s.trump);
    S.ttag.classList.toggle('red', isRed(s.trump));
  }

  if (pos === 'bottom') return;
  if (seatCount(s) === 2) {
    setBacks(S, 0);
    renderPiles(S.piles, shownPiles(s, seat, o), false);
    return;
  }
  const open = s.hands4?.[seat];
  if (open && PLAYING.has(s.phase) && !o.dealing) renderOpenHand(S, open);
  else setBacks(S, o.backs ? o.backs[seat] : PLAYING.has(s.phase) ? (p?.cards ?? 0) : 0);
}

// Three players: what a seat bid in the auction ("bod 90", "pas"), and who
// plays alone for how much once it is over.
function bidStatus(s, seat) {
  if (seatCount(s) !== 3 || !PLAYING.has(s.phase)) return '';
  if (s.phase === 'auction') {
    const b = s.bids?.[seat] ?? -1;
    return b > 0 ? `bod ${b}` : b === 0 ? 'pas' : '';
  }
  return seat === s.soloist ? `alleen voor ${s.bid}` : '';
}

// Two players: what a seat's piles show. While the cards are dealt, eight
// empty places for them to fly to; outside a hand nothing.
const NO_PILES = Array.from({ length: 8 }, () => ({ n: 0, card: null }));
function shownPiles(s, seat, o) {
  if (!PLAYING.has(s.phase)) return null;
  return o.dealing ? NO_PILES : s.piles?.[seat] || null;
}

// Two players: the eight piles in front of a seat, as s.piles has them
// ({n, card}: card null when face down). Ours (mine) sit in two rows with
// the front row (piles 0..3) nearest us; the opponent's mirror them. A
// face-up card of ours is in handEls, so it plays like a card in the hand.
function renderPiles(root, piles, mine) {
  const key = piles ? JSON.stringify(piles) : '';
  if (root.dataset.key === key) return;
  root.dataset.key = key;
  if (mine) for (const [c, el] of handEls) { el.remove(); handEls.delete(c); }
  clear(root);
  root.hidden = !piles;
  if (!piles) return;
  piles.forEach((p, i) => {
    const pile = h('div', { class: `pile pile-${i}` + (i < 4 ? ' front' : ' back') + (p.n ? '' : ' gone'), dataset: { pile: i } });
    if (p.n > 1) pile.append(h('div', { class: 'pile-under' }, createBack()));
    if (p.n > 0) {
      const el = p.card ? createCard(p.card) : createBack();
      el.classList.add('pile-top');
      pile.append(el);
      if (mine && p.card) handEls.set(p.card, el);
    }
    root.append(pile);
  });
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
  const done = !!t && t.cards.length === seatCount(s) && t.winner >= 0;
  (t?.cards || []).forEach((pc, i) => want.set(posOf(s, pc.seat), { code: pc.card, i, win: done && pc.seat === t.winner }));
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

// Three players: the talon lies closed in the middle until the auction is
// over (and not while the cards are being dealt).
function renderTalon(s, o = {}) {
  const lying = s.phase === 'auction' || (s.phase === 'discard' && talonHand === s.handNo);
  E.talon.hidden = !(seatCount(s) === 3 && lying && !o.dealing);
}

function renderStage(s) {
  const my = s.turn === s.you;
  const q = s.takeover;
  let key = '';
  // The question whether an AI may play for someone who is gone takes the
  // stage instead of the waiting text.
  if (q) key = `vote-${q.seat}-${q.left}-${nameOf(s, q.seat)}`;
  else if (s.phase === 'trump' && !shownTrick(s)) key = my ? `trump-me-${s.forced}-${s.turned}` : s.turn >= 0 ? `trump-wait-${s.turn}` : '';
  else if (s.phase === 'bid' && s.turn >= 0) key = `bid-${my}-${s.turn}-${s.turned}`;
  else if (s.phase === 'auction' && s.turn >= 0) key = `auction-${my}-${s.turn}-${s.bid}-${s.bidder}`;
  else if (s.phase === 'discard' && s.turn >= 0) key = my ? `discard-me-${picked.join()}` : `discard-wait-${s.turn}`;
  const hintKey = s.hint ? JSON.stringify(s.hint) : '';
  if (key + '|' + hintKey + '|' + pendingAction === stageKey) {
    if (q) fillVote(s); // the answers so far change in place: the focus stays
    return;
  }
  stageKey = key + '|' + hintKey + '|' + pendingAction;
  clear(E.stage);
  E.stage.className = 'stage' + (key ? ' on' : '') + (my || q ? ' mine' : '') + (q ? ' ask' : '') +
    (s.phase === 'discard' && my && !q ? ' low' : '');
  // The question says who the game waits for: the line under the table
  // steps aside, and the panel takes its room as well.
  E.table.classList.toggle('asking', !!q);
  if (!key) return;
  if (q) E.stage.append(votePanel(s));
  else if (s.phase === 'trump') E.stage.append(my ? trumpPanel(s) : waitPanel(s, 'kiest troef'));
  else if (s.phase === 'auction') E.stage.append(auctionPanel(s, my));
  else if (s.phase === 'discard') E.stage.append(my ? discardPanel(s) : waitPanel(s, 'legt twee kaarten weg'));
  else E.stage.append(bidPanel(s, my));
  if ((my && !pendingAction) || q) focusStage();
}

// Three players: bid or pass. The bid on offer starts at the lowest one
// allowed and goes up in steps.
function auctionPanel(s, my) {
  const high = s.bidder >= 0
    ? h('div', { class: 'auction-high' }, 'Hoogste bod: ', h('b', { text: String(s.bid) }), ` van ${nameOf(s, s.bidder, false)}`)
    : h('div', { class: 'auction-high', text: 'Nog geen bod' });
  if (!my) return h('div', { class: 'panel panel-auction' }, high, waitText(s, 'denkt na'));
  const lowest = s.bidder >= 0 ? s.bid + BID_STEP : MIN_BID;
  if (lowest > MAX_BID) {
    return h('div', { class: 'panel panel-auction' }, h('div', { class: 'panel-title', text: 'Bieden' }), high,
      h('div', { class: 'bid-btns' },
        h('button', { class: 'btn btn-pass', type: 'button', disabled: pendingAction, onclick: () => sendAction({ t: 'auction', bid: 0 }) }, 'Passen')),
      h('div', { class: 'panel-sub', text: `Hoger dan ${MAX_BID} kan niet.` }));
  }
  bidValue = Math.min(MAX_BID, Math.max(bidValue, lowest));
  const num = h('output', { class: 'bid-num', 'aria-live': 'polite', text: String(bidValue) });
  const go = h('button', { class: 'btn btn-go', type: 'button', disabled: pendingAction,
    onclick: () => sendAction({ t: 'auction', bid: bidValue }) }, `Bied ${bidValue}`);
  const step = d => {
    bidValue = Math.min(MAX_BID, Math.max(lowest, bidValue + d));
    num.textContent = String(bidValue);
    go.textContent = `Bied ${bidValue}`;
    down.disabled = bidValue <= lowest || pendingAction;
    up.disabled = bidValue >= MAX_BID || pendingAction;
    sound.play('click');
  };
  const down = h('button', { class: 'btn btn-ghost bid-step', type: 'button', 'aria-label': `${BID_STEP} minder`, disabled: bidValue <= lowest || pendingAction, onclick: () => step(-BID_STEP) }, '−');
  const up = h('button', { class: 'btn btn-ghost bid-step', type: 'button', 'aria-label': `${BID_STEP} meer`, disabled: bidValue >= MAX_BID || pendingAction, onclick: () => step(BID_STEP) }, '+');
  return h('div', { class: 'panel panel-auction' },
    h('div', { class: 'panel-title', text: 'Bieden' }),
    high,
    h('div', { class: 'bid-stepper' }, down, num, up),
    h('div', { class: 'bid-btns' }, go,
      h('button', { class: 'btn btn-pass', type: 'button', disabled: pendingAction, onclick: () => sendAction({ t: 'auction', bid: 0 }) }, 'Passen')),
    h('div', { class: 'panel-sub', text: 'Wie het hoogst biedt, pakt de twee dichte kaarten, legt er twee weg en speelt alleen. Haal je bod, roem telt mee, of je gaat nat.' }));
}

// Three players: the soloist chooses two cards in the hand to lay away.
function discardPanel(s) {
  const ready = picked.length === 2;
  return h('div', { class: 'panel panel-discard' },
    h('div', { class: 'panel-title', text: 'Leg twee kaarten weg' }),
    h('div', { class: 'panel-sub', text: ready ? `${picked.map(cardShort).join(' en ')} gaan weg. Hun punten tellen voor jou.`
      : 'Tik twee kaarten aan. De twee kaarten van tafel zitten nu in je hand (gemarkeerd); hun punten tellen voor jou.' }),
    h('div', { class: 'bid-btns' },
      h('button', { class: 'btn btn-go', type: 'button', disabled: !ready || pendingAction,
        onclick: () => sendAction({ t: 'discard', cards: picked.slice() }) }, 'Wegleggen')));
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
    h('div', { class: 'panel-sub', text: trumpSub(s, forced) }));
}

// What choosing trump commits to, under the suit buttons.
function trumpSub(s, forced) {
  const n = seatCount(s);
  if (n === 3) {
    const lead = s.voorhand === s.you ? 'Jij komt uit.' : `${nameOf(s, s.voorhand)} komt uit.`;
    return `Jij speelt alleen en moet minstens ${s.bid} punten halen, roem telt mee. ${lead}`;
  }
  const we = n === 2 ? 'Je moet' : 'Jullie moeten';
  if (forced) return `${suitText(s.turned)} mag niet meer. ${n === 2 ? 'Jij speelt en moet' : 'Jullie spelen en moeten'} meer dan de helft van de punten halen.`;
  return `Jij komt uit. ${we} daarna meer dan de helft van de punten halen.${n === 2 ? ' Dan gaan de achterste kaarten open.' : ''}`;
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
  actionPhase = app.s?.phase || '';
  app.send(m);
  stageKey = '';
  renderStage(app.s);
  renderHand(app.s);
}

// The game waits on someone who left or lost the connection: every other
// person at the table says whether an AI may play that seat, and only if
// all agree does one (design §6). The answer can be changed while the
// question is open; above the buttons, who agrees so far. Once answered,
// the panel keeps to its title, who agrees and the answers, so it covers
// less of the table while the others think. The buttons are last: at the
// foot of the stage they stay put when the text above them changes.
function votePanel(s) {
  const q = s.takeover;
  const name = nameOf(s, q.seat);
  const id = `vote-${++voteIds}`;
  const btn = (ai, cls, text) => h('button', {
    class: 'btn ' + cls, type: 'button', 'aria-pressed': 'false', 'aria-describedby': id + '-q', onclick: () => sendVote(ai),
  }, icon('check'), h('span', { text }));
  const yes = btn(true, 'btn-go', 'AI laten spelen');
  const no = btn(false, 'btn-pass', 'Wachten');
  E.vote = {
    panel: h('div', { class: 'panel panel-vote', role: 'group', 'aria-labelledby': id + '-t', 'aria-describedby': id + '-q' }),
    q: h('p', { class: 'vote-q', id: id + '-q' }),
    yes, no, btns: h('div', { class: 'vote-btns' }, yes, no), who: h('div', { class: 'vote-who' }),
  };
  E.vote.panel.append(h('div', { class: 'panel-title', id: id + '-t', text: q.left ? `${name} is vertrokken` : `${name} is weg` }),
    E.vote.q, E.vote.who, E.vote.btns);
  fillVote(s);
  return E.vote.panel;
}

// What we answered: sent and on its way, else as the server has it.
function myVote(s) {
  const q = s.takeover;
  if (pendingVote && pendingVote.seat === q?.seat && pendingVote.left === q.left) return pendingVote.ai;
  return s.players[s.you]?.vote ?? null;
}

// Everyone asked: the people at the table but for the one it is about,
// you first, and anyone who said no and lost the connection a moment ago
// (that no still holds, design §6).
function voters(s) {
  const n = seatCount(s);
  return Array.from({ length: n }, (_, k) => (s.you + k) % n).filter(seat => {
    const p = s.players[seat];
    return p && !p.bot && seat !== s.takeover.seat && (p.connected || p.vote === false);
  });
}

// Marks the chosen answer and lists everyone asked with their answer so
// far; alone, you are asked only (the list would say just "Jij").
function fillVote(s) {
  const q = s.takeover;
  const name = nameOf(s, q.seat);
  const mine = myVote(s);
  const asked = voters(s);
  const alone = asked.length < 2;
  E.vote.q.textContent = q.left
    ? `Mag een AI-speler de plaats van ${name} innemen? ${alone ? 'Je kunt' : 'Jullie kunnen'} ook wachten tot iemand anders met de code aanschuift.`
    : `Het spel wacht op ${name}. Mag een AI-speler zolang voor ${name} spelen?`;
  E.vote.panel.classList.toggle('answered', mine !== null);
  for (const [b, ai] of [[E.vote.yes, true], [E.vote.no, false]]) {
    b.classList.toggle('chosen', mine === ai);
    b.setAttribute('aria-pressed', String(mine === ai));
  }
  const chips = asked.map(seat => {
    const v = seat === s.you ? mine : s.players[seat].vote;
    // Not answered yet: the dots of someone thinking, not a text ellipsis
    // that would run into a shortened name.
    const st = v === null
      ? h('span', { class: 'vote-st open' }, h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', { class: 'sr-only', text: 'nog niet gekozen' }))
      : h('span', { class: 'vote-st', text: v ? 'akkoord' : 'wil wachten' });
    return h('span', { class: `vote-chip ${teamCls(s, seat)}${v === true ? ' yes' : v === false ? ' no' : ''}` },
      v === true ? icon('check') : null, playerName(nameOf(s, seat), { cls: 'vote-name', title: true }), st);
  });
  E.vote.who.hidden = alone;
  E.vote.who.replaceChildren(h('div', { class: 'vote-rule', text: 'Iedereen moet akkoord zijn:' }), h('div', { class: 'vote-list' }, chips));
}

function sendVote(ai) {
  const s = app.view || app.s; // the question as the table shows it
  const q = s?.takeover;
  if (!q || myVote(s) === ai) return;
  sound.play('click');
  pendingVote = { seat: q.seat, left: q.left, ai, at: performance.now() };
  voteSentAt = pendingVote.at;
  // Which question it answers: a yes for a stand-in is none for a seat given away.
  app.send({ t: 'vote', seat: q.seat, left: q.left, ai });
  fillVote(s);
}

// The question as one line for screen readers, '' when none is open.
function askText(s) {
  const q = s.takeover;
  if (!q) return '';
  const name = nameOf(s, q.seat);
  return q.left ? `${name} is vertrokken. Mag een AI-speler de plaats van ${name} innemen?` : `${name} is weg. Mag een AI-speler zolang voor ${name} spelen?`;
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
  else if (s.phase === 'auction' && my) { text = 'Bieden of passen?'; cls += ' mine'; }
  else if (s.phase === 'discard' && my) { text = `Kies twee kaarten om weg te leggen (${picked.length} van 2)`; cls += ' mine'; }
  E.rule.className = cls + (text ? '' : ' empty');
  if (E.rule.dataset.text !== text) {
    E.rule.dataset.text = text;
    E.rule.replaceChildren(suitify(text));
  }
  const ask = askText(s);
  if (E.ask.textContent !== ask) E.ask.textContent = ask;

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
  if (!shortLandscape()) E.coach.classList.remove('open'); // turned upright
  const open = E.coach.classList.contains('open');
  let clamped = false;
  if (shortLandscape() && !E.coach.hidden && !open) {
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
  const two = seatCount(s) === 2;
  if (E.hand.classList.contains('tableau') !== two) {
    for (const [, el] of handEls) el.remove();
    handEls.clear();
    clear(E.hand);
    delete E.hand.dataset.key;
    E.hand.hidden = false;
    E.hand.classList.toggle('tableau', two);
  }
  if (two) return renderMyPiles(s, o);
  if (s.phase !== 'discard') picked = [];
  // Our talon cards join the hand when they have flown there (animContract).
  const onTable = new Set(s.phase === 'discard' && talonHand === s.handNo ? s.talon || [] : []);
  const codes = PLAYING.has(s.phase) ? (s.hand || []).filter(c => c !== pending?.card && !onTable.has(c)) : [];
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
  const laying = s.phase === 'discard' && s.turn === s.you && !pendingAction;
  const legal = new Set(s.legal || []);
  const talon = new Set(s.phase === 'discard' ? s.talon || [] : []);
  picked = picked.filter(c => codes.includes(c));
  codes.forEach((c, i) => {
    const el = handEls.get(c);
    el.classList.toggle('legal', playing && legal.has(c));
    el.classList.toggle('selectable', laying);
    el.classList.toggle('disabled', playing && !legal.has(c));
    el.classList.toggle('selected', c === selected);
    el.classList.toggle('picked', picked.includes(c));
    el.classList.toggle('from-talon', talon.has(c));
    el.classList.toggle('hint', playing && s.hint?.card === c);
    el.classList.toggle('dealing', !!o.dealing);
    el.style.zIndex = i + 1;
  });
  E.hand.classList.toggle('my-turn', playing || laying);
  E.table.classList.toggle('my-turn', s.turn === s.you && PLAYING.has(s.phase));
  layoutHand();
}

// Two players: our eight piles take the place of the hand. Their face-up
// cards play like cards in the hand; a card on its way to the trick is
// hidden at once.
function renderMyPiles(s, o) {
  renderPiles(E.hand, shownPiles(s, s.you, o), true);
  if (selected && !handEls.has(selected)) selected = '';
  handOrder = [...handEls.keys()];
  const playing = s.phase === 'play' && s.turn === s.you && !pending;
  const legal = new Set(s.legal || []);
  for (const [c, el] of handEls) {
    el.style.visibility = c === pending?.card ? 'hidden' : '';
    el.classList.toggle('legal', playing && legal.has(c));
    el.classList.toggle('disabled', playing && !legal.has(c));
    el.classList.toggle('selected', c === selected);
    el.classList.toggle('hint', playing && s.hint?.card === c);
  }
  E.hand.classList.toggle('my-turn', playing);
  E.table.classList.toggle('my-turn', s.turn === s.you && PLAYING.has(s.phase));
}

// Fans the hand so it always fits the available width.
function layoutHand() {
  const n = handOrder.length;
  if (!n || E.hand.classList.contains('tableau')) return;
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
  if (s.phase === 'discard' && s.turn === s.you) return pick(code);
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

// Three players, laying away: a tap chooses a card or puts it back; a
// third choice replaces the first.
function pick(code) {
  const s = app.s;
  if (pendingAction) return;
  if (picked.includes(code)) picked = picked.filter(c => c !== code);
  else {
    if (picked.length === 2) picked.shift();
    picked.push(code);
  }
  sound.play('click');
  renderHand(s);
  renderStage(s);
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
    toast(shownTrick(s)?.cards?.length === seatCount(s) ? 'Even geduld, de slag wordt opgehaald' : 'Even geduld, het spel gaat zo verder');
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
  p.flight = fly(code, from, slots.bottom, { rotFrom: rot, ms: 360, index: indexOf(el) }).then(() => {
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
  } else if ((e.key === 'Enter' || e.key === ' ') && selected && s.phase === 'discard') {
    e.preventDefault();
    if (s.turn === s.you) pick(selected);
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
    if (app.s) {
      renderStage(app.s);
      renderHand(app.s);
    }
  }
  if (pendingVote) {
    pendingVote = null;
    if (app.s?.takeover && E.vote) fillVote(app.s);
  }
}

// A vote that comes too late is no mistake of the player: the question
// closed (they are back, the others agreed) or changed meanwhile, often
// in an update that came just before this answer. Our answer goes without
// the error sound and toast; the panel shows what still is to be answered.
// Reports whether the error was that.
export function staleVote(m) {
  if (m.code !== 'ongeldig' || m.msg !== 'Die vraag staat niet (meer) open.' || performance.now() - voteSentAt > STALE_MS) return false;
  pendingVote = null;
  if (app.s?.takeover && E.vote) fillVote(app.s);
  return true;
}

// ---------- flights ----------

let flyLayer;
function layer() {
  flyLayer ??= document.getElementById('fly');
  return flyLayer;
}

// The corner index scale a face shows (cards.css), for a flight from it.
const indexOf = card => getComputedStyle(card.querySelector('.card-svg')).getPropertyValue('--_index');

// FLIP flight of a card (or back) from a source rect to a target element.
// The card has the size and index of where it lands (a trick slot keeps the
// regular index); `index` (indexOf the card it leaves) tweens the index from
// the one it took off with, so the face never jumps.
function fly(code, from, target, { rotFrom = 0, flip = false, back = false, ms = 400, fade = false, index = '' } = {}) {
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
  el.style.setProperty('--card-index-max', getComputedStyle(target).getPropertyValue('--card-index-max'));
  el.style.left = to.left + 'px';
  el.style.top = to.top + 'px';
  layer().append(el);
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const sc = Math.max(0.2, from.width / w);
  const rotTo = code && !back ? tilt(code) : 0;
  const yFrom = flip ? ' rotateY(180deg)' : '';
  const timing = { duration: d, easing: EASE, fill: 'forwards' };
  const a = el.animate([
    { transform: `perspective(900px) translate(${dx}px, ${dy}px) rotate(${rotFrom}deg) scale(${sc})${yFrom}`, opacity: fade ? 0.4 : 1 },
    { transform: `perspective(900px) translate(0, 0) rotate(${rotTo}deg) scale(1)${flip ? ' rotateY(0deg)' : ''}`, opacity: 1 },
  ], timing);
  const end = index && indexOf(el);
  if (end && end !== index) el.querySelector('.card-svg').animate([{ '--_index': index }, { '--_index': end }], timing);
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
    case 'auction': return animAuction(ev, next);
    case 'contract': return animContract(ev, prev, next);
    case 'discard': return animDiscard(ev, prev, next);
    case 'trump': return animTrump(ev, next);
    case 'play': return animPlay(ev, prev, next);
    case 'trick': return animTrick(ev, next);
    case 'collect': return animCollect(ev, next);
    case 'handEnd': return animHandEnd(ev, next);
    case 'gameOver': sound.play(next.winner === -1 ? 'click' : next.winner === myScorer(next) ? 'win' : 'lose'); return;
    case 'join': case 'leave': case 'away': case 'back': case 'takeover': return seatToast(ev, prev, next);
    default: return;
  }
}

async function animDeal(ev, next) {
  heldTrick = null;
  pending = null;
  pendingAction = false;
  selected = '';
  picked = [];
  bidValue = 0;
  tip = '';
  dismissed = '';
  clear(E.fx);
  for (const pos of POS) clear(slots[pos]);
  const n = seatCount(next);
  const dealer = ev.dealer ?? next.dealer;
  talonHand = next.handNo;
  render(next, { dealing: true, backs: [0, 0, 0, 0] });
  if (!dur(100)) return;
  sound.play('shuffle');
  const src = seatRect(posOf(next, dealer));
  // Fit the packets into ~85% of the server's deal pause for this tempo:
  // 3-2-3 with four players; 3, the talon, 4, 3 with three; with two the
  // piles, the cards under them first.
  const rounds = n === 4 ? [3, 2, 3] : n === 3 ? [3, 4, 3] : [8, 8];
  const packets = rounds.length * n + (n === 3 ? 1 : 0);
  const pause = { rustig: 2000, normaal: 1500, snel: 900 }[next.opts?.tempo] ?? 1500;
  const stagger = Math.max(25, (pause * 0.85 - 420) / (packets - 1));
  const counts = [0, 0, 0, 0];
  const flights = [];
  let k = 0;
  await wait(100);
  rounds.forEach((size, round) => {
    for (let j = 0; j < n; j++) {
      const seat = (dealer + 1 + j) % n;
      const from = counts[seat];
      counts[seat] += size;
      flights.push(sleep(dur(k++ * stagger)).then(() => packet(src, seat, posOf(next, seat), from, size, next)));
    }
    if (n === 3 && round === 0) {
      flights.push(sleep(dur(k++ * stagger)).then(() => talonPacket(src)));
    }
  });
  await Promise.all(flights);
  if (n === 2) {
    render(next); // the piles, front rows face up
    sound.play('card');
    await flipIn([...E.hand.querySelectorAll('.pile.front .pile-top'), ...seats.top.piles.querySelectorAll('.pile.front .pile-top')]);
  }
}

// Three players: two closed cards to the middle of the table.
function talonPacket(src) {
  sound.play('deal');
  E.talon.hidden = false;
  const backs = [...E.talon.children];
  for (const b of backs) b.style.visibility = 'hidden';
  return Promise.all(backs.map((b, i) => sleep(dur(i * 30)).then(() => fly('', src, b, { back: true, ms: 320 })).then(() => {
    b.style.visibility = '';
  })));
}

// Turns face-up cards over as they appear.
function flipIn(els) {
  return Promise.all(els.map((el, i) => anim(el, [
    { transform: 'perspective(600px) rotateY(90deg)', opacity: 0.4 },
    { transform: 'perspective(600px) rotateY(0deg)', opacity: 1 },
  ], 320, { delay: i * 25 })));
}

function packet(src, seat, pos, from, n, s) {
  sound.play('deal');
  const jobs = [];
  if (seatCount(s) === 2) {
    // The cards fly to the empty places of the piles (see shownPiles).
    const root = pos === 'bottom' ? E.hand : seats[pos].piles;
    for (let i = 0; i < n; i++) {
      const target = root.querySelector(`.pile-${(from + i) % 8}`);
      if (target) jobs.push(sleep(dur(i * 25)).then(() => fly('', src, target, { back: true, ms: 300 })));
    }
    return Promise.all(jobs);
  }
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

// Three players: a bid ("90") or a pass at the seat.
async function animAuction(ev, next) {
  bubble(next, ev.seat, ev.bid > 0 ? String(ev.bid) : 'Pas', ev.bid > 0 ? 'go' : 'pass', 1800);
  sound.play(ev.bid > 0 ? 'trump' : 'click');
  await wait(ev.bid > 0 ? 350 : 450);
}

// Three players: the auction is over. A banner says who plays alone for
// how much, and the talon goes to that player (into our hand, if ours).
async function animContract(ev, prev, next) {
  const who = nameOf(next, ev.seat);
  const text = ev.forced ? `${who} moet spelen` : `${who} speelt alleen`;
  const ban = h('div', { class: 'banner ' + teamCls(next, ev.seat) },
    h('span', { class: 'banner-sym banner-bid', text: String(ev.bid) }),
    h('span', { class: 'banner-text' }, h('small', { text: ev.forced ? 'De anderen passen' : 'Het hoogste bod' }), h('b', { text })));
  E.fx.append(ban);
  sound.play('trump');
  const backs = [...E.talon.children];
  const from = backs.map(rectOf);
  talonHand = 0;
  render(next);
  const pos = posOf(next, ev.seat);
  if (dur(100) && from[0]?.width) {
    const talon = new Set(next.talon || []);
    await Promise.all(from.map((r, i) => {
      if (pos === 'bottom') {
        const code = [...talon][i];
        const el = code && handEls.get(code);
        if (el) return fly(code, r, el, { flip: true, ms: 480 });
      }
      return fly('', r, seats[pos].av, { back: true, ms: 480, fade: true });
    }));
  }
  await anim(ban, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1.06)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)', opacity: 1 }], 420);
  await wait(700);
  await anim(ban, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(-12px)' }], 260, { fill: 'forwards' });
  ban.remove();
}

// Three players: the soloist lays two cards away, face down.
async function animDiscard(ev, prev, next) {
  const pos = posOf(next, ev.seat);
  const gone = ev.seat === next.you ? (prev?.hand || []).filter(c => !(next.hand || []).includes(c)) : [];
  const from = gone.length ? gone.map(c => handEls.get(c)).filter(Boolean).map(rectOf) : [rectOf(seats[pos].av), rectOf(seats[pos].av)];
  picked = [];
  render(next);
  sound.play('card');
  const to = E.talon.getBoundingClientRect().width ? E.talon : E.trick;
  await Promise.all(from.map((r, i) => sleep(dur(i * 60)).then(() => fly('', r, to, { back: true, ms: 380, fade: true }))));
}

async function animBid(ev, next) {
  bubble(next, ev.seat, ev.play ? 'Ik speel!' : 'Pas', ev.play ? 'go' : 'pass', 1800);
  sound.play(ev.play ? 'trump' : 'click');
  await wait(ev.play ? 250 : 450);
}

async function animTrump(ev, next) {
  render(next);
  sound.play('trump');
  const two = seatCount(next) === 2;
  // Two players: the back rows turn over now.
  if (two) flipIn([...E.hand.querySelectorAll('.pile.back .pile-top'), ...seats.top.piles.querySelectorAll('.pile.back .pile-top')]);
  const who = nameOf(next, ev.seat);
  // Gedraaid: a "spelen" bid makes the turned suit trump.
  const text = seatCount(next) === 3 ? `${who} kiest` : ev.forced ? `${who} moest kiezen` : next.bids?.[ev.seat] === 1 ? `${who} speelt` : `${who} kiest`;
  const ban = h('div', { class: 'banner ' + teamCls(next, ev.seat) },
    h('span', { class: 'banner-sym' + (isRed(ev.suit) ? ' red' : ''), text: suitSym(ev.suit) }),
    h('span', { class: 'banner-text' }, h('small', { text }), h('b', { text: cap(`${suitName(ev.suit)} is troef`) })));
  E.fx.append(ban);
  anim(E.badge, [{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], 600, { delay: 500 });
  await anim(ban, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1.06)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)', opacity: 1 }], 420);
  await wait(800);
  await anim(ban, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(-12px)' }], 260, { fill: 'forwards' });
  ban.remove();
  if (!two) return;
  // The roem in each player's open cards counts for that player.
  for (const seat of [next.you, 1 - next.you]) {
    const items = next.openRoem?.[seat] || [];
    const total = roemTotal(items);
    if (!total) continue;
    sound.play('roem');
    roemBurst(items, total, isWij(next, seat), seat === next.you ? 'Jouw open kaarten' : `Open kaarten van ${nameOf(next, seat)}`);
    await wait(1400);
  }
}

async function animPlay(ev, prev, next) {
  const pos = posOf(next, ev.seat);
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
    const index = el ? indexOf(el) : '';
    if (el) el.style.visibility = 'hidden';
    sound.play('card');
    await fly(ev.card, from, slots[pos], { rotFrom: rot, ms: 380, index });
    return;
  }
  const S = seats[pos];
  let from;
  const openCard = (S.backs.classList.contains('open') && [...S.backs.children].find(c => c.dataset.card === ev.card)) ||
    S.piles.querySelector(`.card[data-card="${ev.card}"]`);
  if (openCard) {
    from = rectOf(openCard);
    openCard.style.visibility = 'hidden';
  } else {
    from = seatRect(pos);
    const n = Number(S.backs.dataset.n) || 0;
    if (n > 0) setBacks(S, n - 1);
  }
  sound.play('card');
  await fly(ev.card, from, slots[pos], { flip: !openCard, ms: 420, index: openCard ? indexOf(openCard) : '' });
}

async function animTrick(ev, next) {
  if (!next.trick?.cards?.length && next.lastTrick?.cards?.length === seatCount(next)) heldTrick = next.lastTrick;
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

function roemBurst(items, total, wij, who = '') {
  const names = items.map(r => ROEM_NAMES[r.kind] || r.kind).join(' + ');
  const el = h('div', { class: 'roem-burst ' + (wij ? 'wij' : 'zij') },
    h('b', { text: `+${total}` }), h('span', { text: `${names}!` }), who ? h('small', { text: who }) : null);
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
  const pos = posOf(next, ev.winner);
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
  const n = seatCount(next);
  const w = n === 4 ? next.you % 2 : n === 2 ? next.you : r.trumpBy === next.you ? 0 : 1;
  // Who: "Wij"/"Zij" with four; with two "Jij" or the other's name; with
  // three the soloist ("Jij" or the name) or the other two ("Wij", "De
  // anderen").
  const sideName = side => {
    if (n === 4) return side === w ? 'Wij' : 'Zij';
    if (n === 2) return side === w ? 'Jij' : nameOf(next, side);
    if (side === 0) return w === 0 ? 'Jij' : nameOf(next, r.trumpBy);
    return w === 1 ? 'Wij' : 'De anderen';
  };
  const verb = (side, one, many) => `${sideName(side)} ${n === 4 || (n === 3 && side === 1) ? many : one}`;
  if (r.pit) {
    sound.play('pit');
    await splash('Pit!', `${verb(r.pitTeam, 'haalt', 'halen')} alle slagen`, 'pit');
  } else if (r.nat) {
    sound.play('nat');
    await splash('Nat!', `${verb(r.playingTeam, 'gaat', 'gaan')} nat`, 'nat');
  } else {
    const mine = r.gains?.[myScorer(next)] ?? r.score[w];
    const best = Math.max(...(r.gains?.length ? r.gains : r.score));
    sound.play(mine >= best ? 'handWon' : 'handLost');
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
  // Whoever left a lobby seat is only in the previous state; a seat left
  // mid-game keeps the name, and an AI that takes it over is in the next.
  const p = ev.type === 'leave'
    ? prev?.players?.[ev.seat] || next.players?.[ev.seat]
    : next.players?.[ev.seat] || prev?.players?.[ev.seat];
  if (ev.seat === next.you) return;
  const name = p?.name || 'Een speler';
  const running = PLAYING.has(next.phase) || next.phase === 'handEnd';
  // The name of who left again: they may be back, or someone with the same name.
  const again = ev.type === 'join' && prev?.players?.[ev.seat]?.left && prev.players[ev.seat].name === name;
  if (ev.type === 'join') { sound.play('join'); toast(again ? `${name} doet weer mee` : `${name} doet mee`); }
  else if (ev.type === 'leave') toast(`${name} is vertrokken`, { sub: running ? 'Een AI-speler neemt de plaats pas in als iedereen akkoord is.' : '' });
  else if (ev.type === 'away') toast(`${name} is even weg`);
  else if (ev.type === 'back') toast(`${name} is terug`);
  // Everyone agreed: a bot in the seat of who left, or one that plays for
  // who dropped out until they are back.
  else if (ev.type === 'takeover') toast(p?.bot ? `${name} neemt het over` : `Een AI-speler speelt nu voor ${name}`);
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
  const pos = posOf(s, seat);
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
function sideBubbleWidth(S, pos) {
  const seat = S.root.getBoundingClientRect();
  const beside = shortLandscape();
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
  if (pendingAction && (next.turn !== next.you || next.phase !== actionPhase || (lost && performance.now() - actionAt > STUCK_MS))) {
    pendingAction = false;
    stageKey = '';
  }
  if (pendingVote) {
    const q = next.takeover;
    if (q?.seat !== pendingVote.seat || q.left !== pendingVote.left || next.players[next.you]?.vote === pendingVote.ai
      || (!ev && performance.now() - pendingVote.at > STUCK_MS)) pendingVote = null;
  }
}

// After a rejoin: tells the player when an AI played for them meanwhile,
// with the others' consent (design §6). A decision for our seat that we
// did not send can only be the AI's; what we sent just before the
// connection went may have been ours.
export function welcomeBack(prev, next) {
  const sent = rejoinSent;
  rejoinSent = null;
  if (!sent || !prev || prev.you !== next.you || !PLAYING.has(prev.phase)) return;
  // Laying away (three players) takes two cards out of the hand: we may
  // have sent that ourselves.
  if (sent.action && prev.phase === 'discard') return;
  const me = next.you;
  const ours = prev.hand.filter(c => c !== sent.card);
  const moved = next.handNo !== prev.handNo || !PLAYING.has(next.phase)
    ? ours.length > 0 // the hand went on without us
    : ours.some(c => !next.hand.includes(c))
      || (!sent.action && (prev.bids[me] !== next.bids[me] || (!prev.trump && next.trumpBy === me)));
  if (moved) toast('Een AI-speler speelde even voor je', { sub: 'De anderen waren akkoord. Nu speel je zelf weer.' });
}

// After a rejoin: forget everything sent but unanswered, so the resync
// that follows renders the table purely from the server's state.
export function resync() {
  talonHand = 0;
  rejoinSent = { card: pending?.card || '', action: pendingAction };
  pending = null;
  pendingAction = false;
  pendingVote = null;
  selected = '';
  stageKey = '';
  heldTrick = null;
  for (const pos of POS) clear(slots[pos]);
  for (const [, el] of handEls) el.style.visibility = '';
}

export function resetRoom() {
  app.view = null;
  talonHand = 0;
  E.hand.hidden = false;
  heldTrick = null;
  pending = null;
  pendingAction = false;
  pendingVote = null;
  rejoinSent = null;
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
