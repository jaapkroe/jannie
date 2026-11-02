#!/usr/bin/env node
// Plays full matches of toepen over the websocket protocol (docs/toepen.md)
// against a toepen server and checks invariants on every update. No
// dependencies: Node's global WebSocket. The toepen site's `make e2e`.
//
//   node test/e2e/toepen.mjs http://127.0.0.1:18096          # the standard suite
//   node test/e2e/toepen.mjs --url ws://127.0.0.1:18096/ws --players 5 --humans 2 --ai sterk --limit 15 [--no-was] [--no-armoede]
//
// Exits 0 when every match finished with all invariants intact, 1 otherwise.
import { parseArgs } from 'node:util';

const STALL_MS = 30000;
const IN_HAND = new Set(['was', 'check', 'toep', 'play']);
const PHASES = new Set(['lobby', ...IN_HAND, 'handEnd', 'gameOver']);
// The keys of toepen's state (docs/toepen.md); legal and rule on your turn
// to play, roster in the lobby.
const KEYS = ['code', 'phase', 'opts', 'you', 'host', 'players', 'turn', 'takeover', 'nextAt', 'winner', 'handNo',
  'dealer', 'voorhand', 'stake', 'toeper', 'armoedeToep', 'points', 'status', 'armoede', 'washed', 'answered', 'claims',
  'canClaim', 'claimant', 'asking', 'checks', 'stock', 'hand', 'canToep', 'trick', 'lastTrick', 'tricks', 'rounds'];
const OPTS = ['players', 'ai', 'tempo', 'seed', 'limit', 'was', 'armoede'];

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' }, players: { type: 'string' }, humans: { type: 'string' }, ai: { type: 'string' },
    limit: { type: 'string' }, tempo: { type: 'string' }, 'no-was': { type: 'boolean' }, 'no-armoede': { type: 'boolean' },
    verbose: { type: 'boolean' },
  },
});

function wsURL(raw) {
  const u = new URL(raw);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}

const url = wsURL(o.url || positionals[0] || 'http://127.0.0.1:18096');
const suite = o.players || o.humans || o.url ? [{
  players: Number(o.players || 4), humans: Number(o.humans || 1), ai: o.ai || 'normaal', tempo: o.tempo || 'snel',
  limit: Number(o.limit || 10), was: !o['no-was'], armoede: !o['no-armoede'],
}] : [
  { players: 4, humans: 1, ai: 'normaal', tempo: 'snel', limit: 10, was: true, armoede: true },
  { players: 2, humans: 2, ai: 'normaal', tempo: 'snel', limit: 10, was: true, armoede: true },
  { players: 6, humans: 3, ai: 'makkelijk', tempo: 'snel', limit: 10, was: true, armoede: true },
  { players: 3, humans: 1, ai: 'sterk', tempo: 'snel', limit: 15, was: false, armoede: false },
  { players: 5, humans: 4, ai: 'normaal', tempo: 'snel', limit: 10, was: true, armoede: false },
];

const rng = (() => { let x = 0x2545f491; return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32); })();
const pick = a => a[Math.floor(rng() * a.length)];

