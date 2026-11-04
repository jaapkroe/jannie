# Architecture

jannie is a platform for Dutch card games played in the browser, with
friends or against bots: one site per game, each with its own address, pod
and interface, built from shared code. Klaverjas
(`klaverjas.kroes.dev`) and toepen (`toepen.kroes.dev`) are live; bridge
is next ([adding-a-game.md, "Order"](adding-a-game.md#order)).

The docs are the contract between the parts of the system. Code that
deviates from them must update them in the same change. The Go API sections
in particular list the exported identifiers and semantics that other
packages use: names may gain helpers, but changing what is listed means
updating that section.

- `docs/` holds the platform: this file; [server.md](server.md), the table
  every game is played at; [protocol.md](protocol.md), the table's part of
  the wire protocol; [frontend.md](frontend.md), the web shell;
  [deployment.md](deployment.md); and [adding-a-game.md](adding-a-game.md).
- Each game's design and contracts sit next to its code:
  [games/klaverjas/README.md](../games/klaverjas/README.md) and
  [games/toepen/README.md](../games/toepen/README.md).

## Principles

- **No accounts, no database, no persistence.** Games live in the
  server's memory and vanish on restart. There is nothing to log in to.
  What a server writes down is its game log, kept at most 12 months
  ([server.md, "Game log"](server.md#game-log)), and toepen's score
  sheets of games at a real table.
- **Same origin.** Everything a page needs comes from its own site: no
  CDN, no web fonts, no analytics. So a strict CSP is possible
  ([frontend.md, "Rules"](frontend.md#rules);
  [deployment.md, "nginx"](deployment.md#nginx)).
- **No build step.** The frontend is vanilla ES modules, served as
  written; there is no framework.
- **A Dutch UI.** English for code, comments and docs; **every
  user-visible string is Dutch**.
- **One site per game** (below): a player who opens a game's site finds
  that game and nothing else.

## One site per game

A player who opens klaverjas.kroes.dev wants to klaverjas, and one who opens
toepen.kroes.dev wants to toep. So every game gets:

- **one address**: klaverjas.kroes.dev, toepen.kroes.dev, …;
- **one entry point**: its own page, name, icons, link preview and install
  name, with nothing on it about any other game, and no game to choose;
- **one pod**: its own server binary and web image, units, game-log volume
  and port, deployed on its own (`make deploy GAME=toepen`).

What the games share is code, never an interface: the table every game is
played at, the shell of the web pages, and the deployment templates. The
games, their addresses and ports are listed in
[deployment.md, "The games"](deployment.md#the-games).

## What a site owns

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
  Snel spelen's options and subtitle, extra tiles (klaverjas: Oefenen;
  toepen: Score bijhouden), the help (klaverjas's handleiding, toepen's
  rules sheet), the table and its overlays, the menu's items, a hidden
  extra under the version (the expert mode), how the lobby places its seats
  and what it calls the others (maat and tegenstander, or tegenspeler).
- Its rules, bots, protocol messages and state, and its game log.

The personas are the same café regulars on every site (identity in
`platform/persona`); their bios and chat lines are per game
([server.md, "Personas"](server.md#personas)).

Storage is per origin: a player who plays both games types their name once
on each site. Nothing links the sites to each other.

## Repository layout

```
go.mod                       module jannie (Go 1.27), one dependency: github.com/coder/websocket
cmd/<game>/                  a game's binary: its AI adapter (ai.go) and platform/serve; named after
                             the game (cmd/klaverjas, cmd/toepen), as the image's binary and health check are
platform/                    what every game shares
  server/                    the table: rooms and codes, seats and the lobby, bots and their chat, calls,
                             reconnects, the takeover question, pacing, limits, the game-log writer; the
                             Game API for the games (api.go, ext.go; docs/server.md)
  server/klaverjas_*.go      klaverjas's server side, still built into the table
  server/servertest/         a test kit for any game's server tests
  serve/                     what every binary shares: flags, HTTP server, graceful shutdown, -healthcheck,
                             the dev static handler (platform/web ∪ games/<game>/web) and the game's 404 page
  persona/                   the personas' identities, shared by every game (bios per game)
  cards/                     the seats and the 32-card deck that klaverjas and toepen share
  web/                       the shell every game's site uses, vanilla ES modules (docs/frontend.md)
    css/app.css  css/cards.css
    js/main.js (routing, the websocket, the update queue)  js/util.js  js/panels.js  js/home.js
    js/cards.js  js/sound.js
    js/call.js               the call with the others at the table, loaded once another person sits there
games/<game>/                one game: README.md (its design and contracts), <game>.mk (its settings:
                             TITLE, VERB, SITE, ADDR, DEV_PORT, E2E_PORT, E2E_SIM), web/ (its site,
                             served with platform/web, no path in both), and its Go packages
games/klaverjas/
  game/                      pure rules engine: legal moves, tricks, roem, scoring, the deal state machine;
                             re-exports platform/cards's seats and cards
  bot/                       bot personalities, play levels, hints and advice, the review, chat lines
  web/                       index.html  favicon.svg  manifest.webmanifest  og.png (link preview)
                             icon-full.svg  apple-touch-icon.png  icon-192.png  icon-512.png  icon-maskable-512.png
                             css/klaverjas.css
                             js/game.js (the game module)  js/table.js (the table and its overlays)  js/manual.js
                             js/expert.js (the sheet Redenering van de AI, loaded only when first opened)
games/toepen/
  toepen/ toepbot/ toepenserver/   toepen's rules, bots and server side
  scoresheet/                Score bijhouden: the score of a game at a real table, a service at /api/score
  web/                       toepen's site
deploy/                      the templates every game renders (game.pod.in, game-web.container.in,
                             game-server.container.in) and nginx.conf (docs/deployment.md)
docs/                        the platform's docs
test/sites.test.mjs          every site: its own files, its request budget, its own game only
test/layout.test.mjs         the Go imports: the platform imports no game (but for klaverjas's files and
                             the tests in platform/server), no game imports another, cmd/<g> only
                             platform/ and games/<g>/, and platform/cards nothing of the module
test/manual.test.mjs         klaverjas's manual: its sections, and its examples against an independent
                             rules checker
test/sound.test.mjs          the shell's sound palette
test/e2e/                    node scripts that play full games over the websocket: sim.mjs (klaverjas),
                             toepen.mjs (test/e2e/README.md)
test/ui/                     puppeteer-core browser checks (`npm ci` there first; node_modules is ignored):
                             app-checks.mjs, behaviour checks on klaverjas's site; app-screens.mjs and
                             toepen-screens.mjs, every screen of a site at six sizes; app-perf.mjs, a
                             benchmark of the frontend on two emulated phones; og-image.mjs, which renders
                             a site's og.png; site.mjs, a site's files; and node tests of the shell's and
                             the games' pure modules (*.test.mjs)
scripts/go                   Go toolchain in a container: `scripts/go test ./...`
GAME=<game> scripts/dev-server PORT  run the game's server from source on 127.0.0.1:PORT, serving
                             platform/web and games/<game>/web (flags after PORT)
scripts/chrome PORT          headless Chromium with CDP on 127.0.0.1:PORT, with a fake camera and microphone
scripts/pod-check ADDR SITE TITLE  check a game's running pod without the reverse proxy: pages and titles,
                             websocket, link preview, manifest, CSP, security headers (`make check`)
scripts/deploy-test          `make test`: every game's units through podman's quadlet generator, and how
                             `make deploy` labels, tags and refuses builds (stubbed podman/systemd)
Containerfile  Makefile  README.md
```

### Toolchain

`scripts/go` runs the Go toolchain in a container, so the host needs only
podman. It has no `-race` (no cgo in the Alpine image); for that, use the
Debian image: `podman run --rm --network host -v $PWD:/src -w /src -e
GOFLAGS=-buildvcs=false docker.io/library/golang:1.27 go test -race ./...`.
The JS tests run on the host with `node --test` (Node 22.15 or later; the
project uses Node 26).

## The seams

**Server.** One process serves exactly one game: `server.Config{Game: …}`.
Klaverjas is the built-in game (`server.Klaverjas(ai)`), on its original
match code; any other game implements the exported `Game` interface (name,
seat range, personas, its options, its bots' brains and chat, and a `Play`
per match) on a `*Table` handle (the shared state envelope, phases, pauses,
turns, emits, bot thinking, chat, the game log). The table drives; a game
never schedules itself. Klaverjas's wire format is exactly what it was
before toepen existed; a game's messages are unknown on another's server.
[server.md](server.md) has the API.

**Frontend.** The shell imports the game only in `main.js`, through
`./game.js`; `home.js` and `panels.js` get it at boot. Every site keeps to
a budget of 17 requests per page load. The contract, the budget and what
`test/sites.test.mjs` checks are in
[frontend.md, "One site per game"](frontend.md#one-site-per-game).

**Deployment.** `GAME` selects the site in the Makefile; names derive from
it (pod, units, containers, images, volume), and klaverjas's rendered units
are byte for byte those from before there were more games. One
Containerfile: Go is vetted and tested once, every binary built; a
`server-<game>` target per game and one `web` target with `ARG GAME`.
[deployment.md](deployment.md) has the rest.

## What is not generic yet

- **Klaverjas on the table.** Klaverjas's server side is still built into
  the table: the `platform/server/klaverjas_*.go` files, in package
  `server`, behind an unexported seam (`games.go`) next to the exported
  Game API that toepen uses. Moving it onto the exported API needs what
  that API lacks so far: the fields of `create` (training, expert, a chosen
  seat), table locks, messages to one seat, the coach's chat lines, hooks
  in the match loop for the lessons, the timing and seat changes the review
  reads, a summary that waits for `ready` while one person is at the table
  and counts down once there are two, and its own shape of the game-log
  record.
- **Cards.** `platform/cards` holds the seats and the 32-card deck that
  klaverjas and toepen share ([server.md, "platform/cards"](server.md#platformcards));
  `cards.js` knows the ranks 7–A only. A 52-card game brings its own `Card`
  and `Rank` and shares `Seat` and `Suit`; `cards.js` needs 2–6 and the
  jokers.
- **The shell's klaverjas leftovers.** `util.js` still holds klaverjas's
  helpers (sides, scorers, roem, headlines, review lines); they load on
  toepen's site unused, and move to klaverjas's game modules in a change of
  their own. Klaverjas's table styles are its own stylesheet,
  `klaverjas.css`.
- **The extras.** Hints, lessons, the review after a match and the expert
  mode are klaverjas's; toepen has a reasoning sheet of its own for the
  expert alone with bots
  ([games/toepen/README.md, "Redenering van de AI"](../games/toepen/README.md#redenering-van-de-ai)).
  A game that wants them brings its own; the table offers
  `Table.Background` for the analysis.
- **The manual.** Klaverjas has its handleiding, toepen a rules sheet; a
  shared renderer with per-game sections and a common *Bediening* would
  suit more games.
- **Seats.** A table has at most 6 seats in the lobby layout so far.
- **Two seats, one person; hidden sides.** Bridge's dummy and rikken's
  called ace need `controller(seat)` in the table and views that hide a
  partnership.
