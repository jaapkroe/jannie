// Calling the table (issue #43): sound and video between the people at a
// table, straight from browser to browser (WebRTC, a connection for every
// two of them). The server keeps who is in the call, with microphone and
// camera, and passes the session descriptions on (`call`, `rtc`, design
// §7). Loaded once another person sits at the table, like expert.js.
import { sound } from './sound.js';
import { app, h, icon, store, toast } from './util.js';
import * as panels from './panels.js';

// Public STUN servers tell each browser its address as the internet sees
// it; nothing of the call passes the game's own server. No TURN: where two
// networks allow no direct connection, those two do not hear each other.
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const GATHER_MS = 2500;   // waited for the addresses before a description goes out
const CONNECT_MS = 20000; // a connection not up by then has failed
const LOST_MS = 8000;     // a connection that drops may come back within this
const RETRIES = 3;        // fresh offers after a failure, 2, 4 and 6 s apart
const RESEND_MS = 4000;   // the server shows us otherwise this long after we said: say it again
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
// Small: the picture fills a seat's circle, and goes to every other player.
const VIDEO = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 20 }, facingMode: 'user' };
// The circle shows the picture at most about 160 device pixels wide: there
// 300 kbit/s looks the same as the 600 a browser allows 320x240, at half
// the data to and from every other player, and less encoding and decoding.
const VIDEO_BITRATE = 300000;

let s = null;        // the latest state received (the table may still animate an older one)
let me = null;       // our session while in the call: {id, sentAt}
let joining = false; // waiting for the microphone and camera to join
let busy = false;    // switching the microphone or camera
let mic = null;      // our tracks
let cam = null;
let micOn = false;   // what the others get
let camOn = false;
let asked = '';      // the room the call was proposed in
let gen = 0;         // bumped by hangup: a join still waiting for the devices is called off
let unlocking = false;
const peers = new Map(); // session id → {id, seat, offerer, pc, audio, video, mic, cam, live, up, failed, tries, timer}
const seen = new Set();  // sessions told as "belt mee"
const rings = new Set(); // elements that show a seat: its video, or the call's mark
const docks = new Set(); // elements that hold the call buttons
const box = h('div', { class: 'call-media', hidden: true });
const self = h('video', { class: 'call-video self', autoplay: true, muted: true, playsInline: true });
document.body.append(box);

// Remembered on the device (kj.call): microphone and camera as last chosen,
// and whether a game with other people proposes the call (Instellingen).
const prefs = () => ({ mic: true, cam: true, ask: true, ...store.json('call', {}) });
const remember = patch => store.setJSON('call', { ...prefs(), ...patch });

export const supported = () => !!(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia);
export const inCall = () => !!me;

// The other people at the table who are there now.
function others(st = s) {
  if (!st) return [];
  return st.players.flatMap((p, seat) => (seat !== st.you && p && !p.bot && p.connected ? [{ p, seat }] : []));
}

// Calling makes sense: someone else is at the table, or we are in a call.
export const possible = () => !!me || others().length > 0;

// ---------- state from the server ----------

// Every update as it arrives: who is in the call decides the connections.
export function state(next) {
  const prev = s;
  s = next;
  if (prev?.code !== next.code) seen.clear();
  for (const [seat, p] of next.players.entries()) {
    const id = p?.call?.id;
    if (!id || seat === next.you || seen.has(id)) continue;
    seen.add(id);
    // A newcomer to the call, not a call we found on arrival.
    if (prev?.code === next.code && !prev.players[seat]?.call) toast(`${p.name} belt mee`, { ms: 2200 });
  }
  reconcile();
  propose();
  refresh();
}

// A (re)join of the room: a call goes on with a session of its own, as the
// server ended the one of the old connection.
export function joined() {
  if (!me) return;
  for (const p of [...peers.values()]) closePeer(p);
  me.id = newId();
  sendCall();
}

function reconcile() {
  const mine = s?.players[s.you]?.call;
  const live = !!me && mine?.id === me.id;
  if (me && (!mine || mine.id !== me.id || mine.mic !== micOn || mine.cam !== camOn) && Date.now() - me.sentAt > RESEND_MS) sendCall();
  const want = new Map();
  if (live) {
    s.players.forEach((p, seat) => {
      if (seat !== s.you && p?.call && p.connected) want.set(p.call.id, { seat, ...p.call });
    });
  }
  for (const [id, p] of [...peers]) if (!want.has(id)) closePeer(p);
  for (const [id, c] of want) {
    const p = peers.get(id) || addPeer(id, c.seat);
    p.seat = c.seat;
    p.mic = c.mic;
    p.cam = c.cam;
  }
}

