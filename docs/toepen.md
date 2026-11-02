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
- **Vuile was** (option `was`; on the site every hand that may be handed
  in is called a *vuile was*, four pictures also a *witte was*): right
  after the deal everyone in the round says, all at once, whether they
  claim one: three pictures (boer, vrouw, heer or aas) and a 7, or four
  pictures. A claim stays secret until everyone has answered or the time
  is up (no answer: no claim). The claims are settled one by one from
  voorhand: the others still in, in turn from the claimant's left, are
  asked whether they check it. The first to check settles it: a real one
  costs the checker a point and the claimant hands the four cards in for
  four new ones from the stock; a bluff costs the claimant a point
  (*betrapt*), who then takes the cards back and plays the round out with
  them face up (option `bluf`, on by default), or sits the round out
  (`bluf` off). If nobody checks, the claimant gets four new cards
  whatever the hand was. Every claim needs four cards in the stock (with
  six players: two claims; eight players: none).
- **Again**: who got new cards is asked again, alone, in another time for
  a vuile was (`wasRound` 2, 3, …), and may hand in again, as long as the
  stock holds four cards. The cards handed in lie face down in front of
  the claimant (a pile on the site).
- **On armoede** only a real vuile was may be claimed (`CanClaim` is false
  without one, `Was` refuses it): the hand is laid open on the table for a
  moment (a `Check` with `shown`) and handed in, without anyone being
  asked.
- **Armoede** (option `armoede`): when someone still in the round has
  `limit − 1` points, the stake starts at 2 and everyone else still in, in
  order from voorhand, goes along or passes (passing: 1 point); there is
  no overtoepen on this question. Nobody is the toeper then; who is on
  armoede may not toep at all.
- **Koningsspel** (option `koning`, on by default): when everyone still in
  the match stands on `limit − 1`, each gets eleven cards and, in turn from
  voorhand, lays three away face down (`PhaseDiscard`, `Discard`), playing
  with eight. With three players the deck holds ten each (two laid away),
  with four eight (none), with five or six as many as it holds (six, five).
  There is no vuile was, no armoede and no toep (nobody may raise a stake
  that puts them out). Who takes the last trick wins the match; the others
  go out.
- **Play**: voorhand leads (the next player still in, when voorhand is
  out of the round). Follow suit when you can; otherwise any card, which
  cannot win. The highest card of the suit led takes the trick; its
  winner leads the next.
- **Toepen**: on your turn to play, before your card, you may toep: the
  stake goes up by one, and the others still in, from your left, say
  whether they go along (*meegaan*), pass (*passen*) or **overtoep**:
  raise the stake once more, after which everyone else still in, the
  toeper too, is asked again from the overtoeper's left. Who passes takes
  the stake from before the last raise as penalty points and is out of the
  round (*gepast*). Nobody may toep twice in a row: after a toep someone
  else must toep first. When everyone else has passed, the last to raise
  wins the round.
- **No toep when out already**: who would be out by losing at the present
  stake (points + stake ≥ limit), or stands on armoede, may neither toep
  nor overtoep.
- **Anti-lijntoep** (option `lijntoep`, off by default): who passed on the
  last two toeps it was asked about (across rounds; armoede's question does
  not count) must go along, or overtoep, on the third; going along starts
  the count again.
- A player who passes after playing to the current trick leaves the card
  on the table, but it no longer counts: the trick goes to the highest card
  of the suit led among the players still in, or, when none of them
  followed, of the suit of the first card of a player still in. When the
  toeper passes on an overtoep before its card and everyone else still in
  has played, the trick is complete then.
- **The round**: who takes the last trick (the fourth; the eighth in the
  koningsspel) wins it; every other player still in takes the stake as
  penalty points. **Boer** (option `boer`, on by default): who takes the
  last trick with a boer has a penalty point taken off, if it has one.
  Penalty points that reach the limit during the round (a check, a pass)
  take that player out of the round at once.
