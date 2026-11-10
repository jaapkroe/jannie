// The table of toepen (games/toepen/README.md#the-site) at
// toepen.kroes.dev: the seats around the felt (two to six), the trick, the
// stake, your cards (four, eight in the koningsspel) and the questions of
// the round (was, check, toep), the takeover question, and the overlays of
// the game: the round summary, game over, the standings and the manual.
// The shell (main.js, home.js, panels.js) does the rest; game.js ties the
// two together. Pure parts: rules.js.
import { app, h, clear, icon, toast, avatar, fillAvatar, playerName, wait, anim, dur, vibrate, store } from './util.js';
import { createCard, createBack, cardName } from './cards.js';
import { sound } from './sound.js';
import * as panels from './panels.js';
import * as R from './rules.js';

const E = {};
let built = false;
let seatEls = [];        // per seat: its parts
let slotOf = new Map();  // seat → its trick slot element
let pileOf = new Map();  // seat → its pile of cards handed in for a vuile was
let pending = null;      // {t, at, key}: a decision sent, awaiting the server
let selected = '';       // a lifted card (touch: the first tap lifts, the second plays)
let chosen = new Set();  // the koningsspel: the cards picked to lay away
let pendingVote = null;  // our answer to the takeover question, awaiting the server
let summaryFor = 0;      // the round whose summary is up
let shownCheck = 0;      // the number of settled claims shown
const touch = matchMedia('(pointer: coarse)');
const STUCK_MS = 4000;

// Builds the table in #game once, at boot (main.js: table.init).
export function init() {
  if (built) return;
  built = true;
  const root = document.getElementById('game');
  E.top = h('header', { class: 'topbar tp-top' },
    E.pill = h('button', { class: 'tp-pill', type: 'button', title: 'Stand: de strafpunten van iedereen', onclick: openStand },
      h('span', { class: 'tp-pill-lbl', text: 'Jij' }), E.mine = h('b', { class: 'tp-pill-n', text: '0' }), E.limit = h('span', { class: 'tp-pill-lim' })),
    h('div', { class: 'potje', title: 'Het hoeveelste potje' },
      h('span', { class: 'potje-lbl', text: 'Potje' }), h('span', { class: 'potje-n' }, E.round = h('b', { text: '1' }))),
    E.stakeTop = h('div', { class: 'tp-stake-top', title: 'De inzet: zoveel strafpunten krijgt wie de laatste slag niet haalt' },
      h('span', { class: 'tp-st-lbl', text: 'Inzet' }), E.stakeN = h('b', { text: '1' })),
    h('span', { class: 'spacer' }),
    ...panels.toolButtons(['chat', 'why', 'help', 'settings', 'sound', 'menu']));
  E.why = E.top.querySelector('.tb-why');
  E.table = h('div', { class: 'tp-table' }, h('div', { class: 'tp-felt', 'aria-hidden': 'true' }));
  E.seats = h('div', { class: 'tp-seats' });
  E.trick = h('div', { class: 'tp-trick', role: 'group', 'aria-label': 'Slag op tafel' });
  E.chip = h('div', { class: 'tp-chip', 'aria-live': 'polite' }, E.chipN = h('b', { text: '1' }), h('span', { text: 'inzet' }));
  E.shown = h('div', { class: 'tp-shown', hidden: true });
  E.fx = h('div', { class: 'tp-fx', 'aria-live': 'polite' });
  E.piles = h('div', { class: 'tp-piles' });
  E.table.append(E.seats, E.piles, E.trick, E.chip, E.shown, E.fx);
  E.me = h('div', { class: 'tp-me' }, E.meAv = h('span', { class: 'avatar' }),
    h('span', { class: 'tp-me-txt' }, E.meName = h('b'), E.mePts = h('span', { class: 'tp-pts' })));
  E.text = h('div', { class: 'tp-text', 'aria-live': 'polite' }, E.textMain = h('b'), E.textSub = h('small'));
  E.actions = h('div', { class: 'tp-actions' });
  E.ring = panels.countdownRing();
  E.ringBox = h('span', { class: 'tp-ring', hidden: true }, E.ring.el);
  E.vote = h('div', { class: 'tp-vote', hidden: true });
  E.callDock = h('div', { class: 'call-dock', role: 'group', 'aria-label': 'Bellen', hidden: true });
  E.prompt = h('div', { class: 'tp-prompt' }, E.me, E.text, E.ringBox, E.actions, E.vote, E.callDock);
  E.hand = h('div', { class: 'tp-hand', role: 'group', 'aria-label': 'Jouw kaarten' });
  root.append(E.top, E.table, E.prompt, E.hand);
  // A tap beside your cards puts a lifted card down again.
  root.addEventListener('click', e => {
    if (selected && e.target.isConnected && !e.target.closest('.tp-hand .card')) { selected = ''; renderHand(app.view); }
  });
  document.addEventListener('keydown', onKey);
}

