// Toepen without a browser: where the seats sit, what the table says on
// every turn, the summary of a round and the rules
// (games/toepen/README.md). Pure functions of the state `s`; table.js
// draws them, game.js places the lobby's seats with them. Tested by
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
// Every hand that may be handed in is called a vuile was at this table;
// four pictures is also known as a witte was.
export const wasName = kind => (kind === 'witte' ? 'witte was' : 'vuile was');

// How often seat handed in a vuile was this round: a claim let through, or
// checked and genuine (a bluff that was caught hands nothing in).
export const washes = (s, seat) => (s.checks || []).filter(c => c.claimant === seat && (c.checker < 0 || c.kind)).length;

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

export const IN_HAND = new Set(['discard', 'was', 'check', 'toep', 'play']);
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
  if (s.phase === 'discard' && s.turn === seat) return 'legt weg…';
  if (s.claims?.[seat] && !s.checks?.some(c => c.claimant === seat)) return 'vuile was?';
  if (s.open?.[seat]?.length) return 'speelt open';
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
    const why = { gepast: 'Je hebt gepast.', betrapt: 'Betrapt: dat was geen vuile was.' }[st] || 'Je ligt eruit.';
    return { text: `${why} Je kijkt mee tot het potje uit is.`, actions: [] };
  }
  switch (s.phase) {
    case 'discard': {
      if (!mine) return { text: `Koningsspel: ${s.turn >= 0 ? turnName : 'iedereen'} legt kaarten weg…`, actions: [] };
      return {
        text: `Koningsspel: leg ${s.lay} kaarten dicht weg.`,
        sub: `Tik de ${s.lay} kaarten aan die je weglegt; je speelt met de andere ${s.size || 8}.`,
        actions: [],
        lay: s.lay,
      };
    }
    case 'was': {
      const again = (s.wasRound ?? 1) > 1;
      if (!s.nextAt) return { text: again ? 'Nieuwe kaarten…' : 'Er wordt gedeeld…', actions: [] };
      if (s.answered?.[me]) {
        return { text: again ? 'Wie nieuwe kaarten kreeg, zegt of die weer een vuile was heeft…' : 'Wachten tot iedereen gezegd heeft of die een vuile was heeft…', actions: [] };
      }
      const kind = wasKind(s.hand);
      const poor = !!s.armoede?.[me];
      const actions = [];
      if (s.canClaim) {
        actions.push({ t: 'was', play: true, label: 'Vuile was!', kind: kind ? 'go' : 'bluff',
          sub: poor ? 'open op tafel' : kind ? (kind === 'witte' ? 'vier plaatjes' : 'echt') : 'bluffen' });
      }
      actions.push({ t: 'was', play: false, label: 'Geen', kind: 'ghost', sub: 'gewoon spelen' });
      if (poor && !kind) {
        return { text: 'Op armoede mag je alleen een echte vuile was inleveren.', sub: 'Je hebt er geen: je speelt met deze kaarten.', actions, countdown: s.nextAt };
      }
      return {
        text: kind ? `Je hebt ${again ? 'weer ' : ''}een ${wasName(kind)}: ruil je hem voor vier nieuwe kaarten?`
          : again ? 'Je nieuwe kaarten: weer een vuile was?' : 'Heb je een vuile was?',
        sub: (poor && s.canClaim ? 'Op armoede leg je hem open op tafel, zodat iedereen hem ziet.'
          : s.canClaim ? 'Vier plaatjes (boer, vrouw, heer, aas), of drie en een 7: die mag je ruilen. Bluffen mag, maar wie controleert…'
            : 'De stapel is op: er kan niet meer gewassen worden.') + (s.canClaim ? ` Op de stapel: ${s.stock} kaarten.` : ''),
        actions,
        countdown: s.nextAt,
      };
    }
    case 'check': {
      const c = s.claimant;
      if (c === me) return { text: `Je meldt een vuile was. ${cap(turnName)} mag controleren…`, actions: [] };
      if (!mine) return { text: `${name(s, c)} meldt een vuile was. ${cap(turnName)} mag controleren…`, actions: [] };
      return {
        text: `${name(s, c)} meldt een vuile was. Controleer je?`,
        sub: `Is het een echte vuile was, dan krijg jij een strafpunt. Is het bluf, dan krijgt ${named(s, c)} er een en ${
          s.opts?.bluf === false ? 'speelt die dit potje niet mee' : 'speelt die open verder'}.`,
        actions: [{ t: 'check', play: true, label: 'Controleren', kind: 'go' }, { t: 'check', play: false, label: 'Laten gaan', kind: 'ghost' }],
      };
    }
    case 'toep': {
      const who = s.toeper >= 0 ? `${name(s, s.toeper)} toept` : 'Armoede';
      if (!mine) {
        return { text: `${who}: de inzet is ${s.stake}. ${cap(turnName)} kiest: meegaan of passen.`, actions: [] };
      }
      // Passing costs the stake you last agreed to: before the first raise
      // you did not go along with.
      const cost = s.passCost || s.stake - 1;
      const actions = [{ t: 'answer', play: true, label: 'Meegaan', kind: 'go' }];
      if (s.canRaise) actions.push({ t: 'overtoep', label: 'Overtoepen', kind: 'toep', sub: `inzet ${s.stake} → ${s.stake + 1}` });
      if (!s.mustStay) actions.push({ t: 'answer', play: false, label: 'Passen', kind: 'ghost', sub: points(cost) });
      return {
        text: `${who}: de inzet is nu ${s.stake}. Ga je mee?`,
        sub: s.mustStay ? 'Anti-lijntoep: je paste al twee keer achter elkaar, nu moet je mee.'
          : `Meegaan: verlies je, dan krijg je ${points(s.stake)}. Passen kost ${points(cost)}, en je speelt niet meer mee.`,
        actions,
      };
    }
    default: {
      if (!mine) return { text: s.turn >= 0 ? `${cap(turnName)} is aan de beurt.` : '', actions: [] };
      const actions = s.canToep ? [{ t: 'toep', label: 'Toep!', kind: 'toep', sub: `inzet ${s.stake} → ${s.stake + 1}` }] : [];
      const last = (s.tricks ?? 0) === (s.size || 4) - 1;
      const why = s.canToep ? '' : noToep(s);
      // A vuile was in hand that the stock has no new cards for.
      const stuck = !s.tricks && !s.trick?.cards?.length && s.opts?.was !== false && wasKind(s.hand) && (s.stock ?? 0) < 4
        ? 'Een vuile was, maar de stapel is op: je speelt met deze kaarten. ' : '';
      return {
        text: s.rule || 'Jij bent aan de beurt',
        sub: stuck + (last ? `De laatste slag: wie die haalt, wint het potje.${why ? ` ${why}` : ''}` : s.canToep ? 'Toep eerst, of speel meteen een kaart.' : why),
        actions,
      };
    }
  }
}