// At the start of a game with other people, once per room: join the call?
function propose() {
  if (me || joining || !s || s.training || s.phase === 'lobby' || asked === s.code || !others().length) return;
  asked = s.code;
  if (prefs().ask) openSheet({ proposal: true });
}

// ---------- joining, switching, hanging up ----------

const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');

function sendCall() {
  if (!me) return;
  me.sentAt = Date.now();
  app.send({ t: 'call', id: me.id, mic: micOn, cam: camOn });
}

async function join(wantMic, wantCam) {
  if (me || joining) return;
  const g = ++gen;
  joining = true;
  refresh();
  // iOS: an audio session that records (sound.js), before the microphone is asked.
  sound.setCall(true);
  const got = await acquire(wantMic, wantCam);
  if (g !== gen) { // hung up, or left the table, meanwhile (hangup gave the session back)
    stopTracks(got);
    return;
  }
  joining = false;
  mic = got.mic;
  cam = got.cam;
  micOn = !!mic;
  camOn = !!cam;
  watchEnd(mic);
  watchEnd(cam);
  remember({ mic: wantMic && !got.missing.mic, cam: wantCam && !got.missing.cam });
  me = { id: newId(), sentAt: 0 };
  attachAll();
  sendCall();
  sound.play('join');
  refresh();
}

export function hangup(tell = true) {
  gen++;
  joining = false;
  sound.setCall(false);
  if (!me) {
    refresh();
    return;
  }
  for (const p of [...peers.values()]) closePeer(p);
  stopTracks({ mic, cam });
  mic = cam = null;
  micOn = camOn = false;
  self.srcObject = null;
  me = null;
  if (tell) app.send({ t: 'call', id: '' });
  refresh();
}

// Leaving the room: the server ends the call with the seat.
export function leave() {
  hangup(false);
  s = null;
  refresh();
}

async function setMic(on) {
  const cur = me;
  if (!cur || busy) return;
  busy = true;
  refresh();
  if (on && mic?.readyState !== 'live') {
    const got = await acquire(true, false);
    if (me === cur) watchEnd(mic = got.mic);
    else stopTracks(got);
  }
  busy = false;
  if (me !== cur) return;
  if (mic) mic.enabled = on;
  micOn = on && !!mic;
  remember({ mic: on });
  attachAll();
  sendCall();
  refresh();
}

async function setCam(on) {
  const cur = me;
  if (!cur || busy) return;
  busy = true;
  refresh();
  if (on && cam?.readyState !== 'live') {
    const got = await acquire(false, true);
    if (me === cur) watchEnd(cam = got.cam);
    else stopTracks(got);
  } else if (!on && cam) {
    cam.stop(); // the camera's light goes off
    cam = null;
  }
  busy = false;
  if (me !== cur) return;
  camOn = !!cam;
  remember({ cam: on });
  attachAll();
  sendCall();
  refresh();
}

// The microphone and camera wanted, in one question to the browser; when
// that is refused, each on its own, so one of the two may still come (the
// microphone allowed, the camera blocked). What cannot be had is told;
// joining goes on without it: the others are still heard and seen.
async function acquire(audio, video) {
  const out = { mic: null, cam: null, missing: {} };
  let errs = {};
  const get = async (a, v) => {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: a && AUDIO, video: v && VIDEO });
      out.mic ||= st.getAudioTracks()[0] || null;
      out.cam ||= st.getVideoTracks()[0] || null;
      return true;
    } catch (e) {
      if (a) errs.mic = e?.name || 'Error';
      if (v) errs.cam = e?.name || 'Error';
      return false;
    }
  };
  if (!audio && !video) return out;
  if (!(await get(audio, video)) && audio && video) {
    errs = {};
    await get(true, false);
    await get(false, true);
  }
  if (errs.mic || errs.cam) mediaError(errs);
  out.missing = { mic: errs.mic === 'NotFoundError', cam: errs.cam === 'NotFoundError' };
  return out;
}

// One toast for what failed: no permission, no device, or a device in use.
function mediaError({ mic: m, cam: c }) {
  const kind = m && c ? 'both' : m ? 'mic' : 'cam';
  const name = m || c;
  const what = { mic: 'de microfoon', cam: 'de camera', both: 'microfoon en camera' }[kind];
  let text = `Geen toegang tot ${what}`;
  let sub = 'Sta het toe in de instellingen van je browser.' + (m ? ' Je hoort de anderen wel.' : '');
  if (name === 'NotFoundError') {
    text = { mic: 'Geen microfoon gevonden', cam: 'Geen camera gevonden', both: 'Geen microfoon en camera gevonden' }[kind];
    sub = '';
  } else if (name === 'NotReadableError' || name === 'AbortError') {
    text = { mic: 'De microfoon is in gebruik', cam: 'De camera is in gebruik', both: 'Microfoon en camera zijn in gebruik' }[kind];
    sub = 'Misschien gebruikt een ander programma ze.';
  }
  sound.play('error');
  toast(text, { sub, kind: 'error', ms: 5000 });
}

