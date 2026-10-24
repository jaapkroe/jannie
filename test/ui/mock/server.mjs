#!/usr/bin/env node
// Mock klaverjas server for frontend development and UI tests: serves web/
// (with the /ABCD → index.html rule) and speaks the websocket protocol of
// docs/design.md §7 with a compact rules engine and simple bots, for tables
// of four only (opts.players other than 4 is ignored).
//
//   node test/ui/mock/server.mjs [--port 18100] [--scale 1] [--fast] [--rig] [--seed N]
//
// --scale multiplies the real server's pauses (default 1, as in design §6);
// --fast is --scale 0.15. The hand summary always uses the full pause.
//
// As the server, it never lets an AI play a person's seat unasked: the game
// waits on whoever left or lost the connection, and asks everyone else
// (state takeover, message vote) until all agree. With only bots left, the
// game pauses.
//
// --rig makes the first hand of every room deterministic: seat 0 is voorhand
// and holds KH AH TH 9H 8H AS TS AC; leading KH with hearts as trump gives a
// trick with driekaart + stuk (40 roem). In gedraaid the turned suit is hearts.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i < 0 ? def : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const PORT = Number(arg('port', 18100));
const SCALE = arg('fast', false) ? 0.15 : Number(arg('scale', 1));
const RIG = !!arg('rig', false);
let seed = Number(arg('seed', Date.now() % 100000));
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web');

// ---------- deterministic rng ----------

function rand() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = a => a[Math.floor(rand() * a.length)];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- rules ----------

const SUITS = ['C', 'D', 'H', 'S'];
const RANKS = ['7', '8', '9', 'T', 'J', 'Q', 'K', 'A']; // natural order
const TRUMP_ORDER = ['J', '9', 'A', 'T', 'K', 'Q', '8', '7'];
const PLAIN_ORDER = ['A', 'T', 'K', 'Q', 'J', '9', '8', '7'];
const TRUMP_PTS = { J: 20, 9: 14, A: 11, T: 10, K: 4, Q: 3, 8: 0, 7: 0 };
const PLAIN_PTS = { A: 11, T: 10, K: 4, Q: 3, J: 2, 9: 0, 8: 0, 7: 0 };
const SUIT_NL = { C: 'klaveren', D: 'ruiten', H: 'harten', S: 'schoppen' };
const SYM = { C: '♣', D: '♦', H: '♥', S: '♠' };
const RANK_NL = { 7: '7', 8: '8', 9: '9', T: '10', J: 'B', Q: 'V', K: 'H', A: 'A' };

const rk = c => c[0];
const st = c => c[1];
const short = c => SYM[st(c)] + RANK_NL[rk(c)];
const points = (c, trump) => (st(c) === trump ? TRUMP_PTS : PLAIN_PTS)[rk(c)];
const strength = (c, led, trump) =>
  st(c) === trump ? 100 - TRUMP_ORDER.indexOf(rk(c)) : st(c) === led ? 50 - PLAIN_ORDER.indexOf(rk(c)) : 0;

function trickWinner(cards, trump) {
  const led = st(cards[0].card);
  let best = cards[0];
  for (const pc of cards) if (strength(pc.card, led, trump) > strength(best.card, led, trump)) best = pc;
  return best.seat;
}

function highestTrump(cards, trump) {
  let best = -1;
  for (const pc of cards) if (st(pc.card) === trump) best = Math.max(best, strength(pc.card, trump, trump));
  return best;
}

function legalMoves(hand, trick, seat, trump, rules) {
  if (!trick.cards.length) return [...hand];
  const led = st(trick.cards[0].card);
  const follow = hand.filter(c => st(c) === led);
  const trumps = hand.filter(c => st(c) === trump);
  const top = highestTrump(trick.cards, trump);
  const over = trumps.filter(c => strength(c, trump, trump) > top);
  if (led === trump) return follow.length ? (over.length ? over : follow) : [...hand];
  if (follow.length) return follow;
  if (!trumps.length) return [...hand];
  const partnerWins = trickWinner(trick.cards, trump) === (seat + 2) % 4;
  if (rules === 'amsterdams' && partnerWins) {
    const free = hand.filter(c => st(c) !== trump).concat(over);
    return free.length ? free : [...hand];
  }
  if (over.length) return over;
  if (rules === 'rotterdams') return trumps;
  const rest = hand.filter(c => st(c) !== trump);
  return rest.length ? rest : trumps;
}

function explain(hand, trick, seat, trump, rules) {
  if (!trick.cards.length) return 'Je komt uit: speel wat je wilt';
  const led = st(trick.cards[0].card);
  const has = hand.some(c => st(c) === led);
  if (led === trump) return has ? 'Troef gevraagd: overtroeven als het kan' : 'Je hebt geen troef: vrije keuze';
  if (has) return `Bekennen: speel ${SYM[led]}`;
  if (!hand.some(c => st(c) === trump)) return 'Je kunt niet bekennen en hebt geen troef: vrije keuze';
  if (rules === 'amsterdams' && trickWinner(trick.cards, trump) === (seat + 2) % 4) return 'Je maat heeft de slag: vrije keuze';
  return trick.cards.some(pc => st(pc.card) === trump) ? 'Je moet overtroeven' : 'Je moet troeven';
}

function trickRoem(cards, trump) {
  const out = [];
  for (const s of SUITS) {
    const idx = cards.filter(c => st(c) === s).map(c => RANKS.indexOf(rk(c))).sort((a, b) => a - b);
    let run = 1;
    let best = 1;
    for (let i = 1; i < idx.length; i++) {
      run = idx[i] === idx[i - 1] + 1 ? run + 1 : 1;
      best = Math.max(best, run);
    }
    if (best >= 4) out.push({ kind: 'vier', points: 50 });
    else if (best === 3) out.push({ kind: 'drie', points: 20 });
  }
  if (cards.includes('K' + trump) && cards.includes('Q' + trump)) out.push({ kind: 'stuk', points: 20 });
  const r0 = rk(cards[0]);
  if (cards.length === 4 && cards.every(c => rk(c) === r0)) {
    if (r0 === 'J') out.push({ kind: 'vierBoeren', points: 200 });
    else if ('ATKQ'.includes(r0)) out.push({ kind: 'vierGelijk', points: 100 });
  }
  return out;
}

