// Home screen (name, quick play, new game, join, training), the join-link
// invite, and the lobby where seats and options are arranged.
import { sound } from './sound.js';
import { app, h, clear, icon, store, toast, POS, posOf, seatCount, isWij, teamCls, avatar, playerName, variantText, countWord, cap, copyText, DEFAULT_NAME, versionText } from './util.js';
import * as panels from './panels.js';

const E = {};
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;
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
    info: ['Makkelijk: speelt los en maakt fouten.', 'Normaal: speelt degelijk volgens de vuistregels.', 'Sterk: telt kaarten, rekent kansen door en kent de seinen.'] },
  { key: 'tempo', label: 'Tempo', choices: [['rustig', 'Rustig'], ['normaal', 'Normaal'], ['snel', 'Snel']],
    info: 'Hoe snel de AI-spelers spelen en hoe lang de pauzes tussen de slagen duren.' },
  { key: 'signals', label: 'Seinen', players: [4], multi: true,
    choices: [['aas', 'Aas vraagt 10'], ['kleintjeBoer', 'Kleintje boer'], ['hoogLaag', 'Hoog/laag'], ['boerOverBoer', 'Boer over boer']],
    info: ['De afspraken aan deze tafel: welke kaarten je maat iets vertellen. De AI-spelers en de tips houden zich eraan.',
      'Aas vraagt 10: gooi je op een slag van je maat een aas bij van een bijkleur die nog niet gespeeld is, dan heb je de 10 van die kleur ook.',
      'Kleintje boer: komt de spelende partij voor het eerst uit met een 7, 8 of 9 van een bijkleur, dan heeft die de troefboer.',
      'Hoog/laag: kun je niet bekennen op een slag van je maat, dan zegt een klein kaartje “speel deze kleur, daar heb ik de hoogste van” en een 10 of plaatje “ik heb weinig in deze kleur”. Op een slag van de tegenpartij zegt je bijkaart niets.',
      'Boer over boer: komt de spelende partij voor het eerst uit met een boer van een bijkleur, dan heeft die de troefboer.'] },
  { key: 'seed', label: 'Seed', input: true, choices: [],
    info: ['Leeg: elke partij krijgt nieuwe kaarten.',
      'Met een getal (1 tot 999999999) krijg je bij dezelfde spelregels dezelfde kaarten, ook bij Nog een partij. Zo speel je een partij nog eens, of dezelfde kaarten als iemand anders.',
      'De seed van een partij staat bij de start in de chat, en in de spelanalyse.'] },
];

const LABELS = Object.fromEntries(OPTS.map(o => [o.key, Object.fromEntries(o.choices)]));
// The agreements on signals as a whole object, defaults for what is missing.
const signalsOf = v => Object.fromEntries(Object.entries(SIGNALS).map(([k, d]) => [k, typeof v?.[k] === 'boolean' ? v[k] : d]));
const sameSignals = (a, b) => Object.keys(SIGNALS).every(k => signalsOf(a)[k] === signalsOf(b)[k]);
// The lobby's start button ignores taps this long after it first shows: a
// double tap on "Maak spel" lands on it and would start without friends.
const START_GUARD_MS = 800;

// The option rows; a row that does not apply to the number of players
// (o.players) hides: troef with three (they bid), the rules with two
// (nobody has a partner). onChange hears every choice.
function optionsForm(opts, onChange, keys = OPTS.map(o => o.key)) {
  const form = h('div', { class: 'opts' }, OPTS.filter(o => keys.includes(o.key)).map(o =>
    h('div', { class: 'opt-row', dataset: { key: o.key } },
      h('div', { class: 'opt-lbl' }, h('span', { text: o.label }), panels.infoBtn(o.label, o.info)),
      o.input ? seedField(opts[o.key], v => onChange(o.key, v))
      : o.multi
        ? panels.toggles(o.choices, signalsOf(opts[o.key]), v => onChange(o.key, v), o.label)
        : panels.segmented(o.choices, opts[o.key] ?? DEFAULTS[o.key], v => {
          onChange(o.key, v);
          if (o.key === 'players') showRows(form, v);
        }, o.label))));
  showRows(form, opts.players ?? DEFAULTS.players);
  return form;
}

