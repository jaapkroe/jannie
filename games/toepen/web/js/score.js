// Score bijhouden (games/toepen/README.md#score-bijhouden): the score of
// toepen played at a real table, with real cards. The host, who makes the
// sheet, chooses the names and enters every round (who won, who went away,
// the points, + and −); everyone with the code watches on their own phone.
// No seats, no bots, no chat, no call: its own websocket (/api/score,
// games/toepen/scoresheet) and its own overlay. Loaded on demand
// (game.js), so a page load stays within its requests.
import { h, icon, toast, store, avatar, playerName, vibrate, copyText, chartBox } from './util.js';
import * as panels from './panels.js';
import { sound } from './sound.js';
import { meter } from './table.js';
import * as C from './scorecalc.js';
import { swatch, COLORS } from './chart.js';

const PING_MS = 20000;  // the page's own ping, as on /ws
const DEAD_MS = 8000;   // no answer this long after a ping: a dead socket
const KEEP_MS = 7 * 24 * 3600 * 1000; // the server forgets a sheet a week untouched
const RECENT = 6;

const S = {
  m: null,          // the overlay
  E: {},            // its parts
  ws: null,
  want: null,       // what to (re)open on a (new) socket: {code, token} or {make: {names, limit}}
  opening: false,   // an open or new sent, its answer not yet in
  live: false,      // the socket is up and the sheet current
  sheet: null,
  host: false,
  draft: null,      // the round the host is entering or changing
  busy: '',         // a change sent (its kind), awaiting the sheet
  form: null,       // the new-sheet form: {names, limit}
  error: '',
  wasOver: false,
  retry: 0,
  timers: { retry: 0, ping: 0, dead: 0 },
};

// Fills el with kids, leaving out what is not there (null, false).
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

const wsUrl = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/score';
const link = code => `${location.origin}/?score=${code}`;

// ---------- the sheets of this device ----------

function recents() {
  const list = store.json('scores', []);
  return (Array.isArray(list) ? list : []).filter(r => r && /^[A-Z]{4}$/.test(r.code) && Date.now() - (r.at || 0) < KEEP_MS);
}

function remember(sheet, token) {
  const old = recents();
  const was = old.find(r => r.code === sheet.code);
  store.setJSON('scores', [{ code: sheet.code, token: token || was?.token || '', names: sheet.names, at: Date.now() },
    ...old.filter(r => r.code !== sheet.code)].slice(0, RECENT));
}

const forget = code => store.setJSON('scores', recents().filter(r => r.code !== code));

// ---------- open and close ----------

// Opens the overlay: with a code, that sheet (as its host if this device
// made it); without, the start (a new sheet, one of before, or a code to
// watch).
export function open(code = '') {
  overlay();
  code = C.cleanCode(code);
  if (code.length === 4) watch(code);
  else start();
}

function overlay() {
  if (S.m && panels.byId('score') === S.m) return;
  const m = panels.openModal({ id: 'score', title: 'Score bijhouden', cls: 'm-score sc-modal', body: [] });
  // However it closes (×, back, Escape), the socket goes with it.
  const close = m.close;
  m.close = quiet => { close(quiet); if (S.m === m) stop(); };
  S.m = m;
}

function stop() {
  S.m = null;
  S.want = null;
  disconnect();
  Object.assign(S, { sheet: null, host: false, draft: null, busy: '', opening: false, error: '', wasOver: false });
  if (new URLSearchParams(location.search).has('score')) history.replaceState(history.state, '', '/');
}

function start(error = '') {
  S.want = null;
  disconnect();
  Object.assign(S, { sheet: null, host: false, draft: null, busy: '', error });
  if (new URLSearchParams(location.search).has('score')) history.replaceState(history.state, '', '/');
  S.m.titleEl.textContent = 'Score bijhouden';
  renderStart();
}

function watch(code) {
  const mine = recents().find(r => r.code === code);
  S.want = { code, token: mine?.token || '' };
  S.sheet = null;
  renderWaiting(code);
  reconnect();
}

function make(names, limit) {
  S.want = { make: { names, limit } };
  renderWaiting('');
  reconnect();
}

// ---------- the socket ----------

