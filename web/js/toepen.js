// The table of toepen (design §11), loaded once a room plays it: the seats
// around the felt (two to six), the trick, the stake, your four cards and
// the questions of the round (was, check, toep). It shares the shell with
// klaverjas: the lobby, chat, calls, settings and the takeover question's
// protocol; its own overlays are the round summary, game over, the
// standings and the rules. Pure parts: toepen-rules.js.
import { app, h, clear, icon, toast, avatar, fillAvatar, playerName, wait, anim, dur, vibrate } from './util.js';
import { createCard, createBack, cardName } from './cards.js';
import { sound } from './sound.js';
import * as panels from './panels.js';
import * as R from './toepen-rules.js';

const E = {};
let built = false;
let seatEls = [];        // per seat: its parts
let slotOf = new Map();  // seat → its trick slot element
let pending = null;      // {t, at, key}: a decision sent, awaiting the server
let selected = '';       // a lifted card (touch: the first tap lifts, the second plays)
let pendingVote = null;  // our answer to the takeover question, awaiting the server
let summaryFor = 0;      // the round whose summary is up
let shownCheck = 0;      // the number of settled claims shown
const touch = matchMedia('(pointer: coarse)');
const STUCK_MS = 4000;

function build() {
  if (built) return;
  built = true;
  document.head.append(h('link', { rel: 'stylesheet', href: '/css/toepen.css' }));
  const root = h('section', { id: 'toepen', class: 'screen screen-toepen', 'aria-label': 'Toepentafel' });
  E.top = h('header', { class: 'topbar tp-top' },
    E.pill = h('button', { class: 'tp-pill', type: 'button', title: 'Stand: de strafpunten van iedereen', onclick: openStand },
      h('span', { class: 'tp-pill-lbl', text: 'Jij' }), E.mine = h('b', { class: 'tp-pill-n', text: '0' }), E.limit = h('span', { class: 'tp-pill-lim' })),
    h('div', { class: 'potje', title: 'Het hoeveelste potje' },
      h('span', { class: 'potje-lbl', text: 'Potje' }), h('span', { class: 'potje-n' }, E.round = h('b', { text: '1' }))),
    E.stakeTop = h('div', { class: 'tp-stake-top', title: 'De inzet: zoveel strafpunten krijgt wie de laatste slag niet haalt' },
      h('span', { class: 'tp-st-lbl', text: 'Inzet' }), E.stakeN = h('b', { text: '1' })),
    h('span', { class: 'spacer' }),
    ...panels.toolButtons(['chat']),
    h('button', { class: 'tb tb-rules', type: 'button', title: 'Spelregels van toepen', 'aria-label': 'Spelregels', onclick: () => { sound.unlock(); openRules(); } }, icon('help')),
    ...panels.toolButtons(['settings', 'sound']),
    h('button', { class: 'tb tb-menu', type: 'button', title: 'Meer: stand, spelregels, verlaten', 'aria-label': 'Meer', onclick: () => { sound.unlock(); openMenu(); } }, icon('menu')));
  E.table = h('div', { class: 'tp-table' }, h('div', { class: 'tp-felt', 'aria-hidden': 'true' }));
  E.seats = h('div', { class: 'tp-seats' });
  E.trick = h('div', { class: 'tp-trick', role: 'group', 'aria-label': 'Slag op tafel' });
  E.chip = h('div', { class: 'tp-chip', 'aria-live': 'polite' }, E.chipN = h('b', { text: '1' }), h('span', { text: 'inzet' }));
  E.shown = h('div', { class: 'tp-shown', hidden: true });
  E.fx = h('div', { class: 'tp-fx', 'aria-live': 'polite' });
  E.table.append(E.seats, E.trick, E.chip, E.shown, E.fx);
  E.me = h('div', { class: 'tp-me' }, E.meAv = h('span', { class: 'avatar' }),
    h('span', { class: 'tp-me-txt' }, E.meName = h('b'), E.mePts = h('span', { class: 'tp-pts' })));
  E.text = h('div', { class: 'tp-text', 'aria-live': 'polite' }, E.textMain = h('b'), E.textSub = h('small'));
  E.actions = h('div', { class: 'tp-actions' });
  E.ring = panels.countdownRing();
  E.ringBox = h('span', { class: 'tp-ring', hidden: true }, E.ring.el);
  E.vote = h('div', { class: 'tp-vote', hidden: true });
  E.prompt = h('div', { class: 'tp-prompt' }, E.me, E.text, E.ringBox, E.actions, E.vote);
  E.hand = h('div', { class: 'tp-hand', role: 'group', 'aria-label': 'Jouw kaarten' });
  root.append(E.top, E.table, E.prompt, E.hand);
  document.getElementById('app').append(root);
  root.addEventListener('click', e => {
    if (selected && !e.target.closest('.tp-hand .card')) { selected = ''; renderHand(app.s); }
  });
  document.addEventListener('keydown', onKey);
}

