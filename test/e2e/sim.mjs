#!/usr/bin/env node
// Plays full klaverjas games over the websocket protocol (docs/protocol.md,
// games/klaverjas/README.md#protocol) and checks invariants on every update.
// No dependencies: Node's global WebSocket. See README.md in this directory.
//
//   node test/e2e/sim.mjs --url ws://127.0.0.1:18200/ws --players 3 --humans 2 --trump gedraaid \
//     --rules rotterdams --ai sterk --hands 4 [--training] [--reconnect] [--games 3]
//   node test/e2e/sim.mjs http://127.0.0.1:18200      # the standard suite (make e2e)
//
// Exits 0 when every game finished with all invariants intact, 1 otherwise.

import { parseArgs } from 'node:util';

const USAGE = `usage: sim.mjs [URL] [--url ws://HOST:PORT/ws] [--players 2-4] [--humans 1-players] [--trump utrechts|gedraaid]
       [--rules amsterdams|rotterdams] [--ai makkelijk|normaal|sterk] [--hands 4|8|...|24]
       [--tempo rustig|normaal|snel] [--training] [--open] [--reconnect] [--games N] [--parallel] [--verbose]
--players: the seats at the table (default 4); --humans: how many of them simulated people take (default all).
--reconnect: players now and then drop the connection and come back with their seat token;
the others answer the question whether an AI may play for them meanwhile.
With only a URL, plays the standard suite of configurations.`;

const STALL_MS = 30000;
const IN_HAND = new Set(['auction', 'discard', 'trump', 'bid', 'play']);
const MOVES = new Set(['auction', 'discard', 'trump', 'bid', 'play']);
// Cards per seat (and tricks) at a table of 2, 3 or 4
// (games/klaverjas/README.md#rules-as-implemented).
const SIZE = { 2: 16, 3: 10, 4: 8 };
// The server's answer to a vote that crossed the end of its question (the
// player came back, the others agreed): told, not a failure, as long as the
// question did close or change after the vote was sent.
const LATE_VOTE = 'Die vraag staat niet (meer) open.';
// The server's answer to a hand asked to look back at, at a table of three
// or two (games/klaverjas/README.md#client--server).
const ALONE_FOUR = "Terugkijken kan alleen met z'n vieren.";

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      players: { type: 'string' },
      humans: { type: 'string' },
      trump: { type: 'string' },
      rules: { type: 'string' },
      ai: { type: 'string' },
      hands: { type: 'string' },
      tempo: { type: 'string' },
      training: { type: 'boolean' },
      open: { type: 'boolean' },
      reconnect: { type: 'boolean' },
      games: { type: 'string' },
      parallel: { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) {
  console.error(e.message + '\n' + USAGE);
  process.exit(2);
}
const opt = args.values;
if (opt.help) {
  console.log(USAGE);
  process.exit(0);
}

// The websocket URL: --url, or a positional http(s)/ws(s) URL; /ws is added
// to a bare host.
function wsURL(raw) {
  const u = new URL(raw || 'ws://127.0.0.1:18200/ws');
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}
const URL_WS = wsURL(opt.url || args.positionals[0]);

function oneOf(name, value, allowed, dflt) {
  const v = value ?? dflt;
  if (!allowed.includes(v)) {
    console.error(`--${name} must be one of ${allowed.join(', ')} (got ${v})\n${USAGE}`);
    process.exit(2);
  }
  return v;
}

const explicit = ['players', 'humans', 'trump', 'rules', 'ai', 'hands', 'tempo', 'training', 'open', 'reconnect'].some(k => opt[k] !== undefined);
const games = Number(opt.games ?? 1);
if (!Number.isInteger(games) || games < 1) {
  console.error('--games must be a positive integer');
  process.exit(2);
}

function config(o) {
  const training = !!o.training;
  const players = training ? 4 : Number(oneOf('players', o.players, ['2', '3', '4'], '4'));
  return {
    players,
    humans: training ? 1 : Number(oneOf('humans', o.humans, ['1', '2', '3', '4'].slice(0, players), String(players))),
    trumpMode: oneOf('trump', o.trump, ['utrechts', 'gedraaid'], 'utrechts'),
    rules: oneOf('rules', o.rules, ['amsterdams', 'rotterdams'], 'amsterdams'),
    ai: oneOf('ai', o.ai, ['makkelijk', 'normaal', 'sterk'], 'normaal'),
    hands: Number(oneOf('hands', o.hands, ['4', '8', '12', '16', '20', '24'], '4')),
    tempo: oneOf('tempo', o.tempo, ['rustig', 'normaal', 'snel'], training ? 'rustig' : 'normaal'),
    training,
    open: !!o.open,
    reconnect: !!o.reconnect,
  };
}

