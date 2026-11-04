# CLAUDE.md

Notes for coding agents in this repository. README.md has the overview and
the layout; docs/ and games/<game>/README.md are the design.

## Conventions

- Code, comments and docs in English; every string a player sees is Dutch
  (server error messages included). Match the surrounding code's style and
  comment density: short, plain comments in full sentences.
- The docs are the contract. A change to behaviour, an exported Go
  identifier, the protocol or a rule updates the doc that describes it in
  the same commit.
- Player-facing feedback (Spelanalyse, hints, tips, chat lines from the
  game) is plain and factual: facts, card names and numbers, with no praise,
  consolation, exclamation marks or emoji. The one exception: Juf Jannie's
  lessons may give short praise tied to a fact (the first trick won, a hand
  won); a lost hand gets no comment.
- A hint gives the reason of what chose the card: the policy rule that
  picked it, or the part of the search value where the search's card gains.
  Never a reason guessed separately in a text layer; add or change a reason
  where the decision is made.
- Frontend: vanilla ES modules, no framework, no build step, nothing loaded
  from another origin. The CSP allows no inline `<script>` or `<style>` and
  no `style` attributes (setting `el.style.x` from JS is fine). Build DOM
  with `createElement`/`textContent`, never `innerHTML` with user or server
  text. Use `store` from `platform/web/js/util.js` for localStorage: it
  adds the prefix and survives storage that throws.

## Constraints

- **17 requests per page load**, the websocket included.
  `test/sites.test.mjs` counts them from index.html and the static imports.
  Both sites are at the limit, so a new module is loaded lazily (dynamic
  `import()`) or replaces one.
- **One site per game.** A site is `platform/web` plus `games/<game>/web`;
  the two trees share no path, and nothing on a site names another game
  (`test/sites.test.mjs`).
- **Import boundaries** between `platform/` and `games/<game>/` are checked
  by `test/layout.test.mjs`; a new import across them must pass it.