function connect() {
  if (S.ws || !S.want) return;
  clearTimeout(S.timers.retry);
  let ws;
  try { ws = new WebSocket(wsUrl()); } catch { later(); return; }
  S.ws = ws;
  ws.onopen = () => {
    S.retry = 0;
    hello();
    clearInterval(S.timers.ping);
    S.timers.ping = setInterval(ping, PING_MS);
  };
  ws.onmessage = e => {
    clearTimeout(S.timers.dead);
    let o;
    try { o = JSON.parse(e.data); } catch { return; }
    onMessage(o);
  };
  ws.onclose = () => { if (S.ws === ws) lost(); };
}

function ping() {
  if (S.ws?.readyState !== WebSocket.OPEN) return;
  send({ t: 'ping' });
  clearTimeout(S.timers.dead);
  const ws = S.ws;
  S.timers.dead = setTimeout(() => { if (S.ws === ws) lost(); }, DEAD_MS);
}

// The socket is gone: try again, a little later each time.
function lost() {
  const ws = S.ws;
  S.ws = null;
  if (ws) { ws.onclose = null; try { ws.close(); } catch { /* closed */ } }
  clearInterval(S.timers.ping);
  clearTimeout(S.timers.dead);
  S.live = false;
  S.opening = false;
  if (S.busy) { S.busy = ''; toast('Niet opgeslagen: de verbinding viel weg.', { kind: 'warn' }); }
  status();
  renderEntry();
  later();
}

function later() {
  clearTimeout(S.timers.retry);
  if (!S.want) return;
  S.timers.retry = setTimeout(connect, Math.min(10000, 700 * 2 ** S.retry++));
}

function reconnect() {
  disconnect();
  S.retry = 0;
  connect();
}

function disconnect() {
  const ws = S.ws;
  S.ws = null;
  if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch { /* closed */ } }
  clearTimeout(S.timers.retry);
  clearInterval(S.timers.ping);
  clearTimeout(S.timers.dead);
  S.live = false;
}

function send(m) {
  if (S.ws?.readyState !== WebSocket.OPEN) return false;
  S.ws.send(JSON.stringify(m));
  return true;
}

function hello() {
  S.opening = true;
  if (S.want.make) send({ t: 'new', ...S.want.make });
  else send({ t: 'open', code: S.want.code, token: S.want.token || undefined });
}

// Back from the background: a socket that died meanwhile is noticed now.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.want) return;
  if (!S.ws) reconnect();
  else ping();
});

function onMessage(o) {
  if (o.t === 'pong') return;
  if (o.t === 'error') {
    if (S.opening) {
      // The sheet is not there (any more), or none could be made.
      S.opening = false;
      if (S.want?.code) forget(S.want.code);
      start(o.msg);
      return;
    }
    S.busy = '';
    toast(o.msg, { kind: 'warn', ms: 4000 });
    renderEntry();
    return;
  }
  if (o.t !== 'sheet' || !o.sheet) return;
  const sheet = { ...o.sheet, rounds: o.sheet.rounds || [], names: o.sheet.names || [] };
  if (S.opening) {
    S.opening = false;
    S.host = !!o.host;
    if (o.token) S.want = { code: sheet.code, token: o.token };
    // Back after a lost connection, a half-entered round stays.
    if (S.sheet?.code !== sheet.code) {
      S.wasOver = C.matchWinner(sheet) >= 0;
      S.draft = null;
    }
  }
  const acked = S.busy;
  S.busy = '';
  S.sheet = sheet;
  S.live = true;
  remember(sheet, S.host ? S.want?.token : '');
  if (new URLSearchParams(location.search).get('score') !== sheet.code) history.replaceState(history.state, '', '/?score=' + sheet.code);
  if (acked === 'round') vibrate(15);
  if (['round', 'edit', 'delete', 'restart'].includes(acked)) S.draft = null;
  fitDraft();
  const over = C.matchWinner(sheet) >= 0;
  if (over && !S.wasOver) {
    sound.play('win');
    if (S.m) panels.confetti(S.m.dlg);
  }
  S.wasOver = over;
  renderSheet();
}

// ---------- the start ----------