// ---------- render ----------

export function render(s) {
  if (!s) return;
  build();
  app.view = s;
  if (pending && (pending.key !== stateKey(s) || performance.now() - pending.at > STUCK_MS)) pending = null;
  if (!R.IN_HAND.has(s.phase)) selected = '';
  E.table.dataset.players = s.players.length;
  renderTop(s);
  renderSeats(s);
  renderTrick(s);
  renderPrompt(s);
  renderHand(s);
  syncOverlays(s);
  if (app.call) app.call.dock(E.callDock ??= E.prompt.appendChild(h('div', { class: 'call-dock', role: 'group', 'aria-label': 'Bellen' })));
  for (const [seat, S] of seatEls.entries()) app.call?.decorate(S.ring, seat);
}

// What changes when a decision of ours went through.
const stateKey = s => `${s.handNo}/${s.phase}/${s.turn}/${s.tricks}/${s.trick?.cards?.length}/${s.answered?.[s.you]}/${s.stake}`;

function renderTop(s) {
  const lim = s.opts?.limit || 10;
  E.mine.textContent = s.points?.[s.you] ?? 0;
  E.limit.textContent = `/${lim}`;
  E.pill.classList.toggle('poor', (s.points?.[s.you] ?? 0) === lim - 1);
  E.round.textContent = s.handNo || 1;
  const stake = R.IN_HAND.has(s.phase) || s.phase === 'handEnd' ? s.stake || 1 : 1;
  E.stakeN.textContent = stake;
  E.stakeTop.classList.toggle('hot', stake > 1);
}

function seatParts(seat) {
  const S = {};
  S.root = h('div', { class: 'tp-seat' },
    S.ring = h('span', { class: 'ring' }, S.av = h('span', { class: 'avatar' }),
      S.chip = h('span', { class: 'dealer-chip', title: 'Gever', text: 'G', hidden: true })),
    h('span', { class: 'tp-plate' }, S.name = h('span', { class: 'nm' }),
      S.pts = h('span', { class: 'tp-pts' }), S.status = h('span', { class: 'st', hidden: true })),
    S.backs = h('div', { class: 'tp-backs', 'aria-hidden': 'true' }),
    S.bubble = h('div', { class: 'bubble', hidden: true }));
  return S;
}

