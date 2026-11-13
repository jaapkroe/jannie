// Klaverjas at klaverjas.kroes.dev: what the shell (main.js, home.js,
// panels.js) needs from the game of this site
// (docs/frontend.md#the-game-module). No side effects when imported: node
// tests read it.
import { sound } from './sound.js';
import { app, h, icon, store, countWord, cap } from './util.js';
import { POS, lobbyPos, WIND, isWij, teamCls, variantText } from './rules.js';
import * as panels from './panels.js';
import * as table from './table.js';
import { optionsForm, numberField, soloName } from './home.js';

export { table };
export const name = 'Klaverjas';
export const maxPlayers = 4;
// Phases in which a hand is played (a turn may be the player's), and the
// moves the server answers at once (main.js: silence means a dead socket).
export const PLAYING = new Set(['auction', 'discard', 'trump', 'bid', 'play']);
export const ACKED = new Set(['play', 'trump', 'bid', 'auction', 'discard', 'vote']);

// The table's own tools in the top bars (panels.toolButtons), and the menu.
const TOOLS = {
  last: ['history', 'Laatste slag', 'Laatste slag: bekijk wie wat speelde', () => table.openLastTrick()],
  score: ['score', 'Scorebord', 'Scorebord: alle potjes en de stand', () => table.openScoreSheet()],
  help: ['help', 'Handleiding', 'Handleiding: bediening, spelregels, roem en tips', () => table.openManual()],
  expert: ['bot', 'Redenering van de AI', 'Redenering van de AI bij jouw zetten, en commentaar', () => table.openWhy(), { hidden: true }],
};
export { TOOLS };
export const menuTitle = 'Meer: scorebord, handleiding, instellingen';
export const menu = item => [
  item('score', 'Scorebord', table.openScoreSheet),
  item('history', 'Laatste slag', table.openLastTrick),
  item('help', 'Handleiding', () => table.openManual()),
];
export const soundSub = 'Kaarten, troef, roem en je beurt';
export const chatQuick = ['👍', '😂', '😱', '😭', 'Mooi!', 'Nat!', 'Goed gespeeld!'];
export const chatCls = (s, seat) => teamCls(s, seat);

// The overlays after an update (summary, game over, replay; table.sync).
export const sync = (s, ev) => table.sync(s, ev);
// The server refused something; the connection is back (main.js).
export function onError() {
  table.onError();
  table.overlayError();
  table.whyError();
}
export const onReconnect = () => table.overlayReconnect();
// Messages of this game: handled at once, or after the animations queued
// before them.
export const messages = {
  why: m => import('./expert.js').then(x => x.onWhy(m)),
  handReview: m => table.onHandReview(m),
};
export const queued = { tip: m => table.setTip(m.text) };

// ---------- home and lobby (home.js) ----------

const SIGNALS = { aas: true, kleintjeBoer: true, hoogLaag: true, boerOverBoer: false };
const DEFAULTS = { players: 4, hands: 16, trumpMode: 'utrechts', rules: 'amsterdams', ai: 'normaal', tempo: 'normaal', signals: SIGNALS };

