# Adding a game

A game is a site of its own, built from the shared table, shell and
deployment templates ([architecture.md](architecture.md)). Klaverjas and
toepen are the two so far; bridge is next, and presidenten, pesten and
rikken could follow. This file says what each of them needs, what the
platform does not offer yet, and the steps from rules to a public site.

## What each game needs

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

What of this the platform does not have yet (the 52-card deck,
`controller`, hidden sides, more than six seats in the lobby, the extras
such as hints and lessons) is listed in
[architecture.md, "What is not generic yet"](architecture.md#what-is-not-generic-yet).

## Checklist

A game `G` (say `pesten`) is ready to go public when every step below is
done; `make test` checks the ones in the repository.

1. **Rules and tests:** `games/G/G`, the rules engine: a pure state machine
   with a view per seat; table-driven tests and thousands of random
   matches.
2. **Bots and an arena:** `games/G/Gbot` at three levels, with an arena
   test in `make test-all` that shows each level beats the one below it,
   and chat lines and bios for the personas.
3. **Server package:** `games/G/Gserver`, the game on the table's exported
   API (`server.Game` on `*Table`,
   [server.md, "The Game API"](server.md#the-game-api)), tested with
   `platform/server/servertest`; the toy game in `toy_test.go` is the
   template.
4. **Command:** `cmd/G`, the AI adapter and `platform/serve`; the binary is
   named after the game (the units' `HealthCmd` runs `/G`). It imports
   only `platform/` and `games/G/`, and no package of `games/G` imports
   another game's (`test/layout.test.mjs` checks both).
5. **Web:** `games/G/web/` with `index.html` (`<title>TITLE</title>`,
   `@SITE@` in the `og:image`, `<meta name="version" content="@VERSION@">`
   and, for the support button, `<meta name="support"
   content="@SUPPORT_URL@">`; `scripts/deploy-test` checks the title, the
   support meta and that the three placeholders are there),
   `manifest.webmanifest` (name `TITLE`), `favicon.svg`, `icon-full.svg`
   and the rendered PNG icons, `og.png`, `js/game.js` and its table, and
   its stylesheet; no path that
   `platform/web` has too, and within the request budget
   ([frontend.md, "One site per game"](frontend.md#one-site-per-game)).
   Add it to the felt table of `test/ui/app-icons.test.mjs` and a scene to
   `test/ui/og-image.mjs`.
6. **Settings:** `games/G/G.mk`, a copy of another game's with every value
   changed: `TITLE`, `VERB`, `SITE`, `ADDR` on the next free odd port `P`,
   `DEV_PORT` `10000+P`, `E2E_PORT` `10001+P`, and `E2E_SIM`, its
   simulation ([deployment.md, "Settings"](deployment.md#settings)).
7. **End-to-end:** `test/e2e/G.mjs`, which plays full games over the
   websocket.
8. **Containerfile:** a target `server-G`, a copy of `server-klaverjas` with
   the name changed in its four places.
9. **Tests:** `make test` (`scripts/deploy-test` checks the settings, the
   units, the target, `cmd/G` and `games/G/web`), `make e2e GAME=G`, the UI
   checks against `make dev GAME=G`.
10. **Docs:** `games/G/README.md` (its rules, options, Go APIs, protocol
    and screens), the games table of
    [deployment.md, "The games"](deployment.md#the-games), this file's
    tables, and `README.md`.
11. **Outside the repository:** a host in the reverse proxy, `SITE` →
    `http://ADDR`, as [deployment.md, "Reverse proxy"](deployment.md#reverse-proxy)
    says, with a rate limit for the name that lets the page budget through
    before the link goes out; the volume `G-games` out of backups kept
    longer than 12 months; the images `localhost/G-*` in your vulnerability
    scans and monitoring, if you have them.
12. **Deploy:** `make install GAME=G && make deploy GAME=G`, then the
    checks of [deployment.md, "Checks"](deployment.md#checks).

## Order

1. **Bridge**, next: the auction with a bidding system the bots and hints
   share, the dummy (`controller`), the 52-card deck, rubber or Chicago
   scoring; card play by sampling as klaverjas's sterk. It
   is the second trick game with trump after klaverjas, so a shared trick
   kit is worth extracting then.
2. **Presidenten**: a new kind of rules (sets on a pile, passing, ranks)
   and the card exchange on `Table.Think`.
3. **Pesten**: shedding with specials as options (as toepen's was and
   armoede), the draw pile and direction; easy bots; jokers and big hands.
4. **Rikken**: a trick engine like klaverjas's, contracts and their
   scores, the hidden partner, open misère.