function renderSeats(s) {
  const n = s.players.length;
  if (seatEls.length !== n) {
    clear(E.seats);
    clear(E.trick);
    seatEls = [];
    slotOf = new Map();
    for (let seat = 0; seat < n; seat++) {
      const S = seatParts(seat);
      seatEls.push(S);
      E.seats.append(S.root);
      const slot = h('div', { class: 'tp-slot' });
      slotOf.set(seat, slot);
      E.trick.append(slot);
    }
  }
  const lim = s.opts?.limit || 10;
  for (let seat = 0; seat < n; seat++) {
    const S = seatEls[seat];
    const p = s.players[seat];
    const a = R.seatAngle(s, seat);
    const at = R.onEllipse(a, 39, 42, 50, 55);
    const me = seat === s.you;
    S.root.hidden = me; // you are in the prompt row
    S.root.style.left = at.x + '%';
    S.root.style.top = at.y + '%';
    S.root.dataset.side = at.x < 35 ? 'l' : at.x > 65 ? 'r' : 'c'; // where its bubble opens
    const sl = R.onEllipse(a, 16, 15, 50, 55);
    const slot = slotOf.get(seat);
    slot.style.left = sl.x + '%';
    slot.style.top = sl.y + '%';
    const status = R.seatStatus(s, seat);
    const out = R.isOut(s, seat) || ['gepast', 'betrapt', 'eruit', 'uit'].includes(s.status?.[seat]);
    S.root.className = 'tp-seat' + (s.turn === seat && R.IN_HAND.has(s.phase) ? ' turn' : '') + (p ? '' : ' empty') +
      (p?.bot ? ' bot' : '') + (out && R.IN_HAND.has(s.phase) ? ' out' : '') + (R.isOut(s, seat) ? ' dead' : '') +
      (s.armoede?.[seat] ? ' poor' : '') + (S.root.classList.contains('talking') ? ' talking' : '');
    fillAvatar(S.av, p);
    S.name.replaceChildren(playerName(p?.name || 'Vrij'));
    S.root.title = p ? `${p.name}: ${R.pointsText(s.points?.[seat] ?? 0)}` : 'Lege plaats';
    S.pts.textContent = `${s.points?.[seat] ?? 0}/${lim}`;
    S.status.hidden = !status;
    S.status.textContent = status;
    S.chip.hidden = s.dealer !== seat || s.phase === 'lobby';
    setBacks(S, R.IN_HAND.has(s.phase) ? p?.cards ?? 0 : 0);
  }
  fillAvatar(E.meAv, s.players[s.you]);
  E.meName.replaceChildren(playerName(s.players[s.you]?.name || 'Jij'));
  E.mePts.textContent = R.pointsText(s.points?.[s.you] ?? 0) + (s.armoede?.[s.you] ? ' · armoede' : '');
  E.me.classList.toggle('turn', s.turn === s.you && R.IN_HAND.has(s.phase));
}

function setBacks(S, n) {
  if (S.backs.childElementCount === n) return;
  S.backs.replaceChildren(...Array.from({ length: n }, () => createBack({ size: 'sm' })));
}

function renderTrick(s) {
  for (const slot of slotOf.values()) clear(slot);
  const t = s.trick;
  E.chipN.textContent = s.stake || 1;
  E.chip.hidden = !R.IN_HAND.has(s.phase);
  E.chip.classList.toggle('hot', (s.stake || 1) > 1);
  if (!t) return;
  for (const p of t.cards || []) {
    const slot = slotOf.get(p.seat);
    if (!slot) continue;
    const c = createCard(p.card, { size: 'md' });
    if (t.winner >= 0 && p.seat === t.winner) c.classList.add('winner');
    if (s.status?.[p.seat] && s.status[p.seat] !== 'in') c.classList.add('dead-card');
    slot.append(c);
  }
}

function renderPrompt(s) {
  const q = R.prompt(s);
  const vote = votePanel(s);
  E.vote.hidden = !vote;
  if (vote) E.vote.replaceChildren(...vote);
  E.prompt.classList.toggle('mine', !!q?.actions?.length || s.turn === s.you && s.phase === 'play');
  E.textMain.textContent = q?.text || (s.phase === 'handEnd' ? 'Het potje is uit.' : s.phase === 'gameOver' ? 'Het spel is uit.' : '');
  E.textSub.textContent = q?.sub || '';
  E.textSub.hidden = !q?.sub;
  E.ringBox.hidden = !q?.countdown;
  E.ring.set(q?.countdown || 0);
  E.actions.replaceChildren(...(q?.actions || []).map(a => h('button', {
    class: `btn tp-act tp-${a.kind}`, type: 'button', disabled: !!pending,
    onclick: () => decide(a),
  }, h('b', { text: a.label }), a.sub ? h('small', { text: a.sub }) : null)));
}

function decide(a) {
  if (pending) return;
  sound.unlock();
  sound.play(a.t === 'toep' ? 'knock' : 'click');
  const m = { t: a.t };
  if (a.play !== undefined) m.play = a.play;
  send(m);
}

function send(m) {
  pending = { t: m.t, at: performance.now(), key: stateKey(app.view) };
  for (const b of E.actions.querySelectorAll('button')) b.disabled = true;
  app.send(m);
}