// The seed: digits only, at most nine; empty (null) is a new seed per match.
function seedField(value, fn) {
  return numberField(value, fn, { max: 999999999, placeholder: 'Willekeurig', label: 'Seed' });
}

// A whole number from 1 to max, or empty (null).
function numberField(value, fn, { max, placeholder, label }) {
  const digits = String(max).length;
  const el = h('input', {
    type: 'text', inputMode: 'numeric', class: 'field seed-field', maxLength: digits, placeholder,
    value: value ? String(value) : '', autocomplete: 'off', enterKeyHint: 'done', 'aria-label': label,
  });
  el.addEventListener('change', () => {
    const n = Math.min(max, Number(el.value.replace(/\D/g, '').slice(0, digits)) || 0);
    el.value = n ? String(n) : '';
    fn(n || null);
  });
  return el;
}

function showRows(form, players) {
  for (const row of form.querySelectorAll('.opt-row')) {
    const o = OPTS.find(x => x.key === row.dataset.key);
    row.hidden = !!o?.players && !o.players.includes(players);
  }
}

function optsSummary(o) {
  const out = [`${o.hands} potjes`, variantText(o), `AI ${LABELS.ai[o.ai]?.toLowerCase() || o.ai}`, `tempo ${LABELS.tempo[o.tempo]?.toLowerCase() || o.tempo}`];
  if (o.players === 4) out.push(signalsText(o.signals));
  if (o.seed) out.push(`seed ${o.seed}`);
  return out;
}

// "seinen: aas vraagt 10, kleintje boer, hoog/laag", or "geen seinen".
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


// Shows the quick-play subtitle with "AI-spelers" kept whole: a narrow
// phone would break the line after "AI-".
function showQuickSub() {
  E.quickSub.replaceChildren(...quickSub().split(/(AI-spelers?)/).filter(Boolean)
    .map(part => (part.startsWith('AI-speler') ? h('span', { class: 'nobreak', text: part }) : part)));
}

// ---------- home ----------

