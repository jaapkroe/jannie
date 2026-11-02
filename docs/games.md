# One site per game

How this repository carries more card games than klaverjas: each game is a
site of its own, with its own address, pod and interface, built from shared
code. Toepen is the second; bridge, rikken, pesten and presidenten could
follow. The contracts stay in [`design.md`](design.md) (the table and
klaverjas) and [`toepen.md`](toepen.md).

## 1. The decision

A player who opens klaverjas.kroes.dev wants to klaverjas, and one who opens
toepen.kroes.dev wants to toep. So every game gets:

- **one address**: klaverjas.kroes.dev, toepen.kroes.dev, …;
- **one entry point**: its own page, name, icons, link preview and install
  name, with nothing on it about any other game, and no game to choose;
- **one pod**: its own server binary and web image, units, game-log volume
  and port, deployed on its own (`make deploy GAME=toepen`).

What the games share is code, never an interface: the table every game is
played at, the shell of the web pages, and the deployment templates. An
earlier version of this branch made toepen a mode of the klaverjas site (a
switch on the home screen, a game option on the wire); a review panel
(Go architecture, frontend, deployment, platform and UX) reworked it into
this design.

| GAME | Address | Loopback | Dev, e2e ports | Game log | Binary |
|---|---|---|---|---|---|
| klaverjas | klaverjas.kroes.dev | 127.0.0.1:8093 | 18093, 18094 | klaverjas-games | cmd/klaverjas |
| toepen | toepen.kroes.dev | 127.0.0.1:8095 | 18095, 18096 | toepen-games | cmd/toepen |

## 2. What a site owns

- Its name everywhere: `<title>`, the wordmark and tagline on the home
  screen, the footer line, the `noscript` text, the tab title while you
  play ("Toepen · ABCD"), the share title and text, the support sheet's
  sentence, the 404 page.
- Its link preview and install: the og texts and `og.png`
  (`test/ui/og-image.mjs --site <game>`), the manifest's name and colours,
  `favicon.svg`, `icon-full.svg` and the PNG icons.
- Its look: its stylesheet overrides the shell's colour tokens (`--bg`,
  `--felt-1..3`, …); klaverjas has green felt, toepen blue. Structure,
  placement, icons and interaction are the same on every site.
- Its content: the option rows of the new-game sheet and the lobby,
  Snel spelen's options and subtitle, extra tiles (klaverjas: Oefenen),
  the help (klaverjas's handleiding, toepen's rules sheet), the table and
  its overlays, the menu's items, a hidden extra under the version
  (klaverjas: the expert mode), how the lobby places its seats and what it
  calls the others (maat and tegenstander, or tegenspeler).
- Its rules, bots, protocol messages and state, and its game log.

The personas are the same café regulars on every site (identity in
`internal/persona`); their bios and chat lines are per game.

Storage is per origin: a player who plays both games types their name once
on each site. Nothing links the sites to each other.

## 3. What is shared as code

```
cmd/<game>/                   main: the game's AI adapter and internal/serve
internal/serve/               flags, run and shutdown, -healthcheck, the dev static handler
                              (the union web/shared ∪ web/<game>), the per-game 404 page
internal/server/              the table: rooms and codes, seats and the lobby, bots, chat,
                              calls, reconnects, the takeover question, pacing, limits,
                              the game-log writer; klaverjas built in; the Game API
internal/server/servertest/   a test kit for any game's server tests
internal/persona/             the personas' identities
internal/<game>, <game>bot,   a game's rules, bots and server side (toepen: internal/toepen,
  <game>server/                 internal/toepbot, internal/toepenserver)
web/shared/{js,css}/          the shell: main.js (with the websocket), util.js, panels.js,
                              home.js, sound.js, cards.js, call.js; app.css, cards.css
web/<game>/                   the site's page, manifest, icons, og.png, js/game.js and the
                              game's modules and stylesheet
deploy/games/<game>.mk        the site's settings: TITLE, VERB, SITE, ADDR, ports, E2E_SIM
deploy/game*.in               the pod and unit templates every game renders
```

## 4. The seams

**Server.** One process serves exactly one game: `server.Config{Game: …}`.
Klaverjas is the built-in game (`server.Klaverjas(ai)`), on its original
match code; any other game implements the exported `Game` interface (name,
seat range, personas, its options, its bots' brains and chat, and a `Play`
per match) on a `*Table` handle (the shared state envelope, phases, pauses,
turns, emits, bot thinking, chat, the game log). The table drives; a game
never schedules itself. Klaverjas's wire format is exactly what it was
before toepen existed; a game's messages are unknown on another's server.

**Frontend.** No build step and a budget of 17 requests per page load (the
name's NPM rate tier): 5 fixed (html, favicon, manifest, one PNG icon, the
websocket), the shell's 6 modules and 2 stylesheets, and at most 3 page-load
modules and 1 stylesheet of the game. The shell imports the game only in
main.js, through `./game.js` (design §9 "One site per game" has its
contract); home.js and panels.js get it at boot. `test/sites.test.mjs`
checks every site: the two trees share no path, the budget holds and every
module main.js imports is preloaded, the shell imports no game module, and
nothing a player sees names another game.

