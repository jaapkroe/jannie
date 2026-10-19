# Klaverjas — design and contracts

This document is the contract between the parts of the system. Code that
deviates from it must update it in the same change. English for code, comments
and docs; **every user-visible string is Dutch**.

Hosted at `https://klaverjas.kroes.dev` on `shrek` (see `/storage/shrek-infra`):
Nginx Proxy Manager (NPM) terminates TLS and forwards plain HTTP to
`127.0.0.1:8093`, where a rootless podman **pod** (owned by `jaap`) runs two
containers:

| Container | Image | Role |
|---|---|---|
| `klaverjas-web` | `localhost/klaverjas-web:current`, from `nginxinc/nginx-unprivileged:1.31-alpine` | Serves `web/` on `:8080`; proxies `/ws` and `/api/` to the server |
| `klaverjas-server` | `localhost/klaverjas-server:current`, `FROM scratch`, static Go binary | Game server on `127.0.0.1:8081` inside the pod |

No database, no accounts, no persistence: games live in memory and vanish on
restart. Everything is same-origin (no CDN, no web fonts, no analytics), so a
strict CSP is possible.

## 1. Repository layout

```
go.mod                     module klaverjas (Go 1.27), one dependency: github.com/coder/websocket
cmd/klaverjas/main.go      flags, HTTP server, graceful shutdown, -healthcheck
internal/game/             pure rules engine: cards, legal moves, tricks, roem, scoring, deal state machine
internal/bot/              bot personalities, play levels, hints/advice, chat lines
internal/server/           rooms, codes, websocket protocol, pacing, chat, limits
web/                       static frontend, vanilla ES modules, no build step
  index.html  favicon.svg  manifest.webmanifest
  css/app.css  css/cards.css
  js/main.js … (app modules)  js/cards.js  js/sound.js  js/manual.js
test/e2e/                  node scripts that play full games over the websocket
test/ui/                   puppeteer-core browser checks (npm install done; node_modules ignored)
deploy/                    nginx.conf, quadlet templates (*.in), npm-advanced.conf, README-deploy.md
scripts/go                 Go toolchain in a container: `scripts/go test ./...`
scripts/dev-server PORT    run the server from source on 127.0.0.1:PORT serving web/ (flags after PORT)
scripts/chrome PORT        headless Chromium with CDP on 127.0.0.1:PORT
Containerfile  Makefile  README.md
```

There is no Go toolchain on the host: always use `scripts/go`. No `-race`
(no cgo in the image). Node 26 is on the host for JS tests (`node --test`).

## 2. Rules as implemented

Source: <https://nl.wikipedia.org/wiki/Klaverjassen>. Four players, two pairs;
partners sit opposite. 32 cards (7–A in four suits), 8 cards each, dealt 3-2-3.

### Cards

| Code | Suit | Dutch | Symbol |
|---|---|---|---|
| `C` | clubs | klaveren | ♣ |
| `D` | diamonds | ruiten | ♦ |
| `H` | hearts | harten | ♥ |
| `S` | spades | schoppen | ♠ |

Rank codes `7 8 9 T J Q K A`; Dutch names 7, 8, 9, 10, boer (B), vrouw (V),
heer (H), aas (A). A card code is rank then suit: `JH` = harten boer, `TS` =
schoppen 10. This is the wire format everywhere.

| | Trump order (high→low) and points | Non-trump order and points |
|---|---|---|
| | B 20 · 9 (nel) 14 · A 11 · 10 10 · H 4 · V 3 · 8 0 · 7 0 | A 11 · 10 10 · H 4 · V 3 · B 2 · 9 0 · 8 0 · 7 0 |

Card points total 152; the last trick adds 10: **162** per hand.

### Seats, dealer, voorhand

Seats `0..3` clockwise; play passes to `(s+1)%4`. Team of a seat is `s % 2`
(team 0 = seats 0 and 2). The first dealer of a match is random; the dealer
moves one seat clockwise every hand. **Voorhand** = `(dealer+1)%4`; voorhand **always leads the first trick**.
The winner of a trick leads the next.

### Choosing trump (`trumpMode`)

- `utrechts` (default, "verplicht spelen"): voorhand must choose one of the four
  suits. Voorhand's team is the playing team (`spelende partij`).
- `gedraaid` ("vrij"): a random suit is turned (`turnedSuit`). Starting with
  voorhand, each player in turn says *spelen* or *passen*. The first *spelen*
  makes that suit trump and that player's team the playing team (the rest are
  skipped). If all four pass, voorhand **must** choose one of the **other three**
  suits (`forced`).

