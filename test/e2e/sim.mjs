#!/usr/bin/env node
// Plays full klaverjas games over the websocket protocol (design §7) and
// checks invariants on every update. No dependencies: Node's global
// WebSocket. See README.md in this directory.
//
//   node test/e2e/sim.mjs --url ws://127.0.0.1:18200/ws --humans 2 --trump gedraaid \
//     --rules rotterdams --ai sterk --hands 4 [--training] [--reconnect] [--games 3]
//   node test/e2e/sim.mjs http://127.0.0.1:18200      # the standard suite (make e2e)
//
// Exits 0 when every game finished with all invariants intact, 1 otherwise.

import { parseArgs } from 'node:util';

const USAGE = `usage: sim.mjs [URL] [--url ws://HOST:PORT/ws] [--humans 1-4] [--trump utrechts|gedraaid]
       [--rules amsterdams|rotterdams] [--ai makkelijk|normaal|sterk] [--hands 4|8|...|24]
       [--tempo rustig|normaal|snel] [--training] [--open] [--reconnect] [--games N] [--parallel] [--verbose]
--reconnect: players now and then drop the connection and come back with their seat token.
With only a URL, plays the standard suite of configurations.`;

const STALL_MS = 30000;
const IN_HAND = new Set(['trump', 'bid', 'play']);

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string' },
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

const explicit = ['humans', 'trump', 'rules', 'ai', 'hands', 'tempo', 'training', 'open', 'reconnect'].some(k => opt[k] !== undefined);
const games = Number(opt.games ?? 1);
if (!Number.isInteger(games) || games < 1) {
  console.error('--games must be a positive integer');
  process.exit(2);
}

