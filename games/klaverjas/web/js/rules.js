// Klaverjas's own helpers, without the DOM: the places and sides at the
// table, the scorers of a match, roem, the variant, the hand summary's
// headline, the score sheet's marks and its chart, the lines of the
// Spelanalyse, and the manual's sections.
// Node tests import it (test/ui/klaverjas.test.mjs).
import { store, seatCount, nameOf, suitSym, cap } from './util.js';
import { cardShort } from './cards.js';

// ---------- places and sides ----------

export const POS = ['bottom', 'left', 'top', 'right'];
// The places at a table of 2, 3 or 4, from the bottom (you) clockwise: with
// three players the others sit left and right, with two opposite.
const POS_AT = { 2: ['bottom', 'top'], 3: ['bottom', 'left', 'right'], 4: POS };
export const posOf = (s, seat) => {
  const n = seatCount(s);
  return POS_AT[n][(seat - s.you + n) % n];
};

// The side a seat plays on in this hand: its team with four players,
// itself with two, and with three the soloist (0) against the other two
// (1); -1 while the auction has no soloist yet.
export function sideOf(s, seat) {
  const n = seatCount(s);
  if (n === 4) return seat % 2;
  if (n === 2) return seat;
  return s.soloist < 0 ? -1 : seat === s.soloist ? 0 : 1;
}
export const mySide = s => sideOf(s, s.you);
export const isWij = (s, seat) => seat === s.you || (sideOf(s, seat) >= 0 && sideOf(s, seat) === mySide(s));
export const teamCls = (s, seat) => (isWij(s, seat) ? 'wij' : 'zij');
// The name of a side in this hand: "Wij" or "Zij", and for a side of one
// player "Jij" or the name.
export function teamName(s, side) {
  const n = seatCount(s);
  if (n === 4) return side === s.you % 2 ? 'Wij' : 'Zij';
  if (n === 2) return nameOf(s, side);
  if (side === 0) return nameOf(s, s.soloist);
  return mySide(s) === 1 ? 'Wij' : 'Zij';
}

// The scores of a match: the two teams with four players, else every
// player has their own (s.total, gains in a score row).
export const scorerOf = (s, seat) => (seatCount(s) === 4 ? seat % 2 : seat);
export const myScorer = s => scorerOf(s, s.you);
// "Wij"/"Zij" with four players, else "Jij" or the player's name.
export const scorerName = (s, k) => (seatCount(s) === 4 ? (k === s.you % 2 ? 'Wij' : 'Zij') : nameOf(s, k));
// Scorers from the viewer's: ours first, then the others in seat order
// from our left.
export function scorerOrder(s) {
  const n = seatCount(s);
  if (n === 4) return [s.you % 2, 1 - (s.you % 2)];
  return Array.from({ length: n }, (_, k) => (s.you + k) % n);
}

// ---------- roem and the variant ----------

// Capitalised for headings ("+20 Stuk!"); roemText is for use mid-sentence.
export const ROEM_NAMES = { drie: 'Driekaart', vier: 'Vierkaart', stuk: 'Stuk', vierGelijk: 'Vier gelijke', vierBoeren: 'Vier boeren' };
export const roemTotal = roem => (roem || []).reduce((n, r) => n + (r.points || 0), 0);
export const roemText = roem => (roem || []).map(r => `${(ROEM_NAMES[r.kind] || r.kind).toLowerCase()} (${r.points})`).join(', ');

export function variantText(o) {
  const trump = o.trumpMode === 'gedraaid' ? 'Gedraaid' : 'Utrechts';
  const rules = o.rules === 'rotterdams' ? 'Rotterdams' : 'Amsterdams';
  if (o.players === 3) return `Met z'n drieën, ${rules}`;
  if (o.players === 2) return `Met z'n tweeën, ${trump}`;
  return `${trump}/${rules}`;
}

// ---------- the hand summary ----------