### Following suit (`rules`)

Let `led` be the suit of the first card in the trick.

1. **Trump led**: if you have trump you must play it; if you can beat the
   highest trump in the trick you must (*overtroeven*); otherwise any trump
   (*ondertroeven* is then compulsory). No trump: any card.
2. **Other suit led, you have that suit**: play any card of that suit
   (no obligation to go higher).
3. **Other suit led, you don't have it, no trumps**: any card.
4. **Other suit led, you don't have it, you have trumps**:
   - `rotterdams`: you must trump, always (also when your partner is winning).
     Must overtrump if you can beat the highest trump in the trick; if you cannot,
     you must still play a (lower) trump.
   - `amsterdams` (default):
     - partner currently winning the trick: free choice among non-trump cards and
       trumps that beat the highest trump in the trick; *ondertroeven* (a trump
       that does not beat the trick's highest trump) only if nothing else is
       allowed.
     - otherwise: must play a trump that beats the trick's highest trump (any
       trump if none in the trick); if you can't, play a non-trump card; only if
       you hold nothing but lower trumps, undertrump.

The winner is the highest trump in the trick, else the highest card of `led`.
Illegal moves are impossible (no *verzaken*); the server rejects them.

### Roem (bonus points, "roem op tafel")

Counted per trick from the four cards in it, for the team that wins the trick,
automatically (no claiming):

| Roem | Points |
|---|---|
| Driekaart: 3 consecutive in one suit | 20 |
| Vierkaart: 4 consecutive in one suit | 50 |
| Stuk: heer + vrouw of trump in the trick | 20 (adds to a sequence) |
| Vier gelijke: four aces, tens, kings or queens | 100 |
| Vier boeren | 200 |

Sequences use the natural order 7-8-9-10-B-V-H-A (not trump order). Four 7s, 8s
or 9s are worth nothing. Roem items are reported per kind:
`drie` (20), `vier` (50), `stuk` (20), `vierGelijk` (100), `vierBoeren` (200).

### Scoring a hand

- `points[t]`: card points of tricks won + 10 for the last trick.
- `roem[t]`: roem of tricks won. A team that wins all 8 tricks gets **pit**
  (also *mars*): +100 roem.
- Playing team `P`, defenders `D`. `P` must score **strictly more than half** of
  `points[P]+points[D]+roem[P]+roem[D]`, i.e. `points[P]+roem[P] > total/2`.
  A tie is nat.
- **Nat**: `P` scores 0; `D` scores 162 + all roem of both teams (+100 pit if `D`
  took every trick, already in `roem[D]`).
- Otherwise each team scores its own `points + roem`.

A match is `hands` hands (default 16, *een boompje*); highest total wins; a tie
is a draw ("gelijkspel").

## 3. Options

Set by the host in the lobby; JSON keys on the wire:

| Key | Values | Default | Meaning |
|---|---|---|---|
| `humans` | 1–4 | 4 | Maximum human seats. Seats beyond it hold bots from the start; empty seats at start get random bots |
| `hands` | 4, 8, 12, 16, 20, 24 | 16 | Hands in the match |
| `trumpMode` | `utrechts`, `gedraaid` | `utrechts` | §2 |
| `rules` | `amsterdams`, `rotterdams` | `amsterdams` | §2 |
| `ai` | `makkelijk`, `normaal`, `sterk` | `normaal` | Strength of every bot in the room |
| `tempo` | `rustig`, `normaal`, `snel` | `normaal` | Pacing of bots and pauses (§6) |
| `open` | bool | false | Training only: show all hands face up |

The UI label for the variant is "Utrechts/Amsterdams" etc.: `trumpMode` +
`rules`.

**Training mode** (`training: true` at create) is a solo room: 1 human at seat
0, partner bot **Juf Ans** at seat 2, two random opponents, tempo `rustig` by
default, hints on, explanatory tips after every trick, nobody else can join.

## 4. Go API contracts

Exact names may gain helpers, but these exported identifiers and semantics are
what other packages use. Changing them means updating this section.

### 4.1 `internal/game`

