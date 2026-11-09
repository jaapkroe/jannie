// Toepen at toepen.kroes.dev: what the shell (main.js, home.js, panels.js)
// needs from the game of this site (docs/frontend.md#the-game-module;
// games/toepen/README.md#the-site). No side effects when imported: node
// tests read it.
import { h, icon, store, countWord, cap, toast } from './util.js';
import * as table from './table.js';
import * as R from './rules.js';

export { table };
export const name = 'Toepen';
export const maxPlayers = 6;
// Phases in which a round is played, and the moves the server answers at
// once (main.js: silence means a dead socket). A was is not among them: a
// late one is ignored without an answer.
export const PLAYING = R.IN_HAND;
export const ACKED = new Set(['play', 'toep', 'overtoep', 'answer', 'check', 'discard', 'vote']);

// The table's own tools in the top bars (panels.toolButtons), and the menu.
export const TOOLS = {
  help: ['help', 'Spelregels', 'Spelregels van toepen en bediening', () => table.openRules()],
  score: ['score', 'Stand', 'Stand: de strafpunten van iedereen', () => table.openStand()],
  // Expert mode, alone with bots: the reasoning for your own decision.
  why: ['bot', 'Redenering van de AI', 'Redenering van de AI bij jouw zet', () => table.openWhy(), { hidden: true }],
};
export const menuTitle = 'Meer: stand, spelregels, instellingen';
export const menu = item => [
  item('score', 'Stand', table.openStand),
  item('help', 'Spelregels toepen', table.openRules),
];
export const soundSub = 'Kaarten, toepen en je beurt';
export const onError = () => table.onError();
// After every update, the lobby's too: overlays of the game close once the
// room moved on (game over → Spelers of regels wijzigen).
export const sync = s => table.sync(s);

// ---------- home and lobby (home.js) ----------

const LEVELS = [['makkelijk', 'Makkelijk'], ['normaal', 'Normaal'], ['sterk', 'Sterk']];
const TEMPOS = [['rustig', 'Rustig'], ['normaal', 'Normaal'], ['snel', 'Snel']];
const DEFAULTS = { players: 4, limit: 10, was: true, armoede: true, koning: true, boer: true, lijntoep: false, bluf: true, ai: 'normaal', tempo: 'normaal' };