function config(o) {
  const training = !!o.training;
  return {
    humans: training ? 1 : Number(oneOf('humans', o.humans, ['1', '2', '3', '4'], '4')),
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
  { humans: '2', trump: 'gedraaid', rules: 'rotterdams', ai: 'normaal', hands: '4', tempo: 'snel' },
  { humans: '3', trump: 'utrechts', rules: 'rotterdams', ai: 'sterk', hands: '4' },
  { humans: '4', trump: 'gedraaid', rules: 'amsterdams', ai: 'normaal', hands: '4', tempo: 'rustig' },
  { training: true, trump: 'gedraaid', rules: 'amsterdams', ai: 'normaal', hands: '4', open: true },
  { humans: '1', trump: 'gedraaid', rules: 'rotterdams', ai: 'sterk', hands: '16' },
  { humans: '3', trump: 'gedraaid', rules: 'amsterdams', ai: 'makkelijk', hands: '8', tempo: 'snel', reconnect: true },
];

const label = c => `${c.training ? 'training' : c.humans + ' human' + (c.humans > 1 ? 's' : '')}, ` +
  `${c.trumpMode}/${c.rules}, ai ${c.ai}, ${c.hands} hands, tempo ${c.tempo}${c.open ? ', open' : ''}` +
  `${c.reconnect ? ', reconnects' : ''}`;

class Violation extends Error {}

let ipSeq = 0;
// A distinct client address per connection (and per process), sent as
// X-Real-IP, so many simulated players do not hit the per-address limits
// of the server (16 connections, 20 new rooms per 10 minutes).
const nextIP = () => {
  ipSeq++;
  return `10.${(process.pid >> 8) & 255}.${process.pid & 255}.${ipSeq & 255}`;
};

const rand = n => Math.floor(Math.random() * n);
const pick = a => a[rand(a.length)];
const sum2 = (a, b) => [a[0] + b[0], a[1] + b[1]];

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
    this.reconnects = 0;
    this.reconnecting = false;
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
        this.check(m.msg && typeof m.msg.text === 'string' && m.msg.text.length > 0 && [...m.msg.text].length <= 200, 'bad chat message');
        if (m.msg.bot) this.check(/ \(AI\)$/.test(m.msg.name), `bot chat without (AI): ${m.msg.name}`);
        break;
      case 'tip':
        this.check(typeof m.text === 'string' && m.text.length > 0, 'empty tip');
        this.tips++;
        break;
      case 'update':
        this.update(m);
        break;
      case 'error':
        this.fail(`server error ${m.code}: ${m.msg}`);
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
    if (ev?.type === 'away' && s.players[ev.seat]?.away) this.game.subs++;
    // After a reconnect the game may already be over: the resync shows it.
    if (s.phase === 'gameOver' && !this.over) this.checkGameOver(s, ev?.type === 'gameOver' ? ev : { total: s.total, winner: s.winner });
    if (this.over) return;
    this.react(s);
    if (this.game.cfg.reconnect && !this.reconnecting && s.phase !== 'lobby' && Math.random() < 0.01) this.reconnect();
  }

  // reconnect drops the connection and comes back with the seat token after
  // up to 1.5 s, sometimes long enough for a substitute to play (20 s at -fast).
  async reconnect() {
    this.reconnecting = true;
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
    // after the resync (training summaries wait for ready).
    this.acted = -1;
    this.readied = 0;
    this.send({ t: 'join', code: this.code, name: this.name, token: this.token });
    this.reconnecting = false;
  }

  checkState(s, prev) {
    const cfg = this.game.cfg;
    this.check(s.you === this.seat, `you=${s.you}, joined at ${this.seat}`);
    this.check(s.code === this.code, `code ${s.code}`);
    this.check(Array.isArray(s.players) && s.players.length === 4, 'players must have 4 entries');
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
      const open = s.trick.cards.length < 4 ? s.trick.cards : [];
      for (let seat = 0; seat < 4; seat++) {
        const want = 8 - done - (open.some(pc => pc.seat === seat) ? 1 : 0);
        this.check(s.players[seat].cards === want, `seat ${seat} has ${s.players[seat].cards} cards, want ${want}`);
      }
      this.check(s.hand.length === s.players[s.you].cards, `hand has ${s.hand.length} cards, players says ${s.players[s.you].cards}`);
      this.check(new Set(s.hand).size === s.hand.length, 'duplicate card in hand');
      if (prev && IN_HAND.has(prev.phase) && prev.handNo === s.handNo) {
        for (const c of s.hand) this.check(prev.hand.includes(c), `card ${c} appeared in the hand`);
      }
      if (cfg.trumpMode === 'gedraaid' && s.phase === 'bid') this.check(s.turned, 'bidding without a turned suit');
      if (s.phase === 'play') this.check(s.trump && s.trumpBy >= 0 && s.playingTeam === s.trumpBy % 2, 'play without trump');
    }

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

    this.check(s.scores.length === (s.phase === 'handEnd' || s.phase === 'gameOver' ? s.handNo : s.handNo - 1),
      `${s.scores.length} score rows in hand ${s.handNo} (${s.phase})`);
    let total = [0, 0];
    s.scores.forEach((r, i) => {
      this.check(r.hand === i + 1, `score row ${i} has hand ${r.hand}`);
      total = sum2(total, r.score);
    });
    this.check(total[0] === s.total[0] && total[1] === s.total[1], `total ${s.total} but the rows add up to ${total}`);
  }

  checkHandEnd(s, ev) {
    const r = ev.result;
    this.handEnds++;
    this.check(r.points[0] + r.points[1] === 162, `card points ${r.points} do not add up to 162`);
    const roem = r.roem[0] + r.roem[1];
    const P = r.playingTeam;
    this.check(P === 0 || P === 1, `playing team ${P}`);
    if (r.nat) {
      this.check(r.score[P] === 0 && r.score[1 - P] === 162 + roem, `nat scored ${r.score} (roem ${r.roem})`);
      this.check(2 * (r.points[P] + r.roem[P]) <= 162 + roem, 'nat although the playing team had more than half');
    } else {
      this.check(r.score[0] === r.points[0] + r.roem[0] && r.score[1] === r.points[1] + r.roem[1],
        `score ${r.score} from points ${r.points} and roem ${r.roem}`);
      this.check(2 * (r.points[P] + r.roem[P]) > 162 + roem, 'not nat although the playing team had at most half');
    }
    if (r.pit) this.check(r.pitTeam >= 0 && s.prevHand.tricks.every(t => t.winner % 2 === r.pitTeam), 'pit without all tricks');
    const row = s.scores[s.scores.length - 1];
    this.check(row.hand === s.handNo && row.score[0] === r.score[0] && row.score[1] === r.score[1] && row.nat === r.nat,
      'last score row differs from the hand result');
    this.check(s.prevHand && s.prevHand.tricks.length === 8, 'prevHand without 8 tricks');
    const cards = new Set(s.prevHand.tricks.flatMap(t => t.cards.map(pc => pc.card)));
    this.check(cards.size === 32, `the 8 tricks hold ${cards.size} different cards`);
    const pts = [0, 0];
    for (const t of s.prevHand.tricks) pts[t.winner % 2] += t.points;
    this.check(pts[0] === r.points[0] && pts[1] === r.points[1], `trick points ${pts} vs result ${r.points}`);
    // The summary counts down to the next hand, except in training: there it
    // waits for ready.
    if (this.game.cfg.training) this.check(s.nextAt === 0, `training handEnd with nextAt ${s.nextAt}`);
    else this.check(s.nextAt > 0, 'handEnd without nextAt');
  }

  checkGameOver(s, ev) {
    const cfg = this.game.cfg;
    this.check(s.handNo === cfg.hands && s.scores.length === cfg.hands, `game over after ${s.scores.length} hands, want ${cfg.hands}`);
    if (!this.reconnects) this.check(this.handEnds === cfg.hands, `saw ${this.handEnds} hand ends, want ${cfg.hands}`);
    this.check(ev.total[0] === s.total[0] && ev.total[1] === s.total[1], 'gameOver total differs from the state');
    const w = s.total[0] > s.total[1] ? 0 : s.total[1] > s.total[0] ? 1 : -1;
    this.check(ev.winner === w && s.winner === w, `winner ${ev.winner} for total ${s.total}`);
    if (cfg.training && !this.reconnects) this.check(this.tips >= 8 * cfg.hands && this.hints > 0, `training: ${this.tips} tips, ${this.hints} hints`);
    this.over = true;
    this.resolve(s);
  }

  // react makes this player's decision, if any, after a short random delay.
  react(s) {
    if (IN_HAND.has(s.phase) && s.turn === s.you && this.seq > this.acted) {
      this.acted = this.seq;
      setTimeout(() => this.decide(s), rand(15));
      if (Math.random() < 0.01) this.send({ t: 'chat', text: pick(['Mooi!', 'hoi', 'Goed gespeeld', '👍', 'haha']) });
    } else if (s.phase === 'handEnd' && this.readied < s.handNo) {
      this.readied = s.handNo;
      setTimeout(() => this.send({ t: 'ready' }), rand(30));
    }
  }

  decide(s) {
    if (s !== this.s || this.reconnecting) return; // the state moved on (e.g. a reconnect)
    switch (s.phase) {
      case 'trump': {
        const suits = ['C', 'D', 'H', 'S'].filter(c => !(s.forced && c === s.turned));
        this.send({ t: 'trump', suit: pick(suits) });
        break;
      }
      case 'bid':
        this.send({ t: 'bid', play: Math.random() < 0.3 });
        break;
      case 'play':
        this.send({ t: 'play', card: pick(s.legal) });
        break;
    }
  }

  close() {
    this.over = true;
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
    this.subs = 0; // substitutes seen taking over (counted by every player)
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
      const w = final.you % 2;
      const re = this.players.reduce((n, p) => n + p.reconnects, 0);
      return `ok   game ${this.id} (${label(cfg)}) room ${final.code}: Wij ${final.total[w]} - Zij ${final.total[1 - w]}, ` +
        `${((Date.now() - t0) / 1000).toFixed(1)} s${cfg.reconnect ? `, ${re} reconnects, substitutes seen ${this.subs}` : ''}`;
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
      opts: { humans: cfg.humans, hands: cfg.hands, trumpMode: cfg.trumpMode, rules: cfg.rules, ai: cfg.ai, tempo: cfg.tempo, open: cfg.open },
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
