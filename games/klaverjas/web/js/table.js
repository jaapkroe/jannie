// The game table: top bar, seats, trick, centre stage, prompt and hand, plus
// the animation for every server event (deal, play, trick, collect, ...),
// and the table's overlays (score sheet, last trick, trump info, manual,
// hand summary, game over, Spelanalyse, replay, the AI's reasoning).
import { createCard, createBack, cardShort } from './cards.js';
import { sound } from './sound.js';
import {
  app, h, clear, prefs, savePrefs, toast, wait, dur, anim, sleep, EASE, seatCount, nameOf, suitSym, suitName, suitText, isRed,
  fillAvatar, countUp, icon, suitify, cap, playerName, shortLandscape, onKeyboard, chartBox,
} from './util.js';
import {
  POS, posOf, isWij, teamCls, teamName, mySide, scorerOrder, scorerName, myScorer, roemTotal, ROEM_NAMES, roemText,
  variantText, handHeadline, pointsText, rowMarks, playedBy, chartSpec,
  reviewVerdict, luckText, momentWhere, strongLine, missedLine, fineLine, outcomeLine, handSum, timeText, reviewHistory,
  MANUAL_SECTIONS,
} from './rules.js';
import * as panels from './panels.js';
import { openModal, byId, info, infoBtn, countdownRing, confetti, feedbackForm, focusMain } from './panels.js';

const E = {};             // fixed elements
const seats = {};         // pos → seat parts
const slots = {};         // pos → trick slot
const handEls = new Map(); // card code → element in the hand
let handOrder = [];       // codes in display order
let handW = 0;            // the hand's width and a card's as last laid out
let cardW = 0;            //   (measureHand); 0: measure at the next layout
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
let lessonRead = 0;       // training with lessons: the step we said we read (tipRead), until the next one shows
let lessonShown = 0;      // the step on screen, and when it appeared
let lessonAt = 0;
let spotEl = null;        // the part of the screen the lesson step is about
let drag = null;
let stageKey = '';

const PLAYING = new Set(['auction', 'discard', 'trump', 'bid', 'play']);
// The bids of the three-player auction
// (games/klaverjas/README.md#three-players-wikipedia-klaverjassen-met-drie-personen).
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
      E.coachMore = h('button', { class: 'coach-more', type: 'button', hidden: true, 'aria-expanded': 'false', onclick: toggleCoach }),
      E.coachMan = h('button', { class: 'coach-man', type: 'button', hidden: true, onclick: openCoachManual },
        icon('book'), E.coachManLbl = h('span')),
      E.coachGo = h('button', { class: 'coach-go', type: 'button', hidden: true, onclick: closeCoach },
        (E.coachRing = panels.countdownRing()).el, h('span', { text: 'Verder' }))),
    h('button', { class: 'coach-x', type: 'button', 'aria-label': 'Sluiten', onclick: closeCoach }, icon('close')));
  E.rule = h('div', { class: 'rule', 'aria-live': 'polite' });
  // The call buttons (call.js), right of the rule; on phones above the last trick.
  E.callDock = h('div', { class: 'call-dock', role: 'group', 'aria-label': 'Bellen', hidden: true });
  E.prompt = h('div', { class: 'prompt' }, seats.bottom.root, E.rule, ...panels.toolButtons(['last']), E.callDock, E.coach);
  E.hand = h('div', { class: 'hand', role: 'group', 'aria-label': 'Jouw kaarten' });
  E.table.append(E.prompt, E.hand);

  root.append(E.top, E.table);
  bindHand();
  root.addEventListener('click', tapAside);
  // The widths are read here, after layout, and kept: a render then fans
  // the hand without forcing a layout of its own.
  new ResizeObserver(() => { measureHand(); layoutHand(); }).observe(E.hand);
  new ResizeObserver(() => fitCoach()).observe(seats.left.ring); // larger with a video (call.js)
  addEventListener('resize', () => { handW = cardW = 0; fitCoach(); });
  onKeyboard(fitCoach); // the landscape layout comes or goes without a resize
  document.addEventListener('keydown', onKey);
}

function buildTopbar(bar) {
  // One part per score: Wij and Zij with four players, else every player
  // (see renderTop).
  E.pill = h('button', { class: 'score-pill', type: 'button', title: 'Scorebord: alle potjes en de stand', onclick: () => openScoreSheet() });
  E.segs = [];
  E.potje = h('div', { class: 'potje', title: 'Het hoeveelste potje van het spel' },
    h('span', { class: 'potje-lbl', text: 'Potje' }), h('span', { class: 'potje-n' }, E.potjeN = h('b', { text: '1' }), '/', E.potjeT = h('span', { text: '16' })));
  E.badge = h('button', { class: 'trump-badge', type: 'button', title: 'Troef: tik voor details over troef en spelvariant', onclick: () => openTrumpInfo() },
    E.badgeSym = h('span', { class: 'tb-sym', text: '?' }),
    E.badgeLbl = h('span', { class: 'tb-lbl', text: 'Troef' }),
    E.badgeCnt = h('span', { class: 'tb-cnt', hidden: true }));
  bar.append(E.pill, E.potje, E.badge, h('span', { class: 'spacer' }),
    ...panels.toolButtons(['expert', 'last', 'score', 'chat', 'help', 'settings', 'sound', 'menu']));
  E.expert = bar.querySelector('.tb-expert');
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
  renderCall();
}

