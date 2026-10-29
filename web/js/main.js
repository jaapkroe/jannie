// Entry point: routing, connection handling and the update queue that
// animates every server event before rendering the new state.
import { sound } from './sound.js';
import { app, store, toast, vibrate, watchKeyboard, DEFAULT_NAME } from './util.js';
import { createNet } from './net.js';
import * as table from './table.js';
import * as panels from './panels.js';
import * as home from './home.js';

const PLAYING = new Set(['auction', 'discard', 'trump', 'bid', 'play']);
const ROUTE = /^\/([A-Za-z]{4})\/?$/;
// Moves the server answers at once; silence after one means a dead socket.
// A vote is only sent when it changes the answer, so an update follows it too.
const ACKED = new Set(['play', 'trump', 'bid', 'auction', 'discard', 'vote']);
const ACK_MS = 4000;
const START_HOLD_MS = 2500; // quick play: how long the lobby may stay hidden

let inRoom = false;   // joined a room (rejoin on reconnect)
let joining = false;  // create/join sent, waiting for "joined"
let starting = false; // created with start: the deal follows the lobby at once
let queue = [];
let busy = false;
let lastSeq = -1;
let joinTimer = 0;
let ackTimer = 0;
let startTimer = 0;
let leaveLater = null; // {code, token, name}: a leave that could not go out yet
let callLoad = null;   // call.js on its way
let callState = null;  // the latest state received, for call.js once it is there
let roomGen = 0;       // bumped by enterRoom: an update still animating belongs to a room left

const net = createNet({ onMessage, onOpen, onClose });
app.send = send;
app.leave = leave;
app.create = create;
app.join = join;

function screen(name) {
  if (document.body.dataset.screen === name) return;
  document.body.dataset.screen = name;
  document.body.classList.toggle('in-room', name === 'lobby' || name === 'game');
  if (name === 'game') requestAnimationFrame(() => table.relayout());
  panels.syncHistory();
}

// Sends a message. A move that gets no answer within ACK_MS was written
// to a dead socket (a phone that slept, a switch from wifi to 4G): the
// reconnect and its resync then give the table back.
function send(m) {
  const sent = net.send(m);
  if (sent && ACKED.has(m.t)) {
    clearTimeout(ackTimer);
    ackTimer = setTimeout(() => {
      ackTimer = 0;
      if (net.isOpen()) net.reconnect();
    }, ACK_MS);
  }
  return sent;
}

// ---------- actions ----------

// name: given for a game with bots only (Snel spelen, Oefenen, Expert),
// which needs none typed; otherwise the home screen asks for it. seat: the
// expert's seat (0–3).
function create({ opts = {}, training = false, expert = false, seat = 0, start = false, name = home.currentName() }) {
  if (!name) return;
  enterRoom('');
  setStarting(start);
  startJoining();
  net.send({ t: 'create', name, opts, training, start, ...(expert ? { expert, seat } : {}) });
}

function join(code) {
  code = code.toUpperCase();
  const name = store.get('name', '') || DEFAULT_NAME;
  if (leaveLater?.code === code) leaveLater = null; // back to that seat after all
  if (code !== app.code) enterRoom(code);
  setStarting(false);
  startJoining();
  const token = store.get('token.' + code, '');
  net.send({ t: 'join', code, name, ...(token ? { token } : {}) });
}

// Waits for "joined"; gives the buttons back when the server stays silent.
function startJoining() {
  joining = true;
  home.setBusy(true);
  clearTimeout(joinTimer);
  joinTimer = setTimeout(() => {
    if (!joining || inRoom) return;
    joining = false;
    net.flushOutbox();
    home.setBusy(false);
    sound.play('error');
    toast('Geen verbinding met de server', { sub: 'Controleer je internet en probeer het nog eens.', kind: 'error', ms: 4500 });
  }, 12000);
}

function leave() {
  const code = app.code;
  if (code && net.isOpen()) {
    net.send({ t: 'leave' });
    store.del('token.' + code);
  } else if (code) {
    // Offline: a leave in the outbox would be dropped with the room, and a
    // later connection has no room to leave. It goes out over a connection
    // of its own once the network is back, rejoining with the seat token
    // first; only then is the token deleted.
    const token = store.get('token.' + code, '');
    if (token) {
      leaveLater = { code, token, name: store.get('name', '') || DEFAULT_NAME };
      sendLeaveLater();
    }
  }
  goHome();
}

