// The expert mode's tools in the replay (design §9 Expert), loaded when an
// expert game first needs them. At every step of a hand they show the
// decisions there (each seat's bid or trump choice before the first card,
// the card about to be played, or the decision awaited now), and for the
// one chosen: the engine's reasoning (why), the expert's own choice (mark)
// and a comment (feedback), for any seat, while the match runs and after.
import { cardShort } from './cards.js';
import { sound } from './sound.js';
import { app, h, icon, nameOf, suitSym, suitName, isRed, suitify } from './util.js';
import * as panels from './panels.js';

const SUITS = ['C', 'D', 'H', 'S'];
const whys = new Map();    // situation (sitKey) → the server's why, or 'wait'
const asked = new Map();   // hand/trick/seat → the situation asked about
let chosen = { at: '', key: '' }; // the decision chosen at a step (hand/step)
let current = null;        // what a comment is about: {hand, trick, seat}
let form = null;           // the comment form: one per replay, so typed text stays
let formOpen = false;
let redraw = null;         // shows the replay again

const tools = { box, card, onError };

// Opens the replay of the expert's hands at {hand, step} (step 'end': after
// the latest card), or at a moment of the review.
export function openPanel(at = {}) {
  const s = app.s;
  const hands = s?.expert?.hands;
  if (!hands?.length) return;
  form = panels.feedbackForm(() => ({ ...current }), 'Commentaar', 'Wat klopt er volgens jou niet, of wat is beter?');
  const start = at.moment ? null : { hand: at.hand ?? hands[0].hand, step: at.step ?? 0 };
  panels.openReplay(s, { hands, moment: at.moment || null, at: start, source: st => st.expert?.hands, tools });
}

// The server's reasoning for a decision.
export function onWhy(m) {
  const k = `${m.hand}/${m.trick}/${m.seat}`;
  const sit = asked.get(k);
  if (!sit) return;
  asked.delete(k);
  whys.set(sit, m);
  redraw?.();
}

// The server refused something: a question still out gets its button back.
function onError() {
  for (const [k, sit] of asked) {
    if (whys.get(sit) === 'wait') whys.delete(sit);
    asked.delete(k);
  }
  redraw?.();
}

// ---------- the decisions at a step ----------

const label = c => (c.card ? cardShort(c.card) : c.suit ? suitSym(c.suit) : c.play ? 'Spelen' : 'Passen');
const what = c => (c.card ? cardShort(c.card) : c.suit ? `${suitSym(c.suit)} als troef` : c.play ? 'spelen' : 'passen');
const same = (a, b) => !!a && !!b && label(a) === label(b);
const kindOf = c => (c.card ? 'card' : c.suit ? 'suit' : 'play');

// The decisions at the step of ctx: before the first card each seat's last
// bid or trump choice (the server knows a seat's decision before play by
// its last one); the card about to be played; or, after the latest card of
// the hand in play, the decision awaited now.
function decisions(ctx) {
  const { s, rh, step, played, next, live } = ctx;
  const out = [];
  if (step === 0) {
    const last = new Map((rh.pre || []).map(p => [p.seat, p]));
    for (const p of rh.pre || []) {
      if (last.get(p.seat) === p) out.push({ trick: 0, seat: p.seat, done: p, kind: kindOf(p) });
    }
  }
  if (step < played.length) {
    const pc = played[step];
    out.push({ trick: ctx.trick, seat: pc.seat, done: { card: pc.card }, kind: 'card', legal: rh.legal?.[step] || [] });
  } else if (live && next >= 0) {
    const trick = s.phase === 'play' ? ctx.trick : 0;
    if (!out.some(d => d.trick === trick && d.seat === next)) out.push({ trick, seat: next, done: null, kind: s.phase === 'play' ? 'card' : '' });
  }
  for (const d of out) d.key = `${rh.hand}/${d.trick}/${d.seat}`;
  return out;
}

