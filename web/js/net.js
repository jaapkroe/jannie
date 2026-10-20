// WebSocket connection to /ws: reconnect with backoff, keepalive and an
// outbox for messages sent while (re)connecting.

const PING_MS = 20000;   // client keepalive
const STALE_MS = 55000;  // no traffic at all for this long: reconnect
const OUTBOX_MAX = 8;    // messages kept while (re)connecting

export function createNet({ onMessage, onOpen, onClose }) {
  let ws = null;
  let delay = 500;
  let timer = 0;
  let lastRx = 0;
  let outbox = [];

  const url = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  const isOpen = () => ws?.readyState === WebSocket.OPEN;

  function connect() {
    clearTimeout(timer);
    timer = 0;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    let sock;
    try {
      sock = new WebSocket(url());
    } catch {
      schedule();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      delay = 500;
      lastRx = Date.now();
      onOpen();
      const queued = outbox;
      outbox = [];
      for (const m of queued) raw(m);
    };
    sock.onmessage = e => {
      if (ws !== sock) return;
      lastRx = Date.now();
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m && m.t !== 'pong') onMessage(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      onClose();
      schedule();
    };
    sock.onerror = () => {}; // a close event always follows
  }

  function schedule(ms = delay) {
    if (timer) return;
    timer = setTimeout(connect, ms);
    delay = Math.min(delay * 2, 5000);
  }

  function raw(m) {
    try { ws.send(JSON.stringify(m)); return true; } catch { return false; }
  }

  // Sends now when open; otherwise keeps it for the next connection. The
  // outbox stays small: together with the rejoin it is sent in one burst,
  // and the server allows 20 messages per second.
  function send(m) {
    if (isOpen()) return raw(m);
    outbox.push(m);
    if (outbox.length > OUTBOX_MAX) outbox.shift();
    connect();
    return false;
  }

  // Drops queued messages (e.g. after leaving a room).
  function flushOutbox() { outbox = []; }

  // Sends `msgs` over a short-lived connection of its own, beside the main
  // one (e.g. a leave for a room this page has already left). done(true)
  // once they went out, done(false) when no connection could be made.
  function oneShot(msgs, done) {
    let sock;
    try {
      sock = new WebSocket(url());
    } catch {
      done(false);
      return;
    }
    let sent = false;
    let timer = 0;
    const finish = () => {
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
    };
    timer = setTimeout(finish, 8000);
    sock.onopen = () => {
      try {
        for (const m of msgs) sock.send(JSON.stringify(m));
        sent = true;
      } catch {
        finish();
      }
    };
    // The first answer shows the server has read them; the close follows them out.
    sock.onmessage = () => { clearTimeout(timer); timer = setTimeout(finish, 300); };
    sock.onerror = () => {};
    sock.onclose = () => {
      clearTimeout(timer);
      done(sent);
    };
  }

  // Forces a fresh connection (stale socket or server restart).
  function reconnect(ms = 0) {
    const old = ws;
    ws = null;
    if (old) {
      old.onclose = null;
      try { old.close(); } catch { /* already closed */ }
      onClose();
    }
    clearTimeout(timer);
    timer = 0;
    schedule(ms);
  }

  setInterval(() => {
    if (!isOpen()) return;
    if (Date.now() - lastRx > STALE_MS) reconnect();
    else raw({ t: 'ping' });
  }, PING_MS);

  const wake = () => {
    if (document.visibilityState !== 'visible') return;
    if (!isOpen()) {
      delay = 500;
      connect();
    } else if (Date.now() - lastRx > PING_MS) {
      // After a phone sleep the socket may be dead without a close event.
      const mark = Date.now();
      raw({ t: 'ping' });
      setTimeout(() => { if (lastRx < mark && isOpen()) reconnect(); }, 3000);
    }
  };
  document.addEventListener('visibilitychange', wake);
  addEventListener('online', wake);
  addEventListener('pageshow', wake);

  return { connect, send, reconnect, isOpen, flushOutbox, oneShot, raw: m => isOpen() && raw(m) };
}