function sendLeaveLater() {
  const job = leaveLater;
  if (!job || job.busy) return;
  job.busy = true;
  net.oneShot([{ t: 'join', code: job.code, name: job.name, token: job.token }, { t: 'leave' }], sent => {
    job.busy = false;
    if (!sent || leaveLater !== job) return;
    leaveLater = null;
    store.del('token.' + job.code);
  });
}

// Clears all per-room state before entering a (new) room.
function enterRoom(code) {
  roomGen++;
  app.code = code;
  app.s = null;
  inRoom = false;
  clearTimeout(ackTimer);
  queue = [];
  lastSeq = -1;
  table.resetRoom();
  home.resetLobby();
  panels.closeAll();
  panels.chatReset();
  app.call?.leave();
  callState = null;
}

function goHome() {
  enterRoom('');
  setStarting(false);
  joining = false;
  net.flushOutbox();
  history.replaceState(history.state, '', '/');
  titleCue();
  banner(false);
  screen('home');
  home.show();
}

// ---------- connection ----------

function onOpen() {
  banner(false);
  sendLeaveLater(); // the network is back
  if (inRoom && app.code) {
    joining = true;
    const token = store.get('token.' + app.code, '');
    net.raw({ t: 'join', code: app.code, name: store.get('name', '') || DEFAULT_NAME, ...(token ? { token } : {}) });
    // Requests that went out over the old connection, before the queued
    // ones go out over this one.
    panels.onReconnect();
  }
}

function onClose() {
  if (inRoom || joining) banner(true);
}

let bannerTimer = 0;
function banner(on) {
  const el = document.getElementById('net-banner');
  clearTimeout(bannerTimer);
  if (on) bannerTimer = setTimeout(() => { el.hidden = false; }, 400);
  else el.hidden = true;
}

function onMessage(m) {
  if (m.t === 'update' || m.t === 'error') {
    clearTimeout(ackTimer); // the socket is alive
    ackTimer = 0;
  }
  switch (m.t) {
    case 'joined': onJoined(m); break;
    case 'update': if (inRoom) { toCall(m.s); enqueue(m); } break;
    case 'chat': if (inRoom) queueChat(m); break;
    case 'chatlog': if (inRoom) enqueue(m); break;
    case 'tip': if (inRoom) enqueue(m); break;
    case 'refused': if (inRoom) onRefused(m.name); break;
    case 'error': onError(m); break;
    case 'saved': panels.onSaved(m); break;
    case 'why': if (inRoom) import('./expert.js').then(x => x.onWhy(m)); break;
    case 'handReview': if (inRoom) panels.onHandReview(m); break;
    case 'rtc': if (inRoom) app.call?.onRTC(m); break;
    default: break;
  }
}

function onJoined(m) {
  const code = String(m.code || '').toUpperCase();
  if (code !== app.code) enterRoom(code);
  // A rejoin: what the table still shows as sent or in flight may never
  // have arrived. The resync that follows is the whole truth. A call goes
  // on from the new connection.
  else {
    enqueue({ t: 'rejoin' });
    app.call?.joined();
  }
  inRoom = true;
  joining = false;
  clearTimeout(joinTimer);
  if (!starting) home.setBusy(false);
  if (m.token) store.set('token.' + code, m.token);
  if (location.pathname !== '/' + code) history.replaceState(history.state, '', '/' + code);
  titleCue();
}

function onError(m) {
  const msg = m.msg || 'Er ging iets mis';
  switch (m.code) {
    case 'onbekend':
    case 'vol':
    case 'gestart':
      // The room is gone, cannot be joined, or our seat moved to another
      // window; only a failed join makes the stored seat token useless.
      if (m.code === 'onbekend' || joining || !inRoom) {
        const code = app.code;
        if (joining && code) store.del('token.' + code);
        sound.play('error');
        goHome();
        // A full table may get a free seat: trying again is one tap on Meedoen.
        if (m.code !== 'onbekend' && code) home.setCode(code);
        toast(msg, { kind: 'error', ms: m.code === 'onbekend' ? 4000 : 7000 });
        return;
      }
      break;
    case 'herstart':
      toast(msg, { ms: 4000 });
      banner(true);
      net.reconnect(1500);
      return;
    case 'te-veel-spellen':
    case 'limiet':
      joining = false;
      home.setBusy(false);
      break;
    default:
      break;
  }
  if (joining && !inRoom) {
    joining = false;
    home.setBusy(false);
  }
  if (table.staleVote(m)) return; // the question closed as we answered: no mistake
  sound.play('error');
  toast(msg, { kind: 'error' });
  table.onError();
  panels.onError();
  // A question to the AI still out gets its button back.
  if (app.s?.expert) import('./expert.js').then(x => x.onError());
  // A refused lobby change: show the options as the server has them again.
  if (app.s?.phase === 'lobby') {
    home.resetLobby();
    home.renderLobby(app.s);
  }
}

