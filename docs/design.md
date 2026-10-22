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
| `klaverjas-web` | `localhost/klaverjas-web:current`, from `nginxinc/nginx-unprivileged` (Alpine; tag in the `Containerfile`) | Serves `web/` on `:8080`; proxies `/ws` and `/api/` to the server |
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
  index.html  favicon.svg  manifest.webmanifest  og.png (link preview)
  icon-full.svg  apple-touch-icon.png  icon-192.png  icon-512.png  icon-maskable-512.png
  css/app.css  css/cards.css  css/manual.css
  js/main.js … (app modules)  js/cards.js  js/sound.js  js/manual.js
test/e2e/                  node scripts that play full games over the websocket
test/ui/                   puppeteer-core browser checks (npm install done; node_modules ignored),
                           and og-image.mjs, which renders web/og.png
deploy/                    nginx.conf, quadlet templates (*.in), npm-advanced.conf, README-deploy.md
scripts/go                 Go toolchain in a container: `scripts/go test ./...`
scripts/dev-server PORT    run the server from source on 127.0.0.1:PORT serving web/ (flags after PORT)
scripts/chrome PORT        headless Chromium with CDP on 127.0.0.1:PORT
scripts/pod-check [ADDR [SITE]]  check a running pod without NPM: pages, websocket, link preview,
                           security headers (`make check`)
scripts/deploy-test        `make test`: the units through podman's quadlet generator, and how
                           `make deploy` labels, tags and refuses builds (stubbed podman/systemd)
Containerfile  Makefile  README.md
```

There is no Go toolchain on the host: always use `scripts/go`. It has no
`-race` (no cgo in the Alpine image); for that, use the Debian image:
`podman run --rm --network host -v $PWD:/src -w /src -e GOFLAGS=-buildvcs=false
docker.io/library/golang:1.27 go test -race ./...`. Node 26 is on the host for
JS tests (`node --test`).

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
     you must still trump: any trump, so *ondertroeven* is then compulsory. A
     non-trump card only when you hold no trump at all. (Wikipedia's
     "Schematisch overzicht" for Rotterdams: 1 kleur bekennen, 2 in-/overtroeven,
     3 ondertroeven, 4 anders spelen; pagat.com agrees. Wikipedia's general
     sentence "Ondertroeven mag alléén als men geen andere kleur kaarten dan
     lagere troeven in handen heeft" is the Amsterdams rule below.)
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
  (also *doormars*): +100 roem.
- Playing team `P`, defenders `D`. `P` must score **strictly more than half** of
  `points[P]+points[D]+roem[P]+roem[D]`, i.e. `points[P]+roem[P] > total/2`.
  A tie is nat.
- **Nat**: `P` scores 0; `D` scores 162 + all roem of both teams (+100 pit if `D`
  took every trick, already in `roem[D]`).
- Otherwise each team scores its own `points + roem`.

A match is `hands` hands (default 16, *een boom*); highest total wins; a tie
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
    Mode TrumpMode; Rules Rules; Phase Phase; Turn Seat   // Turn: NoSeat when done
    Trump Suit; TrumpKnown bool; TrumpBy Seat; PlayingTeam int
    Turned Suit; Bids [4]int; Forced bool
    Current Trick; Tricks []Trick          // full history of this hand (bots may remember)
    Legal []Card                           // when it is Seat's turn in phase play
    HandNo, HandsTotal int; MatchScore [2]int   // zero from Deal.View; the server fills them
}
```

Semantics and additions (implemented in `internal/game`):

- `View.Current` is the trick the next card goes into: once a trick is complete
  it is already the next, empty trick led by the winner (the completed one is the
  last of `View.Tricks`); when done it is the last trick. `Deal.Current()` keeps
  the complete trick until the next `Play` (for display). `LegalMoves` and friends
  treat a complete trick as empty (next card leads).
- `Deal.Tricks()` includes a completed trick that is still `Current()`.
- `HandResult.Roem` includes the `PitBonus` (100); `Deal.HandRoem()` does not.
- Errors (Dutch texts, safe to show): `ErrWrongPhase`, `ErrNotYourTurn`,
  `ErrBadSuit`, `ErrTurnedSuit`, `ErrNotInHand`, `ErrIllegal`; `Play` returns
  `*IllegalError{Card, Reason}` (Reason = `ExplainIllegal` text,
  `errors.Is(err, ErrIllegal)`).
- Constants/names: `NumSuits`, `NumRanks`, `NoSeat` (-1), `PhaseTrump/Bid/Play/Done`,
  `RoemDrie/Vier/Stuk/VierGelijk/VierBoeren`, `PitBonus`, `LastTrickBonus`;
  `Suit.Symbol()` "♥", `Suit.Red()`, `Rank.NameNL()` "boer", `Rank.Letter()` "B",
  `CardShortNL(c)` "♥B", `RoemItem.NameNL()` "stuk"/"driekaart"/"vier gelijke",
  `Rules.NameNL()`/`TrumpMode.NameNL()`, `ParseRules`, `ParseTrumpMode`,
  `Seat.Valid()`, `Card.Valid()`, `Card.Index()`/`CardFromIndex` (0..31),
  `MustParseCards("JH 9H")` (tests); all these types also implement
  `encoding.TextMarshaler`.
- Rules helpers: `Order(c, trump)` (0..7 within suit), `TrumpOrder(r)`,
  `PlainOrder(r)`, `CardPoints(cards, trump)`, `ScoreHand(playingTeam, points,
  roem) (score, nat)`, `Trick.Complete()`, `Trick.Next()` (seat to play),
  `Trick.WinningCard(trump)`, `Trick.RoemTotal()`; `Trick` marshals empty
  `cards`/`roem` as `[]`.