// ---------- render ----------

export function render(s) {
  if (!s) return;
  init();
  app.view = s;
  if (pending && (pending.key !== stateKey(s) || performance.now() - pending.at > STUCK_MS)) pending = null;
  if (!R.IN_HAND.has(s.phase)) selected = '';
  if (s.phase !== 'discard' || !s.lay) chosen.clear();
  E.table.dataset.players = s.players.length;
  renderTop(s);
  renderSeats(s);
  renderTrick(s);
  renderPrompt(s);
  renderHand(s);
  syncOverlays(s);
  renderWhy(s);
  renderCall();
}

// The call, once call.js is loaded: a seat's video in place of its face,
// and the call buttons by your name.
export function renderCall() {
  if (!app.call || !E.callDock) return;
  app.call.dock(E.callDock);
  for (const [seat, S] of seatEls.entries()) app.call.decorate(S.ring, seat);
}

// What main.js asks of every game's table, with nothing to do here.
export function settle() {}
export function welcomeBack() {}
export function relayout() {}

// What changes when a decision of ours went through.
const stateKey = s => `${s.handNo}/${s.phase}/${s.turn}/${s.tricks}/${s.trick?.cards?.length}/${s.answered?.[s.you]}/${s.stake}/${s.wasRound}/${s.checks?.length}`;

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
    clear(E.piles);
    seatEls = [];
    slotOf = new Map();
    pileOf = new Map();
    for (let seat = 0; seat < n; seat++) {
      const S = seatParts(seat);
      seatEls.push(S);
      E.seats.append(S.root);
      const slot = h('div', { class: 'tp-slot' });
      slotOf.set(seat, slot);
      E.trick.append(slot);
      const pile = h('div', { class: 'tp-pile', hidden: true, role: 'img' });
      pileOf.set(seat, pile);
      E.piles.append(pile);
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
    renderPile(s, seat, R.onEllipse(a - 17, 31, 31, 50, 55)); // beside the seat, toward its right
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
    setBacks(S, R.IN_HAND.has(s.phase) ? p?.cards ?? 0 : 0, R.IN_HAND.has(s.phase) ? s.open?.[seat] : null);
  }
  fillAvatar(E.meAv, s.players[s.you]);
  E.meName.replaceChildren(playerName(s.players[s.you]?.name || 'Jij'));
  E.mePts.textContent = R.pointsText(s.points?.[s.you] ?? 0) + (s.armoede?.[s.you] ? ' · armoede' : '') +
    (R.IN_HAND.has(s.phase) && s.open?.[s.you]?.length ? ' · je speelt open' : '');
  E.me.classList.toggle('turn', s.turn === s.you && R.IN_HAND.has(s.phase));
}

// The stake, in the top bar and on the chip.
function showStake(n) {
  E.stakeN.textContent = n;
  E.chipN.textContent = n;
  E.stakeTop.classList.toggle('hot', n > 1);
  E.chip.classList.toggle('hot', n > 1);
}