const cap = t => (t ? t[0].toUpperCase() + t.slice(1) : t);

// ---------- the reasoning of the AI (expert mode) ----------

// Whether the round awaits a decision of yours now: your turn, or your
// answer in the time for a vuile was.
export function yours(s) {
  if (!IN_HAND.has(s.phase) || s.status?.[s.you] !== 'in') return false;
  if (s.phase === 'was') return !!s.nextAt && !s.answered?.[s.you];
  return s.turn === s.you;
}

// Alone with bots: nobody else at the table is a person.
export const alone = s => s.players.filter(p => p && !p.bot).length === 1;

const SUIT = { C: '♣', D: '♦', H: '♥', S: '♠' };
const RANK = { J: 'B', Q: 'V', K: 'H', A: 'A', T: '10', 7: '7', 8: '8', 9: '9' };
// A card as the table writes it: "♥10", "♠B".
export const cardLabel = code => `${SUIT[code?.[1]] || '?'}${RANK[code?.[0]] || '?'}`;

const share = x => `${Math.round(100 * x)}%`;
const pointsNL = x => `${String(Math.round(10 * x) / 10).replace('.', ',')} ${x === 1 ? 'strafpunt' : 'strafpunten'}`;

// The explanation (s.why) as the sheet shows it: the advice, why, the
// options with their values, the rule of thumb and a footnote.
export function whyRows(w) {
  if (!w) return null;
  const what = w.decision === 'controle' ? ['kans op bluf', 'kans dat die echt is'] : ['kans op de laatste slag'];
  const options = (w.options || []).map((o, k) => ({
    label: o.cards?.length ? o.cards.map(cardLabel).join(' ') : o.label,
    value: o.value < 0 ? '' : o.points ? `${pointsNL(o.value)} verwacht` : `${share(o.value)} ${what[Math.min(k, what.length - 1)]}`,
    best: !!o.best,
  }));
  const note = w.worlds ? `${w.worlds} verdelingen nagespeeld van de kaarten die jij niet ziet, steeds anders: alleen wat jij weet telt.`
    : 'Uitgerekend uit de kaarten die jij ziet.';
  return {
    advice: w.advice || '',
    why: w.why || '',
    options,
    rule: w.rule ? `Vuistregel: ${w.rule}` : '',
    ruleCard: w.ruleCard ? `De vuistregel speelt ${cardLabel(w.ruleCard)}.` : '',
    note,
  };
}

