# Klaverjas

The site **klaverjas.kroes.dev**: klaverjas for two to four players, with
friends and bots, with lessons by Juf Jannie, the Spelanalyse after a match
and an expert mode. It is played at the table of
[docs/server.md](../../docs/server.md), with the protocol of
[docs/protocol.md](../../docs/protocol.md), from the shell of
[docs/frontend.md](../../docs/frontend.md); this file has what is klaverjas's
own: its rules, options, Go APIs, bots, signals, protocol messages and
screens. Its packages are `games/klaverjas/game` (the rules) and
`games/klaverjas/bot` (the bots), its server side the
`platform/server/klaverjas_*.go` files, still built into the table
([docs/architecture.md, "What is not generic yet"](../../docs/architecture.md#what-is-not-generic-yet)),
and its site `games/klaverjas/web`.

## Rules as implemented

Source: <https://nl.wikipedia.org/wiki/Klaverjassen>. Four players, two pairs;
partners sit opposite. 32 cards (7–A in four suits), 8 cards each, dealt 3-2-3.
Tables of three and two players follow the same rules with the changes in
"Three players" and "Two players" at the end of this section.

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

### Three players (Wikipedia "Klaverjassen met drie personen")

- Seats `0..2` clockwise; every player has a score of their own. Each gets
  10 cards (dealt 3, then 2 to the **talon**, 4, 3); the talon's two cards
  lie closed on the table.
- **Auction** (phase `auction`), starting with voorhand, clockwise: a bid is
  the points (card points plus roem) one promises to make playing alone:
  at least `MinBid` 80, then each bid at least `BidStep` 10 higher, at most
  `MaxBid` 300; or pass. Who passed is out. Once two players passed, the
  third plays alone (the **soloist**) at its highest bid; when nobody bid,
  the last one left plays for 80 (`forced`). Trump mode does not apply.
- **Discards** (phase `discard`): the soloist takes the talon (12 cards) and
  lays two cards away face down; their card points count for the soloist at
  the end of the hand (roem in them does not). Then the soloist chooses
  trump (phase `trump`, any suit). Voorhand leads the first trick.
- Tricks of three cards; roem per trick as with four (driekaart and stuk can
  occur). The soloist's two opponents are partners for the hand: the
  Amsterdams partner rule applies between them.
- Sides: the soloist is side 0, the other two side 1 (`Deal.Side`).
  `points`, `roem` and `score` of a hand are per side; card points of both
  sides add up to 162 with the discards.
- **Scoring**: the soloist makes it when its points plus roem are at least
  the bid (`ScoreSolo`). Made: each side scores its own points plus roem.
  Nat: the soloist scores 0 and side 1 scores 162 plus all roem. Side 1's
  two players each get half of side 1's score, rounded up (`gains`). Pit
  (all 10 tricks): +100 roem for that side.
- Choices made where Wikipedia leaves room: the discards count for the
  soloist (one of its variants; the total stays 162), the minimum bid is 80
  in steps of 10, a forced soloist plays for 80, and nat gives the other two
  everything, as with four.

### Two players (Wikipedia "Klaverjassen met twee personen")

- Seats `0` and `1`, opposite. Each gets 16 cards laid out as **eight piles
  of two** in two rows of four: pile `i` (0..7) is cards `i` (on top) and
  `8+i` (under it) of the dealt 16; piles 0..3 are the front row, nearest
  the player. The top cards of the front rows are face up from the deal.
- Trump as `trumpMode` says (utrechts: voorhand chooses; gedraaid: a turned
  suit, voorhand then dealer say spelen or passen, both pass → voorhand
  chooses another suit). Then the top cards of the back rows turn face up.
- **Roem in the open cards**: the moment trump is known, the roem in each
  player's eight face-up cards counts for that player (`SetRoem`: every run
  of three (20) or four or more (50) in a suit, all four of a rank (100,
  boeren 200), stuk). In a two-card trick only stuk can still occur.
- Only face-up cards can be played; following suit and trumping apply to
  the face-up cards (no partner: Amsterdams and Rotterdams agree). When a
  trick is complete, the cards under the ones played turn face up.
- 16 tricks; last trick +10, pit (all 16) +100 roem. Scoring as with four:
  the player who made trump must make more than half, else nat. Sides are
  the seats.

## Options

Set by the host in the lobby; JSON keys on the wire. The table's own
options (`players`, `ai`, `tempo`, `seed`) mean what
[docs/server.md, "Table options"](../../docs/server.md#table-options) says;
these are klaverjas's values and what is particular to it:

| Key | Values | Default | Meaning |
|---|---|---|---|
| `players` | 2, 3, 4 | 4 | The game of [Rules as implemented](#rules-as-implemented) for four, three or two players. Training is always 4 |
| `hands` | 4, 8, 12, 16, 20, 24 | 16 | Hands in the match; a lesson has its own, 8 (`lessonLength`, [Lessons](#lessons)) |
| `trumpMode` | `utrechts`, `gedraaid` | `utrechts` | [Choosing trump](#choosing-trump-trumpmode) |
| `rules` | `amsterdams`, `rotterdams` | `amsterdams` | [Following suit](#following-suit-rules) |
| `ai` | `makkelijk`, `normaal`, `sterk` | `normaal` | The lesson on signals raises `makkelijk` to `normaal` |
| `tempo` | `rustig`, `normaal`, `snel` | `normaal` | The table's pacing ([docs/server.md, "Pacing"](../../docs/server.md#pacing)) |
| `open` | bool | false | Training and expert only: show all hands face up |
| `lesson` | `basis`, `roem`, `seinen`, "" | "" | Training only (else ""): the lesson Juf Jannie gives, a match of its own ([Lessons](#lessons); the rows of the Oefenen sheet, [Home](#home)); "": *vrij spelen*, no lesson |
| `tips` | bool | true | Training only (else false): a hint on every turn and an explanation after every trick (`tipsOn`; *Tips* in the Oefenen sheet) |
| `signals` | `{"aas","kleintjeBoer","hoogLaag","boerOverBoer"}`, bools | all true but `boerOverBoer` | The table's agreements on signals ([Seinen](#seinen-signals)), for four players; keys left out keep their default. The lesson on signals plays the defaults when all are off |
| `seed` | 1..999999999, or 0 / null | 0 | The same seed deals the same first dealer, hands, talon and turned suit. The start line in the chat and the Spelanalyse show the seed of the match. The Oefenen sheet keeps it in `kj.train`, the expert sheet in `kj.expert` |
| `from` | 1..24, or 0 / null | 0 | Expert only (else 0): the match is hand `from` of the seed's deals alone, dealt as in the whole match (the deals before it are drawn and passed over, the deal passing on as often) and numbered so; `hands` is raised to a length that holds it. 0: the whole match |

The UI label for the variant is "Utrechts/Amsterdams" etc.: `trumpMode` +
`rules`; with three players "Met z'n drieën, Amsterdams" (no trump mode: they
bid), with two "Met z'n tweeën, Utrechts" (no rules: nobody has a partner).

### Training mode

`training: true` at create makes a solo room: 1 human at seat
0, partner bot **Juf Jannie** at seat 2, two random opponents, tempo `rustig` by
default, nobody else can join. With option `tips`, on by default, the player
gets hints and an explanatory tip after every trick (the last trick of a
hand waits for its tip, [Training: the last trick waits for its tip](#training-the-last-trick-waits-for-its-tip); each tip is a line of Juf Jannie in the chat too).
With option `lesson` Juf Jannie gives one of her lessons, a match each
([Lessons](#lessons)); without it the match is *vrij spelen*, with those hints and tips
alone. `trainingOpts`, at `create` and on `opts`, keeps the table to four
players, a lesson to its length, and the lesson on signals to something to
teach: at `makkelijk` it plays `normaal`, and with no agreements the defaults.
A training table with `makkelijk` bots plays without signals (`noSignals`):
they neither give nor read one, Juf Jannie included, so no hint counts on
one. As in the expert mode, the player asks the
engine's reasoning for their own decisions (`why`, the robot in the top bar,
[Expert](#expert)) and comments on them while the match runs.

### Expert mode

`expert: true` at create, reached only by an easter egg on the home
screen ([Home](#home)), makes a solo room as well: 1 human at the
seat that `create` names (`seat`, 0–3; left out or out of range: 0), the
host, three random bots at the room's level on the other seats, always four
players, `open` allowed, no hints or tips, nobody else can join ("Dit is een
expertspel; daar kun je niet aan meedoen."), no lobby (it starts at once;
`lobby` is refused, a `rematch` plays the same seed and hand again, at the
same seat). It deals from `seed` and `from` by seat, as a game of four with
the same seed and options deals: the same first dealer, and the same cards
for seat k. The state's `expert` is true, and the expert may ask `why`
about their own decisions and give feedback about one of them, while the
match runs and after it ([Expert mode on the server](#expert-mode-on-the-server), [Protocol](#protocol)). The review per hand and the Spelanalyse
are those of any game at a table of four.

## Go APIs

### Package game

`games/klaverjas/game`, the rules engine. The seats and the 32-card deck
(`Seat`, `Card` and what a card is made of) are `platform/cards`'s, shared
with toepen; this package re-exports them, so the names below stay valid.

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

type Seat int                            // 0..3; func (s Seat) Next() Seat; Partner(); Team() int (four players)
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

// Legal cards for `seat` holding `hand`, given the current (incomplete) trick
// (four players: the partner is the seat opposite; a Deal knows every table).
func LegalMoves(hand []Card, trick Trick, seat Seat, trump Suit, rules Rules) []Card
// Short Dutch explanation of the constraint, shown above the hand on your turn:
// "Je komt uit: speel wat je wilt", "Bekennen: speel ♦", "Troef gevraagd: overtroeven",
// "Je moet troeven", "Je moet overtroeven", "Je maat heeft de slag: vrije keuze",
// "Je kunt niet bekennen en hebt geen troef: vrije keuze", ...
func ExplainConstraint(hand []Card, trick Trick, seat Seat, trump Suit, rules Rules) string
// Why a specific card is illegal (Dutch), "" if legal: "Je moet bekennen (♦).", ...
func ExplainIllegal(card Card, hand []Card, trick Trick, seat Seat, trump Suit, rules Rules) string

// Display order: suits alternate colour, trump (if known) first; within a suit low→high
// by the order that applies (trump order for trump).
func SortHand(hand []Card, trump Suit, trumpKnown bool) []Card

type Phase string // "auction", "discard" (three players), "trump", "bid", "play", "done"

// One hand ("potje") for 2, 3 or 4 players: a pure state machine. No timing,
// no randomness inside.
type Deal struct { /* unexported fields */ }
func NewDeal(dealer Seat, hands [4][]Card, mode TrumpMode, rules Rules, turned Suit) *Deal  // four players
func NewDealFor(players int, dealer Seat, hands [4][]Card, talon []Card, mode TrumpMode, rules Rules, turned Suit) *Deal
func Shuffle(rng *rand.Rand) [4][]Card   // math/rand/v2, deal 3-2-3
func ShuffleFor(players int, rng *rand.Rand) (hands [4][]Card, talon []Card) // the rules: 3-2-3; 3, talon, 4, 3; 16 each (piles)
func (d *Deal) Phase() Phase
func (d *Deal) Turn() Seat               // whose action is awaited; -1 if done
func (d *Deal) ChooseTrump(seat Seat, s Suit) error   // utrechts, forced after all passed (not the turned suit), or the soloist
func (d *Deal) Bid(seat Seat, play bool) error        // gedraaid
func (d *Deal) Auction(seat Seat, bid int) error      // three players: bid (MinNextBid()..MaxBid, steps of BidStep) or 0 to pass
func (d *Deal) Discard(seat Seat, cards []Card) error // three players: the soloist lays two cards away
func (d *Deal) Play(seat Seat, c Card) error          // validates the rules (partner per table)
func (d *Deal) Hand(seat Seat) []Card                 // the cards seat can play: with two players its face-up ones
func (d *Deal) Trump() (Suit, bool)
func (d *Deal) TrumpBy() Seat            // -1 before trump is known
func (d *Deal) PlayingTeam() int         // side of the trump maker (Side), -1 before trump is known
func (d *Deal) Forced() bool             // gedraaid: all passed, voorhand must choose; three players: nobody bid
func (d *Deal) Players() int
func (d *Deal) Side(seat Seat) int       // team with four; with three 0 = soloist, 1 = the other two; with two the seat
func (d *Deal) Partner(seat Seat) Seat   // opposite with four; with three the other opponent of the soloist; else NoSeat
func (d *Deal) Contract() (Seat, int)    // three players: highest bid and bidder (the soloist once the auction is over)
func (d *Deal) MinNextBid() int
func (d *Deal) Talon() []Card            // three players: the two cards of the talon
func (d *Deal) Discards() []Card         // three players: what the soloist laid away (after phase discard)
func (d *Deal) Piles(seat Seat) [8]Pile  // two players: {N, Up, Card} per pile
func (d *Deal) OpenRoem(seat Seat) []RoemItem // two players: roem of the face-up cards once trump is known
func (d *Deal) Constraint() string       // ExplainConstraint for the seat on turn
func (d *Deal) Turned() Suit
func (d *Deal) Bids() [4]int             // -1 none yet, 0 pass, 1 play
func (d *Deal) Current() Trick           // trick in progress (may be complete until next Play)
func (d *Deal) Tricks() []Trick          // completed tricks, in order
func (d *Deal) Result() HandResult       // valid when Phase()=="done"
func (d *Deal) View(seat Seat) View      // everything `seat` may know

type HandResult struct {
    Players int; PlayingTeam int; TrumpBy Seat; Trump Suit; Dealer Seat
    Points [2]int; Roem [2]int            // per side, raw, before nat
    Score  [2]int                         // per side
    Nat bool; Pit bool; PitTeam int       // PitTeam -1 if none
    Bid int; Discards [2]Card             // three players
    Gains [4]int                          // per scorer (Scorers): what goes on the score sheet
}
func Scorers(players int) int             // 2 teams with four players, else one per player
func ScorerOf(seat Seat, players int) int
func ScoreSolo(bid int, points, roem [2]int) (score [2]int, nat bool) // three players
func SetRoem(cards []Card, trump Suit) []RoemItem // roem in up to eight open cards (two players)
type Pile struct{ N int; Up bool; Card Card }     // JSON {"n":2,"card":"JH"|null}

type View struct {
    Players int; Seat Seat; Hand []Card; Dealer Seat; Voorhand Seat
    Mode TrumpMode; Rules Rules; Phase Phase; Turn Seat   // Turn: NoSeat when done
    Trump Suit; TrumpKnown bool; TrumpBy Seat; PlayingTeam int; Partner Seat
    Turned Suit; Bids [4]int; Forced bool
    Bid int; Bidder Seat; Talon, Discards []Card   // three players (talon and discards: the soloist only)
    Piles [2][8]Pile; OpenRoem [2][]RoemItem       // two players
    Current Trick; Tricks []Trick          // full history of this hand (bots may remember)
    Legal []Card                           // when it is Seat's turn in phase play
    HandNo, HandsTotal int; MatchScore []int    // zero from Deal.View; the server fills them
}
```

Semantics and additions (implemented in `games/klaverjas/game`):

- `View.Current` is the trick the next card goes into: once a trick is complete
  it is already the next, empty trick led by the winner (the completed one is the
  last of `View.Tricks`); when done it is the last trick. `Deal.Current()` keeps
  the complete trick until the next `Play` (for display). `LegalMoves` and friends
  treat a complete trick as empty (next card leads).
- `Deal.Tricks()` includes a completed trick that is still `Current()`.
- `HandResult.Roem` includes the `PitBonus` (100); `Deal.HandRoem()` does not.
- Errors (Dutch texts, safe to show): `ErrWrongPhase`, `ErrNotYourTurn`,
  `ErrBadSuit`, `ErrTurnedSuit`, `ErrNotInHand`, `ErrIllegal`, `ErrBadBid`
  (wrapped with the lowest bid allowed), `ErrBadDiscard`; `Play` returns
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
  `AppendTrickRoem(dst, cards, trump)`, `RoemPoints(cards, trump)`,
  `RoemAdded(cards, c, trump)` (the roem card c adds to at most three cards:
  `RoemPoints` with c less without);
  on card sets as bitmasks (`uint32`, bit `Card.Index` per card):
  `LegalReply(hand, lead, leader, seat, trump, rules)` (`LegalMoves` for the
  second card of a trick that leader led with lead), `d.HandMask(seat)` (as
  `d.AppendHand`) and `d.LegalMask()` (as `d.AppendLegal`; 0 outside phase
  play);
  `Deal` holds no slices or maps, so `*dst = *src` (or `d.Clone()`) is a full
  independent copy; `d.AppendLegal(dst)`/`d.Legal()` for the seat on turn,
  `d.AppendHand(dst, seat)`, `d.HandLen(seat)`, `d.TrickCount()`.
  `Resume(v View, hands [4][]Card) (*Deal, error)` rebuilds a deal in phase play
  from a view plus every seat's remaining cards (e.g. sampled hidden hands);
  with three players `v.Discards` must hold the (sampled) discards, with two
  `hands[s]` holds only seat s's face-down cards, pile by pile.
  `ResumeInto(d *Deal, v *View, hands) error` is `Resume` into an existing
  Deal, which it overwrites (after an error d is unusable), so a search
  reuses one Deal per worker; `NewDeal`/`NewDealFor` are small enough to be
  inlined, so a deal that does not outlive its caller stays off the heap.
- A Deal holds every seat's cards at the places they were dealt (16 places
  per seat) with masks for played and face-up cards, so copying it stays a
  full copy for every table size. It also keeps each seat's playable cards
  as a mask (with the place of each), and the current trick's winning card
  and highest trump as cards are played, so the rules need no loop over the
  hand, and `Play` judges only a card that neither leads nor follows a side
  suit led (those are always allowed). Its tricks are compact (seats as
  int8, roem as indexes), so a Deal is about 700 bytes: every playout
  starts from a copy.
- Deal accessors for the server: `Dealer()`, `Voorhand()`, `Mode()`, `Rules()`,
  `TricksWon() [2]int`, `HandPoints() [2]int` (incl. last trick),
  `HandRoem() [2]int`.

Tests in `games/klaverjas/game` are table-driven and exhaustive for: legal moves in
both rule sets (all branches above), trick winner, roem (each kind, combos,
stuk+sequence, four of a kind, no false positives), scoring (normal, nat, tie =
nat, pit, pit by defenders), deal state machine (both trump modes, forced
choice, turn order, last-trick bonus, 162 total); for three and two players
the auction, discards, piles, open roem, random deals against the reference
rules, and Resume. The random deals also check the bitmask fast paths
(`HandMask` for every seat, `LegalMask`, `LegalReply`) against the
reference, and `ResumeInto` against `Resume`; `RoemAdded` is checked
against `RoemPoints` for every set of up to three cards, every card added
and every trump. Benchmarks: `BenchmarkPlayout` (a hand of random legal
cards played out on a copy of a Deal), `BenchmarkLegalMoves`,
`BenchmarkRoemPoints`.

### Package bot

`games/klaverjas/bot`, the bots, the hints and the review.

```go
type Level int  // Makkelijk, Normaal, Sterk; String() "normaal"
func ParseLevel(s string) (Level, error)    // "makkelijk"|"normaal"|"sterk"; error → Normaal
type Persona struct {
    ID, Name, Emoji, Color, Bio string   // Name without "(AI)"; Bio is Dutch, one line
    Aggression float64  // 0..1: willingness to play/choose trump on weaker hands, to go for pit
    Chattiness float64  // 0..1: chance of commenting on events
    Speed      float64  // multiplier on think time (0.6 fast .. 1.4 slow)
}
func Roster() []Persona                       // 8 personas (Bots)
func ByID(id string) (Persona, bool)

type Player interface {
    ChooseTrump(v game.View) game.Suit       // utrechts, forced (must not return v.Turned when v.Forced), or the soloist
    Bid(v game.View) bool                    // gedraaid: play on v.Turned?
    Auction(v game.View) int                 // three players: a bid of at least v.MinNextBid(), or 0 to pass
    Discard(v game.View) [2]game.Card        // three players: two cards of v.Hand to lay away
    Play(v game.View) game.Card              // must be in v.Legal
}
func New(p Persona, lvl Level, seed uint64) Player

// Advice for the training hints, Dutch text. Trump and bid advice is the
// sterk choice. A play hint gives the reason of what chose its card, so
// the two cannot drift apart (why.go):
//   - The normaal policy returns with each card the rule that chose it
//     (decide: rule). The hint is that card with the rule's reason, and
//     what the rule's own costs weighed: the cheaper or richer card it
//     kept in hand and why ("Met ♠H zou je de tegenstanders 50 roem
//     geven", "♠A is de hoogste schoppen en kan zelf nog een slag halen"),
//     and for a lead the roem that decided it ("met ♠8 kunnen de
//     tegenstanders in deze slag roem maken: ♠7, ♠9 en ♠10 zijn nog in het
//     spel").
//   - Unless the sterk card is better by at least max(5 points, 2 paired
//     SE): then the hint is that card, with how much more it brings than
//     the rule's card and in which part of the value mainly. The search
//     keeps per card, from the same playouts, the points and the roem in
//     the card's own trick and in the later tricks (ours minus theirs)
//     in the playouts where the hand is made, all of that under nat where
//     it goes nat, and the pit bonus; they sum to the value ("Speel ♠V:
//     volgens de berekening levert dat gemiddeld 9 punten meer op dan ♠8,
//     vooral in de roem van deze slag"). A gain in nat without more or
//     less nat is in what the hands that go nat are worth ("vooral doordat
//     alle punten en roem naar jullie gaan als de tegenstanders nat gaan
//     (100%)"). Then what the playouts of the two cards do differently in
//     the same deals (diff.go: the search keeps per deal which of the
//     player's cards their team wins, who wins the last trick and the roem
//     in the card's own trick): the difference that brings the most, when
//     it is at least 2 points, a quarter of what the card brings more in
//     points and roem before nat and pit, and two paired SE, and its
//     shares as written go the same way ("Je ♣10 gaat in 100% van de verdelingen naar de tegenstanders als je
//     ♣9 speelt, en in 51% als je ♣10 speelt.", "Jullie halen de laatste
//     slag in …", "De tegenstanders maken roem in deze slag in 30% van de
//     verdelingen als je ♥10 speelt, en in 5% als je ♥A speelt."). The two
//     cards compared count together, one played now and the other later;
//     the one named must gain clearly and the other lose at most 2 points.
//   - What the card signals at the table (Seinen) is added: true, or a
//     warning when the partner would read something untrue.
// Every play hint opens with "Speel ♠V: ". The search values every option
// by the points it brings alone: the bots' appetite for pit (Aggression)
// plays no part.
type Advice struct {
    Card *game.Card; Suit *game.Suit; Play *bool
    Text string     // e.g. "Speel ♥A: je maat heeft de slag nog niet en de aas is hoog."
}
func Advise(v game.View) Advice
// Dutch explanation of a finished trick for training tips:
// "Fatima (AI) wint de slag met ♥B, de hoogste troef. 25 punten, roem: stuk (20)."
func ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string
// The signals (Seinen) in the last completed trick of v at a table of four, as
// the table reads them (true or not), for the lessons: Kind
// "kleintjeBoer", "boerOverBoer" (a lead), "aas" or "hoogLaag" (a low
// discard); Means the card it says Seat holds (the trump boer, the 10, the
// highest card left in the suit). SignalChance: a signal the player of v
// can give truthfully with a legal card on their turn, prefer first.
type Signal struct{ Seat game.Seat; Card game.Card; Kind string; Means game.Card }
func TrickSignals(v game.View) []Signal
func SignalChance(v game.View, prefer game.Card) (Signal, bool)

// The review of a player's decisions (Spelanalyse, on the server and on screen). GradeChoice runs the
// search of Advise on the same view (same seed), so it agrees with the hint.
// Points are expected score differences between the teams, as in the hints:
// the player's team's score minus the opponents' at the end of the hand
// (nat and pit included), averaged over the sampled deals (400 for a card,
// 320 for a trump choice or bid), each played out by the normaal policy.
type Choice struct{ Card *game.Card; Suit *game.Suit; Play *bool } // exactly one set
type Grade struct {
    Stake   float64 // best minus worst option; 0 without a choice (one legal card)
    Lost    float64 // the hint's option minus the choice when that is at least
                    // max(5, 2 paired SE), the hint's tolerance; else 0
    Gain    float64 // a strong move: the choice is the hint's option, the normaal
                    // choice differs and is worse by at least max(10, 2 paired SE); else 0
    Better  Choice  // the hint's option, when Lost > 0
    Obvious Choice  // the normaal option, when Gain > 0
    Text    string  // the hint for Better (Lost > 0) or for the choice (Gain > 0)
    Nat     float64 // a bid to play: the estimated chance of going nat
    Played, Other Outcome // the choice and Better or Obvious, when Lost or Gain is set:
                    // Lost = Other.Us−Other.Them − (Played.Us−Played.Them), Gain the reverse
}
// What an option leads to, averaged over the sampled deals: the final score
// of the player's team and of the opponents, and the chance that the one or
// the other plays and goes nat.
type Outcome struct{ Us, Them, NatUs, NatThem float64 }
func GradeChoice(v game.View, c Choice) Grade
// The expert mode's reasoning for one decision of v.Seat (on its turn, a
// table of four; else, or should the search fail, empty). It searches as
// Advise (same view, same seed, the same 400 or 320 deals, points alone),
// so it agrees with the hint and the review.
type Explanation struct {
    Normaal  Choice   // the normaal choice (the rule-based card, bestTrumpNormal, the bid threshold at aggression 0.5)
    Rule     string   // a card: the hint text of the rule that chose it ("Speel ♠A: …"); else ""
    Sterk    Choice   // sterk's pick from this search at average aggression (sterkPick, the bid without bias)
    SterkWhy string   // a card: why Sterk is not a card the search values most (sterkChoose: a false signal
                      // short of its gain, or the normaal card kept as close enough or above the honest one); else ""
    Hint     Choice   // the hint (Advise)
    HintText string
    HintWhy  string   // a card: why the hint keeps the normaal card while sterk plays another; else ""
    Worlds   int      // deals per option; 0 with one legal card (no search)
    Options  []Option // the legal cards (in v.Legal order), the allowed suits, or spelen then passen
}
type Option struct {
    Choice
    Value float64   // expected score difference, as in Grade
    SE    float64   // paired standard error of its difference with the best option; 0 for the best
    Outcome
    Parts []float64 // a card: points in its trick, in later tricks, roem in its trick, in later tricks,
                    // all that under nat when the hand goes nat, and the pit bonus (searchWhy's parts);
                    // they sum to Value less what was scored before it
    Why   string    // a card below the best: why the best brings more, as a hint's search reason
                    // ("♣8: volgens de berekening levert dat …", then "Dat verschil is kleiner dan twee
                    // keer de standaardfout en kan toeval zijn." when it is, then the difference in
                    // the playouts); "… en … zijn volgens de berekening even goed: …" under half a
                    // point; else ""
}
func Explain(v game.View) Explanation
// What the cards dealt to v.Seat are worth to its team against an average
// hand in the same seat: the mean score difference when the hand is played
// from the deal by the normaal policy (bids and trump choice included) over
// 320 sampled deals of the other cards, minus the same over 20000 random
// deals (computed once per trump mode and rules). v is the view at the deal.
func HandLuck(v game.View) float64

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

#### Strength levels

- **makkelijk**: legal moves with simple heuristics and deliberate mistakes
  (~30% random legal card), naive trump choice (longest suit) and bidding (on
  the boer or on length; Aggression moves the bar, e.g. cautious personas want
  the boer with another trump, bold ones also play on the nel with two more).
- **normaal**: rule-based play: win tricks with the cheapest winning card (a
  cheap side-suit trick is ruffed with the lowest trump that wins, not with
  the boer or nel), give points (*spekken*, also *smeren*: a 10 or ace) when
  the partner is winning, discard low otherwise, pull trumps when playing
  team, keep the nel/boer guarded, count trumps played, sensible trump choice
  (boer/nel/aas/length). Gives and reads kleintje boer ([Seinen](#seinen-signals)) and never leads a
  small side card that would falsely promise the boer when it has another
  lead. Holding the ace and the 10 of a side suit it leads the 10 first: it
  wins just as surely, can still bring roem (the ace only with heer and
  vrouw), and leaves the ace on top (in self-play +1.2 points per hand over
  ace first). It never leads under its own ace, gives the ace with its 10
  to the partner's trick (met de aas seinen, [Seinen](#seinen-signals)) but avoids an ace without
  it, avoids a low discard that would falsely claim the highest card of its
  suit (opseinen), and leads into a suit whose highest card the
  partner signalled. Leading, it weighs roem: every side card is a
  candidate, and each run of three through it whose two other cards are
  still out with two other players counts 8 points for the team that
  probably takes the trick: the mover's with the highest card of the suit
  or in the suit of the partner's signalled highest card (when nobody is
  known to ruff it), else the opponents'. So it leads ♦H from ♦H ♦V
  rather than ♠8 with ♠7 ♠9 ♠10 out. In duplicate self-play against the
  lead without roem this gains normaal 3.3 points per hand. Sterk already
  weighs roem at its own lead through the search's score; that its
  playouts now lead the same way changes it by −0.2 ± 0.65 points per
  hand (24,000 deals), nothing measurable.
- **sterk**: card tracking with inference (voids from not following suit,
  trump obligations), determinised Monte Carlo: sample hidden hands consistent
  with everything known, evaluate each legal move by playouts with the normaal
  policy, ~150–400 samples within ~150 ms; trump choice by simulation; reads the
  signals of [Seinen](#seinen-signals) (met de aas seinen, opseinen, kleintje boer) as soft
  evidence. It gives kleintje boer when that costs at most a few points, and
  fakes it (a small side card without the boer) only when that gains clearly
  (≥ 10 points), a false opseinen or met de aas seinen only for ≥ 20
  points, since partners and humans read the signals as promises. Between
  cards that win and lose alike (no card still out lies between them, as
  ♥A and ♥10 in one hand), it plays the normaal card unless the search
  rates the other higher by more than the hints' tolerance (5 points, or
  two paired standard errors); the hints and the Spelanalyse do the same. Exactly equal search
  results go to the rule-based card, then to the cheaper card.

#### Arena, benchmarks and identity

Each persona modulates its level's choices (Aggression shifts thresholds) and
chat. `games/klaverjas/bot` has an arena test (skipped with `-short`) that plays many
hands between levels and asserts sterk > normaal > makkelijk in average points.
Its benchmarks (`bench_test.go`) time the sterk decisions: with four players
the first lead (also on one core), a card mid-hand, the trump choice and the
bid; at the smaller tables a card, the trump choice, the bid with two, the
auction and the discard with three; a training hint, the grades of one
player's hand and the same with a hint before each, `HandLuck`; and a whole
hand of sterk bots at four, three and two players on one core each, the CPU
a table of bots costs per hand. `TestIdentity`, skipped without
`-identity.out=FILE`, writes for 384 seeded deals every decision of every
level, the hints, grades and explanations and the raw search statistics to
FILE: a change that must keep every decision (a speed-up) leaves it byte for
byte the same.

#### Measured strength

Measured strength (2026-10-28; the harness was kept out of the
repo): duplicate deals, sterk choosing trump for both teams, signals off,
Utrechts. Sterk beat seven klaverjas engines with public source code by 6 to
34 points per hand (400 to 1,000 duplicate deals per engine and setting),
normaal by 27 and makkelijk by 57; 3,200 deals per card did not measurably
beat 400. With the default signals at all seats, sterk's margin against each
engine moved by about 2 points per hand at most, and sterk with signals did
not beat sterk without (+0.7 ± 0.9 over 3,000 deals). The manual's
*Juf Jannie* page quotes these numbers.

#### Tables of three and two

At a table of three or two (`games/klaverjas/bot/small.go`, `smallsearch.go`) the
levels keep their meaning with their own policy; the signals of [Seinen](#seinen-signals) play no
part. Normaal plays by rules of thumb: the side that made trump draws trumps
while it holds the strongest, everyone cashes cards that win for sure (with
two players the opponent's answers are known from its face-up cards), the
soloist's opponents give points to each other's sure tricks, otherwise win
cheaply or throw the least useful card. Sterk samples the hidden cards
(three players: the others' hands and, for the opponents, the soloist's
discards, within the voids play has shown; two players: the face-down cards)
and plays every legal card out with that policy, three times as many deals
as with four (the playouts are short). In the auction every level plays out
deals in which it plays alone with the talon (soloPlan lays away a bare 10
or a short side suit and picks trump) and bids while playing alone is worth
more than defending (fitted in self-play); makkelijk with few deals and too
boldly. The arena test also checks sterk > normaal > makkelijk at both
smaller tables.

### The AI seam

The table sees klaverjas's bots and analysis through the interface `AI` of
package `server`; `cmd/klaverjas/ai.go` adapts package `bot` to it, and
`server.Klaverjas(ai)` makes the game
([docs/server.md, "Config and New"](../../docs/server.md#config-and-new)).

```go
type Persona struct{ ID, Name, Emoji, Color, Bio string; Chattiness, Speed float64 }
type Brain interface {
    ChooseTrump(v game.View) game.Suit
    Bid(v game.View) bool
    Auction(v game.View) int            // three players
    Discard(v game.View) [2]game.Card   // three players
    Play(v game.View) game.Card
}
type Advice struct{ Card *game.Card; Suit *game.Suit; Play *bool; Text string }
type Choice struct{ Card *game.Card; Suit *game.Suit; Play *bool }                   // as bot.Choice
type Grade struct{ Stake, Lost, Gain float64; Better, Obvious Choice; Text string; Nat float64; Played, Other Outcome } // as bot.Grade
type Outcome struct{ Us, Them, NatUs, NatThem float64 }            // as bot.Outcome
type Explanation struct{ Normaal Choice; Rule string; Sterk Choice; SterkWhy string; Hint Choice; HintText, HintWhy string; Worlds int; Options []Option } // as bot.Explanation
type Option struct{ Choice; Value, SE float64; Outcome; Parts []float64; Why string }
type ChatEvent struct{ Kind string; Mine bool; Text string; Points int; InHand, Playing bool } // as bot.ChatEvent
type Signal struct{ Seat game.Seat; Card game.Card; Kind string; Means game.Card }           // as bot.Signal
type AI interface {
    Personas() []Persona
    NewBrain(personaID, level string, seed uint64) Brain   // level "makkelijk"|"normaal"|"sterk";
                                                           // personaID "" = neutral substitute for a human who
                                                           // dropped out, once the others agreed (docs/server.md, "Takeover consent")
    Advise(v game.View) Advice
    Grade(v game.View, c Choice) Grade    // the review (Spelanalyse on the server)
    HandLuck(v game.View) float64
    Explain(v game.View) Explanation      // the expert's why (Protocol)
    ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string
    TrickSignals(v game.View) []Signal                    // the lessons (Lessons)
    SignalChance(v game.View, prefer game.Card) (Signal, bool)
    Chat(personaID string, ev ChatEvent, rng *rand.Rand) string
}
```

## Bots

The personas' identities are the table's
([docs/server.md, "Personas"](../../docs/server.md#personas)); their characters
at klaverjas:

| ID | Character |
|---|---|
| `dirk` | Speelt al zestig jaar in café De Klaver. Voorzichtig en degelijk; spreekwoorden. |
| `truus` | Kletst honderduit en is dol op roem; optimistisch. |
| `sjaak` | Gokker: speelt op dunne handen en gaat voor de pit. |
| `fatima` | Wiskundestudent die elke kaart telt; kort van stof. |
| `kees` | Mopperkont, maar eerlijk; moppert als hij nat gaat. |
| `jannie` | Geduldige juf die graag uitlegt; partner in de oefenmodus. |
| `bram` | Jong en snel, speelt op gevoel, chat met emoji. |
| `vera` | Staat om vijf uur op, speelt scherp en vriendelijk. |

### Bot chat

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
answer. The server limits how often bots speak
([docs/server.md, "Bot chat"](../../docs/server.md#bot-chat)).

## On the table

What klaverjas does at the table beyond [docs/server.md](../../docs/server.md).
The takeover question ([docs/server.md, "Takeover consent"](../../docs/server.md#takeover-consent))
is asked in phases `auction`, `discard`, `trump`, `bid` and `play`.

### Spelanalyse on the server

Spelanalyse ([the screen](#spelanalyse)), at a table of four only (three and two players get no
review: `review` stays null, and `handReview` is refused): every decision
a connected human makes with a
choice (a card when more than one is legal, a trump choice, a bid) is
graded in the background with `AI.Grade` on the view it was made on, and
each human's cards with `AI.HandLuck` at the deal. A substitute's decisions are not
graded. At most GOMAXPROCS/4 analyses (at least 1) run at once over all
rooms, each on one core; one whose match is over, or whose room is gone,
is skipped when its turn comes. The roem a human's card adds to the
cards on the table, beyond the least that one of their legal cards would
add, counts as given away when the opponents take the trick. Every
decision of a connected human (also a lone legal card) is timed, from the
turn opening (after the pause before it) to the decision, if they were
connected all along: a turn that opened while they were away, or in which
their connection dropped, is not. A match starts
every review afresh; a seat that changes hands starts a new one.
Every graded decision is also kept with its hand, by hand number, with
what its grade says (`choices` of the hand in `replay`, [The review](#the-review)): in trick
order, within trick 0 a bid before a trump choice (gedraaid: the pass,
then the forced trump choice). A grade that did not run (skipped as
above, or a panic) or came out with stake 0 (a failed search, or options
that all came out the same) is left out there; the review's sums are as
before. Each hand also counts its grades still out. A player asks for a
finished hand of the match (not the hand in play) with `handReview`, in
any phase but the lobby, and alone gets that hand as the replay shows
it, with their own graded decisions and the number of that hand's grades
still out (`pending`). The review remembers the hand asked last: every
grade of that hand that comes in later, kept or not, sends that player a
fresh `handReview` while they are connected, so an open replay fills in
as the grades arrive, and coming back after a dropped connection sends
it once more, with what came in meanwhile. A new match forgets it. A player without a review
gets the hand with no decisions. The state carries none of this. At game
over each human's state carries their own review and nobody else's
(`review`, [The review](#the-review)); while grades are still out it is `{"pending": true, …}`,
and the player gets an update without event once the last one is in.

### Expert mode on the server

Expert mode ([Expert mode](#expert-mode); `klaverjas_expert.go`): the state's `expert` is true. A `why`
names one of the expert's own decisions by hand and trick (1–8; 0: the
bid or trump choice before the first card): one made, or the one awaited
now in the hand in play. Trick 0 is the expert's last bid or trump choice
before the first card, except while the hand in play is in its bid or
trump phase and it is the expert's turn: then it is the decision awaited
now (in gedraaid, after everyone passed, voorhand's trump choice, not
their pass before it, which can no longer be asked about then). The
server rebuilds that moment of the hand from the cards as dealt and the
decisions (`acts`, as in the game log) up to it, and works out the `why`:
`AI.Explain` on the expert's view then, match fields filled in as for the
bots, and the signals the table plays with by then (`r.signals`: none in
the lessons on the basic game and on roem, nor in training with
`makkelijk` bots). It runs in the background, one
at a time per room (another meanwhile: error `limiet`) and one at a time
over all rooms (the search takes every core; others wait their turn),
and the answer goes to the asker alone. The expert gives `feedback` while
the match runs and after it, about the game or about one of their own
decisions (hand and trick), at most 200 lines per match. The review per
hand and the Spelanalyse are as for anyone at a table of four. Training
has `why` and this `feedback` as well (`room.reasoning`), with option
`tips` on or off.

### Chat at the start of a match

The system line at the start of every match, rematches included, with its seed, so nobody has to play to the end to see it
("Spel (482913) begint: 16 potjes, Utrechts/Amsterdams. Veel plezier!";
with `from` "… begint: potje 5, …"); right after it, with four players,
the table's signals ([Seinen](#seinen-signals)): "Seinen aan deze tafel:" and a line for each
agreement with what it says, the texts of Juf Jannie's lesson on signals
(`signalRules`), or "Aan deze tafel spreken we geen seinen af.", which
is also what training with `makkelijk` bots says; a lesson has neither, as
Juf Jannie gives them herself in the lesson on signals and the other
lessons play without.

### Game log records

Klaverjas's `match` record has no `game`; it always has `training`, and
`expert` when set, and its `opts` are klaverjas's options. Its own records
([docs/server.md, "Game log"](../../docs/server.md#game-log) has the rest):
`hand` (`hand`, `dealer`, `turned`, `cards` per seat as one
string "7SAS9H…", `talon` with three players, `acts`, `result`: the
HandResult), `review` (`seat`, `name`, `review`: the review state of
[the protocol](#the-review) without `replay`, once every grade is in) and `feedback` (`seat`,
`name`, `ip`, `device`, `text`; from the expert and in training also
`hand`, `trick` and `by`, the player's own seat, when about one of their
decisions). `acts` lists the hand's decisions in order,
space-separated: the seat, then a card ("2AS"), or `b1`/`b0` (spelen,
passen), `tH` (trump), `a90` (auction bid; `a0` pass), `dJS7H` (laid away).

### Pauses

Pauses start with `deal`, `trump` (and a `bid` with `play: true`), `contract`
(three players: the announcement pause, then the soloist lays away), `trick`
and `handEnd`. A pause ends with the event that follows it (`turned` opens the
bidding in gedraaid, `collect` gives the lead to the winner, `deal` or
`gameOver` after the summary), or else with an update whose `ev` is null that
opens the turn (utrechts and the auction after the deal; the soloist's
discards after the contract; voorhand's first lead after trump).

Alone at the table (training, or one person with bots) the hand summary
does not auto-continue at all: the
player looks back at the hand and goes on with `ready` (`nextAt` is 0). That
can change during the summary (`timeSummary`): when a leave leaves one person,
the countdown stops; when a joiner makes two, it starts in full.

### Training: the last trick waits for its tip

In training with option `tips` the last trick of a hand, which comes with a
tip, stays on the table until the tip is read: the trick pause, or longer for a longer tip
(`readTime`: 2 s plus 250 ms a word of the longest tip, at most 20 s, not by
tempo), or until `tipRead`. `nextAt` says when it goes; the summary would
otherwise cover the tip at once.

### Lessons

Training with option `lesson`. Juf Jannie gives three lessons, chosen in the Oefenen sheet ([Home](#home)): option
`lesson` is `basis`, `roem` or `seinen`, or "" for *vrij spelen*, the game
without a lesson. Each lesson is one match of `lessonLength` hands (8;
`trainingOpts` forces option `hands`), taught a step at a time (`klaverjas_lesson.go`).
A step is the state's `lesson`,
`{n, text, spot, card, manual}`, for the learner alone; `spot` names the
part of the screen it is about ([Lessons on screen](#lessons-on-screen)), `card` the card in the hand for spot
`card`, `manual` a section of the manual ([manual.js](#manualjs)) the step links to. The game waits for it without a timer: the pause
it comes in (`turn` -1, `nextAt` 0) ends only when the learner has read every
step of it, each with `tipRead` and its `n` (a `tipRead` for another `n`,
or with an `n` when no step is on screen, came late and changes nothing).
On the learner's own turn a step needs no pause: the turn is open, the hint
follows once it is read, and playing a card reads it too. Every step is a
line of Juf Jannie in the chat (`coach`), after the first update that shows
it. What is taught, per match, its hands counted from the first (`taught`;
a rematch repeats the lesson from the start, as `startMatch` clears it):

| Lesson | Hand | What | Constant |
|---|---|---|---|
| `basis` | 1 | the intro, trump, which cards may be played, every trick waits for its explanation, the score | |
| `basis` | 3 | the card points, then the last trick's 10 | `pointsHand`, `lastShows` |
| `roem` | 1 | roem, then the first tricks with roem | `lessonShows` |
| `roem` | 5 | counting the trumps, with a counter in this hand only | `countHand` |
| `seinen` | 1 | the table's signals, then the first chances and bot signals | `lessonShows` |
| all three | the last | a closing step after its last trick | `closingText` |
| vrij spelen | | no steps: the hints and tips of option `tips` alone | |

- **Intro**, in `basis` after the deal of the first hand, before the first
  turn: six steps: Juf Jannie is your partner, opposite (`partner`; how to go
  on), 32 cards, 8 each (`hand`), a trick and who leads the next (`trick`),
  trump and who chooses it in this hand, or in gedraaid that a suit will be
  turned up (`trump`), points and Wij/Zij (`score`), tips, explanations, that
  the hint is free to ignore, and the chat (`chat`; with option `tips` off
  only the chat: no step promises tips that do not come).
- **Trump**, in `basis` when the first trump announcement ends: the boer and
  the 9 are the highest trumps, the ace the highest in the other suits, and
  the whole order is in the manual (`trump`, manual `punten`).
- **The learner's turn** in play, in `basis`, the first time they lead
  (`lead`), must follow suit (`follow`), trump was led and they hold trump
  (`trumpLed`), may play anything (`free`: no card of the suit led and no
  trump, or trump led and none held), must trump (`trump`, with overtroeven
  when a trump lies), or need not trump on the partner's trick (`partner`);
  spot `rule`. Other situations are left to the rule above the hand.
- **The first hand** of `basis`: every trick waits for its explanation (the
  tip as a step, spot `trick`; no `tip` message), and the last one also for
  the score: points and roem per side, who made trump and had to get more,
  gehaald or nat (`score`). With option `tips` off a trick has no explanation
  to wait for: it waits only for a step of its own, and the last one for the
  score.
- **Points**, in `basis` from the third hand (`pointsHand`): at its deal,
  before the first turn, that the cards in the tricks are worth points, which
  the most, with the manual for the rest (manual `punten`), then 152 + 10 for
  the last trick = 162, and that the side that made trump must get more, or
  goes nat (`score`, two steps; roem is left out, as it has its own lesson).
  Then the last trick of the first two hands (`lastShows`): its 10 extra
  points, and which side gets the trick's points (spot `trick`).
- **Roem**, in `roem` at the first deal, before the first turn: what roem is,
  who gets it, and what each kind is worth (two steps); then the first three
  tricks with roem (`lessonShows`): the cards it is made of ("♠9, ♠10 en ♠B
  op een rij (driekaart, 20)", "♥V en ♥H van troef (stuk, 20)") and which
  side gets it (spot `trick`). In `basis` the first trick with roem says what
  roem is in a sentence, that the lesson on roem teaches it, and that it can
  be ignored until then (spot `trick`). Roem counts in the score in every
  lesson.
- **Counting the trumps**, in `roem` in the fifth hand (`countHand`): when
  its trump announcement ends, how many trumps the learner holds and so the
  others, and that each trump another plays counts down; then the counter,
  for this hand only (`trump`, two steps). During its play the state's
  `trumpsLeft` is how many trumps the others still hold, from the learner's
  hand and the cards played (null otherwise). The first trick after which it
  is 0, while the hand goes on, says so: nobody can trump a side suit the
  learner plays (spot `trump`).
- **Signals**, in `seinen` at the first deal: what a signal is, then each
  agreement of the table in a step of its own. The lesson always has some:
  `trainingOpts` raises `makkelijk` to `normaal` and replaces empty `signals`
  by the defaults. Then the first three chances the learner has to signal
  truthfully (`SignalChance`, the hint's card first, if any): on their turn, before
  the hint, what the card would say and what Juf Jannie does with it, and
  "Mijn tip is een andere kaart." when the hint is another, never with option
  `tips` off (spot `card`, the card lit up in the hand); and the first three
  signals by a bot (`TrickSignals`, the learner's own left out): who gave it,
  what it says at this table, and when Juf Jannie gave it what follows for
  the learner (spot `trick`). Juf Jannie's own signal is pointed out only when
  it is true; an opponent's, true or not, says how the table reads the card.
  The lessons `basis` and `roem` play without signals: every view (bots,
  hints, the review) has no agreements (`room.signals`), so nobody gives or
  reads a signal and no hint mentions one.
- **Along the way**: in `basis` the learner's first trick won gets "Je eerste
  slag is binnen. Mooi zo." (spot `trick`). In all three the last trick of a
  hand our side won (made the contract, or the opponents went nat) gets a
  compliment: "We hebben het gehaald. Goed gespeeld.", "Zij gaan nat. Goed
  verdedigd.", with pit "Pit: alle acht slagen voor ons. Heel goed gespeeld."
  (spot `score`), at most once per two hands (`praise1` … `praise4`). In the
  first hand of `basis` the compliment follows the result in the score step. A
  hand lost gets no comment. The play analysis ([Spelanalyse](#spelanalyse)), the hints and
  the tips stay factual.
- **Closing**: the last trick of the last hand ends, after any other step,
  with what the lesson was and what comes next (`closingText`, spot `score`):
  the next lesson, chosen in Oefenen, and after `seinen` vrij spelen.

A trick with a step (the first trick won, roem, a signal, the last trick's
10, no trump left, a compliment, the closing step) waits for its explanation
first, then for the step. With option `tips` off the hints and explanations
are gone and the steps stay, but for what is named above. Juf Jannie does not greet in chat in `basis`, where she introduces herself
at once (`greets`).

## Protocol

Klaverjas's own messages, events and state, besides the table's of
[docs/protocol.md](../../docs/protocol.md). Error `ongeldig` for a card
carries `ExplainIllegal`'s text.

### Client → server

`create` also takes `training` bool and `expert` bool, and with `expert`
`seat` (0–3, optional): an expert game always starts at once, with you at
`seat` (left out or out of range: 0, [Expert mode](#expert-mode)); any
other create seats you at 0 and ignores `seat`. `lobby` is refused in
training and in the expert mode.

| `t` | Fields | When |
|---|---|---|
| `trump` | `suit` | Your turn, phase `trump` |
| `bid` | `play` bool | Your turn, phase `bid` |
| `auction` | `bid` (points; 0 = pass) | Three players: your turn, phase `auction` |
| `discard` | `cards` [2] | Three players: you play alone, phase `discard` |
| `play` | `card` | Your turn, phase `play` |
| `tipRead` | `n` (optional) | Training, a lesson step on screen (`lesson`, [Lessons](#lessons)): read, on to the next (ignored when `n` is another step's, or no step is on screen: a late tap); else, without `n`, the last trick of a hand waiting for its tip (`nextAt` set in phase `play`): on to the summary now (ignored once it is up: a late tap) |
| `handReview` | `hand` | A table of four, any phase but the lobby: a finished hand of the match (not the hand in play) as the replay shows it, with your own graded decisions in it; answered with `handReview` to you alone, and again each time a grade of that hand comes in, until you ask for another hand or a new match starts ([Spelanalyse on the server](#spelanalyse-on-the-server)). With three or two players error `ongeldig` ("Terugkijken kan alleen met z'n vieren."); in the lobby, or a hand not finished: `ongeldig` ("Dat potje is er (nog) niet.") |
| `why` | `hand`, `trick` (1–8, or 0: your bid or trump choice before the first card; on your turn to bid or choose trump, the one awaited now) | Expert and training, once the match started (also at game over): the engine's reasoning for one of your own decisions, made or awaited now in the hand in play; answered with `why` to you alone, one at a time per room (another meanwhile: `limiet`, [Expert mode on the server](#expert-mode-on-the-server)). Elsewhere, or no such decision (yet): error `ongeldig` |
| `feedback` | `text` (at most 2000 characters, cleaned per line); the expert and training also `hand` and `trick` (optional, as in `why`: about that decision of their own; the log keeps them when the match has that hand) | Phase `gameOver`, with a review: free text for the game log ([Game log records](#game-log-records)), about the game; the expert and training also while the match runs. Answered with `saved`. At most 20 per player and match, 200 in the expert mode and training |

### Server → client

`chat`'s `msg` has `coach` too: in training, a line of Juf Jannie that the
coach bubble shows, a lesson step or a trick's tip, not a speech bubble.

| `t` | Fields |
|---|---|
| `tip` | `text` (training with option `tips`: explanation after a trick, Dutch, also a `coach` chat line; not while the trick waits for it as a lesson step ([Lessons](#lessons)); when you played another card than the hint, it ends with the advised card and why: "Juf Jannie had ♣9 aangeraden: …"; the first trick's tip of a hand also says so of a trump choice or bid against the hint, before any card: "Juf Jannie had ♥ als troef aangeraden: …", "Juf Jannie had aangeraden om te passen: …") |
| `saved` | `what`: `"feedback"`: kept in the game log |
| `handReview` | `hand`, `pending` (that hand's grades still out), `replay`: the hand as in `review.replay` (below), with your graded decisions in `choices`; to you alone (client `handReview` above) |
| `why` | Expert and training: `hand`, `trick` (as asked), `seat` (yours), `played` (the choice made, null: awaited now), `normaal`, `rule`, `sterk`, `sterkWhy`, `hint`, `hintText`, `hintWhy` (both "" but for a card, see [Expert](#expert)), `worlds`, `options`: `[{card\|suit\|play, value, se, us, them, natUs, natThem, parts, why}]` — `Explanation` ([Package bot](#package-bot)) with points rounded to tenths and nat as shares of the deals (to thousandths); `parts` for cards only, `why` for a card below the best |

### Events

Besides the table's events ([docs/protocol.md, "Events"](../../docs/protocol.md#events)).
A choice by `bid` with `play: true` sends `bid`, then `trump`; the bid that
ends an auction sends `auction`, then `contract`.

| type | fields | client animation |
|---|---|---|
| `deal` | `handNo`, `dealer` | cards fly from the dealer to each seat, 3-2-3 (three players: 3, the talon, 4, 3; two: to the piles, then the front rows turn) |
| `turned` | `suit` | gedraaid: show the turned suit |
| `bid` | `seat`, `play` | speech bubble "Spelen!"/"Pas" at the seat |
| `auction` | `seat`, `bid` (0 = pass) | three players: speech bubble "90"/"Pas" at the seat |
| `contract` | `seat`, `bid`, `forced` | three players: banner "Opa Dirk (AI) speelt alleen" with the bid; the talon flies to the soloist |
| `discard` | `seat` | three players: two closed cards leave the soloist |
| `trump` | `seat`, `suit`, `forced` | banner "Opa Dirk (AI) kiest ♥ als troef"; two players: the back rows turn, then the roem of each side's open cards bursts |
| `play` | `seat`, `card` | card flies from the seat to its trick slot |
| `trick` | `winner`, `points`, `roem` [], `last` bool | highlight winning card; roem burst "+20 Stuk!" |
| `collect` | `winner` | trick slides to the winner and fades |
| `handEnd` | `result` (HandResult as JSON, below) | summary overlay: gehaald/nat/pit, seen from the viewer's team ([Review](#review)) |

### State `s`

After the shared keys ([docs/protocol.md, "The shared state"](../../docs/protocol.md#the-shared-state)):

```jsonc
{
  "phase": "lobby|auction|discard|trump|bid|play|handEnd|gameOver",
  "opts": { "players":4, "hands":16, "trumpMode":"utrechts", "rules":"amsterdams",
            "ai":"normaal", "tempo":"normaal", "open":false, "lesson":"", "tips":false,
            "signals":{"aas":true,"kleintjeBoer":true,"hoogLaag":true,"boerOverBoer":false}, "seed":0, "from":0 },
  "training": false,
  "expert": false,                 // true in an expert match (Expert mode)
  "handNo": 3, "hands": 16, "dealer": 1, "voorhand": 2,
  "turned": null, "bids": [-1,-1,-1,-1], "forced": false,   // bids: one per seat
  "bid": 0, "bidder": -1, "soloist": -1,   // three players: highest bid and bidder; the soloist once the auction is over
  "talon": [], "discards": [],             // three players, the soloist only: the talon it took, what it laid away
  "piles": null, "openRoem": null,         // two players: [[8 × {"n":2,"card":"JH"|null}], [...]], [[roem items], [...]]
  "trump": "H", "trumpBy": 2, "playingTeam": 0,
  "hand": ["AH","9H","JH","KS","TS","8C","7D","AD"],   // yours, display-sorted
  "legal": ["9H","JH"],            // only on your turn in phase play
  "rule": "Troef gevraagd: overtroeven",   // ExplainConstraint, on your turn
  "trick": { "leader":3, "cards":[{"seat":3,"card":"QH"}], "winner":-1 },
  "lastTrick": { "leader":2, "cards":[...4], "winner":3, "points":21, "roem":[] },   // or null
  "tricksWon": [2,1], "handPoints": [43,21], "handRoem": [20,0],
  "scores": [ { "hand":1, "dealer":0, "trump":"S", "trumpBy":1, "playingTeam":1, "bid":0,
                "points":[70,92], "roem":[0,20], "score":[70,112], "gains":[70,112], "nat":false, "pit":false } ],
  "total": [ 418, 391 ],           // per scorer: two teams, or one per player with three or two
  "prevHand": { "tricks":[ /* 8 completed tricks */ ], "result": { /* HandResult */ } }, // after a hand ends, until the next hand ends
  "nextAt": 0,                     // handEnd: unix ms of auto-continue (0 alone at the table: waits for ready); training, play: when the last trick, waiting for its tip, goes (Training: the last trick waits for its tip)
  "hint": null,                    // training with option tips, your turn: {"card":"AH"} | {"suit":"H"} | {"play":true}, plus "text"
  "lesson": null,                  // a lesson: the step on screen, {"n":3,"text":"…","spot":"trick"}, spot "card" with "card":"8D", a manual section with "manual":"punten" (Lessons)
  "trumpsLeft": null,              // the lesson on roem, play in the counting hand: trumps the others still hold (Lessons)
  "hands4": null,                  // training or expert with open: all four hands [[...],...]
  "winner": -1,                    // gameOver
  "review": null                   // gameOver: your own review (Spelanalyse), below
}
```

The shared keys (`code`, `you`, `host`, `roster`, `players`, `turn`,
`takeover`) are left out above; `phase`, `opts` and `nextAt` are shown with
klaverjas's values.

#### The review

`review` (null before game over, at a table of three or two, and for a
player without a graded decision, or one on its way):
`{"id":"9f2c…","pending":false,"pct":87,"hands":16,"choices":118,"luck":-6,
"lost":41,"lostN":3,"strongN":2,"leads":[9,11],"trumps":[4,5],"roem":[40,2],
"risky":[2,1],"strong":[moment…],"missed":[moment…],"speed":{…},"replay":[hand…]}`: `id` names the match
(for the history on the device), `pct` is 100 × (1 − Σ lost / Σ stake),
rounded, `luck` the mean HandLuck per hand, `lost` and `lostN` the points
and decisions with `Lost > 0`, `strongN` those with `Gain > 0`, `leads` and
`trumps` [graded without loss, graded] for leads and for trump choices and
bids, `roem` [points, times] given away, `risky` [bids to play with more than
40% chance of nat, of which nat]. `strong` and `missed` list at most three
moments each, those with the most points, in the order played:
`{"hand":5,"trick":3,"played":{"card":"TS"},"better":{"card":"AS"},"points":18,
"us":11,"them":-7,"nat":[31,18],"natThem":[0,0],
"why":"je maat heeft de slag nog niet …","text":"Speel ♠A: je maat …","table":Trick}`
— `trick` 0 and `cards` (the player's hand, display-sorted) instead of
`table` for a trump choice or bid; `played` and `better` hold one of `card`,
`suit` or `play`; `better` only in `missed`, and `alt` (the normaal option it
beat, same form) only in `strong`; `us` and `them` are what the stronger of
the two options (`better`, or the strong move) brought the player's team and
the opponents more than the weaker one (`us` rounded, `them` = `us` −
`points`), `nat` and `natThem` the chance in percent that the player's team,
or the opponents, played and went nat, with the weaker option and with the
stronger one (the grade's Outcomes); `why` is the hint's reason
without its opening ("Speel ♠A: ", "Kies ♣ als troef: ", "Passen: "). While `pending` is
true only `id` and `pending` mean anything. `hands` is 0 for a player who
took a seat over during a hand and saw no deal: no *Jouw kaarten* then.
`speed` (null when none of the player's decisions was timed, [Spelanalyse on the server](#spelanalyse-on-the-server)), times in
ms: `{"n":118,"median":2400,"total":372000,"slowest":{"hand":4,"trick":2,"ms":48000},
"others":{"n":230,"median":2100,"total":612000}}` — the player's decisions,
the median and summed think time, the slowest one (`trick` 0: a trump choice
or bid), and the same sums over the other humans of the match (null without
one). `replay` lists every finished hand of the match:
`{"hand":4,"cards":[[8 cards]×4],"tricks":[8 Tricks],"choices":[choice…]}`,
its number, the cards dealt to each seat (display-sorted under that hand's
trump), its tricks and the player's graded decisions in it
([Spelanalyse on the server](#spelanalyse-on-the-server); always an array, `[]` when none); the hand's result is the
score sheet's row (`hand`). A choice is a moment without `hand`, `cards`
and `table`, in trick order, within trick 0 a bid before a trump choice:
`{"trick":3,"played":{"card":"TS"},"better":{"card":"AS"},"points":18,"us":11,
"them":-7,"nat":[31,18],"natThem":[0,0],"why":"…","text":"…"}`. `trick` and
`played` are always there; a decision that lost points has `better`, one
that gained them `alt`, both with `points`, `us`, `them`, `nat`, `natThem`,
`why` and `text` as in a moment; a decision that did neither has only
`trick` and `played`. Every field but those two is left out when zero or
empty (a missing `us` or `them` is 0). `seed` is the match's seed ([Options](#options)).

#### HandResult

`HandResult` JSON: `{"players":4,"playingTeam":0,"trumpBy":2,"trump":"H","dealer":1,
"points":[104,58],"roem":[20,0],"score":[124,58],"nat":false,"pit":false,"pitTeam":-1,
"bid":0,"discards":[],"gains":[124,58]}`; `points`, `roem` and `score` are per
side ([Rules as implemented](#rules-as-implemented)), `gains` per scorer, `discards` the soloist's two cards with three
players.

#### Further

Every key above is always present, except `legal` and `rule` (only on your
turn in phase `play`). Further:

- `turned`: the turned suit in gedraaid from the deal on (the `turned` event
  opens the bidding), else null.
- `trick`: null outside a hand (`auction` to `play`); a complete trick stays until
  `collect`, then it is the empty next trick led by the winner (`turn` = winner).
  Tricks carry `points` and `roem` too (0 and `[]` while in progress).
- `lastTrick`: the latest completed trick of this hand (null after a new deal;
  kept through `handEnd` and `gameOver`).
- `hand` is `[]` and `turn` -1 outside a hand; during `handEnd`/`gameOver`,
  `dealer`, `voorhand`, `trump`, `trumpBy`, `playingTeam`, `tricksWon`,
  `handPoints` and `handRoem` still describe the finished hand.
- With two players `players[i].cards` counts the face-down cards too;
  `hand` is then the face-up ones.
- With three players `playingTeam` is 0 (the soloist's side) once trump is
  known; `tricksWon`, `handPoints` and `handRoem` are per side.
- `hint` and `hands4` are null unless they apply; `hint.text` is always set.

## Seinen (signals)

Used by normaal and sterk bots and explained in the manual.
The manual's section is titled *Seinen*; its text and the glossary also give
the other name, *voorkaarten*.

Which signals hold is agreed per table (option `signals`, [Options](#options)): met de
aas seinen, op- en afseinen and kleintje boer are on by default, boer over
boer is off. The manual, the options, the lessons and the chat at the
start of a match name them in this order: met de aas seinen, op- en
afseinen, kleintje boer, boer over boer. The server puts the table's
agreements in every view (`game.View.Signals`; a view without them means
the defaults), and the bots, the hints, the search's playouts and the
Spelanalyse give, read and explain only the signals agreed. Tegenkleur is
described in the manual, which says plainly that it is not used here: no
option, and the bots and the hints do nothing with it.

- **Met de aas seinen** (`aas`): on the **partner's trick**, discarding the ace
  of a side suit that nobody has led yet says "ik heb ook de 10 van deze
  kleur". The ace's 11 points go to the partner's trick, and after the ace
  that 10 is the highest card of the suit, so it can still win a trick: the
  partner leads the suit to it. An ace given without the 10 breaks the
  promise. Leading an ace says nothing: with the ace and the 10 one leads
  the 10 first ([Strength levels](#strength-levels), normaal). Bots read it while the 10 is out, in the first
  six tricks, and lead the suit with a low card; they give the ace with its
  10 rather than keep it, and avoid an ace without it (sterk only for ≥ 20
  points).
- **Op- en afseinen** (`hoogLaag`): on the **partner's trick** (the
  partner holds it when the card is played), discarding a small card (7, 8
  or 9: cards without points) says "speel deze kleur, daar heb ik de
  hoogste van" (**opseinen**); discarding a middle card (10, boer, vrouw or
  heer) says the opposite, "de hoogste van deze kleur heb ik niet"
  (**afseinen**). Bots give and read opseinen in the first six tricks (the
  discarder holds the highest card of that suit still out; sterk fakes it
  only for ≥ 20 points), not afseinen; a hint names afseinen for a discard
  that tells the truth and leaves at most one other card of the suit in
  hand (that card is not the highest still out). A discard into a trick
  the opponents hold says nothing: there the cheapest card goes.
- **Kleintje boer** (`kleintjeBoer`): leading a small card (7, 8, 9) of a side suit signals "ik heb de
  troefboer"; partner wins and returns trump. It is given by the trump maker
  on its first lead (in utrechts the opening lead of the hand; bots as maker
  give it only then, with the boer and at most one other trump, no nel), or by
  the maker's partner on its first lead, while the boer is still out. Bots of
  the playing team do not lead such a card without the boer when they have
  another sensible lead, so they read it as a promise.
- **Boer over boer** (`boerOverBoer`, off by default): leading a side-suit
  boer while holding the trump boer, on the same first lead as kleintje
  boer. When agreed, bots read it like kleintje boer, avoid it without the
  boer, and hints name it (and warn when a side-boer lead could be read as
  one). Not agreed, a side boer says nothing.
- **Tegenkleur seinen** (not used here: no option, bots and hints ignore
  it): discarding a suit to ask for the suit of the other colour of the
  same shade (harten ↔ ruiten, klaveren ↔ schoppen).
- **Spekken (ook wel smeren)**: give points (10, aas) to a trick your partner
  is sure to win (*je maat spekken*).
- **Maat heeft de slag** (Amsterdams): no need to trump; give points
  (spekken) instead.

## The site

`games/klaverjas/web`, on the shell of [docs/frontend.md](../../docs/frontend.md).

### Page load

17 requests: html, 3 css (app.css, klaverjas.css, cards.css, in that
order), favicon, manifest, one PNG icon, the shell's 6 modules, the game's
3 (game, table, rules), the websocket. The modules in `js/`:

- `game.js`, the game module
  ([docs/frontend.md, "The game module"](../../docs/frontend.md#the-game-module));
- `table.js`, the table and its overlays;
- `rules.js`, klaverjas's helpers without the DOM ([rules.js](#rulesjs));
- `manual.js`, the handleiding ([manual.js](#manualjs)), imported when
  the manual is first opened;
- `expert.js`, the sheet *Redenering van de AI*, imported when it is
  first opened (expert mode, training).

When `manual.js` or `expert.js` cannot be loaded, a toast says "Laden
lukte niet" and nothing opens.

`css/klaverjas.css` holds the table, the overlays of the game, the lessons
and, as its last section, the manual's styles (classes `man-…`). It comes
after the shell's `app.css` and before `cards.css`, so a card's state there
(`.card.selected`, `.card.disabled`) keeps winning its ties with
`.hand > .card` and `.pile > .card`
([docs/frontend.md, "Stylesheets"](../../docs/frontend.md#stylesheets)).

### rules.js

```js
// games/klaverjas/web/js/rules.js — klaverjas's helpers without the DOM (it imports util.js and cards.js); s is the state
POS, posOf(s, seat)                     // the places 'bottom' (you), 'left', 'top', 'right' at a table of 2, 3 or 4
sideOf(s, seat), mySide(s)              // the side in this hand: the team (4), the seat (2), the soloist 0 and the others 1 (3);
                                        //   -1 in the auction
isWij(s, seat), teamCls(s, seat), teamName(s, side)  // ours or not; 'wij' or 'zij'; "Wij", "Zij", "Jij" or a name
scorerOf(s, seat), myScorer(s), scorerName(s, k), scorerOrder(s)  // the scores of a match: per team with four, else per player
ROEM_NAMES, roemTotal(roem), roemText(roem)  // roem by name, in points, in words ("driekaart (20), stuk (20)")
variantText(opts)                       // "Utrechts/Amsterdams", "Met z'n drieën, Rotterdams"
handHeadline(r, w, s)                   // the hand summary's headline from the viewer's side: {t, sub, cls}
reviewVerdict, luckText, pointsText, momentWhere, strongLine, missedLine, fineLine, handSum, outcomeLine,
  timeText, reviewHistory               // the lines of the Spelanalyse (below)
MANUAL_SECTIONS                         // manual.js's SECTIONS, for before manual.js is loaded
```

Node tests: `test/ui/klaverjas.test.mjs`, which loads the shell's modules
as the site does (`siteImports` in `test/ui/site.mjs`).

### manual.js

```js
// games/klaverjas/web/js/manual.js — the in-game handleiding (Dutch content + renderer)
export const SECTIONS = [ {id:'bediening',title:'Bediening'}, {id:'regels',title:'Spelregels'},
  {id:'twee-drie',title:'Met 2 of 3'}, {id:'punten',title:'Kaartwaarden'}, {id:'roem',title:'Roem'},
  {id:'seinen',title:'Seinen'}, {id:'tips',title:'Tips'}, {id:'jannie',title:'Juf Jannie'},
  {id:'woorden',title:'Woordenlijst'} ];
export function renderManual(sectionId, opts = {}) // → HTMLElement with that section's content (uses cards.js for illustrations);
                                                  // opts.icon(name) (util.icon) puts the buttons' pictograms in the Bediening chips
// Styles for the manual content are the last section of css/klaverjas.css (classes prefixed man-).
```

`table.js` imports it when the manual is first opened (`openManual`). A
lesson step's link takes its section's title from `MANUAL_SECTIONS` in
rules.js, as manual.js may not be loaded yet; `test/ui/klaverjas.test.mjs`
keeps the two lists the same.

### Home

On the home screen of [docs/frontend.md, "Home"](../../docs/frontend.md#home),
klaverjas has the tile *Oefenen* (training) and the help *Handleiding en
spelregels*, which opens the manual ([manual.js](#manualjs)). In the
*Nieuw spel* sheet *Troef* hides with three players, *Regels* with two, and
*Seinen* (four toggles, two per line: *Met de aas seinen*, *Op- en
afseinen*, *Kleintje boer*, *Boer over boer*) with three or two. Five quick
taps on the version open the expert mode's sheet, *Expert*
([Expert mode](#expert-mode)).

The expert sheet has, in this order, a line
on what the mode does
("Speel een spel opnieuw met de seed, of één potje ervan, op een plaats
naar keuze, tegen drie AI-spelers. Op je beurt tik je bovenin op de
robot voor de redenering van de AI, en geef je commentaar. Na elk
potje tik je op een slag en dan op Dit potje terugkijken."), *Open
kaarten*, *Potjes*, *Troef*, *Regels*, *AI-sterkte*, *Tempo*, *Seinen*,
*Seed*, *Potje* (`from`, 1–24, empty: *Hele spel*; with a number the
*Potjes* row hides) and *Plaats* (*1* to *4*: the seat, 0–3; ⓘ: where
you sit; in a normal game plaats 1 is the creator's seat, plaats 2 sits
to the left of 1, plaats 3 opposite and plaats 4 to the right; with the
same seed every plaats gets the cards and the dealer it gets in that
game; the game log calls plaats 1 seat 0 and plaats 4 seat 3), all kept
on the device in `kj.expert`, the seed included, and *Start expertspel*
(`create` with `expert`, `start` and `seat`, the latter beside `opts`,
not in them; without asking for a name). The sheet *Oefenen met Juf
Jannie* (`openTraining`): her avatar with "Je speelt samen met Juf
Jannie tegen twee AI-spelers. Kies een les.", then four rows, one selected
(a radio group, at least 44 px high, `train-lesson-<x>`), each with a line
of text: *Basisspel* ("Kaarten, troef, bekennen en punten"), *Roem en
tellen* ("Extra punten herkennen en troeven tellen"), *Seinen* ("Je maat
iets vertellen met je kaart") and *Vrij spelen* ("Een heel spel met een
tip bij elke beurt"). Then the fold *Spelopties* (`details.train-opts`,
styled as *Commentaar bij deze zet* in the reasoning sheet), shut unless *Tips* is off,
*Open kaarten* on or a seed set, so those are never hidden when
remembered. In it the switches *Tips* ("Een tip bij elke beurt en uitleg
na elke slag") and *Open kaarten* ("Zie de kaarten van alle spelers"), and
the rows *Potjes*, *Troef*, *Regels*, *AI-sterkte* (its ⓘ adds here "In
de les over seinen spelen ze minstens op Normaal."), *Tempo*, *Seinen* (its
ⓘ adds here "In Vrij spelen op AI-sterkte Makkelijk speelt niemand met
seinen.") and *Seed*. *Potjes* shows only for Vrij spelen, as a lesson has
its own length, and *Seinen* only for Seinen and Vrij spelen; they follow
the row selected at once. At the foot *Start les*, or *Start oefenspel* for
Vrij spelen: `create` with `training` and `start`, `lesson` "" for Vrij
spelen, without asking for a name. Every choice stays on the device in
`kj.train`, the seed included, read value by value: what is corrupt or stale
gets its default. The defaults: *Basisspel*, or *Vrij spelen* when there is
no readable `kj.train` and `kj.lessons`, the old switch *Speluitleg*, is
off; tempo rustig, 8 hands, tips on, open cards off, no seed, and for the
rest those of Nieuw spel.

### Lobby

The mini table shows the seats with four the teams visible; with three
bottom, left and right, raised a little; with two opposite.

### Table

You at the bottom with your hand as a fan; partner on top, opponents
left/right with card backs and names; dealer chip; turn glow; trump indicator;
score bar *Wij – Zij* with names (with three or two players one part per
player: *Jij* and the others' faces, emoji or initial as on their seats);
potje n/16; buttons for chat (with unread
badge), score sheet, last trick, help, settings, sound (a toggle:
`aria-pressed` while the sound is on, tooltip "Geluid aan" / "Geluid uit",
icon to match; on phones it is in the ⋯ menu); in an expert game and in training, first
of them, a robot for the reasoning of the AI ([Expert](#expert)). The trump badge's details show
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
only legal card plays on the first tap. A tap beside the hand (the felt, a
seat, the trick; not a button) puts a lifted card down again, as does
lifting another card. Illegal cards are dimmed; tapping one
shows `ExplainIllegal`-style text (the client may derive it from `rule`); a
tap during a pause (`turn` -1) says to wait. Keyboard: ←/→ select, Enter
plays; the trump/bid panel, the takeover question and the hand summary
focus their main button on fine pointers, and dialogs keep Tab inside.
Trump choice: four big suit buttons (forced: turned suit disabled).
Bidding: *Spelen* / *Passen*.

### Table of three

The others sit left and right, raised towards the top
(their speech bubbles open downwards); the trick is a triangle. During the
auction the talon lies closed in the middle, every seat shows its bid
("bod 90", "pas") under its name, and on our turn a panel shows the
highest bid, a bid to offer with − and + (from the lowest allowed, steps
of 10, at most 300), *Bied 90* and *Passen*. The contract banner shows the
bid; the soloist's seat says "alleen voor 100" for the rest of the hand.
Playing alone, the talon's two cards come into the hand with a gold edge;
tapping two cards chooses them (lifted), *Wegleggen* sends them, then the
trump panel ("Jij speelt alleen en moet minstens 100 punten halen, roem
telt mee.").

### Table of two

Our eight piles take the hand's place, two rows of four,
the front row nearest us, each pile showing the closed card under its top
card; the opponent's piles mirror ours in the top seat, beside its name.
Face-up cards of ours play like hand cards (tap or click, keyboard). After
the trump choice the back rows turn over and each side's open-card roem
bursts with whose it is. A freed card shows face up once its trick is
complete.

### Connection

When the connection opens again ([docs/frontend.md, "Connection"](../../docs/frontend.md#connection)),
the expert's question is asked again (at once when the sheet is open), and
a hand asked with `handReview` is asked again while its trick view is open.

### Game over

Final score with the team names (with three or two players one score per
player, the top one marked); the host's *Spelers of regels wijzigen* is
missing in training and the expert mode; everyone also gets *Scorebord*.

### Feedback

Card fly-in animations, winner highlight, trick collection
toward the winner, roem burst, trump banner, speech bubbles for bids and bot
chat, nat/pit splash, animated score count-up, confetti on winning; short
waits so every move can be followed; `prefers-reduced-motion` shortens all.

### Score sheet

Per hand: trump suit, who played (marker; with three
players the bid too), points+roem per team (with three or two players a
column per player, the gains; roem under the soloist only, as the other
two share theirs), nat (red) / pit (gold), running totals ("stand" under
each hand).
Team names keep "(AI)", one name per line.

### Review

*Laatste slag* shows the previous trick at the seats with winner,
points and roem; the hand summary (and the score sheet for the previous hand,
which stays open while updates arrive) shows all 8 tricks of the finished
hand in play order, each card underlined in its team's colour; tapping a
trick shows it at the seats like *Laatste slag*. The summary's headline
speaks from the viewer's team (`handHeadline` in rules.js): we played and
made it *Gehaald!*, went nat *Nat!*; they made it *Zij halen het*, went nat
*Zij gaan nat!*; our pit *Pit!* (gold, also when they went nat), theirs
*Zij halen pit*; good news for us in our colour, bad news in red. With two
players the sides are *Jij* and the other's name ("Opa Dirk (AI) haalt
het"); with three the headline names the soloist, the bid and what it made
("Kees speelde alleen voor 100 en haalde 110. Jullie delen de rest."), the
table has a column per player (faces as in the score bar; points and roem
of the two who played together, marked "samen"; then each one's gains and
stand) and a line shows the discards and their points. The
whole summary fits without scrolling: on phones (< 600 px wide) the tricks
are a 4 × 2 grid of small tiles (number and points over the cards; 5 × 2
with three players, 8 × 2 with two), in short landscape they sit beside
the score; the ready chips show only with another person at the table
(who left no longer counts), and alone at the table there is no
countdown ring either (`nextAt` 0).

The review per hand starts from a trick: at a table of four
the trick view (from the summary's tiles, or the score sheet's last
potje) has under the cross and its line *Dit potje terugkijken*
(history icon) while that hand is finished: in `handEnd` the hand of
`handNo`, during the next hand and at game over the score sheet's last
row (`prevHand`'s hand). *Laatste slag* has the same button in `handEnd`
and `gameOver`, for the hand just played. A tap sends `handReview` with
that hand (the hand of the tricks shown) and shows *Laden…* on the
button, disabled, until the answer (an error gives the button back; a
reconnect asks again, [Connection](#connection)); the answer opens
the replay of that hand (owner 'hand', [Terugkijken](#terugkijken)) just before the
player's card in the tapped trick (*Laatste slag*: trick 8). In short landscape the trick view
puts the cross beside its line and the button, so the button is in view
without scrolling (640 × 360, 844 × 390). The summary itself gets no
button: it must fit without scrolling. Tables of three or two have none
either, like the Spelanalyse: the engine analyses four players, and the
replay is built for four seats.

### Training

The robot in the top bar opens *Redenering van de AI*, as in
the expert mode ([Expert](#expert)), with option `tips` on or off; with it on, a
tip bubble with the hint text and a glow on the advised card;
for the trump or bid choice the hint is inside the panel (in short landscape
the bubble sits beside it) and the advised suit or *Spelen*/*Passen*
glows; ✕ closes a hint until the next one; tips after
each trick (`tip`), shown until you play your next card; while the last
trick of a hand waits for its tip (`nextAt` in phase `play`) the bubble
has *Verder* with a countdown ring, and *Verder*, ✕ or Enter sends
`tipRead`. Optional open cards; Juf Jannie as partner; the hand summary has
no countdown ring (`nextAt` 0) and waits for *Volgend potje*. In short
landscape the bubble sits in the top-left corner and never covers the left
seat (who plays after you): a long text shows the lines that fit and *Lees
verder* (then *Minder*); the tip of a hand's last trick shows in full, as
nobody plays after it. Every tip is also a line of Juf Jannie in the chat
(`coach`: tinted, no sound, no speech bubble at her seat).

### Lessons on screen

Chosen in the Oefenen sheet ([Home](#home)). The step on screen (`lesson`) is in the coach
bubble, 👩‍🏫 without a label, with *Verder* without a ring; *Verder*, ✕,
Enter or Space, or a tap anywhere on the table that is no button (also on
a card while the game waits for the step) sends `tipRead` with its `n`,
once per step and not in its first 450 ms (the second tap of a double tap,
or a tap meant for the card that completed the trick, would skip it). A
tap beside the hand with a card lifted puts the card down first. On the
learner's turn the step comes before the hint: the advised card glows once
it is read. The part of the screen a step is about lights up (`.spot`, a
pulsing gold outline, steady with reduced motion): `partner` Juf Jannie's
seat, `hand` the cards in the hand (their hint glow), `card` one card in
the hand (the same glow; the hint's glow waits), `trick` a box round
the trick, `trump` the trump badge, `score` the score pill, `rule` the
rule above the hand, `chat` the chat button, or on wide screens the chat
beside the table. A step with `manual` has a link under its text,
*Handleiding: Kaartwaarden* (the book icon and the section's title), that opens the manual
at that section; it is a button, so tapping it reads nothing. In the
counting hand the trump badge has the number `trumpsLeft` on its corner
(also in its title: "De anderen hebben nog 3 troeven."). Input handlers
read the step on screen (`app.view`): the
trick animation shows a trick's explanation before it becomes `app.s`.

### Spelanalyse

Four players only; the same for everyone, the expert included. Under the final score, a line for the
player alone: *Jouw spel volgens Juf Jannie: 87% (goed
gespeeld) ›* (*Jouw spelanalyse wordt berekend…*, disabled, while grades
are out; hidden without a review). Juf Jannie stands for the engine of the
hints, so the numbers read as hers, not as a fact. The verdict is
*sterk gespeeld* from 95%, *goed gespeeld* from 82%, else *kan beter*
(`reviewVerdict`; the bounds fit the bots' averages in `TestGradeLevels`:
sterk ≈ 99, normaal ≈ 87, makkelijk ≈ 76). It opens *Jouw spelanalyse*:
*Volgens Juf Jannie* over the percentage with ⓘ (who Juf Jannie is, how she
plays every option out over deals of the unseen cards, what a point is:
the difference between the two teams' scores, so a point that goes to
the opponents counts twice and a higher chance of nat costs much, that it
stays an estimate, and how the percentage, *Laten liggen* and *Sterke
zet* follow), potjes and keuzes, then
*Jouw kaarten* (*Boven gemiddeld (+8)*, *Gemiddeld (+1)* within ±4,
*Onder gemiddeld (−6)*: points per potje, ⓘ), *Sterke zetten*, *Laten
liggen* (points in zetten), *Uitkomen* (*9 van 11 keer de beste kaart*),
*Troefkeuze* (*4 van 5 keer de beste keuze*), *Roem weggegeven* (ⓘ), and
in gedraaid when it happened *Gespeeld met meer dan 40% kans op nat: 2
keer, 1 keer nat*. Then *Snelheid* (`speed`): *Bedenktijd per zet* (the
median, ⓘ), *Langste bedenktijd 48 s (potje 4, slag 2)*, *De tafel
wachtte op jou 6 min 10 s*, and with other people at the table *Anderen
per zet* and *Jij wachtte op de anderen* (`timeText`: "0,8 s", "48 s",
"6 min 10 s"). Below, the listed moments: *Potje 3, slag 2 · ♠A: …*
and *Potje 5, slag 3 · ♠10 gespeeld, ♠A 18 punten beter: …* (*♥ als
troef, ♣ 14 punten beter: …*, *Gepast, spelen 12 punten beter: …*), each
with a line that splits the points (`outcomeLine`): *Jullie +11, zij −7;
kans dat jullie nat gaan 31% → 18%* (a chance that moves by less than 5
is left out), for a strong move *Tegenover ♠8: jullie +6, zij −6*. A tap
opens the replay (owner 'review', every hand of `replay`) at that moment;
*Potjes terugkijken* opens it at the first hand. A moment is disabled
when its hand is not in `replay` (looked up by number: with `from` the
only hand is not hand 1). The header line under the percentage ends
with the seed: *16 potjes · 118 keuzes · seed 482913*. Then
*Vorige partijen 79% · 83%* (the percentages of up to five earlier matches
on this device, `kj.reviews`, the last 20 kept) and the line *Disclaimer:
Dit is slechts de mening van Juf Jannie.*, and last *Opmerkingen*: a text
field (*Wat viel je op? Wat klopt er volgens jou niet?*) with *Versturen*
(`feedback`; on `saved` the text stays, its edge and a check with
*Bewaard.* in the team colour, and *Versturen* waits for a change; text
typed while it was being sent stays unsaved; one feedback is out at a
time) and the line *Je opmerking wordt met
je naam bewaard, net als de partij zelf: hooguit 12 maanden, voor
statistieken en om het spel te verbeteren.* Apart from the verdict, the wording is plain and factual:
numbers, cards and the hint's reasons, no praise or consolation. The game-over buttons stay in view with
the line: on a short phone it takes the place of the emoji (portrait up to
760 px high) and of *Laatste potje* (up to 680 px); in short landscape the
sub-line goes and the title and score shrink.

### Terugkijken

The replay (`openReplay`): a finished hand card by card
with all four hands open, the same for everyone. It has an owner: 'hand'
(one finished hand, from a `handReview` answer, [Review](#review)) or 'review'
(game over, every hand of `review.replay`, from the Spelanalyse). On top
*Potje 4 van 16* with ‹ › for the other hands and "♥ troef · Kees
speelt", and under it one line for the hand (`.rp-sum`, in the head):
*Volgens Juf Jannie: 7 keuzes · 1 sterke zet · 18 punten laten liggen in
1 zet* (the hand's `choices`; a part that is 0 left out, no line without
choices and nothing pending), ending in *· nog 2 keuzes in berekening*
(*· nog 1 keuze …*) while the hand's `pending` is above 0 (owner
'hand'), with an ⓘ on *Laten liggen* (differences under 5 points, or
within the uncertainty of the search, do not count) and *Sterke zet*.
The trick lies at the seats with every name, whose turn it is marked,
then "Kees is aan de beurt" or, with the trick complete, "Kees neemt de
slag · 21 punten · roem: …", and *Stand in dit potje: Wij 34 – Zij 12*
(card points and roem of the tricks taken), after the last card
*Uitslag: Wij 0 – Zij 182 · Wij nat*. Below the table, a box
(`.rp-moment`) with Juf Jannie's view of the player's own decisions: a choice belongs to the step
just before the player's card in its trick (`before`; a lead: with the
previous trick still on the table), a trump choice or bid to step 0,
before the first card. The box shows every choice of the step on screen
(step 0 may have a bid, a trump choice and the lead of trick 1), else the
latest one before it with *Naar deze keuze*, and nothing before the
player's first choice. A choice that lost points reads as in the
Spelanalyse (*Potje 5, slag 3*, *♠10 gespeeld, ♠A 18 punten beter: …*,
its split), so does a strong move; one that did neither reads *♠8
gespeeld: geen duidelijk betere keuze volgens Juf Jannie* (*♥ als troef:
…*, *Gepast: …*, *Gespeeld: …*; `fineLine`), without a split. Below,
the hands left, the player's first: at a card choice of the step on
screen that lost or gained points, the card played and the better (or
obvious) one are marked in it, with a key. A bar under the scrolling body keeps ‹ *Slag 4 · 2 van 4
kaarten* › (also ←/→) and the eight tricks in view: each in its taker's
colour, with a small dot for the player's graded card in it (light: points
left, gold: a strong move, also said in its title; a trump choice or bid
only shows at step 0), and a tap shows it complete. It opens at the
step of a moment, or just before the player's card in the tapped trick;
*Potjes terugkijken* at the deal of the first hand. In short landscape
the table sits beside the box and the hands, the hand's line stays in
the head, and the bar is one line. The 'review' replay follows
`review.replay` at game over and closes outside it. The 'hand' replay
stays open as the phase moves on (its hand is finished; a
`handReview` for the hand on screen refreshes it, at the same step) and
closes in the lobby and when a new match starts (a `deal` with no score
rows yet). While it is open and the player is to play at the table, a
line on top says *Aan tafel ben je aan de beurt.* with *Naar tafel*,
which closes it and then the views that led to it (the trick view,
*Laatste slag*, the score sheet). The replay has no feedback per decision: the review's
*Opmerkingen* is about the game as a whole (the expert, and a player in
training, comment on their decisions while playing, [Expert](#expert)).

### Expert

The sheet of the [Expert mode](#expert-mode) (`expert.js`, loaded when first needed): the
top bar's robot (*Redenering van de AI*, "Redenering van de AI bij
jouw zetten, en commentaar"; only in an expert game and in training)
opens the sheet
*Redenering van de AI* about the player's own decisions in the hand in
play, or just played (`handNo`). Those come from the state, so a reload
keeps them: trick 0 when the player bid or chose trump before the first
card (`bids`, `trumpBy`), tricks 1 to k for the cards they played (k = 8
− the cards in `hand` during play, 8 at `handEnd` and `gameOver`), and on
their turn in a playing phase the decision awaited now (trick 0 for a bid
or trump choice, else k + 1; in training with option `tips` on only with
a `hint` in the state, which every such turn has unless the engine gave
none; with it off, as in the expert mode, always). It opens on the awaited one on their turn,
else on the latest; never on trick 8 (one card left, no choice: the one
before it instead, also when trick 8 is awaited). With none, a toast
"Nog geen zet van jou in dit potje.". In the head ‹ › step through them (disabled at the ends), with
the decision in bold: awaited, *Slag 3 · Jij bent aan de beurt* or *Voor
de eerste kaart · Jij bent aan de beurt*; made, *Slag 3* or *Voor de
eerste kaart* until the answer names the choice (*Slag 3 · Jij speelde
♠8*, *Jij: ♥ als troef*, *Jij: passen*, *Jij: spelen*; its `played`).
The reasoning (`why`) of the decision shown is asked by itself, when
the sheet opens and after every step, unless already known; *De AI denkt
na…* while it is out. One request is out at a time (expert.js keeps it):
a step meanwhile shows *De AI denkt na…*, and the decision shown is asked
once the answer is in. An answer counts only when its hand and trick are
the request's. An error gives the request up, sheet open or not (main.js
passes every server error on, `panels.whyError`, once expert.js is
loaded), and its
decision shows *De AI gaf hier geen antwoord.* with *Opnieuw* (a step
back to it asks again too). A reconnect asks again when the request went
out over the old connection ([Connection](#connection)). Answers
are kept per decision for the life of the page
(`hand/trick/kind/nu|gedaan`, kind: card, bid or suit, so in gedraaid a
pass and the forced trump choice after it are apart), an awaited one
shown only while it is still awaited; a `deal` forgets them and the
request, so a rematch on the same seed never shows an old answer. An
answer shows *Normaal:* the normaal choice with its rule's reason,
*Sterk:* sterk's choice and, when that is not a card the search values
most, why (`sterkWhy`: a false signal sterk does not give for less than
its gain, *♦9 is volgens de berekening 14,2 punten beter dan ♣10, maar
je maat zou ♦9 lezen als “speel ruiten, daar heb ik de hoogste van”
(opseinen), en die heb je niet. Een vals sein speelt Sterk pas als het
minstens 20 punten meer oplevert.*, or the normaal card kept: within a
point, as kleintje boer or boer over boer, as a card that wins and loses
alike, or valued above the best honest card that took a false signal's
place; a difference is written rounded down and a tolerance rounded up,
so a text never contradicts its threshold), *Tip:*
the hint, with `hintWhy` when it keeps the normaal card while sterk plays
another (*Sterk is volgens de berekening 3,0 punten beter dan de kaart
van Normaal, minder dan 5 punten: dan blijft de tip bij die kaart.*), a
table of
every option (*Waarde*, *±*, for a card *Punten slag*, *Punten later*,
*Roem slag*, *Roem later*, *Nat*, *Pit*, and *Nat wij*, *Nat zij*; the
option played marked *gespeeld* or *gekozen*, the best value in gold; on
a phone the table scrolls sideways) and *Over 400 verdelingen van de
kaarten die jij niet kon zien.* (`worlds`) with an ⓘ on what the numbers
mean. With a card's `why`, every card's row is a touch target (44 px
high, its card a button): tapped, it is framed and the line under the
table says why the best brings more (its `why`; the best itself *♣8 heeft
de hoogste waarde.*). The card played starts picked, else normaal's
card, when it has a `why`; else the line says *Tik op een kaart in de
tabel: …*. The pick stays with the answer. Last
a fold-out *Commentaar bij deze zet*: one feedback form for the sheet
(*Wat klopt er volgens jou niet, of wat is beter?*, with the line *Je
opmerking wordt met je naam bewaard, …* under it), sent with the hand
and trick of the decision shown when sending. Each decision keeps its
own text while the hand lasts (a step shows the text of the decision
stepped to): typed, or saved and marked so (*Bewaard.*, as in every
feedback form). Whether the fold-out is open stays for the life of the
page. The sheet closes on a
`deal` and when the phase becomes `handEnd` or `gameOver` (the summary or
the game-over screen comes up; the robot opens the sheet again over
it); otherwise it stays as it is while play goes on. Values read as
numbers, plainly. The expert looks back at a hand as anyone does
([Review](#review), [Terugkijken](#terugkijken)): there is no replay of their own, and no choice of
their own for another card.

### Look

Green felt table with vignette, wooden rim, gold accents, team colours
(Wij teal/blue, Zij coral/red), dark UI chrome; four-colour deck option.