// A track that ends by itself (the device unplugged or taken by another
// app, the permission withdrawn) is switched off as with its button: the
// others see the face again, and a tap asks for the device anew.
function watchEnd(track) {
  track?.addEventListener('ended', () => {
    if (!me || (track !== mic && track !== cam)) return;
    if (track === mic) {
      mic = null;
      micOn = false;
    } else {
      cam = null;
      camOn = false;
    }
    attachAll();
    sendCall();
    refresh();
  });
}

function stopTracks({ mic: m, cam: c }) {
  m?.stop();
  c?.stop();
}

// ---------- connections ----------

function addPeer(id, seat) {
  const p = {
    id, seat, offerer: me.id < id, pc: null, mic: false, cam: false, live: false, up: false, failed: false, tries: 0, timer: 0,
    audio: h('audio', { autoplay: true }),
    video: h('video', { class: 'call-video', autoplay: true, muted: true, playsInline: true }),
  };
  box.append(p.audio);
  p.video.addEventListener('playing', () => { p.live = true; refresh(); });
  peers.set(id, p);
  if (p.offerer) offer(p);
  else wait(p, null);
  return p;
}

function closePeer(p) {
  clearTimeout(p.timer);
  p.pc?.close();
  p.pc = null;
  p.audio.srcObject = null;
  p.video.srcObject = null;
  p.audio.remove();
  p.video.remove();
  peers.delete(p.id);
}

function newPC(p) {
  p.pc?.close();
  const pc = new RTCPeerConnection({ iceServers: ICE });
  p.pc = pc;
  p.up = false;
  pc.ontrack = e => onTrack(p, e.track);
  pc.onconnectionstatechange = () => onState(p, pc);
  wait(p, pc);
  return pc;
}

// A connection that is not up within CONNECT_MS has failed. The one who
// answers waits for offers: its timer only marks the seat.
function wait(p, pc) {
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    if (p.pc === pc && !p.up) failed(p, pc);
  }, CONNECT_MS);
}

// The lower session id offers, so the two never offer at once. The
// transceivers are there from the start: switching the microphone or
// camera later only swaps tracks, without a new offer.
async function offer(p) {
  const pc = newPC(p);
  pc.addTransceiver('audio', { direction: 'sendrecv' });
  pc.addTransceiver('video', { direction: 'sendrecv', sendEncodings: [{ maxBitrate: VIDEO_BITRATE }] });
  attach(p);
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    if (p.pc === pc) signal(p, pc.localDescription);
  } catch {
    failed(p, pc);
  }
}

export async function onRTC(m) {
  const p = peers.get(m.from);
  if (!me || !p || !m.desc) return;
  if (m.desc.type === 'offer' && !p.offerer) {
    const pc = newPC(p); // every offer starts afresh
    p.failed = false;
    try {
      await pc.setRemoteDescription(m.desc);
      for (const t of pc.getTransceivers()) t.direction = 'sendrecv';
      attach(p);
      await pc.setLocalDescription(await pc.createAnswer());
      capVideo(pc);
      await gathered(pc);
      if (p.pc === pc) signal(p, pc.localDescription);
    } catch {
      failed(p, pc);
    }
  } else if (m.desc.type === 'answer' && p.offerer && p.pc?.signalingState === 'have-local-offer') {
    const pc = p.pc;
    try {
      await pc.setRemoteDescription(m.desc);
    } catch {
      failed(p, pc);
    }
  }
}

// The one who answers gets its transceivers from the offer, so its video
// ceiling is set once they are negotiated. It holds when the track changes.
function capVideo(pc) {
  for (const t of pc.getTransceivers()) {
    if (t.receiver.track?.kind !== 'video') continue;
    const prm = t.sender.getParameters();
    if (!prm.encodings?.length) continue;
    prm.encodings[0].maxBitrate = VIDEO_BITRATE;
    t.sender.setParameters(prm).catch(() => {});
  }
}

// One description with every address found (no trickling): the server
// allows few messages a second.
function signal(p, desc) {
  app.send({ t: 'rtc', to: p.id, desc: { type: desc.type, sdp: desc.sdp } });
}