// The call, once call.js is loaded: a seat's video in place of its face,
// or the mark of who is in the call, and the call buttons.
export function renderCall() {
  const s = app.view;
  if (!app.call || !s) return;
  app.call.dock(E.callDock);
  for (let seat = 0; seat < seatCount(s); seat++) app.call.decorate(seats[posOf(s, seat)].ring, seat);
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
  E.expert.hidden = !s.expert && !s.training; // the reasoning: expert mode and training
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
  // Training with lessons, the hand in which the learner counts trumps:
  // how many the others still hold.
  const left = known ? s.trumpsLeft ?? null : null;
  E.badgeCnt.hidden = left === null;
  E.badgeCnt.textContent = left ?? '';
  E.badge.title = known
    ? `Troef is ${suitName(s.trump)}, gekozen door ${nameOf(s, s.trumpBy, false)}.` +
      (left === null ? '' : left === 0 ? ' De anderen hebben geen troef meer.' : ` De anderen hebben nog ${left} ${left === 1 ? 'troef' : 'troeven'}.`) + ' Tik voor details.'
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
  return `Jij komt uit. ${we} daarna meer dan de helft van de punten halen.${n === 2 ? ' Na de troefkeuze gaan de achterste kaarten open.' : ''}`;
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
// all agree does one (docs/server.md#takeover-consent). The answer can be
// changed while the question is open; above the buttons, who agrees so
// far. Once answered, the panel keeps to its title, who agrees and the
// answers, so it covers less of the table while the others think. The
// buttons are last: at the foot of the stage they stay put when the text
// above them changes.
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
// (that no still holds, docs/server.md#takeover-consent).
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

  // A lesson step goes before the hint: on our turn the hint follows it.
  const lesson = s.lesson?.text || '';
  if (s.lesson?.n !== lessonRead) lessonRead = 0;
  if (lesson && s.lesson.n !== lessonShown) {
    lessonShown = s.lesson.n;
    lessonAt = performance.now();
  }
  const key = !lesson && s.hint?.text && PLAYING.has(s.phase) && my ? JSON.stringify(s.hint) : '';
  if (dismissed !== key) dismissed = ''; // a new hint shows again
  const hint = key && !dismissed ? s.hint.text : '';
  const show = lesson || hint || tip;
  E.coach.hidden = !show;
  // Trump and bid hints are in the panel; only short landscape screens,
  // where the coach sits in a free corner, keep the bubble (see klaverjas.css).
  E.coach.classList.toggle('on-stage', !!hint && s.phase !== 'play');
  // The last trick of a hand waits for its explanation to be read, with a
  // countdown; a lesson step waits for Verder without one.
  const reading = !lesson && !hint && !!tip && readingTip(s);
  E.coachGo.hidden = !reading && !lesson;
  E.coachGo.classList.toggle('no-ring', !!lesson);
  E.coachRing.el.toggleAttribute('hidden', !reading);
  E.coachRing.set(reading ? s.nextAt : 0);
  if (show) {
    E.coach.classList.toggle('is-tip', !hint);
    E.coachIcon.textContent = hint ? '💡' : '👩‍🏫';
    E.coachLbl.textContent = lesson ? '' : hint ? 'Tip ' : 'Uitleg ';
    if (E.coachText.dataset.text !== show) {
      E.coachText.dataset.text = show;
      E.coachText.replaceChildren(suitify(show));
      E.coach.classList.remove('open'); // a new text starts short again
      if (lesson) anim(E.coachTxt, [{ opacity: 0.2 }, { opacity: 1 }], 220); // the next step, not the same one
    }
  }
  // A lesson step may point to a section of the manual.
  const man = lesson ? MANUAL_SECTIONS.find(x => x.id === s.lesson.manual) : null;
  E.coachMan.hidden = !man;
  if (man) {
    E.coachMan.dataset.id = man.id;
    E.coachManLbl.textContent = 'Handleiding: ' + man.title;
  }
  fitCoach();
  spotlight(s);
}

// Training with lessons: the part of the screen the step on screen is about
// (lesson spot, games/klaverjas/README.md#lessons-on-screen) lights up.
function spotlight(s) {
  const el = s.lesson?.spot ? spotTarget(s, s.lesson.spot) : null;
  if (el !== spotEl) spotEl?.classList.remove('spot');
  spotEl = el;
  el?.classList.add('spot'); // again: renderTop and renderPrompt set the classes of theirs anew
}