// The cards a seat handed in for a vuile was this round, or laid away in
// the koningsspel, face down beside it on the felt: one small pile, with ×n
// for more than one vuile was.
function renderPile(s, seat, at) {
  const pile = pileOf.get(seat);
  const laid = R.IN_HAND.has(s.phase) ? s.laid?.[seat] ?? 0 : 0;
  if (laid) {
    pile.style.left = at.x + '%';
    pile.style.top = at.y + '%';
    pile.hidden = false;
    if (pile.dataset.n === `laid${laid}`) return;
    pile.dataset.n = `laid${laid}`;
    const who = seat === s.you ? 'Jij legde' : `${s.players[seat]?.name || 'Speler'} legde`;
    pile.setAttribute('aria-label', `${who} ${laid} kaarten weg`);
    pile.title = pile.getAttribute('aria-label');
    pile.replaceChildren(...Array.from({ length: Math.min(laid, 3) }, () => createBack({ size: 'sm' })));
    return;
  }
  const n = R.IN_HAND.has(s.phase) ? R.washes(s, seat) : 0;
  pile.style.left = at.x + '%';
  pile.style.top = at.y + '%';
  pile.hidden = !n;
  if (Number(pile.dataset.n || 0) === n) return;
  pile.dataset.n = n;
  const who = seat === s.you ? 'Jij leverde' : `${s.players[seat]?.name || 'Speler'} leverde`;
  pile.setAttribute('aria-label', `${who} ${n === 1 ? 'een vuile was' : `${n} keer een vuile was`} in`);
  pile.title = pile.getAttribute('aria-label');
  pile.replaceChildren(...Array.from({ length: Math.min(n + 1, 4) }, () => createBack({ size: 'sm' })),
    n > 1 ? h('b', { class: 'tp-pile-n', text: `×${n}` }) : '');
}

// A seat's cards: backs, or, played face up after a bluff, the cards.
function setBacks(S, n, open = null) {
  const key = open?.length ? open.join() : String(n);
  if (S.backs.dataset.key === key) return;
  S.backs.dataset.key = key;
  S.backs.classList.toggle('open', !!open?.length);
  S.backs.replaceChildren(...(open?.length ? open.map(c => createCard(c, { size: 'sm' }))
    : Array.from({ length: n }, () => createBack({ size: 'sm' }))));
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
  const acts = q?.lay ? [{ t: 'discard', label: 'Wegleggen', kind: 'go', sub: `${chosen.size} van ${q.lay}`, off: chosen.size !== q.lay }] : q?.actions || [];
  E.actions.replaceChildren(...acts.map(a => h('button', {
    class: `btn tp-act tp-${a.kind}`, type: 'button', disabled: !!pending || !!a.off,
    onclick: () => decide(a),
  }, h('b', { text: a.label }), a.sub ? h('small', { text: a.sub }) : null)));
}

function decide(a) {
  if (pending) return;
  sound.unlock();
  sound.play(a.t === 'toep' || a.t === 'overtoep' ? 'knock' : 'click');
  const m = { t: a.t };
  if (a.play !== undefined) m.play = a.play;
  if (a.t === 'discard') m.cards = [...chosen];
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
  if (s.phase === 'discard' && s.lay) return renderDiscard(s, hand);
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
    // Not on to the table's click: the hand is drawn anew, and the table
    // would take a tap on this (now gone) card for one beside the cards.
    c.addEventListener('click', e => { e.stopPropagation(); tap(code); });
    return c;
  });
  E.hand.replaceChildren(...kids);
  E.hand.classList.toggle('mine', mine);
  // First another choice (a vuile was, a check, a toep): your cards wait.
  E.hand.classList.toggle('waiting', R.yours(s) && s.phase !== 'play');
  // Out of the round (passed, a bluff caught, out): your cards stay in
  // sight, faded, until the round ends.
  const out = hand.length > 0 && s.status?.[s.you] !== 'in';
  E.hand.classList.toggle('out', out);
  E.hand.setAttribute('aria-label', out ? 'Jouw kaarten (doen niet meer mee)' : 'Jouw kaarten');
  E.hand.classList.toggle('many', hand.length > 4); // the koningsspel: the cards overlap
  E.hand.classList.toggle('lots', hand.length > 8);
}

// The koningsspel, your turn to lay away: tap cards to pick them (again to
// put one back); the button under the table lays them away.
function renderDiscard(s, hand) {
  for (const c of chosen) if (!hand.includes(c)) chosen.delete(c);
  E.hand.replaceChildren(...hand.map(code => {
    const c = createCard(code, { size: 'lg' });
    c.classList.add('legal');
    c.classList.toggle('selected', chosen.has(code));
    c.tabIndex = 0;
    c.setAttribute('role', 'button');
    c.setAttribute('aria-pressed', String(chosen.has(code)));
    c.setAttribute('aria-label', `${cardName(code)}${chosen.has(code) ? ' (wegleggen)' : ''}`);
    c.addEventListener('click', e => { e.stopPropagation(); pick(code); });
    return c;
  }));
  E.hand.classList.add('mine');
  E.hand.classList.remove('waiting', 'out');
  E.hand.setAttribute('aria-label', 'Jouw kaarten');
  E.hand.classList.toggle('many', hand.length > 4);
  E.hand.classList.toggle('lots', hand.length > 8);
}