```go
type Suit uint8   // Clubs, Diamonds, Hearts, Spades  (wire "C","D","H","S")
type Rank uint8   // Seven, Eight, Nine, Ten, Jack, Queen, King, Ace (natural/sequence order)
type Card struct{ Rank Rank; Suit Suit }
func (c Card) String() string            // "JH"
func ParseCard(s string) (Card, error)
func (s Suit) String() string            // "H"
func ParseSuit(s string) (Suit, error)
func (c Card) MarshalJSON / UnmarshalJSON // as the string code; same for Suit
func NewDeck() []Card                    // 32 cards, ordered
func SuitNameNL(s Suit) string           // "harten"; also CardNameNL(c) "harten boer"

type Seat int                            // 0..3; func (s Seat) Next() Seat; Partner(); Team() int
type Rules uint8                         // Amsterdams, Rotterdams  (JSON "amsterdams"/"rotterdams")
type TrumpMode uint8                     // Utrechts, Gedraaid      (JSON "utrechts"/"gedraaid")

func Points(c Card, trump Suit) int
func Beats(a, b Card, led, trump Suit) bool          // a beats b in a trick with this led suit
type Played struct{ Seat Seat; Card Card }            // JSON {"seat":2,"card":"JH"}
type Trick struct {
    Leader Seat
    Cards  []Played
    Winner Seat      // valid when len(Cards)==4, else -1
    Points int       // card points (+10 if last trick) when complete
    Roem   []RoemItem
}
func (t Trick) Led() (Suit, bool)
func (t Trick) CurrentWinner(trump Suit) (Seat, bool)  // who is winning so far
type RoemItem struct{ Kind string; Points int }       // JSON {"kind":"stuk","points":20}
func TrickRoem(cards []Card, trump Suit) []RoemItem

// Legal cards for `seat` holding `hand`, given the current (incomplete) trick.
func LegalMoves(hand []Card, trick Trick, seat Seat, trump Suit, rules Rules) []Card
// Short Dutch explanation of the constraint, shown above the hand on your turn:
// "Je komt uit: speel wat je wilt", "Bekennen: speel ♦", "Troef gevraagd: overtroeven",
// "Je moet troeven", "Je moet overtroeven", "Je maat heeft de slag: vrije keuze",
// "Je kunt niet bekennen en hebt geen troef: vrije keuze", ...
func ExplainConstraint(hand []Card, trick Trick, seat Seat, trump Suit, rules Rules) string
// Why a specific card is illegal (Dutch), "" if legal: "Je moet bekennen (♦).", ...
func ExplainIllegal(card Card, hand []Card, trick Trick, seat Seat, trump Suit, rules Rules) string

// Display order: suits alternate colour, trump (if known) first; within a suit high→low
// by the order that applies (trump order for trump).
func SortHand(hand []Card, trump Suit, trumpKnown bool) []Card

type Phase string // "trump", "bid", "play", "done"

// One hand ("potje"): a pure state machine. No timing, no randomness inside.
type Deal struct { /* unexported fields */ }
func NewDeal(dealer Seat, hands [4][]Card, mode TrumpMode, rules Rules, turned Suit) *Deal
func Shuffle(rng *rand.Rand) [4][]Card   // math/rand/v2, deal 3-2-3
func (d *Deal) Phase() Phase
func (d *Deal) Turn() Seat               // whose action is awaited; -1 if done
func (d *Deal) ChooseTrump(seat Seat, s Suit) error   // utrechts, or forced after 4 passes (not the turned suit)
func (d *Deal) Bid(seat Seat, play bool) error        // gedraaid
func (d *Deal) Play(seat Seat, c Card) error          // validates with LegalMoves
func (d *Deal) Hand(seat Seat) []Card
func (d *Deal) Trump() (Suit, bool)
func (d *Deal) TrumpBy() Seat            // -1 before trump is known
func (d *Deal) PlayingTeam() int         // -1 before trump is known
func (d *Deal) Forced() bool             // gedraaid: all passed, voorhand must choose
func (d *Deal) Turned() Suit
func (d *Deal) Bids() [4]int             // -1 none yet, 0 pass, 1 play
func (d *Deal) Current() Trick           // trick in progress (may be complete until next Play)
func (d *Deal) Tricks() []Trick          // completed tricks, in order
func (d *Deal) Result() HandResult       // valid when Phase()=="done"
func (d *Deal) View(seat Seat) View      // everything `seat` may know

type HandResult struct {
    PlayingTeam int; TrumpBy Seat; Trump Suit; Dealer Seat
    Points [2]int; Roem [2]int            // raw, before nat
    Score  [2]int                         // what goes on the score sheet
    Nat bool; Pit bool; PitTeam int       // PitTeam -1 if none
}

type View struct {
    Seat Seat; Hand []Card; Dealer Seat; Voorhand Seat
    Mode TrumpMode; Rules Rules; Phase Phase
    Trump Suit; TrumpKnown bool; TrumpBy Seat; PlayingTeam int
    Turned Suit; Bids [4]int; Forced bool
    Current Trick; Tricks []Trick          // full history of this hand (bots may remember)
    Legal []Card                           // when it is Seat's turn in phase play
    HandNo, HandsTotal int; MatchScore [2]int
}
```