function spotTarget(s, spot) {
  switch (spot) {
    case 'partner': return seats[posOf(s, (s.you + 2) % seatCount(s))]?.root.querySelector('.seat-id');
    case 'hand': return E.hand;
    case 'trick': return E.trick;
    case 'trump': return E.badge;
    case 'score': return E.pill;
    case 'rule': return E.rule;
    case 'card': return handEls.get(s.lesson.card) || null; // a card to signal with
    case 'chat': {
      // On wide screens the chat is a side panel, without a button.
      const b = E.top.querySelector('.tb-chat');
      return b?.offsetParent ? b : document.getElementById('chat');
    }
  }
  return null;
}

// The lesson step on screen. An animation shows the next state (a trick
// with its explanation) before it becomes app.s.
const shownLesson = () => app.view?.lesson || null;

// Says we read the lesson step on screen: the server shows the next one,
// or the game goes on. Once per step, however often it is tapped, and not
// in its first moment: the second tap of a double tap, or a tap meant for
// the card that completed the trick, would skip it unread.
const LESSON_SETTLE_MS = 450;
function readLesson() {
  const n = shownLesson()?.n;
  if (!n || lessonRead === n || performance.now() - lessonAt < LESSON_SETTLE_MS) return;
  lessonRead = n;
  sound.play('click');
  app.send({ t: 'tipRead', n });
}