// Someone was turned away from this full table: the host hears who, and
// how to make room for them.
function onRefused(name) {
  const s = app.s;
  if (!s || s.host !== s.you || s.training) return;
  const n = s.players.length;
  const humans = s.players.filter(p => p && !p.bot && !p.left).length;
  const more = humans >= n && n < 4 ? `zet Spelers op ${n + 1}` : '';
  let sub = '';
  if (s.phase === 'lobby') {
    if (s.players.some(p => p?.bot)) sub = 'Haal een AI-speler weg om een plaats vrij te maken.';
    else if (more) sub = `Wil je er nog iemand bij? Zet Spelers op ${n + 1}.`;
  } else if (s.phase === 'gameOver') {
    sub = `Tik op Spelers of regels wijzigen${more ? ' en ' + more : ''} om een plaats vrij te maken.`;
  }
  sound.play('join');
  toast(`${name || 'Iemand'} wil meedoen, maar de tafel is vol`, { sub, ms: 7000 });
}

// ---------- the call ----------

// Every state goes to the call as it arrives, ahead of the animations: who
// is in the call decides the connections. call.js loads once someone else
// sits at the table, in a browser that can call (also one that offers a
// page no microphone or camera: it listens).
function toCall(s) {
  if (!s) return;
  callState = s;
  if (app.call) {
    app.call.state(s);
    return;
  }
  const others = s.players.some((p, seat) => seat !== s.you && p && !p.bot && p.connected);
  if (callLoad || !others || !window.RTCPeerConnection) return;
  callLoad = import('./call.js').then(m => {
    app.call = m;
    if (callState && inRoom) m.state(callState);
    table.renderCall();
    home.renderCall();
  }).catch(() => { callLoad = null; });
}

// ---------- update queue ----------

function enqueue(m) {
  queue.push(m);
  pump();
}

// A chat line waits its turn behind the table's animations, so a bubble
// comes with the move it is about; one we typed shows at once (a bot line
// at our seat, after a takeover, still waits). Ours still waits behind a
// queued chat log (a rejoin), which was sent before it and replaces the
// lines shown, and behind a line of ours queued there, to keep the order.
function queueChat(m) {
  const ours = x => x.t === 'chat' && x.msg && x.msg.seat === app.s?.you && !x.msg.sys && !x.msg.bot;
  if (ours(m) && !queue.some(x => x.t === 'chatlog' || ours(x))) onChat(m.msg);
  else enqueue(m);
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const m = queue.shift();
      const waiting = queue.filter(x => x.t === 'update').length;
      app.backlog = waiting > 4;
      app.ff = document.hidden || app.backlog;
      app.hurry = waiting >= 2;
      try {
        if (m.t === 'update') await applyUpdate(m);
        else if (m.t === 'chat') onChat(m.msg);
        else if (m.t === 'chatlog') panels.chatSet(m.msgs);
        else if (m.t === 'tip') table.setTip(m.text);
        else if (m.t === 'rejoin') table.resync();
      } catch (e) {
        console.error(e);
      }
    }
  } finally {
    app.ff = false;
    app.backlog = false;
    app.hurry = false;
    busy = false;
  }
}