export function init() {
  const root = document.getElementById('home');
  E.name = h('input', {
    id: 'name', class: 'field field-name', type: 'text', maxLength: 20, placeholder: 'Hoe heet je?', autocomplete: 'nickname',
    autocapitalize: 'words', spellcheck: false, enterKeyHint: 'done', value: store.get('name', ''), 'aria-label': 'Je naam',
  });
  E.name.addEventListener('change', saveName);
  E.name.addEventListener('input', () => E.name.classList.remove('ask'));
  E.name.addEventListener('blur', () => E.name.classList.remove('ask'));
  // Enter (the keyboard's go key) does what the name was asked for: join
  // the invite, or the code already typed; otherwise it just closes the
  // keyboard.
  E.name.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (document.body.classList.contains('busy')) return; // already joining
    if (!E.invite.hidden) {
      sound.unlock();
      if (currentName()) app.join(E.inviteCode);
    } else if (CODE_RE.test(E.code.value)) joinCode(E.code.value);
    else {
      saveName();
      E.name.blur();
    }
  });
  E.code = h('input', {
    class: 'field field-code', type: 'text', maxLength: 4, placeholder: 'CODE', autocomplete: 'off', autocapitalize: 'characters',
    spellcheck: false, enterKeyHint: 'go', 'aria-label': 'Spelcode van vier letters',
  });
  E.code.addEventListener('input', () => {
    const v = E.code.value.toUpperCase().replace(/[^A-Z]/g, '').replace(/[IO]/g, '').slice(0, 4);
    if (E.code.value !== v) E.code.value = v;
    if (v.length === 4) joinCode(v);
  });
  E.code.addEventListener('keydown', e => { if (e.key === 'Enter') joinCode(E.code.value); });

  E.invite = h('div', { class: 'invite', hidden: true });
  E.main = h('div', { class: 'home-main' },
    h('button', { class: 'btn btn-hero', type: 'button', id: 'btn-quick', onclick: quick },
      h('span', { class: 'hero-ico', 'aria-hidden': 'true' }, icon('bolt')),
      h('span', { class: 'hero-txt' }, h('b', { text: 'Snel spelen' }), E.quickSub = h('small', { id: 'quick-sub' }))),
    h('div', { class: 'tiles' },
      h('button', { class: 'btn btn-tile', type: 'button', id: 'btn-new', onclick: openNewGame },
        icon('users'), h('b', { text: 'Nieuw spel' }), h('small', { text: 'Speel met vrienden' })),
      h('button', { class: 'btn btn-tile', type: 'button', id: 'btn-train', onclick: openTraining },
        icon('school'), h('b', { text: 'Oefenen' }), h('small', { text: 'Leren met tips' }))),
    h('div', { class: 'join' },
      h('label', { class: 'join-lbl', for: 'join-code' }, 'Meedoen met een code'),
      h('div', { class: 'join-row' }, E.code,
        h('button', { class: 'btn btn-join', type: 'button', onclick: () => joinCode(E.code.value) }, icon('enter'), 'Meedoen'))),
    h('button', { class: 'btn btn-link', type: 'button', id: 'btn-help', onclick: () => panels.openManual() }, icon('book'), 'Handleiding en spelregels'));
  E.code.id = 'join-code';
  showQuickSub();
  E.card = h('div', { class: 'home-card' },
    h('label', { class: 'name-lbl', for: 'name', text: 'Je naam' }), E.name, E.invite, E.main);
  root.querySelector('.home-inner').append(E.card,
    h('footer', { class: 'home-foot' },
      h('span', { text: 'Klaverjassen zoals in het café.' }),
      h('small', { class: 'home-ver', text: `Versie ${versionText(document.querySelector('meta[name="version"]')?.content)}`, onclick: versionTap })),
  );
  E.lobby = document.getElementById('lobby');
  buildLobby();
}

function saveName() {
  const v = E.name.value.replace(/\s+/g, ' ').trim().slice(0, 20);
  E.name.value = v;
  if (v) store.set('name', v);
  return v;
}

// The player's name, or '' after asking for it: for a game with friends,
// who will see it. The field takes the focus, with a word on why.
export function currentName() {
  const v = saveName();
  if (v) return v;
  E.name.focus();
  E.name.classList.add('ask');
  toast('Hoe heet je?', { sub: 'Vul je naam in, dan weten de anderen aan tafel wie je bent.' });
  return '';
}

// Snel spelen and Oefenen are with bots only: they never wait for a name.
// The one typed is used (and kept); without one the player is "Speler",
// which is not stored as their name.
function soloName() {
  return saveName() || DEFAULT_NAME;
}

export function show() {
  E.invite.hidden = true;
  E.main.hidden = false;
  E.name.enterKeyHint = 'done';
  showQuickSub();
  E.name.value = store.get('name', '') || E.name.value;
  setBusy(false);
  if (!E.name.value && matchMedia('(pointer: fine)').matches) setTimeout(() => E.name.focus(), 50);
}

// Join link without a stored name: ask only for the name. The keyboard's
// go key joins as well (see init).
export function showInvite(code) {
  E.main.hidden = true;
  E.invite.hidden = false;
  E.inviteCode = code;
  E.name.enterKeyHint = 'go';
  E.invite.replaceChildren(
    h('p', { class: 'invite-txt' }, 'Je bent uitgenodigd voor spel ', h('b', { class: 'code-inline', text: code })),
    h('button', { class: 'btn btn-hero', type: 'button', onclick: () => { if (currentName()) app.join(code); } },
      h('span', { class: 'hero-ico', 'aria-hidden': 'true' }, icon('enter')),
      h('span', { class: 'hero-txt' }, h('b', { text: 'Meedoen' }), h('small', { text: 'Vul je naam in en schuif aan' }))),
    h('button', { class: 'btn btn-link', type: 'button', onclick: () => { history.replaceState(history.state, '', '/'); show(); } }, 'Liever zelf een spel beginnen'));
  setTimeout(() => E.name.focus(), 50);
}