// ---------- your cards ----------

function renderHand(s) {
  const hand = R.IN_HAND.has(s.phase) ? s.hand || [] : [];
  const legal = new Set(s.legal || []);
  const mine = s.turn === s.you && s.phase === 'play' && !pending;
  if (!hand.includes(selected)) selected = '';
  const kids = hand.map(code => {
    const c = createCard(code, { size: 'lg' });
    const ok = mine && legal.has(code);
    c.classList.toggle('legal', ok);
    c.classList.toggle('disabled', mine && !ok);
    c.classList.toggle('selected', code === selected);
    c.tabIndex = mine ? 0 : -1;
    c.setAttribute('role', 'button');
    c.setAttribute('aria-label', cardName(code) + (mine && !ok ? ' (mag niet)' : ''));
    c.addEventListener('click', () => tap(code));
    return c;
  });
  E.hand.replaceChildren(...kids);
  E.hand.classList.toggle('mine', mine);
}

function tap(code) {
  const s = app.view;
  if (!s || s.turn !== s.you || s.phase !== 'play' || pending) return;
  if (!(s.legal || []).includes(code)) {
    sound.play('error');
    vibrate(30);
    const led = s.trick?.cards?.[0]?.card?.[1];
    toast(led ? `Je moet bekennen: speel ${{ C: '♣', D: '♦', H: '♥', S: '♠' }[led]}.` : 'Die kaart mag niet.', { kind: 'warn', ms: 2200 });
    return;
  }
  if (touch.matches && selected !== code) {
    selected = code;
    sound.play('click');
    renderHand(s);
    return;
  }
  selected = '';
  playCard(code);
}

function playCard(code) {
  sound.unlock();
  send({ t: 'play', card: code });
  renderHand(app.view);
}

function onKey(e) {
  const s = app.view;
  if (!s || s.game !== 'toepen' || document.body.dataset.screen !== 'toepen' || e.target.closest?.('input, textarea') || panels.isOpen()) return;
  const hand = s.hand || [];
  const k = Number(e.key);
  if (k >= 1 && k <= hand.length && s.turn === s.you && s.phase === 'play') {
    e.preventDefault();
    tap(hand[k - 1]);
  } else if ((e.key === 't' || e.key === 'T') && s.canToep && !pending) {
    e.preventDefault();
    decide({ t: 'toep' });
  }
}

// ---------- the takeover question ----------

// Shown to everyone connected while the game waits for a seat whose player
// is gone: may an AI play it? (design §6). The same messages as klaverjas.
function votePanel(s) {
  const q = s.takeover;
  if (!q || q.seat === s.you) { pendingVote = null; return null; }
  const who = s.players[q.seat]?.name || 'Speler';
  const mine = pendingVote?.seat === q.seat ? pendingVote.ai : s.players[s.you]?.vote;
  const ask = q.left ? `${who} is vertrokken. Mag een AI-speler de plaats innemen?` : `${who} is weg. Mag een AI-speler zolang meespelen?`;
  const btn = (ai, label) => h('button', {
    class: 'btn ' + (ai ? 'btn-go' : 'btn-ghost') + (mine === ai ? ' on' : ''), type: 'button', 'aria-pressed': String(mine === ai),
    onclick: () => { pendingVote = { seat: q.seat, ai }; sound.play('click'); app.send({ t: 'vote', seat: q.seat, ai, left: q.left }); render(app.view); },
  }, label);
  return [h('b', { text: ask }), h('div', { class: 'btn-row' }, btn(true, 'Ja'), btn(false, 'Wachten'))];
}

// A refusal of our vote that comes just after the question closed is no
// mistake (as table.staleVote).
export function staleVote(m) {
  if (m.code !== 'ongeldig' || !pendingVote) return false;
  pendingVote = null;
  return m.msg === 'Die vraag staat niet (meer) open.';
}

// ---------- overlays ----------

function syncOverlays(s) {
  if (s.phase === 'handEnd') showSummary(s);
  else if (summaryFor) { summaryFor = 0; app.toepSummary?.close(true); }
  if (s.phase === 'gameOver') showOver(s);
  else app.toepOver?.close(true);
  if (s.phase === 'lobby') { app.toepStand?.close(true); }
  app.toepStand?.refresh?.(s);
}

