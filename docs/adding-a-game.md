# Adding a game

A game is a site of its own, built from the shared table, shell and
deployment templates ([architecture.md](architecture.md)). Klaverjas and
toepen are the two so far; presidenten, pesten and rikken could follow.
This file says what each of them needs, what the platform does not offer
yet, and the steps from rules to a public site.

## What each game needs

| | Klaverjas | Toepen | Presidenten | Pesten | Rikken |
|---|---|---|---|---|---|
| Players | 2–4 | 2–6 (rules: 8) | 3–8 | 2–8 | 4 |
| Cards | 32 | 32 | 52 (+ jokers) | 52 + 2 jokers, two decks for many | 52 |
| Hand | 8 (10, 16) | 4 | all dealt: 6–18 | 7, grows | 13 |
| Kind | tricks, trump | tricks, only the last counts | climbing: sets on a pile | shedding | tricks, trump |
| Sides | 2 teams | each alone | each alone, ranks between rounds | each alone | per contract, **hidden** partner |
| Before play | trump or bids | was (all at once), armoede | card exchange between ranks | — | auction of contracts |
| Special | roem, signals | stakes, passing mid-trick | pass rounds, multi-card plays | draw pile, direction, specials | misère, open misère |
| Match | fixed hands | until one is left | rounds, ranks | first out | points per contract |

Which shared capabilities each uses:

| Capability | Klaverjas | Toepen | Presidenten | Pesten | Rikken |
|---|---|---|---|---|---|
| Seats on an ellipse, 2–8 | (4 fixed) | yes | yes | yes | (4) |
| Everyone answers at once (`Table.Think`) | — | the was | card exchange | last-card call | — |
| Hidden sides in the view | — | — | — | — | yes |
| 52 cards and jokers | — | — | yes | yes | yes |
| Big hands, multi-select | — | — | yes | yes | — |
| Piles | — | — | yes | yes | — |

