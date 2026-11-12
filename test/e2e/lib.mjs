// What the games' e2e scripts share (sim.mjs, toepen.mjs and the test/e2e.mjs
// of a game of the overlay): the websocket URL, the line with the seed, a
// random source that is the same on every run, a simulated person's
// connection, the lobby, and the watch over a match until game over. No
// dependencies: Node's global WebSocket.

// The websocket URL of a server's http(s) or ws(s) URL; /ws is added to a
// bare host.
export function wsURL(raw) {
  const u = new URL(raw);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}

// The table's line at game over with the seed of the match, which no
// message names before (docs/server.md#the-seed).
export const SEED_LINE = /^De seed van dit spel was (\d+)\.$/;

export const rng = (() => { let x = 0x2545f491; return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32); })();
export const pick = a => a[Math.floor(rng() * a.length)];

// A simulated person's connection to a table of the server at url, from
// the address ip when given. A game's player extends it with
// onMessage(m), which keeps the last update's state in s, sets overAt and
// answers the waiters of until.
export class Seat {
  constructor(url, name, game, errors, ip = '') {
    Object.assign(this, { url, name, game, errors, ip, s: null, seat: -1, code: '', acted: '' });
    this.raws = []; // every message as it came, for the seed
    this.overAt = -1; // the index in raws of the first update at game over
    this.seed = 0; // the seed named at game over
    this.waiters = [];
    this.connect();
  }
  connect() {
    this.ws = this.ip ? new WebSocket(this.url, { headers: { 'X-Real-IP': this.ip } }) : new WebSocket(this.url);
    this.open = new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = fail; });
    this.ws.onmessage = e => { this.raws.push(e.data); this.onMessage(JSON.parse(e.data)); };
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  fail(msg) { this.errors.push(`${this.game} ${this.name}: ${msg}`); }
  until(pred) {
    if (this.s && pred(this.s)) return Promise.resolve(this.s);
    return new Promise(ok => this.waiters.push({ pred, ok }));
  }
  // answer hands the state s to the waiters of until.
  answer(s) { this.waiters = this.waiters.filter(w => (w.pred(s) ? (w.ok(s), false) : true)); }
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
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

// Sets a table up with humans people, each from seat(name): the host
// creates it with opts and starts alone, or the guests (Gast1, …) join by
// its code and the host starts when all are in. Returns the people, the
// host first.
export async function seatTable(seat, humans, opts) {
  const host = seat('Host');
  await host.open;
  host.send({ t: 'create', name: 'Host', opts, start: humans === 1 });
  const people = [host];
  if (humans > 1) {
    await host.until(s => s.phase === 'lobby' && host.code);
    for (let k = 1; k < humans; k++) {
      const p = seat(`Gast${k}`);
      await p.open;
      p.send({ t: 'join', code: host.code, name: `Gast${k}` });
      await p.until(s => s.phase === 'lobby');
      people.push(p);
    }
    await host.until(s => s.players.filter(x => x && !x.bot).length === humans);
    host.send({ t: 'start' });
  }
  return people;
}

// Waits until the host's state is game over, with an error when key(s),
// what moves in a match, stands still for stallMs; then for the line with
// the seed, which everyone gets right after.
export async function untilOver(people, key, stallMs) {
  const host = people[0];
  let last = Date.now();
  let lastKey = '';
  await new Promise((ok, fail) => {
    const tick = setInterval(() => {
      const s = host.s;
      const k = s ? key(s) : '';
      if (k !== lastKey) { lastKey = k; last = Date.now(); }
      if (s?.phase === 'gameOver') { clearInterval(tick); ok(); }
      else if (Date.now() - last > stallMs) { clearInterval(tick); fail(new Error(`stalled in ${k}`)); }
    }, 100);
  }).catch(e => host.errors.push(`${host.game}: ${e.message}`));
  for (const t1 = Date.now(); people.some(p => !p.seed) && Date.now() - t1 < 5000;) await new Promise(ok => setTimeout(ok, 20));
  for (const p of people) if (!p.seed) p.fail('no line with the seed after game over');
}