// The decision chosen at the step of ctx: the card (or the one awaited
// now) unless another one was tapped.
function decide(ctx) {
  if (ctx.xp !== undefined) return ctx.xp;
  const list = decisions(ctx);
  const at = `${ctx.rh.hand}/${ctx.step}`;
  if (chosen.at !== at || !list.some(d => d.key === chosen.key)) chosen = { at, key: list.at(-1)?.key || '' };
  ctx.xp = list.find(d => d.key === chosen.key) || null;
  ctx.list = list;
  return ctx.xp;
}

// The situation of decision d: the hand, the decisions before the first
// card and the cards before d. A rematch with the same seed, or the
// decision being made meanwhile, is another situation.
function sitKey(ctx, d) {
  const pre = (ctx.rh.pre || []).map(p => p.seat + label(p)).join(' ');
  const cards = ctx.played.slice(0, ctx.step).map(pc => pc.card).join('');
  return `${d.key}|${pre}|${cards}|${d.done ? '' : 'nu'}`;
}

const markOf = (s, d) => s.expert?.marks?.find(x => `${x.hand}/${x.trick}/${x.seat}` === d.key);

function mark(ctx, d, choice) {
  sound.play('click');
  app.send({ t: 'mark', hand: ctx.rh.hand, trick: d.trick, seat: d.seat, ...choice });
}

function ask(ctx, d) {
  const sit = sitKey(ctx, d);
  whys.set(sit, 'wait');
  asked.set(d.key, sit);
  sound.play('click');
  app.send({ t: 'why', hand: ctx.rh.hand, trick: d.trick, seat: d.seat });
  ctx.render();
}

// ---------- the tools ----------

// A card in the hands: the decider's card at this step is marked, and the
// cards it could play there take the expert's own choice.
function card(el, seat, c, ctx) {
  const d = decide(ctx);
  if (!d?.done?.card || seat !== d.seat) return;
  const own = markOf(ctx.s, d)?.card;
  if (c === d.done.card) el.classList.add('xp-next');
  if (c === own) el.classList.add('rp-mine');
  if (!d.legal.includes(c)) return;
  el.classList.add('rp-pick');
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-pressed', String(c === own));
  el.setAttribute('aria-label', `${cardShort(c)} als jouw keuze`);
  const pick = () => mark(ctx, d, c === own ? {} : { card: c });
  el.addEventListener('click', pick);
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
}

// Under the table: the decisions at this step, and for the one chosen its
// reasoning, the expert's own choice and a comment.
function box(ctx) {
  redraw = ctx.render;
  const d = decide(ctx);
  if (!d) return null;
  const { s } = ctx;
  current = { hand: ctx.rh.hand, trick: d.trick, seat: d.seat };
  const who = nameOf(s, d.seat);
  const head = d.done
    ? `${d.trick ? `Slag ${d.trick} · ` : ''}${who}${d.kind === 'card' ? ' speelde ' : ': '}${what(d.done)}`
    : `${d.trick ? `Slag ${d.trick} · ` : ''}${d.seat === s.you ? 'Jij bent' : `${who} is`} aan de beurt`;
  const chips = ctx.list.length > 1 ? h('div', { class: 'xp-chips', role: 'group', 'aria-label': 'Beslissingen' }, ctx.list.map(x => h('button', {
    class: 'btn btn-ghost btn-sm xp-chip', type: 'button', 'aria-pressed': String(x === d),
    onclick: () => { chosen.key = x.key; sound.play('click'); ctx.render(); },
  }, suitify(`${nameOf(s, x.seat)}${!x.done ? ': aan de beurt' : x.kind === 'card' ? ' speelde ' : ': '}${x.done ? what(x.done) : ''}`)))) : null;

  const sit = sitKey(ctx, d);
  const w = whys.get(sit);
  const why = w === 'wait'
    ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: true }, 'De AI denkt na…')
    : w ? null
      : h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => ask(ctx, d) }, icon('search'), 'Redenering van de AI');

  return h('section', { class: 'xp-box' },
    chips,
    h('p', { class: 'xp-head' }, h('b', {}, suitify(head))),
    d.done ? ownChoice(ctx, d) : null,
    why,
    w && w !== 'wait' ? whyView(s, w) : null,
    h('details', { class: 'rp-fb xp-fb', open: formOpen, ontoggle: e => { formOpen = e.target.open; } },
      h('summary', {}, suitify(`Commentaar bij ${d.done ? `${what(d.done)} van ${who === 'Jij' ? 'jou' : who}` : 'deze beurt'}`)),
      form));
}