// The hand summary's headline, seen from team w (the viewer's): t the title,
// sub the line under it, cls its colour: good news for us is 'good',
// bad news 'bad', the opponents making their game 'neutral'; 'nat' and
// 'pit' mark the two big outcomes. A pit by the defenders means the
// players went nat as well. With two or three players (r.players) w is the
// viewer's side and s gives the names (smallHeadline).
export function handHeadline(r, w, s = null) {
  if (r.players === 2 || r.players === 3) return smallHeadline(r, w, s);
  const we = r.playingTeam === w;
  if (r.pit) {
    const ours = r.pitTeam === w;
    if (ours && we) return { t: 'Pit!', sub: 'Wij halen alle acht slagen: 100 roem extra.', cls: 'pit good' };
    if (ours) return { t: 'Pit!', sub: 'Zij gaan nat en wij halen alle acht slagen: 100 roem extra.', cls: 'pit good' };
    if (!we) return { t: 'Zij halen pit', sub: 'Zij halen alle acht slagen en krijgen 100 roem extra.', cls: 'pit bad' };
    return { t: 'Nat!', sub: 'Wij spelen en halen geen slag. Zij krijgen alles, plus 100 roem voor pit.', cls: 'nat bad' };
  }
  if (r.nat) {
    return we
      ? { t: 'Nat!', sub: 'Wij spelen en halen het niet. Zij krijgen alle punten.', cls: 'nat bad' }
      : { t: 'Zij gaan nat!', sub: 'Zij spelen en halen het niet. Wij krijgen alle punten!', cls: 'nat good' };
  }
  return we
    ? { t: 'Gehaald!', sub: 'Wij spelen en halen het.', cls: 'good' }
    : { t: 'Zij halen het', sub: 'Zij spelen en halen meer dan de helft van de punten.', cls: 'neutral' };
}

// handHeadline for two players (w: the viewer's seat) or three (w: the
// viewer's side, 0 when playing alone). Sides of one player speak in the
// singular; the soloist's opponents share their side's score.
function smallHeadline(r, w, s) {
  const name = seat => (s ? nameOf(s, seat, false) : 'De ander');
  const made = r.points[0] + r.roem[0];
  if (r.players === 3) {
    const solo = r.trumpBy;
    const who = w === 0 ? 'Jij speelde' : `${name(solo)} speelde`;
    const what = `${who} alleen voor ${r.bid} en haalde ${made}.`;
    if (r.pit && r.pitTeam === 0) {
      return w === 0 ? { t: 'Pit!', sub: `${what} Alle tien slagen: 100 roem extra.`, cls: 'pit good' }
        : { t: `${name(solo)} haalt pit`, sub: `${what} Alle tien slagen: 100 roem extra.`, cls: 'pit bad' };
    }
    if (r.nat) {
      return w === 0 ? { t: 'Nat!', sub: `${what} De anderen krijgen alles, ieder de helft.`, cls: 'nat bad' }
        : { t: `${name(solo)} gaat nat!`, sub: `${what} Jullie krijgen alles, ieder de helft.`, cls: 'nat good' };
    }
    return w === 0 ? { t: 'Gehaald!', sub: what, cls: 'good' }
      : { t: `${name(solo)} haalt het`, sub: `${what} Jullie delen de rest.`, cls: 'neutral' };
  }
  const we = r.playingTeam === w;
  const other = name(1 - w);
  if (r.pit) {
    const ours = r.pitTeam === w;
    if (ours && we) return { t: 'Pit!', sub: 'Jij haalt alle zestien slagen: 100 roem extra.', cls: 'pit good' };
    if (ours) return { t: 'Pit!', sub: `${other} gaat nat en jij haalt alle zestien slagen: 100 roem extra.`, cls: 'pit good' };
    if (!we) return { t: `${other} haalt pit`, sub: `${other} haalt alle zestien slagen en krijgt 100 roem extra.`, cls: 'pit bad' };
    return { t: 'Nat!', sub: `Jij speelt en haalt geen slag. ${other} krijgt alles, plus 100 roem voor pit.`, cls: 'nat bad' };
  }
  if (r.nat) {
    return we
      ? { t: 'Nat!', sub: `Jij speelt en haalt het niet. Alle punten gaan naar ${other}.`, cls: 'nat bad' }
      : { t: `${other} gaat nat!`, sub: `${other} speelt en haalt het niet. Alle punten voor jou.`, cls: 'nat good' };
  }
  return we
    ? { t: 'Gehaald!', sub: 'Jij speelt en haalt het.', cls: 'good' }
    : { t: `${other} haalt het`, sub: `${other} speelt en haalt meer dan de helft van de punten.`, cls: 'neutral' };
}