const SUITE = [
  { humans: '1', trump: 'utrechts', rules: 'amsterdams', ai: 'makkelijk', hands: '4' },
  { players: '3', humans: '2', rules: 'rotterdams', ai: 'normaal', hands: '4', tempo: 'snel' },
  { players: '3', humans: '1', rules: 'amsterdams', ai: 'sterk', hands: '8', reconnect: true },
  { players: '2', humans: '2', trump: 'gedraaid', ai: 'normaal', hands: '4' },
  { players: '2', humans: '1', trump: 'utrechts', ai: 'sterk', hands: '4', tempo: 'snel' },
  { humans: '2', trump: 'gedraaid', rules: 'rotterdams', ai: 'normaal', hands: '4', tempo: 'snel' },
  { humans: '3', trump: 'utrechts', rules: 'rotterdams', ai: 'sterk', hands: '4' },
  { humans: '4', trump: 'gedraaid', rules: 'amsterdams', ai: 'normaal', hands: '4', tempo: 'rustig' },
  { training: true, trump: 'gedraaid', rules: 'amsterdams', ai: 'normaal', hands: '4', open: true },
  { humans: '1', trump: 'gedraaid', rules: 'rotterdams', ai: 'sterk', hands: '16' },
  { humans: '3', trump: 'gedraaid', rules: 'amsterdams', ai: 'makkelijk', hands: '8', tempo: 'snel', reconnect: true },
];

const label = c => `${c.training ? 'training' : `${c.humans} human${c.humans > 1 ? 's' : ''} of ${c.players}`}, ` +
  `${c.trumpMode}/${c.rules}, ai ${c.ai}, ${c.hands} hands, tempo ${c.tempo}${c.open ? ', open' : ''}` +
  `${c.reconnect ? ', reconnects' : ''}`;

class Violation extends Error {}

// Card points (games/klaverjas/README.md#cards), for the soloist's discards.
function cardPoints(code, trump) {
  if (code[1] === trump) return { J: 20, 9: 14, A: 11, T: 10, K: 4, Q: 3 }[code[0]] ?? 0;
  return { A: 11, T: 10, K: 4, Q: 3, J: 2 }[code[0]] ?? 0;
}

let ipSeq = 0;
// A distinct client address per connection (and per process), sent as
// X-Real-IP, so many simulated players do not hit the per-address limits
// of the server (150 connections, 60 new rooms per 10 minutes).
const nextIP = () => {
  ipSeq++;
  return `10.${(process.pid >> 8) & 255}.${process.pid & 255}.${ipSeq & 255}`;
};

// Short Dutch card names as in the server's texts: "AH" is ♥A, "TC" ♣10.
const SUIT_SYMBOL = { C: '♣', D: '♦', H: '♥', S: '♠' };
const RANK_NL = { 7: '7', 8: '8', 9: '9', T: '10', J: 'B', Q: 'V', K: 'H', A: 'A' };
const cardNL = code => SUIT_SYMBOL[code[1]] + RANK_NL[code[0]];

const rand = n => Math.floor(Math.random() * n);
const pick = a => a[rand(a.length)];
// The side of a seat in a hand
// (games/klaverjas/README.md#rules-as-implemented): its team with four
// players, itself with two, with three 0 for the soloist and 1 for the
// other two.
const sideOf = (n, seat, soloist) => (n === 3 ? (seat === soloist ? 0 : 1) : seat % 2);

// One simulated human: connects, follows the protocol, plays randomly and
// checks every update.
class Player {
  constructor(game, n) {
    this.game = game;
    this.n = n;
    this.name = `Sim ${n}`;
    this.seat = -1;
    this.seq = -1;
    this.s = null;
    this.acted = -1;
    this.readied = 0;
    this.handEnds = 0;
    this.tips = 0;
    this.hints = 0;
    this.misses = []; // training: what the next tip must say was advised instead
    this.reconnects = 0;
    this.reconnecting = false;
    this.resync = true; // the next update is the state after (re)joining
    this.votes = 0;
    this.voteTimer = null;
    this.question = ''; // the open question as seen: seat, left and the seq it opened at
    this.lastVote = null; // {question, ai}: the answer sent last
    this.reviewsAsked = new Set(); // hands asked to look back at (handReview)
    this.handReviews = new Map(); // hand → its last handReview: {pending, choices}
    this.refusalDue = false; // a handReview asked at a table of three or two
    this.over = false;
    this.done = new Promise((res, rej) => { this.resolve = res; this.reject = rej; });
    this.joined = new Promise(res => { this.onJoined = res; });
  }

  where() {
    const s = this.s;
    return `game ${this.game.id}, ${this.name} (seat ${this.seat})` + (s ? `, hand ${s.handNo}, phase ${s.phase}, turn ${s.turn}` : '');
  }

  fail(msg) {
    const err = new Violation(`${this.where()}: ${msg}`);
    this.reject(err);
    this.game.fail(err);
  }