**Deployment.** `GAME` selects the site in the Makefile; `make install`,
`deploy`, `uninstall` and `dev` refuse to run without it (`GAME=all` runs
every game in turn), while `status`, `check`, `logs`, `quadlet` and `e2e`
cover all games. Names derive from GAME (pod, units, containers, images,
volume), and klaverjas's rendered units are byte for byte those of before.
One Containerfile: Go is vetted and tested once, every binary built; a
`server-<game>` target per game and one `web` target with `ARG GAME`.

## 5. What each game needs

| | Klaverjas | Toepen | Presidenten | Pesten | Rikken | Bridge |
|---|---|---|---|---|---|---|
| Players | 2–4 | 2–6 (rules: 8) | 3–8 | 2–8 | 4 | 4 |
| Cards | 32 | 32 | 52 (+ jokers) | 52 + 2 jokers, two decks for many | 52 | 52 |
| Hand | 8 (10, 16) | 4 | all dealt: 6–18 | 7, grows | 13 | 13 |
| Kind | tricks, trump | tricks, only the last counts | climbing: sets on a pile | shedding | tricks, trump | tricks, trump or NT |
| Sides | 2 teams | each alone | each alone, ranks between rounds | each alone | per contract, **hidden** partner | 2 fixed pairs |
| Before play | trump or bids | was (all at once), armoede | card exchange between ranks | — | auction of contracts | auction, conventions |
| Special | roem, signals | stakes, passing mid-trick | pass rounds, multi-card plays | draw pile, direction, specials | misère, open misère | the dummy |
| Match | fixed hands | until one is left | rounds, ranks | first out | points per contract | rubber or duplicate |

Which shared capabilities each uses:

| Capability | Klaverjas | Toepen | Presidenten | Pesten | Rikken | Bridge |
|---|---|---|---|---|---|---|
| Seats on an ellipse, 2–8 | (4 fixed) | yes | yes | yes | (4) | (4) |
| Everyone answers at once (`Table.Think`) | — | the was | card exchange | last-card call | — | — |
| Hidden sides in the view | — | — | — | — | yes | — |
| One person plays two seats (`controller`) | — | — | — | — | — | the dummy |
| 52 cards and jokers | — | — | yes | yes | yes | yes |
| Big hands, multi-select | — | — | yes | yes | — | — |
| Piles | — | — | yes | yes | — | — |

## 6. What is not generic yet

- **Cards.** `internal/game`'s card type and `cards.js` know the ranks 7–A
  only; the 52-card games need 2–6 and the jokers (`internal/cards`, faces
  in cards.js). Toepen reuses the 32.
- **The shell's klaverjas leftovers.** util.js still holds klaverjas's
  helpers (sides, scorers, roem, headlines, review lines) and app.css its
  table styles; both load on toepen's site unused. They move to klaverjas's
  game modules and stylesheet in a change of their own (the stylesheet
  order app → klaverjas → cards keeps equal-specificity ties as they are).
- **The extras.** Hints, lessons, the review after a match and the expert
  mode are klaverjas's; toepen has a reasoning sheet of its own for the
  expert alone with bots (toepen.md §8). A game that wants them brings its
  own; the table offers `Table.Background` for the analysis.
- **The manual.** Klaverjas has its handleiding, toepen a rules sheet; a
  shared renderer with per-game sections and a common *Bediening* would
  suit more games.
- **Seats.** A table has at most 6 seats in the lobby layout so far.
- **Two seats, one person; hidden sides.** Bridge's dummy and rikken's
  called ace need `controller(seat)` in the table and views that hide a
  partnership.

## 7. Adding a game

1. Rules: `internal/<game>`, a pure state machine with a view per seat;
   table-driven tests and thousands of random matches.
2. Bots: `internal/<game>bot` at three levels, with an arena test (stronger
   beats weaker) and chat lines and bios for the personas.
3. Server: `internal/<game>server` implementing `server.Game`; its tests on
   `servertest`.
4. `cmd/<game>`: the AI adapter and `internal/serve`.
5. Site: `web/<game>/` with index.html, manifest, icons (`icon-full.svg`,
   rendered PNGs), `og.png`, `js/game.js` and its table, its stylesheet;
   add it to the felt table of `test/ui/app-icons.test.mjs` and a scene to
   `test/ui/og-image.mjs`.
6. End-to-end: `test/e2e/<game>.mjs`.
7. Deployment: `deploy/games/<game>.mk` (next free odd port), a
   `server-<game>` target in the Containerfile; then outside the repo an NPM
   proxy host, the name's rate tier in shrek-infra, the game-log volume in
   the backup exclusions, Trivy and monitoring for its images.
8. Docs: `docs/<game>.md`, this file's tables, README.

## 8. Order

1. **Presidenten**: a new kind of rules (sets on a pile, passing, ranks),
   the 52-card deck, and the card exchange on `Table.Think`.
2. **Pesten**: shedding with specials as options (as toepen's was and
   armoede), the draw pile and direction; easy bots; jokers and big hands.
3. **Rikken**: a trick engine like klaverjas's (a shared trick kit is worth
   extracting then), contracts and their scores, the hidden partner, open
   misère.
4. **Bridge**: the auction with a bidding system the bots and hints share,
   the dummy (`controller`), rubber or Chicago scoring; card play by
   sampling as klaverjas's sterk.

## 9. Toepen, as built

[`toepen.md`](toepen.md): the rules as implemented and where variants were
chosen, its options, server, protocol, bots, site and deployment.
