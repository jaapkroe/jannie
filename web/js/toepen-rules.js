// Toepen without a browser: where the seats sit, what the table says on
// every turn, the summary of a round and the rules (design §11). Pure
// functions of the state `s` (a toepState); toepen.js draws them. Tested by
// test/ui/toepen.test.mjs.

// The order within a suit, low to high: boer, vrouw, heer, aas, 7, 8, 9, 10.
export const STRENGTH = { J: 0, Q: 1, K: 2, A: 3, 7: 4, 8: 5, 9: 6, T: 7 };
export const strength = code => STRENGTH[code?.[0]] ?? -1;
export const isPlaatje = code => strength(code) >= 0 && strength(code) < 4;

// A witte was is four pictures (boer, vrouw, heer, aas), a vuile was three
// and a 7; '' for neither.
export function wasKind(hand) {
  if (!Array.isArray(hand) || hand.length !== 4) return '';
  const pics = hand.filter(isPlaatje).length;
  const sevens = hand.filter(c => c[0] === '7').length;
  if (pics === 4) return 'witte';
  if (pics === 3 && sevens === 1) return 'vuile';
  return '';
}
export const wasName = kind => (kind === 'witte' ? 'witte was' : kind === 'vuile' ? 'vuile was' : 'was');

// Where a seat sits, as an angle in degrees: you at the bottom (270), the
// others clockwise from your lower left (210) over the top to your lower
// right (-30), evenly spread over that arc; one other sits at the top.
export function seatAngle(s, seat) {
  const n = s.players.length;
  const k = (seat - s.you + n) % n;
  return k === 0 ? 270 : 210 - (k * 240) / n;
}

// A point on an ellipse around (cx, cy) with radii rx, ry, in percent.
export function onEllipse(angle, rx, ry, cx = 50, cy = 50) {
  const a = (angle * Math.PI) / 180;
  return { x: +(cx + rx * Math.cos(a)).toFixed(2), y: +(cy - ry * Math.sin(a)).toFixed(2) };
}

const name = (s, seat) => (seat === s.you ? 'Jij' : s.players[seat]?.name || 'Speler');
const named = (s, seat) => (seat === s.you ? 'jij' : s.players[seat]?.name || 'Speler');
const points = n => `${n} ${n === 1 ? 'strafpunt' : 'strafpunten'}`;
export const pointsText = points;

export const IN_HAND = new Set(['was', 'check', 'toep', 'play']);
const limitOf = s => s.opts?.limit || 10;

// Is seat out of the match: at the limit, or before this round.
export const isOut = (s, seat) => (s.points?.[seat] ?? 0) >= limitOf(s);

// The short line under a seat's name.
export function seatStatus(s, seat) {
  const p = s.players[seat];
  if (p?.left) return 'vertrokken';
  if (p?.away) return 'AI speelt even mee';
  if (p && !p.bot && !p.connected) return 'verbinding weg';
  if (s.phase === 'lobby' || !s.status) return '';
  if (isOut(s, seat)) return 'eruit';
  if (!IN_HAND.has(s.phase)) return '';
  switch (s.status[seat]) {
    case 'gepast': return 'gepast';
    case 'betrapt': return 'betrapt';
    case 'uit': case 'eruit': return 'eruit';
    default: break;
  }
  if (s.phase === 'was' && s.nextAt) return s.answered?.[seat] ? 'klaar' : 'kijkt…';
  if (s.claims?.[seat] && !s.checks?.some(c => c.claimant === seat)) return 'was?';
  if (s.armoede?.[seat]) return 'armoede';
  return '';
}