- Choices where the sources differ: a toep only on your own turn (the
  "more official" rule; others allow it any time); the deal passes
  clockwise (rather than to the winner); the koningsspel's eleven cards
  and three laid away, which the deck holds for two, is ten and two for
  three and eight for four; laying away goes in turn (so a player who is
  away gets the takeover question, as for any turn); the boer takes one
  point off (rather than doubling the stake); anti-lijntoep
  counts every toep (rather than only the first of a round); there is no
  *blind toepen* and no cap on toepen.

`Deal` is a pure state machine (`NewDeal`, `Discard`, `Was`, `CloseWas`,
`Check`, `Toep`, `Overtoep`, `Answer`, `Play`, `View`, `Result`), `Match` the
points, the passes in a row and the dealer. Tests: every rule above,
table-driven, and 3,000 random matches at 2–8 players and every rule set
checking that each round ends, points only grow (but for the boer), the
32 cards are always somewhere exactly once, the koningsspel comes exactly
when everyone left is on armoede and ends the match, and the match ends
with one player left.

## 2. Options

| Key | Values | Default | Meaning |
|---|---|---|---|
| `players` | 2–6 | 4 | Seats at the table; empty seats at the start get random bots |
| `limit` | 10, 15 | 10 | Penalty points that put a player out |
| `was` | bool | true | The vuile was (§1) |
| `armoede` | bool | true | Armoede (§1) |
| `koning` | bool | true | The koningsspel (§1) |
| `boer` | bool | true | The last trick with a boer: a point off (§1) |
| `lijntoep` | bool | false | Anti-lijntoep (§1) |
| `bluf` | bool | true | A caught bluff plays on face up, else sits the round out (§1) |
| `ai` | `makkelijk`, `normaal`, `sterk` | `normaal` | Strength of every bot (§5) |
| `tempo` | `rustig`, `normaal`, `snel` | `normaal` | Pacing (§3) |
| `seed` | 1..999999999, or 0 / null | 0 | As klaverjas's (design §3): the same seed deals the same cards |

`s.opts` has exactly these eleven keys (default `{"players":4, "ai":
"normaal", "tempo": "normaal", "seed": 0, "limit": 10, "was": true,
"armoede": true, "koning": true, "boer": true, "lijntoep": false,
"bluf": true}`). Keys of klaverjas are not options here: `create` and
`opts` ignore them. In the lobby a change is all or nothing, and refused
with "Kies 2 tot en met 6 spelers.", "Speel tot 10 of tot 15 strafpunten.",
or "Ongeldige waarde voor KEY." for a switch that is not a boolean (`null`
too); a `create` skips a bad value and keeps the default. There is no
training and no expert mode: a `create` that asks for either plays an
ordinary game.

## 3. Server (`internal/toepenserver`, `cmd/toepen`)

Toepen implements the table's `server.Game` (design §4.3) on its exported
`*Table`: `toepenserver.New(ai)` with seats (2, 6, 4), `Options{Limit, Was,
Armoede, Koning, Boer, Lijntoep, Bluf}` and toepen's own pacing; its `AI`
gives the personas, a `Brain` per bot seat (`Discard`, `Was`, `Check`,
`Toep`, `Overtoep`, `Answer`, `Play`) and the chat, and
nil plays plain bots. `cmd/toepen` runs it with toepen's bots
(`internal/toepbot`) and the shared personas (`internal/persona`) with
toepen's bios; it does not import klaverjas's packages. Room phases:
`lobby`, `discard` (the koningsspel), `was`, `check`, `toep`, `play`,
`handEnd`, `gameOver`.