// On a short landscape screen the coach sits in the top-left corner, above
// the left seat: the player after you, whose turn ring must stay in view.
// A text too long for that room shows the lines that fit and "Lees verder";
// opened on purpose, it may cover the seat until "Minder" or ✕. The
// explanation of a hand's last trick shows in full: nobody plays after it.
function fitCoach() {
  E.coach.style.removeProperty('--coach-lines');
  if (!shortLandscape()) E.coach.classList.remove('open'); // turned upright
  const open = E.coach.classList.contains('open');
  let clamped = false;
  if (shortLandscape() && !E.coach.hidden && !open && E.coachGo.hidden) {
    E.coach.classList.remove('clamped');
    E.coachMore.hidden = true; // measured without it: it goes over the last line
    const over = coachBottom() - (ringTop(seats.left.ring) - COACH_GAP);
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

// The top of a ring, or of a mark above it (a ring with a video has its
// marks outside it). A hidden ring (two players: no left seat) gives 0,
// which keeps the coach to two lines.
function ringTop(ring) {
  const tops = [ring, ...ring.children].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect().top);
  return tops.length ? Math.min(...tops) : 0;
}

// The coach's bottom edge as laid out, without its rise-in animation.
function coachBottom() {
  const par = E.coach.offsetParent;
  if (!par) return E.coach.getBoundingClientRect().bottom;
  return par.getBoundingClientRect().top + par.clientTop + E.coach.offsetTop + E.coach.offsetHeight;
}

// The manual from a lesson step. The link gives up focus first: closing
// the manual would give it back, and Enter would open it again instead of
// going on.
function openCoachManual() {
  E.coachMan.blur();
  openManual(E.coachMan.dataset.id);
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
  if (shownLesson()) return readLesson();
  if (s?.hint?.text && !E.coach.classList.contains('is-tip')) dismissed = JSON.stringify(s.hint);
  else if (tip && s && readingTip(s)) app.send({ t: 'tipRead' }); // read: on to the summary
  tip = '';
  if (s) renderPrompt(s);
}

// Training: the last trick of a hand stays on the table until its
// explanation is read (Verder, ✕) or nextAt has come.
function readingTip(s) {
  return !!(s.training && s.phase === 'play' && s.nextAt);
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
    el.classList.toggle('hint', playing && !s.lesson && s.hint?.card === c);
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

function measureHand() {
  handW = E.hand.clientWidth;
  cardW = handEls.get(handOrder[0])?.offsetWidth || 0; // no card: measured with the next one
}

// Fans the hand so it always fits the available width.
function layoutHand() {
  const n = handOrder.length;
  if (!n || E.hand.classList.contains('tableau')) return;
  const els = handOrder.map(c => handEls.get(c));
  if (!handW || !cardW) measureHand();
  const W = handW;
  const cw = cardW || 64;
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
  if (shownLesson() && app.view.turn < 0) return readLesson(); // the game waits for the lesson: any tap goes on
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

// A tap beside the hand (the felt, a seat, the trick; not a button) puts a
// lifted card down again, or else goes on from a lesson step. Clicks in
// the hand are its own: with the pointer captured, a tap on a card may
// arrive as a click on the hand.
function tapAside(e) {
  const s = app.s;
  if (!s || E.hand.contains(e.target) || e.target.closest?.('button, a, input, textarea, select, label')) return;
  if (selected) {
    selected = '';
    renderHand(s);
    renderPrompt(s);
  } else if (shownLesson()) readLesson();
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
  if ((e.key === 'Enter' || e.key === ' ') && shownLesson() && !selected) {
    e.preventDefault();
    readLesson();
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && tip && readingTip(s)) {
    e.preventDefault();
    closeCoach();
    return;
  }
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
// table sideways towards the middle (klaverjas.css). Either way the bubble
// stops short of the trick slot in its path (the partner's card above, or
// the side seat's own card), so it does not cover the trick. '' leaves the
// CSS maximum.
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
// with the others' consent (docs/server.md#takeover-consent). A decision
// for our seat that we did not send can only be the AI's; what we sent
// just before the connection went may have been ours.
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
  lessonRead = lessonShown = 0;
  spotEl?.classList.remove('spot');
  spotEl = null;
  stageKey = '';
  waitingBubbles = [];
  for (const pos of POS) endBubble(seats[pos]);
  clear(E.fx);
  for (const pos of POS) clear(slots[pos]);
  for (const [, el] of handEls) el.remove();
  handEls.clear();
  handOrder = [];
}

export function relayout() {
  measureHand();
  layoutHand();
}

// ---------- overlays ----------
// The table's own overlays live with the table, not in the shell's
// panels.js, so another game's site loads none of them.

// ---------- mini cards and trick review ----------

function mini(code, cls = '') {
  const c = createCard(code, { size: 'sm' });
  if (cls) c.classList.add(cls);
  return c;
}

// One trick of finished hand `hand`: the cards in play order (the first
// came out), each underlined in its team's colour. Tapping it shows who
// played what at the seats, as for the last trick.
function trickTile(s, t, i, owner, hand) {
  const wij = isWij(s, t.winner);
  const roem = roemTotal(t.roem);
  const what = `Slag ${i + 1}: ${nameOf(s, t.winner)} nam de slag${roem ? `, roem: ${roemText(t.roem)}` : ''}`;
  return h('button', {
    class: 'mt ' + (wij ? 'wij' : 'zij'), type: 'button', title: `${what}. Tik om te zien wie wat speelde.`, 'aria-label': what,
    onclick: () => openTrick(s, t, i, owner, hand),
  },
    h('span', { class: 'mt-n', text: i + 1 }),
    h('span', { class: 'mt-cards' }, t.cards.map(pc => {
      const c = mini(pc.card, pc.seat === t.winner ? 'winner' : '');
      c.dataset.team = teamCls(s, pc.seat);
      return c;
    })),
    h('span', { class: 'mt-pts' }, h('b', { text: t.points ?? '' }), roem ? h('i', { text: `+${roem}` }) : null));
}

function review(s, tricks, owner, hand) {
  return h('div', { class: 'review' }, (tricks || []).map((t, i) => trickTile(s, t, i, owner, hand)));
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

function openTrick(s, t, i, owner, hand) {
  sound.play('click');
  const m = openModal({ id: 'trick', title: `Slag ${i + 1}`, cls: 'm-last', body: [...trickCross(s, t), replayButton(hand, i + 1)] });
  m.owner = owner;
}

// Under a trick of finished hand `hand`, at a table of four: the button that
// opens that hand in the replay, just before the player's card in the
// trick. The server sends the hand (handReview); until then the button
// says it is loading. A reconnect asks again (onReconnect).
let handWait = null; // {hand, trick, btn, done}: the tap waiting for its hand
function replayButton(hand, trick) {
  const s = app.s;
  if (!s || seatCount(s) !== 4 || !s.scores?.some(r => r.hand === hand)) return null;
  const label = () => [icon('history'), 'Dit potje terugkijken'];
  const btn = h('button', {
    class: 'btn btn-ghost btn-block last-replay', type: 'button', onclick: () => {
      sound.play('click');
      handWait?.done();
      btn.disabled = true;
      btn.replaceChildren('Laden…');
      const w = handWait = { hand, trick, btn, done: () => { btn.disabled = false; btn.replaceChildren(...label()); } };
      w.sent = app.send({ t: 'handReview', hand }); // false: queued until the connection is back
    },
  }, label());
  return btn;
}

// ---------- score sheet ----------

export function openScoreSheet() {
  const s = app.s;
  if (!s) return;
  sound.play('click');
  const m = openModal({ id: 'score', title: 'Scorebord', cls: 'm-score', body: [] });
  m.view = 'score';
  // The course of the match under the table (chartSpec in rules.js). An
  // update replaces the table only: the chart stays in the page, with its
  // tooltip and focus.
  const chart = chartBox({ title: 'Verloop' });
  let table = null;
  // Runs on every update; the review of a hand stays put until "Terug".
  m.refresh = () => {
    if (m.view !== 'score') return;
    m.titleEl.textContent = 'Scorebord';
    const next = scoreBody(app.s, m);
    if (table?.parentNode === m.body) table.replaceWith(next);
    else m.body.replaceChildren(next, chart);
    table = next;
    chart.set(chartSpec(app.s));
  };
  m.refresh();
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
    review(asInHand(s, res), s.prevHand.tricks, 'score', r.hand),
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

// Once a hand is over, its last trick also opens the hand in the replay.
export function openLastTrick() {
  const s = app.s;
  if (!s) return;
  const t = s.lastTrick;
  if (!t?.cards?.length) { toast('Er is nog geen slag gespeeld'); return; }
  sound.play('click');
  const over = s.phase === 'handEnd' || s.phase === 'gameOver';
  openModal({ id: 'last', title: 'Laatste slag', cls: 'm-last', body: [...trickCross(s, t), over ? replayButton(s.scores?.at(-1)?.hand, 8) : null] });
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


// ---------- manual ----------

// The manual (manual.js, loaded when first opened) at section tab, else at
// the one last read.
export function openManual(tab) {
  sound.play('click');
  import('./manual.js').then(m => showManual(m, tab),
    () => toast('Laden lukte niet', { sub: 'Controleer je internet en probeer het nog eens.', kind: 'error' }));
}

function showManual({ SECTIONS, renderManual }, tab) {
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


// ---------- hand summary ----------

// The overlays after an update. A new deal closes the sheet of the AI's
// reasoning (it is about the hand before). A hand looked back at (replay
// owner 'hand') stays open through the next hand, until the lobby or a new
// match; the review's replay belongs to game over.
export function sync(s, ev) {
  if (s.phase === 'handEnd') showSummary(s, ev);
  else {
    byId('summary')?.close(true);
    if (byId('trick')?.owner === 'summary') byId('trick').close(true);
  }
  if (ev?.type === 'deal') {
    byId('why')?.close(true);
    expertJs?.onDeal();
  }
  const rp = byId('replay');
  if (s.phase === 'gameOver') {
    showGameOver(s, ev);
    rp?.refresh(s);
  } else {
    byId('over')?.close(true);
    byId('review')?.close(true);
    if (rp?.owner === 'review' || s.phase === 'lobby' || (ev?.type === 'deal' && !s.scores?.length)) rp?.close(true);
    else rp?.refresh(s);
  }
  if (s.phase === 'lobby') { byId('score')?.close(true); byId('last')?.close(true); byId('trick')?.close(true); }
  byId('score')?.refresh?.();
}

// A passive overlay (hand summary, game over) comes up: the sheet of the
// AI's reasoning closes (the top-bar button opens it again over it), and a
// hand open in the replay stays on top of it.
function overlayUp(m) {
  byId('why')?.close(true);
  byId('replay')?.root.before(m.root);
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
          review(asInHand(s, r), tricks, 'summary', s.handNo)) : null,
        h('div', { class: 'sum-foot' }, go, ready),
      ],
    });
    overlayUp(m);
    m.go = go;
    m.ready = ready;
    m.ring = ring;
    m.onRemove = () => ring.set(0); // stops the countdown once the fade-out is over
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
    'Gehaald: ieder krijgt wat hij haalde, en de andere twee delen hun punten, ieder de helft. Nat: wie alleen speelde, krijgt niets en de andere twee delen alle 162 punten en alle roem.',
  ]), ' Weggelegd: ', suitify(r.discards.map(c => cardShort(c)).join(' ')), ` (${pts} ${pts === 1 ? 'punt' : 'punten'}).`);
}

