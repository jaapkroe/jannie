#!/usr/bin/env node
// Plays full matches of toepen over the websocket protocol
// (games/toepen/README.md#protocol) against a toepen server and checks
// invariants on every update, then keeps a score sheet with watchers
// (games/toepen/README.md#score-bijhouden). No dependencies: Node's global
// WebSocket. The toepen site's `make e2e`.
//
//   node test/e2e/toepen.mjs http://127.0.0.1:18096          # the standard suite
//   node test/e2e/toepen.mjs --url ws://127.0.0.1:18096/ws --players 5 --humans 2 --ai sterk --limit 15 [--no-was] [--no-armoede] [--no-koning] [--no-boer] [--lijntoep]
//
// Exits 0 when every match finished with all invariants intact, 1 otherwise.
import { parseArgs } from 'node:util';

const STALL_MS = 30000;
const IN_HAND = new Set(['discard', 'was', 'check', 'toep', 'play']);
const PHASES = new Set(['lobby', ...IN_HAND, 'handEnd', 'gameOver']);
// The keys of toepen's state (games/toepen/README.md#protocol); legal and
// rule on your turn to play, roster in the lobby.
const KEYS = ['code', 'phase', 'opts', 'you', 'host', 'players', 'turn', 'takeover', 'nextAt', 'winner', 'handNo',
  'dealer', 'voorhand', 'stake', 'toeper', 'armoedeToep', 'koning', 'size', 'wasRound', 'canRaise', 'mustStay', 'passCost', 'open', 'lay', 'laid', 'points',
  'status', 'armoede', 'washed', 'answered', 'claims', 'canClaim', 'claimant', 'asking', 'checks', 'stock', 'hand',
  'canToep', 'trick', 'lastTrick', 'tricks', 'rounds'];
const OPTS = ['players', 'ai', 'tempo', 'seed', 'limit', 'was', 'armoede', 'koning', 'boer', 'lijntoep', 'bluf'];
// The table's line at game over with the seed of the match, which no
// message names before (docs/server.md#the-seed).
const SEED_LINE = /^De seed van dit spel was (\d+)\.$/;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' }, players: { type: 'string' }, humans: { type: 'string' }, ai: { type: 'string' },
    limit: { type: 'string' }, tempo: { type: 'string' }, 'no-was': { type: 'boolean' }, 'no-armoede': { type: 'boolean' },
    'no-koning': { type: 'boolean' }, 'no-boer': { type: 'boolean' }, lijntoep: { type: 'boolean' }, 'no-bluf': { type: 'boolean' },
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
  limit: Number(o.limit || 10), was: !o['no-was'], armoede: !o['no-armoede'], koning: !o['no-koning'], boer: !o['no-boer'],
  lijntoep: !!o.lijntoep, bluf: !o['no-bluf'],
}] : [
  { players: 4, humans: 1, ai: 'normaal', tempo: 'snel', limit: 10, was: true, armoede: true, koning: true, boer: true, lijntoep: false, bluf: true },
  { players: 2, humans: 2, ai: 'normaal', tempo: 'snel', limit: 10, was: true, armoede: true, koning: true, boer: true, lijntoep: true, bluf: false },
  { players: 6, humans: 3, ai: 'makkelijk', tempo: 'snel', limit: 10, was: true, armoede: true, koning: true, boer: false, lijntoep: true, bluf: true },
  { players: 3, humans: 1, ai: 'sterk', tempo: 'snel', limit: 15, was: false, armoede: false, koning: false, boer: true, lijntoep: false, bluf: true },
  { players: 5, humans: 4, ai: 'normaal', tempo: 'snel', limit: 10, was: true, armoede: false, koning: true, boer: true, lijntoep: true, bluf: true },
];

// A witte or vuile was: four pictures, or three and a 7 (as rules.js).
const wasKind = hand => {
  const pics = hand.filter(c => 'JQKA'.includes(c[0])).length;
  return hand.length === 4 && (pics === 4 || pics === 3 && hand.some(c => c[0] === '7'));
};

const rng = (() => { let x = 0x2545f491; return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32); })();
const pick = a => a[Math.floor(rng() * a.length)];