function showSummary(s) {
  const row = s.rounds?.at(-1);
  if (!row || summaryFor === row.hand) { refreshReady(s); return; }
  summaryFor = row.hand;
  const T = R.roundHeadline(s, row);
  const list = h('div', { class: 'tp-sum-list' }, R.standings(s).map(x => {
    const gain = row.gains?.[x.seat] ?? 0;
    return h('div', { class: 'tp-sum-row' + (x.seat === s.you ? ' me' : '') + (x.out ? ' out' : '') + (x.seat === row.winner ? ' won' : '') },
      avatar(s.players[x.seat], 'sm'), playerName(x.name, { cls: 'tp-sum-name' }),
      h('span', { class: 'tp-sum-gain' + (gain ? ' plus' : ''), text: gain ? `+${gain}` : x.seat === row.winner ? '🏆' : '' }),
      meter(x.points, s.opts?.limit || 10),
      h('b', { class: 'tp-sum-pts', text: x.out ? 'eruit' : String(x.points) }));
  }));
  E.go = h('button', { class: 'btn btn-go btn-big', type: 'button', onclick: () => { sound.play('click'); app.send({ t: 'ready' }); E.go.disabled = true; } },
    (E.sumRing = panels.countdownRing()).el, h('span', { text: R.standings(s).filter(x => !x.out).length > 1 ? 'Volgend potje' : 'Verder' }));
  app.toepSummary = panels.openModal({
    id: 'tp-summary', cls: 'm-summary passive tp-summary ' + T.cls, closable: false, label: 'Uitslag van het potje', body: [
      h('h2', { class: 'sum-title', text: T.title }), h('p', { class: 'sum-sub', text: T.sub }), list, h('div', { class: 'sheet-foot' }, E.go)],
  });
  sound.play(row.winner === s.you ? 'handWon' : (row.gains?.[s.you] ?? 0) > 0 ? 'handLost' : 'trick');
  refreshReady(s);
}

function refreshReady(s) {
  E.sumRing?.set(s.nextAt || 0);
  if (E.go && s.players[s.you]?.ready) E.go.disabled = true;
}

function meter(points, limit) {
  const el = h('span', { class: 'tp-meter', title: `${points} van ${limit}` });
  for (let k = 0; k < limit; k++) el.append(h('i', { class: k < points ? 'on' : '' }));
  return el;
}

function showOver(s) {
  if (app.toepOver?.round === s.handNo) return;
  const won = s.winner === s.you;
  const host = s.host === s.you;
  const title = won ? 'Jij wint het spel!' : `${s.players[s.winner]?.name || 'Iemand'} wint het spel`;
  const btns = [];
  if (host) {
    btns.push(h('button', { class: 'btn btn-go btn-big', type: 'button', onclick: () => { sound.play('click'); app.send({ t: 'rematch' }); } }, icon('shuffle'), 'Nog een keer'));
    if (!s.training) btns.push(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { sound.play('click'); app.send({ t: 'lobby' }); } }, icon('users'), 'Spelers of regels wijzigen'));
  } else {
    btns.push(h('p', { class: 'lb-hint', text: `${s.players[s.host]?.name || 'De host'} kan een nieuw spel starten.` }));
  }
  btns.push(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => app.leave() }, icon('leave'), 'Naar het begin'));
  const m = panels.openModal({
    id: 'tp-over', cls: 'm-over passive tp-over' + (won ? ' won' : ' lost'), closable: false, label: title, body: [
      h('h2', { class: 'over-title', text: title }),
      h('p', { class: 'over-sub', text: `Na ${s.handNo} ${s.handNo === 1 ? 'potje' : 'potjes'} is ${won ? 'alleen jij' : 'nog één speler'} over.` }),
      standTable(s), h('div', { class: 'btn-col' }, btns)],
  });
  m.round = s.handNo;
  app.toepOver = m;
  sound.play(won ? 'win' : 'lose');
  if (won) panels.confetti(m.dlg);
}