// Card points (games/klaverjas/README.md#cards), for the discards.
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
  const setup = h('button', { class: 'btn btn-ghost btn-block btn-setup', type: 'button', hidden: !host || s.training || s.expert, onclick: () => send('lobby') },
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
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => openScoreSheet() }, icon('score'), 'Scorebord'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => app.leave() }, icon('leave'), 'Naar start'))),
    ],
  });
  m.refresh = st => {
    const hst = st.host === st.you;
    again.disabled = !hst || sent;
    again.textContent = label(hst);
    setup.hidden = !hst || st.training || st.expert;
    setup.disabled = sent;
    reviewLine(rv, st.review);
    m.root.classList.toggle('with-review', !!st.review);
  };
  m.root.classList.toggle('with-review', !!s.review);
  m.reset = () => {
    sent = false;
    if (app.s) m.refresh(app.s);
  };
  overlayUp(m);
  if (won && ev?.type === 'gameOver') confetti(m.root);
  if (host) focusMain(again);
}

// ---------- spelanalyse ----------

// What the review counts as points left and as a strong move (the
// Spelanalyse, and the line over a hand in the replay).
const LOST_INFO = 'Laten liggen: wat een betere keuze gemiddeld meer had opgeleverd. Verschillen van minder dan 5 punten, of binnen de onzekerheid van de berekening, tellen niet mee.';
const STRONG_INFO = 'Sterke zet: de beste keuze, terwijl de voor de hand liggende keuze minstens 10 punten minder opleverde.';

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