// The option rows of the new-game sheet and the lobby.
const OPTS = [
  { key: 'players', label: 'Spelers', choices: [[2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6']],
    info: ['Met hoeveel spelers je toept, jij meegerekend: ieder speelt voor zich. Een plaats waar bij de start niemand zit, krijgt een AI-speler.'] },
  { key: 'limit', label: 'Eruit bij', choices: [[10, '10 punten'], [15, '15 punten']],
    info: ['Bij hoeveel strafpunten je eruit ligt. Wie als laatste over is, wint.'] },
  { key: 'was', label: 'Vuile was', choices: [[true, 'Aan'], [false, 'Uit']],
    info: ['Vuile was: drie plaatjes (boer, vrouw, heer, aas) en een 7. Vier plaatjes mag ook (een witte was).',
      'Zo\'n hand mag je meteen na het delen inleveren voor vier nieuwe kaarten, en met de nieuwe weer, zolang de stapel strekt. Een ander mag controleren: klopt het niet, dan krijg jij een strafpunt; klopt het wel, dan die ander.',
      'Op armoede alleen een echte, en die gaat even open op tafel.'] },
  { key: 'bluf', label: 'Betrapte bluf', choices: [[true, 'Open spelen'], [false, 'Potje uit']],
    info: ['Wie een vuile was meldt die er geen is en betrapt wordt, krijgt een strafpunt.',
      'Open spelen: die neemt de kaarten terug en speelt het potje uit met de kaarten open op tafel. Potje uit: die doet dat potje niet meer mee.'] },
  { key: 'armoede', label: 'Armoede', choices: [[true, 'Aan'], [false, 'Uit']],
    info: ['Staat iemand op armoede (nog één strafpunt en die ligt eruit), dan begint het potje meteen met inzet 2. De anderen kiezen of ze meegaan; passen kost een punt.',
      'Op armoede kun je zelf niet toepen.'] },
  { key: 'koning', label: 'Koningsspel', choices: [[true, 'Aan'], [false, 'Uit']],
    info: ['Staat iedereen die nog meedoet op armoede, dan volgt het koningsspel: iedereen krijgt elf kaarten en legt er drie dicht weg, er wordt niet getoept en wie de laatste slag haalt, wint het spel.'] },
  { key: 'boer', label: 'Boer', choices: [[true, 'Punt eraf'], [false, 'Gewoon']],
    info: ['Punt eraf: haal je de laatste slag met een boer, de laagste kaart, dan gaat er een strafpunt van je af.'] },
  { key: 'lijntoep', label: 'Anti-lijntoep', choices: [[false, 'Uit'], [true, 'Aan']],
    info: ['Lijntoepen is steeds passen en alleen meegaan met topkaarten.',
      'Met anti-lijntoep mag je hoogstens twee keer achter elkaar passen op een toep: bij de derde ga je verplicht mee (of je overtoept).'] },
  { key: 'ai', label: 'AI-sterkte', choices: LEVELS,
    info: ['Makkelijk: speelt los en maakt fouten.', 'Normaal: speelt met vuistregels en bewaart de beste kaart voor de laatste slag.',
      'Sterk: speelt elke kaart honderden keren uit, met de kaarten die het niet ziet steeds anders verdeeld, en toept en past op die kansen.'] },
  { key: 'tempo', label: 'Tempo', choices: TEMPOS,
    info: 'Hoe snel de AI-spelers spelen en hoe lang de pauzes tussen de slagen duren.' },
  { key: 'seed', label: 'Seed', input: true, choices: [],
    info: ['Leeg: elke partij krijgt nieuwe kaarten.',
      'Met een getal (1 tot 999999999) krijg je bij dezelfde spelregels dezelfde kaarten, ook bij Nog een keer.',
      'De seed van een partij staat pas aan het eind in de chat.'] },
];
const LABELS = Object.fromEntries(OPTS.map(o => [o.key, Object.fromEntries(o.choices)]));

// Snel spelen uses the options last chosen for a new game (kj.opts), each
// value checked.
function quickOpts() {
  const stored = store.json('opts', {});
  const o = {};
  for (const key of ['players', 'limit', 'was', 'armoede', 'koning', 'boer', 'lijntoep', 'bluf', 'ai', 'tempo']) {
    if (stored?.[key] != null && LABELS[key][stored[key]] !== undefined) o[key] = stored[key];
  }
  return o;
}

// The quick-play subtitle names whatever differs from the defaults.
function quickSub() {
  const o = { ...DEFAULTS, ...quickOpts() };
  const bots = o.players - 1;
  const parts = [];
  if (o.limit !== DEFAULTS.limit) parts.push(`eruit bij ${o.limit}`);
  if (!o.was) parts.push('zonder vuile was');
  if (!o.armoede) parts.push('zonder armoede');
  if (!o.koning) parts.push('zonder koningsspel');
  if (!o.boer) parts.push('boer gewoon');
  if (o.lijntoep) parts.push('anti-lijntoep');
  if (!o.bluf && o.was) parts.push('bluf: potje uit');
  if (o.ai !== DEFAULTS.ai) parts.push(`AI ${LABELS.ai[o.ai].toLowerCase()}`);
  if (o.tempo !== DEFAULTS.tempo) parts.push(`tempo ${LABELS.tempo[o.tempo].toLowerCase()}`);
  const who = `${countWord(bots)} ${bots === 1 ? 'AI-speler' : 'AI-spelers'}`;
  return parts.length ? `${cap(who)} · ${parts.join(' · ')}` : `Meteen aan tafel met ${who}`;
}

function summary(o) {
  const out = [`eruit bij ${o.limit} punten`, o.was ? 'met vuile was' : 'zonder vuile was', o.armoede ? 'met armoede' : 'zonder armoede',
    o.koning === false ? 'zonder koningsspel' : 'met koningsspel', o.boer === false ? 'boer gewoon' : 'boer: punt eraf',
    o.lijntoep ? 'anti-lijntoep' : 'zonder anti-lijntoep', o.bluf === false ? 'betrapte bluf: potje uit' : 'betrapte bluf: open spelen',
    `AI ${LABELS.ai[o.ai]?.toLowerCase() || o.ai}`, `tempo ${LABELS.tempo[o.tempo]?.toLowerCase() || o.tempo}`];
  if (o.seed) out.push(`seed ${o.seed}`);
  return out;
}

// The lobby's mini table: up to six places on an ellipse, as at the table
// (rules.js seatAngle), nobody anyone's partner.
const lobbySeats = [];
export const lobby = {
  seats(miniTable) {
    miniTable.classList.add('tp');
    for (let k = 0; k < maxPlayers; k++) miniTable.append(lobbySeats[k] = h('div', { class: 'lseat ls-tp' }));
    return lobbySeats;
  },
  slot(s, seat) {
    const el = lobbySeats[seat];
    const at = R.onEllipse(R.seatAngle(s, seat), 38, 36, 50, 50);
    el.style.left = `${at.x}%`;
    el.style.top = `${at.y}%`;
    return { el, cls: `ls-tp ${seat === s.you ? 'wij' : 'tp-opp'}`, role: 'tegenspeler', free: 'vrij' };
  },
};

// Score bijhouden (score.js, loaded on demand): the score of a game at a
// real table. From the home's tile, or a link https://SITE/?score=CODE.
function openScore(code = '') {
  import('./score.js').then(m => m.open(code)).catch(() => toast('Dat lukte niet. Is er verbinding?', { kind: 'warn' }));
}

export const home = {
  options: OPTS,
  defaults: DEFAULTS,
  quickOpts,
  quickSub,
  summary,
  // The next new game starts from what the room has.
  remember: ({ players, limit, was, armoede, koning, boer, lijntoep, bluf, ai, tempo }) => ({ players, limit, was, armoede, koning, boer, lijntoep, bluf, ai, tempo }),
  help: { label: 'Spelregels en bediening', open: () => table.openRules() },
  tiles: () => [h('button', { class: 'btn btn-tile', type: 'button', id: 'btn-score', onclick: () => openScore() },
    icon('score'), h('b', { text: 'Score bijhouden' }), h('small', { text: 'Aan een echte tafel' }))],
  // At boot on the home: a link to a score sheet opens it. The page's own
  // history entry goes back to /, so closing the sheet (back) lands there;
  // the sheet's entry carries ?score= while it is open.
  route: params => {
    const code = params.get('score');
    if (!code) return;
    history.replaceState(history.state, '', '/');
    openScore(code);
  },
  // Five taps on the word Versie: the expert mode on or off (on this device).
  egg: () => {
    const on = store.get('expert', '') !== '1';
    if (on) store.set('expert', '1');
    else store.del('expert');
    toast(on ? 'Expertmodus aan: speel je zonder andere mensen, dan geeft het robotje bovenin de redenering van de AI bij je eigen zet.'
      : 'Expertmodus uit.', { ms: 4000 });
  },
  footer: 'Toepen zoals aan de keukentafel.',
  support: 'Toepen is gratis en zonder reclame. Met een vrijwillige bijdrage help je de server en de ontwikkeling te betalen, zodat dat zo blijft.',
  shareText: code => `Kom je toepen? Doe mee met code ${code}:`,
};