// Option rows shared by the new-game sheet and the lobby.
const OPTS = [
  { key: 'players', label: 'Spelers', choices: [[2, '2'], [3, '3'], [4, '4']],
    info: ['Met hoeveel spelers je klaverjast, jij meegerekend. Een plaats waar bij de start niemand zit, krijgt een AI-speler.',
      'Met z\'n vieren: twee tegen twee, maten tegenover elkaar.',
      'Met z\'n drieën: ieder voor zich. Je krijgt tien kaarten, twee liggen dicht op tafel. Wie het hoogst biedt, pakt die twee, legt er twee weg, kiest troef en speelt alleen tegen de andere twee.',
      'Met z\'n tweeën: je speelt van acht stapeltjes van twee kaarten op tafel, de bovenste open. Ook de kaarten van de ander zie je.'] },
  { key: 'hands', label: 'Potjes', choices: [[4, '4'], [8, '8'], [12, '12'], [16, '16'], [20, '20'], [24, '24']],
    info: ['Hoeveel potjes (handen) het spel duurt. Zestien potjes heet een boom.', 'Wie na het laatste potje de meeste punten heeft, wint.'] },
  { key: 'trumpMode', label: 'Troef', choices: [['utrechts', 'Utrechts'], ['gedraaid', 'Gedraaid']], players: [2, 4],
    info: ['Utrechts (verplicht): de voorhand moet troef kiezen en speelt.', 'Gedraaid (vrij): er wordt een kleur gedraaid. Om de beurt zeg je spelen of passen. Past iedereen, dan kiest de voorhand een andere kleur.', 'Met z\'n drieën wordt er om troef geboden.'] },
  { key: 'rules', label: 'Regels', choices: [['amsterdams', 'Amsterdams'], ['rotterdams', 'Rotterdams']], players: [3, 4],
    info: ['Amsterdams: kun je niet bekennen en heeft je maat de slag, dan hoef je niet te troeven.', 'Rotterdams: kun je niet bekennen, dan moet je altijd troeven (en overtroeven als het kan).', 'Met z\'n drieën zijn de twee tegenspelers van wie alleen speelt elkaars maat. Met z\'n tweeën heb je geen maat.'] },
  { key: 'ai', label: 'AI-sterkte', choices: [['makkelijk', 'Makkelijk'], ['normaal', 'Normaal'], ['sterk', 'Sterk']],
    info: ['Makkelijk: speelt los en maakt fouten.', 'Normaal: speelt degelijk volgens de vuistregels en telt kaarten. Met z’n vieren geeft en leest Normaal ook de seinen van de tafel.', 'Sterk: speelt bij elke keuze het potje honderden keren uit, kiest wat gemiddeld het meest oplevert en kent ook de seinen.'] },
  { key: 'tempo', label: 'Tempo', choices: [['rustig', 'Rustig'], ['normaal', 'Normaal'], ['snel', 'Snel']],
    info: 'Hoe snel de AI-spelers spelen en hoe lang de pauzes tussen de slagen duren.' },
  { key: 'signals', label: 'Seinen', players: [4], multi: true, value: v => signalsOf(v),
    choices: [['aas', 'Met de aas seinen'], ['hoogLaag', 'Op- en afseinen'], ['kleintjeBoer', 'Kleintje boer'], ['boerOverBoer', 'Boer over boer']],
    info: ['De afspraken aan deze tafel: welke kaarten je maat iets vertellen. De AI-spelers op Normaal en Sterk en de tips houden zich eraan. Bij de start van een spel staan ze in de chat.',
      'Met de aas seinen: gooi je op een slag van je maat een aas bij van een bijkleur die nog niet gespeeld is, dan heb je de 10 van die kleur ook.',
      'Op- en afseinen: kun je niet bekennen op een slag van je maat, dan zegt een 7, 8 of 9 “speel deze kleur, daar heb ik de hoogste van” (opseinen) en een 10, boer, vrouw of heer “de hoogste van deze kleur heb ik niet” (afseinen). Op een slag van de tegenpartij zegt je bijkaart niets.',
      'Kleintje boer: komt iemand van de spelende partij voor het eerst uit met een 7, 8 of 9 van een bijkleur, dan heeft die de troefboer.',
      'Boer over boer: komt iemand van de spelende partij voor het eerst uit met een boer van een bijkleur, dan heeft die de troefboer.',
      'Tegenkleur seinen staat hier niet bij: dat sein gebruiken de AI-spelers en de tips niet.'] },
  { key: 'seed', label: 'Seed', input: true, choices: [],
    info: ['Leeg: elke partij krijgt nieuwe kaarten.',
      'Met een getal (1 tot 999999999) krijg je bij dezelfde spelregels dezelfde kaarten, ook bij Nog een partij. Zo speel je een partij nog eens, of dezelfde kaarten als iemand anders.',
      'De kaarten horen bij de plaats aan tafel (Zuid, West, Noord, Oost): wie dezelfde kaarten wil, gaat op dezelfde plaats zitten.',
      'De seed van een partij staat pas aan het eind in de chat, en in de spelanalyse.'] },
];