function pick(code) {
  const s = app.view;
  if (!s?.lay || pending) return;
  if (chosen.has(code)) chosen.delete(code);
  else if (chosen.size < s.lay) chosen.add(code);
  else { sound.play('error'); return; }
  sound.play('click');
  renderHand(s);
  renderPrompt(s);
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
  if (!s || document.body.dataset.screen !== 'game' || e.target.closest?.('input, textarea') || panels.isOpen()) return;
  const hand = s.hand || [];
  const k = Number(e.key);
  if (k >= 1 && k <= hand.length && s.turn === s.you && s.phase === 'play') {
    e.preventDefault();
    tap(hand[k - 1]);
  } else if ((e.key === 't' || e.key === 'T') && (s.canToep || s.canRaise && s.turn === s.you && s.phase === 'toep') && !pending) {
    e.preventDefault();
    decide({ t: s.phase === 'toep' ? 'overtoep' : 'toep' });
  }
}

// ---------- the takeover question ----------

// Shown to everyone connected while the game waits for a seat whose player
// is gone: may an AI play it? (docs/server.md#takeover-consent). The same
// messages as klaverjas.
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

// After every update, also those the shell draws itself (the lobby): a
// summary or game over still up closes once the room moved on.
export function sync(s) {
  if (s) syncOverlays(s);
}

