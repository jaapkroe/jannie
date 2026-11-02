// The sheet Redenering van de AI (design §9 Expert), in the expert mode and
// in training, loaded when first needed: for the player's own decisions in
// the hand in play or just played, made or awaited now, the engine's
// reasoning (why) and a comment (feedback). Looking back at a hand is the
// review's (panels.js openReplay), as in any game.
import { cardShort } from './cards.js';
import { sound } from './sound.js';
import { app, h, icon, suitSym, suitify, toast } from './util.js';
import * as panels from './panels.js';

const PLAYING = new Set(['auction', 'discard', 'trump', 'bid', 'play']);
const whys = new Map();   // decision (its key) → the server's why
const failed = new Set(); // decisions whose question the server refused
const drafts = new Map(); // hand/trick → the comment on it: {text, saved}
let wait = null;          // the question out: {key, hand, trick, sent}
let shown = null;         // the decision on the sheet, what a comment is about
let form = null;          // the comment form: one for the page
let formOpen = false;
let redraw = null;        // shows the open sheet again
let deals = 0;            // deals seen (onDeal): a sheet of an earlier hand keeps no draft

// The sheet, on the decision awaited now when it is the player's turn,
// else on their latest one in this hand, short of the last card (there was
// only one card left to play).
export function openWhy() {
  const s = app.s;
  if (!s?.expert && !s?.training) return;
  const list = decisions(s);
  if (!list.length) { toast('Nog geen zet van jou in dit potje.'); return; }
  sound.play('click');
  let at = list.length - 1; // the decision awaited now comes last
  if (list[at].trick === 8 && at > 0) at--;
  form ??= panels.feedbackForm(() => ({ hand: shown.hand, trick: shown.trick }), 'Commentaar', 'Wat klopt er volgens jou niet, of wat is beter?', onSaved);
  // Stepping to a decision asks again what the server refused for it.
  const step = k => { at += k; failed.delete(list[at].key); sound.play('click'); draw(); };
  const prev = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Vorige zet', title: 'Vorige zet', onclick: () => step(-1) }, icon('back'));
  const next = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Volgende zet', title: 'Volgende zet', onclick: () => step(1) }, icon('forward'));
  const head = h('b');
  const out = h('div', { class: 'why-out' });
  const m = panels.openModal({
    id: 'why', title: 'Redenering van de AI', cls: 'm-why', body: [
      h('div', { class: 'why-head' }, prev, h('p', { 'aria-live': 'polite' }, head), next),
      out,
      h('details', { class: 'xp-fb', open: formOpen, ontoggle: e => { formOpen = e.target.open; } },
        h('summary', { text: 'Commentaar bij deze zet' }), form,
        h('p', { class: 'legend', text: 'Je opmerking wordt met je naam bewaard, net als de partij zelf: hooguit 12 maanden, voor statistieken en om het spel te verbeteren.' })),
    ],
  });
  // The decision at `at`, its reasoning asked for when not known yet (one
  // question at a time: the next once the one out is answered), and the
  // comment typed or saved for it.
  function draw() {
    const d = list[at];
    if (shown !== d) {
      if (shown) drafts.set(commentKey(shown), form.value());
      form.load(drafts.get(commentKey(d)));
    }
    shown = d;
    prev.disabled = at === 0;
    next.disabled = at === list.length - 1;
    const w = whys.get(d.key);
    head.replaceChildren(suitify(headText(d, w)));
    if (!w && !wait && !failed.has(d.key)) { ask(d); return; }
    out.replaceChildren(w ? whyView(w) : failed.has(d.key)
      ? h('p', { class: 'xp-note' }, 'De AI gaf hier geen antwoord. ',
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { failed.delete(d.key); sound.play('click'); draw(); } }, 'Opnieuw'))
      : h('p', { class: 'xp-note', text: 'De AI denkt na…' }));
  }
  redraw = draw;
  const dealt = deals;
  // Once gone (a moment after closing): unless a new sheet opened meanwhile.
  m.onRemove = () => {
    if (redraw !== draw) return;
    redraw = null;
    if (shown && deals === dealt) drafts.set(commentKey(shown), form.value());
    shown = null;
  };
  draw();
}

// A comment is about a decision's hand and trick.
const commentKey = d => `${d.hand}/${d.trick}`;

// The server kept a comment: it stays with its decision, marked saved,
// unless its text was changed meanwhile. The form shows that only while the
// sheet is still on that decision.
function onSaved(about, text) {
  const k = commentKey(about);
  if (shown && commentKey(shown) === k) return true; // the form tells whether its text is still what was sent
  if ((drafts.get(k)?.text ?? text) === text) drafts.set(k, { text, saved: true });
  return false;
}