function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(done => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      done();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const timer = setTimeout(finish, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function onState(p, pc) {
  if (p.pc !== pc) return;
  const st = pc.connectionState;
  if (st === 'connected') {
    clearTimeout(p.timer);
    p.up = true;
    p.failed = false;
    p.tries = 0;
  } else if (st === 'failed') {
    failed(p, pc);
  } else if (st === 'disconnected') {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (p.pc === pc && pc.connectionState !== 'connected') failed(p, pc);
    }, LOST_MS);
  }
  refresh();
}

// The offerer tries again a few times; after that, and for the one who
// answers until a new offer comes, the seat says there is no connection.
function failed(p, pc) {
  if (p.pc !== pc || !peers.has(p.id)) return;
  clearTimeout(p.timer);
  pc?.close();
  p.pc = null;
  p.up = false;
  p.live = false;
  if (p.offerer && p.tries < RETRIES) {
    p.tries++;
    p.timer = setTimeout(() => { if (peers.get(p.id) === p && !p.pc) offer(p); }, 2000 * p.tries);
  } else {
    p.failed = true;
  }
  refresh();
}

function onTrack(p, track) {
  if (track.kind === 'audio') {
    p.audio.srcObject = new MediaStream([track]);
    play(p.audio);
    return;
  }
  p.video.srcObject = new MediaStream([track]);
  track.addEventListener('mute', () => { p.live = false; refresh(); });
  track.addEventListener('unmute', () => { p.live = true; refresh(); });
  play(p.video);
}

// Our tracks on a connection: the microphone always (muted it sends
// silence), the camera while it is on.
function attach(p) {
  for (const t of p.pc?.getTransceivers() || []) {
    const kind = t.receiver.track?.kind;
    const track = kind === 'audio' ? mic : kind === 'video' ? cam : null;
    if (t.sender.track !== track) t.sender.replaceTrack(track).catch(() => {});
  }
}

function attachAll() {
  for (const p of peers.values()) attach(p);
  if (cam) {
    if (self.srcObject?.getVideoTracks()[0] !== cam) self.srcObject = new MediaStream([cam]);
    play(self);
  } else {
    self.srcObject = null;
  }
}

// ---------- playing ----------

// A browser may refuse to play sound before a tap on the page: the next
// tap plays everything of the call.
function play(el) {
  el.play?.()?.catch?.(e => {
    if (e?.name === 'NotAllowedError') blocked();
  });
}

function blocked() {
  if (unlocking) return;
  unlocking = true;
  toast('Tik ergens om de anderen te horen', { ms: 4000 });
  const go = () => {
    removeEventListener('pointerdown', go, true);
    removeEventListener('keydown', go, true);
    unlocking = false;
    unlockMedia();
  };
  addEventListener('pointerdown', go, true);
  addEventListener('keydown', go, true);
}

function unlockMedia() {
  for (const p of peers.values()) {
    if (p.audio.srcObject) play(p.audio);
    if (p.video.srcObject) play(p.video);
  }
}

// ---------- on screen ----------

// The video a seat shows: ours while the camera is on, another's while
// theirs is on and pictures arrive.
function videoFor(seat) {
  if (!s) return null;
  if (seat === s.you) return me && camOn ? self : null;
  for (const p of peers.values()) if (p.seat === seat && p.cam && p.live && p.up) return p.video;
  return null;
}

// Makes el (a seat's ring, a lobby avatar) show seat in the call: its
// video in place of the face, and a mark with the microphone, or that no
// connection could be made.
export function decorate(el, seat) {
  rings.add(el);
  el.dataset.callSeat = seat;
  paint(el);
}

function paint(el) {
  // Only the screen in view shows videos: one element cannot be in two places.
  const screen = el.closest('.screen');
  if (screen && screen.id !== document.body.dataset.screen) return;
  const seat = Number(el.dataset.callSeat);
  const v = videoFor(seat);
  const cur = el.querySelector(':scope > .call-video');
  if (cur && cur !== v) cur.remove();
  if (v && cur !== v) {
    el.prepend(v); // under the marks on the ring (dealer, trump, call)
    play(v);
  }
  el.classList.toggle('cam', !!v);
  const c = s?.players[seat]?.call;
  const peer = seat === s?.you ? null : [...peers.values()].find(p => p.seat === seat);
  let tag = el.querySelector(':scope > .call-tag');
  if (!c) {
    tag?.remove();
    return;
  }
  if (!tag) el.append(tag = h('span', { class: 'call-tag' }));
  const lost = !!peer?.failed;
  const key = lost ? 'lost' : c.mic ? 'mic' : 'off';
  if (tag.dataset.key === key) return;
  tag.dataset.key = key;
  tag.className = 'call-tag ' + key;
  tag.title = lost ? 'Belt mee, maar er is geen verbinding' : c.mic ? 'Belt mee' : 'Belt mee, microfoon uit';
  tag.replaceChildren(icon(lost ? 'noLink' : c.mic ? 'mic' : 'micOff'));
}