// What the table asks of you now: a line of text, an optional line under
// it, and the buttons ({t, play, label, sub, kind}). null outside a round.
export function prompt(s) {
  if (!IN_HAND.has(s.phase)) return null;
  const me = s.you;
  const mine = s.turn === me;
  const turnName = s.turn >= 0 ? named(s, s.turn) : '';
  const st = s.status?.[me];
  if (st && st !== 'in') {
    const why = { gepast: 'Je hebt gepast.', betrapt: 'Betrapt: dat was geen was.' }[st] || 'Je ligt eruit.';
    return { text: `${why} Je kijkt mee tot het potje uit is.`, actions: [] };
  }
  switch (s.phase) {
    case 'was': {
      if (!s.nextAt) return { text: 'Er wordt gedeeld…', actions: [] };
      if (s.answered?.[me]) return { text: 'Wachten tot iedereen gezegd heeft of die een was heeft…', actions: [] };
      const kind = wasKind(s.hand);
      const actions = [];
      if (s.canClaim) actions.push({ t: 'was', play: true, label: 'Was!', kind: kind ? 'go' : 'bluff', sub: kind ? wasName(kind) : 'bluffen' });
      actions.push({ t: 'was', play: false, label: 'Geen was', kind: 'ghost' });
      return {
        text: kind ? `Je hebt een ${wasName(kind)}: ruil je hem voor vier nieuwe kaarten?` : 'Heb je een was?',
        sub: s.canClaim ? 'Vier plaatjes (boer, vrouw, heer, aas), of drie en een 7: die mag je ruilen. Bluffen mag, maar wie controleert…'
          : 'De stapel is op: er kan niet meer gewassen worden.',
        actions,
        countdown: s.nextAt,
      };
    }
    case 'check': {
      const c = s.claimant;
      if (c === me) return { text: `Je meldt een was. ${cap(turnName)} mag controleren…`, actions: [] };
      if (!mine) return { text: `${name(s, c)} meldt een was. ${cap(turnName)} mag controleren…`, actions: [] };
      return {
        text: `${name(s, c)} meldt een was. Controleer je?`,
        sub: `Is het een echte was, dan krijg jij een strafpunt. Is het bluf, dan krijgt ${named(s, c)} er een en speelt dit potje niet mee.`,
        actions: [{ t: 'check', play: true, label: 'Controleren', kind: 'go' }, { t: 'check', play: false, label: 'Laten gaan', kind: 'ghost' }],
      };
    }
    case 'toep': {
      const who = s.toeper >= 0 ? `${name(s, s.toeper)} toept` : 'Armoede';
      if (!mine) {
        return { text: `${who}: de inzet is ${s.stake}. ${cap(turnName)} kiest: meegaan of passen.`, actions: [] };
      }
      return {
        text: `${who}: de inzet is nu ${s.stake}. Ga je mee?`,
        sub: `Meegaan: verlies je, dan krijg je ${points(s.stake)}. Passen kost ${points(s.stake - 1)}, en je speelt niet meer mee.`,
        actions: [
          { t: 'answer', play: true, label: 'Meegaan', kind: 'go' },
          { t: 'answer', play: false, label: 'Passen', kind: 'ghost', sub: points(s.stake - 1) },
        ],
      };
    }
    default: {
      if (!mine) return { text: s.turn >= 0 ? `${cap(turnName)} is aan de beurt.` : '', actions: [] };
      const actions = s.canToep ? [{ t: 'toep', label: 'Toep!', kind: 'toep', sub: `inzet ${s.stake} → ${s.stake + 1}` }] : [];
      const last = (s.tricks ?? 0) === 3;
      return {
        text: s.rule || 'Jij bent aan de beurt',
        sub: last ? 'De laatste slag: wie die haalt, wint het potje.' : s.canToep ? 'Toep eerst, of speel meteen een kaart.' : '',
        actions,
      };
    }
  }
}

const cap = t => (t ? t[0].toUpperCase() + t.slice(1) : t);

// The headline of a round that ended (a score row), seen by you.
export function roundHeadline(s, row) {
  const w = row.winner;
  const title = w === s.you ? 'Jij wint het potje!' : `${name(s, w)} wint het potje`;
  const mine = row.gains?.[s.you] ?? 0;
  let sub = row.tricks ? `Met de laatste slag, bij inzet ${row.stake}.` : `De anderen pasten, bij inzet ${row.stake}.`;
  if (w !== s.you && mine > 0) sub += ` Jij krijgt ${points(mine)}.`;
  if (w !== s.you && mine === 0 && s.status?.[s.you] !== 'in') sub += ' Jij liep geen punten op.';
  return { title, sub, cls: w === s.you ? 'good' : mine > 0 ? 'bad' : 'neutral' };
}