// A simulated person at the table.
class Player {
  constructor(name, game, errors) {
    Object.assign(this, { name, game, errors, s: null, seat: -1, code: '', acted: '', wasIn: '', prev: null });
    this.raws = []; // every message as it came, for the seed
    this.overAt = -1; // the index in raws of the first update at game over
    this.seed = 0; // the seed named at game over
    this.ws = new WebSocket(url);
    this.open = new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = fail; });
    this.ws.onmessage = e => { this.raws.push(e.data); this.onMessage(JSON.parse(e.data)); };
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
      // A refusal of a move that crossed a change of turn is harmless, as is
      // that of a ready that crossed the last summary moving on by itself
      // into game over (the table answers it as it does for klaverjas).
      const crossed = m.msg === 'Dat kan nu niet.' && this.readyIn === this.s?.handNo && this.s?.phase === 'gameOver';
      if (m.code !== 'niet-jouw-beurt' && !/Die vraag staat niet/.test(m.msg) && !crossed) this.fail(`error ${m.code}: ${m.msg}`);
      return;
    }
    if (m.t === 'chat' && m.msg.sys && SEED_LINE.test(m.msg.text)) this.seedNamed(m.msg.text);
    if (m.t !== 'update') return;
    const s = m.s;
    if (s.phase === 'gameOver' && this.overAt < 0) this.overAt = this.raws.length - 1;
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
    if (s.hand.length > (s.koning ? s.phase === 'discard' ? 11 : 8 : 4)) this.fail(`hand of ${s.hand.length} in ${s.phase}`);
    if (s.lay && (s.phase !== 'discard' || s.turn !== s.you || s.hand.length - s.lay !== s.size)) this.fail(`lay ${s.lay} with ${s.hand.length} cards`);
    if (s.koning && s.phase === 'play' && s.handNo && this.koning !== s.handNo) this.koning = s.handNo, this.konings = (this.konings || 0) + 1;
    if (s.koning && !s.opts.koning) this.fail('a koningsspel without the rule');
    if (s.canRaise && s.phase !== 'toep') this.fail(`canRaise in ${s.phase}`);
    if (s.mustStay && !s.opts.lijntoep) this.fail('mustStay without anti-lijntoep');
    s.open.forEach((h, k) => {
      if (h.length && (!s.opts.bluf || s.status[k] !== 'in')) this.fail(`seat ${k} plays open: bluf ${s.opts.bluf}, ${s.status[k]}`);
      if (k === s.you && h.length && h.join() !== s.hand.join()) this.fail(`my open hand ${h} is not my hand ${s.hand}`);
    });
    if (s.phase === 'was' && s.canClaim && s.armoede[s.you] && !wasKind(s.hand)) this.fail('a bluff offered on armoede');
    for (const c of s.legal || []) if (!s.hand.includes(c)) this.fail(`legal ${c} not in hand`);
    const p = this.prev;
    if (p && p.handNo === s.handNo && p.phase !== 'lobby') {
      // Points only go up within a round, but for the boer: one off for the
      // winner of the last trick.
      const boer = k => s.opts.boer && s.tricks === s.size && s.lastTrick?.winner === k;
      s.points.forEach((n, k) => { if (n < p.points[k] - (boer(k) ? 1 : 0)) this.fail(`points of ${k} went down: ${p.points[k]} → ${n}`); });
    }
    if (s.phase === 'gameOver') {
      const left = s.points.filter(n => n < s.opts.limit).length;
      if (left !== 1 || s.points[s.winner] >= s.opts.limit) this.fail(`game over with ${left} left, winner ${s.winner}`);
    }
  }
  // seedNamed: the line with the seed (text) follows gameOver, and no
  // message before game over named that number; a seed under 10000 might
  // be a count, so it is not looked for.
  seedNamed(text) {
    const seed = Number(SEED_LINE.exec(text)[1]);
    if (this.s?.phase !== 'gameOver') this.fail(`the seed named in phase ${this.s?.phase}`);
    const num = new RegExp(`(^|[^0-9])${seed}([^0-9]|$)`);
    const at = this.raws.findIndex(r => num.test(r));
    if (seed >= 10000 && at < this.overAt) this.fail(`seed ${seed} in a message before game over: ${this.raws[at].slice(0, 200)}`);
    this.seed = seed;
  }
  // A random decision when the state awaits one of this player.
  act(s) {
    const me = s.you;
    const key = `${s.handNo}/${s.phase}/${s.turn}/${s.tricks}/${s.trick?.cards?.length}/${s.stake}/${s.claimant}/${s.wasRound}/${s.checks.length}/${s.asking.length}`;
    // Half the time ready, else the summary's own time moves on.
    if (s.phase === 'handEnd') {
      if (rng() < 0.5 && !s.players[me]?.ready) { this.readyIn = s.handNo; this.send({ t: 'ready' }); }
      return;
    }
    if (s.takeover && s.players[me]?.vote == null) { this.send({ t: 'vote', seat: s.takeover.seat, ai: true, left: s.takeover.left }); return; }
    if (s.phase === 'was') {
      const was = `${s.handNo}/${s.wasRound}`;
      if (!s.nextAt || s.status[me] !== 'in' || s.answered[me] || this.wasIn === was) return;
      this.wasIn = was;
      this.send({ t: 'was', play: s.canClaim && rng() < 0.15 });
      return;
    }
    if (s.turn !== me || key === this.acted) return;
    this.acted = key;
    if (s.phase === 'discard' && s.lay) {
      const hand = [...s.hand].sort(() => rng() - 0.5);
      this.send({ t: 'discard', cards: hand.slice(0, s.lay) });
      return;
    }
    if (s.phase === 'check') this.send({ t: 'check', play: rng() < 0.4 });
    else if (s.phase === 'toep' && s.canRaise && rng() < 0.12) this.send({ t: 'overtoep' });
    else if (s.phase === 'toep') this.send({ t: 'answer', play: s.mustStay || rng() < 0.75 });
    else if (s.phase === 'play' && s.canToep && rng() < 0.15) this.send({ t: 'toep' });
    else if (s.phase === 'play') this.send({ t: 'play', card: pick(s.legal) });
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

async function play(cfg, n) {
  const rules = ['was', 'armoede', 'koning', 'boer', 'lijntoep', 'bluf'].filter(k => cfg[k]).join(', ');
  const game = `match ${n} (${cfg.humans} of ${cfg.players}, ai ${cfg.ai}, tot ${cfg.limit}${rules ? `, ${rules}` : ''})`;
  const errors = [];
  const t0 = Date.now();
  const host = new Player('Host', game, errors);
  await host.open;
  const opts = { players: cfg.players, ai: cfg.ai, tempo: cfg.tempo, limit: cfg.limit, was: cfg.was, armoede: cfg.armoede,
    koning: cfg.koning, boer: cfg.boer, lijntoep: cfg.lijntoep, bluf: cfg.bluf };
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
      const key = s ? `${s.handNo}/${s.phase}/${s.turn}/${s.tricks}/${JSON.stringify(s.trick?.cards)}/${s.wasRound}/${s.checks.length}/${s.stake}` : '';
      if (key !== lastKey) { lastKey = key; last = Date.now(); }
      if (s?.phase === 'gameOver') { clearInterval(tick); ok(); }
      else if (Date.now() - last > STALL_MS) { clearInterval(tick); fail(new Error(`stalled in ${key}`)); }
    }, 100);
  }).catch(e => errors.push(`${game}: ${e.message}`));
  // Right after gameOver everyone gets the line with the seed.
  for (const t1 = Date.now(); people.some(p => !p.seed) && Date.now() - t1 < 5000;) await new Promise(ok => setTimeout(ok, 20));
  for (const p of people) if (!p.seed) p.fail('no line with the seed after game over');
  const s = host.s;
  for (const p of people) p.close();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (errors.length) {
    console.log(`FAIL ${game}: ${errors.slice(0, 5).join('; ')}`);
    return false;
  }
  const koning = host.konings ? `, koningsspel` : '';
  console.log(`ok   ${game}: ${s.handNo} potjes${koning}, winner seat ${s.winner}, points ${s.points.join('/')}, seed ${host.seed}, ${secs} s`);
  return true;
}