- Fast paths for simulation (no allocations): `AppendLegalMoves(dst, hand, trick,
  seat, trump, rules)`, `IsLegal(card, hand, trick, seat, trump, rules)`,
  `AppendTrickRoem(dst, cards, trump)`, `RoemPoints(cards, trump)`;
  `Deal` holds no slices or maps, so `*dst = *src` (or `d.Clone()`) is a full
  independent copy; `d.AppendLegal(dst)`/`d.Legal()` for the seat on turn,
  `d.AppendHand(dst, seat)`, `d.HandLen(seat)`, `d.TrickCount()`.
  `Resume(v View, hands [4][]Card) (*Deal, error)` rebuilds a deal in phase play
  from a view plus every seat's remaining cards (e.g. sampled hidden hands).
- Deal accessors for the server: `Dealer()`, `Voorhand()`, `Mode()`, `Rules()`,
  `TricksWon() [2]int`, `HandPoints() [2]int` (incl. last trick),
  `HandRoem() [2]int`.

Tests in `internal/game` are table-driven and exhaustive for: legal moves in
both rule sets (all branches above), trick winner, roem (each kind, combos,
stuk+sequence, four of a kind, no false positives), scoring (normal, nat, tie =
nat, pit, pit by defenders), deal state machine (both trump modes, forced
choice, turn order, last-trick bonus, 162 total).

### 4.2 `internal/bot`

```go
type Level int  // Makkelijk, Normaal, Sterk; String() "normaal"
func ParseLevel(s string) (Level, error)    // "makkelijk"|"normaal"|"sterk"; error → Normaal
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

// Advice for the training hints, Dutch text. Trump and bid advice is the
// sterk choice. A play hint is the sterk card, unless the hint can name no
// reason for it beyond the search's estimate: then it is the rule-based or
// the cheapest card, if that card has a reason of its own and the search
// cannot tell the two apart (gap under max(5 points, 2 paired SE)), never a
// card that falsely signals kleintje boer. A hint that still has no reason
// names a fact that speaks for the card against the cheapest other one,
// true whatever the other hands hold (it keeps the last trick, gives no
// roem, banks points in a sure trick, keeps the trumps, the highest card of
// a side suit or the guard of an honour); without one it says by how much
// the search rates it higher ("volgens de berekening levert ♠A gemiddeld 9
// punten meer op dan ♠8").
type Advice struct {
    Card *game.Card; Suit *game.Suit; Play *bool
    Text string     // e.g. "Speel ♥A: je maat heeft de slag nog niet en de aas is hoog."
}
func Advise(v game.View) Advice
// Dutch explanation of a finished trick for training tips:
// "Fatima (AI) wint de slag met ♥B, de hoogste troef. 25 punten, roem: stuk (20)."
func ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string

// Personality chat. Returns "" for silence; the server rate-limits on top.
type ChatEvent struct {
    Kind string   // "greet","trump","pass","play","wonTrick","roem","nat","natOpp","pit","handWon",
                  // "handLost","gameWon","gameLost","partnerGood","reply"
    Mine bool     // about the bot itself / its team; "reply": the bot is the speaker's partner
    Text string   // for "reply": the human chat line being answered
    Points int    // roem/points involved
    InHand, Playing bool // "reply": tricks are being played; the bot's team made trump
}
func Chat(p Persona, ev ChatEvent, rng *rand.Rand) string
```

Strength levels:

- **makkelijk**: legal moves with simple heuristics and deliberate mistakes
  (~30% random legal card), naive trump choice (longest suit) and bidding (on
  the boer or on length; Aggression moves the bar, e.g. cautious personas want
  the boer with another trump, bold ones also play on the nel with two more).
- **normaal**: rule-based play: win tricks with the cheapest winning card (a
  cheap side-suit trick is ruffed with the lowest trump that wins, not with
  the boer or nel), give points (*spekken*, also *smeren*: a 10 or ace) when
  the partner is winning, discard low otherwise, pull trumps when playing
  team, keep the nel/boer guarded, count trumps played, sensible trump choice
  (boer/nel/aas/length). Gives and reads kleintje boer (§8) and never leads a
  small side card that would falsely promise the boer when it has another
  lead. Likewise it holds back a side ace whose 10 it lacks (aas voorspelen,
  §8, would promise that 10), never leads under its own ace, avoids a low
  discard that would falsely claim the highest card of its suit (laag
  bijspelen), and leads into a suit whose highest card the partner signalled.
- **sterk**: card tracking with inference (voids from not following suit,
  trump obligations), determinised Monte Carlo: sample hidden hands consistent
  with everything known, evaluate each legal move by playouts with the normaal
  policy, ~150–400 samples within ~150 ms; trump choice by simulation; reads the
  signals of §8 (aas voorspelen, kleintje boer, laag bijspelen) as soft
  evidence. It gives kleintje boer when that costs at most a few points, and
  fakes it (a small side card without the boer) only when that gains clearly
  (≥ 10 points), a false laag bijspelen only for ≥ 20 points, and a false aas
  voorspelen never while it has an honest card to lead, since partners and
  humans read the signals as promises. Exactly equal search
  results go to the rule-based card, then to the cheaper card.

Each persona modulates its level's choices (Aggression shifts thresholds) and
chat. `internal/bot` has an arena test (skipped with `-short`) that plays many
hands between levels and asserts sterk > normaal > makkelijk in average points.

### 4.3 `internal/server`