- **Production names never change**: per game the unit names
  (`<game>.pod`, `<game>-web.container`, `<game>-server.container`), the pod
  name, the images `localhost/<game>-server` and `localhost/<game>-web`, the
  `<game>-games` volume (the game log), the `cmd/<game>` directory names
  (they name the binary the health check runs), the rendered output of
  `deploy/*.in` (compare `make -s quadlet GAME=klaverjas` and `GAME=toepen`
  before and after touching anything near them; the comments render too),
  the `kj.` localStorage prefix (players' saved state), and the constant in
  `dealRNG` (`platform/server`), which makes a seed deal the same cards.
- **Ports** come from `games/<game>/<game>.mk`: klaverjas `DEV_PORT` 18093,
  `E2E_PORT` 18094; toepen 18095, 18096. The rule, checked by
  `scripts/deploy-test`: `ADDR` is an odd port P, `DEV_PORT` 10000+P,
  `E2E_PORT` 10001+P. A new game takes the next odd port.
- `make install`, `deploy`, `uninstall` and `image` build, install or
  remove a game's production pod on this machine: run them only when asked.

## Toolchain

- No Go on the host: `scripts/go` runs the Go toolchain in podman, in the
  Containerfile's `golang` build image, from anywhere in the repo, with the
  repo mounted at `/src`: `scripts/go test ./platform/...`,
  `scripts/go vet ./...`, `scripts/go fmt ./...`.
- It has no `-race` (no cgo in the Alpine image). Use the Debian image:
  `podman run --rm --network host -v $PWD:/src -w /src -e GOFLAGS=-buildvcs=false docker.io/library/golang:1.27 go test -race ./...`
- Node 22.15 or later (`module.registerHooks`; developed on 26) for
  `node --test`. The unit tests import no packages.
- Go module `jannie`, Go 1.27, one dependency: `github.com/coder/websocket`.

## Tests and benchmarks

```sh
make test       # go vet, go test -short, node --test, scripts/deploy-test; ~2 min cold, ~10 s warm
make test-all   # every Go test, including the bot arenas: sterk beats normaal beats makkelijk
make e2e        # full games over the websocket against each game's server, -fast (GAME=… for one)
scripts/go test -run '^$' -bench . ./games/klaverjas/bot ./games/klaverjas/game  # CPU per decision, per hand
scripts/go test -run '^$' -bench . ./platform/server                              # the server's cost per match
scripts/go test -run PerfWire -v ./platform/server -args -perf.wire               # what one connection receives
scripts/go test -run '^TestIdentity$' ./games/klaverjas/bot -args -identity.out=/src/id-before.txt
```

`TestIdentity` writes every decision, hint and grade of 384 seeded deals
(`/src` is the repo root in the container): a change that must keep every
decision (a speed-up) leaves the file byte for byte the same, so run it
before and after and compare. `make test`'s JS part runs `test/*.test.mjs` and
`test/ui/*.test.mjs`. `scripts/deploy-test` puts every game's units through
podman's quadlet generator and checks how `make deploy` labels, tags and
refuses builds, with stubs for podman and systemd.

## A server from source

- `make dev GAME=<game>` serves on `DEV_PORT` and follows the log; Ctrl-C
  or `make dev-stop` stops it.
- `GAME=<game> scripts/dev-server PORT [-fast]` runs it in the background
  as the container `kj-dev-PORT`, serving `platform/web` and
  `games/<game>/web`. Poll `/api/health` until it answers (the first compile
  takes about a minute). `podman restart kj-dev-PORT` recompiles after a Go
  change; `podman stop kj-dev-PORT` ends it. `-fast` cuts every pause to 5%.

## Browser checks (puppeteer)

```sh
(cd test/ui && npm ci)                     # puppeteer-core and ws, once
scripts/chrome 9301                        # headless Chromium, CDP on 9301; podman stop kj-chrome-9301
node test/ui/mock/server.mjs --rig &       # klaverjas mock on 18100: four players, no lesson steps
cd test/ui
node app-screens.mjs [--only iphone,desktop] [--dpr 2]   # every screen at six sizes, into test/ui/out/
node app-perf.mjs                          # main-thread work and chat keystrokes on two emulated phones
node og-image.mjs --site klaverjas         # rewrites games/<site>/web/og.png (--out FILE elsewhere)
```

The scripts default to the mock's 18100 and Chromium's 9301; `--url` and
`--cdp` choose others. Lessons, tables of two and three, calls and the
checks need the real server with `-fast`:

```sh
GAME=klaverjas scripts/dev-server 18300 -fast && scripts/chrome 9303
cd test/ui
U='--url http://127.0.0.1:18300 --cdp http://127.0.0.1:9303'
node app-play.mjs $U [--gedraaid | --multi | --training | --players 2|3]   # full games by tapping
node app-checks.mjs $U [--only lessons,call]   # 34 checks, about 15 minutes for all
```

`app-*.mjs` and the mock are klaverjas only; `test/ui/toepen-screens.mjs`
drives toepen's site against `GAME=toepen scripts/dev-server`. Other
scripts start their own Chromium: `manual-shot.mjs` (18120, 9321),
`manual-app.mjs` (18121, 9321), `sound-render.mjs` (9331); `cards-shot.mjs`
needs `scripts/chrome 9311` and a static server on 18110.

- **Known flaky**: `app-screens.mjs` fails on and off at the review steps
  after game over (score sheet, last potje, replay), most often on narrow
  phones, and on main too. Run the same command on main before calling such
  a failure a regression.
- **In a git worktree**, link the main checkout's packages
  (`ln -s <main checkout>/test/ui/node_modules test/ui/node_modules`) and
  start `scripts/dev-server` and `scripts/chrome` from the worktree, so they
  serve its sources. Remove the link before committing: `.gitignore`'s
  `node_modules/` does not match a symlink.