  open() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(URL_WS, { headers: { 'X-Real-IP': this.ip || (this.ip = nextIP()) } });
      this.ws = ws;
      let opened = false;
      ws.onopen = () => { opened = true; res(); };
      ws.onerror = () => {};
      ws.onclose = e => {
        if (!opened) rej(new Violation(`game ${this.game.id}: cannot connect to ${URL_WS} (code ${e.code})`));
        else if (!this.over && !this.game.finished && ws === this.ws) this.fail(`connection closed (code ${e.code} ${e.reason})`);
      };
      ws.onmessage = e => {
        if (ws !== this.ws) return;
        this.game.touch();
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          this.fail(`message is not JSON: ${String(e.data).slice(0, 80)}`);
          return;
        }
        try {
          this.handle(m);
        } catch (err) {
          if (err instanceof Violation) return;
          this.fail(`crashed on ${m.t}: ${err.stack || err}`);
        }
      };
    });
  }

  send(m) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  check(cond, msg) {
    if (!cond) {
      this.fail(msg);
      throw new Violation(msg);
    }
  }

  handle(m) {
    switch (m.t) {
      case 'joined':
        this.check(/^[A-HJ-NP-Z]{4}$/.test(m.code), `bad room code ${m.code}`);
        this.check(Number.isInteger(m.seat) && m.seat >= 0 && m.seat < 4, `bad seat ${m.seat}`);
        this.check(typeof m.token === 'string' && m.token.length >= 16, 'no seat token');
        if (this.token) this.check(m.seat === this.seat && m.token === this.token && m.code === this.code, 'came back at another seat');
        this.seat = m.seat;
        this.code = m.code;
        this.token = m.token;
        this.onJoined(m);
        break;
      case 'chatlog':
        this.check(Array.isArray(m.msgs) && m.msgs.length <= 50, 'bad chatlog');
        break;
      case 'chat':
        // At most 200 characters, as people may type; Juf Jannie's explanations
        // in training (coach) and the table's own lines (sys: the signals
        // agreed at the start) may run longer.
        this.check(m.msg && typeof m.msg.text === 'string' && m.msg.text.length > 0 && ([...m.msg.text].length <= 200 || m.msg.coach || m.msg.sys), 'bad chat message');
        if (m.msg.coach) this.check(this.game.cfg.training && m.msg.bot && m.msg.seat === 2, `coach line outside training or not of Juf Jannie: ${JSON.stringify(m.msg)}`);
        if (m.msg.bot) this.check(/ \(AI\)$/.test(m.msg.name), `bot chat without (AI): ${m.msg.name}`);
        break;
      case 'tip':
        this.check(typeof m.text === 'string' && m.text.length > 0, 'empty tip');
        this.tips++;
        // The last trick of a hand waits for its tip: read it now, or let
        // the time run out.
        if (this.s?.phase === 'play' && this.s.nextAt && Math.random() < 0.5) setTimeout(() => this.send({ t: 'tipRead' }), rand(30));
        // A trump, bid or card against the hint is told with the (first)
        // trick, and only then. A reconnect may lose a tip or a decision.
        if (!this.game.cfg.reconnect) {
          for (const want of this.misses) this.check(m.text.includes(want), `tip ${JSON.stringify(m.text)} does not say "${want}"`);
          if (!this.misses.length) this.check(!m.text.includes('aangeraden'), `tip ${JSON.stringify(m.text)} after following the hints`);
        }
        this.misses = [];
        break;
      case 'update':
        this.update(m);
        break;
      case 'error':
        // The update that closed the question comes before the refusal.
        if (m.code === 'ongeldig' && m.msg === LATE_VOTE && this.lastVote) {
          this.check(this.lastVote.question !== this.question, `a vote refused while its question ${this.question} is open`);
          this.game.lateVotes++;
          break;
        }
        // A hand to look back at, asked at a table of three or two.
        if (m.code === 'ongeldig' && m.msg === ALONE_FOUR && this.refusalDue) {
          this.refusalDue = false;
          break;
        }
        this.fail(`server error ${m.code}: ${m.msg}`);
        break;
      case 'handReview':
        this.checkHandReview(m);
        break;
      case 'pong':
        break;
      case 'refused': // someone could not join a full table: the host hears of it
        this.check(typeof m.name === 'string' && m.name.length > 0, 'refused without a name');
        this.check(this.s && this.s.host === this.s.you, 'refused sent to a player who is not the host');
        break;
      default:
        this.fail(`unknown message type ${m.t}`);
    }
  }

  update(m) {
    const s = m.s;
    const ev = m.ev;
    this.check(s && typeof s === 'object', 'update without state');
    this.check(Number.isInteger(m.seq), 'update without seq');
    if (ev) this.check(m.seq > this.seq, `seq did not increase: ${this.seq} -> ${m.seq} (${ev.type})`);
    else this.check(m.seq >= this.seq, `resync seq went back: ${this.seq} -> ${m.seq}`);
    this.seq = m.seq;
    const prev = this.s;
    this.s = s;
    if (this.game.verbose && ev) console.log(`  ${this.name}: #${m.seq} ${ev.type}`, JSON.stringify(ev));

    this.checkState(s, prev);
    if (ev?.type === 'handEnd') this.checkHandEnd(s, ev);
    this.checkConsent(s, prev, ev, m.seq);
    this.resync = false;
    // After a reconnect the game may already be over: the resync shows it.
    if (s.phase === 'gameOver' && !this.over) this.checkGameOver(s, ev?.type === 'gameOver' ? ev : { total: s.total, winner: s.winner });
    if (this.over) return;
    this.react(s);
    if (this.game.cfg.reconnect && !this.reconnecting && s.phase !== 'lobby' && Math.random() < 0.01) this.reconnect();
  }

  // checkConsent: no AI plays for an absent human without everyone's
  // consent. A move for a human seat comes from its player or from the
  // substitute (away); the substitute starts only with a takeover event,
  // and that event follows a yes of everyone asked, this player included;
  // away comes once per lost connection. A resync may show what happened
  // while this player was gone, so it only starts the bookkeeping.
  checkConsent(s, prev, ev, seq) {
    if (ev && MOVES.has(ev.type)) {
      const p = s.players[ev.seat];
      this.check(!(p && !p.bot && (p.left || (!p.connected && !p.away))), `${ev.type} for ${p?.name}, who is gone, without everyone's consent`);
    }
    const q = s.takeover;
    const was = this.question;
    const same = q && prev?.takeover && prev.takeover.seat === q.seat && prev.takeover.left === q.left && !this.resync;
    this.question = !q ? '' : same ? was : `${q.seat}|${q.left}|${seq}`;
    if (this.resync || !prev || prev.phase === 'lobby') return;
    // Seen by several players at the same seq: counted once.
    if (q && !same) this.game.questions.add(seq);
    s.players.forEach((p, i) => {
      const before = prev.players[i];
      if (p.away && !before?.away) this.check(ev?.type === 'takeover' && ev.seat === i, `an AI plays for ${p.name} without a takeover (event ${ev?.type})`);
    });
    if (ev?.type === 'away') {
      const before = prev.players[ev.seat];
      this.check(!before || before.bot || before.connected, `a second away for ${before?.name}, whose connection was gone already`);
    }
    if (ev?.type === 'takeover') {
      this.game.takeovers.add(seq);
      this.check(prev.takeover?.seat === ev.seat && was, `takeover of seat ${ev.seat} without a question about it`);
      this.check(this.lastVote?.question === was && this.lastVote.ai, `takeover of seat ${ev.seat} although this player's answer was ${JSON.stringify(this.lastVote)}`);
    }
  }

  // reconnect drops the connection and comes back with the seat token after
  // up to 1.5 s, often long enough for the others to be asked whether an AI
  // may play for this player (after 10 s, 0.5 s at -fast, on their turn).
  async reconnect() {
    this.reconnecting = true;
    this.resync = true;
    this.reconnects++;
    const old = this.ws;
    this.ws = null;
    try { old.close(); } catch { /* already closed */ }
    await new Promise(res => setTimeout(res, rand(1500)));
    if (this.game.finished) return;
    try {
      await this.open();
    } catch (err) {
      this.fail(err.message);
      return;
    }
    // What was sent while offline is lost: decide and press ready again
    // after the resync (summaries alone at the table wait for ready).
    this.acted = -1;
    this.readied = 0;
    this.send({ t: 'join', code: this.code, name: this.name, token: this.token });
    this.reconnecting = false;
  }

  checkState(s, prev) {
    const cfg = this.game.cfg;
    this.check(s.you === this.seat, `you=${s.you}, joined at ${this.seat}`);
    this.check(s.code === this.code, `code ${s.code}`);
    const n = cfg.players;
    this.check(Array.isArray(s.players) && s.players.length === n, `players must have ${n} entries`);
    const me = s.players[s.you];
    this.check(me && !me.bot && me.connected, 'own seat is not a connected human');
    for (const p of s.players) {
      if (p?.bot) this.check(/ \(AI\)$/.test(p.name) && p.botId, `bot without (AI) or id: ${p.name}`);
    }
    this.check(s.opts.trumpMode === cfg.trumpMode && s.opts.rules === cfg.rules, `opts ${JSON.stringify(s.opts)}`);
    this.check(s.training === cfg.training, 'training flag');
    if (s.phase === 'lobby') return;
    this.check(s.hands === cfg.hands, `hands ${s.hands}, want ${cfg.hands}`);
    this.check(s.players.every(p => p), 'empty seat after the start');

    const inHand = IN_HAND.has(s.phase);
    if (!inHand) {
      this.check(s.turn === -1, `turn ${s.turn} in phase ${s.phase}`);
      this.check(s.hand.length === 0, 'cards in hand outside a hand');
    } else {
      this.check(s.trick && Array.isArray(s.trick.cards), 'no trick during a hand');
      const done = s.tricksWon[0] + s.tricksWon[1];
      const open = s.trick.cards.length < n ? s.trick.cards : [];
      for (let seat = 0; seat < n; seat++) {
        const talon = s.phase === 'discard' && seat === s.soloist ? 2 : 0;
        const want = SIZE[n] - done - (open.some(pc => pc.seat === seat) ? 1 : 0) + talon;
        this.check(s.players[seat].cards === want, `seat ${seat} has ${s.players[seat].cards} cards, want ${want}`);
      }
      if (n === 2) {
        // The hand is the face-up cards on our piles.
        const up = s.piles[s.you].filter(p => p.card).map(p => p.card);
        this.check(s.hand.length === up.length && s.hand.every(c => up.includes(c)), `hand ${s.hand} is not our open cards ${up}`);
      } else {
        this.check(s.hand.length === s.players[s.you].cards, `hand has ${s.hand.length} cards, players says ${s.players[s.you].cards}`);
      }
      this.check(new Set(s.hand).size === s.hand.length, 'duplicate card in hand');
      if (n !== 2 && prev && IN_HAND.has(prev.phase) && prev.handNo === s.handNo && !(s.phase === 'discard' && prev.phase === 'auction')) {
        for (const c of s.hand) this.check(prev.hand.includes(c), `card ${c} appeared in the hand`);
      }
      if (cfg.trumpMode === 'gedraaid' && n !== 3 && s.phase === 'bid') this.check(s.turned, 'bidding without a turned suit');
      if (s.phase === 'play') {
        this.check(s.trump && s.trumpBy >= 0 && s.playingTeam === sideOf(n, s.trumpBy, s.soloist), 'play without trump');
      }
      if (n === 3 && s.phase !== 'auction') this.check(s.soloist >= 0 && s.bid >= 80 && s.bid % 10 === 0, `soloist ${s.soloist} bid ${s.bid}`);
    }

    // The question whether an AI may play for an absent player: only on
    // their turn, only to those connected, and only it gets answers.
    this.check('takeover' in s, 'state without takeover');
    const q = s.takeover;
    if (q) {
      const p = s.players[q.seat];
      this.check(inHand && s.turn === q.seat && q.seat !== s.you && p && !p.bot && !p.connected && !p.away && p.left === q.left,
        `takeover ${JSON.stringify(q)} in phase ${s.phase}, turn ${s.turn}: ${JSON.stringify(p)}`);
    }
    s.players.forEach((p, i) => {
      this.check(typeof p.left === 'boolean' && (p.vote === null || typeof p.vote === 'boolean'), `seat ${i} without left or vote`);
      // Who just lost the connection may still hold a no, never a yes.
      if (p.vote !== null) this.check(q && !p.bot && (p.connected || p.vote === false), `seat ${i} answers without a question`);
      if (p.left) this.check(!p.bot && !p.connected && !p.away, `seat ${i} left, but ${JSON.stringify(p)}`);
      if (p.left && s.turn === i) this.check(q, `the turn of seat ${i}, which its player left, but nobody is asked`);
    });

    const mine = inHand && s.turn === s.you;
    if (mine && s.phase === 'play') {
      this.check(Array.isArray(s.legal) && s.legal.length > 0, 'my turn without legal cards');
      for (const c of s.legal) this.check(s.hand.includes(c), `legal card ${c} not in hand`);
      this.check(typeof s.rule === 'string' && s.rule.length > 0, 'my turn without rule');
    } else {
      this.check(s.legal === undefined && s.rule === undefined, 'legal/rule while not my turn');
    }
    if (cfg.training && mine) {
      this.check(s.hint && s.hint.text, `no training hint in phase ${s.phase}`);
      if (s.phase === 'play' && s.hint.card) this.check(s.legal.includes(s.hint.card), `hint ${s.hint.card} is not legal`);
      this.hints++;
    }
    if (cfg.training && cfg.open && inHand) {
      this.check(Array.isArray(s.hands4) && s.hands4.length === 4, 'open cards without hands4');
      s.hands4.forEach((h, seat) => this.check(h.length === s.players[seat].cards, `hands4[${seat}] has ${h.length} cards`));
    } else {
      this.check(s.hands4 === null, 'hands4 outside open training');
    }
    if (s.phase !== 'gameOver') this.check(s.review === null, `review in phase ${s.phase}`);
    else if (s.review && !s.review.pending) {
      const r = s.review;
      this.check(Number.isInteger(r.pct) && r.pct >= 0 && r.pct <= 100, `review percentage ${r.pct}`);
      this.check(r.leads[0] <= r.leads[1] && r.trumps[0] <= r.trumps[1] && r.risky[1] <= r.risky[0], 'review counts out of order');
      this.check(r.missed.length <= Math.min(3, r.lostN) && r.strong.length <= Math.min(3, r.strongN), 'review lists too many moments');
      for (const m of [...r.missed, ...r.strong]) {
        this.check(m.hand >= 1 && m.hand <= s.handNo && (m.table || m.cards), `review moment ${JSON.stringify(m)}`);
        this.check(m.us - m.them === m.points && [...m.nat, ...m.natThem].every(p => p >= 0 && p <= 100), `review moment split ${JSON.stringify(m)}`);
      }
      for (const m of r.strong) this.check(!!m.alt, `strong moment without the obvious option ${JSON.stringify(m)}`);
      this.check(r.replay.length === s.handNo, `replay of ${r.replay.length} hands after ${s.handNo}`);
      r.replay.forEach((rh, h) => {
        this.checkReplayHand(rh, h + 1);
        // All grades are in: at least those of the hand looked back at,
        // and the same ones once that had none still out.
        const seen = this.handReviews.get(h + 1);
        if (seen) this.check(rh.choices.length >= seen.choices && (seen.pending > 0 || rh.choices.length === seen.choices), `hand ${h + 1} at game over has ${rh.choices.length} choices, its handReview ${JSON.stringify(seen)}`);
      });
      const sp = r.speed;
      this.check(sp === null || sp.n >= 1 && sp.median <= sp.slowest.ms && sp.slowest.ms <= sp.total, `review speed ${JSON.stringify(sp)}`);
      this.check(Number.isInteger(r.seed) && r.seed >= 1 && r.seed <= 999999999 && r.marks === undefined, `review seed ${r.seed}, marks ${JSON.stringify(r.marks)}`);
    }

    this.check(s.scores.length === (s.phase === 'handEnd' || s.phase === 'gameOver' ? s.handNo : s.handNo - 1),
      `${s.scores.length} score rows in hand ${s.handNo} (${s.phase})`);
    const total = s.total.map(() => 0);
    this.check(s.total.length === (n === 4 ? 2 : n), `total ${s.total} for ${n} players`);
    s.scores.forEach((r, i) => {
      this.check(r.hand === i + 1, `score row ${i} has hand ${r.hand}`);
      r.gains.forEach((g, k) => { total[k] += g; });
    });
    this.check(total.every((t, k) => t === s.total[k]), `total ${s.total} but the rows add up to ${total}`);
  }

  // A finished hand as the replay shows it: the 32 cards dealt, all played
  // by whoever held them, and this player's graded decisions in it by trick
  // (0 before the first card), each card one they played in that trick.
  checkReplayHand(rh, hand) {
    const dealt = new Set(rh.cards.flat());
    const played = rh.tricks.flatMap(t => t.cards);
    this.check(rh.hand === hand && dealt.size === 32 && played.length === 32 && played.every(pc => rh.cards[pc.seat].includes(pc.card)), `replay of hand ${hand} does not add up`);
    const mine = t => rh.tricks[t - 1]?.cards.find(pc => pc.seat === this.seat)?.card;
    const ok = Array.isArray(rh.choices) && rh.choices.every((d, k) => Number.isInteger(d.trick) && d.trick >= 0 && d.trick <= 8
      && (k === 0 || d.trick >= rh.choices[k - 1].trick)
      && (d.trick === 0 ? !d.played?.card && (!!d.played?.suit || typeof d.played?.play === 'boolean') : d.played?.card === mine(d.trick)));
    this.check(ok, `choices of hand ${hand}: ${JSON.stringify(rh.choices)}`);
  }

  // A hand asked to look back at (handReview), at its end; the server sends
  // it again with each grade of it that comes in: no fewer choices, no more
  // still out.
  checkHandReview(m) {
    this.check(this.reviewsAsked.has(m.hand), `handReview of hand ${m.hand}, which was not asked`);
    this.checkReplayHand(m.replay, m.hand);
    this.check(Number.isInteger(m.pending) && m.pending >= 0, `handReview of hand ${m.hand} with pending ${m.pending}`);
    const was = this.handReviews.get(m.hand);
    const now = { pending: m.pending, choices: m.replay.choices.length };
    if (was) this.check(now.pending <= was.pending && now.choices >= was.choices, `handReview of hand ${m.hand} went back: ${JSON.stringify(was)} → ${JSON.stringify(now)}`);
    this.handReviews.set(m.hand, now);
  }

  checkHandEnd(s, ev) {
    const r = ev.result;
    const n = this.game.cfg.players;
    this.handEnds++;
    this.check(r.players === n, `result for ${r.players} players`);
    this.check(r.points[0] + r.points[1] === 162, `card points ${r.points} do not add up to 162`);
    const roem = r.roem[0] + r.roem[1];
    const P = r.playingTeam;
    this.check(P === 0 || P === 1, `playing team ${P}`);
    // With three players the soloist (side 0) must make the bid; otherwise
    // the side that made trump more than half.
    const made = n === 3 ? r.points[0] + r.roem[0] >= r.bid : 2 * (r.points[P] + r.roem[P]) > 162 + roem;
    this.check(r.nat === !made, `nat ${r.nat} for points ${r.points}, roem ${r.roem}, bid ${r.bid}`);
    if (r.nat) {
      this.check(r.score[P] === 0 && r.score[1 - P] === 162 + roem, `nat scored ${r.score} (roem ${r.roem})`);
    } else {
      this.check(r.score[0] === r.points[0] + r.roem[0] && r.score[1] === r.points[1] + r.roem[1],
        `score ${r.score} from points ${r.points} and roem ${r.roem}`);
    }
    const gains = n === 4 ? r.score : n === 2 ? r.score
      : [0, 1, 2].map(seat => (seat === r.trumpBy ? r.score[0] : Math.ceil(r.score[1] / 2)));
    this.check(gains.every((g, k) => g === r.gains[k]) && r.gains.length === gains.length, `gains ${r.gains}, want ${gains}`);
    const side = seat => sideOf(n, seat, r.trumpBy);
    if (r.pit) this.check(r.pitTeam >= 0 && s.prevHand.tricks.every(t => side(t.winner) === r.pitTeam), 'pit without all tricks');
    const row = s.scores[s.scores.length - 1];
    this.check(row.hand === s.handNo && row.score[0] === r.score[0] && row.score[1] === r.score[1] && row.nat === r.nat,
      'last score row differs from the hand result');
    this.check(s.prevHand && s.prevHand.tricks.length === SIZE[n], `prevHand without ${SIZE[n]} tricks`);
    const cards = new Set(s.prevHand.tricks.flatMap(t => t.cards.map(pc => pc.card)));
    for (const c of r.discards) cards.add(c);
    this.check(cards.size === 32, `the tricks and discards hold ${cards.size} different cards`);
    const pts = [0, 0];
    for (const t of s.prevHand.tricks) pts[side(t.winner)] += t.points;
    if (n === 3) for (const c of r.discards) pts[0] += cardPoints(c, r.trump);
    this.check(pts[0] === r.points[0] && pts[1] === r.points[1], `trick points ${pts} vs result ${r.points}`);
    // The summary counts down to the next hand, except alone at the table
    // (training, or one person with bots): there it waits for ready.
    const people = s.players.filter(p => p && !p.bot && !p.left).length;
    if (people === 1) this.check(s.nextAt === 0, `handEnd alone with nextAt ${s.nextAt}`);
    else this.check(s.nextAt > 0, `handEnd of ${people} people without nextAt`);
    // Looking back at the hand: at a table of four every hand, else the
    // first is refused.
    if (n === 4) {
      this.reviewsAsked.add(s.handNo);
      this.send({ t: 'handReview', hand: s.handNo });
    } else if (s.handNo === 1) {
      this.refusalDue = true;
      this.send({ t: 'handReview', hand: s.handNo });
    }
  }

  checkGameOver(s, ev) {
    const cfg = this.game.cfg;
    this.check(s.handNo === cfg.hands && s.scores.length === cfg.hands, `game over after ${s.scores.length} hands, want ${cfg.hands}`);
    if (!this.reconnects) this.check(this.handEnds === cfg.hands, `saw ${this.handEnds} hand ends, want ${cfg.hands}`);
    this.check(ev.total.every((t, k) => t === s.total[k]), 'gameOver total differs from the state');
    const top = Math.max(...s.total);
    const w = s.total.filter(t => t === top).length > 1 ? -1 : s.total.indexOf(top);
    this.check(ev.winner === w && s.winner === w, `winner ${ev.winner} for total ${s.total}`);
    if (cfg.training && !this.reconnects) this.check(this.tips >= 8 * cfg.hands && this.hints > 0, `training: ${this.tips} tips, ${this.hints} hints`);
    // Every hand asked to look back at came back (the last one may still
    // be on its way), and the refusal at a table of three or two came.
    if (!cfg.reconnect) {
      const missing = [...this.reviewsAsked].filter(h => h < s.handNo && !this.handReviews.has(h));
      this.check(!missing.length && !this.refusalDue, `no handReview for hands ${missing}${this.refusalDue ? ', no refusal' : ''}`);
    }
    this.over = true;
    this.resolve(s);
  }

  // react makes this player's decision, if any, after a short random delay.
  react(s) {
    if (s.takeover && !this.voteTimer) this.voteTimer = setTimeout(() => this.vote(), rand(300));
    if (IN_HAND.has(s.phase) && s.turn === s.you && this.seq > this.acted) {
      this.acted = this.seq;
      setTimeout(() => this.decide(s), rand(15));
      if (Math.random() < 0.01) this.send({ t: 'chat', text: pick(['Mooi!', 'hoi', 'Goed gespeeld', '👍', 'haha']) });
    } else if (s.phase === 'handEnd' && this.readied < s.handNo) {
      this.readied = s.handNo;
      setTimeout(() => this.send({ t: 'ready' }), rand(30));
    }
  }

  // vote answers the open question: mostly yes, and a no is now and then
  // changed into a yes.
  vote() {
    this.voteTimer = null;
    const s = this.s;
    if (!s?.takeover || this.reconnecting || this.over) return;
    const mine = s.players[s.you].vote;
    // As the app: one answer at a time, until the table shows it.
    if (this.lastVote?.question === this.question && this.lastVote.ai !== mine) return;
    let ai;
    if (mine === null) ai = Math.random() < 0.7;
    else if (mine === false && Math.random() < 0.5) ai = true;
    else return;
    this.votes++;
    this.game.votes++;
    this.lastVote = { question: this.question, ai };
    this.send({ t: 'vote', seat: s.takeover.seat, left: s.takeover.left, ai });
  }

  decide(s) {
    if (s !== this.s || this.reconnecting) return; // the state moved on (e.g. a reconnect)
    const h = this.game.cfg.training ? s.hint : null;
    switch (s.phase) {
      case 'trump': {
        const suits = ['C', 'D', 'H', 'S'].filter(c => !(s.forced && c === s.turned));
        const suit = pick(suits);
        if (h?.suit && suit !== h.suit) this.misses.push(`${SUIT_SYMBOL[h.suit]} als troef aangeraden`);
        this.send({ t: 'trump', suit });
        break;
      }
      case 'bid': {
        const play = Math.random() < 0.3;
        if (typeof h?.play === 'boolean' && play !== h.play) this.misses.push(`aangeraden om te ${h.play ? 'spelen' : 'passen'}`);
        this.send({ t: 'bid', play });
        break;
      }
      case 'auction': {
        const lowest = s.bidder >= 0 ? s.bid + 10 : 80;
        this.send({ t: 'auction', bid: Math.random() < 0.35 ? lowest + 10 * rand(3) : 0 });
        break;
      }
      case 'discard': {
        const h2 = [...s.hand].sort(() => Math.random() - 0.5);
        this.send({ t: 'discard', cards: h2.slice(0, 2) });
        break;
      }
      case 'play': {
        const card = pick(s.legal);
        if (h?.card && card !== h.card) this.misses.push(`${cardNL(h.card)} aangeraden`);
        this.send({ t: 'play', card });
        break;
      }
    }
  }

  close() {
    this.over = true;
    clearTimeout(this.voteTimer);
    try { this.ws?.close(); } catch { /* already closed */ }
  }
}