function standTable(s) {
  return h('div', { class: 'tp-sum-list' }, R.standings(s).map(x =>
    h('div', { class: 'tp-sum-row' + (x.seat === s.you ? ' me' : '') + (x.out ? ' out' : '') + (x.seat === s.winner ? ' won' : '') },
      avatar(s.players[x.seat], 'sm'), playerName(x.name, { cls: 'tp-sum-name' }),
      h('span', { class: 'tp-sum-gain', text: x.seat === s.winner ? '🏆' : '' }),
      meter(x.points, s.opts?.limit || 10), h('b', { class: 'tp-sum-pts', text: String(x.points) }))));
}

// The standings and every round: who won it, and the points each took.
function openStand() {
  sound.unlock();
  sound.play('click');
  const m = panels.openModal({ id: 'tp-stand', title: 'Stand', cls: 'm-score tp-stand', body: [] });
  m.refresh = s => {
    if (!s) return;
    const n = s.players.length;
    const order = Array.from({ length: n }, (_, k) => (s.you + k) % n);
    const head = h('tr', {}, h('th', { text: '#' }), order.map(seat => h('th', { title: s.players[seat]?.name || '' },
      avatar(s.players[seat], 'xs'))));
    const rows = (s.rounds || []).map(r => h('tr', {}, h('td', { class: 'tp-st-n', text: r.hand }),
      order.map(seat => h('td', { class: (r.winner === seat ? 'won' : '') + (r.out?.[seat] && (r.gains?.[seat] ?? 0) > 0 ? ' out' : ''),
        text: r.winner === seat ? '🏆' : r.gains?.[seat] ? `+${r.gains[seat]}` : '·' }))));
    const total = h('tr', { class: 'tp-st-total' }, h('td', { text: 'Σ' }),
      order.map(seat => h('td', { class: R.isOut(s, seat) ? 'out' : '', text: String(s.points?.[seat] ?? 0) })));
    m.body.replaceChildren(
      h('p', { class: 'sheet-note', text: `${R.variantText(s.opts || {})}. Wie de laatste slag niet haalt, krijgt de inzet als strafpunten.` }),
      standTable(s),
      s.rounds?.length ? h('div', { class: 'tp-st-scroll' }, h('table', { class: 'tp-st-table' }, h('thead', {}, head), h('tbody', {}, rows, total))) : null);
  };
  m.refresh(app.view);
  app.toepStand = m;
}

function openRules() {
  const o = app.view?.opts || {};
  panels.openModal({
    id: 'tp-rules', title: 'Spelregels toepen', cls: 'm-manual tp-rules', body: [
      h('p', { class: 'sheet-note', text: `Aan deze tafel: ${R.variantText(o).toLowerCase()}.` }),
      ...R.rules(o).flatMap(([title, ps]) => [h('h3', { text: title }), ...ps.map(p => h('p', { text: p }))]),
      h('h3', { text: 'Bediening' }),
      h('p', { text: touch.matches ? 'Tik een kaart aan om hem op te tillen, en nog een keer om hem te spelen. Toepen doe je met de knop Toep! naast je naam, voordat je speelt.'
        : 'Klik een kaart om hem te spelen (of de toetsen 1 tot 4). Toepen: de knop Toep! of de toets T, voordat je speelt.' })],
  });
}

function openMenu() {
  const s = app.view;
  const item = (ic, text, fn, cls = '') => h('button', { class: 'menu-item ' + cls, type: 'button', onclick: () => { m.close(true); fn(); } }, icon(ic), h('span', { text }));
  const m = panels.openModal({
    id: 'menu', cls: 'm-menu', label: 'Menu', body: [
      item('score', 'Stand', openStand),
      item('help', 'Spelregels toepen', openRules),
      item('settings', 'Instellingen', panels.openSettings),
      item(sound.isMuted() ? 'soundOff' : 'soundOn', sound.isMuted() ? 'Geluid aanzetten' : 'Geluid uitzetten', () => {
        sound.setMuted(!sound.isMuted());
        if (!sound.isMuted()) sound.play('click');
        panels.refreshSound();
        toast(sound.isMuted() ? 'Geluid uit' : 'Geluid aan', { ms: 1200 });
      }),
      app.call?.inCall() ? item('hangup', 'Ophangen', () => app.call.hangup())
        : app.call?.possible() && app.call.supported() ? item('phone', 'Bellen', () => app.call.openSheet()) : null,
      s ? item('leave', 'Spel verlaten', () => panels.confirmLeave(), 'danger') : null,
    ],
  });
}