- After the deal pause, the **time for a was** opens (the was window:
  rustig 10 s, normaal 8 s, snel 6 s; `nextAt` says when it ends; `turn` is
  -1). Every human in the round answers with `was`; every bot (or
  substitute) in the round decides in the background (`Table.Think`) and
  answers after its think time. The time ends when everyone has answered
  or it runs out. A late or repeated `was` is ignored without a reply; a
  claim when the stock has no four cards left for it is refused ("De
  stapel is op: er kan niemand meer wassen."), as is a bluff on armoede
  ("Op armoede mag je alleen een echte vuile was inleveren."). An
  absent player is not waited for here: not claiming is no decision made
  for them. When claims got new cards, another time for a was opens after
  the announcement, for those claimants only.
- A vuile was on armoede is told (`wasDone` with `shown`) once the claims
  are announced, and lies open for three times `announce`.
- Pauses: the claims and a toep are announced for the pace's `announce`,
  armoede for twice that, a checked was (its hand shown) for three times
  that; a completed trick lies for `trick`. The round summary moves on
  after rustig 6 s, normaal 4.5 s, snel 3 s, also for one player alone;
  `ready` from everyone connected moves on at once.
- Bots decide once per turn as at klaverjas's table (design §6). The
  takeover question works as there in `check`, `toep` and `play`.
- Chat: bots greet, toep, overtoep, and say they go along or pass only
  with that decision, so the line and the deed agree; they claim a vuile
  was, are caught, check rightly or wrongly, win a round (with the boer),
  lose one, greet the koningsspel, go out, and win or lose the match
  (`toepbot.Chat`, per persona; the limits of design §5).
- Game log (design §6, its own volume `toepen-games`): `match` (`game`:
  "toepen", and `opts` the eleven of §2; no `training` or `expert`), then
  per round `{"t":"round", "hand", "dealer", "cards" (per seat as dealt,
  before any vuile was; "" for a seat out), "acts", "result"}` with `acts`
  the seat and then `x` and the cards laid away (the koningsspel), `w`
  (claimed a vuile was), `c1`/`c0` (checked or not),
  `t` (toep), `o` (overtoep), `a1`/`a0` (went along or passed) or a card;
  then `end` (`total`: the points, `winner`: the seat).

## 4. Protocol

Client → server, besides the table's messages of design §7 (`create`,
`join`, `sit`, `bot`, `unbot`, `opts`, `start`, `ready`, `vote`, `chat`,
`call`, `rtc`, `rematch`, `lobby`, `leave`, `ping`): `play` `{card}`,
`discard` `{cards}` (the koningsspel: exactly `lay` cards), `toep`,
`overtoep` (asked about a toep), `answer` `{play}` (true: go
along), `was` `{play}` (true: claim) and `check` `{play}` (true: check). Klaverjas's messages (`trump`, `bid`,
`why`, …) are unknown here ("Dat bericht ken ik niet."). Errors as design
§7 (`niet-jouw-beurt`, `ongeldig` with the engine's Dutch text).

The state `s`: `code`, `phase`, `opts`, `you`, `host`, `roster` (lobby),
`players` (as design §7; `cards` 0 for a seat out of the round), `turn`,
`takeover`, `nextAt` (the end of the time for a was, or of the summary),
`winner` (the seat left); `handNo` (the round), `dealer`, `voorhand`,
`stake`, `toeper` (-1; the last to raise), `armoedeToep`, `koning`, `size`
(cards each plays with: 4, 8 in the koningsspel), `lay` (the koningsspel,
your turn: how many to lay away), `laid` (per seat, how many it laid
away), `wasRound` (the time for a
was: 1, 2, …), `canRaise` and `mustStay` (asked about a toep: you may
overtoep; you may not pass), `open` (per seat: its hand when played face
up after a bluff, else empty), `points` (per seat, now; the boer takes one
off at the last trick), `status` (per seat: `in`, `gepast`, `betrapt`,
`eruit`, `uit` for out of the match), `armoede` (per seat), `washed`,
`answered` (the time for a was), `claims` (once that time is over),
`canClaim`, `claimant` (-1), `asking` (who still answers, in order),
`checks` (the settled claims, always an array: `{claimant, checker, kind,
cards, shown}`), `stock`, `hand` (yours, sorted), `legal` and `rule` (your
turn to play), `canToep`, `trick` (`{leader, cards, winner}`; the trick
just taken until `collect`), `lastTrick`, `tricks` (taken this round) and
`rounds` (the score sheet: `{hand, dealer, winner, stake, tricks, boer,
koning, gains, points, out}`, `gains` -1 for the boer).

Events: `deal` `{handNo, dealer, koning}`; `discard` `{seat, n}`; `claims` `{seats}`; `check`
`{seat, claimant, check}`; `wasDone` `{claimant, checker, kind, cards,
genuine, washed, shown}`; `toep` `{seat, stake, over}` (over: an
overtoep); `answer` `{seat, stay, points}`;
`armoede` `{seats, stake}`; `play` `{seat, card}`; `trick` `{winner,
last}`; `collect` `{winner}`; `handEnd` `{result}` (a score row);
`gameOver` `{total, winner}`; and the seat events of design §7.

## 5. Bots (`internal/toepbot`)

All levels play their cards by the same rules of thumb: keep the best card
for the last trick, lead low from another suit, take the trick before the
last with a card other than the best, throw the weakest card when you
cannot follow (also with the eight cards of the koningsspel).
**Sterk** plays every legal card out in sampled deals of the hidden cards
(240; within the suits each player showed it lacks, hands played face up
as they are, and weighted towards a strong hand for whoever toept) and
keeps the one that wins most. Toepen, overtoepen, going along and claiming
a vuile was follow the chance to take the last trick
(sampled: makkelijk 12 deals, normaal 48, sterk 240) against what is at
stake: passing costs the stake before the toep, losing the stake, and going
out counts as five points more (so who is out either way goes along).
**Memory**: the match keeps a public record per seat (`Record`, in every
view): its toeps whose cards came on the table (it stayed in to the last
trick), of which those without a card above an aas count as bluffs, and
its checked claims of a vuile was, bluff or not. A seat's bluff rate is
(bluffs + 1) / (seen + 8). Normaal and sterk weigh a toeper's sampled hand
by it (a likely bluffer's hand counts as random; sterk reads a toep twice
as sharply as normaal), go along more readily against a known bluffer
(the risk of going along scaled by 1 − 1.2 × (rate − 1/8), between 0.5 and
1.15), and take the claimant's rate as the chance of a bluff when they
check. Makkelijk remembers nothing. **Bluffing, balanced**: so that a
bot's toep is not simply real, a hand with little chance (below 15%)
toeps now and then at any stake (sterk 2.5–9.5%, normaal 4–14% by
boldness; × 0.6 above stake 2, × 0.25 when being caught would put it
out), a hand just under the bar sometimes toeps anyway, and now and then a
hopeless hand overtoeps while the stake is at most 3.
In the koningsspel sterk tries every choice of cards to lay away in the
same 24 sampled deals and keeps the eight that take the last trick most
often (against normaal it wins 102 of 150 koningsspellen where the
weakest-cards rule wins 74); normaal lays away its weakest cards,
makkelijk now and then any. Overtoepen asks for a surer hand than a toep, and more so the higher the
stake (never at 5 or more; makkelijk only with a near-certain last trick),
so two bots do not raise each other without end. Under anti-lijntoep a bot
goes along when it must. A real vuile was is always claimed (makkelijk
70%); a hopeless hand is a bluff now and then, never on armoede. Checking weighs the chance of a real was among the cards unseen
against a bluff rate. The persona's aggression lowers the bar for toepen
and raises the bluffs. The arena test (2 × 1,500 and 2 × 700 duplicate
rounds at four) has sterk take fewer points than normaal, and normaal than
makkelijk (with overtoepen, the memory and the bluffs: sterk 2.71 against
normaal 2.80, normaal 2.57 against makkelijk 3.02 penalty points per round
for two seats; the arena keeps no record, so a bluff there buys nothing:
it costs sterk about 0.03 a round, the price of being unreadable to
people). A
sterk decision takes about 4 ms.

## 6. The site (`web/toepen`)

The shell of design §9 with toepen's `game.js`:

- Home: the wordmark *Toepen* and *Wie haalt de laatste slag?*, the name,
  *Snel spelen* (its subtitle names what differs from the defaults), *Nieuw
  spel* (full width: there is no Oefenen), *Meedoen* with a code,
  *Spelregels en bediening*, and in the footer "Toepen zoals aan de
  keukentafel." with the version and *Support deze app*.
- New-game sheet and lobby: *Spelers* 2–6, *Eruit bij*, *Vuile was*,
  *Betrapte bluf* (*Open spelen* / *Potje uit*), *Armoede*,
  *Koningsspel*, *Boer* (*Punt eraf* / *Gewoon*), *Anti-lijntoep*,
  *AI-sterkte*, *Tempo*, *Seed*; options remembered in `kj.opts` (its own
  origin). The lobby seats up to six on an ellipse as at the table; the
  others are *tegenspeler*.
- The table (`js/table.js`, pure parts in `js/rules.js`): the seats on an
  ellipse over the top of the felt (you at the bottom, the others clockwise
  from your left), the trick around the stake chip, your cards (four;
  eight overlapping in the koningsspel), and above them the question of
  the moment with its buttons (in the koningsspel first *Wegleggen*, once
  the cards to lay away are tapped; *Vuile was!* / *Geen* with the countdown,
  only *Geen* on armoede without a real one; *Controleren* / *Laten
  gaan*; *Meegaan* / *Overtoepen* / *Passen* with what passing costs,
  *Passen* gone under anti-lijntoep; *Toep!* on your turn, and when you
  may not toep, why: on armoede, out at the stake already, the
  koningsspel, or you raised last), the takeover question, a summary after every round
  (the boer's point off as 🏆 -1), game over, *Stand* (the points and every
  round) and the manual. A vuile was handed in flies face down to a small
  pile beside the claimant's seat (×n when more than once; the cards laid
  away in the koningsspel lie there too) and four new
  cards come from the middle; on armoede the hand is shown in the middle
  first; a caught bluffer's cards lie face up at its seat (*speelt
  open*). Keys: 1–4 (1–8) play a card, T toeps or overtoeps. Sound
  `knock` for a toep.