function syncOverlays(s) {
  if (s.phase === 'handEnd') showSummary(s);
  else if (summaryFor) { summaryFor = 0; app.toepSummary?.close(true); }
  if (s.phase === 'gameOver') showOver(s);
  else {
    // Forgotten too: a rematch that ends after as many rounds shows its own.
    app.toepOver?.close(true);
    app.toepOver = null;
    panels.byId('tp-course')?.close(true);
  }
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
      h('span', { class: 'tp-sum-gain' + (gain > 0 ? ' plus' : ''), text: gain > 0 ? `+${gain}` : x.seat === row.winner ? '🏆' : '' }),
      meter(x.points, s.opts?.limit || 10, Math.max(0, -gain)),
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

// The penalty points as bars, red up to points; minus green bars after
// them: points just taken off (the boer).
export function meter(points, limit, minus = 0) {
  const el = h('span', { class: 'tp-meter', title: `${points} van ${limit}${minus ? `, ${minus} eraf met de boer` : ''}` });
  for (let k = 0; k < limit; k++) el.append(h('i', { class: k < points ? 'on' : k < points + minus ? 'minus' : '' }));
  return el;
}

// The course of the score: per round who won it (🏆, a green bar for a
// point off with the boer) and what each took, and the totals. At game
// over a round opens its overview (openCourse).
function roundsTable(s) {
  if (!s.rounds?.length) return null;
  const n = s.players.length;
  const order = Array.from({ length: n }, (_, k) => (s.you + k) % n);
  const head = h('tr', {}, h('th', { text: '#' }), order.map(seat => h('th', { title: s.players[seat]?.name || '' }, avatar(s.players[seat], 'xs'))));
  const cell = (r, seat) => {
    const g = r.gains?.[seat] ?? 0;
    if (r.winner === seat) {
      return h('td', { class: 'won', title: g < 0 ? 'Gewonnen met de boer: een strafpunt eraf' : 'Gewonnen' },
        '🏆', g < 0 ? h('span', { class: 'tp-minus', 'aria-label': `${g}` }) : null);
    }
    return h('td', { class: r.out?.[seat] && g > 0 ? 'out' : '', text: g ? `+${g}` : '·' });
  };
  const review = canReview(s);
  const rows = s.rounds.map((r, k) => review
    ? h('tr', { class: 'tp-st-tap', onclick: e => openCourse(s, k, e.currentTarget.querySelector('button')) },
      h('td', { class: 'tp-st-n' }, h('button', { class: 'tp-st-open', type: 'button', 'aria-label': `Potje ${r.hand} terugkijken`, text: r.hand })),
      order.map(seat => cell(r, seat)))
    : h('tr', {}, h('td', { class: 'tp-st-n', text: r.hand }), order.map(seat => cell(r, seat))));
  const total = h('tr', { class: 'tp-st-total' }, h('td', { text: 'Σ' }),
    order.map(seat => h('td', { class: R.isOut(s, seat) ? 'out' : '', text: String(s.points?.[seat] ?? 0) })));
  return h('div', { class: 'tp-st-scroll' }, h('table', { class: 'tp-st-table' }, h('thead', {}, head), h('tbody', {}, rows, total)));
}

// At game over every round can be looked back at: the server sends what
// happened in each (s.courses).
const canReview = s => s.phase === 'gameOver' && s.courses?.length === s.rounds?.length && s.rounds.length > 0;

// The overview of round k at game over (R.courseView): what happened
// before the first card, every trick with the toeps and answers in
// between, and the result; ‹ › go to the round before or after. Closed,
// the focus goes back to the round's button (from).
function openCourse(s, k, from = null) {
  sound.play('click');
  const prev = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Vorig potje', title: 'Vorig potje', onclick: () => show(k - 1) }, icon('back'));
  const next = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Volgend potje', title: 'Volgend potje', onclick: () => show(k + 1) }, icon('forward'));
  // Stand rebuilds its table on every update: then the same round's new
  // button in the same sheet.
  const host = from?.closest('.modal');
  const label = CSS.escape(from?.getAttribute('aria-label') || '');
  const back = () => (from?.isConnected ? from : host?.querySelector(`.tp-st-open[aria-label="${label}"]`))?.focus();
  const m = panels.openModal({ id: 'tp-course', title: 'Potje', cls: 'm-score tp-course', body: [], onClose: back });
  m.titleEl.after(prev, next);
  function show(j) {
    const v = R.courseView(s, j);
    if (!v) return;
    k = j;
    m.titleEl.textContent = v.title;
    m.dlg.setAttribute('aria-label', v.title);
    // A button that goes off drops the focus (Chromium at once): to the
    // other one, which is on (a single round has neither ever focused).
    const had = document.activeElement;
    prev.disabled = k === 0;
    next.disabled = k === s.rounds.length - 1;
    if ((had === prev || had === next) && had.disabled) (had === prev ? next : prev).focus();
    m.body.replaceChildren(h('p', { class: 'sheet-note', text: v.sub }), ...v.parts.map(part =>
      h('section', { class: 'tp-cs-part' }, h('h3', { text: part.title }), part.items.map(item => (item.cards
        ? h('div', { class: 'tp-cs-cards' }, item.cards.map(c =>
          h('div', { class: 'tp-cs-card' + (c.win ? ' win' : '') + (c.void ? ' void' : ''), title: c.void ? 'Telt niet meer: gepast' : '' },
            createCard(c.card, { size: 'sm' }), h('span', { class: 'tp-cs-name', text: c.name }))))
        : h('p', { class: 'tp-cs-line', text: item.text }))))));
    m.body.scrollTop = 0;
  }
  show(k);
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
      h('p', { class: 'over-sub', text: `Na ${s.handNo} ${s.handNo === 1 ? 'potje' : 'potjes'} ${won ? 'ben jij als enige over' : 'is er nog één speler over'}.` }),
      standTable(s), canReview(s) ? h('p', { class: 'sheet-note', text: 'Tik op een potje om terug te zien wat er gebeurde.' }) : null,
      roundsTable(s), h('div', { class: 'btn-col' }, btns)],
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
export function openStand() {
  sound.unlock();
  sound.play('click');
  const m = panels.openModal({ id: 'tp-stand', title: 'Stand', cls: 'm-score tp-stand', body: [] });
  m.refresh = s => {
    if (!s) return;
    m.body.replaceChildren(
      h('p', { class: 'sheet-note', text: `${R.variantText(s.opts || {})}. Wie de laatste slag niet haalt, krijgt de inzet als strafpunten.` }),
      standTable(s), roundsTable(s));
  };
  m.refresh(app.view);
  app.toepStand = m;
}

// The manual: tabs for the rules, the extra rules (this table's options),
// the terms and the controls, on the shell's tabs and scrolling pane (as
// klaverjas's handleiding). Opens on the tab last read.
let lastTab = 'regels';
export function openRules(tab) {
  sound.play('click');
  // At a table the extra rules say how they are played there; from the home
  // screen, what each is and its default.
  const atTable = document.body.classList.contains('in-room');
  const o = atTable ? app.s?.opts || app.view?.opts || {} : {};
  const tabsOf = R.manual(o, { touch: touch.matches, table: atTable });
  const content = h('div', { class: 'man-scroll tp-man', role: 'tabpanel' });
  const bar = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Delen van de spelregels' });
  const btns = tabsOf.map(x => h('button', {
    class: 'tab', type: 'button', role: 'tab', id: `tp-tab-${x.id}`, dataset: { id: x.id }, onclick: () => show(x.id),
  }, x.title));
  bar.append(...btns);
  bar.addEventListener('keydown', e => {
    const k = btns.indexOf(document.activeElement);
    if (k < 0 || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const b = btns[(k + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
    b.focus();
    show(b.dataset.id);
  });
  function show(id) {
    const tab = tabsOf.find(x => x.id === id) || tabsOf[0];
    lastTab = tab.id;
    for (const b of btns) {
      const on = b.dataset.id === tab.id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    content.setAttribute('aria-labelledby', `tp-tab-${tab.id}`);
    const terms = tab.id === 'begrippen';
    const note = atTable && (tab.id === 'extra' || tab.id === 'regels') ? [h('p', { class: 'sheet-note', text: `Aan deze tafel: ${R.variantText(o).toLowerCase()}.` })] : [];
    content.replaceChildren(...note,
      ...(terms ? [h('dl', { class: 'tp-terms' }, tab.parts.flatMap(([t, ps]) => [h('dt', { text: t }), h('dd', { text: ps.join(' ') })]))]
        : tab.parts.flatMap(([title, ps]) => [h('h3', { text: title }), ...ps.map(p => h('p', { text: p }))])));
    const next = tabsOf[tabsOf.indexOf(tab) + 1];
    if (next) {
      content.append(h('div', { class: 'man-next' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => show(next.id) }, `Volgende: ${next.title}`, icon('forward'))));
    }
    content.scrollTop = 0;
    btns.find(b => b.dataset.id === tab.id)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  panels.openModal({ id: 'tp-rules', title: 'Spelregels toepen', cls: 'm-manual tp-rules', body: [bar, content] });
  show(tab || lastTab);
}

// ---------- the reasoning of the AI (expert mode) ----------

const expert = () => store.get('expert', '') === '1';

// The robot in the top bar: in expert mode, alone with bots, in a round.
// An open sheet follows the state: the answer arrives in s.why, and a
// decision made closes it.
function renderWhy(s) {
  E.why.hidden = !(expert() && R.alone(s) && R.IN_HAND.has(s.phase));
  const m = panels.byId('tp-why');
  if (!m) return;
  if (s.why) m.show(s.why);
  else if (!R.yours(s)) m.close();
}

export function openWhy() {
  const s = app.view;
  if (!s) return;
  sound.play('click');
  const m = panels.openModal({ id: 'tp-why', title: 'Redenering van de AI', cls: 'm-sheet tp-why', body: [] });
  m.show = w => {
    const r = R.whyRows(w);
    m.body.replaceChildren(
      h('p', { class: 'tp-why-advice', text: r.advice }),
      h('p', { class: 'tp-why-text', text: r.why }),
      r.options.length ? h('table', { class: 'tp-why-table' }, h('tbody', {}, r.options.map(o =>
        h('tr', { class: o.best ? 'best' : '' }, h('th', { scope: 'row', text: o.label }), h('td', { text: o.value }),
          h('td', { class: 'tp-why-mark', text: o.best ? 'beste' : '' }))))) : null,
      r.rule ? h('p', { class: 'tp-why-rule', text: r.rule + (r.ruleCard ? ` ${r.ruleCard}` : '') }) : null,
      h('p', { class: 'sheet-note', text: r.note }));
  };
  if (!R.yours(s)) {
    m.body.replaceChildren(h('p', { text: 'Je bent nu niet aan zet: vraag het op je beurt.' }));
    return;
  }
  if (s.why) { m.show(s.why); return; }
  m.body.replaceChildren(h('p', { class: 'tp-why-wait', text: 'De AI rekent je kansen uit…' }));
  app.send({ t: 'why' });
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
  init();
  if (!ev || !prev) return;
  if (next.phase === 'lobby' || prev.phase === 'lobby' && ev.type !== 'deal') {
    seatToast(ev, next); // the lobby is the shell's
    return;
  }
  if (prev.players.length !== next.players.length || !seatEls.length) render(prev);
  switch (ev.type) {
    case 'deal': {
      sound.play('shuffle');
      if (ev.koning) flash('Koningsspel', 'poor', 1800);
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
      for (const seat of ev.seats) { bubble(next, seat, 'Vuile was!', 'was'); }
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
      bubble(next, ev.seat, ev.over ? 'Overtoep!' : 'Toep!', 'toep');
      showStake(ev.stake); // only the stake: the buttons wait for the next state
      flash(`${ev.seat === next.you ? '' : `${NAME(next, ev.seat)}: `}${ev.over ? 'overtoep' : 'toep'}!`.replace(/^./, c => c.toUpperCase()), 'toep');
      await wait(650);
      break;
    case 'discard': {
      const from = ev.seat === next.you ? E.hand : seatEls[ev.seat]?.ring;
      const pile = pileOf.get(ev.seat);
      if (pile) pile.hidden = false;
      const flights = [];
      for (let k = 0; k < ev.n; k++) { flights.push(fly('', from, pile, { ms: 340, back: true })); await wait(70); }
      sound.play('shuffle');
      await Promise.all(flights);
      break;
    }
    case 'answer':
      bubble(next, ev.seat, ev.auto ? 'Gaat vanzelf mee' : ev.stay ? 'Ik ga mee' : `Pas (+${ev.points})`, ev.stay ? 'go' : 'pass');
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
      if (ev.seat !== next.you) setBacks(seatEls[ev.seat], Math.max(0, (prev.players[ev.seat]?.cards ?? 1) - 1), prev.open?.[ev.seat]?.filter(c => c !== ev.card));
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

// The hand of a checked vuile was, shown in the middle a moment; then, for
// a hand handed in, its four cards go face down onto the claimant's pile
// and four new ones come from the stock.
async function showWas(ev, next) {
  shownCheck++;
  const who = NAME(next, ev.claimant);
  if (ev.checker < 0 && !ev.shown) {
    flash(`${who}: nieuwe kaarten`, 'was', 1200);
    await handIn(ev.claimant, next);
    return;
  }
  const verdict = ev.shown ? `${who}: armoede, echte ${R.wasName(ev.kind)}` : ev.genuine ? `Echte ${R.wasName(ev.kind)}!` : 'Geen vuile was: bluf!';
  const after = ev.shown ? 'Open op tafel; vier nieuwe kaarten.'
    : ev.genuine ? `${NAME(next, ev.checker)} krijgt een strafpunt.`
      : `${who} krijgt een strafpunt${next.open?.[ev.claimant]?.length ? ' en speelt open verder' : ''}.`;
  E.shown.hidden = false;
  E.shown.replaceChildren(
    h('div', { class: 'tp-shown-cards' }, (ev.cards || []).map(c => createCard(c, { size: 'md' }))),
    h('b', { class: ev.genuine ? 'good' : 'bad', text: verdict }),
    h('small', { text: after }));
  sound.play(ev.genuine ? 'roem' : 'nat');
  await wait(2200);
  E.shown.hidden = true;
  if (ev.washed) await handIn(ev.claimant, next);
}

// Four cards fly from the claimant to its pile, face down, and four new
// ones from the stock (the middle) back to it.
async function handIn(seat, next) {
  const hand = seat === next.you ? E.hand : seatEls[seat]?.ring;
  const pile = pileOf.get(seat);
  if (!hand || !pile) return;
  sound.play('shuffle');
  pile.hidden = false;
  const out = [];
  for (let k = 0; k < 4; k++) { out.push(fly('', hand, pile, { ms: 360, back: true })); await wait(60); }
  await Promise.all(out);
  render(next); // the pile as it now is
  const back = [];
  for (let k = 0; k < 4; k++) { back.push(fly('', E.chip, hand, { ms: 380, back: true, fade: seat === next.you })); sound.play('deal'); await wait(60); }
  await Promise.all(back);
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
  app.toepOver = null; // back at the same game over, it shows again
  app.toepStand?.close(true);
  if (E.shown) E.shown.hidden = true;
}

export function resync() {
  pending = null;
  if (app.view) render(app.view);
}