// Display order: trump first, then alternating colours; within a suit low
// to high.
function sortHand(hand, trump) {
  const order = !trump ? ['C', 'D', 'S', 'H']
    : { C: ['C', 'H', 'S', 'D'], S: ['S', 'H', 'C', 'D'], H: ['H', 'C', 'D', 'S'], D: ['D', 'C', 'H', 'S'] }[trump];
  return [...hand].sort((a, b) => {
    const sa = order.indexOf(st(a));
    const sb = order.indexOf(st(b));
    if (sa !== sb) return sa - sb;
    const ord = st(a) === trump ? TRUMP_ORDER : PLAIN_ORDER;
    return ord.indexOf(rk(b)) - ord.indexOf(rk(a));
  });
}

function deck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return d;
}

const RIGGED = [
  ['KH', 'AH', 'TH', '9H', '8H', 'AS', 'TS', 'AC'],
  ['QH', '7S', '8S', '9S', '7C', '8C', 'TD', 'AD'],
  ['JH', 'KS', 'QS', 'JS', 'TC', 'KC', 'QC', 'JC'],
  ['7H', '9C', '7D', '8D', '9D', 'JD', 'QD', 'KD'],
];

// ---------- personas ----------

const ROSTER = [
  { id: 'dirk', name: 'Opa Dirk', emoji: '👴', color: '#8a5a2b', bio: 'Speelt al zestig jaar in café De Klaver. Voorzichtig en degelijk.' },
  { id: 'truus', name: 'Tante Truus', emoji: '👵', color: '#c2577a', bio: 'Kletst honderduit en is dol op roem.' },
  { id: 'sjaak', name: 'Sjaak', emoji: '🎲', color: '#d9822b', bio: 'Gokker: speelt op dunne handen en gaat voor de pit.' },
  { id: 'fatima', name: 'Fatima', emoji: '🧠', color: '#6a4fc4', bio: 'Wiskundestudent die elke kaart telt.' },
  { id: 'kees', name: 'Kees de Visser', emoji: '🎣', color: '#2f6f9f', bio: 'Mopperkont, maar eerlijk.' },
  { id: 'ans', name: 'Juf Ans', emoji: '👩‍🏫', color: '#3c9d6b', bio: 'Geduldige juf die graag uitlegt.' },
  { id: 'bram', name: 'Bram', emoji: '🛹', color: '#e0457b', bio: 'Jong en snel, speelt op gevoel.' },
  { id: 'vera', name: 'Bakker Vera', emoji: '🥐', color: '#b8862e', bio: 'Staat om vijf uur op, speelt scherp en vriendelijk.' },
];
const LINES = {
  greet: ['Goedenavond allemaal!', 'Zin in! Wie geeft?', 'Daar gaan we weer 🃏', 'Veel plezier, en geen gezeur over de kaarten.'],
  roem: ['Roem! Schrijf maar op.', 'Hé, dat telt mooi aan.', 'Stuk, hoor!', 'Ha, daar zat roem in.'],
  nat: ['Nat! Dat was te gewaagd.', 'Oei, daar gaan ze nat.', 'Nat als een kat 😄'],
  pit: ['PIT! Alle slagen!', 'Een pit, die zie je niet vaak.'],
  reply: ['Haha', 'Ja hoor!', 'Goed gespeeld 👍', 'Let maar op.'],
};

// ---------- rooms ----------

const PACE = {
  rustig: { think: 1500, deal: 2000, announce: 1200, trick: 2200, summary: 15000 },
  normaal: { think: 900, deal: 1500, announce: 900, trick: 1500, summary: 12000 },
  snel: { think: 450, deal: 900, announce: 500, trick: 800, summary: 8000 },
};
const ASK_AFTER = 10000; // ms, scaled: a dropped-out person's turn before the table is asked
const PLAYING = new Set(['trump', 'bid', 'play']);
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const rooms = new Map();
const DEFAULTS = { players: 4, hands: 16, trumpMode: 'utrechts', rules: 'amsterdams', ai: 'normaal', tempo: 'normaal', open: false };

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
}

const token = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

function botPlayer(room, id) {
  const used = new Set(room.players.filter(p => p?.bot).map(p => p.botId));
  const free = ROSTER.filter(p => !used.has(p.id) && (id ? p.id === id : true));
  const per = free.length ? (id ? free[0] : pick(free)) : pick(ROSTER);
  return { name: per.name + ' (AI)', bot: true, botId: per.id, emoji: per.emoji, color: per.color, connected: true, away: false, ready: false };
}

function delay(room, kind) {
  return Math.max(30, PACE[room.opts.tempo][kind] * SCALE);
}

function later(room, ms, fn) {
  const t = setTimeout(() => { room.timers.delete(t); fn(); }, ms);
  room.timers.add(t);
}

function clearTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers.clear();
  clearTimeout(room.turnTimer);
}

function createRoom(opts, training) {
  const room = {
    code: newCode(), opts: { ...DEFAULTS, ...pickOpts(opts) }, training, host: 0, seq: 0,
    players: [null, null, null, null], phase: 'lobby', handNo: 0, dealer: -1, deal: null,
    scores: [], total: [0, 0], prevHand: null, lastTrick: null, nextAt: 0, winner: -1,
    chat: [], timers: new Set(), rigged: RIG, lastBotChat: 0,
    turnKey: '', turnAt: 0, openedAt: 0, think: 0, turnTimer: 0, question: null, takeover: null, summaryWaits: false,
  };
  if (training) room.opts = { ...room.opts, tempo: opts?.tempo || 'rustig' };
  rooms.set(room.code, room);
  return room;
}