// Score bijhouden (games/toepen/README.md#score-bijhouden): a host keeps a
// sheet at /api/score until one player is left, two watchers see every
// version of it, and their own changes are refused.
async function scoreSheet() {
  const errors = [];
  const sheetUrl = url.replace(/\/ws$/, '/api/score');
  const conn = () => {
    const ws = new WebSocket(sheetUrl);
    const c = { ws, got: [], waiters: [] };
    c.open = new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      c.got.push(m);
      c.waiters = c.waiters.filter(w => (w.pred(m) ? (w.ok(m), false) : true));
    };
    c.send = m => ws.send(JSON.stringify(m));
    c.until = (pred, what) => {
      const had = c.got.find(pred);
      if (had) return Promise.resolve(had);
      return new Promise((ok, fail) => {
        c.waiters.push({ pred, ok });
        setTimeout(() => fail(new Error(`no ${what}`)), 5000);
      });
    };
    return c;
  };
  const t0 = Date.now();
  const names = ['Jaap', 'Kees', 'Truus', 'Bram'];
  const host = conn();
  await host.open;
  host.send({ t: 'new', limit: 10, names });
  const made = await host.until(m => m.t === 'sheet', 'sheet');
  if (!made.host || !made.token || !/^[A-HJ-NP-Z]{4}$/.test(made.sheet.code)) errors.push(`new: ${JSON.stringify(made)}`);
  const code = made.sheet.code;
  const watchers = [conn(), conn()];
  for (const w of watchers) {
    await w.open;
    w.send({ t: 'open', code: code.toLowerCase() });
    const m = await w.until(x => x.t === 'sheet', 'sheet for a watcher');
    if (m.host || m.token) errors.push('a watcher became host');
  }
  watchers[0].send({ t: 'delete', i: 0 });
  await watchers[0].until(m => m.t === 'error', 'refusal for a watcher');
  // Rounds until one player is left: random winners, some go away.
  const pts = names.map(() => 0);
  let version = made.sheet.version;
  let rounds = 0;
  while (pts.filter(p => p < 10).length > 1 && rounds < 60) {
    const ins = pts.flatMap((p, k) => (p < 10 ? [k] : []));
    const winner = pick(ins);
    const stake = 1 + Math.floor(rng() * 3);
    const passed = names.map((_, k) => pts[k] < 10 && k !== winner && rng() < 0.3);
    const gains = names.map((_, k) => (pts[k] >= 10 || k === winner ? 0 : passed[k] ? Math.max(1, stake - 1) : stake));
    gains.forEach((g, k) => { pts[k] += g; });
    host.send({ t: 'round', winner, gains, passed, stake });
    version++;
    rounds++;
    for (const c of [host, ...watchers]) {
      const m = await c.until(x => x.t === 'sheet' && x.sheet.version === version, `version ${version}`).catch(e => { errors.push(e.message); return null; });
      const got = m && m.sheet.rounds.reduce((acc, r) => acc.map((p, k) => p + r.gains[k]), names.map(() => 0));
      if (m && got.join() !== pts.join()) errors.push(`points ${got} != ${pts}`);
    }
    if (errors.length) break;
  }
  if (pts.filter(p => p < 10).length !== 1) errors.push(`no winner after ${rounds} rounds: ${pts}`);
  // The host again, from a new connection, with its token.
  const again = conn();
  await again.open;
  again.send({ t: 'open', code, token: made.token });
  const back = await again.until(m => m.t === 'sheet', 'sheet for the host again');
  if (!back.host || back.sheet.rounds.length !== rounds) errors.push('the host came back without its sheet');
  for (const c of [host, again, ...watchers]) c.ws.close();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (errors.length) {
    console.log(`FAIL score sheet: ${errors.slice(0, 5).join('; ')}`);
    return false;
  }
  console.log(`ok   score sheet ${code}: ${rounds} potjes, points ${pts.join('/')}, 2 watchers in step, ${secs} s`);
  return true;
}

let good = 0;
for (const [k, cfg] of suite.entries()) if (await play(cfg, k + 1)) good++;
// The standard suite only (one custom match leaves it out).
const custom = !!(o.players || o.humans || o.url);
const sheetOk = custom || await scoreSheet();
console.log(good === suite.length && sheetOk ? `all ${good} matches passed${custom ? '' : ', and the score sheet'}` : `${suite.length - good} of ${suite.length} matches FAILED${sheetOk ? '' : ', the score sheet FAILED'}`);
process.exit(good === suite.length && sheetOk ? 0 : 1);