Tests in `internal/game` are table-driven and exhaustive for: legal moves in
both rule sets (all branches above), trick winner, roem (each kind, combos,
stuk+sequence, four of a kind, no false positives), scoring (normal, nat, tie =
nat, pit, pit by defenders), deal state machine (both trump modes, forced
choice, turn order, last-trick bonus, 162 total).

### 4.2 `internal/bot`

```go
type Level int  // Makkelijk, Normaal, Sterk; func ParseLevel("normaal")
type Persona struct {
    ID, Name, Emoji, Color, Bio string   // Name without "(AI)"; Bio is Dutch, one line
    Aggression float64  // 0..1: willingness to play/choose trump on weaker hands, to go for pit
    Chattiness float64  // 0..1: chance of commenting on events
    Speed      float64  // multiplier on think time (0.6 fast .. 1.4 slow)
}
func Roster() []Persona                       // 8 personas, §5
func ByID(id string) (Persona, bool)

type Player interface {
    ChooseTrump(v game.View) game.Suit       // utrechts, or forced (must not return v.Turned when v.Forced)
    Bid(v game.View) bool                    // gedraaid: play on v.Turned?
    Play(v game.View) game.Card              // must be in v.Legal
}
func New(p Persona, lvl Level, seed uint64) Player

// Advice for the training hints (always at Sterk strength), Dutch text
type Advice struct {
    Card *game.Card; Suit *game.Suit; Play *bool
    Text string     // e.g. "Speel ♥A: je maat heeft de slag nog niet en de aas is hoog."
}
func Advise(v game.View) Advice
// Dutch explanation of a finished trick for training tips:
// "Fatima (AI) wint de slag met ♥B (troef). 25 punten, roem: stuk (20)."
func ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string

// Personality chat. Returns "" for silence; the server rate-limits on top.
type ChatEvent struct {
    Kind string   // "greet","trump","pass","play","wonTrick","roem","nat","natOpp","pit","handWon",
                  // "handLost","gameWon","gameLost","partnerGood","reply"
    Mine bool     // about the bot itself / its team
    Text string   // for "reply": the human chat line being answered
    Points int    // roem/points involved
}
func Chat(p Persona, ev ChatEvent, rng *rand.Rand) string
```

Strength levels:

- **makkelijk**: legal moves with simple heuristics and deliberate mistakes
  (~30% random legal card), naive trump choice.
- **normaal**: rule-based play: win tricks with the cheapest winning card, smear
  points (*smeren*: a 10 or ace) when the partner is winning, discard low
  otherwise, pull trumps when playing team, keep the nel/boer guarded, count
  trumps played, sensible trump choice (boer/nel/aas/length).
- **sterk**: card tracking with inference (voids from not following suit,
  trump obligations), determinised Monte Carlo: sample hidden hands consistent
  with everything known, evaluate each legal move by playouts with the normaal
  policy, ~150–400 samples within ~150 ms; trump choice by simulation; reads and
  gives the signals of §8 (aas voorspelen, kleintje boer).

Each persona modulates its level's choices (Aggression shifts thresholds) and
chat. `internal/bot` has an arena test (skipped with `-short`) that plays many
hands between levels and asserts sterk > normaal > makkelijk in average points.

### 4.3 `internal/server`

```go
type Config struct {
    Fast bool           // scale all delays by 0.05 (tests)
    MaxRooms int        // default 500
    AllowedOrigins []string // websocket Origin patterns besides same-host
}
func New(cfg Config) *Server
func (s *Server) Handler() http.Handler   // /ws, /api/health
func (s *Server) Shutdown(ctx context.Context)
```

`cmd/klaverjas` flags: `-addr 127.0.0.1:8081`, `-static DIR` (dev only: also
serve the frontend, with the same `/^[A-Z]{4}$/` → index.html rule as nginx),
`-fast`, `-origin PATTERN` (repeatable), `-healthcheck` (GET
`http://127.0.0.1:8081/api/health`, exit 0/1; the scratch image has no curl).
Logs with `log/slog` to stdout. Never log chat text or tokens.

Each room is an actor: one goroutine owning all room state, fed by a command
channel; timers via `time.AfterFunc` posting back into the channel. Each
connection has a reader and a writer goroutine with a bounded send queue (a
client that falls behind is disconnected; it resyncs on reconnect).

## 5. Bots

Display name is always `"<Name> (AI)"`, built by the server into
`players[i].name`. Eight personas (IDs fixed):