function pickOpts(o = {}) {
  const out = {};

  if ([4, 8, 12, 16, 20, 24].includes(o.hands)) out.hands = o.hands;
  if (['utrechts', 'gedraaid'].includes(o.trumpMode)) out.trumpMode = o.trumpMode;
  if (['amsterdams', 'rotterdams'].includes(o.rules)) out.rules = o.rules;
  if (['makkelijk', 'normaal', 'sterk'].includes(o.ai)) out.ai = o.ai;
  if (['rustig', 'normaal', 'snel'].includes(o.tempo)) out.tempo = o.tempo;
  if (typeof o.open === 'boolean') out.open = o.open;
  return out;
}

// ---------- state ----------

function stateFor(room, seat) {
  const d = room.deal;
  const playing = d && ['trump', 'bid', 'play'].includes(room.phase);
  const myTurn = playing && d.turn === seat;
  const hand = playing ? sortHand(d.hands[seat], d.trump) : [];
  const legal = myTurn && room.phase === 'play' ? sortHand(legalMoves(d.hands[seat], d.trick, seat, d.trump, room.opts.rules), d.trump) : null;
  const s = {
    code: room.code, phase: room.phase, opts: room.opts, training: room.training, you: seat, host: room.host,
    roster: room.phase === 'lobby' ? ROSTER : undefined,
    players: room.players.map((p, i) => p && {
      name: p.name, bot: p.bot, botId: p.botId || '', emoji: p.emoji || '', color: p.color || '',
      connected: p.bot ? true : p.connected, away: !!p.away, left: !!p.left, cards: playing ? d.hands[i].length : 0, ready: !!p.ready,
      vote: room.takeover && typeof p.vote === 'boolean' ? p.vote : null,
    }),
    takeover: room.takeover && { seat: room.takeover.seat, left: room.takeover.left },
    handNo: room.handNo || 1, hands: room.opts.hands, dealer: room.dealer, voorhand: (room.dealer + 1) % 4,
    turned: d?.turned || null, bids: d?.bids || [-1, -1, -1, -1], forced: !!d?.forced,
    trump: d?.trump || null, trumpBy: d?.trumpBy ?? -1, playingTeam: d?.trumpBy >= 0 ? d.trumpBy % 2 : -1,
    turn: playing ? d.turn : -1, hand, legal,
    rule: myTurn && room.phase === 'play' ? explain(d.hands[seat], d.trick, seat, d.trump, room.opts.rules) : '',
    trick: playing ? d.trick : { leader: 0, cards: [], winner: -1 },
    lastTrick: room.lastTrick,
    tricksWon: d ? d.tricksWon : [0, 0], handPoints: d ? d.points : [0, 0], handRoem: d ? d.roem : [0, 0],
    scores: room.scores, total: room.total, prevHand: room.prevHand, nextAt: room.phase === 'handEnd' ? room.nextAt : 0,
    hint: null, hands4: null, winner: room.winner,
    review: room.phase === 'gameOver' && !room.players[seat]?.bot ? mockReview(room, seat) : null,
  };
  if (room.training && myTurn) s.hint = hintFor(room, seat);
  if (room.training && room.opts.open && playing) s.hands4 = d.hands.map((h, i) => (i === seat ? null : sortHand(h, d.trump)));
  return s;
}

// The review at game over (design §9 Spelanalyse), with its moments taken
// from the tricks of the last hand, and every hand for the replay.
function mockReview(room, seat) {
  const tricks = room.prevHand?.tricks || [];
  const moment = (k, m) => {
    const t = tricks[k];
    const pc = t?.cards.find(c => c.seat === seat);
    return pc ? { hand: room.handNo, trick: k + 1, played: { card: pc.card }, text: '', table: t, nat: [0, 0], natThem: [0, 0], ...m } : null;
  };
  // The better card: another of the player's cards in that trick's suit,
  // else any other card they still held.
  const other = k => {
    const mine = tricks.slice(k).flatMap(t => t.cards.filter(c => c.seat === seat).map(c => c.card));
    return mine.find((c, i) => i > 0 && c[1] === mine[0][1]) || mine[1] || mine[0];
  };
  const strong = [moment(1, { points: 21, us: 11, them: -10, alt: { card: other(1) }, why: 'de slag is zeker voor jullie, dus zo zijn de 11 punten binnen.' })].filter(Boolean);
  const missed = [
    { hand: 1, trick: 0, played: { suit: 'H' }, better: { suit: 'C' }, points: 14, us: 9, them: -5, nat: [31, 18], natThem: [0, 0], text: '',
      cards: ['JC', '9C', 'AC', '7C', 'AH', '8H', 'TS', '7D'],
      why: 'je hebt de boer, de nel en de aas, in totaal vier klaveren. Je haalt het zo naar schatting in 8 van de 10 potjes.' },
    moment(3, { better: { card: other(3) }, points: 18, us: 7, them: -11, why: 'je maat heeft de slag nog niet en de aas is hoog.' }),
  ].filter(Boolean);
  const replay = (room.handTricks || []).map((ts, h) => {
    const cards = [[], [], [], []];
    for (const t of ts) for (const pc of t.cards) cards[pc.seat].push(pc.card);
    return { cards: cards.map(c => sortHand(c, room.scores[h]?.trump)), tricks: ts };
  });
  return {
    id: room.reviewId, pending: false, pct: 87, hands: room.opts.hands, choices: 31, luck: -6, lost: 41, lostN: 3,
    strongN: 2, leads: [9, 11], trumps: [3, 4], roem: [40, 2], risky: room.opts.trumpMode === 'gedraaid' ? [2, 1] : [0, 0], strong, missed,
    speed: { n: 31, median: 2400, total: 98000, slowest: { hand: 2, trick: 5, ms: 14200 }, others: { n: 62, median: 3100, total: 211000 } },
    replay,
  };
}