// ---------- animation ----------

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}

// Where a seat's cards come from: its seat, or your hand.
function seatSource(s, seat) {
  if (seat === s.you) return E.hand.querySelector('.card') || E.me;
  return seatEls[seat]?.ring || E.table;
}

// Flies a card (or its back) from one element to another.
async function fly(code, from, to, { ms = 380, back = false, fade = false } = {}) {
  if (!dur(ms) || !from || !to) return;
  const a = rectOf(from);
  const b = rectOf(to);
  const c = back || !code ? createBack({ size: 'md' }) : createCard(code, { size: 'md' });
  c.classList.add('tp-flying');
  document.getElementById('fly').append(c);
  const cw = c.getBoundingClientRect();
  const x0 = a.x - cw.width / 2;
  const y0 = a.y - cw.height / 2;
  c.style.left = x0 + 'px';
  c.style.top = y0 + 'px';
  await anim(c, [
    { transform: 'translate(0, 0) scale(0.8)', opacity: 0.4 },
    { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(1)`, opacity: fade ? 0 : 1 },
  ], ms, { fill: 'forwards' });
  c.remove();
}

export function bubble(s, seat, text, kind = '', ms = 2400) {
  if (seat === s.you) { flash(text, kind); return; }
  const S = seatEls[seat];
  if (!S || !text) return;
  S.bubble.hidden = false;
  S.bubble.textContent = text;
  S.bubble.className = 'bubble ' + kind;
  S.root.classList.add('talking');
  clearTimeout(S.bubbleTimer);
  S.bubbleTimer = setTimeout(() => { S.bubble.hidden = true; S.root.classList.remove('talking'); }, Math.max(1200, dur(ms) || 1200));
}

// A word in the middle of the table: "Toep!", "Armoede".
async function flash(text, kind = '', ms = 1100) {
  const el = h('div', { class: 'tp-flash ' + kind, text });
  E.fx.append(el);
  await anim(el, [{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'scale(1.08)', offset: 0.3 }, { opacity: 1, transform: 'scale(1)', offset: 0.8 }, { opacity: 0, transform: 'scale(1)' }], ms);
  el.remove();
}

const NAME = (s, seat) => (seat === s.you ? 'Jij' : s.players[seat]?.name || 'Speler');

export async function animate(ev, prev, next) {
  build();
  if (!ev || !prev || prev.game !== 'toepen') return;
  if (prev.players.length !== next.players.length || !seatEls.length) render(prev);
  switch (ev.type) {
    case 'deal': {
      sound.play('shuffle');
      shownCheck = 0;
      render({ ...next, hand: [], trick: null, players: next.players.map(p => p && { ...p, cards: 0 }) });
      const n = next.players.length;
      const src = seatEls[ev.dealer]?.ring || E.table;
      const flights = [];
      for (let k = 1; k <= n; k++) {
        const seat = (ev.dealer + k) % n;
        if (!next.players[seat] || (next.status?.[seat] ?? 'in') !== 'in') continue;
        flights.push(fly('', src, seat === next.you ? E.hand : seatEls[seat].ring, { ms: 420, back: true, fade: seat === next.you }));
        sound.play('deal');
        await wait(70);
      }
      await Promise.all(flights);
      break;
    }
    case 'claims':
      for (const seat of ev.seats) { bubble(next, seat, 'Was!', 'was'); }
      sound.play('trump');
      await wait(500);
      break;
    case 'check':
      bubble(next, ev.seat, ev.check ? 'Controleren!' : 'Laat maar', ev.check ? 'check' : '');
      if (ev.check) sound.play('click');
      await wait(ev.check ? 450 : 250);
      break;
    case 'wasDone':
      await showWas(ev, next);
      break;
    case 'toep':
      sound.play('knock');
      vibrate(20);
      bubble(next, ev.seat, 'Toep!', 'toep');
      render({ ...prev, stake: ev.stake });
      flash(ev.seat === next.you ? 'Toep!' : `${NAME(next, ev.seat)}: toep!`, 'toep');
      await wait(650);
      break;
    case 'answer':
      bubble(next, ev.seat, ev.stay ? 'Ik ga mee' : `Pas (+${ev.points})`, ev.stay ? 'go' : 'pass');
      if (!ev.stay) sound.play('click');
      await wait(ev.stay ? 250 : 450);
      break;
    case 'armoede':
      sound.play('trump');
      flash(`Armoede · inzet ${ev.stake}`, 'poor', 1600);
      await wait(900);
      break;
    case 'play': {
      sound.play('card');
      const slot = slotOf.get(ev.seat);
      const from = ev.seat === next.you ? E.hand.querySelector(`.card[data-card="${ev.card}"]`) || E.hand : seatSource(prev, ev.seat);
      if (ev.seat !== next.you) setBacks(seatEls[ev.seat], Math.max(0, (prev.players[ev.seat]?.cards ?? 1) - 1));
      else if (from.classList.contains('card')) from.style.visibility = 'hidden'; // it is in the air now
      await fly(ev.card, from, slot, { ms: 320 });
      break;
    }
    case 'trick': {
      render(next);
      const slot = slotOf.get(ev.winner);
      slot?.querySelector('.card')?.classList.add('winner');
      sound.play(ev.last ? 'trickWon' : 'trick');
      if (ev.last) flash(ev.winner === next.you ? 'Laatste slag: jij!' : `Laatste slag: ${NAME(next, ev.winner)}`, 'last', 1300);
      await wait(ev.last ? 700 : 350);
      break;
    }
    case 'collect': {
      const to = ev.winner === next.you ? E.me : seatEls[ev.winner]?.ring;
      const cards = [...E.trick.querySelectorAll('.card')];
      await Promise.all(cards.map(c => anim(c, [{ opacity: 1 }, { opacity: 0, transform: `translate(${rectOf(to).x - rectOf(c).x}px, ${rectOf(to).y - rectOf(c).y}px) scale(0.5)` }], 380, { fill: 'forwards' })));
      break;
    }
    case 'handEnd':
    case 'gameOver':
      render(next);
      break;
    default:
      seatToast(ev, next);
  }
}

// The hand of a checked was, shown in the middle a moment; or the new
// cards of one let through.
async function showWas(ev, next) {
  shownCheck++;
  const who = NAME(next, ev.claimant);
  if (ev.checker < 0) {
    flash(`${who}: nieuwe kaarten`, 'was', 1200);
    sound.play('shuffle');
    await wait(700);
    return;
  }
  const verdict = ev.genuine ? `Echte ${R.wasName(ev.kind)}!` : 'Geen was: bluf!';
  E.shown.hidden = false;
  E.shown.replaceChildren(
    h('div', { class: 'tp-shown-cards' }, (ev.cards || []).map(c => createCard(c, { size: 'md' }))),
    h('b', { class: ev.genuine ? 'good' : 'bad', text: verdict }),
    h('small', { text: ev.genuine ? `${NAME(next, ev.checker)} krijgt een strafpunt.` : `${who} krijgt een strafpunt.` }));
  sound.play(ev.genuine ? 'roem' : 'nat');
  await wait(2200);
  E.shown.hidden = true;
}

function seatToast(ev, next) {
  const who = ev.seat != null ? NAME(next, ev.seat) : '';
  const text = { join: `${who} schuift aan`, leave: `${who} is vertrokken`, away: `${who} is weg`, back: `${who} is terug`, takeover: `Een AI-speler speelt voor ${who}` }[ev.type];
  if (text && ev.seat !== next.you) toast(text, { ms: 2200 });
}

export function onError() {
  pending = null;
  if (app.view) render(app.view);
}

export function resetRoom() {
  pending = null;
  selected = '';
  pendingVote = null;
  summaryFor = 0;
  app.toepSummary?.close(true);
  app.toepOver?.close(true);
  app.toepStand?.close(true);
  if (E.shown) E.shown.hidden = true;
}

export function resync() {
  pending = null;
  if (app.view) render(app.view);
}