// The standings: every seat with its points, from fewest to most; ties by
// seat from you.
export function standings(s) {
  const n = s.players.length;
  return Array.from({ length: n }, (_, k) => (s.you + k) % n)
    .map(seat => ({ seat, name: name(s, seat), points: s.points?.[seat] ?? 0, out: isOut(s, seat) }))
    .sort((a, b) => a.points - b.points);
}

// "toepen tot 10 strafpunten, met was en armoede".
export function variantText(o) {
  let t = `Toepen tot ${o.limit || 10} strafpunten`;
  if (o.was && o.armoede) t += ', met was en armoede';
  else if (o.was) t += ', met was';
  else if (o.armoede) t += ', met armoede';
  return t;
}

// The rules, for the sheet Spelregels: [title, paragraphs] per part; the
// parts of options that are off say so.
export function rules(o = {}) {
  const limit = o.limit || 10;
  return [
    ['De kaarten', [
      'Toepen speel je met 32 kaarten: 7, 8, 9, 10, boer, vrouw, heer en aas in vier kleuren. Er is geen troef.',
      'De volgorde is anders dan je gewend bent. Van laag naar hoog: boer, vrouw, heer, aas, 7, 8, 9, 10. De 10 is dus de hoogste kaart, de boer de laagste.']],
    ['Een potje', [
      'Iedereen krijgt vier kaarten. De speler links van de gever komt uit.',
      'Je moet bekennen: de kleur spelen die gevraagd is. Kun je dat niet, dan gooi je een andere kaart bij; die kan de slag niet winnen.',
      'De hoogste kaart van de gevraagde kleur wint de slag, en wie de slag haalt, komt weer uit.',
      'Alleen de laatste slag telt: wie de vierde slag haalt, wint het potje. Alle anderen die nog meedoen, krijgen de inzet als strafpunten. De inzet begint op 1.']],
    ['Toepen', [
      'Ben je aan de beurt, dan mag je eerst toepen: op tafel kloppen. De inzet gaat dan een punt omhoog.',
      'De anderen zeggen om de beurt of ze meegaan of passen. Wie past, krijgt de inzet van vóór de toep als strafpunten en doet dit potje niet meer mee. Past iedereen, dan wint wie toepte.',
      'Je mag niet twee keer achter elkaar toepen: eerst moet een ander toepen. Daarna mag jij weer.',
      'Wie toept, laat zien dat die denkt de laatste slag te halen. Of bluft.']],
    ['Witte en vuile was', o.was === false ? ['Aan deze tafel speel je zonder was.'] : [
      'Vier plaatjes (boer, vrouw, heer en aas, in elke combinatie) heten een witte was; drie plaatjes en een 7 een vuile was. Met zo\'n hand win je bijna nooit.',
      'Meteen na het delen zegt iedereen tegelijk of die een was heeft. Wie er een meldt, mag de kaarten dicht inleveren voor vier nieuwe.',
      'De anderen mogen om de beurt controleren. Klopt de was, dan krijgt wie controleerde een strafpunt. Was het bluf, dan krijgt wie de was meldde een strafpunt en speelt dat potje niet mee. Controleert niemand, dan krijg je hoe dan ook nieuwe kaarten.']],
    ['Armoede', o.armoede === false ? ['Aan deze tafel speel je zonder armoede.'] : [
      `Staat iemand op ${limit - 1} strafpunten, één van eruit, dan heet dat armoede. Het potje begint dan meteen met inzet 2.`,
      'Wie niet op armoede staat, zegt na het delen of die meegaat. Passen kost dan één strafpunt.']],
    ['Eruit en winnen', [
      `Wie ${limit} strafpunten heeft, ligt eruit. Het spel gaat door tot er één speler over is: die wint.`,
      'De deler schuift elk potje een plaats op, en slaat over wie eruit ligt.']],
  ];
}