// Registers el as a place for the call buttons.
export function dock(el) {
  if (docks.has(el)) return;
  docks.add(el);
  paintDock(el);
}

// A call button: a pictogram, with its label beside it where there is
// room (the lobby: `text`).
function toolBtn(name, ic, label, title, fn, { pressed = null, disabled = false, text = false } = {}) {
  const b = h('button', {
    class: 'tb tb-' + name + (text ? ' labeled' : ''), type: 'button', title, 'aria-label': label, disabled,
    onclick: () => { sound.play('click'); fn(); },
  }, icon(ic), text ? h('span', { text: label }) : null);
  if (pressed != null) b.setAttribute('aria-pressed', String(pressed));
  return b;
}

function paintDock(el) {
  const show = supported() && (possible() || joining);
  el.hidden = !show;
  // Its row makes room for the buttons (app.css).
  if (show) el.parentElement.dataset.call = me ? 'in' : 'out';
  else delete el.parentElement.dataset.call;
  if (!show) {
    el.replaceChildren();
    delete el.dataset.key;
    return;
  }
  const key = JSON.stringify([!!me, joining, busy, micOn, camOn]);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.classList.toggle('in-call', !!me);
  const text = el.classList.contains('lb-call');
  if (!me) {
    el.replaceChildren(toolBtn('call', 'phone', 'Bellen', joining ? 'Verbinden…' : 'Bellen met de anderen aan tafel', () => openSheet(), { disabled: joining, text }));
    return;
  }
  el.replaceChildren(
    toolBtn('mic', micOn ? 'mic' : 'micOff', 'Microfoon', micOn ? 'Microfoon aan' : 'Microfoon uit', () => setMic(!micOn), { pressed: micOn, disabled: busy }),
    toolBtn('cam', camOn ? 'cam' : 'camOff', 'Camera', camOn ? 'Camera aan' : 'Camera uit', () => setCam(!camOn), { pressed: camOn, disabled: busy }),
    toolBtn('hangup', 'hangup', 'Ophangen', 'Ophangen: het gesprek verlaten', () => hangup(), { text }));
}

// Repaints everything of the call on screen.
function refresh() {
  for (const el of [...rings]) {
    if (el.isConnected) paint(el);
    else rings.delete(el);
  }
  for (const el of [...docks]) {
    if (el.isConnected) paintDock(el);
    else docks.delete(el);
  }
}

// ---------- the sheet ----------

const listNames = names => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} en ${names[names.length - 1]}`);

// Join the call: proposed at the start of a game, or from the Bellen
// button. In the call the buttons switch and hang up.
export function openSheet({ proposal = false } = {}) {
  if (me || !s) return;
  const pick = { mic: prefs().mic, cam: prefs().cam };
  const names = others().map(o => o.p.name);
  const calling = s.players.flatMap((p, seat) => (seat !== s.you && p?.call ? [p.name] : []));
  const m = panels.openModal({
    id: 'call', title: 'Meebellen?', cls: 'm-call', body: [
      h('p', { text: calling.length ? `${listNames(calling)} ${calling.length === 1 ? 'belt' : 'bellen'} al.` : `${listNames(names)} ${names.length === 1 ? 'zit' : 'zitten'} ook aan tafel. Bel mee met geluid, en met beeld als je wilt.` }),
      panels.toggleRow('Microfoon', 'De anderen horen je', pick.mic, on => { pick.mic = on; }),
      panels.toggleRow('Camera', 'Je beeld staat op je plaats aan tafel', pick.cam, on => { pick.cam = on; }),
      h('p', { class: 'call-note', text: 'Beeld en geluid gaan rechtstreeks van toestel naar toestel, niet via de server.'
        + (document.body.dataset.screen === 'game' ? ' Tijdens het spel zet je ze aan en uit met de knoppen rechtsonder.' : '') }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, proposal ? 'Niet nu' : 'Annuleren'),
        h('button', { class: 'btn btn-go', type: 'button', onclick: () => { m.close(true); join(pick.mic, pick.cam); } }, icon('phone'), 'Meebellen')),
    ],
  });
}
