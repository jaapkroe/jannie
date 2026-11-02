# Toepen — design and contracts

The site **toepen.kroes.dev**: toepen and nothing else, for two to six
players, with friends and bots. It is played at the same table as klaverjas
(rooms and codes, seats and the lobby, bots, chat, calls, reconnects, the
takeover question, limits: [`design.md`](design.md) §6 and the table's
messages of §7), from its own server binary, web image and pod; how the
sites share code is in [`games.md`](games.md). English for code and docs;
every user-visible string Dutch.

Sources: <https://nl.wikipedia.org/wiki/Toepen> and the common house rules;
where groups differ, the choice is written down here and the commonest
variants are options.

## 1. Rules as implemented (`internal/toepen`)

- The 32 cards of klaverjas, under the same codes. Within a suit, low to
  high: boer, vrouw, heer, aas, 7, 8, 9, 10 (`Strength`). No trump. Two to
  six players at the table (the engine takes up to eight), each for
  themselves.
- Everyone starts at 0 penalty points (*strafpunten*); who reaches `limit`
  (10 or 15) is out (*eruit*). The match goes on until one player is left:
  the winner.
- The first dealer is drawn from the match's seed; then the deal passes
  clockwise to the next player still in. Everyone still in gets four cards,
  in order from **voorhand** (the first player still in after the dealer);
  the rest of the deck is the **stock**.
- **Was** (option `was`): right after the deal everyone in the round says,
  all at once, whether they claim a was: a **witte was** is four pictures
  (boer, vrouw, heer or aas), a **vuile was** three pictures and a 7. A
  claim stays secret until everyone has answered or the time is up (no
  answer: no claim). The claims are settled one by one from voorhand: the
  others still in, in turn from the claimant's left, are asked whether they
  check it. The first to check settles it: a real was costs the checker a
  point and the claimant gets four new cards from the stock; a bluff costs
  the claimant a point and sits them out of the round (*betrapt*). If
  nobody checks, the claimant gets four new cards whatever the hand was.
  Every claim needs four cards in the stock (with six players: two claims;
  eight players: no was).
- **Armoede** (option `armoede`): when someone still in the round has
  `limit − 1` points, the stake starts at 2 and everyone else still in, in
  order from voorhand, goes along or passes (passing: 1 point). Nobody is
  the toeper then, so anyone may toep afterwards.
- **Play**: voorhand leads (the next player still in, when voorhand is
  out of the round). Follow suit when you can; otherwise any card, which
  cannot win. The highest card of the suit led takes the trick; its
  winner leads the next.
- **Toepen**: on your turn to play, before your card, you may toep: the
  stake goes up by one, and the others still in, from your left, say
  whether they go along (*meegaan*) or pass (*passen*). Who passes takes
  the stake from before the toep as penalty points and is out of the round
  (*gepast*). Nobody may toep twice in a row: after a toep someone else
  must toep first. When everyone else has passed, the toeper wins the
  round.
- A player who passes after playing to the current trick leaves the card
  on the table, but it no longer counts: the trick goes to the highest card
  of the suit led among the players still in, or, when none of them
  followed, of the suit of the first card of a player still in.
- **The round**: who takes the fourth trick wins it; every other player
  still in takes the stake as penalty points. Penalty points that reach the
  limit during the round (a check, a pass) take that player out of the
  round at once.
- Choices where the sources differ: a toep only on your own turn (the
  "more official" rule; others allow it any time); the answers are going
  along or passing only (a raise comes on your own turn); a caught bluff
  sits the round out (rather than playing on with the old cards); the deal
  passes clockwise (rather than to the winner); there is no *blind toepen*
  and no cap on toepen.

`Deal` is a pure state machine (`NewDeal`, `Was`, `CloseWas`, `Check`,
`Toep`, `Answer`, `Play`, `View`, `Result`), `Match` the points and the
dealer. Tests: every rule above, table-driven, and 3,000 random matches at
2–8 players and every rule set checking that each round ends, points only
grow, the 32 cards are always somewhere exactly once, and the match ends
with one player left.

## 2. Options

