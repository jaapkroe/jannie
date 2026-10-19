#!/usr/bin/env node
// Mock klaverjas server for frontend development and UI tests: serves web/
// (with the /ABCD → index.html rule) and speaks the websocket protocol of
// docs/design.md §7 with a compact rules engine and simple bots.
//
//   node test/ui/mock/server.mjs [--port 18100] [--scale 1] [--fast] [--rig] [--seed N]
//
// --scale multiplies the real server's pauses (default 1, as in design §6);
// --fast is --scale 0.15. The hand summary always uses the full pause.
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

// Display order: trump first, then alternating colours.
function sortHand(hand, trump) {
  const order = !trump ? ['C', 'D', 'S', 'H']
    : { C: ['C', 'H', 'S', 'D'], S: ['S', 'H', 'C', 'D'], H: ['H', 'C', 'D', 'S'], D: ['D', 'C', 'H', 'S'] }[trump];
  return [...hand].sort((a, b) => {
    const sa = order.indexOf(st(a));
    const sb = order.indexOf(st(b));
    if (sa !== sb) return sa - sb;
    const ord = st(a) === trump ? TRUMP_ORDER : PLAIN_ORDER;
    return ord.indexOf(rk(a)) - ord.indexOf(rk(b));
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
  { id: 'henk', name: 'Opa Henk', emoji: '👴', color: '#8a5a2b', bio: 'Speelt al zestig jaar in café De Klaver. Voorzichtig en degelijk.' },
  { id: 'truus', name: 'Tante Truus', emoji: '👵', color: '#c2577a', bio: 'Kletst honderduit en is dol op roem.' },
  { id: 'sjaak', name: 'Sjaak', emoji: '🎲', color: '#d9822b', bio: 'Gokker: speelt op dunne handen en gaat voor de pit.' },
  { id: 'fatima', name: 'Fatima', emoji: '🧠', color: '#6a4fc4', bio: 'Wiskundestudent die elke kaart telt.' },
  { id: 'kees', name: 'Kees de Visser', emoji: '🎣', color: '#2f6f9f', bio: 'Mopperkont, maar eerlijk.' },
  { id: 'ans', name: 'Juf Ans', emoji: '👩‍🏫', color: '#3c9d6b', bio: 'Geduldige juf die graag uitlegt.' },
  { id: 'bram', name: 'Bram', emoji: '🛹', color: '#e0457b', bio: 'Jong en snel, speelt op gevoel.' },
  { id: 'lies', name: 'Bakker Lies', emoji: '🥐', color: '#b8862e', bio: 'Staat om vijf uur op, speelt scherp en vriendelijk.' },
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
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const rooms = new Map();
const DEFAULTS = { humans: 4, hands: 16, trumpMode: 'utrechts', rules: 'amsterdams', ai: 'normaal', tempo: 'normaal', open: false };

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
}

function prefill(room) {
  const want = room.opts.humans;
  const bots = { 1: [1, 2, 3], 2: [1, 3], 3: [3], 4: [] }[want];
  for (let s = 0; s < 4; s++) {
    const p = room.players[s];
    if (bots.includes(s) && !p) room.players[s] = botPlayer(room);
    if (!bots.includes(s) && p?.bot) room.players[s] = null;
  }
}

function createRoom(opts, training) {
  const room = {
    code: newCode(), opts: { ...DEFAULTS, ...pickOpts(opts) }, training, host: 0, seq: 0,
    players: [null, null, null, null], phase: 'lobby', handNo: 0, dealer: -1, deal: null,
    scores: [], total: [0, 0], prevHand: null, lastTrick: null, nextAt: 0, winner: -1,
    chat: [], timers: new Set(), rigged: RIG, lastBotChat: 0,
  };
  if (training) room.opts = { ...room.opts, humans: 1, tempo: opts?.tempo || 'rustig' };
  rooms.set(room.code, room);
  return room;
}

function pickOpts(o = {}) {
  const out = {};
  if ([1, 2, 3, 4].includes(o.humans)) out.humans = o.humans;
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
    players: room.players.map(p => p && {
      name: p.name, bot: p.bot, botId: p.botId || '', emoji: p.emoji || '', color: p.color || '',
      connected: p.bot ? true : p.connected, away: !!p.away, cards: playing ? d.hands[room.players.indexOf(p)].length : 0, ready: !!p.ready,
    }),
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
  };
  if (room.training && myTurn) s.hint = hintFor(room, seat);
  if (room.training && room.opts.open && playing) s.hands4 = d.hands.map((h, i) => (i === seat ? null : sortHand(h, d.trump)));
  return s;
}

function broadcast(room, ev) {
  room.seq++;
  room.players.forEach((p, seat) => {
    if (p && !p.bot && p.ws && p.connected) send(p.ws, { t: 'update', seq: room.seq, ev, s: stateFor(room, seat) });
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
  for (let s = 0; s < 4; s++) if (!room.players[s]) room.players[s] = botPlayer(room);
  room.scores = [];
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

function schedule(room) {
  const d = room.deal;
  if (!d || d.turn < 0 || !['trump', 'bid', 'play'].includes(room.phase)) return;
  const p = room.players[d.turn];
  if (!p.bot && !p.away) return;
  const seat = d.turn;
  later(room, delay(room, 'think') * (0.7 + rand() * 0.6), () => {
    if (room.deal !== d || d.turn !== seat) return;
    if (room.phase === 'trump') doTrump(room, seat, botTrump(d.hands[seat], d.forced ? d.turned : null));
    else if (room.phase === 'bid') doBid(room, seat, botBid(d.hands[seat], d.turned));
    else if (room.phase === 'play') doPlay(room, seat, botPlay(room, seat));
  });
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
  clearTimers(room);
  if (room.handNo >= room.opts.hands) {
    room.phase = 'gameOver';
    room.deal = null;
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
      } else prefill(r);
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
        const p = r.players[back];
        p.ws = ws;
        p.connected = true;
        conn.room = r;
        conn.seat = back;
        send(ws, { t: 'joined', code: r.code, seat: back, token: p.token });
        send(ws, { t: 'chatlog', msgs: r.chat });
        r.seq++;
        send(ws, { t: 'update', seq: r.seq, ev: null, s: stateFor(r, back) });
        broadcast(r, { type: 'back', seat: back });
        return;
      }
      if (r.training) return err('vol', 'Dit is een oefenspel; daar kun je niet bij.');
      if (r.phase === 'lobby') {
        const humans = r.players.filter(p => p && !p.bot).length;
        const free = r.players.findIndex(p => !p);
        if (humans >= r.opts.humans || free < 0) return err('vol', 'Deze tafel is vol.');
        seatHuman(ws, r, free, m.name);
        broadcast(r, { type: 'join', seat: free });
        sys(r, `${r.players[free].name} schuift aan.`);
        return;
      }
      const vac = r.players.findIndex(p => p?.vacated);
      if (vac < 0) return err('gestart', 'Dit spel is al begonnen.');
      seatHuman(ws, r, vac, m.name);
      broadcast(r, { type: 'join', seat: vac });
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
      if ('humans' in (m.opts || {})) prefill(room);
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
      if (room.players.every(p => !p || p.bot || p.ready || !p.connected)) later(room, 200, () => nextHand(room));
      return;
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
      if (room.phase === 'lobby') room.players[seat] = null;
      else room.players[seat] = { ...botPlayer(room), vacated: true };
      if (room.host === seat) {
        const next = room.players.findIndex(x => x && !x.bot);
        room.host = next >= 0 ? next : room.host;
      }
      broadcast(room, { type: 'leave', seat });
      sys(room, `${p?.name || 'Een speler'} is vertrokken.`);
      if (!room.players.some(x => x && !x.bot)) { clearTimers(room); rooms.delete(room.code); }
      else schedule(room);
      return;
    }
    default:
      return err('ongeldig', 'Onbekend bericht.');
  }
}

function seatHuman(ws, room, seat, name) {
  const clean = String(name || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 20) || 'Speler';
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
  ws.on('close', () => {
    const { room, seat } = ws.kj;
    const p = room?.players[seat];
    if (!p || p.ws !== ws) return;
    p.connected = false;
    p.ws = null;
    broadcast(room, { type: 'away', seat });
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock klaverjas on http://127.0.0.1:${PORT}/ (scale ${SCALE}${RIG ? ', rigged' : ''})`));