function renderWaiting(code) {
  S.m.titleEl.textContent = code ? `Scorelijst ${code}` : 'Score bijhouden';
  put(S.m.body, h('p', { class: 'sc-wait', text: code ? 'De scorelijst wordt geopend…' : 'De scorelijst wordt gemaakt…' }));
}

function renderStart() {
  const myName = C.cleanName(store.get('name', ''));
  S.form ??= { names: [myName, '', '', ''], limit: 10 };
  const f = S.form;
  const E = {};
  const nameRow = k => {
    const input = h('input', {
      class: 'field sc-name-in', type: 'text', maxLength: C.MAX_NAME, value: f.names[k], placeholder: `Speler ${k + 1}`,
      autocomplete: 'off', enterKeyHint: k < f.names.length - 1 ? 'next' : 'done', 'aria-label': `Naam van speler ${k + 1}`,
      oninput: e => { f.names[k] = e.target.value; E.err.textContent = ''; },
      onkeydown: e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const next = E.list.querySelectorAll('input')[k + 1];
        if (next) next.focus();
        else e.target.blur();
      },
    });
    return h('div', { class: 'sc-name-row' }, sw(k), input,
      f.names.length > C.MIN_PLAYERS ? h('button', {
        class: 'icon-btn sc-del', type: 'button', 'aria-label': `Speler ${k + 1} weghalen`, title: 'Weghalen',
        onclick: () => { sound.play('click'); f.names.splice(k, 1); drawNames(); },
      }, icon('close')) : null);
  };
  const drawNames = () => {
    put(E.list, ...f.names.map((_, k) => nameRow(k)));
    E.add.hidden = f.names.length >= C.MAX_PLAYERS;
  };
  E.list = h('div', { class: 'sc-names' });
  E.add = h('button', {
    class: 'btn btn-ghost sc-add', type: 'button',
    onclick: () => {
      sound.play('click');
      f.names.push('');
      drawNames();
      E.list.querySelectorAll('input')[f.names.length - 1]?.focus();
    },
  }, icon('plus'), 'Speler erbij');
  E.err = h('p', { class: 'sc-err', role: 'alert' });
  drawNames();
  const begin = () => {
    // Empty rows are left out.
    const names = f.names.map(C.cleanName).filter(Boolean);
    const err = C.namesError(names);
    if (err) { E.err.textContent = err; sound.play('error'); return; }
    sound.play('click');
    f.names = names;
    make(names, f.limit);
  };

  const code = h('input', {
    class: 'field field-code', type: 'text', maxLength: 4, placeholder: 'CODE', autocomplete: 'off', autocapitalize: 'characters',
    spellcheck: false, enterKeyHint: 'go', 'aria-label': 'Code van de scorelijst, vier letters',
  });
  const go = () => {
    const v = C.cleanCode(code.value);
    if (v.length !== 4) { E.err2.textContent = 'Een code heeft vier letters.'; return; }
    sound.play('click');
    watch(v);
  };
  code.addEventListener('input', () => {
    const v = C.cleanCode(code.value);
    if (code.value !== v) code.value = v;
    E.err2.textContent = '';
  });
  code.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  E.err2 = h('p', { class: 'sc-err', role: 'alert' });

  const before = recents();
  put(S.m.body, 
    h('p', { class: 'sheet-note', text: 'Speel je aan een echte tafel, met echte kaarten? Houd hier de strafpunten bij. Wie de code heeft, kijkt op de eigen telefoon mee.' }),
    // Why the sheet asked for did not open, or none was made.
    h('p', { class: 'sc-err', role: 'alert', text: S.error }),
    before.length ? h('section', { class: 'sc-sec' }, h('h3', { text: 'Verder met' }),
      h('div', { class: 'sc-recent' }, before.map(r => h('button', {
        class: 'btn btn-ghost sc-recent-btn', type: 'button', onclick: () => { sound.play('click'); watch(r.code); },
      }, h('b', { class: 'sc-recent-code', text: r.code }),
      h('span', { class: 'sc-recent-txt' }, h('span', { text: (r.names || []).join(', ') }),
        h('small', { text: r.token ? 'Jij houdt bij' : 'Meekijken' })))))) : null,
    h('section', { class: 'sc-sec' }, h('h3', { text: 'Nieuwe scorelijst' }),
      E.list, E.add,
      h('div', { class: 'sc-opt' }, h('span', { class: 'sc-opt-lbl', text: 'Eruit bij' }),
        panels.segmented([[10, '10 punten'], [15, '15 punten']], f.limit, v => { f.limit = v; }, 'Eruit bij')),
      E.err,
      h('button', { class: 'btn btn-go btn-big', type: 'button', onclick: begin }, icon('score'), 'Begin met bijhouden')),
    h('section', { class: 'sc-sec' }, h('h3', { text: 'Meekijken' }),
      h('label', { class: 'join-lbl', for: 'sc-code', text: 'Met de code van wie de score bijhoudt' }),
      h('div', { class: 'join-row' }, code, h('button', { class: 'btn btn-join', type: 'button', onclick: go }, icon('enter'), 'Kijken')),
      E.err2));
  code.id = 'sc-code';
}