// One update for everyone; as the server, fresh (a connection that just
// joined) gets it as a resync, with ev null.
function broadcast(room, ev, fresh = null) {
  refreshQuestion(room);
  room.seq++;
  room.players.forEach((p, seat) => {
    if (p && !p.bot && p.ws && p.connected) send(p.ws, { t: 'update', seq: room.seq, ev: p.ws === fresh ? null : ev, s: stateFor(room, seat) });
  });
}

function send(ws, m) {
  if (ws.readyState === 1) ws.send(JSON.stringify(m));
}

function sys(room, text) {
  chatMsg(room, { seat: -1, name: '', text, ts: Date.now(), bot: false, sys: true });
}

function chatMsg(room, msg) {
  room.chat.push(msg);
  if (room.chat.length > 50) room.chat.shift();
  for (const p of room.players) if (p && !p.bot && p.ws) send(p.ws, { t: 'chat', msg });
}

function botSay(room, seat, kind, force = false) {
  const p = room.players[seat];
  if (!p?.bot) return;
  const now = Date.now();
  if (!force && (now - room.lastBotChat < 2500 || rand() > 0.6)) return;
  room.lastBotChat = now;
  later(room, 250, () => chatMsg(room, { seat, name: p.name, text: pick(LINES[kind]), ts: Date.now(), bot: true, sys: false }));
}

// ---------- game flow ----------

function startGame(room) {
  // Empty seats, and those of whoever left, get bots (a rematch too). The
  // consent for an AI that played for someone who is gone was for the match
  // that ended: in this one they are waited for and asked about again.
  for (let s = 0; s < 4; s++) if (!room.players[s] || room.players[s].left) room.players[s] = botPlayer(room);
  for (const p of room.players) if (!p.bot) { p.away = false; p.asked = false; }
  room.scores = [];
  room.handTricks = [];
  room.total = [0, 0];
  room.handNo = 0;
  room.winner = -1;
  room.prevHand = null;
  room.lastTrick = null;
  sys(room, 'Het spel begint. Veel plezier!');
  const greeter = room.players.findIndex(p => p?.bot);
  if (greeter >= 0) botSay(room, greeter, 'greet', true);
  startHand(room);
}

function startHand(room) {
  clearTimers(room);
  room.handNo++;
  const rig = room.rigged && room.handNo === 1;
  room.dealer = rig ? 3 : room.dealer < 0 ? Math.floor(rand() * 4) : (room.dealer + 1) % 4;
  let hands;
  if (rig) hands = RIGGED.map(h => [...h]);
  else {
    const dk = shuffle(deck());
    hands = [0, 1, 2, 3].map(i => dk.slice(i * 8, i * 8 + 8));
  }
  const gedraaid = room.opts.trumpMode === 'gedraaid';
  room.deal = {
    hands, trump: null, trumpBy: -1, turned: null, bids: [-1, -1, -1, -1], forced: false, turn: -1,
    trick: { leader: (room.dealer + 1) % 4, cards: [], winner: -1 }, tricks: [], tricksWon: [0, 0], points: [0, 0], roem: [0, 0],
  };
  room.phase = gedraaid ? 'bid' : 'trump';
  for (const p of room.players) if (p) p.ready = false;
  room.lastTrick = null;
  broadcast(room, { type: 'deal', handNo: room.handNo, dealer: room.dealer });
  later(room, delay(room, 'deal'), () => {
    const v = (room.dealer + 1) % 4;
    room.deal.turn = v;
    if (gedraaid) {
      room.deal.turned = rig ? 'H' : pick(SUITS);
      broadcast(room, { type: 'turned', suit: room.deal.turned });
    } else broadcast(room, null);
    schedule(room);
  });
}

// Schedules what the current turn needs, in place of what it scheduled
// before: the move of a bot (or of the AI that plays for someone who is
// away), or the moment the table is asked about a person who dropped out.
// With only bots left nothing moves: the game pauses. Called after every
// change.
function schedule(room) {
  clearTimeout(room.turnTimer);
  room.turnTimer = 0;
  const d = room.deal;
  if (!d || d.turn < 0 || !PLAYING.has(room.phase) || !live(room)) return;
  trackTurn(room);
  const seat = d.turn;
  const p = room.players[seat];
  if (p.bot || p.away) {
    // Thinking counts from the turn, or from when the AI took over.
    const due = Math.max(room.turnAt, p.since || 0) + room.think;
    room.turnTimer = setTimeout(() => botMove(room, d, seat), Math.max(0, due - Date.now()));
  } else if (!p.connected && !room.takeover) {
    room.turnTimer = setTimeout(() => { if (askedSeat(room) === seat) broadcast(room, null); }, Math.max(0, askAt(room, p) - Date.now()) + 5);
  }
}

function botMove(room, d, seat) {
  const p = room.players[seat];
  if (room.deal !== d || d.turn !== seat || !(p.bot || p.away) || !live(room)) return;
  if (room.phase === 'trump') doTrump(room, seat, botTrump(d.hands[seat], d.forced ? d.turned : null));
  else if (room.phase === 'bid') doBid(room, seat, botBid(d.hands[seat], d.turned));
  else if (room.phase === 'play') doPlay(room, seat, botPlay(room, seat));
}

// When the current turn opened, and how long a bot thinks in it (turnAt
// starts over when play resumes; openedAt does not).
function trackTurn(room) {
  const d = room.deal;
  const key = d && d.turn >= 0 && PLAYING.has(room.phase) ? [room.handNo, room.phase, d.tricks.length, d.trick.cards.length, d.turn].join('|') : '';
  if (key === room.turnKey) return;
  room.turnKey = key;
  room.turnAt = room.openedAt = Date.now();
  room.think = delay(room, 'think') * (0.7 + rand() * 0.6);
}

// ---------- takeover (design §6) ----------

// The game runs while a person is connected.
const live = room => room.players.some(p => p && !p.bot && p.connected);

// Who is asked about a seat: every connected person but its own.
const voters = (room, seat) => room.players.flatMap((p, i) => (p && !p.bot && p.connected && i !== seat ? [i] : []));