// The server's reasoning for the question out.
export function onWhy(m) {
  if (!wait || m.hand !== wait.hand || m.trick !== wait.trick) return;
  whys.set(wait.key, m);
  wait = null;
  redraw?.();
}

// The server refused something: a question still out is given up, and its
// decision shows Opnieuw.
export function onError() {
  if (!wait) return;
  failed.add(wait.key);
  wait = null;
  redraw?.();
}

// The connection is back, the join just sent and what was queued while
// offline not yet (panels.onReconnect): the answer to a question sent over
// the old connection goes there, so it is asked again (an open sheet asks
// at once); a question queued meanwhile goes out next, over this
// connection, and is answered.
export function onReconnect() {
  if (!wait) return;
  if (!wait.sent) { wait.sent = true; return; }
  wait = null;
  redraw?.();
}

// A new deal (panels.sync): the answers and comments about the hands before
// are forgotten, and so is a question about them still out, whose answer
// then counts no more (a rematch with the same seed has the same hand
// numbers).
export function onDeal() {
  deals++;
  whys.clear();
  failed.clear();
  drafts.clear();
  wait = null;
}

// Asks the server's reasoning for decision d; one question is out at a time.
function ask(d) {
  const w = wait = { key: d.key, hand: d.hand, trick: d.trick };
  w.sent = app.send({ t: 'why', hand: d.hand, trick: d.trick }); // false: queued until the connection is back
  redraw?.();
}

// ---------- the player's decisions ----------