// Why you may not toep on your turn.
function noToep(s) {
  const me = s.you;
  if (s.koning) return 'Koningsspel: er wordt niet getoept.';
  if (s.armoede?.[me]) return 'Op armoede kun je niet toepen.';
  if ((s.points?.[me] ?? 0) + (s.stake || 1) >= limitOf(s)) return 'Met deze inzet lig je er bij verlies al uit: toepen kan niet.';
  if (s.toeper === me) return 'Jij toepte het laatst: eerst moet een ander toepen.';
  // What is left: everyone else still in would go along anyway.
  return 'Toepen heeft geen zin: wie nog meedoet, kan niet meer passen.';
}

// The headline of a round that ended (a score row), seen by you.
export function roundHeadline(s, row) {
  const w = row.winner;
  const title = w === s.you ? 'Jij wint het potje!' : `${name(s, w)} wint het potje`;
  const mine = row.gains?.[s.you] ?? 0;
  // Won without the last trick: everyone else passed, or some sat out (a
  // bluff caught) or went out (a check).
  const passed = (s.status || []).every((st, seat) => seat === w || st === 'uit' || st === 'gepast');
  let sub = row.tricks ? `Met de laatste slag, bij inzet ${row.stake}.`
    : `${passed ? 'De anderen pasten' : 'Niemand anders doet nog mee'}, bij inzet ${row.stake}.`;
  if (row.boer) sub = `Met de boer in de laatste slag, bij inzet ${row.stake}${(row.gains?.[w] ?? 0) < 0 ? ': een strafpunt eraf' : ''}.`;
  if (row.koning) sub = `Het koningsspel: ${w === s.you ? 'jij haalde' : `${name(s, w)} haalde`} de laatste slag.`;
  if (w !== s.you && mine > 0) sub += ` Jij krijgt ${points(mine)}.`;
  if (w !== s.you && mine === 0 && s.status?.[s.you] !== 'in') sub += ' Jij liep geen punten op.';
  return { title, sub, cls: w === s.you ? 'good' : mine > 0 ? 'bad' : 'neutral' };
}