// ---------- the sheet ----------

function renderSheet() {
  const s = S.sheet;
  if (!S.m || !s) return;
  S.m.titleEl.textContent = `Scorelijst ${s.code}`;
  const E = S.E;
  if (!E.root?.isConnected) {
    E.bar = h('div', { class: 'sc-bar' });
    E.over = h('div', { class: 'sc-over', hidden: true });
    E.entry = h('section', { class: 'sc-entry', 'aria-label': 'Potje invoeren' });
    E.stand = h('section', { class: 'sc-sec' });
    E.chart = chartBox({ empty: 'Na het eerste potje zie je hier hoe de strafpunten oplopen.' });
    E.course = h('section', { class: 'sc-sec' }, h('h3', { text: 'Verloop' }), E.chart);
    E.rounds = h('section', { class: 'sc-sec' });
    E.tools = h('section', { class: 'sc-sec sc-tools' });
    E.root = h('div', { class: 'sc-root' }, E.bar, E.over, E.entry, E.stand, E.course, E.rounds, E.tools);
    put(S.m.body, E.root);
  }
  renderBar();
  renderOver();
  renderEntry();
  renderStand();
  // The chart stays in the page, with its tooltip and focus.
  E.chart.set(C.chartSpec(s));
  renderRounds();
  renderTools();
}

function renderBar() {
  const s = S.sheet;
  put(S.E.bar, 
    h('div', { class: 'sc-code', title: 'Met deze code kijkt iedereen mee' }, h('small', { text: 'Code' }), h('b', { text: s.code })),
    S.E.live = h('span', { class: 'sc-live', role: 'status' }),
    S.host ? h('button', { class: 'btn btn-ghost sc-share', type: 'button', onclick: share }, icon('share'), 'Laat meekijken')
    : [h('span', { class: 'chip sc-chip', text: 'Je kijkt mee' }),
      h('button', { class: 'icon-btn sc-share-ico', type: 'button', 'aria-label': 'Link delen', title: 'Link delen', onclick: share }, icon('share'))]);
  status();
}

function status() {
  const el = S.E.live;
  if (!el?.isConnected) return;
  el.classList.toggle('on', S.live);
  el.textContent = S.live ? 'Live' : 'Verbinden…';
  el.title = S.live ? 'Verbonden: je ziet elke wijziging meteen' : 'De verbinding is weg; de app probeert het steeds opnieuw';
}

async function share() {
  sound.play('click');
  const code = S.sheet.code;
  const url = link(code);
  const text = `Kijk mee met de stand van ons toepen, code ${code}:`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Toepen: de stand', text, url }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  if (await copyText(url)) toast('Link gekopieerd', { sub: url });
  else toast(`Code ${code}`, { sub: url, ms: 6000 });
}

function renderOver() {
  const s = S.sheet;
  const w = C.matchWinner(s);
  const el = S.E.over;
  el.hidden = w < 0;
  if (w < 0) { put(el); return; }
  const n = s.rounds.length;
  put(el, h('span', { class: 'sc-over-cup', 'aria-hidden': 'true', text: '🏆' }),
    h('div', { class: 'sc-over-txt' }, h('b', { text: `${s.names[w]} wint de partij!` }),
      h('small', { text: `Na ${n} ${n === 1 ? 'potje' : 'potjes'}.` })),
    S.host ? sureButton('Nog een partij', 'Zeker? De potjes gaan weg', () => change({ t: 'restart' }), 'btn btn-go sc-again') : null);
}