`internal/server` does **not** import `internal/bot`: it defines the interface
it needs, and `cmd/klaverjas/ai.go` adapts package `bot` to it. Server tests
use a fake AI (first legal card), so the two packages build independently.

```go
type Persona struct{ ID, Name, Emoji, Color, Bio string; Chattiness, Speed float64 }
type Brain interface {
    ChooseTrump(v game.View) game.Suit
    Bid(v game.View) bool
    Play(v game.View) game.Card
}
type Advice struct{ Card *game.Card; Suit *game.Suit; Play *bool; Text string }
type ChatEvent struct{ Kind string; Mine bool; Text string; Points int; InHand, Playing bool } // as bot.ChatEvent
type AI interface {
    Personas() []Persona
    NewBrain(personaID, level string, seed uint64) Brain   // level "makkelijk"|"normaal"|"sterk";
                                                           // personaID "" = neutral substitute for an away human
    Advise(v game.View) Advice
    ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string
    Chat(personaID string, ev ChatEvent, rng *rand.Rand) string
}
type Config struct {
    AI   AI
    Fast bool           // scale all delays by 0.05 (tests)
    MaxRooms int        // default 500
    AllowedOrigins []string // websocket Origin patterns besides same-host
    Version  string     // reported by /api/health {ok, version, rooms, players}
    Logger   *slog.Logger // nil: slog.Default()
}
func New(cfg Config) *Server
func (s *Server) Handler() http.Handler   // /ws, /api/health
func (s *Server) Shutdown(ctx context.Context)
```

`cmd/klaverjas` flags: `-addr 127.0.0.1:8081`, `-static DIR` (dev only: also
serve the frontend, with the same `/^[A-Za-z]{4}$/` → index.html rule as nginx,
`Cache-Control: no-cache` and the nginx CSP),
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
| `dirk` | Opa Dirk | 👴 | Speelt al zestig jaar in café De Klaver. Voorzichtig en degelijk; spreekwoorden. |
| `truus` | Tante Truus | 👵 | Kletst honderduit en is dol op roem; optimistisch. |
| `sjaak` | Sjaak | 🎲 | Gokker: speelt op dunne handen en gaat voor de pit. |
| `fatima` | Fatima | 🧠 | Wiskundestudent die elke kaart telt; kort van stof. |
| `kees` | Kees de Visser | 🎣 | Mopperkont, maar eerlijk; moppert als hij nat gaat. |
| `ans` | Juf Ans | 👩‍🏫 | Geduldige juf die graag uitlegt; partner in de oefenmodus. |
| `bram` | Bram | 🛹 | Jong en snel, speelt op gevoel, chat met emoji. |
| `vera` | Bakker Vera | 🥐 | Staat om vijf uur op, speelt scherp en vriendelijk. |

Chat lines are Dutch, short, in character, varied (≥ 4 lines per event kind
per persona where it fits), never revealing a bot's hidden cards. `ChatEvent`
carries no time of day and no trump mode, so lines fit any hour (no
"goedenavond") and both modes (no passing outside "pass" lines: utrechts has
none). Bots greet on game start, react to roem, nat, pit and game end, and
occasionally reply to human chat ("hoi", "goed gespeeld", "gg", "haha"…). For
a trump choice or a big trick the bot that made it speaks (`Mine`); if it says
nothing, or a human made it, a bot of the other team may (`Mine: false`, the
"/opp" lines; for these sided kinds a voice without "/opp" lines stays
silent). A reply knows whether the bot is the speaker's partner and, while
tricks are played, whether its team made trump: "Nat!" is answered only then,
by the partner agreeing ("nat/maat") or by a bot of the playing team
protesting; after the hand, or from a player whose own team plays, it gets no
answer. The
server allows a bot at most one line per trick and one per 8 s, scaled by
Chattiness (the gap is 8 s / max(Chattiness, 0.2)); per event at most one bot
speaks (two for the greeting and game end), and about 60% of human lines get a
reply attempt.

## 6. Server behaviour

### Rooms and codes

- Code: 4 letters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (no I, O), unique among live
  rooms, case-insensitive on input. Join link: `https://klaverjas.kroes.dev/ABCD`.
- Creator sits at seat 0 and is host. If the host leaves, or stays disconnected
  for 30 s while another human is connected, the next human becomes host
  (checked when the 30 s are up, and again when someone else gives a host
  command such as `rematch` or `lobby`). A room is removed 30 min after game over (players
  still connected get `onbekend`) and at once when the last human leaves its
  lobby. With no human connected it is removed after 30 min while a game runs
  that still has a human seat, and after 5 min in the lobby, after game over,
  or once every human has left (bots play all seats; a vacated seat can be taken
  over until then). Max 500 rooms (`Config.MaxRooms`): when full, a new game
  replaces the room that has had no human connected for longest (at least
  2 min), else error `te-veel-spellen`.
- Bots in the lobby: when `humans < 4`, seats are prefilled with random distinct
  personas so that remaining human seats are partners where possible
  (`humans`=2 → bots at 1 and 3; 3 → bot at 3; 1 → bots at 1,2,3). Changing
  `humans` in the lobby adds/removes bots (never removes humans; cannot go
  below the current human count). The host can put a bot (chosen or random) on
  any empty seat and remove bots. Humans may move to any empty seat. At start,
  empty seats get random distinct bots.
- Joining a lobby: first empty seat, unless `humans` humans are already seated
  → error `vol`, whose text says what to ask the host: a seat more under
  *Spelers*, or, when bots the host placed fill every seat, one bot less
  (with four people seated, nothing can be done). Joining a
  running game: allowed only to take over a *vacated* seat (a human left; a
  bot plays it meanwhile), else error `gestart` (after game over its text asks
  the host to set the table up again).