// Puts a code in the join field without joining (the field joins on
// input): a refused join that may work later is one tap on Meedoen.
export function setCode(code) {
  E.code.value = CODE_RE.test(code) ? code : '';
}

export function setBusy(on) {
  document.body.classList.toggle('busy', on);
  for (const b of E.card.querySelectorAll('button')) b.disabled = on;
}

function quick() {
  sound.unlock();
  sound.play('click');
  app.create({ opts: quickOpts(), start: true, name: soloName() });
}

function joinCode(v) {
  const code = (v || '').toUpperCase();
  if (!CODE_RE.test(code)) {
    toast('Een spelcode heeft vier letters', { kind: 'warn' });
    return;
  }
  sound.unlock();
  if (!currentName()) return;
  E.code.blur();
  app.join(code);
}

function openNewGame() {
  sound.unlock();
  sound.play('click');
  if (!currentName()) return; // friends will see it: ask before the options
  const opts = { ...DEFAULTS, ...store.json('opts', {}) };
  delete opts.open;
  const m = panels.openModal({
    id: 'new', title: 'Nieuw spel', cls: 'm-sheet m-new', body: [
      // A seed holds for this game only: a remembered one would deal the same cards forever.
      optionsForm(opts, (k, v) => { opts[k] = v; store.setJSON('opts', { ...opts, seed: undefined }); showQuickSub(); }),
      h('p', { class: 'sheet-note', text: 'Je krijgt een code en een link om te delen. Lege plaatsen worden aangevuld met AI-spelers.' }),
      h('div', { class: 'sheet-foot' }, h('button', { class: 'btn btn-go btn-big btn-block', type: 'button', id: 'btn-create', onclick: () => {
        if (!currentName()) { m.close(); return; }
        m.close(true);
        app.create({ opts, start: false });
      } }, 'Maak spel')),
    ],
  });
}

function openTraining() {
  sound.unlock();
  sound.play('click');
  // Speluitleg stays as last chosen: once the game is known, it is off.
  const opts = { open: false, lessons: store.get('lessons', '1') === '1', tempo: 'rustig', trumpMode: 'utrechts', rules: 'amsterdams' };
  const open = h('input', { type: 'checkbox', id: 'train-open', onchange: e => { opts.open = e.target.checked; } });
  const lessons = h('input', { type: 'checkbox', id: 'train-lessons', checked: opts.lessons, onchange: e => {
    opts.lessons = e.target.checked;
    store.set('lessons', opts.lessons ? '1' : '0');
  } });
  const m = panels.openModal({
    id: 'train', title: 'Oefenen met Juf Jannie', cls: 'm-sheet m-train', body: [
      h('div', { class: 'train-intro' },
        h('span', { class: 'avatar is-bot train-av', text: '👩‍🏫' }),
        h('p', { text: 'Je speelt samen met Juf Jannie tegen twee AI-spelers. Bij elke beurt krijg je een tip, en na elke slag legt ze uit wat er gebeurde.' })),
      h('label', { class: 'set-row' },
        h('span', { class: 'set-txt' }, h('b', { text: 'Speluitleg' }), h('small', { text: 'Juf Jannie legt het spel stap voor stap uit' })),
        h('span', { class: 'switch' }, lessons, h('i'))),
      h('label', { class: 'set-row' },
        h('span', { class: 'set-txt' }, h('b', { text: 'Open kaarten' }), h('small', { text: 'Zie de kaarten van alle spelers' })),
        h('span', { class: 'switch' }, open, h('i'))),
      optionsForm(opts, (k, v) => { opts[k] = v; }, ['trumpMode', 'rules', 'signals', 'tempo', 'seed']),
      h('div', { class: 'sheet-foot' }, h('button', { class: 'btn btn-go btn-big btn-block', type: 'button', id: 'btn-train-go', onclick: () => {
        m.close(true);
        app.create({ opts, training: true, start: true, name: soloName() });
      } }, 'Start oefenspel')),
    ],
  });
}