// A button that asks once more before it does what it says.
function sureButton(label, sure, fn, cls = 'btn btn-ghost') {
  let timer = 0;
  const b = h('button', {
    class: cls, type: 'button', text: label,
    onclick: () => {
      sound.play('click');
      if (!b.classList.contains('sure')) {
        b.classList.add('sure');
        b.textContent = sure;
        timer = setTimeout(() => { b.classList.remove('sure'); b.textContent = label; }, 3500);
        return;
      }
      clearTimeout(timer);
      fn();
    },
  });
  return b;
}

function change(m) {
  if (S.busy) return;
  if (!send(m)) { toast('Geen verbinding: probeer het zo nog eens.', { kind: 'warn' }); return; }
  S.busy = m.t;
  renderEntry();
}

// ---------- entering a round ----------

const outBefore = (s, index) => C.course(s)[index < 0 ? s.rounds.length : index].map(p => p >= s.limit);

function newDraft() {
  const s = S.sheet;
  const n = s.names.length;
  const d = { index: -1, stake: C.startStake(C.points(s), s.limit), winner: -1,
    passed: Array(n).fill(false), gains: Array(n).fill(0), touched: Array(n).fill(false) };
  fill(d);
  return d;
}

// The points of every row not set by hand follow from the stake, the
// winner and who went away.
function fill(d) {
  const out = outBefore(S.sheet, d.index);
  d.gains = d.gains.map((g, k) => {
    if (out[k]) return 0;
    return d.touched[k] ? g : C.defaultGain({ stake: d.stake, winner: d.winner, passed: d.passed[k], out: out[k] }, k);
  });
  d.passed = d.passed.map((p, k) => p && !out[k]);
}

// After a change from elsewhere: the draft still fits the sheet.
function fitDraft() {
  const d = S.draft;
  if (!d) return;
  const s = S.sheet;
  if (d.index >= s.rounds.length) { S.draft = null; return; }
  while (d.gains.length < s.names.length) { d.gains.push(0); d.passed.push(false); d.touched.push(false); }
  fill(d);
}