// ---------- the score sheet ----------

// The side a scorer played on in a finished hand r (see sideOf): its team
// with four players, itself with two, with three 0 for the soloist
// (r.trumpBy) and 1 for the other two.
export function rowSide(s, r, k) {
  const n = seatCount(s);
  return n === 3 ? (k === r.trumpBy ? 0 : 1) : k;
}

// What is shown of hand r in scorer k's column: nat and pit for the side
// that went nat or made pit; roem for a side that kept it (with three
// players only the soloist's, as the other two share theirs).
export function rowMarks(s, r, k) {
  const side = rowSide(s, r, k);
  const nat = r.nat && r.playingTeam === side;
  const pit = r.pit && (r.nat ? 1 - r.playingTeam : r.playingTeam) === side;
  const roem = !r.nat && !(seatCount(s) === 3 && side === 1) ? r.roem?.[side] || 0 : 0;
  return { nat, pit, roem };
}

// Who played a hand, under its trump suit: jij, Wij/Zij with four players,
// else the player's face (as in the score pill), and the bid with three.
export function playedBy(s, r) {
  if (r.trumpBy === s.you) return 'jij';
  if (seatCount(s) === 4) return r.playingTeam === s.you % 2 ? 'Wij' : 'Zij';
  return scorerName(s, r.trumpBy);
}

// The chart's colours, by place in scorerOrder: ours --wij, the next
// --zij (the score sheet's colours), with three players the third the
// shell's slot #9085e9. Checked for colour-blind separation, the
// normal-vision floor and 3:1 contrast on klaverjas's --panel-solid.
const LINE_COLORS = ['var(--wij)', 'var(--zij)', '#9085e9'];

// The course of the match for the shell's chart (chart.js,
// docs/frontend.md#the-score-chart): every scorer's stand after each hand
// (Wij and Zij with four players, else every player; ours first), an open
// ring where a side went nat, and per hand the tooltip: the trump and who
// played, and per scorer what the hand brought (nat, pit, roem) and the
// stand, the highest first. null before the first hand.
export function chartSpec(s) {
  const rows = s.scores || [];
  const N = rows.length;
  if (!N) return null;
  const order = scorerOrder(s);
  const gainsOf = r => r.gains || r.score || [];
  const pts = [order.map(() => 0)];
  for (const r of rows) pts.push(pts.at(-1).map((p, j) => p + (gainsOf(r)[order[j]] || 0)));
  const tips = pts.map((p, i) => {
    const r = i ? rows[i - 1] : null;
    const bid = r && seatCount(s) === 3 && r.bid ? ` voor ${r.bid}` : '';
    return {
      title: r ? `Na potje ${i} · ${suitSym(r.trump)} ${playedBy(s, r)}${bid}` : 'Begin',
      rows: order.map((_, j) => j).sort((a, b) => p[b] - p[a] || a - b).map(j => {
        if (!r) return { k: j, note: '', value: p[j] };
        const { nat, pit, roem } = rowMarks(s, r, order[j]);
        const note = [nat ? 'nat' : `+${gainsOf(r)[order[j]] || 0}`, pit ? 'pit' : '', roem ? `${roem} roem` : ''];
        return { k: j, note: note.filter(Boolean).join(', '), value: p[j] };
      }),
    };
  });
  return {
    names: order.map(k => scorerName(s, k)), colors: order.map((_, j) => LINE_COLORS[j]), pts,
    rings: order.map(k => rows.flatMap((r, i) => (rowMarks(s, r, k).nat ? [i + 1] : []))), ringLabel: 'nat', tips,
    label: `Grafiek van de stand na elk potje, ${N} ${N === 1 ? 'potje' : 'potjes'}. De tabel erboven heeft dezelfde cijfers.`,
  };
}

