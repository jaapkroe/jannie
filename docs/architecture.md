# Architecture

jannie is a platform for Dutch card games played in the browser, with
friends or against bots: one site per game, each with its own address, pod
and interface, built from shared code. Klaverjas
(`klaverjas.kroes.dev`) and toepen (`toepen.kroes.dev`) are live; others
could follow ([adding-a-game.md, "Order"](adding-a-game.md#order)).

The docs are the design, and the contract for behaviour between the parts
of the system: what the table and a game do, the rules, the protocol and
the decisions behind them. Code that deviates from them must update them in
the same change. Names are documented in the code: an exported identifier
by its doc comment, a test by the comment above it. The docs explain what a
package is for and how its parts fit, and do not list its API or its tests.

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
- Its look: its stylesheet, with its table's styles. The shell's colour
  tokens (`--bg`, `--felt-1..3`, …) are klaverjas's green felt, and
  toepen's stylesheet overrides them with blue
  ([frontend.md, "Stylesheets"](frontend.md#stylesheets)). Structure,
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
cmd/<game>/                  klaverjas's and toepen's binaries: the AI adapter (ai.go) and platform/serve;
                             named after the game, as the image's binary and health check are (a later
                             game keeps its main package in its folder, <folder>/cmd/<game>)
platform/                    what every game shares
  server/                    the table: rooms and codes, seats and the lobby, bots and their chat, calls,
                             reconnects, the takeover question, pacing, limits, the game-log writer; the
                             Game API for the games (api.go, ext.go; docs/server.md)
  server/klaverjas_*.go      klaverjas's server side, still built into the table
  server/servertest/         a test kit for any game's server tests
  serve/                     what every binary shares: flags, HTTP server, graceful shutdown, -healthcheck,
                             the dev static handler (platform/web ∪ the game's web/) and the game's 404 page
  persona/                   the personas' identities, shared by every game (bios per game)
  cards/                     the seats and the 32-card deck that klaverjas and toepen share
  web/                       the shell every game's site uses, vanilla ES modules (docs/frontend.md)
    css/app.css  css/cards.css
    js/main.js (routing, the websocket, the update queue)  js/util.js  js/panels.js  js/home.js
    js/cards.js  js/sound.js
    js/call.js               the call with the others at the table, loaded once another person sits there
    js/chart.js              the course of a match as a line chart, loaded with the first chart shown
games/<game>/                one game, one folder (docs/adding-a-game.md#the-folder): README.md (its design
                             and contracts), <game>.mk (its settings: TITLE, VERB, SITE, ADDR, DEV_PORT,
                             E2E_PORT, E2E_SIM), web/ (its site, served with platform/web, no path in both),
                             its Go packages, a later game's main package cmd/<game>/, and test/ (its JS
                             tests and simulation, and facts.mjs, what the shared tests need to know of it)
extra/<game>/                a game of the overlay: a checkout of a repository of private games, which git
                             ignores here, with a folder per game as in games/ (docs/adding-a-game.md#the-overlay)
games/klaverjas/
  game/                      pure rules engine: legal moves, tricks, roem, scoring, the deal state machine;
                             re-exports platform/cards's seats and cards
  bot/                       bot personalities, play levels, hints and advice, the review, chat lines
  web/                       index.html  favicon.svg  manifest.webmanifest  og.png (link preview)
                             icon-full.svg  apple-touch-icon.png  icon-192.png  icon-512.png  icon-maskable-512.png
                             css/klaverjas.css (linked between app.css and cards.css; the manual's styles last)
                             js/game.js (the game module)  js/table.js (the table and its overlays)
                             js/rules.js (klaverjas's helpers without the DOM: sides, scores, the score chart's data, roem, review lines)
                             js/manual.js (the handleiding) and js/expert.js (the sheet Redenering van de AI),
                             each loaded only when first opened
games/toepen/
  toepen/ toepbot/ toepenserver/   toepen's rules, bots and server side
  scoresheet/                Score bijhouden: the score of a game at a real table, a service at /api/score
  web/                       toepen's site
deploy/                      the templates every game renders (game.pod.in, game-web.container.in,
                             game-server.container.in) and nginx.conf (docs/deployment.md)
docs/                        the platform's docs
test/sites.test.mjs          every site: its own files, its request budget, its own game only
test/layout.test.mjs         the Go imports: the platform imports no game (but for klaverjas's files and
                             the tests in platform/server), no game imports another, a game's main package
                             only platform/ and its folder, platform/cards nothing of the module, and a
                             game's packages what the import table of its test/facts.mjs allows
test/docs.test.mjs           the docs' links and anchors, and every reference to a doc in the code
test/manual.test.mjs         klaverjas's manual: its sections, and its examples against an independent
                             rules checker
test/sound.test.mjs          the shell's sound palette
test/e2e/                    node scripts that play full games over the websocket: sim.mjs (klaverjas),
                             toepen.mjs (test/e2e/README.md)
test/ui/                     puppeteer-core browser checks (`npm ci` there first; node_modules is ignored):
                             app-checks.mjs, behaviour checks on klaverjas's site; app-screens.mjs and
                             toepen-screens.mjs, every screen of a site at six sizes; app-perf.mjs, a
                             benchmark of the frontend on two emulated phones; css-same.mjs, which checks
                             along any of them that a change of stylesheets changes nothing on screen;
                             og-image.mjs, which renders a site's og.png; site.mjs, the games (their
                             folders in games/ and extra/), their sites' files and their test/facts.mjs;
                             and node tests of the sites' icons and of the shell's and the games' pure modules
                             (*.test.mjs)
scripts/go                   Go toolchain in a container: `scripts/go test ./...`
GAME=<game> scripts/dev-server PORT  run the game's server from source on 127.0.0.1:PORT, serving
                             platform/web and the game's web/ (flags after PORT)
scripts/chrome PORT          headless Chromium with CDP on 127.0.0.1:PORT, with a fake camera and microphone
scripts/pod-check ADDR SITE TITLE  check a game's running pod without the reverse proxy: pages and titles,
                             websocket, link preview, manifest, CSP, security headers (`make check`)
scripts/deploy-test          `make test`: every game's units through podman's quadlet generator, and how
                             `make deploy` labels, tags, refuses and restarts (stubbed podman/systemd)
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
Containerfile: Go is vetted and tested once, every binary built; one
`server` target and one `web` target, each with `ARG GAME`. Everything
finds the games by their folders, so a game is added in its folder alone
([adding-a-game.md, "The folder"](adding-a-game.md#the-folder)).
[deployment.md](deployment.md) has the rest.

## What is not generic yet

- **Klaverjas on the table.** Klaverjas's server side is still built into
  the table: the `platform/server/klaverjas_*.go` files, in package
  `server`, behind an unexported seam (`games.go`) next to the exported
  Game API that toepen uses. The API now has part of what training and
  the expert mode need of the table: the fields of `create`, a chosen
  seat, bots on chosen seats and a fixed table (`Opener`,
  [server.md, "Rooms without a lobby"](server.md#rooms-without-a-lobby)),
  messages to one seat (`Table.Send`) and the coach's chat lines
  (`Table.CoachChat`). Moving klaverjas onto it still needs what the API
  lacks so far: table options a room fixes (training plays with four, its
  lesson on signals with bots at least at normaal), its own texts for the
  lobby commands a fixed table refuses, hooks in the match loop for the
  lessons, the timing and seat changes the review reads, a summary that
  waits for `ready` while one person is at the table and counts down once
  there are two, and its own shape of the game-log record.
- **Cards.** `platform/cards` holds the seats and the 32-card deck that
  klaverjas and toepen share ([server.md, "platform/cards"](server.md#platformcards));
  a 52-card game brings its own `Card` and `Rank` and shares `Seat` and
  `Suit`. `cards.js` draws all 52 faces (ranks 2–A) but no jokers, and its
  backs carry the clover.
- **The shell's klaverjas leftovers.** Klaverjas's helpers are its own
  `rules.js` and its table styles its own stylesheet, `klaverjas.css`
  ([frontend.md, "Stylesheets"](frontend.md#stylesheets)). The shell still
  has a little of klaverjas alone: in `panels.js` `setLastEnabled` (its
  *Laatste slag* tool); in `util.js` its first
  manual tab as the default of `prefs.tab`. And `app.css` has, kept on
  purpose:
  - Klaverjas-only alternatives inside the `:is()` lists of four shell
    rules: `.rule:not(.mine)` and `.rv-text` in the two four-colour suit
    colours of text, `.seat-id.spot` and `.rule.spot` where the manual
    holds the pulses still, and `.trump-tag` beside the dealer's chip on a
    video ring. In all but the last a klaverjas alternative is the most
    specific of its list, so taking it out would lower the specificity of
    the shell's alternatives.
  - What a game of two partnerships uses, which toepen does not: the
    other side's colour (`.zij`, `.msg-name.zij`; `.wij` is toepen's too,
    its lobby marks your own seat with it), the four places of the lobby's
    table (`.ls-bottom`, `.ls-top`, `.ls-left`, `.ls-right`) and the
    bubbles of a bid and a pass (`.bubble-go`, `.bubble-pass`). The team
    colours go with `rules.js`'s `teamCls` and the game module's `chatCls`
    hook, which gives a chat sender a side's colour.
  - What a game with lessons uses: the coach bubble (`.coach…`), the pulse
    of a lesson's spot (`kj-spot`) and the icon of the home page's training
    button (`#btn-train .icon`).
- **The extras.** Hints, lessons, the review after a match and the expert
  mode are klaverjas's; toepen has a reasoning sheet of its own for the
  expert alone with bots
  ([games/toepen/README.md, "Redenering van de AI"](../games/toepen/README.md#redenering-van-de-ai)).
  A game that wants them brings its own; the table offers
  `Table.Background` for the analysis, `Opener` for a training table
  ([server.md, "Rooms without a lobby"](server.md#rooms-without-a-lobby)),
  `Table.CoachChat` for a coach's lines, `Table.Send` for an answer to
  one player, `CleanText` for a person's text such as feedback and
  `Table.Current` for a game's own workers
  ([server.md, "Table"](server.md#table)).
- **Another seat's cards.** The Game API already lets one player play
  two seats: `Play.Turn` is the seat that decides, so a player who plays
  a partner's open hand too is on turn while that hand's card is due (the
  bot that decides, the think time and the takeover question are that
  player's), and the game's state says which hand to play from. A
  partnership the others may not see yet can stay in the game's
  `State(i)`, which is per seat
  ([server.md, "The Game API"](server.md#the-game-api)).
- **The manual.** Klaverjas has its handleiding, toepen a rules sheet; a
  shared renderer with per-game sections and a common *Bediening* would
  suit more games.
- **Seats.** A table has at most 6 seats in the lobby layout so far.
- **Hidden sides.** Rikken's called ace needs views that hide a
  partnership.