// ---------- expert ----------

// The expert mode (design §9 Expert) has no button: five quick taps on the
// version under the home screen open it.
const EGG_TAPS = 5;
const EGG_GAP_MS = 1500;
let taps = 0;
let tapAt = 0;

function versionTap() {
  const now = performance.now();
  taps = now - tapAt < EGG_GAP_MS ? taps + 1 : 1;
  tapAt = now;
  if (taps < EGG_TAPS) return;
  taps = 0;
  openExpert();
}

// A game alone against three bots with the cards of a seed: the whole
// match, or one hand of it (from). The choices stay on the device
// (kj.expert), the seed too.
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
      'De seed staat bij de start van elk spel in de chat, het nummer van een potje op het scorebord.',
    ])),
    numberField(opts.from, v => { opts.from = v; save(); showHands(); }, { max: 24, placeholder: 'Hele spel', label: 'Potje' })));
  showHands();
  const m = panels.openModal({
    id: 'expert', title: 'Expert', cls: 'm-sheet m-train', body: [
      h('p', { class: 'sheet-note', text: 'Speel een spel opnieuw met de seed, of één potje ervan, tegen drie AI-spelers. Tijdens en na het spel kijk je elk potje kaart voor kaart terug: bij elke kaart, troefkeuze of elk bod zie je de redenering van de AI, geef je je eigen keuze en schrijf je commentaar.' }),
      h('label', { class: 'set-row' },
        h('span', { class: 'set-txt' }, h('b', { text: 'Open kaarten' }), h('small', { text: 'Zie de kaarten van alle spelers' })),
        h('span', { class: 'switch' }, open, h('i'))),
      form,
      h('div', { class: 'sheet-foot' }, h('button', { class: 'btn btn-go btn-big btn-block', type: 'button', id: 'btn-expert-go', onclick: () => {
        m.close(true);
        app.create({ opts: { ...opts, players: 4 }, expert: true, start: true, name: soloName() });
      } }, 'Start expertspel')),
    ],
  });
}

// ---------- lobby ----------

function buildLobby() {
  E.lbTitle = h('h1', { class: 'lb-title', text: 'Klaarzetten' });
  const bar = h('header', { class: 'lobby-bar' },
    h('button', { class: 'tb tb-back', type: 'button', title: 'Tafel verlaten', 'aria-label': 'Tafel verlaten', onclick: () => app.leave() }, icon('back')),
    E.lbTitle, h('span', { class: 'spacer' }),
    ...panels.toolButtons(['chat', 'help', 'settings', 'sound']));
  E.lbCode = h('div', { class: 'code-big', 'aria-label': 'Spelcode' });
  E.lbCodeCard = h('section', { class: 'lb-card lb-code' },
    h('div', { class: 'lb-lbl', text: 'Spelcode' }), E.lbCode,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: copyLink }, icon('copy'), 'Kopieer link'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: shareLink }, icon('share'), 'Delen')),
    E.lbHint = h('p', { class: 'lb-hint' }));
  E.lbTable = h('div', { class: 'mini-table' }, h('div', { class: 'mini-felt' }));
  E.lbSeats = {};
  for (const pos of POS) E.lbTable.append(E.lbSeats[pos] = h('div', { class: 'lseat ls-' + pos }));
  E.lbCount = h('p', { class: 'lb-count' });
  E.lbCall = h('div', { class: 'call-dock lb-call', role: 'group', 'aria-label': 'Bellen', hidden: true });
  E.lbAv = [];
  E.lbOpts = h('section', { class: 'lb-card lb-opts' });
  E.lbFoot = h('div', { class: 'lobby-foot' });
  E.lobby.append(bar, h('div', { class: 'lobby-main' },
    h('div', { class: 'lb-col' }, E.lbCodeCard, h('section', { class: 'lb-card lb-seats' }, h('div', { class: 'lb-lbl', text: 'Aan tafel' }), E.lbTable, E.lbCount, E.lbCall)),
    h('div', { class: 'lb-col' }, E.lbOpts)), E.lbFoot);
}