// ---------- spelanalyse (the review at the end of a match, and per hand) ----------

// The verdict on the review's percentage. The bounds fit the bots' averages
// (games/klaverjas/bot TestGradeLevels): sterk about 99, normaal 87, makkelijk 76.
export const reviewVerdict = pct => (pct >= 95 ? 'sterk gespeeld' : pct >= 82 ? 'goed gespeeld' : 'kan beter');

// What the player's cards were worth per hand against an average hand:
// "Boven gemiddeld (+8)", "Gemiddeld (+1)", "Onder gemiddeld (−6)".
export function luckText(n) {
  const band = n >= 5 ? 'Boven gemiddeld' : n <= -5 ? 'Onder gemiddeld' : 'Gemiddeld';
  return `${band}\u00a0(${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)})`;
}

export const pointsText = n => `${n}\u00a0${n === 1 ? 'punt' : 'punten'}`;

// Where a moment of the review was: "Potje 5, slag 3", "Potje 9".
export const momentWhere = m => `Potje ${m.hand}` + (m.trick ? `, slag ${m.trick}` : '');

// A strong move: what was chosen ("♠A", "♣ als troef", "Gespeeld",
// "Gepast") and the rest of the line, ": " and the reason, or the whole
// hint as a sentence of its own.
export function strongLine(m) {
  const c = m.played || {};
  const what = c.card ? cardShort(c.card) : c.suit ? `${suitSym(c.suit)} als troef` : c.play ? 'Gespeeld' : 'Gepast';
  return { what, rest: m.why ? `: ${m.why}` : m.text ? `. ${m.text}` : '' };
}

// Points left on the table: "♠10 gespeeld, ♠A 18 punten beter: …", "♥ als
// troef, ♣ 14 punten beter: …", "Gepast, spelen 12 punten beter: …". A
// hint whose reason could not be cut out follows as a sentence of its own.
export function missedLine(m) {
  const c = m.played || {};
  const b = m.better || {};
  const pts = pointsText(m.points);
  let head;
  if (c.card) head = `${cardShort(c.card)} gespeeld, ${cardShort(b.card)} ${pts} beter`;
  else if (c.suit) head = `${suitSym(c.suit)} als troef, ${suitSym(b.suit)} ${pts} beter`;
  else head = c.play ? `Gespeeld, passen ${pts} beter` : `Gepast, spelen ${pts} beter`;
  if (m.why) return `${head}: ${m.why}`;
  return m.text ? `${head}. ${m.text}` : head;
}

// A choice that lost no points and gained none: "♠8 gespeeld: geen
// duidelijk betere keuze volgens Juf Jannie", "♥ als troef: …", "Gepast: …",
// "Gespeeld: …".
export function fineLine(m) {
  const c = m.played || {};
  const what = c.card ? `${cardShort(c.card)} gespeeld` : c.suit ? `${suitSym(c.suit)} als troef` : c.play ? 'Gespeeld' : 'Gepast';
  return `${what}: geen duidelijk betere keuze volgens Juf Jannie`;
}