// The player's own decisions in the hand in play or just played, from the
// state: the bid or trump choice before the first card (trick 0), the cards
// played (tricks 1 to 8), and the decision awaited now. Before the first
// card the server knows a decision by the player's last one, or the one
// awaited now: in gedraaid a pass and then, once everyone passed, the trump
// choice. kind keeps those apart, and key names a decision for the answers
// kept: an answer about a decision awaited is not one about it made. With
// tips on the decision awaited now comes with its hint (in training the
// state has one on every turn); with tips off, or in the expert mode, there
// is no hint and it is always there.
function decisions(s) {
  const out = [];
  const add = (trick, kind, awaited) => out.push({
    hand: s.handNo, trick, kind, awaited, key: `${s.handNo}/${trick}/${kind}/${awaited ? 'nu' : 'gedaan'}`,
  });
  const turn = s.turn === s.you && PLAYING.has(s.phase);
  const asks = turn && (s.expert || !s.opts.tips || !!s.hint);
  const bid = s.bids?.[s.you] ?? -1; // gedraaid: -1 none yet, 0 passen, 1 spelen
  if (turn && (s.phase === 'bid' || s.phase === 'trump')) {
    if (asks) add(0, s.phase === 'trump' ? 'suit' : 'bid', true);
  } else if (bid >= 0 || s.trumpBy === s.you) add(0, s.trumpBy === s.you && bid !== 1 ? 'suit' : 'bid', false);
  // Out of a hand (its end, game over) the state holds no cards: all eight were played.
  const played = PLAYING.has(s.phase) ? 8 - (s.hand?.length ?? 8) : 8;
  for (let t = 1; t <= played; t++) add(t, 'card', false);
  if (asks && s.phase === 'play') add(played + 1, 'card', true);
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
// rule's reason), sterk and the hint, and the value of every option. A
// card's row, tapped, says under the table why the best brings more (its
// `why`); the card played starts picked, else normaal's, when it has one.
// The pick stays with the answer, for the life of the sheet's answers.
function whyView(w) {
  if (!w.options.length) return h('p', { class: 'xp-note', text: 'Voor deze beslissing heeft de AI geen redenering.' });
  const cards = w.options.some(o => o.parts);
  const best = Math.max(...w.options.map(o => o.value));
  const heads = cards
    ? ['Kaart', 'Waarde', '±', 'Punten slag', 'Punten later', 'Roem slag', 'Roem later', 'Nat', 'Pit', 'Nat wij', 'Nat zij']
    : [w.options[0].suit ? 'Troef' : 'Keuze', 'Waarde', '±', 'Nat wij', 'Nat zij'];
  const reasons = cards && w.options.some(o => o.why);
  w.pick ??= [w.played, w.normaal].map(c => w.options.findIndex(o => o.why && same(o, c))).find(i => i >= 0) ?? -1;
  const said = h('p', { class: 'xp-said', 'aria-live': 'polite' });
  const pick = i => {
    w.pick = i;
    rows.forEach((r, k) => {
      r.classList.toggle('xp-sel', k === i);
      r.querySelector('.xp-pick')?.setAttribute('aria-pressed', String(k === i));
    });
    const o = w.options[i];
    said.replaceChildren(!o ? 'Tik op een kaart in de tabel: dan staat hier waarom de kaart met de hoogste waarde meer oplevert.'
      : suitify(o.why || `${label(o)} heeft de hoogste waarde.`));
  };
  const rows = w.options.map((o, i) => h('tr', {
    class: (same(o, w.played) ? 'xp-played' : '') + (o.value === best ? ' xp-best' : ''),
    onclick: reasons ? () => { sound.play('click'); pick(i); } : null,
  },
    h('th', {}, reasons ? h('button', { class: 'xp-pick', type: 'button', 'aria-pressed': 'false' }, suitify(label(o))) : suitify(label(o)),
      same(o, w.played) ? h('small', { text: o.card ? ' gespeeld' : ' gekozen' }) : null),
    h('td', { text: num(o.value) }),
    h('td', { text: o.value === best ? '' : o.se.toFixed(1).replace('.', ',') }),
    ...(cards ? (o.parts || []).map(p => h('td', { text: num(p) })) : []),
    h('td', { text: pct(o.natUs) }),
    h('td', { text: pct(o.natThem) })));
  if (reasons) pick(w.pick);
  const rule = w.rule.replace(/^[^:]*: /, '');
  return h('div', { class: 'xp-why' },
    h('p', {}, h('b', { text: 'Normaal: ' }), suitify(what(w.normaal) + (rule ? ` · ${rule}` : ''))),
    h('p', {}, h('b', { text: 'Sterk: ' }), suitify(what(w.sterk) + (w.sterkWhy ? ` · ${w.sterkWhy}` : ''))),
    h('p', {}, h('b', { text: 'Tip: ' }), suitify(w.hintText + (w.hintWhy ? ` ${w.hintWhy}` : ''))),
    w.worlds ? h('div', { class: 'xp-scroll' }, h('table', { class: 'xp-table' + (reasons ? ' xp-pickable' : '') },
      h('thead', {}, h('tr', {}, heads.map(t => h('th', { text: t })))),
      h('tbody', {}, rows))) : null,
    reasons ? said : null,
    h('p', { class: 'legend' }, w.worlds ? `Over ${w.worlds} verdelingen van de kaarten die jij niet kon zien. ` : 'Er mocht maar één kaart. ',
      panels.infoBtn('Redenering van de AI', [
        'Normaal: de keuze van de AI-spelers op Normaal, met de regel die hem koos. Sterk: de keuze van de AI-spelers op Sterk, uit deze berekening. Tip: wat Juf Jannie bij Oefenen aanraadt.',
        'De AI speelt elke keuze uit over honderden verdelingen van de kaarten die de speler niet kon zien, telkens met eenvoudige regels tot het eind van het potje.',
        `Waarde: hoeveel punten jij en je maat gemiddeld meer halen dan de tegenstanders aan het eind van het potje, roem, nat en pit meegeteld. ±: de standaardfout van het verschil met de beste; een verschil van minder dan twee keer ± kan toeval zijn.`,
        ...(cards ? ['Punten slag, punten later, roem slag en roem later: hetzelfde verschil, alleen van de kaartpunten of van de roem, in deze slag en in de latere slagen, als het spelende team het potje haalt. Nat: gaat het spelende team nat, dan krijgt één team alles en telt dat hier. Pit: de pitbonus. Samen zijn ze de waarde, min wat er voor deze kaart al gehaald was.',
          'Tik op een kaart in de tabel: onder de tabel staat dan hoeveel meer de kaart met de hoogste waarde oplevert en waar vooral, en wat er in dezelfde verdelingen anders loopt: hoe vaak een kaart van jou naar de tegenstanders gaat, wie de laatste slag haalt of wie roem maakt in deze slag. Dat laatste staat er alleen bij als het minstens 2 punten scheelt, en een kwart van wat de kaart meer oplevert aan punten en roem zonder nat en pit, en meer dan toeval is.'] : []),
        `Nat wij: de kans dat jij en je maat spelen en nat gaan. Nat zij: de kans dat de tegenstanders spelen en nat gaan.`,
        ...(cards ? ['Sterk speelt niet altijd de kaart met de hoogste waarde: geen vals sein voor minder dan 20 punten (kleintje boer of boer over boer: 10), tenzij de kaart van Normaal zelf al een vals sein is, en bij heel weinig verschil de kaart van Normaal. Staat Sterk niet op de hoogste waarde, dan staat erbij waarom. De tip houdt de kaart van Normaal aan, tenzij Sterk minstens 5 punten en minstens twee keer de standaardfout beter is.'] : []),
        'De AI-spelers op Sterk rekenen met hun eigen verdelingen en, naar karakter, met wat zin in pit: hun keuze kan een enkele keer anders zijn dan hier.',
      ])));
}