async function applyUpdate(u) {
  const next = u.s;
  if (!next || !inRoom) return;
  if (u.ev && typeof u.seq === 'number' && u.seq <= lastSeq) return; // duplicate
  if (typeof u.seq === 'number') lastSeq = u.seq;
  let prev = app.s;
  if (prev && prev.code !== next.code) prev = null;
  const ev = u.ev || null;

  if (!prev || prev.you !== next.you) {
    app.s = next;
    panels.chatRefresh();
  }

  if (next.phase === 'lobby') {
    app.s = next;
    // Quick play and training start at once: the deal is on its way, so
    // the lobby would only flash by.
    if (starting) { holdLobby(); return; }
    screen('lobby');
    home.renderLobby(next, !!prev && prev.phase !== 'lobby');
    panels.sync(next, ev);
    if (ev && prev) await table.animate(ev, prev, next);
    return;
  }

  if (starting) {
    setStarting(false);
    home.setBusy(false);
  }
  screen('game');
  const gen = roomGen;
  if (ev && prev) await table.animate(ev, prev, next);
  if (gen !== roomGen) return; // left the table, or went to another, while it animated
  app.s = next;
  table.settle(next, ev);
  table.render(next);
  panels.sync(next, ev);
  table.welcomeBack(prev, next);
  turnCue(prev, next);
}

// Quick play and training (create with start) go from home straight to
// the table; the room's code changes on "joined", this flag stays.
function setStarting(on) {
  starting = on;
  clearTimeout(startTimer);
}

// Shows the lobby after all when the deal does not follow.
function holdLobby() {
  clearTimeout(startTimer);
  startTimer = setTimeout(() => {
    if (!starting || app.s?.phase !== 'lobby') return;
    starting = false;
    home.setBusy(false);
    screen('lobby');
    home.renderLobby(app.s);
    panels.sync(app.s, null);
  }, START_HOLD_MS);
}

// Sound and buzz when a turn opens, or when the table is asked whether an
// AI may play for someone who is gone (that asks for attention as much),
// also in a background tab; only a long backlog (a rejoin catching up) is
// history rather than news.
function turnCue(prev, next) {
  const mine = next.turn === next.you && PLAYING.has(next.phase);
  const was = prev && prev.turn === prev.you && prev.phase === next.phase;
  const q = next.takeover;
  const asked = !!q && !(prev?.takeover?.seat === q.seat && prev.takeover.left === q.left);
  if (((mine && !was) || asked) && !app.backlog) {
    sound.play('turn');
    vibrate(15);
  }
  titleCue();
}

// The tab title says when it is your turn while you look elsewhere, and
// while the table waits for your answer to the takeover question.
function titleCue() {
  const s = app.s;
  const mine = inRoom && s && s.turn === s.you && PLAYING.has(s.phase);
  const asked = inRoom && !!s?.takeover && s.players[s.you]?.vote == null;
  const base = inRoom && app.code ? `Klaverjas · ${app.code}` : 'Klaverjas';
  let want = base;
  if (document.hidden && mine) want = '● Jouw beurt · Klaverjas';
  else if (document.hidden && asked) want = '● Vraag aan tafel · Klaverjas';
  if (document.title !== want) document.title = want;
}

function onChat(msg) {
  if (!msg) return;
  panels.chatAdd(msg, true);
  // Juf Jannie's lessons and explanations show in the coach bubble already.
  if (app.s && msg.seat >= 0 && !msg.sys && !msg.coach) table.bubble(app.s, msg.seat, msg.text);
}

// ---------- boot ----------

function boot() {
  watchKeyboard(); // before the table listens to resizes: it reads the result
  panels.applyPrefs();
  table.init();
  home.init();
  panels.initChat();
  panels.refreshSound();

  const unlock = () => { sound.unlock(); };
  addEventListener('pointerdown', unlock, { once: true, capture: true });
  addEventListener('keydown', unlock, { once: true, capture: true });
  document.addEventListener('visibilitychange', titleCue);
  addEventListener('online', sendLeaveLater);

  const r = location.pathname.match(ROUTE);
  screen('home');
  if (r) {
    const code = r[1].toUpperCase();
    // A seat token is a seat of ours: a reload in Snel spelen or Oefenen,
    // which may be played without a name, goes back to it.
    if (store.get('name', '') || store.get('token.' + code, '')) join(code);
    else {
      home.show();
      home.showInvite(code);
    }
  } else {
    if (location.pathname !== '/') history.replaceState(history.state, '', '/');
    home.show();
  }
  net.connect();
  document.getElementById('boot')?.remove();
  document.getElementById('boot-slow')?.remove();
}

boot();