// The review (games/klaverjas/README.md#spelanalyse): numbers and facts
// about the player's own play, for them alone, as Juf Jannie (the engine
// of the hints) sees it.
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
        class: 'rv-moment', type: 'button', disabled: !r.replay?.some(x => x.hand === m.hand),
        title: 'Tik om dit potje terug te kijken', onclick: () => openReplay(s, { hands: r.replay, moment: m, owner: 'review' }),
      }, h('span', { class: 'rv-where', text: momentWhere(m) }), line(m),
      h('span', { class: 'rv-sum' }, suitify(outcomeLine(m))), icon('forward')))))) : null);
  const sp = r.speed;
  openModal({
    id: 'review', title: 'Jouw spelanalyse', cls: 'm-review', body: [
      h('div', { class: 'rv-head' },
        h('small', { class: 'rv-who', text: 'Volgens Juf Jannie' }),
        h('div', { class: 'rv-pct' }, h('b', { text: `${r.pct}%` }), h('span', { text: `(${reviewVerdict(r.pct)})` }), infoBtn('Spelanalyse', [
          'Juf Jannie is de game-engine van dit spel: dezelfde die de AI-spelers laat spelen en bij Oefenen de tips geeft. Dit is haar berekening, met alleen wat jij op dat moment wist.',
          'Bij elke keuze speelt ze het potje honderden keren uit, voor elke kaart, troefkleur of elk bod dat je kon kiezen, telkens met een andere verdeling van de kaarten die je niet kon zien. Wat een keuze gemiddeld oplevert, is haar waarde.',
          'Punten zijn het verschil tussen de score van jullie koppel en die van de tegenstanders aan het eind van het potje. Een punt dat naar de tegenstanders gaat in plaats van naar jullie, telt dus twee keer. Gaat een potje nat, dan krijgen de tegenstanders alle punten: een keuze die de kans op nat groter maakt, kost gemiddeld veel, ook als de kaart zelf weinig punten waard is.',
          'Het blijft een schatting: Juf Jannie speelt de rest van het potje met eenvoudige regels uit.',
          'Het percentage zegt hoeveel van de punten die met je keuzes te winnen waren, je ook haalde. Je kaarten tellen niet mee: ook met slechte kaarten kun je 100% halen.',
          LOST_INFO,
          STRONG_INFO,
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
            'De tijd van het moment dat je aan de beurt was tot je kaart, troefkeuze of bod. Je ziet de middelste van je tijden: de helft van je zetten ging sneller, de helft langzamer. Zo telt één lange pauze niet zwaar mee.',
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
      r.replay?.length ? h('button', { class: 'btn btn-ghost btn-block rv-replay', type: 'button', onclick: () => openReplay(s, { hands: r.replay, owner: 'review' }) },
        icon('history'), 'Potjes terugkijken') : null,
      prev.length ? h('p', { class: 'rv-prev' }, 'Vorige partijen ', h('b', { text: prev.map(p => `${p}%`).join(' · ') })) : null,
      h('p', { class: 'legend', text: 'Disclaimer: dit is slechts de mening van Juf Jannie.' }),
      h('section', { class: 'rv-sec' }, h('h3', {}, 'Opmerkingen'),
        feedbackForm(() => ({}), 'Opmerking over dit spel of de analyse'),
        h('p', { class: 'legend', text: 'Je opmerking wordt met je naam bewaard, net als de partij zelf: hooguit 12 maanden, voor statistieken en om het spel te verbeteren.' })),
    ],
  });
}

// ---------- replay ----------

// The replay (games/klaverjas/README.md#terugkijken): a finished hand card
// by card with every hand open, and at each graded decision of the player
// what Juf Jannie thinks of it (the hand's choices). hands are the hands
// to step through: one hand from handReview (owner 'hand'; pending: its
// grades still out), or every hand of the review at game over (owner
// 'review'). It starts at the first hand's deal, at {hand, step}, or just
// before the player's card of a moment {hand, trick} (at the deal for a
// trump choice or bid). A step is the number of cards played: at 4 × n
// trick n lies complete.
export function openReplay(s, { hands, moment = null, owner = 'review' }) {
  if (!hands?.length) return null;
  sound.play('click');
  const seats = [0, 1, 2, 3].map(k => (s.you + k) % 4);
  const cardsOf = rh => rh.tricks.flatMap(t => t.cards);
  const indexOf = n => Math.max(0, hands.findIndex(x => x.hand === n));
  // The step just before the player's card in trick d.trick of hand rh:
  // for a lead the trick before still lies complete; the deal (0) for a
  // trump choice or bid.
  const before = (rh, d) => {
    const t = d.trick ? rh?.tricks[d.trick - 1] : null;
    return t ? 4 * (d.trick - 1) + Math.max(0, t.cards.findIndex(pc => pc.seat === s.you)) : 0;
  };
  let hand = indexOf(moment?.hand);
  let step = moment ? before(hands[hand], moment) : 0;
  const m = openModal({ id: 'replay', title: 'Terugkijken', cls: 'm-replay', body: [] });
  m.owner = owner;
  // A hand looked back at during the next one: your turn at the table. To
  // the table closes the views that led here too, top down, so the focus
  // goes back to the table. The text comes a frame after the line shows,
  // so a screen reader announces it.
  const turnText = h('span');
  const turn = h('p', { class: 'rp-turn', role: 'status', hidden: true }, turnText,
    h('button', {
      class: 'btn btn-sm', type: 'button', onclick: () => {
        m.close();
        for (const id of ['trick', 'last', 'score']) byId(id)?.close();
      },
    }, 'Naar tafel'));
  m.body.before(turn);
  const showTurn = () => {
    const on = s.turn === s.you && PLAYING.has(s.phase);
    if (on === !turn.hidden) return;
    turn.hidden = !on;
    turnText.textContent = '';
    if (on) requestAnimationFrame(() => { turnText.textContent = 'Aan tafel ben je aan de beurt.'; });
  };
  showTurn();
  // A later state: the turn at the table, and at game over the review's
  // hands again.
  m.refresh = st => {
    s = st;
    showTurn();
    if (owner !== 'review' || !st.review?.replay?.length) return;
    const shown = hands[hand].hand;
    hands = st.review.replay;
    hand = indexOf(shown);
    redraw();
  };
  // A fresh handReview of a hand shown: its grades so far.
  m.update = rh => {
    if (!hands.some(x => x.hand === rh.hand)) return;
    hands = hands.map(x => (x.hand === rh.hand ? rh : x));
    redraw();
  };
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
  const redraw = () => go(hand, step);
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
    const next = step < n ? played[step].seat : -1;
    const trump = row ? { suit: row.trump, by: row.trumpBy } : null;
    // The player's graded decisions at this step (at the deal maybe a bid,
    // a trump choice and the lead of the first trick), else the latest one
    // before it.
    const choices = rh.choices || [];
    const now = choices.filter(d => before(rh, d) === step);
    const last = now.length ? null : choices.filter(d => before(rh, d) < step).at(-1);
    // The player's card and the option it is measured against, marked in
    // their hand at the decision itself: the stronger of the two in gold.
    // A card that lost and gained nothing is not marked.
    const mo = now.find(d => d.played?.card && (d.better || d.points > 0));
    const playedCls = mo?.better ? 'rp-played' : 'rp-better';
    const alt = mo && (mo.better || mo.alt);
    const marks = new Map();
    if (mo) marks.set(mo.played.card, playedCls);
    if (alt?.card) marks.set(alt.card, mo.better ? 'rp-better' : 'rp-alt');

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

    // A graded decision as in the review: points left, a strong move, or
    // neither; away from it, a button back to it.
    const rated = d => d.better || d.points > 0;
    const choice = (d, here) => h('div', { class: 'rp-moment' + (here ? ' now' : '') },
      h('span', { class: 'rv-where', text: momentWhere({ hand: rh.hand, trick: d.trick }) }),
      h('span', { class: 'rv-text' }, suitify(d.better ? missedLine(d) : d.points > 0 ? Object.values(strongLine(d)).join('') : fineLine(d))),
      rated(d) ? h('span', { class: 'rv-sum' }, suitify(outcomeLine(d))) : null,
      here ? null : h('button', { class: 'btn btn-ghost btn-sm', type: 'button', dataset: { key: 'choice' }, onclick: () => go(hand, before(rh, d)) }, 'Naar deze keuze'));
    const box = now.length ? now.map(d => choice(d, true)) : last ? [choice(last, false)] : [];
    const sum = handSum(choices, rh.pending);
    const hand4 = seat => h('div', { class: 'rp-hand ' + teamCls(s, seat) + (seat === next && !complete ? ' turn' : '') },
      playerName(nameOf(s, seat), { cls: 'rp-name', title: true }),
      h('div', { class: 'rp-cards' }, rh.cards[seat].filter(c => !gone.has(c)).map(c => mini(c, marks.get(c) || ''))));
    // replaceChildren would show a null as text.
    m.body.replaceChildren(...[
      h('div', { class: 'rp-head' },
        h('button', { class: 'icon-btn', type: 'button', dataset: { key: 'hand-prev' }, 'aria-label': 'Vorig potje', title: 'Vorig potje', disabled: hand === 0, onclick: () => go(hand - 1, 0) }, icon('back')),
        h('div', { class: 'rp-title' }, h('b', { text: `Potje ${rh.hand} van ${s.hands}` }),
          trump ? h('small', {}, suitify(`${suitSym(trump.suit)} troef · ${nameOf(s, trump.by)} speelt`)) : null),
        h('button', { class: 'icon-btn', type: 'button', dataset: { key: 'hand-next' }, 'aria-label': 'Volgend potje', title: 'Volgend potje', disabled: hand === hands.length - 1, onclick: () => go(hand + 1, 0) }, icon('forward')),
        sum ? h('p', { class: 'rp-sum' }, sum, infoBtn('Volgens Juf Jannie', [LOST_INFO, STRONG_INFO])) : null),
      h('div', { class: 'rp-table' },
        cross,
        what,
        h('p', { class: 'rp-stand' }, step === 32 && row
          ? `Uitslag: Wij ${row.score[wij]} – Zij ${row.score[1 - wij]}` + (row.nat ? ` · ${row.playingTeam === wij ? 'Wij' : 'Zij'} nat` : row.pit ? ' · pit' : '')
          : `Stand in dit potje: Wij ${stand[wij]} – Zij ${stand[1 - wij]}`)),
      // Under the table, so the table stays put as the box changes.
      box.length ? h('div', { class: 'rp-choices' }, box) : null,
      h('div', { class: 'rp-hands' },
        hand4(s.you),
        mo && marks.size ? h('p', { class: 'rp-legend' },
          h('span', {}, h('span', { class: 'rp-key ' + playedCls }), suitify(`${cardShort(mo.played.card)} gespeeld`)),
          alt?.card ? h('span', {}, h('span', { class: 'rp-key ' + (mo.better ? 'rp-better' : 'rp-alt') }),
            suitify(`${cardShort(alt.card)} ${mo.better ? 'beter volgens Juf Jannie' : 'voor de hand liggend'}`)) : null) : null,
        seats.slice(1).map(hand4)),
      h('p', { class: 'legend', text: 'Alle kaarten liggen open. Bij een keuze zag de speler alleen de eigen kaarten en wat er gespeeld was.' }),
    ].filter(Boolean));
    // The player's card in a trick that lost points has a light dot, a
    // strong one a gold dot.
    const dot = d => (d?.better ? 'missed' : d?.points > 0 ? 'strong' : '');
    bar.replaceChildren(
      h('div', { class: 'rp-steps' },
        h('button', { class: 'btn btn-ghost', type: 'button', dataset: { key: 'prev' }, 'aria-label': 'Een kaart terug', title: 'Een kaart terug (←)', disabled: step === 0, onclick: () => go(hand, step - 1) }, icon('back')),
        h('span', { class: 'rp-pos', text: step === 0 ? 'Voor de eerste kaart' : `Slag ${ti + 1} · ${shown.length} van 4 kaarten` }),
        h('button', { class: 'btn btn-ghost', type: 'button', dataset: { key: 'next' }, 'aria-label': 'Een kaart verder', title: 'Een kaart verder (→)', disabled: step === n, onclick: () => go(hand, step + 1) }, icon('forward'))),
      h('div', { class: 'rp-tricks', role: 'group', 'aria-label': 'Slagen' }, rh.tricks.map((t, k) => {
        const d = dot(choices.find(x => x.trick === k + 1));
        const note = d === 'missed' ? ', punten laten liggen' : d === 'strong' ? ', sterke zet' : '';
        return h('button', {
          class: 'rp-tn ' + teamCls(s, t.winner) + (d ? ' ' + d : '') + (k === ti ? ' on' : ''), type: 'button', dataset: { key: `t${k}` },
          'aria-label': `Slag ${k + 1}${note}`, title: `Slag ${k + 1}: ${nameOf(s, t.winner)} nam de slag${note}`,
          onclick: () => go(hand, Math.min(4 * (k + 1), n)),
        }, String(k + 1));
      })));
  }
  render();
  return m;
}

// A hand from the server (handReview): opened in the replay for the tap
// that asked for it, while that tap's trick is still open; else the grades
// so far for the hand the replay shows.
export function onHandReview(msg) {
  const rh = { ...msg.replay, pending: msg.pending };
  const w = handWait;
  if (w?.hand === msg.hand) {
    handWait = null;
    w.done();
    if (w.btn.closest('.modal.open') && app.s) {
      openReplay(app.s, { hands: [rh], moment: { hand: msg.hand, trick: w.trick }, owner: 'hand' });
      return;
    }
  }
  const rp = byId('replay');
  if (rp?.owner === 'hand') rp.update(rh);
}

// The sheet Redenering van de AI (expert.js, loaded when first needed; the
// expert mode and training); sync tells it about every new deal,
// onReconnect about a new connection, whyError about a refusal.
let expertJs = null;
export function openWhy() {
  import('./expert.js').then(x => { expertJs = x; x.openWhy(); })
    .catch(() => toast('Laden lukte niet', { sub: 'Controleer je internet en probeer het nog eens.', kind: 'error' }));
}

// The server refused something: a question to the AI still out is given up.
export function whyError() { expertJs?.onError(); }

// The server refused something: a rematch in flight can be tried again,
// and so can a hand to look back at (the shell's panels.onError frees
// feedback; whyError a question to the AI).
export function overlayError() {
  byId('over')?.reset?.();
  handWait?.done();
  handWait = null;
}

// The connection is back (see the shell's panels.onReconnect): a hand asked
// over the old connection is asked again, while its trick view is open (a
// second answer only refreshes the replay). The expert's question likewise.
export function overlayReconnect() {
  expertJs?.onReconnect();
  const w = handWait;
  if (!w) return;
  if (!w.sent) {
    w.sent = true;
    return;
  }
  if (w.btn.closest('.modal.open')) {
    app.send({ t: 'handReview', hand: w.hand });
    return;
  }
  handWait = null;
  w.done();
}