// The expert's own choice for a decision made: a card is tapped in the
// hand, a trump suit or a bid is chosen here. Tapping it again clears it.
function ownChoice(ctx, d) {
  const own = markOf(ctx.s, d);
  if (d.kind === 'card') {
    return h('p', { class: 'rp-own' }, own
      ? [h('span', { class: 'rp-key rp-mine' }), suitify(`Jouw keuze: ${cardShort(own.card)}. Tik er nog eens op om hem weg te halen.`)]
      : d.legal.length > 1 ? 'Jouw keuze: tik op de kaart die jij hier het beste vindt.' : 'Er mocht hier maar één kaart.');
  }
  if (d.kind === 'suit') {
    return h('div', { class: 'rp-own rp-own-suits' }, h('span', { text: 'Jouw troefkeuze:' }),
      SUITS.map(su => h('button', {
        class: 'btn btn-ghost btn-sm rp-suit' + (isRed(su) ? ' red' : ''), type: 'button', 'aria-pressed': String(own?.suit === su),
        'aria-label': suitName(su), title: suitName(su), onclick: () => mark(ctx, d, own?.suit === su ? {} : { suit: su }),
      }, suitSym(su))));
  }
  return h('div', { class: 'rp-own rp-own-suits' }, h('span', { text: 'Jouw keuze:' }),
    [true, false].map(play => h('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', 'aria-pressed': String(own?.play === play),
      onclick: () => mark(ctx, d, own?.play === play ? {} : { play }),
    }, play ? 'Spelen' : 'Passen')));
}

// ---------- the reasoning ----------

const num = x => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1).replace('.', ',');
const pct = x => `${Math.round(100 * x)}%`;

// The engine's reasoning (design §7 why): the choices of normaal (with its
// rule's reason), sterk and the hint, and the value of every option.
function whyView(s, w) {
  if (!w.options.length) return h('p', { class: 'xp-note', text: 'Voor deze beslissing heeft de AI geen redenering.' });
  const mine = w.seat === s.you;
  const name = mine ? 'jij' : nameOf(s, w.seat, false);
  const team = mine ? 'jij en je maat' : `${name} en maat`;
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
    h('p', { class: 'legend' }, w.worlds ? `Over ${w.worlds} verdelingen van de kaarten die ${name} niet kon zien. ` : 'Er mocht maar één kaart. ',
      panels.infoBtn('Redenering van de AI', [
        'Normaal: de keuze van de AI-spelers op Normaal, met de regel die hem koos. Sterk: de keuze van de AI-spelers op Sterk, uit deze berekening. Tip: wat Juf Jannie bij Oefenen aanraadt.',
        'De AI speelt elke keuze uit over honderden verdelingen van de kaarten die de speler niet kon zien, telkens met eenvoudige regels tot het eind van het potje.',
        `Waarde: hoeveel punten ${team} gemiddeld meer halen dan de tegenstanders aan het eind van het potje, roem, nat en pit meegeteld. ±: de standaardfout van het verschil met de beste; een verschil van minder dan twee keer ± kan toeval zijn.`,
        ...(cards ? ['Punten slag, punten later, roem slag en roem later: hetzelfde verschil, alleen van de kaartpunten of van de roem, in deze slag en in de latere slagen. Nat, pit: wat nat en pit daar nog aan toevoegen. Samen zijn ze de waarde, min wat er voor deze kaart al gehaald was.'] : []),
        `Nat wij: de kans dat ${team} spelen en nat gaan. Nat zij: de kans dat de tegenstanders spelen en nat gaan.`,
        'De AI-spelers op Sterk rekenen met hun eigen verdelingen en, naar karakter, met wat zin in pit: hun keuze kan een enkele keer anders zijn dan hier.',
      ])));
}
