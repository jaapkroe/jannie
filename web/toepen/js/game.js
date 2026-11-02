// Toepen at toepen.kroes.dev: what the shell (main.js, home.js, panels.js)
// needs from the game of this site (design §9, "The game module";
// docs/toepen.md). No side effects when imported: node tests read it.
import { h, store, countWord, cap } from './util.js';
import * as table from './table.js';
import * as R from './rules.js';

export { table };
export const name = 'Toepen';
export const maxPlayers = 6;
// Phases in which a round is played, and the moves the server answers at
// once (main.js: silence means a dead socket). A was is not among them: a
// late one is ignored without an answer.
export const PLAYING = R.IN_HAND;
export const ACKED = new Set(['play', 'toep', 'answer', 'check', 'vote']);

// The table's own tools in the top bars (panels.toolButtons), and the menu.
export const TOOLS = {
  help: ['help', 'Spelregels', 'Spelregels van toepen en bediening', () => table.openRules()],
  score: ['score', 'Stand', 'Stand: de strafpunten van iedereen', () => table.openStand()],
};
export const menuTitle = 'Meer: stand, spelregels, instellingen';
export const menu = item => [
  item('score', 'Stand', table.openStand),
  item('help', 'Spelregels toepen', table.openRules),
];
export const soundSub = 'Kaarten, toepen en je beurt';
export const onError = () => table.onError();

// ---------- home and lobby (home.js) ----------

const LEVELS = [['makkelijk', 'Makkelijk'], ['normaal', 'Normaal'], ['sterk', 'Sterk']];
const TEMPOS = [['rustig', 'Rustig'], ['normaal', 'Normaal'], ['snel', 'Snel']];
const DEFAULTS = { players: 4, limit: 10, was: true, armoede: true, ai: 'normaal', tempo: 'normaal' };

// The option rows of the new-game sheet and the lobby.
const OPTS = [
  { key: 'players', label: 'Spelers', choices: [[2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6']],
    info: ['Met hoeveel spelers je toept, jij meegerekend: ieder speelt voor zich. Een plaats waar bij de start niemand zit, krijgt een AI-speler.'] },
  { key: 'limit', label: 'Eruit bij', choices: [[10, '10 punten'], [15, '15 punten']],
    info: ['Hoeveel strafpunten je mag oplopen: wie dat aantal haalt, ligt eruit. Wie als laatste over is, wint.'] },
  { key: 'was', label: 'Was', choices: [[true, 'Met was'], [false, 'Zonder']],
    info: ['Witte was: vier plaatjes (boer, vrouw, heer, aas). Vuile was: drie plaatjes en een 7.',
      'Met was mag je zo\'n hand meteen na het delen ruilen voor vier nieuwe kaarten. Een ander mag controleren: klopt het niet, dan krijg jij een strafpunt; klopt het wel, dan die ander.'] },
  { key: 'armoede', label: 'Armoede', choices: [[true, 'Aan'], [false, 'Uit']],
    info: ['Staat iemand op één strafpunt van eruit, dan begint het potje meteen met inzet 2. De anderen kiezen of ze meegaan; passen kost een punt.'] },
  { key: 'ai', label: 'AI-sterkte', choices: LEVELS,
    info: ['Makkelijk: speelt los en maakt fouten.', 'Normaal: speelt met vuistregels en bewaart de beste kaart voor de laatste slag.',
      'Sterk: speelt elke kaart honderden keren uit, met de kaarten die het niet ziet steeds anders verdeeld, en toept en past op die kansen.'] },
  { key: 'tempo', label: 'Tempo', choices: TEMPOS,
    info: 'Hoe snel de AI-spelers spelen en hoe lang de pauzes tussen de slagen duren.' },
  { key: 'seed', label: 'Seed', input: true, choices: [],
    info: ['Leeg: elke partij krijgt nieuwe kaarten.',
      'Met een getal (1 tot 999999999) krijg je bij dezelfde spelregels dezelfde kaarten, ook bij Nog een keer.',
      'De seed van een partij staat bij de start in de chat.'] },
];
const LABELS = Object.fromEntries(OPTS.map(o => [o.key, Object.fromEntries(o.choices)]));

// Snel spelen uses the options last chosen for a new game (kj.opts), each
// value checked.
function quickOpts() {
  const stored = store.json('opts', {});
  const o = {};
  for (const key of ['players', 'limit', 'was', 'armoede', 'ai', 'tempo']) {
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
  if (!o.was) parts.push('zonder was');
  if (!o.armoede) parts.push('zonder armoede');
  if (o.ai !== DEFAULTS.ai) parts.push(`AI ${LABELS.ai[o.ai].toLowerCase()}`);
  if (o.tempo !== DEFAULTS.tempo) parts.push(`tempo ${LABELS.tempo[o.tempo].toLowerCase()}`);
  const who = `${countWord(bots)} ${bots === 1 ? 'AI-speler' : 'AI-spelers'}`;
  return parts.length ? `${cap(who)} · ${parts.join(' · ')}` : `Meteen aan tafel met ${who}`;
}

function summary(o) {
  const out = [`eruit bij ${o.limit} punten`, o.was ? 'met was' : 'zonder was', o.armoede ? 'met armoede' : 'zonder armoede',
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

export const home = {
  options: OPTS,
  defaults: DEFAULTS,
  quickOpts,
  quickSub,
  summary,
  // The next new game starts from what the room has.
  remember: ({ players, limit, was, armoede, ai, tempo }) => ({ players, limit, was, armoede, ai, tempo }),
  help: { label: 'Spelregels en bediening', open: () => table.openRules() },
  footer: 'Toepen zoals aan de keukentafel.',
  support: 'Toepen is gratis en zonder reclame. Met een vrijwillige bijdrage help je de server en de ontwikkeling te betalen, zodat dat zo blijft.',
  shareText: code => `Kom je toepen? Doe mee met code ${code}:`,
};