| ID | Name | Emoji | Character |
|---|---|---|---|
| `henk` | Opa Henk | 👴 | Speelt al zestig jaar in café De Klaver. Voorzichtig en degelijk; spreekwoorden. |
| `truus` | Tante Truus | 👵 | Kletst honderduit en is dol op roem; optimistisch. |
| `sjaak` | Sjaak | 🎲 | Gokker: speelt op dunne handen en gaat voor de pit. |
| `fatima` | Fatima | 🧠 | Wiskundestudent die elke kaart telt; kort van stof. |
| `kees` | Kees de Visser | 🎣 | Mopperkont, maar eerlijk; moppert als hij nat gaat. |
| `ans` | Juf Ans | 👩‍🏫 | Geduldige juf die graag uitlegt; partner in de oefenmodus. |
| `bram` | Bram | 🛹 | Jong en snel, speelt op gevoel, chat met emoji. |
| `lies` | Bakker Lies | 🥐 | Staat om vijf uur op, speelt scherp en vriendelijk. |

Chat lines are Dutch, short, in character, varied (≥ 4 lines per event kind
per persona where it fits), never revealing a bot's hidden cards. Bots greet
on game start, react to roem, nat, pit and game end, and occasionally reply to
human chat ("hoi", "goed gespeeld", "gg", "haha"…). The server allows a bot at
most one line per trick and one per 8 s, scaled by Chattiness.

## 6. Server behaviour

### Rooms and codes

- Code: 4 letters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (no I, O), unique among live
  rooms, case-insensitive on input. Join link: `https://klaverjas.kroes.dev/ABCD`.
- Creator sits at seat 0 and is host. If the host leaves, the next human becomes
  host. A room is removed after 30 min with no connected human, or 30 min after
  game over; max 500 rooms (`Config.MaxRooms`), error when full.
- Bots in the lobby: when `humans < 4`, seats are prefilled with random distinct
  personas so that remaining human seats are partners where possible
  (`humans`=2 → bots at 1 and 3; 3 → bot at 3; 1 → bots at 1,2,3). Changing
  `humans` in the lobby adds/removes bots (never removes humans; cannot go
  below the current human count). The host can put a bot (chosen or random) on
  any empty seat and remove bots. Humans may move to any empty seat. At start,
  empty seats get random distinct bots.
- Joining a lobby: first empty seat, unless `humans` humans are already seated
  → error `vol`. Joining a running game: allowed only to take over a *vacated*
  seat (a human left; a bot plays it meanwhile), else error `gestart`.
- Reconnect: `join` with the room's code and the seat token returns you to your
  seat, mid-game included.
- A human who disconnects keeps the seat. If it is their turn and they are still
  away after 20 s, a substitute bot (level normaal) plays for them
  (`away: true`) until they return. Explicit `leave` mid-game vacates the seat.
- If no human is connected, the game pauses (bots do not play).

### Pacing (ms, scaled by tempo; `-fast` multiplies everything by 0.05)

| | rustig | normaal | snel |
|---|---|---|---|
| bot think time (× persona Speed, ± 30%) | 1500 | 900 | 450 |
| deal animation before first action | 2000 | 1500 | 900 |
| trump/bid announcement pause | 1200 | 900 | 500 |
| completed trick on table before collect | 2200 | 1500 | 800 |
| hand summary before auto-continue (unless all humans `ready`) | 15000 | 12000 | 8000 |

During a pause nobody may act (`turn` is -1). Humans have no time limit.

### Limits

WebSocket messages ≤ 4 KiB; per connection ≤ 20 messages/s (excess:
disconnect); chat ≤ 200 characters, 1 per second with burst 5; names 1–20
characters, control characters stripped, trimmed (empty → "Speler"); room
creation ≤ 20 per 10 minutes per client IP (`X-Real-IP` from nginx, else remote
address); ≤ 16 websocket connections per IP. WebSocket `Origin` must match
the Host (coder/websocket default) or an `-origin` pattern. Server pings every
25 s (nginx and NPM time out idle proxied connections at 60 s).

## 7. Wire protocol

One websocket at `/ws` (same origin, `wss:` in production). All messages are
JSON objects with a type field `t`. Seats are absolute (0..3); the client
rotates so `you` is at the bottom.

### Client → server

