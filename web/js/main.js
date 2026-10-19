// Entry point: routing, connection handling and the update queue that
// animates every server event before rendering the new state.
import { sound } from './sound.js';
import { app, store, toast, vibrate } from './util.js';
import { createNet } from './net.js';
import * as table from './table.js';
import * as panels from './panels.js';
import * as home from './home.js';

const PLAYING = new Set(['trump', 'bid', 'play']);
const ROUTE = /^\/([A-Za-z]{4})\/?$/;

let inRoom = false;   // joined a room (rejoin on reconnect)
let joining = false;  // create/join sent, waiting for "joined"
let queue = [];
let busy = false;
let lastSeq = -1;
let joinTimer = 0;

const net = createNet({ onMessage, onOpen, onClose });
app.send = m => net.send(m);
app.leave = leave;
app.create = create;
app.join = join;

function screen(name) {
  if (document.body.dataset.screen === name) return;
  document.body.dataset.screen = name;
  document.body.classList.toggle('in-room', name === 'lobby' || name === 'game');
  if (name === 'game') requestAnimationFrame(() => table.relayout());
}

// ---------- actions ----------

function create({ opts = {}, training = false, start = false }) {
  const name = home.currentName();
  if (!name) return;
  enterRoom('');
  startJoining();
  net.send({ t: 'create', name, opts, training, start });
}

function join(code) {
  code = code.toUpperCase();
  const name = store.get('name', '') || 'Speler';
  if (code !== app.code) enterRoom(code);
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
  if (app.code) {
    net.send({ t: 'leave' });
    store.del('token.' + app.code);
  }
  goHome();
}

// Clears all per-room state before entering a (new) room.
function enterRoom(code) {
  app.code = code;
  app.s = null;
  inRoom = false;
  queue = [];
  lastSeq = -1;
  table.resetRoom();
  home.resetLobby();
  panels.closeAll();
  panels.chatReset();
}

function goHome() {
  enterRoom('');
  joining = false;
  net.flushOutbox();
  history.replaceState(null, '', '/');
  document.title = 'Klaverjas';
  banner(false);
  screen('home');
  home.show();
}

// ---------- connection ----------

function onOpen() {
  banner(false);
  if (inRoom && app.code) {
    joining = true;
    const token = store.get('token.' + app.code, '');
    net.raw({ t: 'join', code: app.code, name: store.get('name', '') || 'Speler', ...(token ? { token } : {}) });
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
  switch (m.t) {
    case 'joined': onJoined(m); break;
    case 'update': if (inRoom) enqueue(m); break;
    case 'chat': if (inRoom) enqueue(m); break;
    case 'chatlog': if (inRoom) panels.chatSet(m.msgs); break;
    case 'tip': if (inRoom) enqueue(m); break;
    case 'error': onError(m); break;
    default: break;
  }
}

function onJoined(m) {
  const code = String(m.code || '').toUpperCase();
  if (code !== app.code) enterRoom(code);
  inRoom = true;
  joining = false;
  clearTimeout(joinTimer);
  home.setBusy(false);
  if (m.token) store.set('token.' + code, m.token);
  if (location.pathname !== '/' + code) history.replaceState(null, '', '/' + code);
  document.title = `Klaverjas · ${code}`;
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
        if (joining && app.code) store.del('token.' + app.code);
        sound.play('error');
        goHome();
        toast(msg, { kind: 'error', ms: 4000 });
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
  sound.play('error');
  toast(msg, { kind: 'error' });
  table.onError();
  // A refused lobby change: show the options as the server has them again.
  if (app.s?.phase === 'lobby') {
    home.resetLobby();
    home.renderLobby(app.s);
  }
}

// ---------- update queue ----------

function enqueue(m) {
  queue.push(m);
  pump();
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const m = queue.shift();
      const waiting = queue.filter(x => x.t === 'update').length;
      app.ff = document.hidden || waiting > 4;
      app.hurry = waiting >= 2;
      try {
        if (m.t === 'update') await applyUpdate(m);
        else if (m.t === 'chat') onChat(m.msg);
        else if (m.t === 'tip') table.setTip(m.text);
      } catch (e) {
        console.error(e);
      }
    }
  } finally {
    app.ff = false;
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
    screen('lobby');
    app.s = next;
    home.renderLobby(next);
    panels.sync(next, ev);
    if (ev && prev) await table.animate(ev, prev, next);
    return;
  }

  screen('game');
  if (ev && prev) await table.animate(ev, prev, next);
  app.s = next;
  table.settle(next);
  table.render(next);
  panels.sync(next, ev);
  turnCue(prev, next);
}

function turnCue(prev, next) {
  const mine = next.turn === next.you && PLAYING.has(next.phase);
  const was = prev && prev.turn === prev.you && prev.phase === next.phase;
  if (mine && !was && !app.ff) {
    sound.play('turn');
    vibrate(15);
  }
}

function onChat(msg) {
  if (!msg) return;
  panels.chatAdd(msg, true);
  if (app.s && msg.seat >= 0 && !msg.sys) table.bubble(app.s, msg.seat, msg.text);
}

// ---------- boot ----------

function boot() {
  panels.applyPrefs();
  table.init();
  home.init();
  panels.initChat();
  panels.refreshSound();

  const unlock = () => { sound.unlock(); };
  addEventListener('pointerdown', unlock, { once: true, capture: true });
  addEventListener('keydown', unlock, { once: true, capture: true });

  const r = location.pathname.match(ROUTE);
  screen('home');
  if (r) {
    const code = r[1].toUpperCase();
    if (store.get('name', '')) join(code);
    else {
      home.show();
      home.showInvite(code);
    }
  } else {
    if (location.pathname !== '/') history.replaceState(null, '', '/');
    home.show();
  }
  net.connect();
  document.getElementById('boot')?.remove();
  document.getElementById('boot-slow')?.remove();
}

boot();