// A dropped-out person is asked about askAfter after the later of the turn
// opening and the drop-out (once asked, until they are back, at once); who
// left, at once. A pause with nobody there does not reset that clock.
const askAt = (room, p) => (p.left || p.asked ? 0 : Math.max(room.openedAt, p.droppedAt || 0) + ASK_AFTER * SCALE);

// The seat the game waits on and the question is about, or -1: the turn
// (no pause) of a person who is gone, once it is time to ask. While nobody
// is connected to answer, the question rests: nobody sees it, and it keeps
// its votes.
function questionSeat(room) {
  const d = room.deal;
  if (!d || d.turn < 0 || !PLAYING.has(room.phase)) return -1;
  const p = room.players[d.turn];
  return p.bot || p.away || p.connected || Date.now() < askAt(room, p) ? -1 : d.turn;
}

// The seat the table is asked about, or -1: as questionSeat, when there
// is anyone to ask.
function askedSeat(room) {
  const seat = questionSeat(room);
  return seat >= 0 && voters(room, seat).length ? seat : -1;
}

// Opens or closes the question as the state now asks (before every
// update). The votes last as long as it is about the same seat, also
// while it rests, so a no held for someone who dropped out still counts
// for whoever is back first.
function refreshQuestion(room) {
  trackTurn(room);
  const seat = questionSeat(room);
  const q = room.question;
  if (q && (q.seat !== seat || q.left !== !!room.players[seat].left)) closeQuestion(room);
  if (seat >= 0 && !room.question) {
    room.question = { seat, left: !!room.players[seat].left };
    room.players[seat].asked = true;
  }
  room.takeover = room.question && voters(room, seat).length ? room.question : null;
}

function closeQuestion(room) {
  room.question = room.takeover = null;
  for (const p of room.players) if (p) p.vote = null;
}

// Settles the question once everyone asked agrees, checked after a vote and
// whenever who is asked changes. Who left gets a bot in their seat, which
// a joiner can still take over; who dropped out gets an AI that plays for
// them until they are back. Reports whether it took over.
function decide(room) {
  const q = room.takeover;
  if (!q) return false;
  const asked = voters(room, q.seat);
  if (!asked.length || !asked.every(i => room.players[i].vote === true)) return false;
  if (room.players.some(p => p && !p.bot && p.vote === false)) return false; // a no held after a drop-out
  const p = room.players[q.seat];
  closeQuestion(room);
  if (q.left) {
    room.players[q.seat] = { ...botPlayer(room), vacated: true, since: Date.now() };
    sys(room, `Iedereen is akkoord: ${room.players[q.seat].name} neemt de plaats van ${p.name} in.`);
  } else {
    p.away = true;
    p.asked = false;
    p.since = Date.now();
    sys(room, `Iedereen is akkoord: een AI-speler speelt zolang voor ${p.name}.`);
  }
  broadcast(room, { type: 'takeover', seat: q.seat });
  schedule(room);
  return true;
}

// The hand summary ends early once every person still connected is ready.
const allReady = room => live(room) && room.players.every(p => !p || p.bot || !p.connected || p.ready);

// Play pauses while nobody is connected. Once someone is back, bots think
// anew and the hand summary's countdown starts over; the question about a
// person gone for askAfter meanwhile is there at once.
function resume(room) {
  room.turnAt = Date.now();
  if (room.phase !== 'handEnd' || !room.summaryWaits) return;
  room.summaryWaits = false;
  room.nextAt = Date.now() + PACE[room.opts.tempo].summary;
  later(room, room.nextAt - Date.now(), () => nextHand(room));
}

function botTrump(hand, not) {
  let best = null;
  let score = -1;
  for (const s of SUITS) {
    if (s === not) continue;
    const v = hand.filter(c => st(c) === s).reduce((n, c) => n + 10 + TRUMP_PTS[rk(c)], 0);
    if (v > score) { score = v; best = s; }
  }
  return best;
}

function botBid(hand, turned) {
  const t = hand.filter(c => st(c) === turned);
  return t.length >= 4 || (t.length >= 3 && t.some(c => rk(c) === 'J' || rk(c) === '9'));
}

function botPlay(room, seat) {
  const d = room.deal;
  const legal = legalMoves(d.hands[seat], d.trick, seat, d.trump, room.opts.rules);
  if (!d.trick.cards.length) return legal.sort((a, b) => points(b, d.trump) - points(a, d.trump))[0];
  const partnerWins = trickWinner(d.trick.cards, d.trump) === (seat + 2) % 4;
  const byPts = [...legal].sort((a, b) => points(a, d.trump) - points(b, d.trump));
  if (partnerWins) return byPts[byPts.length - 1];
  const winners = legal.filter(c => trickWinner([...d.trick.cards, { seat, card: c }], d.trump) === seat);
  if (winners.length) return winners.sort((a, b) => points(a, d.trump) - points(b, d.trump))[0];
  return byPts[0];
}

function hintFor(room, seat) {
  const d = room.deal;
  if (room.phase === 'trump') {
    const suit = botTrump(d.hands[seat], d.forced ? d.turned : null);
    return { suit, text: `Kies ${SUIT_NL[suit]}: daar heb je de meeste en sterkste kaarten in.` };
  }
  if (room.phase === 'bid') {
    const play = botBid(d.hands[seat], d.turned);
    return { play, text: play ? `Spelen: je hebt genoeg ${SUIT_NL[d.turned]} om troef te maken.` : `Passen: met zo weinig ${SUIT_NL[d.turned]} is spelen te riskant.` };
  }
  const card = botPlay(room, seat);
  const lead = !d.trick.cards.length;
  return { card, text: lead ? `Speel ${short(card)}: kom uit met een hoge kaart en haal de punten binnen.` : `Speel ${short(card)}: ${trickWinner(d.trick.cards, d.trump) === (seat + 2) % 4 ? 'je maat heeft de slag, dus geef er punten bij.' : 'dit is de goedkoopste kaart die past.'}` };
}

