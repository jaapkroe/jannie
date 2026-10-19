// Home screen (name, quick play, new game, join, training), the join-link
// invite, and the lobby where seats and options are arranged.
import { sound } from './sound.js';
import { app, h, clear, icon, store, toast, POS, posOf, isWij, teamCls, avatar, variantText, copyText, anim } from './util.js';
import * as panels from './panels.js';

const E = {};
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;
const DEFAULTS = { humans: 4, hands: 16, trumpMode: 'utrechts', rules: 'amsterdams', ai: 'normaal', tempo: 'normaal' };

// Option rows shared by the new-game sheet and the lobby.
const OPTS = [
  { key: 'humans', label: 'Spelers', choices: [[1, '1'], [2, '2'], [3, '3'], [4, '4']],
    info: ['Hoeveel mensen er mee kunnen spelen, jij meegerekend.', 'Plaatsen zonder mens krijgen een AI-speler. Met z\'n tweeën zitten jullie tegenover elkaar, als maten.'] },
  { key: 'hands', label: 'Potjes', choices: [[4, '4'], [8, '8'], [12, '12'], [16, '16'], [20, '20'], [24, '24']],
    info: ['Hoeveel potjes (handen) het spel duurt. Zestien potjes heet een boompje.', 'Wie na het laatste potje de meeste punten heeft, wint.'] },
  { key: 'trumpMode', label: 'Troef', choices: [['utrechts', 'Utrechts'], ['gedraaid', 'Gedraaid']],
    info: ['Utrechts (verplicht): de voorhand moet troef kiezen en speelt.', 'Gedraaid (vrij): er wordt een kleur gedraaid. Om de beurt zeg je spelen of passen. Past iedereen, dan kiest de voorhand een andere kleur.'] },
  { key: 'rules', label: 'Regels', choices: [['amsterdams', 'Amsterdams'], ['rotterdams', 'Rotterdams']],
    info: ['Amsterdams: kun je niet bekennen en heeft je maat de slag, dan hoef je niet te troeven.', 'Rotterdams: kun je niet bekennen, dan moet je altijd troeven (en overtroeven als het kan).'] },
  { key: 'ai', label: 'AI-sterkte', choices: [['makkelijk', 'Makkelijk'], ['normaal', 'Normaal'], ['sterk', 'Sterk']],
    info: ['Makkelijk: speelt los en maakt fouten.', 'Normaal: speelt degelijk volgens de vuistregels.', 'Sterk: telt kaarten, rekent kansen door en kent de seinen.'] },
  { key: 'tempo', label: 'Tempo', choices: [['rustig', 'Rustig'], ['normaal', 'Normaal'], ['snel', 'Snel']],
    info: 'Hoe snel de AI-spelers spelen en hoe lang de pauzes tussen de slagen duren.' },
];

const LABELS = Object.fromEntries(OPTS.map(o => [o.key, Object.fromEntries(o.choices)]));

function optionsForm(opts, onChange, keys = OPTS.map(o => o.key)) {
  return h('div', { class: 'opts' }, OPTS.filter(o => keys.includes(o.key)).map(o =>
    h('div', { class: 'opt-row' },
      h('div', { class: 'opt-lbl' }, h('span', { text: o.label }), panels.infoBtn(o.label, o.info)),
      panels.segmented(o.choices, opts[o.key] ?? DEFAULTS[o.key], v => onChange(o.key, v), o.label))));
}

function optsSummary(o) {
  return [`${o.hands} potjes`, variantText(o), `AI ${LABELS.ai[o.ai]?.toLowerCase() || o.ai}`, `tempo ${LABELS.tempo[o.tempo]?.toLowerCase() || o.tempo}`];
}

// ---------- home ----------