What of this the platform does not have yet (jokers, more than six seats
in the lobby, the extras such as hints and lessons) is listed in
[architecture.md, "What is not generic yet"](architecture.md#what-is-not-generic-yet).

## The folder

A game is one folder: `games/G/` (say `games/pesten/`), or `extra/G/` for
a game of the overlay ([below](#the-overlay)). The folder, its settings
file and the game have one name, `G`: lower case letters, digits and
hyphens, as its pod, units, images and game log are named, and neither
`all` (every game, for `make`) nor `server` (the link to the binary in
the server image). A pull request that adds a game touches only its
folder:

```
games/G/
  G.mk                the settings: TITLE, VERB, SITE, ADDR, DEV_PORT, E2E_PORT, E2E_SIM
  README.md           its design: rules as implemented, options, Go APIs, protocol and screens
  G/ Gbot/ Gserver/   its Go packages, jannie/games/G/… (jannie/extra/G/… in the overlay)
  cmd/G/              the server's main package: the AI adapter and platform/serve
  web/                its site, served together with platform/web
  test/               its JS: unit tests (*.test.mjs), its simulation for make e2e, and
                      facts.mjs, what the shared tests need to know of it
```

Klaverjas and toepen came before this and keep a few parts outside their
folders: their main packages are `cmd/klaverjas` and `cmd/toepen`, whose
names are those of the binaries their pods' health checks run, their
simulations and JS tests are in `test/`, and klaverjas's server side is
still built into `platform/server`
([architecture.md, "What is not generic yet"](architecture.md#what-is-not-generic-yet)).

Everything else finds the games by their folders, `games/*/*.mk` and
`extra/*/*.mk`; a settings file not named after its folder, or a name in
both `games/` and `extra/`, stops `make`:

- **`make`**: `GAME=G` reads `G.mk` from the folder; `make install`,
  `deploy`, `quadlet` and the rest render the game's units from
  `deploy/game*.in` ([deployment.md](deployment.md)), and `GAME=all` and
  the targets without `GAME` go through every game.
- **`scripts/dev-server`**, so `make dev` and `make e2e`: runs the main
  package, `cmd/G` or `<folder>/cmd/G`, serving `platform/web` and the
  folder's `web/`.
- **The `Containerfile`**: builds every game's main package, `cmd/G` or
  `<folder>/cmd/G` (another command in a folder's `cmd/` is not built),
  into a binary named after the game, `/G` in the game's server image;
  the web image takes the folder's `web/`
  ([deployment.md, "Images"](deployment.md#images)).
- **`make test`**: `go vet ./...` and `go test -short ./...` cover every
  package of the module, the overlay's included; `node --test` runs the
  shared JS tests and every `<folder>/test/*.test.mjs`; and
  `scripts/deploy-test` checks every game's settings, units and builds.
- **The shared tests** go through every game they find:
  `test/sites.test.mjs` its site (its own files, the request budget, no
  other game named), `test/layout.test.mjs` its imports (no other game's,
  the main package only the platform's and its folder's, and its import
  table), `test/docs.test.mjs` its links and references to docs, and
  `test/ui/app-icons.test.mjs` its icons and link preview;
  `test/ui/og-image.mjs --site G` renders its `og.png`.

### Facts for the shared tests

`test/facts.mjs` in the game's folder says, in named exports, what the
shared tests need to know of the game; they import it when it is there.
Klaverjas's and toepen's are examples.

| Export | What | Without it |
|---|---|---|
| `felt` | `'r'`, `'g'` or `'b'`: the felt's dominant colour channel, which the corners of the maskable icon show (`test/ui/app-icons.test.mjs`) | a game with a site fails that test |
| `scene` | the link preview that `test/ui/og-image.mjs` renders: `bg`, the felt's colour `stops`, the `emblem` (SVG in a 64 × 64 box), `title`, the lines `t1` and `t2`, `t2color`, and the fan's card `codes` | `og-image.mjs` refuses the site |
| `mention` | the text, in lower case, that names the game on another game's site (`test/sites.test.mjs`; klaverjas: `klaverj`, since *klaveren* is a suit) | the first four letters of `G` |
| `imports` | the import table of the game's Go packages (`test/layout.test.mjs`): for each package, a path in the folder (`rules`, `cmd/G`), what it may import besides itself and the packages under it: paths in the folder (`.` for all of it), the platform's (`platform`, `platform/cards`) and other modules' (`github.com/…`); the standard library always. With a table, every Go file in the folder belongs to one of its packages | the general rules only |

## The overlay

Private games live in a repository of their own, checked out as `extra/`
in a checkout of this one:

```sh
git clone <the private repository> extra
make test                  # its packages and tests as well
make dev GAME=<game>       # one of its games from source
make deploy GAME=<game>    # and every other target, as for a game of games/
```

Its root holds one folder per game, each as [above](#the-folder):
`extra/G/G.mk` and so on. Git ignores `extra/` here (`.gitignore`), so
nothing of it reaches this repository. It must be a clone inside the
checkout, not a symlink to one elsewhere: `scripts/go` mounts only the
checkout, and the image build cannot follow a link out of it. Its Go code is part of the module
`jannie`, with import paths `jannie/extra/G/…` and no `go.mod` of its own;
it imports `platform/` as any game does, and nothing here imports it.
`go vet ./...`, `go test ./...` and the shared tests take it in when it is
there and work without it.

The image builds copy `extra/`, without its `.git`, and podman refuses to
copy a directory that is not there: `make image-server` and `make
image-web` make an empty one first, and a plain `podman build` needs
`mkdir -p extra`. The revision of a game of the overlay, its images'
label and tag and the version in `/api/health`, names both commits, this
repository's and the overlay's after a dot (`<commit>.<overlay commit>`,
the second shortened to 12 characters), with `-dirty` when either tree
differs from its commit; so `make deploy` of one of its games refuses a
change in either, and an `extra/` that is not a git checkout
([deployment.md, "Make targets"](deployment.md#make-targets)). The games
of `games/` keep this repository's commit alone. A deploy builds a new
server for a game of the overlay when its code changed since either
commit, its folder in `extra/` being part of it.

## Checklist

A game `G` (say `pesten`) is ready to go public when every step below is
done; `make test` checks the ones in the repository. The paths are in the
game's folder.

1. **Rules and tests:** `G/`, the rules engine: a pure state machine with
   a view per seat; table-driven tests and thousands of random matches.
2. **Bots and an arena:** `Gbot/` at three levels, with an arena test in
   `make test-all` that shows each level beats the one below it, and chat
   lines and bios for the personas.
3. **Server package:** `Gserver/`, the game on the table's exported API
   (`server.Game` on `*Table`,
   [server.md, "The Game API"](server.md#the-game-api)), tested with
   `platform/server/servertest`; the toy game in `toy_test.go` is the
   template.
4. **Command:** `cmd/G/`, the AI adapter and `platform/serve`; the binary
   is named after the game (the units' `HealthCmd` runs `/G`). It imports
   only `platform/` and the game's folder, and no package of the folder
   imports another game's (`test/layout.test.mjs` checks both; an import
   table in `test/facts.mjs` can say more).
5. **Web:** `web/` with `index.html` (`<title>TITLE</title>`, `@SITE@` in
   the `og:image`, `<meta name="version" content="@VERSION@">` and, for
   the support button, `<meta name="support" content="@SUPPORT_URL@">`;
   `scripts/deploy-test` checks the title, the support meta and that the
   three placeholders are there), `manifest.webmanifest` (name `TITLE`),
   `favicon.svg`, `icon-full.svg` and the rendered PNG icons, `og.png`,
   `js/game.js` and its table, and its stylesheet, linked after `app.css`
   ([frontend.md, "Stylesheets"](frontend.md#stylesheets)); no path that
   `platform/web` has too, and within the request budget
   ([frontend.md, "One site per game"](frontend.md#one-site-per-game)).
   `felt` and `scene` in `test/facts.mjs`
   ([above](#facts-for-the-shared-tests)); `test/ui/og-image.mjs --site G`
   then renders `og.png`.
6. **Settings:** `G.mk`, a copy of another game's with every value
   changed: `TITLE`, `VERB`, `SITE`, `ADDR` on the next free odd port `P`,
   `DEV_PORT` `10000+P`, `E2E_PORT` `10001+P`, and `E2E_SIM`, its
   simulation ([deployment.md, "Settings"](deployment.md#settings)).
7. **End-to-end:** the simulation `E2E_SIM` names, a path from the
   repository's root such as `games/G/test/e2e.mjs`, which plays full
   games over the websocket on the shared `test/e2e/lib.mjs`
   ([test/e2e/README.md](../test/e2e/README.md)).
8. **Tests:** `make test` (`scripts/deploy-test` checks the settings, the
   units, the main package and `web/`), `make e2e GAME=G`, the UI checks
   against `make dev GAME=G`.
9. **Docs:** `README.md` in the folder (its rules, options, Go APIs,
   protocol, screens and simulation); once it is public, its line in the
   list of games of the repository's `README.md`.
10. **Outside the repository:** a host in the reverse proxy, `SITE` →
    `http://ADDR`, as [deployment.md, "Reverse proxy"](deployment.md#reverse-proxy)
    says, with a rate limit for the name that lets the page budget through
    before the link goes out; the volume `G-games` out of backups kept
    longer than 12 months; the images `localhost/G-*` in your vulnerability
    scans and monitoring, if you have them.
11. **Deploy:** `make install GAME=G && make deploy GAME=G`, then the
    checks of [deployment.md, "Checks"](deployment.md#checks).

## Order

1. **Presidenten**: a new kind of rules (sets on a pile, passing, ranks)
   and the card exchange on `Table.Think`.
2. **Pesten**: shedding with specials as options (as toepen's was and
   armoede), the draw pile and direction; easy bots; jokers and big hands.
3. **Rikken**: a trick engine like klaverjas's, contracts and their
   scores, the hidden partner, open misère.