let gameSeq = 0;

class Game {
  constructor(cfg, verbose) {
    this.id = ++gameSeq;
    this.cfg = cfg;
    this.verbose = verbose;
    this.finished = false;
    this.questions = new Set(); // seqs at which a question opened (whoever saw it)
    this.takeovers = new Set(); // seqs of takeover events
    this.votes = 0;
    this.lateVotes = 0; // votes that came after the question had closed
    this.last = Date.now();
    this.failed = new Promise((_, rej) => { this.reject = rej; });
    this.failed.catch(() => {});
  }

  touch() { this.last = Date.now(); }

  fail(err) {
    if (this.finished) return;
    this.finished = true;
    this.reject(err);
  }

  async play() {
    const cfg = this.cfg;
    const t0 = Date.now();
    this.players = Array.from({ length: cfg.humans }, (_, i) => new Player(this, i + 1));
    const watchdog = setInterval(() => {
      if (Date.now() - this.last > STALL_MS) {
        const where = this.players.map(p => p.where()).join('; ');
        this.fail(new Violation(`game ${this.id} stalled for ${STALL_MS / 1000} s: ${where}`));
      }
    }, 1000);
    try {
      await Promise.race([this.run(), this.failed]);
      const s = await Promise.race([Promise.all(this.players.map(p => p.done)), this.failed]);
      const final = s[0];
      const re = this.players.reduce((n, p) => n + p.reconnects, 0);
      const score = cfg.players === 4 ? `Wij ${final.total[final.you % 2]} - Zij ${final.total[1 - (final.you % 2)]}` : final.total.join(' - ');
      return `ok   game ${this.id} (${label(cfg)}) room ${final.code}: ${score}, ` +
        `${((Date.now() - t0) / 1000).toFixed(1)} s` + (cfg.reconnect ? `, ${re} reconnects, ${this.questions.size} questions, ` +
        `${this.votes} votes (${this.lateVotes} too late), ${this.takeovers.size} takeovers` : '');
    } finally {
      this.finished = true;
      clearInterval(watchdog);
      for (const p of this.players) p.close();
    }
  }