function edit(i) {
  const s = S.sheet;
  const r = s.rounds[i];
  if (!S.host || !r) return;
  sound.play('click');
  const n = s.names.length;
  const pad = (a, v) => Array.from({ length: n }, (_, k) => a?.[k] ?? v);
  const gains = pad(r.gains, 0);
  const passed = pad(r.passed, false);
  const lost = gains.filter((g, k) => k !== r.winner && !passed[k] && g > 0);
  S.draft = { index: i, stake: r.stake || (lost.length ? Math.max(...lost) : 1), winner: r.winner, passed, gains, touched: Array(n).fill(true) };
  renderEntry();
  renderRounds();
  S.E.entry.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function renderEntry() {
  const s = S.sheet;
  const el = S.E.entry;
  if (!el?.isConnected || !s) return;
  const over = C.matchWinner(s) >= 0;
  if (!S.host || (over && !(S.draft?.index >= 0))) { el.hidden = true; put(el); return; }
  el.hidden = false;
  S.draft ??= newDraft();
  const d = S.draft;
  const focus = document.activeElement?.dataset?.key;
  const editing = d.index >= 0;
  const no = editing ? d.index + 1 : s.rounds.length + 1;
  const before = C.course(s)[editing ? d.index : s.rounds.length];
  const out = before.map(p => p >= s.limit);
  const redraw = () => { fill(d); renderEntry(); };

  const stepper = (label, value, fn, key, min, max, txt = String(value)) => h('div', { class: 'sc-step' },
    h('button', { class: 'sc-pm', type: 'button', 'aria-label': `${label}: één minder`, disabled: value <= min, dataset: { key: key + '-' }, onclick: () => { sound.play('click'); fn(-1); } }, '−'),
    h('b', { class: 'sc-val', 'aria-live': 'polite', text: txt }),
    h('button', { class: 'sc-pm', type: 'button', 'aria-label': `${label}: één meer`, disabled: value >= max, dataset: { key: key + '+' }, onclick: () => { sound.play('click'); fn(1); } }, '+'));

  const rows = s.names.map((name, k) => {
    if (out[k]) return null;
    const g = d.gains[k];
    const won = d.winner === k;
    const armoede = before[k] === s.limit - 1;
    return h('div', { class: 'sc-row' + (won ? ' won' : '') + (d.passed[k] ? ' weg' : '') },
      h('span', { class: 'sc-who' }, sw(k), h('span', { class: 'sc-who-name', text: name }),
        armoede ? h('small', { class: 'sc-badge armoede', text: 'armoede' }) : null),
      h('button', {
        class: 'sc-win', type: 'button', 'aria-pressed': String(won), dataset: { key: `w${k}` },
        'aria-label': `${name} haalde de laatste slag`, title: 'Won het potje: haalde de laatste slag',
        onclick: () => {
          sound.play('click');
          if (d.winner >= 0) d.touched[d.winner] = false;
          d.winner = won ? -1 : k;
          d.passed[k] = false;
          d.touched[k] = false;
          redraw();
        },
      }, '🏆'),
      h('button', {
        class: 'sc-weg', type: 'button', 'aria-pressed': String(d.passed[k]), dataset: { key: `p${k}` },
        'aria-label': `${name} ging weg (paste op een toep)`, title: 'Ging weg: paste op een toep',
        onclick: () => {
          sound.play('click');
          d.passed[k] = !d.passed[k];
          if (d.passed[k] && d.winner === k) d.winner = -1;
          d.touched[k] = false;
          redraw();
        },
      }, 'Weg'),
      stepper(`Strafpunten van ${name}`, g, x => { d.gains[k] = g + x; d.touched[k] = true; renderEntry(); }, `g${k}`, -C.MAX_GAIN, C.MAX_GAIN,
        g > 0 ? `+${g}` : g < 0 ? `−${-g}` : '0'));
  });
  const outs = s.names.filter((_, k) => out[k]);
  const ready = C.validRound(d, s.names.length);
  const saving = !!S.busy;
  const save = () => {
    if (!ready) { toast('Kies eerst wie het potje won (🏆).', { kind: 'warn' }); return; }
    sound.play('click');
    const m = { winner: d.winner, gains: d.gains, passed: d.passed, stake: d.stake };
    change(editing ? { t: 'edit', i: d.index, ...m } : { t: 'round', ...m });
  };
  const hint = d.winner < 0 ? 'Wie haalde de laatste slag? Tik op 🏆.'
    : 'Wie paste op een toep: tik op Weg. Kloppen de punten niet (de boer, een vuile was)? Pas ze aan met − en +.';

  put(el, 
    h('div', { class: 'sc-entry-head' },
      h('h3', { text: editing ? `Potje ${no} aanpassen` : `Potje ${no}` }),
      h('div', { class: 'sc-stake' }, h('span', { class: 'sc-stake-lbl', text: 'Inzet' }),
        stepper('Inzet', d.stake, x => { d.stake += x; d.touched.fill(false); redraw(); }, 'stake', 1, C.MAX_GAIN))),
    h('p', { class: 'sc-hint', text: hint }),
    h('div', { class: 'sc-rows' }, rows),
    outs.length ? h('p', { class: 'sc-outs', text: `Eruit: ${outs.join(', ')}` }) : null,
    h('div', { class: 'sc-entry-btns' },
      h('button', { class: 'btn btn-go' + (ready ? '' : ' wait'), type: 'button', disabled: saving || !S.live, dataset: { key: 'save' }, onclick: save },
        icon('check'), saving ? 'Opslaan…' : !S.live ? 'Verbinden…' : editing ? 'Opslaan' : `Potje ${no} opslaan`),
      editing ? sureButton('Potje weghalen', 'Zeker? Tik nog eens', () => change({ t: 'delete', i: d.index })) : null,
      editing ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { sound.play('click'); S.draft = null; renderEntry(); renderRounds(); } }, 'Annuleren') : null));
  if (focus) el.querySelector(`[data-key="${focus}"]:not(:disabled)`)?.focus({ preventScroll: true });
}

// ---------- the standings, the chart, the rounds ----------

// Player k's colour beside the name: slot k, as the chart's line.
const sw = k => swatch(COLORS[k % COLORS.length]);