- A join refused from a full lobby or after game over is told to the table:
  the system line "… wilde aanschuiven, maar de tafel is vol." and, for the
  host only, a `refused` message (§7), at most once per 30 s per room whatever
  the name (names are free text; a code guesser must not flood the host).
- After game over the host chooses: `rematch` starts a new match at once with
  the same seats and options; `lobby` takes the room back to phase `lobby`
  under the same code and options. There the humans keep their seats (except
  those disconnected for longer than the 30 s host grace), bots placed in the
  lobby stay, and the seats that bots filled at the start or after a human left
  are empty again, so a late friend can join and the host can change seats,
  bots and options before starting. Scores and the previous hand are cleared.
  The system line says "Wie wil, kan nu aanschuiven." only when a seat for a
  human is free. Training has no lobby.
- Reconnect: `join` with the room's code and the seat token returns you to your
  seat, mid-game included. Without the token (another device, cleared storage),
  a `join` with exactly the same name takes back a human seat that has been
  disconnected for at least 3 min (a locked phone keeps its seat): the seat
  gets a new token, the old one then gets `onbekend`, and a system line says
  "… speelt verder op een ander apparaat".
- A human who disconnects keeps the seat (event `away`, `connected: false`). If
  it is their turn and they are still away after 20 s, a substitute bot (level
  normaal) plays for them (a second `away` event, `away: true`) until they
  return (`back`). Explicit `leave` mid-game (or at game over) vacates the seat:
  a random persona at the room's level plays it (system line "… neemt het
  over") until a joiner takes it over. A second connection that joins with the
  same token takes the seat over; the old one gets `onbekend`.
- A bot (or substitute) decides once per turn, in the background: a sterk
  search uses all cores for a moment. Reconnects, window switches and a seat
  changing hands during the turn reuse that decision; it is played when the
  think time is up (counted from the turn, or from when a substitute starts).
- If no human is connected, the game pauses (bots do not play, the hand summary
  waits); when someone returns, bots think again and the summary countdown
  restarts.
- Bot chat (limits in §5): a bot does not repeat one of its last two lines for
  the same kind of event (numbers aside: "20 roem" and "50 roem" are one line);
  it asks for another line a few times and otherwise stays silent.