- The manual (*Spelregels toepen*, from the table and the home screen): the
  shell's tabs and scrolling pane (as klaverjas's handleiding) with
  *Spelregels*, *Extra regels* (each option: at a table how it is played
  there, from the home screen what it is and its default), *Tips* (the
  bots' rules of thumb), *Begrippen* and *Bediening*.
- Expert mode: the robot in the top bar and the sheet *Redenering van de
  AI* (§8).
- Game over → *Spelers of regels wijzigen*: the overlays close when the
  room is back in the lobby (`game.sync`).
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

## 8. Redenering van de AI (expert mode)

Five taps on the version under the home screen switch the expert mode on
or off for this device (`kj.expert`). In it, alone with bots (nobody else
at the table is a person, so it is help nobody else lacks), a robot in the
top bar asks the reasoning for your own decision now: `why` (no fields).
The server works it out in the background (`Table.Background`; one at a
time per table) and puts it in your state only, as `why`, while that
decision stands; with other people at the table, out of turn, or without
an AI that explains, `why` is refused (`ongeldig`).

The reasoning (`toepbot.Explain`, from your view only, so it gives none of
the others' cards away) is sterk's at average boldness, with the rule of
thumb of normaal: `{decision, advice, why, rule, ruleCard, chance,
options, worlds}`, `options` each `{label | cards, value, points, best}`:

- **kaart**: per legal card the share of 240 sampled deals in which you
  take the last trick with it, and, when you may, *Toepen* against the
  bar for a toep;
- **antwoord**: *Meegaan* (expected penalty points: the stake times the
  chance to lose, going out counting five more), *Overtoepen* (the chance
  against its bar) and *Passen* (the stake before the toep); with what the
  table saw of the toeper's bluffs;
- **was**: whether the hand is a real vuile was, and the chance with it;
- **controle**: the chance that the claim is a bluff, from the hands the
  cards you do not see make and the claimant's record, against the bar
  (50%; 85% when a wrong check puts you out);
- **wegleggen**: the five best choices of cards to lay away in the
  koningsspel, each with its share of 48 deals.

The rules of thumb are also the manual's tab *Tips*.
