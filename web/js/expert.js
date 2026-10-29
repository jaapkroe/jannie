// The expert mode's sheet Redenering van de AI (design §9 Expert), loaded
// when an expert game first needs it: for the player's own decisions in the
// hand in play or just played, made or awaited now, the engine's reasoning
// (why) and a comment (feedback). Looking back at a hand is the review's
// (panels.js openReplay), as in any game.
import { cardShort } from './cards.js';
import { sound } from './sound.js';
import { app, h, icon, suitSym, suitify, toast } from './util.js';
import * as panels from './panels.js';

const PLAYING = new Set(['auction', 'discard', 'trump', 'bid', 'play']);
const whys = new Map();  // decision (its key) → the server's why
let wait = null;         // the question out: {key, hand, trick}
let shown = null;        // the decision on the sheet, what a comment is about
let form = null;         // the comment form: one for the page, so typed text stays
let formOpen = false;
let redraw = null;       // shows the open sheet again

// The sheet, on the decision awaited now when it is the player's turn,
// else on their latest one in this hand, short of the last card (there was
// only one card left to play).
export function openWhy() {
  const s = app.s;
  if (!s?.expert) return;
  const list = decisions(s);
  if (!list.length) { toast('Nog geen zet van jou in dit potje.'); return; }
  sound.play('click');
  let at = list.length - 1; // the decision awaited now comes last
  if (list[at].trick === 8 && at > 0) at--;
  form ??= panels.feedbackForm(() => ({ hand: shown.hand, trick: shown.trick }), 'Commentaar', 'Wat klopt er volgens jou niet, of wat is beter?');
  const step = k => { at += k; sound.play('click'); draw(); };
  const prev = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Vorige zet', title: 'Vorige zet', onclick: () => step(-1) }, icon('back'));
  const next = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Volgende zet', title: 'Volgende zet', onclick: () => step(1) }, icon('forward'));
  const head = h('b');
  const out = h('div', { class: 'why-out' });
  const m = panels.openModal({
    id: 'why', title: 'Redenering van de AI', cls: 'm-why', body: [
      h('div', { class: 'why-head' }, prev, h('p', { 'aria-live': 'polite' }, head), next),
      out,
      h('details', { class: 'xp-fb', open: formOpen, ontoggle: e => { formOpen = e.target.open; } },
        h('summary', { text: 'Commentaar bij deze zet' }), form),
    ],
  });
  function draw() {
    const d = list[at];
    // "Bewaard." was about the decision shown before.
    if (shown !== d) form.querySelector('.fb-status').textContent = '';
    shown = d;
    prev.disabled = at === 0;
    next.disabled = at === list.length - 1;
    const w = whys.get(d.key);
    head.replaceChildren(suitify(headText(d, w)));
    const asking = wait?.key === d.key;
    out.replaceChildren(w ? whyView(s, w)
      : h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: !!wait, onclick: () => { sound.play('click'); ask(d); } },
        asking ? null : icon('search'), asking ? 'De AI denkt na…' : 'Redenering van de AI'));
  }
  redraw = draw;
  m.onRemove = () => { if (redraw === draw) redraw = null; };
  const d = list[at];
  if (!whys.has(d.key) && !wait) ask(d);
  else draw();
}

// The server's reasoning for the question out.
export function onWhy(m) {
  if (!wait || m.hand !== wait.hand || m.trick !== wait.trick) return;
  whys.set(wait.key, m);
  wait = null;
  redraw?.();
}

// The server refused something, or the connection the question went out on
// is gone: a question still out gets its button back.
export function onError() {
  if (!wait) return;
  wait = null;
  redraw?.();
}

// A new deal (panels.sync): the answers about the hands before are
// forgotten, and so is a question about them still out, whose answer then
// counts no more (a rematch with the same seed has the same hand numbers).
export function onDeal() {
  whys.clear();
  wait = null;
}

// Asks the server's reasoning for decision d; one question is out at a time.
function ask(d) {
  wait = { key: d.key, hand: d.hand, trick: d.trick };
  app.send({ t: 'why', hand: d.hand, trick: d.trick });
  redraw?.();
}

// ---------- the player's decisions ----------

// The player's own decisions in the hand in play or just played, from the
// state: the bid or trump choice before the first card (trick 0), the cards
// played (tricks 1 to 8), and the decision awaited now. Before the first
// card the server knows a decision by the player's last one, or the one
// awaited now: in gedraaid a pass and then, once everyone passed, the trump
// choice. kind keeps those apart, and key names a decision for the answers
// kept: an answer about a decision awaited is not one about it made.
function decisions(s) {
  const out = [];
  const add = (trick, kind, awaited) => out.push({
    hand: s.handNo, trick, kind, awaited, key: `${s.handNo}/${trick}/${kind}/${awaited ? 'nu' : 'gedaan'}`,
  });
  const turn = s.turn === s.you && PLAYING.has(s.phase);
  const bid = s.bids?.[s.you] ?? -1; // gedraaid: -1 none yet, 0 passen, 1 spelen
  if (turn && (s.phase === 'bid' || s.phase === 'trump')) add(0, s.phase === 'trump' ? 'suit' : 'bid', true);
  else if (bid >= 0 || s.trumpBy === s.you) add(0, s.trumpBy === s.you && bid !== 1 ? 'suit' : 'bid', false);
  // Out of a hand (its end, game over) the state holds no cards: all eight were played.
  const played = PLAYING.has(s.phase) ? 8 - (s.hand?.length ?? 8) : 8;
  for (let t = 1; t <= played; t++) add(t, 'card', false);
  if (turn && s.phase === 'play') add(played + 1, 'card', true);
  return out;
}