- System chat lines (`sys`, seat -1): start, joining, a join refused because
  the table is full, leaving (and which bot takes over), away/back of a
  substitute, a seat taken back on another device, host changes, rematch, back
  to the lobby (and a gone player's seat freed).

### Pacing (ms, scaled by tempo; `-fast` multiplies everything by 0.05)

| | rustig | normaal | snel |
|---|---|---|---|
| bot think time (× persona Speed, ± 30%) | 1500 | 900 | 450 |
| deal animation before first action | 2000 | 1500 | 900 |
| trump/bid announcement pause | 1200 | 900 | 500 |
| completed trick on table before collect | 2200 | 1500 | 800 |
| hand summary before auto-continue (unless all humans `ready`) | 15000 | 12000 | 8000 |

The hand summary also ends as soon as every human still connected is `ready`,
including when the last one not ready leaves or drops. In training it does not
auto-continue at all: the learner looks back at the hand and goes on with
`ready` (`nextAt` is 0).

During a pause nobody may act (`turn` is -1). Humans have no time limit.
Pauses start with `deal`, `trump` (and a `bid` with `play: true`), `trick` and
`handEnd`. A pause ends with the event that follows it (`turned` opens the
bidding in gedraaid, `collect` gives the lead to the winner, `deal` or
`gameOver` after the summary), or else with an update whose `ev` is null that
opens the turn (utrechts after the deal; voorhand's first lead after trump).

### Limits

WebSocket messages ≤ 4 KiB; per connection ≤ 20 messages/s (excess:
disconnect) and ≤ 1 `join` per second (burst 3; more: error `limiet`); chat
≤ 200 characters, 1 per second with burst 5; names 1–20 characters (nothing
visible → "Speler") and never with "(AI)" in them, in any spelling (case, full
width, look-alike letters or brackets, spaces or invisible characters in
between): only bots carry it. Names and chat lose control and format
characters (bidi controls, zero-width spaces, soft hyphens, tag characters; a
zero-width joiner stays between visible characters, as in 👩‍🏫), blank fillers
(Hangul fillers, the empty Braille pattern) count as spaces, runs of whitespace
become one space, trimmed, and a character keeps at most 3 combining marks; a
chat line with nothing visible is dropped. Room creation ≤ 20 per 10 minutes
and ≤ 10 live rooms per client IP (`X-Real-IP` from nginx, else remote address;
over a limit, or `MaxRooms` reached with no idle room to replace: error
`te-veel-spellen`); ≤ 16 websocket connections per IP (more: HTTP 429 before
the upgrade). Failed joins (`onbekend`, `vol`, `gestart`) ≤ 10 per minute per
IP; then joins from that IP get `limiet` for 5 minutes, except a `join` with a
valid seat token (room codes cannot be guessed). Chat over the limit: error
`limiet`; over the message rate: error `limiet`, then the server closes the
connection (status 1008). WebSocket `Origin` must match
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
| `ready` | | Phase `handEnd`: continue now (ignored once the next hand is dealt: a late tap on the summary) |
| `chat` | `text` | Any time |
| `rematch` | | Host, phase `gameOver`: new match, same seats and options |
| `lobby` | | Host, phase `gameOver`, not training: back to the lobby, same code and options (§6) |
| `leave` | | Leave the room |
| `ping` | | Keepalive (server answers `pong`) |

### Server → client

| `t` | Fields |
|---|---|
| `joined` | `code`, `seat`, `token` (store in localStorage under `kj.token.<code>`) |
| `update` | `seq`, `ev` (event or null), `s` (full state for you) |
| `chat` | `msg`: `{seat, name, text, ts, bot, sys}` (`sys`: system line, seat -1) |
| `chatlog` | `msgs`: last 50, sent after `joined` |
| `tip` | `text` (training: explanation after a trick, Dutch; when you played another card than the hint, it ends with the advised card and why: "Juf Ans had ♣9 aangeraden: …"; the first trick's tip of a hand also says so of a trump choice or bid against the hint, before any card: "Juf Ans had ♥ als troef aangeraden: …", "Juf Ans had aangeraden om te passen: …") |
| `refused` | `name`: to the host only, someone could not join because the table is full (§6); no state change, so no `update` |
| `error` | `code`, `msg` (Dutch, ready to show) |
| `pong` | |

Error codes: `onbekend` (no such room, or no longer in it: room removed, seat
taken over by another window, or taken back by name on another device), `vol`,
`gestart`, `geen-host`, `niet-jouw-beurt`, `ongeldig` (bad card/suit/fields;
`msg` from `ExplainIllegal` for cards), `limiet` (rate limit, also for joins
after too many failed ones), `te-veel-spellen`, `herstart` (server restarting;
client reconnects after a delay).

Every state change is one `update`: the client queues updates, animates `ev`
from its previous state to `s`, then renders `s`. A resync (join, reconnect)
is an `update` with `ev: null`; so is a change without animation (a pause ends
and a turn opens, `ready` flags, a host change). `seq` increases per room with
every event; a resync carries the current `seq` (the joiner gets `ev: null`
where the others get `join`/`back` with the same `seq`). A choice by `bid` with
`play: true` sends `bid`, then `trump`.

### Events (`ev.type`)

| type | fields | client animation |
|---|---|---|
| `lobby` | | none (seat/option changes) |
| `deal` | `handNo`, `dealer` | cards fly from the dealer to each seat, 3-2-3 |
| `turned` | `suit` | gedraaid: show the turned suit |
| `bid` | `seat`, `play` | speech bubble "Spelen!"/"Pas" at the seat |
| `trump` | `seat`, `suit`, `forced` | banner "Opa Dirk (AI) kiest ♥ als troef" |
| `play` | `seat`, `card` | card flies from the seat to its trick slot |
| `trick` | `winner`, `points`, `roem` [], `last` bool | highlight winning card; roem burst "+20 Stuk!" |
| `collect` | `winner` | trick slides to the winner and fades |
| `handEnd` | `result` (HandResult as JSON, below) | summary overlay: gehaald/nat/pit, seen from the viewer's team (§9 Review) |
| `gameOver` | `total` [2], `winner` (0,1, or -1 draw) | celebration |
| `join` / `leave` / `away` / `back` | `seat` | small toast |

### State `s`

```jsonc
{
  "code": "KQXB", "phase": "lobby|trump|bid|play|handEnd|gameOver",
  "opts": { "humans":4, "hands":16, "trumpMode":"utrechts", "rules":"amsterdams",
            "ai":"normaal", "tempo":"normaal", "open":false },
  "training": false, "you": 0, "host": 0,
  "roster": [ {"id":"dirk","name":"Opa Dirk","emoji":"👴","color":"#8a5a2b","bio":"…"} ],  // lobby only: bot picker
  "players": [ // always 4 entries; null = empty seat
    { "name":"Piet", "bot":false, "botId":"", "emoji":"", "color":"",
      "connected":true, "away":false, "cards":8, "ready":false },
    { "name":"Opa Dirk (AI)", "bot":true, "botId":"dirk", "emoji":"👴", "color":"#8a5a2b",
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
  "nextAt": 0,                     // handEnd: unix ms of auto-continue (0 in training: waits for ready)
  "hint": null,                    // training, your turn: {"card":"AH"} | {"suit":"H"} | {"play":true}, plus "text"
  "hands4": null,                  // training with open: all four hands [[...],...]
  "winner": -1                     // gameOver
}
```

`HandResult` JSON: `{"playingTeam":0,"trumpBy":2,"trump":"H","dealer":1,
"points":[104,58],"roem":[20,0],"score":[124,58],"nat":false,"pit":false,"pitTeam":-1}`.

Every key above is always present, except `roster` (lobby only) and `legal` and
`rule` (only on your turn in phase `play`). Further:

- `turned`: the turned suit in gedraaid from the deal on (the `turned` event
  opens the bidding), else null.
- `trick`: null outside `trump`/`bid`/`play`; a complete trick stays until
  `collect`, then it is the empty next trick led by the winner (`turn` = winner).
  Tricks carry `points` and `roem` too (0 and `[]` while in progress).
- `lastTrick`: the latest completed trick of this hand (null after a new deal;
  kept through `handEnd` and `gameOver`).
- `hand` is `[]` and `turn` -1 outside a hand; during `handEnd`/`gameOver`,
  `dealer`, `voorhand`, `trump`, `trumpBy`, `playingTeam`, `tricksWon`,
  `handPoints` and `handRoem` still describe the finished hand.
- `players[i].cards` is 0 outside a hand; `ready` only counts in `handEnd`.
- `hint` and `hands4` are null unless they apply; `hint.text` is always set.

## 8. Seinen (signals) — used by normaal and sterk bots and explained in the manual

The manual's section is titled *Seinen*; its text and the glossary also give
the other name, *voorkaarten*.

- **Aas voorspelen**: leading the ace of a side suit says "ik heb ook de
  10 van deze kleur". After the ace that 10 is the highest card of the suit,
  so the partner can safely lead the suit back later (*veilig terugkomen*).
  An ace led without the 10 breaks the promise. Bots read it while the 10 is
  out, in the first five tricks, and come back in the suit with a low card.
  Normaal holds back an ace whose 10 it lacks; sterk never leads such an ace
  while it has an honest card to lead.
- **Kleintje boer**: leading a small card (7, 8, 9) of a side suit signals "ik heb de
  troefboer"; partner wins and returns trump. It is given by the trump maker
  on its first lead (in utrechts the opening lead of the hand; bots as maker
  give it only then, with the boer and at most one other trump, no nel), or by
  the maker's partner on its first lead, while the boer is still out. Bots of
  the playing team do not lead such a card without the boer when they have
  another sensible lead, so they read it as a promise.
- **Boer over boer**: leading a side-suit boer while holding the trump boer.
  Bots do not read it; hints name it, and say when a side-boer lead of the
  playing team is none.
- **Hoog/laag bijspelen**: discarding a small card (7, 8 or 9: cards without
  points) says "speel deze kleur, daar heb ik de hoogste van"; discarding a
  10 or picture card says the opposite, "ik heb weinig in deze kleur". Bots
  give and read the low one in the first six tricks (the discarder holds the
  highest card of that suit still out; sterk fakes it only for ≥ 20 points),
  not the high one; a hint names the
  high one for a discard that tells the truth (at most one other card of the
  suit left, not its ace).
- **Tegenkleur seinen**: discarding a suit to ask for the suit of the other colour of
  the same shade (harten ↔ ruiten, klaveren ↔ schoppen).
- **Spekken (ook wel smeren)**: give points (10, aas) to a trick your partner
  is sure to win (*je maat spekken*).
- **Maat heeft de slag** (Amsterdams): no need to trump; give points
  (spekken) instead.

## 9. Frontend

Vanilla ES modules, no framework, no build step, no inline `<script>`/`<style>`
and no `style="…"` attributes or `setAttribute('style')` (CSP `style-src
'self'`; setting `el.style.x` from JS is fine). Build DOM with
`document.createElement`/`textContent`; never `innerHTML` with user or server
text. At most 17 requests per page load in total, the websocket included
(NPM's rate limit for the name is in shrek-infra, `docs/services/klaverjas.md`):
html, 3 css, favicon, manifest, one PNG icon (Chrome's install check),
≤ 6 app modules, cards.js, sound.js, manual.js, the websocket. No service worker. System font stack.
`localStorage` access wrapped in try/catch (keys prefixed `kj.`).
Icons: `favicon.svg` (tab; manifest `any`), `icon-192.png` and `icon-512.png`
(manifest `any`, rendered from favicon.svg), and from the full-bleed
`icon-full.svg` (felt to every edge, artwork inside the central 80% circle)
the opaque `apple-touch-icon.png` (180 px; iOS fills transparency black and
also asks for this path by itself) and `icon-maskable-512.png` (manifest
`maskable`). The PNGs are rendered once with `rsvg-convert` (commands in
icon-full.svg) and committed; `test/ui/app-icons.test.mjs` checks them.
Link preview: `index.html` has Open Graph tags (`og:title`, `og:description`,
`og:image` and its size and alt text, `og:locale` `nl_NL`; no `og:url`, since
the same file serves `/` and every `/ABCD`). `og:image` must be absolute:
the file says `https://@SITE@/og.png` and the web image build fills in the
host name (the dev server keeps the placeholder). `og.png` is an opaque
1200×630 PNG under 300 KB (WhatsApp skips larger ones) of the felt, the
clover and a fan of real card faces, rendered by `test/ui/og-image.mjs` and
committed. Browsers never fetch it, so the request budget is unchanged.
WhatsApp and iMessage build the preview on the sender's phone; iMessage's
fetcher calls itself `facebookexternalhit`, which NPM's bot filter refuses
outside the house, so its previews show the image only for a sender at home.
Server-side previewers (Telegram, Slack, Discord) fetch from datacenter
addresses that shrek's firewall drops.

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

// web/js/sound.js — synthesised with WebAudio, no audio files
export const sound = {
  unlock(),            // call on the first user gesture (also self-armed on any gesture); Promise, never rejects
  play(name),          // 'card','deal','shuffle','trick','trickWon','roem','trump','turn','chat',
                       // 'nat','pit','handWon','handLost','win','lose','click','error','join'
  setMuted(bool), isMuted(), setVolume(0..1), getVolume()   // persisted in localStorage kj.sound
};

// web/js/manual.js — the in-game handleiding (Dutch content + renderer)
export const SECTIONS = [ {id:'bediening',title:'Bediening'}, {id:'regels',title:'Spelregels'},
  {id:'punten',title:'Kaartwaarden'}, {id:'roem',title:'Roem'}, {id:'seinen',title:'Seinen'},
  {id:'tips',title:'Tips'}, {id:'woorden',title:'Woordenlijst'} ];
export function renderManual(sectionId, opts = {}) // → HTMLElement with that section's content (uses cards.js for illustrations);
                                                  // opts.icon(name) (util.icon) puts the buttons' pictograms in the Bediening chips
// Styles for the manual content live in web/css/manual.css (classes prefixed man-).
```

### Screens and flows (minimal clicks)

- **Home**: name field (remembered), and big buttons: *Snel spelen*
  (one tap: solo vs 3 bots, starts immediately, straight from home to the table
  without showing the lobby; it uses the options last chosen for a new game,
  named under the button when they differ from the defaults; "AI-spelers"
  never breaks at its hyphen), *Nieuw spel*
  (options sheet with defaults → *Maak spel*), *Meedoen* (4-letter code field;
  joins as soon as 4 letters are typed), *Oefenen* (training), *Handleiding*.
  Snel spelen and Oefenen (bots only) never ask for a name: without one the
  player is "Speler", which is not stored as their name. *Nieuw spel* and
  *Meedoen*, where others see the name, ask for it first, gently: the name
  field takes the focus with a soft glow and a toast "Hoe heet je?" says why.
  Opening a join link `/ABCD` goes straight to joining (asks only for a name if
  none is stored and the browser holds no seat token for that room, so a
  reload in a game without a name goes back to the seat). Enter (the keyboard's go key) in the name field joins that
  invite, or the code typed before the name was asked for.
- **Lobby**: big code + *Kopieer link* + *Delen* (`navigator.share` where
  available; when copying fails the link is shown in a field to copy by hand);
  a mini table with the four seats (teams visible); tap an empty seat to
  sit there; host taps an empty seat to add a bot (choose a character or random),
  ✕ to remove one; host edits options; *Start* (ignores taps for 0.8 s after
  the lobby first shows, so a double tap on *Maak spel* cannot start the game
  before friends can join). The hint under the code says when every seat for
  a human is taken ("Zet Spelers hoger als er nog iemand mee wil doen."). A
  `refused` gives the host a toast "… wil meedoen, maar de tafel is vol" with
  what to do (*Zet Spelers op 3*; after game over *Spelers of regels
  wijzigen*). A joiner turned away with `vol` or `gestart` lands on home with
  the code back in the *Meedoen* field, so trying again is one tap.
- **Table**: you at the bottom with your hand as a fan; partner on top, opponents
  left/right with card backs and names; dealer chip; turn glow; trump indicator;
  score bar *Wij – Zij* with names; potje n/16; buttons for chat (with unread
  badge), score sheet, last trick, help, settings, sound (a toggle:
  `aria-pressed` while the sound is on, tooltip "Geluid aan" / "Geluid uit",
  icon to match; on phones it is in the ⋯ menu). Where a name must
  shorten (lobby seat, score bar, *Laatste slag*), only the name does: its
  "(AI)" stays readable ("Kees de Vi… (AI)"). The trump badge's details show
  what the badge shows, also during the trump banner. Whatever the order of
  play, every card in the trick keeps one corner index in view, also under a
  winner scaled up with its ring: the top and left cards their top-left one,
  the bottom and right cards their bottom-right one (the left card sits a
  little low, the right card a little high). Open hands and your own hand
  show each card's whole index (`app-checks.mjs --only corners` measures
  the trick and the hands). A card flying from a hand to the trick takes
  off with that hand's index and grows or shrinks it to the trick's on the
  way.
  Playing: on fine pointers one click plays a legal card; on touch the first tap
  lifts the card and a second tap (or swipe up) plays it (setting: one tap /
  two taps); the prompt then says so ("Tik nog eens om ♠A te spelen"), and the
  only legal card plays on the first tap. Illegal cards are dimmed; tapping one
  shows `ExplainIllegal`-style text (the client may derive it from `rule`); a
  tap during a pause (`turn` -1) says to wait. Keyboard: ←/→ select, Enter
  plays; the trump/bid panel and the hand summary focus their main button on
  fine pointers, and dialogs keep Tab inside. Trump choice: four big suit
  buttons (forced: turned suit disabled). Bidding: *Spelen* / *Passen*.
- **Back button**: every closable overlay (dialog, chat drawer) has a history
  entry, so back (the Android gesture) closes the top one; at a table one more
  entry makes back ask *Spel verlaten?* instead of leaving the page.
- **On-screen keyboard**: `index.html` sets `interactive-widget=resizes-content`,
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
- **Connection**: a `play`, `trump` or `bid` without any answer within 4 s
  means a dead socket: the client reconnects. Every rejoin drops what was sent
  but unanswered and renders purely from the resync. A tab in the background
  still sounds the turn and shows "● Jouw beurt" in its title. Leaving while
  offline sends `join` (with the seat token) + `leave` over a short-lived
  connection of its own once the network is back. Without `localStorage` the
  name and seat tokens live in memory for the life of the page.
- **Game over**: final score with the team names; the host gets *Nog een
  partij* (`rematch`) and, outside training, *Spelers of regels wijzigen*
  (`lobby`: back to *Klaarzetten* under the same code, where the start guard
  runs again); everyone gets *Scorebord* and *Naar start*.
- **Feedback**: card fly-in animations, winner highlight, trick collection
  toward the winner, roem burst, trump banner, speech bubbles for bids and bot
  chat, nat/pit splash, animated score count-up, confetti on winning; short
  waits so every move can be followed; `prefers-reduced-motion` shortens all.
- **Score sheet**: per hand: trump suit, who played (marker), points+roem per
  team, nat (red) / pit (gold), running totals ("stand" under each hand).
  Team names keep "(AI)", one name per line.
- **Review**: *Laatste slag* shows the previous trick at the seats with winner,
  points and roem; the hand summary (and the score sheet for the previous hand,
  which stays open while updates arrive) shows all 8 tricks of the finished
  hand in play order, each card underlined in its team's colour; tapping a
  trick shows it at the seats like *Laatste slag*. The summary's headline
  speaks from the viewer's team (`handHeadline` in util.js): we played and
  made it *Gehaald!*, went nat *Nat!*; they made it *Zij halen het*, went nat
  *Zij gaan nat!*; our pit *Pit!* (gold, also when they went nat), theirs
  *Zij halen pit*; good news for us in our colour, bad news in red. The
  whole summary fits without scrolling: on phones (< 600 px wide) the tricks
  are a 4 × 2 grid of small tiles (number and points over the cards), in
  short landscape they sit beside the score; the ready chips show only with
  another person at the table.
- **Chat**: drawer (side panel on wide screens), quick reactions (👍 😂 😱 "Mooi!"
  "Nat!" "Goed gespeeld"), bot lines, system lines, unread badge (counts what
  people write; system lines and bot chatter, shown as speech bubbles, do not).
  Speech bubbles stay behind the cards of the trick and never overlap each
  other: a chat line in the way of another bubble waits for room (dropped
  after 6 s; it is in the chat log), while a bid (*Ik speel!*, *Pas*) shows at
  once and ends a chat bubble in its way.
- **Training**: tip bubble with the hint text and a glow on the advised card;
  for the trump or bid choice the hint is inside the panel (in short landscape
  the bubble sits beside it); ✕ closes a hint until the next one; tips after
  each trick (`tip`), shown until you play your next card; optional open
  cards; Juf Ans as partner; the hand summary has no countdown ring (`nextAt`
  0) and waits for *Volgend potje*. In short landscape the bubble sits in the
  top-left corner and never covers the left seat (who plays after you): a
  long text shows the lines that fit and *Lees verder* (then *Minder*).
- **Help**: the manual (SECTIONS) in a modal, plus `title` tooltips and small ⓘ
  explanations on UI elements.
- **Responsive**: phones portrait (360×640 up, and an iPhone SE in Safari:
  375×548) and landscape (≥ 640×360), tablets and desktop; touch targets
  ≥ 44 px; no horizontal scroll.
- **Look**: green felt table with vignette, wooden rim, gold accents, team colours
  (Wij teal/blue, Zij coral/red), dark UI chrome; four-colour deck option.

## 10. Deployment

- `Containerfile` stages: `build` (the official golang Alpine image: `go vet`,
  `go test -short ./...`, static build with `-trimpath -ldflags "-s -w -X
  main.version=$GIT_SHA"`), `server` (`FROM scratch`, binary + CA-less, `USER
  65532:65532`), `web` (`nginxinc/nginx-unprivileged`, Alpine, `deploy/nginx.conf`,
  `web/`). The base tags (minor versions) live only in the `Containerfile`;
  `scripts/go` and `scripts/dev-server` read the build image from its `FROM … AS
  build` line, and `make image` builds with `--pull=newer`, so a fix re-published
  under the same tag reaches the next deploy. The `web-conf` stage renders
  `@SITE@` into `nginx.conf` (checked with `nginx -t`) and into `index.html`
  (`og:image`), which the `web` stage copies over the one from `web/`.
- `deploy/nginx.conf`: listen 8080; `/ws` → `http://127.0.0.1:8081` with Upgrade
  headers and long read timeout; `/api/` → same; `location ~ "^/[A-Za-z]{4}$"` →
  `/index.html`; security headers in one place (CSP `default-src 'self';
  connect-src 'self' wss://@SITE@; img-src 'self' data:; style-src 'self';
  script-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self';
  object-src 'none'; form-action 'none'`, nosniff, Referrer-Policy,
  Permissions-Policy, COOP, HSTS `max-age=31536000; includeSubDomains`), each sent
  once on every path (`scripts/pod-check`); `Cache-Control: no-cache` for html/js/css (ETag
  revalidation) so a deploy is picked up at once, a day for images, but never
  for a 404, which is `text/html` whatever the path's extension; gzip; `X-Real-IP` forwarding:
  NPM's `X-Real-IP` is trusted from `127.0.0.1` only and passed on as the one
  client address (`X-Forwarded-For` is dropped); `Host` is passed unchanged
  (`$http_host`), which the websocket Origin check compares against.
- Quadlets rendered by `make install` into `~/.config/containers/systemd/`:
  `klaverjas.pod` (`PublishPort=127.0.0.1:8093:8080`; `Network=pasta:--host-lo-to-ns-lo`,
  so NPM's connections arrive from `127.0.0.1` instead of the host's LAN
  address; `ExitPolicy=continue`, so both containers dying at once does not
  stop the pod for good), `klaverjas-web.container`,
  `klaverjas-server.container` (`Pod=klaverjas.pod`, `Pull=never`, `ReadOnly`,
  `NoNewPrivileges`, `DropCapability=ALL`, health checks).
- `Makefile` like `/storage/CLIC/ISMS/Makefile`: `help test test-all e2e dev
  dev-stop image install deploy check status logs uninstall quadlet`, settings
  `SITE ?= klaverjas.kroes.dev`, `ADDR ?= 127.0.0.1:8093`. The revision
  (`GIT_SHA`, the image label and `/api/health`'s version) is `HEAD`, with
  `-dirty` when `git status` lists anything; each build tags both images
  `<GIT_SHA>-YYYYmmdd-HHMMSS`, and only `make deploy` then moves `:current`
  (what the units run) to it, so `make image` alone never changes what a
  restart starts. `make deploy` refuses a dirty tree unless `ALLOW_DIRTY=1`,
  and ends with `make check`.
- NPM proxy host (made by hand; it exists, ID 37): `klaverjas.kroes.dev` →
  `http://127.0.0.1:8093`, wildcard certificate, Force SSL, Block Common
  Exploits, **Websockets Support ON**, no access list, HTTP/2 off (either
  works); Advanced empty and NPM's HSTS box off, since HSTS comes from
  `deploy/nginx.conf` (recorded in `deploy/npm-advanced.conf`).