// The overview of round k at game over (games/toepen/README.md#the-site),
// from its course (s.courses[k]: what everyone saw happen): the round's
// title, the dealer, and parts before the first card and per trick, each
// a list of lines ({text}) and rows of cards ({cards}: per card its seat,
// name, card, win: took the trick, void: its seat passed later in the
// trick, so it no longer counts), then the result. Hands nobody saw stay
// out: a vuile was nobody checked shows no cards.
export function courseView(s, k) {
  const row = s.rounds?.[k];
  if (!row) return null;
  const obj = seat => (seat === s.you ? 'jou' : named(s, seat));
  const names = seats => cap(joinNL(seats.map(seat => named(s, seat))));
  const cardsOf = cs => (cs || []).map(cardLabel).join(' ');
  const n = s.players.length;
  // The points through the round, from those after the round before: a
  // check's point can put a seat out of it.
  const pts = [...(s.rounds[k - 1]?.points || Array(n).fill(0))];
  const outBy = (seat, p) => (pts[seat] += p) >= limitOf(s);
  const claimed = new Set(), passed = new Set();
  const parts = [];
  let part = null, trick = 0, played = null;
  const open = title => { part = { title, items: [] }; parts.push(part); };
  const line = text => { if (!part) open('Voor de eerste kaart'); part.items.push({ text }); };
  // A toep comes on a turn to play: it opens the next trick when none is
  // in play, as the first card does.
  const inTrick = () => { if (!played) { open(`Slag ${++trick}`); played = new Map(); } };
  for (const ev of s.courses?.[k] || []) {
    switch (ev.type) {
      case 'claims':
        // Again: who got new cards may hand them in once more.
        line(`${names(ev.seats)} ${ev.seats.length === 1 ? 'meldt' : 'melden'} ${ev.seats.every(seat => claimed.has(seat)) ? 'weer ' : ''}een vuile was.`);
        ev.seats.forEach(seat => claimed.add(seat));
        break;
      case 'wasDone': {
        const who = name(s, ev.claimant);
        if (ev.shown) line(`${who} staat op armoede en legt een echte ${wasName(ev.kind)} open: ${cardsOf(ev.cards)}. ${who} krijgt vier nieuwe kaarten.`);
        else if (ev.checker < 0) line(`Niemand controleert: ${named(s, ev.claimant)} krijgt vier nieuwe kaarten.`);
        else if (ev.genuine) {
          const out = outBy(ev.checker, 1);
          line(`${name(s, ev.checker)} controleert ${obj(ev.claimant)}: een echte ${wasName(ev.kind)}, ${cardsOf(ev.cards)}. ` +
            (out ? `${name(s, ev.checker)} krijgt een strafpunt en ligt eruit; ${named(s, ev.claimant)} krijgt vier nieuwe kaarten.`
              : `${name(s, ev.checker)} krijgt een strafpunt, ${named(s, ev.claimant)} vier nieuwe kaarten.`));
        } else {
          const then = outBy(ev.claimant, 1) ? 'ligt eruit' : s.opts?.bluf === false ? 'doet dit potje niet meer mee' : 'speelt open verder';
          line(`${name(s, ev.checker)} controleert ${obj(ev.claimant)}: bluf, ${cardsOf(ev.cards)}. ${who} krijgt een strafpunt en ${then}.`);
        }
        break;
      }
      case 'armoede':
        line(`Armoede: ${joinNL(ev.seats.map(seat => named(s, seat)))} ${ev.seats.length === 1 ? 'staat' : 'staan'} op ${limitOf(s) - 1} strafpunten. De inzet is ${ev.stake}.`);
        break;
      case 'discard':
        line(`${name(s, ev.seat)} legt ${ev.n} ${ev.n === 1 ? 'kaart' : 'kaarten'} dicht weg.`);
        break;
      case 'toep':
        if (!ev.over) inTrick();
        line(`${name(s, ev.seat)} ${ev.over ? 'overtoept' : 'toept'}: inzet ${ev.stake}.`);
        break;
      case 'answer':
        line(ev.auto ? `${name(s, ev.seat)} gaat vanzelf mee.` : ev.stay ? `${name(s, ev.seat)} gaat mee.` : `${name(s, ev.seat)} past: ${points(ev.points)}.`);
        if (!ev.stay) { outBy(ev.seat, ev.points); passed.add(ev.seat); }
        if (!ev.stay && played?.has(ev.seat)) played.get(ev.seat).void = true;
        break;
      case 'play': {
        inTrick();
        const c = { seat: ev.seat, name: name(s, ev.seat), card: ev.card, win: false, void: false };
        played.set(ev.seat, c);
        const last = part.items.at(-1);
        if (last?.cards) last.cards.push(c);
        else part.items.push({ cards: [c] });
        break;
      }
      case 'trick':
        if (played?.has(ev.winner)) played.get(ev.winner).win = true;
        line(`${name(s, ev.winner)} haalt de slag.`);
        played = null;
        break;
    }
  }
  const w = row.winner;
  const before = s.rounds[k - 1]?.out || [];
  // Won without the last trick: everyone else in the round passed, or some
  // sat out (a bluff caught) or went out (a check).
  const allPassed = [...Array(n).keys()].every(seat => seat === w || before[seat] || passed.has(seat));
  let won = row.tricks ? `${name(s, w)} haalt de laatste slag en wint het potje, bij inzet ${row.stake}.`
    : `${allPassed ? 'De anderen pasten' : 'Niemand anders doet nog mee'}: ${named(s, w)} wint het potje, bij inzet ${row.stake}.`;
  if (row.boer) won += (row.gains?.[w] ?? 0) < 0 ? ' Met de boer in de laatste slag: een strafpunt eraf.' : ' Met de boer in de laatste slag.';
  if (row.koning) won = `Koningsspel: ${named(s, w)} haalt de laatste slag en wint het spel.`;
  const order = Array.from({ length: n }, (_, j) => (s.you + j) % n);
  const gains = order.filter(seat => (row.gains?.[seat] ?? 0) > 0).map(seat => `${named(s, seat)} +${row.gains[seat]}`);
  const out = order.filter(seat => row.out?.[seat] && !before[seat]);
  const result = [won];
  if (gains.length) result.push(`Strafpunten: ${gains.join(', ')}.`);
  if (out.length) result.push(`${names(out)} ${out.length === 1 ? 'ligt' : 'liggen'} eruit.`);
  parts.push({ title: 'Uitslag', items: result.map(text => ({ text })) });
  return { title: `Potje ${row.hand} van ${s.rounds.length}`, sub: `Gever: ${named(s, row.dealer)}.`, parts };
}