export function init() {
  const root = document.getElementById('home');
  E.name = h('input', {
    id: 'name', class: 'field field-name', type: 'text', maxLength: 20, placeholder: 'Hoe heet je?', autocomplete: 'nickname',
    autocapitalize: 'words', spellcheck: false, enterKeyHint: 'done', value: store.get('name', ''), 'aria-label': 'Je naam',
  });
  E.name.addEventListener('change', saveName);
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
      h('span', { class: 'hero-txt' }, h('b', { text: 'Snel spelen' }), h('small', { text: 'Meteen aan tafel met drie AI-spelers' }))),
    h('div', { class: 'tiles' },
      h('button', { class: 'btn btn-tile', type: 'button', id: 'btn-new', onclick: openNewGame },
        icon('users'), h('b', { text: 'Nieuw spel' }), h('small', { text: 'Speel met vrienden' })),
      h('button', { class: 'btn btn-tile', type: 'button', id: 'btn-train', onclick: openTraining },
        icon('school'), h('b', { text: 'Oefenen' }), h('small', { text: 'Leer het spel met tips' }))),
    h('div', { class: 'join' },
      h('label', { class: 'join-lbl', for: 'join-code' }, 'Meedoen met een code'),
      h('div', { class: 'join-row' }, E.code,
        h('button', { class: 'btn btn-join', type: 'button', onclick: () => joinCode(E.code.value) }, icon('enter'), 'Meedoen'))),
    h('button', { class: 'btn btn-link', type: 'button', id: 'btn-help', onclick: () => panels.openManual() }, icon('book'), 'Handleiding en spelregels'));
  E.code.id = 'join-code';
  E.card = h('div', { class: 'home-card' },
    h('label', { class: 'name-lbl', for: 'name', text: 'Je naam' }), E.name, E.invite, E.main);
  root.querySelector('.home-inner').append(E.card,
    h('footer', { class: 'home-foot' },
      h('span', { text: 'Klaverjassen zoals in het café: Utrechts of gedraaid, Amsterdams of Rotterdams.' })),
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

// The player's name, or '' after nudging them to fill it in.
export function currentName() {
  const v = saveName();
  if (v) return v;
  E.name.focus();
  anim(E.name, [{ translate: '0 0' }, { translate: '-6px 0' }, { translate: '6px 0' }, { translate: '0 0' }], 300);
  toast('Vul eerst je naam in', { kind: 'warn' });
  return '';
}

export function show() {
  E.invite.hidden = true;
  E.main.hidden = false;
  E.name.value = store.get('name', '') || E.name.value;
  setBusy(false);
  if (!E.name.value && matchMedia('(pointer: fine)').matches) setTimeout(() => E.name.focus(), 50);
}

// Join link without a stored name: ask only for the name.
export function showInvite(code) {
  E.main.hidden = true;
  E.invite.hidden = false;
  E.invite.replaceChildren(
    h('p', { class: 'invite-txt' }, 'Je bent uitgenodigd voor spel ', h('b', { class: 'code-inline', text: code })),
    h('button', { class: 'btn btn-hero', type: 'button', onclick: () => { if (currentName()) app.join(code); } },
      h('span', { class: 'hero-ico', 'aria-hidden': 'true' }, icon('enter')),
      h('span', { class: 'hero-txt' }, h('b', { text: 'Meedoen' }), h('small', { text: 'Vul je naam in en schuif aan' }))),
    h('button', { class: 'btn btn-link', type: 'button', onclick: () => { history.replaceState(null, '', '/'); show(); } }, 'Liever zelf een spel beginnen'));
  setTimeout(() => E.name.focus(), 50);
}

export function setBusy(on) {
  document.body.classList.toggle('busy', on);
  for (const b of E.card.querySelectorAll('button')) b.disabled = on;
}

function quick() {
  sound.unlock();
  sound.play('click');
  if (!currentName()) return;
  app.create({ opts: { humans: 1 }, start: true });
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
  const opts = { ...DEFAULTS, ...store.json('opts', {}) };
  delete opts.open;
  const m = panels.openModal({
    id: 'new', title: 'Nieuw spel', cls: 'm-sheet m-new', body: [
      optionsForm(opts, (k, v) => { opts[k] = v; store.setJSON('opts', opts); }),
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
  const opts = { open: false, tempo: 'rustig', trumpMode: 'utrechts', rules: 'amsterdams' };
  const open = h('input', { type: 'checkbox', onchange: e => { opts.open = e.target.checked; } });
  const m = panels.openModal({
    id: 'train', title: 'Oefenen met Juf Ans', cls: 'm-sheet m-train', body: [
      h('div', { class: 'train-intro' },
        h('span', { class: 'avatar is-bot train-av', text: '👩‍🏫' }),
        h('p', { text: 'Je speelt samen met Juf Ans tegen twee AI-spelers. Bij elke beurt krijg je een tip, en na elke slag legt ze uit wat er gebeurde.' })),
      h('label', { class: 'set-row' },
        h('span', { class: 'set-txt' }, h('b', { text: 'Open kaarten' }), h('small', { text: 'Zie de kaarten van alle spelers' })),
        h('span', { class: 'switch' }, open, h('i'))),
      optionsForm(opts, (k, v) => { opts[k] = v; }, ['trumpMode', 'rules', 'tempo']),
      h('div', { class: 'sheet-foot' }, h('button', { class: 'btn btn-go btn-big btn-block', type: 'button', id: 'btn-train-go', onclick: () => {
        if (!currentName()) { m.close(); return; }
        m.close(true);
        app.create({ opts, training: true, start: true });
      } }, 'Start oefenspel')),
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
    h('p', { class: 'lb-hint', text: 'Stuur de link of de code naar wie mee wil doen.' }));
  E.lbTable = h('div', { class: 'mini-table' }, h('div', { class: 'mini-felt' }));
  E.lbSeats = {};
  for (const pos of POS) E.lbTable.append(E.lbSeats[pos] = h('div', { class: 'lseat ls-' + pos }));
  E.lbCount = h('p', { class: 'lb-count' });
  E.lbOpts = h('section', { class: 'lb-card lb-opts' });
  E.lbFoot = h('div', { class: 'lobby-foot' });
  E.lobby.append(bar, h('div', { class: 'lobby-main' },
    h('div', { class: 'lb-col' }, E.lbCodeCard, h('section', { class: 'lb-card lb-seats' }, h('div', { class: 'lb-lbl', text: 'Aan tafel' }), E.lbTable, E.lbCount)),
    h('div', { class: 'lb-col' }, E.lbOpts)), E.lbFoot);
}

const link = () => `${location.origin}/${app.code}`;

async function copyLink() {
  sound.play('click');
  toast(await copyText(link()) ? 'Link gekopieerd' : `Kopiëren lukte niet: ${link()}`, { sub: 'Plak hem in een appje naar je vrienden.' });
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

export function renderLobby(s) {
  const host = s.host === s.you;
  const hostName = s.players[s.host]?.name || 'de host';
  E.lbTitle.textContent = host ? 'Klaarzetten' : 'Even wachten';
  E.lbCode.replaceChildren(...[...s.code].map(ch => h('span', { text: ch })));
  for (let seat = 0; seat < 4; seat++) renderLobbySeat(s, seat, host);
  const humans = s.players.filter(p => p && !p.bot).length;
  const free = s.players.some(p => !p);
  const tip = host
    ? (free ? 'tik op een lege plaats voor een AI-speler' : 'tik op een AI-speler om te wisselen')
    : (free ? 'tik op een lege plaats om daar te gaan zitten' : 'de tafel is vol');
  E.lbCount.textContent = `${humans} van ${s.opts.humans} ${s.opts.humans === 1 ? 'mens' : 'mensen'} · ${tip}`;

  const key = JSON.stringify([s.opts, host]);
  if (key !== lastOptsKey) {
    lastOptsKey = key;
    if (host) {
      E.lbOpts.replaceChildren(h('div', { class: 'lb-lbl', text: 'Spelregels' }),
        optionsForm(s.opts, (k, v) => { app.send({ t: 'opts', opts: { [k]: v } }); store.setJSON('opts', { ...store.json('opts', {}), [k]: v }); }));
    } else {
      E.lbOpts.replaceChildren(h('div', { class: 'lb-lbl', text: 'Spelregels' }),
        h('div', { class: 'chips' }, optsSummary(s.opts).map(t => h('span', { class: 'chip', text: t }))),
        h('p', { class: 'lb-hint', text: `${hostName} bepaalt de spelregels.` }));
    }
  }
  const empty = s.players.filter(p => !p).length;
  E.lbFoot.replaceChildren(host
    ? h('button', { class: 'btn btn-go btn-big btn-start', type: 'button', id: 'btn-start', onclick: e => { e.currentTarget.disabled = true; sound.play('click'); app.send({ t: 'start' }); } },
      icon('play'), h('span', {}, h('b', { text: 'Start spel' }), h('small', { text: empty ? `${empty === 1 ? 'De lege plaats krijgt' : 'Lege plaatsen krijgen'} een AI-speler` : 'Iedereen zit klaar' })))
    : h('div', { class: 'lb-wait' }, h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), ` Wachten tot ${hostName} het spel start`));
}

function renderLobbySeat(s, seat, host) {
  const pos = posOf(seat, s.you);
  const el = E.lbSeats[pos];
  const p = s.players[seat];
  const me = seat === s.you;
  el.className = `lseat ls-${pos} ${teamCls(s, seat)}` + (p ? '' : ' empty') + (me ? ' me' : '') + (p?.bot ? ' bot' : '');
  const role = me ? 'jij' : isWij(s, seat) ? 'maat' : 'tegenstander';
  const tag = [p && !p.bot && !p.connected ? 'weg' : role, seat === s.host ? 'host' : ''].filter(Boolean).join(' · ');
  const kids = [];
  if (p) {
    kids.push(h('button', {
      class: 'ls-main', type: 'button', disabled: !(host && p.bot),
      title: host && p.bot ? 'Tik om een andere AI-speler te kiezen' : p.name,
      onclick: host && p.bot ? () => panels.openBotPicker(seat, s) : null,
    }, avatar(p), h('span', { class: 'ls-name', text: p.name }), h('span', { class: 'ls-tag', text: tag })));
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

export function resetLobby() {
  lastOptsKey = '';
  clear(E.lbOpts);
}