// The line over a hand in the replay, from its graded choices: "Volgens
// Juf Jannie: 7 keuzes · 1 sterke zet · 18 punten laten liggen in 1 zet",
// parts of 0 left out, and "nog 2 keuzes in berekening" while pending of
// them are still being graded; '' with nothing to say.
export function handSum(choices = [], pending = 0) {
  const count = (n, one, more) => `${n} ${n === 1 ? one : more}`;
  const missed = choices.filter(c => c.better);
  const strong = choices.filter(c => !c.better && c.points > 0).length;
  const lost = missed.reduce((n, c) => n + (c.points || 0), 0);
  const parts = [
    choices.length ? count(choices.length, 'keuze', 'keuzes') : '',
    strong ? count(strong, 'sterke zet', 'sterke zetten') : '',
    missed.length ? `${pointsText(lost)} laten liggen in ${count(missed.length, 'zet', 'zetten')}` : '',
    pending > 0 ? `nog ${count(pending, 'keuze', 'keuzes')} in berekening` : '',
  ].filter(Boolean);
  return parts.length ? `Volgens Juf Jannie: ${parts.join(' · ')}` : '';
}

// What the two options of a review moment brought each team, the stronger
// against the weaker, and the chance of nat where it moved: "Jullie +37,
// zij −23; kans dat jullie nat gaan 69% → 37%". A strong move names the
// obvious option it beat: "Tegenover ♠8: jullie +6, zij −6".
export function outcomeLine(m) {
  const sign = n => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
  const nat = (pair, who) => (pair && Math.abs(pair[0] - pair[1]) >= 5 ? `; kans dat ${who} nat gaan ${pair[0]}% → ${pair[1]}%` : '');
  const text = `jullie ${sign(m.us)}, zij ${sign(m.them)}` + nat(m.nat, 'jullie') + nat(m.natThem, 'zij');
  const a = m.alt;
  const alt = !a ? '' : a.card ? cardShort(a.card) : a.suit ? `${suitSym(a.suit)} als troef` : a.play ? 'spelen' : 'passen';
  return alt ? `Tegenover ${alt}: ${text}` : cap(text);
}

// A think time in ms: "0,8 s", "48 s", "6 min 10 s".
export function timeText(ms) {
  const sec = ms / 1000;
  if (sec < 9.95) return `${sec.toFixed(1).replace('.', ',')}\u00a0s`;
  const n = Math.round(sec);
  if (n < 60) return `${n}\u00a0s`;
  return `${Math.floor(n / 60)}\u00a0min` + (n % 60 ? ` ${n % 60}\u00a0s` : '');
}

// The percentages of the reviews before review r on this device, oldest
// first (at most keep). r itself is added to the list the first time.
export function reviewHistory(r, keep = 5) {
  let list = store.json('reviews', []);
  if (!Array.isArray(list)) list = [];
  list = list.filter(x => x && typeof x.id === 'string' && Number.isFinite(x.pct));
  let i = list.findIndex(x => x.id === r.id);
  if (i < 0) {
    list.push({ id: r.id, pct: r.pct });
    i = list.length - 1;
    store.setJSON('reviews', list.slice(-20));
  }
  return list.slice(Math.max(0, i - keep), i).map(x => x.pct);
}

// ---------- the manual ----------

// The manual's sections, as manual.js's SECTIONS: manual.js loads when the
// manual is first opened, and a lesson step names its section before that.
// test/ui/klaverjas.test.mjs keeps the two the same.
export const MANUAL_SECTIONS = [
  { id: 'bediening', title: 'Bediening' },
  { id: 'regels', title: 'Spelregels' },
  { id: 'twee-drie', title: 'Met 2 of 3' },
  { id: 'punten', title: 'Kaartwaarden' },
  { id: 'roem', title: 'Roem' },
  { id: 'seinen', title: 'Seinen' },
  { id: 'tips', title: 'Tips' },
  { id: 'jannie', title: 'Juf Jannie' },
  { id: 'woorden', title: 'Woordenlijst' },
];