// The standings: every seat with its points, from fewest to most; ties by
// seat from you.
export function standings(s) {
  const n = s.players.length;
  return Array.from({ length: n }, (_, k) => (s.you + k) % n)
    .map(seat => ({ seat, name: name(s, seat), points: s.points?.[seat] ?? 0, out: isOut(s, seat) }))
    .sort((a, b) => a.points - b.points);
}

// "Toepen tot 10 strafpunten, met vuile was, armoede, koningsspel en boer eraf"
// (as the server's variant).
export function variantText(o) {
  const t = `Toepen tot ${o.limit || 10} strafpunten`;
  const extra = [[o.was, 'vuile was'], [o.armoede, 'armoede'], [o.koning, 'koningsspel'], [o.boer, 'boer eraf'], [o.lijntoep, 'anti-lijntoep'],
    [o.was && o.bluf, 'open na bluf']]
    .filter(([on]) => on).map(([, n]) => n);
  return extra.length ? `${t}, met ${joinNL(extra)}` : t;
}

const joinNL = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} en ${xs.at(-1)}`);

// The extra rules on a new table (the server's defaults).
const RULE_DEFAULTS = { was: true, armoede: true, koning: true, boer: true, lijntoep: false, bluf: true };

// The manual (the sheet Spelregels): its tabs, each {id, title, parts},
// a part [title, paragraphs]. The extra rules are options: at a table
// (table) each says whether it is played there (o); elsewhere each is
// explained with its default. Bediening differs by pointer.
export function manual(o = {}, { touch = false, table = true } = {}) {
  const limit = o.limit || 10;
  const off = what => `Aan deze tafel speel je zonder ${what}.`;
  const on = k => !table || (o[k] ?? RULE_DEFAULTS[k]) === true;
  const choice = k => (table ? [] : [`Dit kies je bij een nieuw spel; standaard staat het ${RULE_DEFAULTS[k] ? 'aan' : 'uit'}.`]);
  return [
    { id: 'regels', title: 'Spelregels', parts: [
      ['De kaarten', [
        'Toepen speel je met 32 kaarten: 7, 8, 9, 10, boer, vrouw, heer en aas in vier kleuren. Er is geen troef.',
        'De volgorde is anders dan je gewend bent. Van laag naar hoog: boer, vrouw, heer, aas, 7, 8, 9, 10. De 10 is dus de hoogste kaart, de boer de laagste.']],
      ['Een potje', [
        `Iedereen krijgt vier kaarten. De speler links van de gever komt uit${on('armoede') ? ', tenzij iemand anders op armoede staat' : ''}.`,
        'Je moet bekennen: de kleur spelen die gevraagd is. Kun je dat niet, dan gooi je een andere kaart bij; die kan de slag niet winnen.',
        'De hoogste kaart van de gevraagde kleur wint de slag, en wie de slag haalt, komt weer uit.',
        'Alleen de laatste slag telt: wie de vierde slag haalt, wint het potje. Alle anderen die nog meedoen, krijgen de inzet als strafpunten. De inzet begint op 1.']],
      ['Toepen', [
        'Ben je aan de beurt, dan mag je eerst toepen: op tafel kloppen. De inzet gaat dan een punt omhoog.',
        'De anderen zeggen om de beurt of ze meegaan of passen. Wie past, krijgt de inzet waarmee die het laatst akkoord ging als strafpunten (de inzet van vóór de toep) en doet dit potje niet meer mee. Past iedereen, dan wint wie toepte.',
        'Wie wordt gevraagd, mag ook overtoepen: de inzet gaat nog een punt omhoog, en dan zegt iedereen die nog meedoet, ook wie toepte, opnieuw of die meegaat. Wie al meeging, betaalt bij passen de inzet waarmee die meeging; wie nog niet meeging, de inzet van vóór de eerste toep.',
        'Zou je door te passen eruit liggen (bijvoorbeeld op armoede), dan ga je vanzelf mee: je wordt niet gevraagd.',
        'Kan niemand anders nog passen, dan heeft toepen geen zin en kan het niet: je zou alleen zelf meer riskeren.',
        'Je mag niet twee keer achter elkaar toepen: eerst moet een ander toepen. Daarna mag jij weer.',
        'Lig je er bij verlies met de huidige inzet al uit, dan kun je niet (over)toepen.',
        'Wie toept, laat zien dat die denkt de laatste slag te halen. Of bluft.']],
      ['Eruit en winnen', [
        `Wie ${limit} strafpunten heeft, ligt eruit. Het spel gaat door tot er één speler over is: die wint.`,
        'De gever schuift elk potje een plaats op, en slaat over wie eruit ligt.']],
    ] },
    { id: 'extra', title: 'Extra regels', parts: [
      ['Vuile was', !on('was') ? [off('vuile was')] : [
        'Drie plaatjes (boer, vrouw, heer of aas) en een 7 heten een vuile was. Vier plaatjes mag ook; dat heet ook wel een witte was. Met zo\'n hand win je bijna nooit.',
        'Meteen na het delen zegt iedereen tegelijk of die een vuile was heeft. Wie er een meldt, legt de kaarten dicht voor zich neer en krijgt vier nieuwe van de stapel.',
        'De anderen mogen om de beurt controleren. Klopt de vuile was, dan krijgt wie controleerde een strafpunt. Controleert niemand, dan krijg je hoe dan ook nieuwe kaarten.',
        !on('bluf')
          ? 'Was het bluf, dan krijgt wie hem meldde een strafpunt en speelt die dat potje niet mee.'
          : `Was het bluf, dan krijgt wie hem meldde een strafpunt; die neemt de kaarten terug en speelt het potje open uit: iedereen ziet die kaarten.${
            table ? '' : ' Dat staat standaard aan; zonder doet die het potje niet meer mee.'}`,
        'Is je nieuwe hand weer een vuile was, dan mag je hem opnieuw inleveren, zo vaak als de stapel nieuwe kaarten heeft. Het stapeltje voor je op tafel laat zien hoe vaak je inleverde.',
        'Op armoede mag je alleen een echte vuile was inleveren, geen bluf. Je legt hem even open op tafel, zodat iedereen hem ziet; controleren hoeft dan niet.',
        ...choice('was')]],
      ['Armoede', !on('armoede') ? [off('armoede')] : [
        `Staat iemand op ${limit - 1} strafpunten (nog één en die ligt eruit), dan heet dat armoede. Het potje begint dan meteen met inzet 2.`,
        'Wie op armoede staat, komt uit. Staan er meer spelers op armoede, dan komt de eerste na de gever uit.',
        'Wie niet op armoede staat, zegt vóór de eerste kaart om de beurt of die meegaat, te beginnen links van wie uitkomt. Passen kost dan één strafpunt.',
        'Op armoede kun je zelf niet toepen, en ga je vanzelf mee met elke toep: passen zou je eruit zetten.', ...choice('armoede')]],
      ['Koningsspel', !on('koning') ? [off('koningsspel')] : [
        'Staat iedereen die nog meedoet op armoede, dan volgt het koningsspel: iedereen krijgt elf kaarten en legt er om de beurt drie dicht weg; je speelt met acht.',
        'Met drie spelers zijn het er tien en leg je er twee weg, met vier acht en leg je niets weg; met meer spelers zoveel als de stapel toelaat.',
        'Er is geen vuile was en er wordt niet getoept. Wie de laatste slag haalt, wint het spel; de anderen liggen eruit.', ...choice('koning')]],
      ['Boer: een punt eraf', !on('boer') ? ['Aan deze tafel levert de boer niets op.'] : [
        'Haal je de laatste slag met een boer, de laagste kaart, dan gaat er een strafpunt van je af (als je er een hebt).', ...choice('boer')]],
      ['Anti-lijntoep', on('lijntoep') ? [
        'Lijntoepen is steeds passen en alleen meegaan met topkaarten. Daarom mag je hoogstens twee keer achter elkaar passen op een toep: bij de derde ga je verplicht mee (of je overtoept).',
        'Na meegaan of overtoepen begint de telling opnieuw. Het meegaan op armoede telt niet mee.', ...choice('lijntoep')] : [
        'Aan deze tafel mag je zo vaak passen als je wilt. Met de regel anti-lijntoep mag je hoogstens twee keer achter elkaar passen op een toep.']],
    ] },
    { id: 'tips', title: 'Tips', parts: [
      ['Kaarten spelen', [
        'Bewaar je hoogste kaart voor de laatste slag: alleen die telt.',
        'Kom laag uit, met een andere kleur dan je beste kaart.',
        'De voorlaatste slag neem je het liefst met een andere kaart dan je beste: dan kom je in de laatste slag uit met je beste.',
        'Kun je niet bekennen, gooi dan je zwakste kaart weg; die wint toch niet.',
        'Beken je wel, speel dan je laagste kaart van die kleur, tenzij je de voorlaatste slag wilt halen.']],
      ['Toepen', [
        'Toep als je een goede kans hebt op de laatste slag: ruwweg zes op de tien. Met minder spelers moet je zekerder zijn: tegen één ander is het gauw kop of munt om meer punten.',
        'Een bluf met een kansloze hand kan, het liefst bij een lage inzet: wie past, betaalt toch.',
        'Bluf niet als iemand de laatste slag zeker heeft (een 10 die niemand meer kan slaan): die past toch niet, en jij verliest alleen meer.',
        'Haal je de laatste slag zeker niet meer, pas dan op een toep: passen kost minder dan verliezen.',
        'Overtoep alleen met een (bijna) zekere laatste slag, en hoe hoger de inzet, hoe zekerder: heen en weer toepen kost al snel meer dan het potje waard is.']],
      ['Meegaan of passen', [
        'Vergelijk wat passen kost (de inzet van vóór de toep) met wat meegaan gemiddeld kost: de nieuwe inzet maal je kans om te verliezen.',
        'Eruit gaan weegt extra zwaar. Zet passen je er net zo goed uit als verliezen, ga dan mee.',
        'Wie bij een hoge inzet nog toept, heeft vaak echt iets, maar niet altijd: ook de AI-spelers bluffen af en toe, ook bij een hoge inzet.',
        'Let op wie bluft: wie vaak bluft, verdient vaker een meegaan of een controle. De AI-spelers onthouden dat ook, van iedereen aan tafel.']],
      ['Vuile was', [
        'Lever een echte vuile was altijd in: vier nieuwe kaarten zijn bijna altijd beter, en wie controleert, krijgt zelf een strafpunt.',
        'Bluf af en toe met een kansloze hand, maar nooit op armoede: daar mag het niet.']],
      ['Controleren', [
        'Heb je zelf veel plaatjes en zevens, dan is een echte vuile was bij een ander minder waarschijnlijk: controleren loont dan eerder.',
        'Wees voorzichtig als een verkeerde controle je eruit zet.']],
      ['Koningsspel', [
        'Leg je zwakste kaarten weg en houd je hoogste kaarten; met acht slagen telt nog steeds alleen de laatste.']],
    ] },
    { id: 'begrippen', title: 'Begrippen', parts: [
      ['Armoede', [`Op ${limit - 1} strafpunten staan: nog één en je ligt eruit.`]],
      ['Bekennen', ['De kleur spelen die gevraagd is.']],
      ['Betrapt', ['Een vuile was gemeld die er geen was, en gecontroleerd: een strafpunt, en het potje open uitspelen (of, zonder die regel, niet meer meedoen).']],
      ['Boer eraf', ['De laatste slag met een boer halen: een strafpunt eraf.']],
      ['Controleren', ['De hand van wie een vuile was meldt laten zien: klopt hij niet, dan krijgt die een strafpunt; klopt hij wel, dan jij.']],
      ['Eruit liggen', [`${limit} strafpunten of meer hebben: niet meer meedoen.`]],
      ['Gever', ['Wie deelt; die schuift elk potje een plaats op.']],
      ['Inzet', ['Hoeveel strafpunten wie de laatste slag niet haalt krijgt. Begint op 1, en gaat bij elke toep een punt omhoog.']],
      ['Koningsspel', ['Het laatste potje als iedereen op armoede staat: elf kaarten, drie dicht weg, en wie de laatste slag haalt, wint.']],
      ['Lijntoepen', ['Steeds passen en alleen meegaan met topkaarten. De regel anti-lijntoep gaat het tegen.']],
      ['Meegaan', ['Een toep aannemen: verlies je, dan krijg je de nieuwe inzet.']],
      ['Open spelen', ['Met je kaarten zichtbaar voor iedereen spelen, na een betrapte bluf.']],
      ['Overtoepen', ['Op een toep nog een keer toepen: de inzet gaat nog een punt omhoog.']],
      ['Passen', ['Een toep niet aannemen: je krijgt de inzet waarmee je het laatst akkoord ging en speelt dat potje niet meer mee.']],
      ['Plaatjes', ['Boer, vrouw, heer en aas: de laagste kaarten bij toepen.']],
      ['Potje', ['Eén ronde van vier kaarten (acht in het koningsspel).']],
      ['Slag', ['Eén kaart van iedereen die nog meedoet; de hoogste van de gevraagde kleur wint.']],
      ['Strafpunten', ['Wat je oploopt als je een potje verliest, past of verkeerd controleert. Wie er het minst heeft, ligt er het laatst uit.']],
      ['Toepen', ['Kloppen: de inzet een punt omhoog, voordat je je kaart speelt.']],
      ['Voorhand', [`Wie links van de gever zit. Die komt het eerst uit${on('armoede') ? ', tenzij iemand anders op armoede staat' : ''}.`]],
      ['Vuile was', ['Drie plaatjes en een 7, of vier plaatjes (een witte was): die mag je inleveren voor nieuwe kaarten.']],
      ['Wegleggen', ['In het koningsspel de kaarten die je te veel hebt dicht voor je neerleggen; die doen niet meer mee.']],
    ] },
    { id: 'bediening', title: 'Bediening', parts: [
      ['Je kaarten', [touch
        ? 'Tik een kaart aan om hem op te tillen, en nog een keer om hem te spelen. Kaarten die niet mogen, zijn donkerder.'
        : 'Klik op een kaart om hem te spelen, of gebruik de toetsen 1 tot 4 (in het koningsspel 1 tot 8). Kaarten die niet mogen, zijn donkerder.']],
      ['Toepen en antwoorden', [
        `Toepen doe je met de knop Toep! naast je naam, voordat je speelt${touch ? '' : ', of met de toets T'}.`,
        'Wordt er getoept, dan kies je onder de tafel: Meegaan, Overtoepen of Passen. Na het delen: Vuile was! of Geen, en bij een vuile was van een ander: Controleren of Laten gaan.',
        'In het koningsspel tik je eerst de kaarten aan die je weglegt (nog een keer tikken zet er een terug) en dan Wegleggen.']],
      ['Stand en meer', [
        'Bovenaan staan jouw strafpunten, het potje en de inzet. Tik op je punten voor de stand van iedereen en elk potje.',
        'Na het laatste potje tik je in de tabel op een potje om terug te zien wat er gebeurde: de vuile was, armoede, wie toepte, wie meeging of paste, en elke slag. Je ziet alleen wat op tafel kwam: handen die niemand zag, blijven verborgen.',
        'Onder de drie puntjes vind je de stand, deze spelregels, de instellingen en het geluid. Met het ballonnetje open je de chat.']],
      ['Score bijhouden', [
        'Speel je met echte kaarten aan een echte tafel? Met Score bijhouden op het beginscherm houdt één iemand de strafpunten bij: namen invullen, en na elk potje de inzet, 🏆 bij wie de laatste slag haalde, Weg bij wie paste, en met − en + wat er nog anders ging (de boer, een vuile was).',
        'De anderen kijken mee met de code of de link, en zien de stand, het verloop in een grafiek en elk potje. Wie twee keer of vaker achter elkaar weggaat, valt op als lijntoeper.']],
      ['Privacy', [
        'De server bewaart van elk spel de kaarten en de zetten, en de naam, het IP-adres en het apparaat van de spelers. Die gegevens gebruiken we voor statistieken en om het spel te verbeteren. Ze worden na hooguit 12 maanden verwijderd.']],
    ] },
  ];
}