function avatarOf(k, cls) {
  const el = avatar({ name: S.sheet.names[k] }, cls);
  el.style.setProperty('--persona', COLORS[k % COLORS.length]);
  return el;
}

function renderStand() {
  const s = S.sheet;
  const w = C.matchWinner(s);
  const runs = C.runs(s);
  const last = s.rounds.at(-1);
  put(S.E.stand, h('h3', { text: 'Stand' }),
    h('div', { class: 'tp-sum-list' }, C.standings(s).map(x => {
      const run = runs[x.k];
      const lijn = !x.out && x.k !== w && run >= C.LIJN;
      const minus = last && last.gains?.[x.k] < 0 ? -last.gains[x.k] : 0;
      return h('div', { class: 'tp-sum-row sc-sum-row' + (x.out ? ' out' : '') + (x.k === w ? ' won' : '') + (lijn ? ' lijn' : '') },
        avatarOf(x.k, 'sm'),
        h('span', { class: 'sc-sum-who' }, playerName(x.name, { cls: 'tp-sum-name' }),
          x.out ? h('small', { class: 'sc-badge out', text: 'eruit' })
          : x.k === w ? null
          : lijn ? h('small', { class: 'sc-badge lijn', title: 'Lijntoepen: steeds passen en alleen meegaan met topkaarten', text: `${run}× achter elkaar weg` })
          : x.points === s.limit - 1 ? h('small', { class: 'sc-badge armoede', text: 'armoede' }) : null),
        h('span', { class: 'tp-sum-gain', text: x.k === w ? '🏆' : '' }),
        meter(x.points, s.limit, minus), h('b', { class: 'tp-sum-pts', text: String(x.points) }));
    })),
    h('p', { class: 'sheet-note', text: `Eruit bij ${s.limit} strafpunten; wie als laatste over is, wint.` }));
}

function renderRounds() {
  const s = S.sheet;
  const el = S.E.rounds;
  if (!el?.isConnected) return;
  if (!s.rounds.length) { put(el, h('h3', { text: 'Potjes' }), h('p', { class: 'sc-empty', text: 'Nog geen potjes.' })); return; }
  const n = s.names.length;
  const pts = C.course(s);
  const runs = C.streaks(s);
  const editing = S.draft?.index ?? -1;
  const head = h('tr', {}, h('th', { text: '#' }), s.names.map((name, k) => h('th', { title: name }, avatarOf(k, 'xs'))));
  const cell = (r, i, k) => {
    const before = pts[i][k];
    if (before >= s.limit) return h('td', { class: 'gone', text: '' });
    const g = r.gains?.[k] || 0;
    const after = pts[i + 1][k];
    const outNow = after >= s.limit;
    if (r.winner === k) {
      return h('td', { class: 'won', title: g < 0 ? 'Gewonnen met de boer: een strafpunt eraf' : 'Gewonnen' },
        '🏆', g < 0 ? h('span', { class: 'tp-minus', 'aria-label': `${g}` }) : null);
    }
    const txt = g > 0 ? `+${g}` : g < 0 ? `−${-g}` : '·';
    if (r.passed?.[k]) {
      const run = runs[i][k];
      const lijn = run >= C.LIJN;
      return h('td', { class: 'weg' + (lijn ? ' lijn' : '') + (outNow && g > 0 ? ' out' : ''), title: lijn ? `${run}× achter elkaar weg` : 'Weg: gepast op een toep' },
        h('span', { class: 'sc-weg-n', text: txt }), lijn ? h('i', { class: 'sc-run', text: `${run}×` }) : null);
    }
    return h('td', { class: outNow && g > 0 ? 'out' : '', text: txt });
  };
  const rows = s.rounds.map((r, i) => h('tr', S.host ? {
    class: 'sc-tr' + (i === editing ? ' editing' : ''), tabIndex: 0, role: 'button', 'aria-label': `Potje ${i + 1} aanpassen`,
    onclick: () => edit(i), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); edit(i); } },
  } : {}, h('td', { class: 'tp-st-n', text: String(i + 1) }), s.names.map((_, k) => cell(r, i, k))));
  const total = h('tr', { class: 'tp-st-total' }, h('td', { text: 'Σ' }),
    s.names.map((_, k) => h('td', { class: pts.at(-1)[k] >= s.limit ? 'out' : '', text: String(pts.at(-1)[k]) })));
  const anyWeg = s.rounds.some(r => r.passed?.some(Boolean));
  const anyLijn = runs.some(r => r.some(c => c >= C.LIJN));
  put(el, h('h3', { text: 'Potjes' }),
    S.host ? h('p', { class: 'sc-hint', text: 'Tik op een potje om het aan te passen of weg te halen.' }) : null,
    h('div', { class: 'tp-st-scroll sc-st-scroll' }, h('table', { class: 'tp-st-table sc-table', dataset: { n } },
      h('thead', {}, head), h('tbody', {}, rows, total))),
    anyWeg ? h('p', { class: 'sc-key-row' }, h('span', { class: 'sc-k weg', text: '+1' }), ' weggegaan',
      anyLijn ? [h('span', { class: 'sc-k weg lijn', text: '+1' }), ` ${C.LIJN}× of vaker achter elkaar weg: lijntoepen`] : null) : null);
}