const LABELS = Object.fromEntries(OPTS.map(o => [o.key, Object.fromEntries(o.choices)]));
// The sheet Oefenen: Juf Jannie's lessons, each one match, and vrij, the
// game with hints only (option lesson empty).
const LESSONS = [
  ['basis', 'Basisspel', 'Kaarten, troef, bekennen en punten'],
  ['roem', 'Roem en tellen', 'Extra punten herkennen en troeven tellen'],
  ['seinen', 'Seinen', 'Je maat iets vertellen met je kaart'],
  ['vrij', 'Vrij spelen', 'Een heel spel met een tip bij elke beurt'],
];
// The agreements on signals as a whole object, defaults for what is missing.
const signalsOf = v => Object.fromEntries(Object.entries(SIGNALS).map(([k, d]) => [k, typeof v?.[k] === 'boolean' ? v[k] : d]));
const sameSignals = (a, b) => Object.keys(SIGNALS).every(k => signalsOf(a)[k] === signalsOf(b)[k]);

function optsSummary(o) {
  const out = [`${o.hands} potjes`, variantText(o), `AI ${LABELS.ai[o.ai]?.toLowerCase() || o.ai}`, `tempo ${LABELS.tempo[o.tempo]?.toLowerCase() || o.tempo}`];
  if (o.players === 4) out.push(signalsText(o.signals));
  if (o.seed) out.push(`seed ${o.seed}`);
  return out;
}

// "seinen: met de aas seinen, op- en afseinen, kleintje boer", or "geen seinen".
function signalsText(sig) {
  const on = OPTS.find(x => x.key === 'signals').choices.filter(([k]) => signalsOf(sig)[k]).map(([, label]) => label.toLowerCase());
  return on.length ? `seinen: ${on.join(', ')}` : 'geen seinen';
}

// Snel spelen uses the options last chosen for a new game (kj.opts), the
// number of players included, alone with bots.
function quickOpts() {
  const stored = store.json('opts', {});
  const o = {};
  for (const key of ['players', 'hands', 'trumpMode', 'rules', 'ai', 'tempo']) {
    if (stored?.[key] != null && LABELS[key][stored[key]] !== undefined) o[key] = stored[key];
  }
  if (stored?.signals && typeof stored.signals === 'object') o.signals = signalsOf(stored.signals);
  return o;
}

// The quick-play subtitle names whatever differs from the defaults.
function quickSub() {
  const o = { ...DEFAULTS, ...quickOpts() };
  const bots = o.players - 1;
  const parts = [];
  if (o.hands !== DEFAULTS.hands) parts.push(`${o.hands} potjes`);
  if (o.trumpMode !== DEFAULTS.trumpMode && o.players !== 3) parts.push(LABELS.trumpMode[o.trumpMode]);
  if (o.rules !== DEFAULTS.rules && o.players !== 2) parts.push(LABELS.rules[o.rules]);
  if (o.ai !== DEFAULTS.ai) parts.push(`AI ${LABELS.ai[o.ai].toLowerCase()}`);
  if (o.tempo !== DEFAULTS.tempo) parts.push(`tempo ${LABELS.tempo[o.tempo].toLowerCase()}`);
  if (o.players === 4 && !sameSignals(o.signals, SIGNALS)) parts.push('eigen seinen');
  const who = `${countWord(bots)} ${bots === 1 ? 'AI-speler' : 'AI-spelers'}`;
  return parts.length ? `${cap(who)} · ${parts.join(' · ')}` : `Meteen aan tafel met ${who}`;
}

// What Oefenen had last (kj.train), each value checked: what is corrupt or
// stale falls back to its default. Who switched Speluitleg off before there
// were lessons (kj.lessons) starts on Vrij spelen.
function trainOpts() {
  const { players, ...defaults } = DEFAULTS;
  const raw = store.json('train', null);
  const saved = raw && typeof raw === 'object' ? raw : null;
  const opts = { ...defaults, hands: 8, tempo: 'rustig', tips: true, open: false, seed: null, lesson: !saved && store.get('lessons') === '0' ? 'vrij' : 'basis' };
  if (!saved) return opts;
  for (const o of OPTS) {
    if (o.key in opts && o.choices.some(([v]) => v === saved[o.key])) opts[o.key] = saved[o.key];
  }
  for (const key of ['tips', 'open']) {
    if (typeof saved[key] === 'boolean') opts[key] = saved[key];
  }
  if (LESSONS.some(([id]) => id === saved.lesson)) opts.lesson = saved.lesson;
  if (Number.isInteger(saved.seed) && saved.seed >= 1 && saved.seed <= 999999999) opts.seed = saved.seed;
  opts.signals = signalsOf(saved.signals);
  return opts;
}