function doTrump(room, seat, suit) {
  const d = room.deal;
  d.trump = suit;
  d.trumpBy = seat;
  d.turn = -1;
  const forced = d.forced;
  room.phase = 'play';
  d.turn = -1;
  broadcast(room, { type: 'trump', seat, suit, forced });
  later(room, delay(room, 'announce'), () => {
    d.turn = (room.dealer + 1) % 4;
    broadcast(room, null);
    schedule(room);
  });
}

function doBid(room, seat, play) {
  const d = room.deal;
  d.bids[seat] = play ? 1 : 0;
  if (play) {
    d.turn = -1;
    broadcast(room, { type: 'bid', seat, play });
    doTrump(room, seat, d.turned);
    return;
  }
  const next = (seat + 1) % 4;
  if (next === (room.dealer + 1) % 4) {
    d.forced = true;
    room.phase = 'trump';
    d.turn = next;
  } else d.turn = next;
  broadcast(room, { type: 'bid', seat, play });
  schedule(room);
}

function doPlay(room, seat, card) {
  const d = room.deal;
  d.hands[seat] = d.hands[seat].filter(c => c !== card);
  d.trick.cards.push({ seat, card });
  if (d.trick.cards.length < 4) {
    d.turn = (seat + 1) % 4;
    broadcast(room, { type: 'play', seat, card });
    schedule(room);
    return;
  }
  d.turn = -1;
  broadcast(room, { type: 'play', seat, card });
  const t = d.trick;
  const winner = trickWinner(t.cards, d.trump);
  const last = d.tricks.length === 7;
  const pts = t.cards.reduce((n, pc) => n + points(pc.card, d.trump), 0) + (last ? 10 : 0);
  const roem = trickRoem(t.cards.map(pc => pc.card), d.trump);
  t.winner = winner;
  t.points = pts;
  t.roem = roem;
  const team = winner % 2;
  d.tricksWon[team]++;
  d.points[team] += pts;
  d.roem[team] += roem.reduce((n, r) => n + r.points, 0);
  broadcast(room, { type: 'trick', winner, points: pts, roem, last });
  if (roem.length) {
    const bot = room.players.findIndex((p, i) => p?.bot && i % 2 === team);
    if (bot >= 0) botSay(room, bot, 'roem');
  }
  if (room.training) {
    const names = room.players.map((p, i) => (i === 0 ? 'Jij' : p.name));
    const rtxt = roem.length ? `, roem: ${roem.map(r => `${r.kind} (${r.points})`).join(', ')}` : '';
    later(room, 120, () => {
      const human = room.players.find(p => p && !p.bot);
      if (human?.ws) send(human.ws, { t: 'tip', text: `${names[winner]} wint de slag met ${short(t.cards.find(pc => pc.seat === winner).card)}. ${pts} punten${rtxt}.` });
    });
  }
  later(room, delay(room, 'trick'), () => {
    d.tricks.push({ ...t });
    room.lastTrick = { ...t };
    d.trick = { leader: winner, cards: [], winner: -1 };
    if (d.tricks.length === 8) return endHand(room, winner);
    d.turn = winner;
    broadcast(room, { type: 'collect', winner });
    schedule(room);
  });
}

function endHand(room, lastWinner) {
  const d = room.deal;
  const P = d.trumpBy % 2;
  const D = 1 - P;
  const pit = d.tricksWon[0] === 8 || d.tricksWon[1] === 8;
  const pitTeam = pit ? (d.tricksWon[0] === 8 ? 0 : 1) : -1;
  const roem = [...d.roem];
  if (pit) roem[pitTeam] += 100;
  const total = d.points[0] + d.points[1] + roem[0] + roem[1];
  const nat = !(d.points[P] + roem[P] > total / 2);
  const score = [0, 0];
  if (nat) score[D] = 162 + roem[0] + roem[1];
  else { score[0] = d.points[0] + roem[0]; score[1] = d.points[1] + roem[1]; }
  const result = { playingTeam: P, trumpBy: d.trumpBy, trump: d.trump, dealer: room.dealer, points: [...d.points], roem, score, nat, pit, pitTeam };
  room.scores.push({ hand: room.handNo, dealer: room.dealer, trump: d.trump, trumpBy: d.trumpBy, playingTeam: P, points: [...d.points], roem, score, nat, pit });
  room.total = [room.total[0] + score[0], room.total[1] + score[1]];
  room.prevHand = { tricks: d.tricks, result };
  room.handTricks.push(d.tricks);
  room.phase = 'handEnd';
  room.nextAt = Date.now() + PACE[room.opts.tempo].summary; // unscaled: the summary must stay readable
  broadcast(room, { type: 'collect', winner: lastWinner });
  broadcast(room, { type: 'handEnd', result });
  if (nat) {
    const bot = room.players.findIndex((p, i) => p?.bot && i % 2 === D);
    if (bot >= 0) botSay(room, bot, 'nat', true);
  } else if (pit) {
    const bot = room.players.findIndex((p, i) => p?.bot && i % 2 === pitTeam);
    if (bot >= 0) botSay(room, bot, 'pit', true);
  }
  later(room, room.nextAt - Date.now(), () => nextHand(room));
}

function nextHand(room) {
  if (room.phase !== 'handEnd') return;
  if (!live(room)) { room.summaryWaits = true; return; }
  clearTimers(room);
  if (room.handNo >= room.opts.hands) {
    room.phase = 'gameOver';
    room.deal = null;
    room.reviewId = `${room.code}-${Date.now()}`;
    room.winner = room.total[0] === room.total[1] ? -1 : room.total[0] > room.total[1] ? 0 : 1;
    broadcast(room, { type: 'gameOver', total: room.total, winner: room.winner });
    return;
  }
  startHand(room);
}

// ---------- messages ----------