// A simulated person at the table.
class Player {
  constructor(name, game, errors) {
    Object.assign(this, { name, game, errors, s: null, seat: -1, code: '', acted: '', wasIn: -1, prev: null });
    this.ws = new WebSocket(url);
    this.open = new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = fail; });
    this.ws.onmessage = e => this.onMessage(JSON.parse(e.data));
    this.waiters = [];
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  fail(msg) { this.errors.push(`${this.game} ${this.name}: ${msg}`); }
  until(pred) {
    if (this.s && pred(this.s)) return Promise.resolve(this.s);
    return new Promise(ok => this.waiters.push({ pred, ok }));
  }
  onMessage(m) {
    if (m.t === 'joined') { this.seat = m.seat; this.code = m.code; return; }
    if (m.t === 'error') {
      // A refusal of a move that crossed a change of turn is harmless.
      if (m.code !== 'niet-jouw-beurt' && !/Die vraag staat niet/.test(m.msg)) this.fail(`error ${m.code}: ${m.msg}`);
      return;
    }
    if (m.t !== 'update') return;
    const s = m.s;
    this.check(s);
    this.prev = this.s;
    this.s = s;
    this.waiters = this.waiters.filter(w => (w.pred(s) ? (w.ok(s), false) : true));
    this.act(s);
  }
  check(s) {
    const keys = Object.keys(s).filter(k => !['legal', 'rule', 'roster'].includes(k)).sort();
    if (keys.join() !== [...KEYS].sort().join()) this.fail(`state keys ${keys.join()}`);
    if (Object.keys(s.opts).sort().join() !== [...OPTS].sort().join()) this.fail(`opts keys ${Object.keys(s.opts).join()}`);
    if (!PHASES.has(s.phase)) this.fail(`phase ${s.phase}`);
    if (s.hand.length > 4) this.fail(`hand of ${s.hand.length}`);
    for (const c of s.legal || []) if (!s.hand.includes(c)) this.fail(`legal ${c} not in hand`);
    const p = this.prev;
    if (p && p.handNo === s.handNo && p.phase !== 'lobby') {
      s.points.forEach((n, k) => { if (n < p.points[k]) this.fail(`points of ${k} went down: ${p.points[k]} → ${n}`); });
    }
    if (s.phase === 'gameOver') {
      const left = s.points.filter(n => n < s.opts.limit).length;
      if (left !== 1 || s.points[s.winner] >= s.opts.limit) this.fail(`game over with ${left} left, winner ${s.winner}`);
    }
  }
  // A random decision when the state awaits one of this player.
  act(s) {
    const me = s.you;
    const key = `${s.handNo}/${s.phase}/${s.turn}/${s.tricks}/${s.trick?.cards?.length}/${s.stake}/${s.claimant}`;
    if (s.phase === 'handEnd') { if (rng() < 0.5 && !s.players[me]?.ready) this.send({ t: 'ready' }); return; }
    if (s.takeover && s.players[me]?.vote == null) { this.send({ t: 'vote', seat: s.takeover.seat, ai: true, left: s.takeover.left }); return; }
    if (s.phase === 'was') {
      if (!s.nextAt || s.status[me] !== 'in' || s.answered[me] || this.wasIn === s.handNo) return;
      this.wasIn = s.handNo;
      this.send({ t: 'was', play: s.canClaim && rng() < 0.15 });
      return;
    }
    if (s.turn !== me || key === this.acted) return;
    this.acted = key;
    if (s.phase === 'check') this.send({ t: 'check', play: rng() < 0.4 });
    else if (s.phase === 'toep') this.send({ t: 'answer', play: rng() < 0.75 });
    else if (s.phase === 'play' && s.canToep && rng() < 0.15) this.send({ t: 'toep' });
    else if (s.phase === 'play') this.send({ t: 'play', card: pick(s.legal) });
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

async function play(cfg, n) {
  const game = `match ${n} (${cfg.humans} of ${cfg.players}, ai ${cfg.ai}, tot ${cfg.limit}${cfg.was ? ', was' : ''}${cfg.armoede ? ', armoede' : ''})`;
  const errors = [];
  const t0 = Date.now();
  const host = new Player('Host', game, errors);
  await host.open;
  const opts = { players: cfg.players, ai: cfg.ai, tempo: cfg.tempo, limit: cfg.limit, was: cfg.was, armoede: cfg.armoede };
  host.send({ t: 'create', name: 'Host', opts, start: cfg.humans === 1 });
  const people = [host];
  if (cfg.humans > 1) {
    await host.until(s => s.phase === 'lobby' && host.code);
    for (let k = 1; k < cfg.humans; k++) {
      const p = new Player(`Gast${k}`, game, errors);
      await p.open;
      p.send({ t: 'join', code: host.code, name: `Gast${k}` });
      await p.until(s => s.phase === 'lobby');
      people.push(p);
    }
    await host.until(s => s.players.filter(x => x && !x.bot).length === cfg.humans);
    host.send({ t: 'start' });
  }
  let last = Date.now();
  let lastKey = '';
  await new Promise((ok, fail) => {
    const tick = setInterval(() => {
      const s = host.s;
      const key = s ? `${s.handNo}/${s.phase}/${s.turn}/${s.tricks}/${JSON.stringify(s.trick?.cards)}` : '';
      if (key !== lastKey) { lastKey = key; last = Date.now(); }
      if (s?.phase === 'gameOver') { clearInterval(tick); ok(); }
      else if (Date.now() - last > STALL_MS) { clearInterval(tick); fail(new Error(`stalled in ${key}`)); }
    }, 100);
  }).catch(e => errors.push(`${game}: ${e.message}`));
  const s = host.s;
  for (const p of people) p.close();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (errors.length) {
    console.log(`FAIL ${game}: ${errors.slice(0, 5).join('; ')}`);
    return false;
  }
  console.log(`ok   ${game}: ${s.handNo} potjes, winner seat ${s.winner}, points ${s.points.join('/')}, ${secs} s`);
  return true;
}

let good = 0;
for (const [k, cfg] of suite.entries()) if (await play(cfg, k + 1)) good++;
console.log(good === suite.length ? `all ${good} matches passed` : `${suite.length - good} of ${suite.length} matches FAILED`);
process.exit(good === suite.length ? 0 : 1);