function renderTools() {
  const s = S.sheet;
  const el = S.E.tools;
  if (!S.host) {
    put(el, h('p', { class: 'sheet-note', text: 'Alleen wie de score bijhoudt, kan iets aanpassen. Je ziet elke wijziging meteen.' }));
    return;
  }
  put(el, h('h3', { text: 'Scorelijst' }),
    h('div', { class: 'sc-opt' }, h('span', { class: 'sc-opt-lbl', text: 'Eruit bij' }),
      panels.segmented([[10, '10 punten'], [15, '15 punten']], s.limit, v => change({ t: 'limit', limit: v }), 'Eruit bij')),
    h('div', { class: 'btn-row sc-tool-btns' },
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: openNames }, icon('users'), 'Spelers'),
      s.rounds.length ? sureButton('Nieuwe partij', 'Zeker? De potjes gaan weg', () => change({ t: 'restart' })) : null),
    h('p', { class: 'sheet-note', text: 'De scorelijst blijft een week bewaard. Op dit toestel vind je hem terug onder Score bijhouden.' }));
}

// Renaming players or adding one: the server keeps everyone already on
// the sheet (their points stay theirs).
function openNames() {
  sound.play('click');
  const names = [...S.sheet.names];
  const had = names.length;
  const m = panels.openModal({ id: 'score-names', title: 'Spelers', cls: 'sc-names-m', body: [] });
  let err;
  const draw = () => {
    put(m.body, 
      h('p', { class: 'sheet-note', text: 'Pas een naam aan of zet er iemand bij; die begint op 0. Weghalen kan niet: wie stopt, blijft gewoon op de lijst.' }),
      h('div', { class: 'sc-names' }, names.map((name, k) => h('div', { class: 'sc-name-row' }, sw(k),
        h('input', {
          class: 'field sc-name-in', type: 'text', maxLength: C.MAX_NAME, value: name, placeholder: `Speler ${k + 1}`, autocomplete: 'off',
          'aria-label': `Naam van speler ${k + 1}`, oninput: e => { names[k] = e.target.value; err.textContent = ''; },
        }),
        k >= had ? h('button', { class: 'icon-btn sc-del', type: 'button', 'aria-label': 'Weghalen', title: 'Weghalen', onclick: () => { names.splice(k, 1); draw(); } }, icon('close')) : null))),
      names.length < C.MAX_PLAYERS ? h('button', {
        class: 'btn btn-ghost sc-add', type: 'button',
        onclick: () => { sound.play('click'); names.push(''); draw(); m.body.querySelectorAll('input')[names.length - 1]?.focus(); },
      }, icon('plus'), 'Speler erbij') : null,
      err = h('p', { class: 'sc-err', role: 'alert' }),
      h('div', { class: 'btn-col' },
        h('button', {
          class: 'btn btn-go', type: 'button',
          onclick: () => {
            const e = C.namesError(names);
            if (e) { err.textContent = e; return; }
            change({ t: 'names', names: names.map(C.cleanName) });
            m.close();
          },
        }, icon('check'), 'Opslaan'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, 'Annuleren')));
  };
  draw();
}