function onMessage(ws, m) {
  const conn = ws.kj;
  const room = conn.room;
  const seat = conn.seat;
  const err = (code, msg) => send(ws, { t: 'error', code, msg });
  switch (m.t) {
    case 'ping': return send(ws, { t: 'pong' });
    case 'create': {
      const r = createRoom(m.opts, !!m.training);
      if (r.training) {
        r.players[2] = { ...botPlayer(r, 'ans') };
        r.players[1] = botPlayer(r);
        r.players[3] = botPlayer(r);
      }
      seatHuman(ws, r, 0, m.name);
      if (m.start || r.training) startGame(r);
      else broadcast(r, { type: 'lobby' });
      return;
    }
    case 'join': {
      const code = String(m.code || '').toUpperCase();
      const r = rooms.get(code);
      if (!r) return err('onbekend', `Spel ${code} bestaat niet (meer).`);
      const back = r.players.findIndex(p => p && !p.bot && p.token && p.token === m.token);
      if (back >= 0) {
        // Back at the seat: whoever played for them stops, and the
        // question about them (or the one they are asked) is as it now is.
        const p = r.players[back];
        const wasAway = p.away;
        const paused = !live(r);
        p.ws = ws;
        p.connected = true;
        p.away = false;
        p.asked = false; // a later drop-out asks again
        conn.room = r;
        conn.seat = back;
        if (paused) resume(r);
        send(ws, { t: 'joined', code: r.code, seat: back, token: p.token });
        send(ws, { t: 'chatlog', msgs: r.chat });
        if (wasAway) sys(r, `${p.name} is terug.`);
        broadcast(r, { type: 'back', seat: back }, ws);
        schedule(r);
        return;
      }
      if (r.training) return err('vol', 'Dit is een oefenspel; daar kun je niet bij.');
      if (r.phase === 'lobby') {
        const free = r.players.findIndex(p => !p);
        if (free < 0) {
          // As the server: the host hears of it (without its rate limit).
          sys(r, `${String(m.name || 'Speler').slice(0, 20)} wilde aanschuiven, maar de tafel is vol.`);
          const host = r.players[r.host];
          if (host?.ws && host.connected) send(host.ws, { t: 'refused', name: String(m.name || 'Speler').slice(0, 20) });
          return err('vol', r.players.some(p => p?.bot) ? 'Deze tafel is vol. Vraag de host om een AI-speler weg te halen en probeer het dan opnieuw.'
            : 'Deze tafel is vol: alle vier de plaatsen zijn bezet.');
        }
        seatHuman(ws, r, free, m.name);
        sys(r, `${r.players[free].name} schuift aan.`);
        broadcast(r, { type: 'join', seat: free }, ws);
        return;
      }
      // A running game: only the seat of someone who left can be taken
      // over, still empty or with the bot the table agreed on. As the
      // server: who left gets their own seat back (by name), else the one
      // whose turn it is goes first; the line for the same name claims no
      // more than the name.
      const clean = cleanName(m.name);
      const turn = r.deal && PLAYING.has(r.phase) ? r.deal.turn : -1;
      let vac = r.players.findIndex(p => p?.left && p.name === clean);
      if (vac < 0) vac = r.players[turn]?.left ? turn : r.players.findIndex(p => p?.left);
      if (vac < 0) vac = r.players.findIndex(p => p?.vacated);
      if (vac < 0) return err('gestart', 'Dit spel is al begonnen.');
      const old = r.players[vac].name;
      const paused = !live(r);
      seatHuman(ws, r, vac, m.name);
      if (paused) resume(r);
      const name = r.players[vac].name;
      sys(r, name === old ? `${name} neemt de plaats weer in.` : `${name} neemt de plaats van ${old} over.`);
      broadcast(r, { type: 'join', seat: vac }, ws);
      schedule(r);
      return;
    }
    default: break;
  }
  if (!room) return err('onbekend', 'Je zit nog niet aan een tafel.');
  const d = room.deal;
  const host = room.host === seat;
  switch (m.t) {
    case 'sit':
      if (room.phase !== 'lobby' || room.players[m.seat]) return err('ongeldig', 'Die plaats is niet vrij.');
      room.players[m.seat] = room.players[seat];
      room.players[seat] = null;
      if (room.host === seat) room.host = m.seat;
      conn.seat = m.seat;
      send(ws, { t: 'joined', code: room.code, seat: m.seat, token: room.players[m.seat].token });
      return broadcast(room, { type: 'lobby' });
    case 'bot':
      if (!host) return err('geen-host', 'Alleen de host kan dat.');
      if (room.phase !== 'lobby' || (room.players[m.seat] && !room.players[m.seat].bot)) return err('ongeldig', 'Die plaats is niet vrij.');
      room.players[m.seat] = null;
      room.players[m.seat] = botPlayer(room, m.id || '');
      return broadcast(room, { type: 'lobby' });
    case 'unbot':
      if (!host) return err('geen-host', 'Alleen de host kan dat.');
      if (!room.players[m.seat]?.bot) return err('ongeldig', 'Daar zit geen AI-speler.');
      room.players[m.seat] = null;
      return broadcast(room, { type: 'lobby' });
    case 'opts':
      if (!host) return err('geen-host', 'Alleen de host kan dat.');
      if (room.phase !== 'lobby') return err('ongeldig', 'Het spel is al begonnen.');
      Object.assign(room.opts, pickOpts(m.opts));
      return broadcast(room, { type: 'lobby' });
    case 'start':
      if (!host) return err('geen-host', 'Alleen de host kan het spel starten.');
      if (room.phase !== 'lobby') return;
      return startGame(room);
    case 'trump':
      if (!d || room.phase !== 'trump' || d.turn !== seat) return err('niet-jouw-beurt', 'Je bent niet aan de beurt.');
      if (!SUITS.includes(m.suit) || (d.forced && m.suit === d.turned)) return err('ongeldig', 'Die kleur mag je niet kiezen.');
      return doTrump(room, seat, m.suit);
    case 'bid':
      if (!d || room.phase !== 'bid' || d.turn !== seat) return err('niet-jouw-beurt', 'Je bent niet aan de beurt.');
      return doBid(room, seat, !!m.play);
    case 'play': {
      if (!d || room.phase !== 'play' || d.turn !== seat) return err('niet-jouw-beurt', 'Je bent niet aan de beurt.');
      const legal = legalMoves(d.hands[seat], d.trick, seat, d.trump, room.opts.rules);
      if (!legal.includes(m.card)) return err('ongeldig', 'Die kaart mag je nu niet spelen.');
      return doPlay(room, seat, m.card);
    }
    case 'ready':
      if (room.phase !== 'handEnd') return;
      room.players[seat].ready = true;
      broadcast(room, null);
      if (allReady(room)) later(room, 200, () => nextHand(room));
      return;
    case 'vote': {
      // As the server: a field of the wrong type is a message it cannot
      // read; a vote answers one question (seat, and left when it says);
      // the same answer again changes nothing, so no update.
      const q = room.takeover;
      const typed = (v, type) => v == null || (type === 'int' ? Number.isInteger(v) : typeof v === type);
      if (!typed(m.seat, 'int') || !typed(m.ai, 'boolean') || !typed(m.left, 'boolean')) return err('ongeldig', 'Dat bericht begrijp ik niet.');
      if (m.seat == null || m.seat < 0 || m.seat > 3) return err('ongeldig', 'Die plaats bestaat niet.');
      if (m.ai == null) return err('ongeldig', 'Kies of een AI-speler mag spelen of dat jullie wachten.');
      if (!q || q.seat !== m.seat || seat === q.seat || (m.left != null && q.left !== m.left)) return err('ongeldig', 'Die vraag staat niet (meer) open.');
      if (room.players[seat].vote === m.ai) return;
      room.players[seat].vote = m.ai;
      if (!decide(room)) broadcast(room, null);
      return;
    }
    case 'chat': {
      const text = String(m.text || '').slice(0, 200).trim();
      if (!text) return;
      chatMsg(room, { seat, name: room.players[seat].name, text, ts: Date.now(), bot: false, sys: false });
      const bot = room.players.findIndex(p => p?.bot);
      if (bot >= 0 && rand() < 0.7) later(room, 700, () => botSay(room, bot, 'reply', true));
      return;
    }
    case 'rematch':
      if (!host) return err('geen-host', 'Alleen de host kan een nieuw spel starten.');
      if (room.phase !== 'gameOver') return;
      room.dealer = -1;
      return startGame(room);
    case 'leave': {
      const p = room.players[seat];
      conn.room = null;
      // In a game (or at game over) the seat keeps the name, and nobody
      // plays it until someone joins in it or the others agree on an AI.
      if (room.phase === 'lobby') room.players[seat] = null;
      else room.players[seat] = { name: p.name, bot: false, botId: '', emoji: '', color: '', connected: false, away: false, ready: false, left: true };
      if (room.host === seat) {
        const next = room.players.findIndex(x => x && !x.bot && !x.left);
        room.host = next >= 0 ? next : room.host;
      }
      sys(room, `${p?.name || 'Een speler'} is vertrokken.`);
      broadcast(room, { type: 'leave', seat });
      // As the server: an empty lobby goes at once; a game everyone left
      // waits five minutes for someone with the code to take a seat.
      if (!room.players.some(x => x && !x.bot && !x.left)) {
        if (room.phase === 'lobby') { clearTimers(room); rooms.delete(room.code); return; }
        setTimeout(() => {
          if (rooms.get(room.code) === room && !room.players.some(x => x && !x.bot && !x.left)) { clearTimers(room); rooms.delete(room.code); }
        }, 5 * 60000);
      }
      if (room.phase === 'handEnd' && allReady(room)) later(room, 200, () => nextHand(room));
      if (!decide(room)) schedule(room); // the rest may all agree already
      return;
    }
    default:
      return err('ongeldig', 'Onbekend bericht.');
  }
}