const link = () => `${location.origin}/${app.code}`;

async function copyLink() {
  sound.play('click');
  if (await copyText(link())) {
    toast('Link gekopieerd', { sub: 'Plak hem in een appje naar je vrienden.' });
    return;
  }
  // The clipboard is off limits: show the link where it can be copied by hand.
  const field = h('input', { type: 'text', class: 'field link-field', readOnly: true, value: link(), 'aria-label': 'Link naar dit spel', onfocus: e => e.target.select() });
  panels.openModal({
    id: 'link', title: 'Kopieer de link', cls: 'm-info', body: [
      h('p', { text: 'Kopiëren lukte niet vanzelf. Selecteer de link en kopieer hem zelf, of geef de code door.' }),
      field,
    ],
  });
  setTimeout(() => { field.focus(); field.select(); }, 60);
}

async function shareLink() {
  sound.play('click');
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Klaverjas', text: `Kom je klaverjassen? Doe mee met code ${app.code}:`, url: link() });
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
  }
  copyLink();
}

let lastOptsKey = '';
let lobbyCode = '';  // the room the lobby was last shown for
let lobbyAt = 0;     // when it first showed (performance.now)
let armTimer = 0;

// fresh: the room just came (back) to the lobby, so the start guard runs
// again, as for a new room.
export function renderLobby(s, fresh = false) {
  const host = s.host === s.you;
  const hostName = s.players[s.host]?.name || 'de host';
  if (s.code !== lobbyCode || fresh) {
    lobbyCode = s.code;
    lobbyAt = performance.now();
  }
  E.lbTitle.textContent = host ? 'Klaarzetten' : 'Even wachten';
  E.lbCode.replaceChildren(...[...s.code].map(ch => h('span', { text: ch })));
  const n = seatCount(s);
  E.lbTable.dataset.players = n;
  for (const pos of POS) E.lbSeats[pos].hidden = true;
  E.lbAv = [];
  for (let seat = 0; seat < n; seat++) renderLobbySeat(s, seat, host);
  renderCall();
  const taken = s.players.filter(Boolean).length;
  const free = taken < n;
  const bots = s.players.some(p => p?.bot);
  const tip = host
    ? (free ? 'tik op een lege plaats voor een AI-speler' : bots ? 'tik op een AI-speler om te wisselen' : 'iedereen zit klaar')
    : (free ? 'tik op een lege plaats om daar te gaan zitten' : 'de tafel is vol');
  E.lbCount.textContent = `${taken} van de ${n} plaatsen bezet · ${tip}`;
  E.lbHint.textContent = codeHint(s, host, free, bots);

  const key = JSON.stringify([s.opts, host]);
  if (key !== lastOptsKey) {
    lastOptsKey = key;
    if (host) {
      // The next new game starts from what the room has: a change the
      // server refused (more people than seats) is not remembered.
      const { players, hands, trumpMode, rules, ai, tempo, signals } = s.opts;
      store.setJSON('opts', { ...store.json('opts', {}), players, hands, trumpMode, rules, ai, tempo, signals });
      E.lbOpts.replaceChildren(h('div', { class: 'lb-lbl', text: 'Spelregels' }),
        optionsForm(s.opts, (k, v) => app.send({ t: 'opts', opts: { [k]: v } })));
    } else {
      E.lbOpts.replaceChildren(h('div', { class: 'lb-lbl', text: 'Spelregels' }),
        h('div', { class: 'chips' }, optsSummary(s.opts).map(t => h('span', { class: 'chip', text: t }))),
        h('p', { class: 'lb-hint', text: `${hostName} bepaalt de spelregels.` }));
    }
  }
  const empty = s.players.filter(p => !p).length;
  const guard = Math.max(0, START_GUARD_MS - (performance.now() - lobbyAt));
  E.lbFoot.replaceChildren(host
    ? h('button', {
      class: 'btn btn-go btn-big btn-start', type: 'button', id: 'btn-start', disabled: guard > 0,
      onclick: e => {
        if (performance.now() - lobbyAt < START_GUARD_MS) return;
        e.currentTarget.disabled = true;
        sound.play('click');
        app.send({ t: 'start' });
      },
    }, icon('play'), h('span', {}, h('b', { text: 'Start spel' }), h('small', { text: empty ? `${empty === 1 ? 'De lege plaats krijgt' : 'Lege plaatsen krijgen'} een AI-speler` : 'Iedereen zit klaar' })))
    : h('div', { class: 'lb-wait' }, h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), ` Wachten tot ${hostName} het spel start`));
  if (guard > 0) {
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      const b = document.getElementById('btn-start');
      if (b) b.disabled = false;
    }, guard + 20);
  }
}