| `t` | Fields | When |
|---|---|---|
| `create` | `name`, `opts` (partial ok), `training` bool, `start` bool | Home. `start:true` starts at once (quick play vs bots) |
| `join` | `code`, `name`, `token` (optional) | Join link, code entry, reconnect |
| `sit` | `seat` | Lobby: move to an empty seat |
| `bot` | `seat`, `id` ("" = random) | Host, lobby: put a bot on an empty seat (or replace a bot) |
| `unbot` | `seat` | Host, lobby: remove a bot |
| `opts` | `opts` (partial) | Host, lobby |
| `start` | | Host, lobby |
| `trump` | `suit` | Your turn, phase `trump` |
| `bid` | `play` bool | Your turn, phase `bid` |
| `play` | `card` | Your turn, phase `play` |
| `ready` | | Phase `handEnd`: continue now |
| `chat` | `text` | Any time |
| `rematch` | | Host, phase `gameOver`: new match, same seats and options |
| `leave` | | Leave the room |
| `ping` | | Keepalive (server answers `pong`) |

### Server → client

| `t` | Fields |
|---|---|
| `joined` | `code`, `seat`, `token` (store in localStorage under `kj.token.<code>`) |
| `update` | `seq`, `ev` (event or null), `s` (full state for you) |
| `chat` | `msg`: `{seat, name, text, ts, bot, sys}` (`sys`: system line, seat -1) |
| `chatlog` | `msgs`: last 50, sent after `joined` |
| `tip` | `text` (training: explanation after a trick, Dutch) |
| `error` | `code`, `msg` (Dutch, ready to show) |
| `pong` | |

Error codes: `onbekend` (no such room), `vol`, `gestart`, `geen-host`,
`niet-jouw-beurt`, `ongeldig` (bad card/suit/fields; `msg` from
`ExplainIllegal` for cards), `limiet` (rate limit), `te-veel-spellen`, `herstart`
(server restarting; client reconnects after a delay).

Every state change is one `update`: the client queues updates, animates `ev`
from its previous state to `s`, then renders `s`. A resync (join, reconnect)
is an `update` with `ev: null`. `seq` increases per room.

### Events (`ev.type`)

| type | fields | client animation |
|---|---|---|
| `lobby` | | none (seat/option changes) |
| `deal` | `handNo`, `dealer` | cards fly from the dealer to each seat, 3-2-3 |
| `turned` | `suit` | gedraaid: show the turned suit |
| `bid` | `seat`, `play` | speech bubble "Spelen!"/"Pas" at the seat |
| `trump` | `seat`, `suit`, `forced` | banner "Opa Henk (AI) kiest ♥ als troef" |
| `play` | `seat`, `card` | card flies from the seat to its trick slot |
| `trick` | `winner`, `points`, `roem` [], `last` bool | highlight winning card; roem burst "+20 Stuk!" |
| `collect` | `winner` | trick slides to the winner and fades |
| `handEnd` | `result` (HandResult as JSON, below) | summary overlay: gehaald/nat/pit |
| `gameOver` | `total` [2], `winner` (0,1, or -1 draw) | celebration |
| `join` / `leave` / `away` / `back` | `seat` | small toast |

### State `s`

```jsonc
{
  "code": "KQXB", "phase": "lobby|trump|bid|play|handEnd|gameOver",
  "opts": { "humans":4, "hands":16, "trumpMode":"utrechts", "rules":"amsterdams",
            "ai":"normaal", "tempo":"normaal", "open":false },
  "training": false, "you": 0, "host": 0,
  "players": [ // always 4 entries; null = empty seat
    { "name":"Piet", "bot":false, "botId":"", "emoji":"", "color":"",
      "connected":true, "away":false, "cards":8, "ready":false },
    { "name":"Opa Henk (AI)", "bot":true, "botId":"henk", "emoji":"👴", "color":"#8a5a2b",
      "connected":true, "away":false, "cards":8, "ready":false }, null, null ],
  "handNo": 3, "hands": 16, "dealer": 1, "voorhand": 2,
  "turned": null, "bids": [-1,-1,-1,-1], "forced": false,
  "trump": "H", "trumpBy": 2, "playingTeam": 0,
  "turn": 0,                       // -1 while paused or nobody's turn
  "hand": ["JH","9H","AH","TS","KS","8C","AD","7D"],   // yours, display-sorted
  "legal": ["JH","9H"],            // only on your turn in phase play
  "rule": "Troef gevraagd: overtroeven",   // ExplainConstraint, on your turn
  "trick": { "leader":3, "cards":[{"seat":3,"card":"QH"}], "winner":-1 },
  "lastTrick": { "leader":2, "cards":[...4], "winner":3, "points":21, "roem":[] },   // or null
  "tricksWon": [2,1], "handPoints": [43,21], "handRoem": [20,0],
  "scores": [ { "hand":1, "dealer":0, "trump":"S", "trumpBy":1, "playingTeam":1,
                "points":[70,92], "roem":[0,20], "score":[70,112], "nat":false, "pit":false } ],
  "total": [ 418, 391 ],
  "prevHand": { "tricks":[ /* 8 completed tricks */ ], "result": { /* HandResult */ } }, // after a hand ends, until the next hand ends
  "nextAt": 0,                     // handEnd: unix ms of auto-continue
  "hint": null,                    // training, your turn: {"card":"AH"} | {"suit":"H"} | {"play":true}, plus "text"
  "hands4": null,                  // training with open: all four hands [[...],...]
  "winner": -1                     // gameOver
}
```

