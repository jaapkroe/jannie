# The web shell

`platform/web` is the shell every game's site is built from: routing, the
websocket and the update queue, the home screen and the lobby, panels,
settings, chat, calling, sounds and card faces. A game brings its page,
icons, table and styles in `games/<game>/web` and plugs in through its
`game.js` ("One site per game" below). What the table sends is in
[protocol.md](protocol.md).

## Rules

Vanilla ES modules, no framework, no build step, no inline `<script>`/`<style>`
and no `style="…"` attributes or `setAttribute('style')` (CSP `style-src
'self'`; setting `el.style.x` from JS is fine). Build DOM with
`document.createElement`/`textContent`; never `innerHTML` with user or server
text. The site is the union of `platform/web` (the shell every game's site
uses) and `games/<game>/web` (the game's page, icons, modules and styles); a
path in both is an error (see "One site per game" below).
No service worker. System font stack.

## Request budget

At most 17 requests per page load in total, the websocket included: 5
fixed (html, favicon, manifest, one PNG icon for Chrome's install check,
the websocket), the shell's 6 modules (main.js with the websocket, util,
panels, home, sound, cards) and 2 stylesheets (app.css, cards.css), and at
most 3 page-load modules and 1 stylesheet of the game. Every other module
is imported when first needed: the shell's `call.js` once another person
sits at the table, and a game's own extras (klaverjas's handleiding
`manual.js` and `expert.js`, toepen's score sheet), so a page load never
fetches them.
`test/sites.test.mjs` counts it from index.html and the static imports.
Each game lists its own
([games/klaverjas/README.md, "Page load"](../games/klaverjas/README.md#page-load);
[games/toepen/README.md, "The site"](../games/toepen/README.md#the-site)).
The budget is what the reverse proxy's rate limit for the site must let
through ([deployment.md, "Reverse proxy"](deployment.md#reverse-proxy)).

## Stylesheets

Every site links the shell's two stylesheets and one of its own:
`app.css` (the tokens, layout, home, lobby, table chrome, seats, overlays
and chat), `cards.css` (the card faces, with `cards.js`) and the game's,
with its table and overlays. The order in each `index.html`:

- klaverjas: `app.css`, `klaverjas.css`, `cards.css`. `klaverjas.css`
  comes before `cards.css`, so a card's state there (`.card.selected`,
  `.card.disabled`) keeps winning its ties with rules of the same weight in
  `klaverjas.css` (`.hand > .card`, `.pile > .card`). The manual's styles
  (classes `man-…`) are the last section of `klaverjas.css`.
- toepen: `app.css`, `cards.css`, `toepen.css`; what `toepen.css` sets on
  `:root` gives the site its own colours.

The shell's colour tokens (`--bg`, `--felt-1..3`, …) are klaverjas's green
felt; toepen's blue overrides them. What of klaverjas is still in `app.css`
is in [architecture.md, "What is not generic yet"](architecture.md#what-is-not-generic-yet).

## Storage

`localStorage` access wrapped in try/catch (keys prefixed `kj.`, on every
site). Without `localStorage` the name and seat tokens live in memory for
the life of the page.

## Icons

`favicon.svg` (tab; manifest `any`), `icon-192.png` and `icon-512.png`
(manifest `any`, rendered from favicon.svg), and from the full-bleed
`icon-full.svg` (felt to every edge, artwork inside the central 80% circle)
the opaque `apple-touch-icon.png` (180 px; iOS fills transparency black and
also asks for this path by itself) and `icon-maskable-512.png` (manifest
`maskable`). The PNGs are rendered once with `rsvg-convert` (commands in
icon-full.svg) and committed; `test/ui/app-icons.test.mjs` checks them.

## Link preview

`index.html` has Open Graph tags (`og:title`, `og:description`,
`og:image` and its size and alt text, `og:locale` `nl_NL`; no `og:url`, since
the same file serves `/` and every `/ABCD`). `og:image` must be absolute:
the file says `https://@SITE@/og.png` and the web image build fills in the
host name (the dev server keeps the placeholder). `og.png` is an opaque
1200×630 PNG under 300 KB (WhatsApp skips larger ones) of the felt, the
clover and a fan of real card faces, rendered by `test/ui/og-image.mjs` and
committed. Browsers never fetch it, so the request budget is unchanged.
WhatsApp and iMessage build the preview on the sender's phone; iMessage's
fetcher calls itself `facebookexternalhit`. Server-side previewers
(Telegram, Slack, Discord) fetch from datacenter addresses. A bot filter or
firewall in front of the site that refuses these leaves the bare link
([deployment.md, "Reverse proxy"](deployment.md#reverse-proxy)).

## One site per game

Every game has a site of its own (`klaverjas.kroes.dev`, `toepen.kroes.dev`;
[architecture.md, "One site per game"](architecture.md#one-site-per-game)),
built from the same shell:

- `platform/web/js`: `main.js` (routing, the websocket, the update queue),
  `util.js`, `panels.js` (modals, back button, settings, bot picker, menu,
  feedback, chat), `home.js` (home, invite, lobby), `sound.js`, `cards.js`,
  `call.js` (lazy); `platform/web/css`: `app.css`, `cards.css`.
- `games/<game>/web`: `index.html`, `manifest.webmanifest`, `favicon.svg`,
  `icon-full.svg`, the PNG icons, `og.png`, and `js/game.js`, the game
  module, with the game's other modules and its stylesheet.
- The shell reaches the game only through `main.js` importing `./game.js`;
  `home.js` and `panels.js` get it at boot (`home.init(game)`,
  `panels.useGame(game)`). `game.js` has no side effects on import.
- Nothing a player sees on one site names another game
  (`test/sites.test.mjs`, below). The look of a site comes from its
  stylesheet ("Stylesheets" above).

`test/sites.test.mjs` checks every site: the two trees share no path, the
budget holds and every module main.js imports is preloaded, a module those
import when first needed is on the site, the shell imports no game module,
and nothing a player sees names another game.

### The game module

```js
// games/<game>/web/js/game.js — what the shell needs from the game of the site
export const name;          // 'Klaverjas': titles ("Klaverjas · ABCD"), the share title
export const maxPlayers;    // the largest table: the lobby's hints, the refused-join toast
export const PLAYING;       // Set of phases in which a turn may be the player's (sound and title cues)
export const ACKED;         // Set of moves the server answers at once (silence: a dead socket)
export const table;         // the table module: init, render(s), animate(ev, prev, next), settle, welcomeBack,
                            //   bubble(s, seat, text), staleVote(m), resync, resetRoom, relayout, renderCall
export const TOOLS;         // the game's top-bar tools for panels.toolButtons, as the shell's:
                            //   name: [icon, label, title, fn, {hidden}?]
export const menuTitle, menu;  // the menu button's tooltip; menu(item) → the game's menu items, before the shell's
export const soundSub, chatQuick, chatCls;  // settings line under Geluidseffecten; quick chat lines; a sender's colour
export const sync, onError, onReconnect;    // after every update; on a refusal; on a new connection (all optional)
export const messages, queued;  // the game's own server messages: handled at once, or after the animations before them
export const home;          // options (rows: key, label, choices, info, players?, input?, multi + value?), defaults,
                            //   quickOpts(), quickSub(), summary(o), remember(o), tiles()?, help {label, open},
                            //   egg?, footer, support, shareText(code), route(params)? (a link of its own)
export const lobby;         // seats(miniTable) → its seat slots; slot(s, seat) → {el, cls, role, free}
```

## Shared modules

```js
// platform/web/js/cards.js — card faces and backs (with platform/web/css/cards.css)
export const SUITS = { C:{name:'klaveren',symbol:'♣',color:'black'}, D:{name:'ruiten',symbol:'♦',color:'red'},
                       H:{name:'harten',symbol:'♥',color:'red'}, S:{name:'schoppen',symbol:'♠',color:'black'} };
export const RANKS = { '7':'7','8':'8','9':'9','T':'10','J':'B','Q':'V','K':'H','A':'A' };  // face letters
export function cardName(code)            // "harten boer"
export function cardShort(code)           // "♥B"
export function createCard(code, opts={}) // → HTMLElement .card; opts: {size:'sm'|'md'|'lg'} (default md);
                                          //   dataset.card = code; aria-label = cardName
export function createBack(opts={})       // → HTMLElement .card.back
// Card size scales with the CSS custom property --card-w on any ancestor (height = 1.4 × width).
// Four-colour deck when an ancestor has class .four-color (♣ green, ♦ blue/orange). In the
//   two-colour deck the courts of ♣ and ♦ wear those inks on a garment (tunic, bodice, doublet
//   and beret), so the courts of every suit look different; the spade (needle point over low,
//   wide lobes, broad foot) and the club (three wide-set round lobes, slim stem) stay apart
//   as small or distant blurs.
// Extras: parseCard(code) → {rank,suit}|null; suitIcon(suit, {colored}) → <svg.suit-icon> (1em);
//   createBack({size, color:'blue'|'red'}). State classes: .legal .selected (lifted) .disabled
//   .hint (pulsing glow) .winner (gold ring) .selectable (hover/press only); they use the
//   individual `translate`/`scale` properties, so layout may use `transform`. Every face, at any
//   size, shows its picture (pips, ace medallion, court figure) and the index (rank over suit) in
//   the top-left and, turned, the bottom-right corner; the boer's B has a square-cornered stem.
//   Below 60, 40 and 30 px wide the index grows to 1.25, 1.4 and 1.6 times its regular size and
//   the picture shrinks to keep clear of it. --card-index-max on an ancestor caps that growth
//   where cards overlap at their corners or show only a strip (the trick: 1, the regular index).
//   The scale a face shows is --_index on its .card-svg, a registered <number> that an
//   animation may tween (a flight from a hand to the trick does).

// platform/web/js/sound.js — synthesised with WebAudio, no audio files
export const sound = {
  unlock(),            // call on the first user gesture (also self-armed on any gesture); Promise, never rejects
  play(name),          // 'card','knock','deal','shuffle','trick','trickWon','roem','trump','turn','chat',
                       // 'nat','pit','handWon','handLost','win','lose','click','error','join'
  setMuted(bool), isMuted(), setVolume(0..1), getVolume()   // persisted in localStorage kj.sound
  setCall(bool),       // call.js holds the iOS audio session ('play-and-record', else 'ambient')
};
// The context sleeps (suspend) 30 s after the last sound, or 0.4 s after muting, so the device can
//   stop its audio output; the next play() wakes it without a gesture, a tap or a key does not.
//   It does not fall asleep while call.js holds the session (setCall(true) until setCall(false)),
//   which keeps the audio output busy anyway; one already asleep wakes at the next sound.
//   setCall(false) starts the wait again.
```

The palette serves every game: `roem`, `nat` and `pit` are klaverjas's,
`knock` (a toep) toepen's.

## Shared screens

These screens are the shell's, the same on every site, built for as few
clicks as possible; what a game adds to them is in its README.

### Home

Name field (remembered), and big buttons: *Snel spelen*
(one tap: solo vs bots, starts immediately, straight from home to the table
without showing the lobby; it uses the options last chosen for a new game,
the number of players included, named under the button when they differ
from the defaults: "Twee AI-spelers · 8 potjes"; "AI-spelers" never breaks
at its hyphen), *Nieuw spel*
(options sheet with defaults → *Maak spel*; rows that do not apply to the
number of players hide), *Meedoen* (4-letter code field;
joins as soon as 4 letters are typed), the game's own tiles (klaverjas:
*Oefenen*; toepen: *Score bijhouden*) and its help (*Handleiding en
spelregels*, *Spelregels en bediening*). Snel spelen and a game's tiles for play with
bots only never ask for a name: without one the
player is "Speler", which is not stored as their name. Under the footer,
small: "Versie a05a087", the commit the web image was built from (the
Containerfile fills in index.html's `<meta name="version">`; `versionText`
shortens it, "dev" when run from source; `pod-check` compares it with
`/api/health`). Five quick taps on the version (each within 1.5 s of the
last) open the game's hidden extra (`game.home.egg`; klaverjas's and
toepen's expert mode): the only way in, and not named anywhere (in short
landscape the footer, and so the line, is hidden). Beside it, *Support
deze app* with a hand: a short sheet on why (free and without ads, a
contribution pays for the server and the development) and the button
*Bijdragen met iDEAL*, the site's payment link in a new tab. The link is
the deployment's `SUPPORT_URL`
([deployment.md, "SUPPORT_URL"](deployment.md#support_url)), which the
Containerfile fills into index.html's `<meta name="support">`; `supportURL`
(util.js) takes it only as an `https://` URL. Without one there is no
button: a server from source has none, nor a fork that sets none, nor an
app sold through an app store, which may not point to a payment outside
the store.

*Nieuw spel* and
*Meedoen*, where others see the name, ask for it first, gently: the name
field takes the focus with a soft glow and a toast "Hoe heet je?" says why.
Opening a join link `/ABCD` goes straight to joining (asks only for a name if
none is stored and the browser holds no seat token for that room, so a
reload in a game without a name goes back to the seat). Enter (the keyboard's go key) in the name field joins that
invite, or the code typed before the name was asked for.

### Lobby

Big code + *Kopieer link* + *Delen* (`navigator.share` where
available; when copying fails the link is shown in a field to copy by hand);
a mini table with the seats of `players` around it, placed by the game
(`game.lobby.seats`), "2 van de 4 plaatsen bezet"; tap an empty seat to
sit there; host taps an empty seat to add a bot (choose a character or random),
✕ to remove one; host edits options; *Start* (ignores taps for 0.8 s after
the lobby first shows, so a double tap on *Maak spel* cannot start the game
before friends can join). The hint under the code says when every seat is
taken, and how the host makes room (a bot away, or "Zet Spelers hoger als
er nog iemand mee wil doen."). A `refused` gives the host a toast "… wil
meedoen, maar de tafel is vol" with what to do (a bot away, *Zet Spelers
op 3*; after game over *Spelers of regels wijzigen*). A joiner turned away with `vol` or `gestart` lands on home with
the code back in the *Meedoen* field, so trying again is one tap.

### Player names

Where a name must shorten (lobby seat, score bar, *Laatste slag*), only the
name does: its "(AI)" stays readable ("Kees de Vi… (AI)").

### Someone gone

The takeover question of [server.md, "Takeover consent"](server.md#takeover-consent),
as every game's table shows it (klaverjas's `table.js`; toepen's follows
it, with the same messages).

A seat says *verbinding weg* while its player is
disconnected, *vertrokken* once they left (the name stays until a joiner
or an AI takes the seat) and *AI speelt even mee* while an AI plays for
them (`away`); on a narrow side seat the status wraps inside its plate.
While `takeover` is set, everyone asked (connected, so never the one it
is about) sees the question in the centre stage, instead of the waiting
text, in a panel like the trump and bid panels: "Anna is weg" with "Het
spel wacht op Anna. Mag een AI-speler zolang voor Anna spelen?", or for a
seat left "Anna is vertrokken" with "Mag een AI-speler de plaats van Anna
innemen? Jullie kunnen ook wachten tot iemand anders met de code
aanschuift." ("Je kunt ook wachten …" when you are the only one asked);
then "Iedereen moet akkoord zijn:" with a chip for everyone asked (you
first, then anyone whose no still holds after a drop-out): *akkoord*,
*wil wachten*, or three thinking dots ("nog niet gekozen" for screen
readers) for no answer yet; with you the only one asked, rule and chips
are left out. Last *AI laten spelen* and *Wachten* (`vote`, with the
question's `seat` and `left`), the answer given marked (tick, a dark ring
inside the button, `aria-pressed`; the other one duller but readable)
and open to change. Once you answered, the question text steps out of
sight (still read with the buttons), so the panel covers less of the
table while the others think. The panel is a `group` named by its title
and described by the question; a polite live region says the question
when it opens. It opens with the turn sound and buzz, and on fine
pointers focuses *AI laten spelen*; answers change in place, so the focus
stays. While it is open the stage also takes the prompt row, whose "…
is aan de beurt" steps aside (the panel says it), and the panel sits as
low as it goes, just above the hand, so the trick and the side seats
stay in view (on phones your own seat and the last-trick button are
under it meanwhile). The answers come last, so they stay put when what
is above them changes (the question stepping aside, chips getting longer
as people answer). On phones upright it is compact; in short landscape
title, question and chips go beside the answers. `app-checks.mjs --only
takeover` checks what stays in view at each size.
A vote refused as too late (the question closed as you answered) passes
without the error sound and toast. Toasts: "Anna is even weg" (`away`),
"Anna is vertrokken" (mid-game with "Een AI-speler neemt de plaats pas in
als iedereen akkoord is."), "Anna is terug", "Anna doet weer mee" (a
joiner with the name of who left that seat), and for `takeover` "Een
AI-speler speelt nu voor Anna" or "Opa Dirk (AI) neemt het over". Back
after an AI played for you (a decision for your seat you did not send),
you get "Een AI-speler speelde even voor je". *Spel verlaten?* says
mid-game "De anderen beslissen samen of een AI-speler je plaats inneemt."
("Je verlaat de tafel." with nobody else to ask). `app-checks.mjs --only
takeover` plays it through, also on the mock.

### Back button

Every closable overlay (dialog, chat drawer) has a history
entry, so back (the Android gesture) closes the top one; at a table one more
entry makes back ask *Spel verlaten?* instead of leaving the page. An
update still animating when the page leaves the room (or goes to another)
is dropped after its animation, so no hand summary of the table left
opens over the home screen or the next table (`app-checks.mjs --only
queue` leaves during the hand end).

### On-screen keyboard

`index.html` sets `interactive-widget=resizes-content`,
so an open keyboard shrinks the viewport, and an upright phone turns short
and wide. The keyboard counts as open while a text field (not read-only)
has the focus on a touch screen (`pointer: coarse`) that is not turned
sideways (`screen.orientation`), and the viewport is at least 120 px
shorter than its height without a field focused; after a blur the state
holds until the viewport grows back (at most 0.9 s), so nothing moves under
the finger. Then `html.kb` is set (`watchKeyboard` in util.js): every rule
for `(orientation: landscape)` phones starts with `:where(html:not(.kb))`,
so the upright layout stays (home, the table behind the chat drawer),
the home screen hides its banner and footer, and the focused field is
scrolled into view when the keyboard covers it. A phone on its side keeps
its landscape layout. `app-checks.mjs --only keyboard` emulates it.

### Connection

A move the game lists in `ACKED` (klaverjas: `play`, `trump`, `bid`,
`auction`, `discard`) or a `vote` (sent only when it changes the answer) without any answer within 4 s means
a dead socket: the client reconnects. So does the client's keepalive
`ping` (every 20 s) with nothing at all received by the next one; that
counts from the ping, not the clock, since Chrome may fire the timers of a
tab hidden for 5 minutes or more only once a minute. Every rejoin drops the
moves and votes sent but unanswered and renders purely from the resync.
As the connection opens again, right after the `join` and before what
was queued while offline goes out, requests sent over the old connection
are settled: a feedback form's *Versturen* comes back (its `saved` went
to the old connection), and the game settles its own (`game.onReconnect`;
klaverjas's: [games/klaverjas/README.md, "Connection"](../games/klaverjas/README.md#connection));
queued ones go out and are answered. A tab in the background still sounds
the turn (and the takeover question) and shows "● Jouw beurt" in its
title on your turn, and "● Vraag aan tafel" while the question waits for
your answer. Leaving while offline sends `join` (with the seat
token) + `leave` over a short-lived connection of its own once the network
is back. A rejoin of a page in the call joins it again
with a new session (the server ended the old one with its connection).

### Game over

The host gets *Nog een partij* (`rematch`) and, where the room has a lobby,
*Spelers of regels wijzigen* (`lobby`: back to *Klaarzetten* under the same
code, where the start guard runs again); everyone gets *Naar start*. What
the screen shows of the scores is the game's.

### Motion and glows

A glow that pulses until the player acts (the turn, the advice on a trump
or bid choice, a hinted card) animates only `opacity`, which the
compositor runs: a `box-shadow` animation would restyle and repaint the
page every frame (`test/ui/app-perf.mjs` measures it). The turn and the
advice keep the two ends of their pulse on two layers (`::before`,
`::after`) that crossfade. With `prefers-reduced-motion` or *Minder
animaties* (`body.reduced`) these glows, and the lesson spot, are steady.
A countdown ring stops once it is hidden or its dialog is gone. On a phone
(up to 600 × 932 px) the manual is an opaque sheet over all but a strip of
the top bar: the pulses and glows, the home logo and the waiting dots under
it hold still while it is open (not a lesson spot in the top bar). The
sheet is at most 900 px high, so in a taller window the table shows above
it and they keep moving.

### Chat

Drawer (side panel on wide screens), quick reactions (the game's
`chatQuick`; klaverjas: 👍 😂 😱 😭 "Mooi!" "Nat!" "Goed gespeeld!"), bot lines, system lines, unread badge (counts what
people write; system lines and bot chatter, shown as speech bubbles, do not).
Speech bubbles stay behind the cards of the trick and never overlap each
other: a chat line in the way of another bubble waits for room (dropped
after 6 s; it is in the chat log), while a bid (*Ik speel!*, *Pas*) shows at
once and ends a chat bubble in its way. The others' lines wait in the
update queue behind the table's animations, so a line and its bubble come
with the move they are about; a line you typed shows as soon as the
server echoes it (a bot line at your seat waits like the others). The
`chatlog` after `joined` takes its turn in the queue as well, so a line
still queued from before a reconnect is not shown twice, and your own
line waits behind a chat log still queued, which was sent before it.
`app-checks.mjs --only queue` sends lines during the trump banner and
drops the socket there.

### Calling

The call with the others at the table ([server.md, "Calls"](server.md#calls)
has the server's side; `call.js`, loaded once another person is
at the table, in a browser with WebRTC, also one that offers a page no
microphone or camera): at the start of a game with another person (the
first update of a match, or the first at a table joined mid-game, once
per room and page, not in a room where the page was in the call
already; again after leaving the room and coming back) a
dialog *Meebellen?* proposes the call: "Gast zit ook aan tafel. Bel mee
met geluid, en met beeld als je wilt." (or who already calls), switches
*Microfoon* and *Camera* as last chosen (on before the first choice), a
line that sound and picture go from device to device, not through the
server (when the game is on screen also how to switch them during the
game), and
*Niet nu* / *Meebellen*. Not in the lobby, where the call is offered but
not proposed, and not in training or alone with bots. Instellingen
*Bellen voorstellen* ("Bij een spel met andere spelers vragen of je
meebelt, als je niet automatisch meebelt"; `kj.call` `ask`) turns the
proposal off. Not in the call, the
*Bellen* button opens the same dialog, with *Annuleren*. Until the
player has called once (`auto` unset), the dialog also asks *Automatisch
meebellen* ("Voortaan zit je bij een spel met andere spelers meteen in
het gesprek"), switched off; *Meebellen* keeps the answer,
*Niet nu* and *Annuleren* keep nothing, so the next dialog asks again.
With *Automatisch meebellen* on (also under Instellingen: "Bij een spel
met andere spelers zit je meteen in het gesprek"; off by default), a
page comes into the call by itself at a table with another person, once
per room and page, already in the lobby, with its microphone and camera
as last chosen (`mic`, `cam`), and is not proposed the call. A page that
has been in the call in a room, however it came in, is neither proposed
it nor put in it again there: hung up, it stays out until the *Bellen*
button (a reload, or leaving the room and coming back, starts afresh).
Never chosen yet, a dialog *Microfoon en camera*
asks for them: "Je zit in het gesprek: je hoort en ziet wie de microfoon
of camera aan heeft. Met die van jou aan horen en zien de anderen jou
ook.", with the two switches (on), the line (with "Automatisch meebellen
zet je uit bij Instellingen.") and *Niet nu* / *Aanzetten* (*Uit laten*
with both switches off). Both dialogs
remember the switches as set. *Meebellen* joins at once: the page hears
and sees the others while its own devices are still asked for, or with
both off. A browser that offers a page no microphone or camera joins to
listen: *Meebellen?* says so ("Deze browser deelt geen microfoon of
camera: je kunt wel meeluisteren en meekijken."), without their
switches, and in the call there are no buttons for them. On iOS
(`navigator.audioSession`) sound.js plays the game's sounds in an
`ambient` session, mixed with the user's own music; as that records
nothing and goes quiet with the silent switch, the session is
`play-and-record` from the first time the page records or asks for the
microphone (set before it is asked) or someone else in the call has the
microphone on, until it hangs up or leaves the room (given back once the
microphone has stopped; devices that come after are stopped), also for a
sound context made meanwhile: switching back and forth as someone mutes
would break into the sound and move a headset between its modes. A page
that only listens to a call where nobody has talked yet stays `ambient`.
Switching on asks the browser for microphone and camera together;
refused at once (a setting blocks one of them), for each on its own, so
the microphone may still come when the camera is blocked; refused after
0.8 s (someone answered the browser's question; Safari asks for both
together) only one the browser already allows this page
(`navigator.permissions`) is asked for again. What cannot be had is a
toast while still in the call ("Geen toegang tot de camera" with "Sta het
toe in de instellingen van je browser.", "Geen microfoon gevonden", "De
camera is in gebruik"; for another error "Geen toegang tot …" with its
name: "Fout: OverconstrainedError."), and the call goes on without it.
A device that could not be had is remembered as off, but for one in use
(it may be free next time), also when the page hung up meanwhile, so the
next table does not ask for it by itself (its button still does). While
the devices are asked for, their two buttons wait.
A microphone or camera that ends by itself later (unplugged, taken by
another app, its permission withdrawn), or already while the other was
still being asked for, is switched off as with its button, but not
remembered; a tap asks for it again. The page sends `call` as it joins
and at every switch; every two pages in the call connect, also two that
only listen, the lower session
id offering, with one audio and one video transceiver from the start, so
switching later only swaps tracks (the camera's track is stopped, its
light goes off; the microphone's is muted and taken off the connections,
so nothing is sent until it is on again). Video goes at most 300 kbit/s
to each other page (the browser would send 600 for 320x240; the circle
shows it at most about 160 device pixels wide): the offerer sets it on
its transceiver, the answerer once the answer is made, and it holds as
the camera's track changes. One description each way,
with the addresses found within 2.5 s (no trickling, for the message
limit); STUN from Google and Cloudflare, no TURN. A connection not up
within 20 s, or lost for 8 s, failed: the offerer tries again three
times, then the seat is marked. The others' sound and pictures play in
one `<audio>` and one `<video>` for each other seat, made when call.js
loads and started empty at the first taps (pointerup, touchend, click,
keydown; a touch's pointerdown is no gesture to Safari): Safari then
plays them without a tap, also on a page that records nothing, where it
would otherwise refuse the sound; a priming refused (a swipe is no
gesture) waits for the next tap. A browser that still refuses gets "Tik
ergens om de anderen te horen" once someone in the call has the
microphone on, and the next tap plays everything. The call buttons sit
in the prompt row
right of the rule: *Microfoon* and *Camera* toggles (`aria-pressed`,
coral while off) and a red *Ophangen*; while they show, a long rule wraps
sooner, so the two never overlap. On phones under 600 px the two toggles
stand in a row above the last-trick button, clear of the right seat and
the trick, and *Ophangen* is in the ⋯ menu. Not in the call, one button
*Bellen* (on phones also in the ⋯ menu) opens the dialog. In the lobby
the same buttons sit under the table, *Bellen* and *Ophangen* with their
label. The question whether to call by itself sits just above the
answers. In short landscape the dialog puts the microphone's and
camera's switches side by side, and only what lies above the question
and the answers scrolls (at least 56 px of it; on a still shorter screen
the whole body scrolls), so those stay in view, under a line. A seat in the call shows that
person's video in place of the face (in the ring, and in the lobby's
avatar), ours mirrored, while the camera is on and pictures arrive:
another's video waits in the ring out of sight until its first picture
(Safari plays a video in the page, not one outside it, and unmutes a
track before its pictures come). In the call with the microphone off (so
also a page that only listens) the ring has a mark in its circle, at the
bottom left (the dealer's chip is at the bottom right), 30% of the
ring's width (12 to 22 px): a microphone crossed out, coral; when no
connection could be made a warning sign; with the microphone on none. A toast says "Kees
belt mee". Leaving the room hangs up. `app-checks.mjs --only call` plays
it through with the fake devices of `scripts/chrome`: a host with
Automatisch meebellen on comes into the call in the lobby and is asked
for the devices; the guest is offered the call there, not proposed it,
calls with *Bellen*, is asked the first time whether to call by itself,
says yes with both devices off and hears the host, hangs up and stays
out, also when the game starts; it calls again, asked only for the
devices, and sees and hears the host. Then a camera refused and allowed,
a camera and a microphone whose permission is withdrawn and given back,
a hang-up and a join with the camera slow to be refused and the
microphone's permission withdrawn meanwhile, the marks of muted
microphones in their circles, the dealer's and trump's marks outside the
videos, the video ceiling on both sides, a muted microphone off the
connection and back on it with one tap, a host that came into the call
by itself and stays out after hanging up, a reload with Automatisch
meebellen that comes back into the call with the devices as last chosen
(a refused camera then remembered as off), a reload never answered that
is proposed the call with the question (it and the answers in reach
at 568x320 and 740x300) and keeps nothing after *Niet nu*, and a refusal at the
question (slow) that asks again only for the microphone the browser
allows and remembers the camera as off; and, with a fake
`navigator.audioSession` on the host, that the microphone is asked for
under `play-and-record` and that hanging up and leaving while the
devices are asked for give `ambient` back once the tracks have stopped.

### Help

The game's help in a modal (klaverjas's handleiding, toepen's rules sheet),
plus `title` tooltips and small ⓘ explanations on UI elements.

### Responsive layout

Phones portrait (360×640 up, and an iPhone SE in Safari:
375×548) and landscape (≥ 640×360), tablets and desktop; touch targets
≥ 44 px; no horizontal scroll.