// Under the code: who can still join. A friend who opens the link of a
// full table is turned away, so say so, and how the host makes room.
function codeHint(s, host, free, bots) {
  if (free) return 'Stuur de link of de code naar wie mee wil doen.';
  if (!host) return 'Alle plaatsen zijn bezet.';
  if (bots) return 'Alle plaatsen zijn bezet. Haal een AI-speler weg als er nog iemand mee wil doen.';
  if (seatCount(s) < 4) return 'Alle plaatsen zijn bezet. Zet Spelers hoger als er nog iemand mee wil doen.';
  return 'Alle vier de plaatsen zijn bezet.';
}

function renderLobbySeat(s, seat, host) {
  const pos = posOf(s, seat);
  const el = E.lbSeats[pos];
  const p = s.players[seat];
  const me = seat === s.you;
  el.hidden = false;
  el.className = `lseat ls-${pos} ${teamCls(s, seat)}` + (p ? '' : ' empty') + (me ? ' me' : '') + (p?.bot ? ' bot' : '');
  const role = me ? 'jij' : isWij(s, seat) ? 'maat' : 'tegenstander';
  const tag = [p && !p.bot && !p.connected ? 'weg' : role, seat === s.host ? 'host' : ''].filter(Boolean).join(' · ');
  const kids = [];
  if (p) {
    kids.push(h('button', {
      class: 'ls-main', type: 'button', disabled: !(host && p.bot),
      title: host && p.bot ? 'Tik om een andere AI-speler te kiezen' : p.name,
      onclick: host && p.bot ? () => panels.openBotPicker(seat, s) : null,
    }, E.lbAv[seat] = avatar(p), playerName(p.name, { cls: 'ls-name' }), h('span', { class: 'ls-tag', text: tag })));
    if (host && p.bot) kids.push(h('button', { class: 'ls-x', type: 'button', title: 'AI-speler weghalen', 'aria-label': `${p.name} weghalen`, onclick: () => { sound.play('click'); app.send({ t: 'unbot', seat }); } }, icon('close')));
  } else {
    kids.push(h('button', {
      class: 'ls-main', type: 'button',
      title: host ? 'AI-speler neerzetten of zelf hier gaan zitten' : 'Hier gaan zitten',
      onclick: () => { if (host) panels.openBotPicker(seat, s, { canSit: true }); else { sound.play('click'); app.send({ t: 'sit', seat }); } },
    }, h('span', { class: 'avatar empty-av' }, icon('plus')), h('span', { class: 'ls-name', text: host ? 'AI-speler' : 'Hier zitten' }), h('span', { class: 'ls-tag', text: isWij(s, seat) ? 'maat · vrij' : 'vrij' })));
  }
  el.replaceChildren(...kids);
}

// The call, once call.js is loaded: videos in place of the faces, who is
// in the call, and the call buttons under the table.
export function renderCall() {
  if (!app.call) return;
  app.call.dock(E.lbCall);
  E.lbAv.forEach((av, seat) => av && app.call.decorate(av, seat));
}

export function resetLobby() {
  lastOptsKey = '';
  clear(E.lbOpts);
}