`HandResult` JSON: `{"playingTeam":0,"trumpBy":2,"trump":"H","dealer":1,
"points":[104,58],"roem":[20,0],"score":[124,0],"nat":false,"pit":false,"pitTeam":-1}`.

## 8. Seinen (signals) — used by sterk bots and explained in the manual

- **Aas voorspelen**: lead an ace of a side suit to take its points safely.
- **Kleintje boer**: leading a small card (7, 8, 9) of a side suit signals "ik heb de
  troefboer"; partner wins and returns trump.
- **Boer over boer**: leading a side-suit boer while holding the trump boer.
- **Hoog/laag bijspelen**: discarding a 10 or picture card says "ik heb weinig in
  deze kleur"; a small card asks for that suit.
- **Tegenkleur seinen**: discarding a suit to ask for the suit of the other colour of
  the same shade (harten ↔ ruiten, klaveren ↔ schoppen).
- **Smeren**: give points (10, aas) to a trick your partner is sure to win.
- **Maat heeft de slag** (Amsterdams): no need to trump; smear instead.

## 9. Frontend

Vanilla ES modules, no framework, no build step, no inline `<script>`/`<style>`
and no `style="…"` attributes or `setAttribute('style')` (CSP `style-src
'self'`; setting `el.style.x` from JS is fine). Build DOM with
`document.createElement`/`textContent`; never `innerHTML` with user or server
text. At most ~14 files fetched per page load (NPM allows bursts of 20
requests): keep app JS to ≤ 7 modules. No service worker. System font stack.
`localStorage` access wrapped in try/catch (keys prefixed `kj.`).

### Module contracts shared between agents

```js
// web/js/cards.js — card faces and backs (with web/css/cards.css)
export const SUITS = { C:{name:'klaveren',symbol:'♣',color:'black'}, D:{name:'ruiten',symbol:'♦',color:'red'},
                       H:{name:'harten',symbol:'♥',color:'red'}, S:{name:'schoppen',symbol:'♠',color:'black'} };
export const RANKS = { '7':'7','8':'8','9':'9','T':'10','J':'B','Q':'V','K':'H','A':'A' };  // face letters
export function cardName(code)            // "harten boer"
export function cardShort(code)           // "♥B"
export function createCard(code, opts={}) // → HTMLElement .card; opts: {size:'sm'|'md'|'lg'} (default md);
                                          //   dataset.card = code; aria-label = cardName
export function createBack(opts={})       // → HTMLElement .card.back
// Card size scales with the CSS custom property --card-w on any ancestor (height = 1.4 × width).
// Four-colour deck when an ancestor has class .four-color (♣ green, ♦ blue/orange).

// web/js/sound.js — synthesised with WebAudio, no audio files
export const sound = {
  unlock(),            // call on the first user gesture
  play(name),          // 'card','deal','shuffle','trick','trickWon','roem','trump','turn','chat',
                       // 'nat','pit','handWon','handLost','win','lose','click','error','join'
  setMuted(bool), isMuted(), setVolume(0..1)    // persisted in localStorage kj.sound
};

// web/js/manual.js — the in-game handleiding (Dutch content + renderer)
export const SECTIONS = [ {id:'bediening',title:'Bediening'}, {id:'regels',title:'Spelregels'},
  {id:'punten',title:'Kaartwaarden'}, {id:'roem',title:'Roem'}, {id:'seinen',title:'Seinen & voorkaarten'},
  {id:'tips',title:'Tips'}, {id:'woorden',title:'Woordenlijst'} ];
export function renderManual(sectionId) // → HTMLElement with that section's content (uses cards.js for illustrations)
```

### Screens and flows (minimal clicks)

- **Home**: name field (remembered; asked once), and big buttons: *Snel spelen*
  (one tap: solo vs 3 bots, starts immediately), *Nieuw spel* (options sheet with
  defaults → *Maak spel*), *Meedoen* (4-letter code field; joins as soon as 4
  letters are typed), *Oefenen* (training), *Handleiding*. Opening a join link
  `/ABCD` goes straight to joining (asks only for a name if none is stored).