const cleanName = name => String(name || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 20) || 'Speler';

function seatHuman(ws, room, seat, name) {
  const clean = cleanName(name);
  const p = { name: clean, bot: false, botId: '', emoji: '', color: '', connected: true, away: false, ready: false, token: token(), ws };
  room.players[seat] = p;
  ws.kj.room = room;
  ws.kj.seat = seat;
  send(ws, { t: 'joined', code: room.code, seat, token: p.token });
  send(ws, { t: 'chatlog', msgs: room.chat });
}

// ---------- http + ws ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, mock: true, rooms: rooms.size }));
  }
  let p = url.pathname;
  if (p === '/' || /^\/[A-Za-z]{4}$/.test(p)) p = '/index.html';
  const file = path.join(WEB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Niet gevonden'); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'none'",
    });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', ws => {
  ws.kj = { room: null, seat: -1 };
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    try { onMessage(ws, m); } catch (e) { console.error(e); }
  });
  // A connection lost keeps the seat; nobody plays it unasked (design §6).
  ws.on('close', () => {
    const { room, seat } = ws.kj;
    const p = room?.players[seat];
    if (!p || p.ws !== ws) return;
    p.connected = false;
    p.ws = null;
    const at = p.droppedAt = Date.now();
    // No longer asked, but a no outlasts a short drop-out: it holds for
    // askAfter, as on the server.
    if (p.vote === false && room.takeover) {
      later(room, ASK_AFTER * SCALE, () => {
        if (p.ws || p.droppedAt !== at || p.vote !== false) return;
        p.vote = null;
        if (!decide(room)) broadcast(room, null);
      });
    } else p.vote = null;
    broadcast(room, { type: 'away', seat });
    if (room.phase === 'handEnd' && allReady(room)) later(room, 200, () => nextHand(room));
    if (!decide(room)) schedule(room); // the rest may all agree already
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock klaverjas on http://127.0.0.1:${PORT}/ (scale ${SCALE}${RIG ? ', rigged' : ''})`));