// Oefenen: a lesson or Vrij spelen, with Juf Jannie against two AI-spelers.
// Every choice stays on the device (kj.train), the seed too. Spelopties is
// folded, and opens by itself for what would surprise at the table: Tips
// off, Open kaarten on or a seed.
function openTraining() {
  sound.unlock();
  sound.play('click');
  const opts = trainOpts();
  const save = () => store.setJSON('train', opts);
  const switchRow = (key, title, sub) => h('label', { class: 'set-row' },
    h('span', { class: 'set-txt' }, h('b', { text: title }), h('small', { text: sub })),
    h('span', { class: 'switch' }, h('input', { type: 'checkbox', id: `train-${key}`, checked: opts[key], onchange: e => { opts[key] = e.target.checked; save(); } }), h('i')));
  const form = optionsForm(opts, (k, v) => { opts[k] = v; save(); }, ['hands', 'trumpMode', 'rules', 'ai', 'tempo', 'signals', 'seed'],
    { ai: 'In de les over seinen spelen ze minstens op Normaal.', signals: 'In Vrij spelen op AI-sterkte Makkelijk speelt niemand met seinen.' });
  const go = h('button', { class: 'btn btn-go btn-big btn-block', type: 'button', id: 'btn-train-go', onclick: () => {
    m.close(true);
    app.create({ opts: { ...opts, lesson: opts.lesson === 'vrij' ? '' : opts.lesson }, training: true, start: true, name: soloName() });
  } });
  // A lesson has its own length; only Seinen and Vrij spelen have signals.
  const followLesson = () => {
    const vrij = opts.lesson === 'vrij';
    form.querySelector('[data-key="hands"]').hidden = !vrij;
    form.querySelector('[data-key="signals"]').hidden = !vrij && opts.lesson !== 'seinen';
    go.textContent = vrij ? 'Start oefenspel' : 'Start les';
  };
  const lessons = panels.segmented(LESSONS.map(([id, title, sub]) => [id, [h('b', { text: title }), h('small', { text: sub })]]), opts.lesson, v => {
    opts.lesson = v;
    save();
    followLesson();
  }, 'Les');
  lessons.classList.add('train-lessons');
  lessons.querySelectorAll('.seg-btn').forEach((b, i) => { b.id = `train-lesson-${LESSONS[i][0]}`; });
  followLesson();
  const m = panels.openModal({
    id: 'train', title: 'Oefenen met Juf Jannie', cls: 'm-sheet m-train', body: [
      h('div', { class: 'train-intro' },
        h('span', { class: 'avatar is-bot train-av', text: '👩‍🏫' }),
        h('p', { text: 'Je speelt samen met Juf Jannie tegen twee AI-spelers. Kies een les.' })),
      lessons,
      h('details', { class: 'train-opts', open: !opts.tips || opts.open || !!opts.seed },
        h('summary', { text: 'Spelopties' }),
        switchRow('tips', 'Tips', 'Een tip bij elke beurt en uitleg na elke slag'),
        switchRow('open', 'Open kaarten', 'Je ziet de kaarten van alle spelers'),
        form),
      h('div', { class: 'sheet-foot' }, go),
    ],
  });
}