// The decision on the sheet: "Slag 3 · Jij bent aan de beurt", "Voor de
// eerste kaart", and once an answer names the choice made "Slag 3 · Jij
// speelde ♠8", "Jij: ♥ als troef", "Jij: passen".
function headText(d, w) {
  const at = d.trick ? `Slag ${d.trick}` : 'Voor de eerste kaart';
  if (d.awaited) return `${at} · Jij bent aan de beurt`;
  const p = w?.played;
  if (!p) return at;
  return p.card ? `${at} · Jij speelde ${cardShort(p.card)}` : `Jij: ${what(p)}`;
}

// ---------- the reasoning ----------

const label = c => (c.card ? cardShort(c.card) : c.suit ? suitSym(c.suit) : c.play ? 'Spelen' : 'Passen');
const what = c => (c.card ? cardShort(c.card) : c.suit ? `${suitSym(c.suit)} als troef` : c.play ? 'spelen' : 'passen');
const same = (a, b) => !!a && !!b && label(a) === label(b);
const num = x => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1).replace('.', ',');
const pct = x => `${Math.round(100 * x)}%`;

// The engine's reasoning (design §7 why): the choices of normaal (with its
// rule's reason), sterk and the hint, and the value of every option.
function whyView(s, w) {
  if (!w.options.length) return h('p', { class: 'xp-note', text: 'Voor deze beslissing heeft de AI geen redenering.' });
  const cards = w.options.some(o => o.parts);
  const best = Math.max(...w.options.map(o => o.value));
  const heads = cards
    ? ['Kaart', 'Waarde', '±', 'Punten slag', 'Punten later', 'Roem slag', 'Roem later', 'Nat, pit', 'Nat wij', 'Nat zij']
    : [w.options[0].suit ? 'Troef' : 'Keuze', 'Waarde', '±', 'Nat wij', 'Nat zij'];
  const rows = w.options.map(o => h('tr', { class: (same(o, w.played) ? 'xp-played' : '') + (o.value === best ? ' xp-best' : '') },
    h('th', {}, suitify(label(o)), same(o, w.played) ? h('small', { text: o.card ? ' gespeeld' : ' gekozen' }) : null),
    h('td', { text: num(o.value) }),
    h('td', { text: o.value === best ? '' : o.se.toFixed(1).replace('.', ',') }),
    ...(cards ? (o.parts || []).map(p => h('td', { text: num(p) })) : []),
    h('td', { text: pct(o.natUs) }),
    h('td', { text: pct(o.natThem) })));
  const rule = w.rule.replace(/^[^:]*: /, '');
  return h('div', { class: 'xp-why' },
    h('p', {}, h('b', { text: 'Normaal: ' }), suitify(what(w.normaal) + (rule ? ` · ${rule}` : ''))),
    h('p', {}, h('b', { text: 'Sterk: ' }), suitify(what(w.sterk))),
    h('p', {}, h('b', { text: 'Tip: ' }), suitify(w.hintText)),
    w.worlds ? h('div', { class: 'xp-scroll' }, h('table', { class: 'xp-table' },
      h('thead', {}, h('tr', {}, heads.map(t => h('th', { text: t })))),
      h('tbody', {}, rows))) : null,
    h('p', { class: 'legend' }, w.worlds ? `Over ${w.worlds} verdelingen van de kaarten die jij niet kon zien. ` : 'Er mocht maar één kaart. ',
      panels.infoBtn('Redenering van de AI', [
        'Normaal: de keuze van de AI-spelers op Normaal, met de regel die hem koos. Sterk: de keuze van de AI-spelers op Sterk, uit deze berekening. Tip: wat Juf Jannie bij Oefenen aanraadt.',
        'De AI speelt elke keuze uit over honderden verdelingen van de kaarten die de speler niet kon zien, telkens met eenvoudige regels tot het eind van het potje.',
        `Waarde: hoeveel punten jij en je maat gemiddeld meer halen dan de tegenstanders aan het eind van het potje, roem, nat en pit meegeteld. ±: de standaardfout van het verschil met de beste; een verschil van minder dan twee keer ± kan toeval zijn.`,
        ...(cards ? ['Punten slag, punten later, roem slag en roem later: hetzelfde verschil, alleen van de kaartpunten of van de roem, in deze slag en in de latere slagen. Nat, pit: wat nat en pit daar nog aan toevoegen. Samen zijn ze de waarde, min wat er voor deze kaart al gehaald was.'] : []),
        `Nat wij: de kans dat jij en je maat spelen en nat gaan. Nat zij: de kans dat de tegenstanders spelen en nat gaan.`,
        'De AI-spelers op Sterk rekenen met hun eigen verdelingen en, naar karakter, met wat zin in pit: hun keuze kan een enkele keer anders zijn dan hier.',
      ])));
}