  async run() {
    const cfg = this.cfg;
    const [host, ...guests] = this.players;
    await Promise.all(this.players.map(p => p.open()));
    const start = cfg.training || cfg.humans === 1;
    host.send({
      t: 'create', name: host.name, training: cfg.training, start,
      opts: { players: cfg.players, hands: cfg.hands, trumpMode: cfg.trumpMode, rules: cfg.rules, ai: cfg.ai, tempo: cfg.tempo, open: cfg.open },
    });
    const j = await host.joined;
    for (const g of guests) {
      g.send({ t: 'join', code: j.code, name: g.name });
      await g.joined;
    }
    if (!start) {
      // Wait until the host's state shows everyone, then start.
      await new Promise((res, rej) => {
        const t = setInterval(() => {
          if (this.finished) { clearInterval(t); rej(new Error('failed before the start')); }
          const s = host.s;
          if (s && s.players.filter(p => p && !p.bot).length === cfg.humans) { clearInterval(t); res(); }
        }, 5);
      });
      host.send({ t: 'start' });
    }
  }
}

async function main() {
  const cfgs = explicit ? Array.from({ length: games }, () => config(opt)) : SUITE.flatMap(o => Array.from({ length: games }, () => config(o)));
  console.log(`klaverjas e2e: ${cfgs.length} game${cfgs.length > 1 ? 's' : ''} against ${URL_WS}`);
  const t0 = Date.now();
  let failures = 0;
  const runOne = async cfg => {
    try {
      console.log(await new Game(cfg, opt.verbose).play());
    } catch (err) {
      failures++;
      console.error(`FAIL ${err instanceof Violation ? '' : 'error: '}${err.message}`);
    }
  };
  if (opt.parallel) await Promise.all(cfgs.map(runOne));
  else for (const cfg of cfgs) await runOne(cfg);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (failures) {
    console.error(`${failures} of ${cfgs.length} games failed (${secs} s)`);
    process.exit(1);
  }
  console.log(`all ${cfgs.length} games passed (${secs} s)`);
  process.exit(0);
}

main();