// A game alone against three bots with the cards of a seed: the whole
// match, or one hand of it (from), at a seat of choice. The choices stay
// on the device (kj.expert), the seed too.
function openExpert() {
  sound.unlock();
  sound.play('click');
  const opts = { ...DEFAULTS, open: false, seed: null, from: null, ...store.json('expert', {}) };
  delete opts.players;
  const save = () => store.setJSON('expert', opts);
  const open = h('input', { type: 'checkbox', checked: !!opts.open, onchange: e => { opts.open = e.target.checked; save(); } });
  const showHands = () => { form.querySelector('[data-key="hands"]').hidden = !!opts.from; };
  const form = optionsForm(opts, (k, v) => { opts[k] = v; save(); }, ['seed', 'hands', 'trumpMode', 'rules', 'signals', 'ai', 'tempo']);
  form.querySelector('[data-key="seed"]').after(h('div', { class: 'opt-row', dataset: { key: 'from' } },
    h('div', { class: 'opt-lbl' }, h('span', { text: 'Potje' }), panels.infoBtn('Potje', [
      'Leeg: het hele spel.',
      'Met een nummer speel je alleen dat potje van de seed: dezelfde kaarten en dezelfde gever als in het hele spel.',
      'De seed staat aan het eind van elk spel in de chat, het nummer van een potje op het scorebord.',
    ])),
    numberField(opts.from, v => { opts.from = v; save(); showHands(); }, { max: 24, placeholder: 'Hele spel', label: 'Potje' })));
  form.querySelector('[data-key="from"]').after(h('div', { class: 'opt-row', dataset: { key: 'seat' } },
    h('div', { class: 'opt-lbl' }, h('span', { text: 'Plaats' }), panels.infoBtn('Plaats', [
      'Waar je aan tafel zit. Plaats 1 is Zuid in het tafeltje van Klaarzetten, plaats 2 West (links van 1), plaats 3 Noord (tegenover 1) en plaats 4 Oost (rechts van 1). In Snel spelen zit je op plaats 1.',
      'Met dezelfde seed krijgt elke plaats dezelfde kaarten en dezelfde gever als in dat spel.',
      'In het spellog heet plaats 1 seat 0, plaats 4 seat 3.',
    ])),
    panels.segmented([[0, '1'], [1, '2'], [2, '3'], [3, '4']], opts.seat ?? 0, v => { opts.seat = v; save(); }, 'Plaats')));
  showHands();
  const m = panels.openModal({
    id: 'expert', title: 'Expert', cls: 'm-sheet m-train', body: [
      h('p', { class: 'sheet-note', text: 'Speel een spel opnieuw met de seed, of één potje ervan, op een plaats naar keuze, tegen drie AI-spelers. Op je beurt tik je bovenin op de robot voor de redenering van de AI, en geef je commentaar. Na elk potje tik je op een slag en dan op Dit potje terugkijken.' }),
      h('label', { class: 'set-row' },
        h('span', { class: 'set-txt' }, h('b', { text: 'Open kaarten' }), h('small', { text: 'Je ziet de kaarten van alle spelers' })),
        h('span', { class: 'switch' }, open, h('i'))),
      form,
      h('div', { class: 'sheet-foot' }, h('button', { class: 'btn btn-go btn-big btn-block', type: 'button', id: 'btn-expert-go', onclick: () => {
        m.close(true);
        const { seat, ...rest } = opts; // the seat goes beside the options
        app.create({ opts: { ...rest, players: 4 }, expert: true, seat: seat ?? 0, start: true, name: soloName() });
      } }, 'Start expertspel')),
    ],
  });
}

// The lobby's mini table: the four places of the table (POS), partners
// opposite. A seat keeps its place whoever looks (lobbyPos), named by its
// wind direction; the colours and the words maat and tegenstander are the
// viewer's. At the table everyone sits at the bottom (posOf).
const lobbySeats = {};
export const lobby = {
  seats(miniTable) {
    for (const pos of POS) miniTable.append(lobbySeats[pos] = h('div', { class: 'lseat ls-' + pos }));
    return Object.values(lobbySeats);
  },
  slot(s, seat) {
    const pos = lobbyPos(s, seat);
    return {
      el: lobbySeats[pos], cls: `ls-${pos} ${teamCls(s, seat)}`, wind: WIND[pos],
      role: isWij(s, seat) ? 'maat' : 'tegenstander', free: isWij(s, seat) ? 'maat · vrij' : 'vrij',
    };
  },
};

export const home = {
  options: OPTS,
  defaults: DEFAULTS,
  quickOpts,
  quickSub,
  summary: optsSummary,
  // The next new game starts from what the room has.
  remember: ({ players, hands, trumpMode, rules, ai, tempo, signals }) => ({ players, hands, trumpMode, rules, ai, tempo, signals }),
  tiles: () => [h('button', { class: 'btn btn-tile', type: 'button', id: 'btn-train', onclick: openTraining },
    icon('school'), h('b', { text: 'Oefenen' }), h('small', { text: 'Leren met tips' }))],
  help: { label: 'Handleiding en spelregels', open: () => table.openManual() },
  egg: openExpert,
  footer: 'Klaverjassen zoals in het café.',
  support: 'Klaverjas is gratis en zonder reclame. Met een vrijwillige bijdrage help je de server en de ontwikkeling te betalen, zodat dat zo blijft.',
  shareText: code => `Kom je klaverjassen? Doe mee met code ${code}:`,
};