| Key | Values | Default | Meaning |
|---|---|---|---|
| `players` | 2–6 | 4 | Seats at the table; empty seats at the start get random bots |
| `limit` | 10, 15 | 10 | Penalty points that put a player out |
| `was` | bool | true | The witte and vuile was (§1) |
| `armoede` | bool | true | Armoede (§1) |
| `ai` | `makkelijk`, `normaal`, `sterk` | `normaal` | Strength of every bot (§5) |
| `tempo` | `rustig`, `normaal`, `snel` | `normaal` | Pacing (§3) |
| `seed` | 1..999999999, or 0 / null | 0 | As klaverjas's (design §3): the same seed deals the same cards |

`s.opts` has exactly these seven keys. Keys of klaverjas are not options
here (a `create` ignores them; `opts` refuses none of them by itself, they
are simply unknown), and `players` outside 2–6 is refused ("Kies 2 tot en
met 6 spelers."). There is no training and no expert mode: a `create` that
asks for either plays an ordinary game.

## 3. Server (`internal/toepenserver`, `cmd/toepen`)

Toepen implements the table's `server.Game` (design §4.3) on its exported
`*Table`; `cmd/toepen` runs it with toepen's bots (`internal/toepbot`) and
the shared personas with toepen's bios. Room phases: `lobby`, `was`,
`check`, `toep`, `play`, `handEnd`, `gameOver`.

- After the deal pause, the **time for a was** opens (the was window:
  rustig 10 s, normaal 8 s, snel 6 s; `nextAt` says when it ends; `turn` is
  -1). Every human in the round answers with `was`; every bot (or
  substitute) in the round decides in the background (`Table.Think`) and
  answers after its think time. The time ends when everyone has answered
  or it runs out. A late or repeated `was` is ignored without a reply. An
  absent player is not waited for here: not claiming is no decision made
  for them.
- Pauses: the claims and a toep are announced for the pace's `announce`,
  armoede for twice that, a checked was (its hand shown) for three times
  that; a completed trick lies for `trick`. The round summary moves on
  after rustig 6 s, normaal 4.5 s, snel 3 s, also for one player alone;
  `ready` from everyone connected moves on at once.
- Bots decide once per turn as at klaverjas's table (design §6). The
  takeover question works as there in `check`, `toep` and `play`.
- Chat: bots greet, react to a toep (the toeper, or someone else), pass,
  claim a was, are caught, check rightly or wrongly, win or lose a round, go
  out, and win or lose the match (`toepbot.Chat`, per persona; the limits
  of design §5).
- Game log (design §6, its own volume `toepen-games`): `match` (its `opts`
  are the seven of §2), then per round `{"t":"round", "hand", "dealer",
  "cards" (per seat as dealt, "" for a seat out), "acts", "result"}` with
  `acts` the seat and then `w` (claimed a was), `c1`/`c0` (checked or not),
  `t` (toep), `a1`/`a0` (went along or passed) or a card; then `end`
  (`total`: the points, `winner`: the seat).

## 4. Protocol

Client → server, besides the table's messages of design §7 (`create`,
`join`, `sit`, `bot`, `unbot`, `opts`, `start`, `ready`, `vote`, `chat`,
`call`, `rtc`, `rematch`, `lobby`, `leave`, `ping`): `play` `{card}`,
`toep`, `answer` `{play}` (true: go along), `was` `{play}` (true: claim)
and `check` `{play}` (true: check). Klaverjas's messages (`trump`, `bid`,
`why`, …) are unknown here ("Dat bericht ken ik niet."). Errors as design
§7 (`niet-jouw-beurt`, `ongeldig` with the engine's Dutch text).

The state `s`: `code`, `phase`, `opts`, `you`, `host`, `roster` (lobby),
`players` (as design §7; `cards` 0 for a seat out of the round), `turn`,
`takeover`, `nextAt` (the end of the time for a was, or of the summary),
`winner` (the seat left); `handNo` (the round), `dealer`, `voorhand`,
`stake`, `toeper` (-1), `armoedeToep`, `points` (per seat, now), `status`
(per seat: `in`, `gepast`, `betrapt`, `eruit`, `uit` for out of the
match), `armoede` (per seat), `washed`, `answered` (the time for a was),
`claims` (once that time is over), `canClaim`, `claimant` (-1), `asking`
(who still answers, in order), `checks` (the settled claims: `{claimant,
checker, kind, cards}`), `stock`, `hand` (yours, sorted), `legal` and
`rule` (your turn to play), `canToep`, `trick` (`{leader, cards, winner}`;
the trick just taken until `collect`), `lastTrick`, `tricks` (taken this
round) and `rounds` (the score sheet: `{hand, dealer, winner, stake,
tricks, gains, points, out}`).

Events: `deal` `{handNo, dealer}`; `claims` `{seats}`; `check` `{seat,
claimant, check}`; `wasDone` `{claimant, checker, kind, cards, genuine,
washed}`; `toep` `{seat, stake}`; `answer` `{seat, stay, points}`;
`armoede` `{seats, stake}`; `play` `{seat, card}`; `trick` `{winner,
last}`; `collect` `{winner}`; `handEnd` `{result}` (a score row);
`gameOver` `{total, winner}`; and the seat events of design §7.

## 5. Bots (`internal/toepbot`)

All levels play their cards by the same rules of thumb: keep the best card
for the last trick, lead low from another suit, take the third trick with a
card other than the best, throw the weakest card when you cannot follow.
**Sterk** plays every legal card out in sampled deals of the hidden cards
(240; within the suits each player showed it lacks, and weighted towards a
strong hand for whoever toept) and keeps the one that wins most. Toepen,
going along and claiming a was follow the chance to take the last trick
(sampled: makkelijk 12 deals, normaal 48, sterk 240) against what is at
stake: passing costs the stake before the toep, losing the stake, and going
out counts as five points more (so who is out either way goes along). A
real was is always claimed (makkelijk 70%); a hopeless hand is a bluff now
and then. Checking weighs the chance of a real was among the cards unseen
against a bluff rate. The persona's aggression lowers the bar for toepen
and raises the bluffs. The arena test (2 × 1,500 and 2 × 700 duplicate
rounds at four) has sterk take fewer points than normaal, and normaal than
makkelijk. A sterk decision takes about 4 ms.

## 6. The site (`web/toepen`)

The shell of design §9 with toepen's `game.js`:

- Home: the wordmark *Toepen* and *Wie haalt de laatste slag?*, the name,
  *Snel spelen* (its subtitle names what differs from the defaults), *Nieuw
  spel* (full width: there is no Oefenen), *Meedoen* with a code,
  *Spelregels en bediening*, and in the footer "Toepen zoals aan de
  keukentafel." with the version and *Support deze app*.
- New-game sheet and lobby: *Spelers* 2–6, *Eruit bij*, *Was*, *Armoede*,
  *AI-sterkte*, *Tempo*, *Seed*; options remembered in `kj.opts` (its own
  origin). The lobby seats up to six on an ellipse as at the table; the
  others are *tegenspeler*.
- The table (`js/table.js`, pure parts in `js/rules.js`): the seats on an
  ellipse over the top of the felt (you at the bottom, the others clockwise
  from your left), the trick around the stake chip, your four cards, and
  above them the question of the moment with its buttons (*Was!* / *Geen
  was* with the countdown, *Controleren* / *Laten gaan*, *Meegaan* /
  *Passen* with what passing costs, *Toep!* on your turn), the takeover
  question, a summary after every round, game over, *Stand* (the points
  and every round) and *Spelregels toepen*. Keys: 1–4 play a card, T
  toeps. Sound `knock` for a toep.
- Its look: blue café felt (`css/toepen.css` overrides the shell's
  tokens), its own icons (a ten of hearts) and link preview.
- Page load: 17 requests (html, app.css, cards.css, toepen.css, favicon,
  manifest, a PNG icon, the shell's 6 modules, game.js, table.js, rules.js,
  the websocket); call.js is lazy.

## 7. Deployment

`deploy/games/toepen.mk`: SITE `toepen.kroes.dev`, ADDR `127.0.0.1:8095`,
dev port 18095, e2e port 18096 (`test/e2e/toepen.mjs`), volume
`toepen-games`; `make install GAME=toepen`, `make deploy GAME=toepen`
(deploy/README-deploy.md). Outside the repo: the NPM proxy host
toepen.kroes.dev → `http://127.0.0.1:8095` with websockets on, and the
name's rate tier in shrek-infra before the link goes out.