- **Lobby**: big code + *Kopieer link* + *Delen* (`navigator.share` where
  available); a mini table with the four seats (teams visible); tap an empty seat to
  sit there; host taps an empty seat to add a bot (choose a character or random),
  ✕ to remove one; host edits options; *Start*.
- **Table**: you at the bottom with your hand as a fan; partner on top, opponents
  left/right with card backs and names; dealer chip; turn glow; trump indicator;
  score bar *Wij – Zij* with names; potje n/16; buttons for chat (with unread
  badge), score sheet, last trick, help, settings, sound.
  Playing: on fine pointers one click plays a legal card; on touch the first tap
  lifts the card and a second tap (or swipe up) plays it (setting: one tap /
  two taps). Illegal cards are dimmed; tapping one shows `ExplainIllegal`-style
  text (the client may derive it from `rule`). Keyboard: ←/→ select, Enter plays.
  Trump choice: four big suit buttons (forced: turned suit disabled). Bidding:
  *Spelen* / *Passen*.
- **Feedback**: card fly-in animations, winner highlight, trick collection
  toward the winner, roem burst, trump banner, speech bubbles for bids and bot
  chat, nat/pit splash, animated score count-up, confetti on winning; short
  waits so every move can be followed; `prefers-reduced-motion` shortens all.
- **Score sheet**: per hand: trump suit, who played (marker), points+roem per
  team, nat (red) / pit (gold), running totals.
- **Review**: *Laatste slag* shows the previous trick at the seats with winner,
  points and roem; the hand summary (and the score sheet for the previous hand)
  shows all 8 tricks of the finished hand.
- **Chat**: drawer (side panel on wide screens), quick reactions (👍 😂 😱 "Mooi!"
  "Nat!" "Goed gespeeld"), bot lines, system lines, unread badge.
- **Training**: tip bubble with the hint text and a glow on the advised card;
  tips after each trick (`tip`); optional open cards; Juf Ans as partner.
- **Help**: the manual (SECTIONS) in a modal, plus `title` tooltips and small ⓘ
  explanations on UI elements.
- **Responsive**: phones portrait (360×640 up) and landscape (≥ 640×360),
  tablets and desktop; touch targets ≥ 44 px; no horizontal scroll.
- **Look**: green felt table with vignette, wooden rim, gold accents, team colours
  (Wij teal/blue, Zij coral/red), dark UI chrome; four-colour deck option.

## 10. Deployment

- `Containerfile` stages: `build` (golang:1.27-alpine: `go vet`, `go test -short
  ./...`, static build with `-trimpath -ldflags "-s -w -X main.version=$GIT_SHA"`),
  `server` (`FROM scratch`, binary + CA-less, `USER 65532:65532`), `web`
  (`nginxinc/nginx-unprivileged:1.31-alpine`, `deploy/nginx.conf`, `web/`).
- `deploy/nginx.conf`: listen 8080; `/ws` → `http://127.0.0.1:8081` with Upgrade
  headers and long read timeout; `/api/` → same; `location ~ "^/[A-Za-z]{4}$"` →
  `/index.html`; security headers in one place (CSP `default-src 'self';
  connect-src 'self' wss://@SITE@; img-src 'self' data:; style-src 'self';
  script-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self';
  object-src 'none'; form-action 'none'`, nosniff, Referrer-Policy,
  Permissions-Policy, COOP); `Cache-Control: no-cache` for html/js/css (ETag
  revalidation) so a deploy is picked up at once; gzip; `X-Real-IP` forwarding.
- Quadlets rendered by `make install` into `~/.config/containers/systemd/`:
  `klaverjas.pod` (`PublishPort=127.0.0.1:8093:8080`), `klaverjas-web.container`,
  `klaverjas-server.container` (`Pod=klaverjas.pod`, `Pull=never`, `ReadOnly`,
  `NoNewPrivileges`, `DropCapability=ALL`, health checks).
- `Makefile` like `/storage/CLIC/ISMS/Makefile`: `help test image install deploy
  status logs uninstall dev`, settings `SITE ?= klaverjas.kroes.dev`,
  `ADDR ?= 127.0.0.1:8093`.
- NPM proxy host (manual, by the admin): `klaverjas.kroes.dev` → `http://127.0.0.1:8093`,
  wildcard certificate, Force SSL, HTTP/2, Block Common Exploits, **Websockets
  Support ON**, no access list; HSTS in Advanced (`deploy/npm-advanced.conf`).
