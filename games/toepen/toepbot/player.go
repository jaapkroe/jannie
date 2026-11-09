// Package toepbot plays toepen (package toepen) at three strengths. Every
// level plays its cards by the same rules of thumb (normalCard); sterk
// plays out every legal card in sampled deals of the hidden cards, and
// decides on toepen, going along and the was by its chance to take the
// last trick, weighed against the points at stake and the risk of going
// out.
package toepbot

import (
	"math"
	"math/rand/v2"
	"slices"

	"jannie/games/toepen/toepen"
	"jannie/platform/cards"
)

// Level is a playing strength.
type Level int

const (
	Makkelijk Level = iota
	Normaal
	Sterk
)

func (l Level) String() string {
	switch l {
	case Makkelijk:
		return "makkelijk"
	case Sterk:
		return "sterk"
	}
	return "normaal"
}

// ParseLevel reads "makkelijk", "normaal" or "sterk"; anything else is
// normaal.
func ParseLevel(s string) Level {
	switch s {
	case "makkelijk":
		return Makkelijk
	case "sterk":
		return Sterk
	}
	return Normaal
}

// Player makes the decisions of one seat. Aggression (0..1) is the
// persona's boldness: it toeps on less, goes along more and bluffs a was
// more often.
type Player struct {
	lvl  Level
	aggr float64
	rng  *rand.Rand
}

// New returns a player; seed makes its choices repeatable.
func New(aggression float64, lvl Level, seed uint64) *Player {
	return &Player{lvl: lvl, aggr: min(max(aggression, 0), 1), rng: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))}
}

// worlds is the number of sampled deals per estimate.
func (p *Player) worlds() int {
	switch p.lvl {
	case Makkelijk:
		return 12
	case Sterk:
		return 240
	}
	return 48
}

// ---- cards ----

// Play chooses a card of v.Legal.
func (p *Player) Play(v toepen.View) cards.Card {
	legal := v.Legal
	if len(legal) == 0 {
		legal = toepen.Legal(v.Hand, v.Current)
	}
	if len(legal) == 1 {
		return legal[0]
	}
	switch p.lvl {
	case Makkelijk:
		if p.rng.Float64() < 0.35 {
			return legal[p.rng.IntN(len(legal))]
		}
	case Sterk:
		return p.search(&v, legal)
	}
	return normalCard(v.Hand, v.Current, v.In)
}

// search plays every legal card out in the same sampled deals and keeps
// the one that takes the last trick most often; a tie goes to the rule's
// card.
func (p *Player) search(v *toepen.View, legal []cards.Card) cards.Card {
	rule := normalCard(v.Hand, v.Current, v.In)
	s := newSampler(v)
	wins := make([]float64, len(legal))
	n := p.worlds()
	for range n {
		w := s.draw(p.rng)
		weight := p.weight(v, &w)
		for k, c := range legal {
			if playout(v, &w, c) == v.Seat {
				wins[k] += weight
			}
		}
	}
	best := -1
	for k, c := range legal {
		switch {
		case best < 0, wins[k] > wins[best]+1e-9:
			best = k
		case math.Abs(wins[k]-wins[best]) <= 1e-9 && c == rule:
			best = k
		}
	}
	return legal[best]
}

// weight is how likely a sampled world is given the toeps made: a seat
// that toept is thought to hold a strong hand, unless it bluffs, as often
// as the table saw it bluff (normaal and sterk; makkelijk takes every toep
// for what it is not).
func (p *Player) weight(v *toepen.View, w *world) float64 {
	if p.lvl == Makkelijk {
		return 1
	}
	x := 1.0
	for _, t := range v.Toeps {
		if t.Seat != v.Seat && v.In(t.Seat) {
			b := toepBluffRate(v, t.Seat)
			x *= b + (1-b)*(0.35+toepStrength(w[t.Seat]))
		}
	}
	return x
}

// The prior of the bluff rates: one bluff in eight, as if seen in eight.
const priorBluffs, priorSeen = 1.0, 8.0

// toepBluffRate is how often seat o bluffs a toep, as far as the table saw
// (its toeps whose cards came on the table), with the prior.
func toepBluffRate(v *toepen.View, o cards.Seat) float64 {
	r := v.Record[o]
	return (float64(r.ToepBluffs) + priorBluffs) / (float64(r.Toeps) + priorSeen)
}

// claimBluffRate is how often seat o bluffs a vuile was, as far as the
// table saw (its claims checked, this round's too), with the prior.
func claimBluffRate(v *toepen.View, o cards.Seat) float64 {
	r := v.Record[o]
	bluffs, seen := float64(r.ClaimBluffs), float64(r.Claims)
	for _, c := range v.Checks {
		if c.Claimant == o && c.Checker != cards.NoSeat && !c.Shown {
			seen++
			if !c.Genuine() {
				bluffs++
			}
		}
	}
	return (bluffs + priorBluffs) / (seen + priorSeen)
}

// winChance is the share of sampled deals in which v.Seat takes the last
// trick, everyone playing on by the rules of thumb (from v.Seat's best
// card, for sterk on its own turn).
func (p *Player) winChance(v *toepen.View) float64 {
	if !v.In(v.Seat) {
		return 0
	}
	if v.InCount() == 1 {
		return 1
	}
	s := newSampler(v)
	n := p.worlds()
	total, won := 0.0, 0.0
	legal := toepen.Legal(v.Hand, v.Current)
	mine := v.Turn == v.Seat && v.Phase == toepen.PhasePlay && p.lvl == Sterk && len(legal) > 1
	for range n {
		w := s.draw(p.rng)
		weight := p.weight(v, &w)
		total += weight
		if !mine {
			if playout(v, &w, noCard) == v.Seat {
				won += weight
			}
			continue
		}
		for _, c := range legal {
			if playout(v, &w, c) == v.Seat {
				won += weight
				break
			}
		}
	}
	if total == 0 {
		return 0
	}
	return won / total
}

// ---- the koningsspel ----

// Discard lays v.Lay cards away in the koningsspel. Sterk tries every
// choice in the same sampled deals (the others holding eight of the cards
// it does not) and keeps the eight that take the last trick most often;
// the others lay away their weakest cards, makkelijk now and then any.
func (p *Player) Discard(v toepen.View) []cards.Card {
	n := v.Lay
	if n <= 0 || n >= len(v.Hand) {
		return nil
	}
	switch {
	case p.lvl == Makkelijk && p.rng.Float64() < 0.3:
		hand := slices.Clone(v.Hand)
		p.rng.Shuffle(len(hand), func(i, j int) { hand[i], hand[j] = hand[j], hand[i] })
		return hand[:n]
	case p.lvl == Sterk:
		return p.bestDiscard(&v, n)
	}
	return weakestN(v.Hand, n)
}

// weakestN is the n weakest cards of hand.
func weakestN(hand []cards.Card, n int) []cards.Card {
	h := slices.Clone(hand)
	slices.SortStableFunc(h, func(a, b cards.Card) int { return toepen.Strength(a.Rank) - toepen.Strength(b.Rank) })
	return h[:n]
}

func (p *Player) bestDiscard(v *toepen.View, n int) []cards.Card {
	lays, wins := p.discardScores(v, n, 24)
	best := 0
	for k := range lays {
		if wins[k] > wins[best] {
			best = k
		}
	}
	return lays[best]
}

// discardScores plays every choice of n cards to lay away out in the same
// sampled deals (the others holding as many cards as v.Seat keeps) and
// counts the deals in which v.Seat takes the last trick.
func (p *Player) discardScores(v *toepen.View, n, worlds int) ([][]cards.Card, []int) {
	all := *v
	for o := range cards.Seat(v.Players) {
		if v.In(o) {
			all.Cards[o] = v.Size // everyone plays with eight
		}
	}
	s := newSampler(&all)
	ws := make([]world, worlds)
	for k := range ws {
		ws[k] = s.draw(p.rng)
	}
	lays := combinations(v.Hand, n)
	wins := make([]int, len(lays))
	for i, lay := range lays {
		kept := all
		kept.Hand = without(v.Hand, lay...)
		for k := range ws {
			if playout(&kept, &ws[k], noCard) == v.Seat {
				wins[i]++
			}
		}
	}
	return lays, wins
}

// combinations lists every choice of n cards of hand.
func combinations(hand []cards.Card, n int) [][]cards.Card {
	var out [][]cards.Card
	var pick func(from int, got []cards.Card)
	pick = func(from int, got []cards.Card) {
		if len(got) == n {
			out = append(out, slices.Clone(got))
			return
		}
		for k := from; k < len(hand); k++ {
			pick(k+1, append(got, hand[k]))
		}
	}
	pick(0, nil)
	return out
}

// ---- the stake ----

// cost is what taking n penalty points costs a player with points of
// limit: the points, and being out of the match outCost more.
func cost(points, n, limit int) float64 {
	if points+n >= limit {
		return float64(limit-points) + outCost
	}
	return float64(n)
}

// outCost is what going out of the match weighs on top of the points: a
// lot, so that no bot plays for a stake that ends its match lightly.
const outCost = 8

// lastTrick reports whether v is in the round's last trick.
func lastTrick(v *toepen.View) bool {
	size := v.Size
	if size == 0 {
		size = toepen.HandSize
	}
	return len(v.Tricks) == size-1
}

// lostForSure reports whether v.Seat can no longer take the last trick:
// its card on the table, or the one it holds, does not beat the card that
// wins it now, and later cards can only take it further away.
func lostForSure(v *toepen.View) bool {
	if !lastTrick(v) || len(v.Current.Cards) == 0 || !v.In(v.Seat) {
		return false
	}
	t := v.Current
	if !t.Played(v.Seat) {
		if len(v.Hand) != 1 {
			return false
		}
		t.Cards = append(slices.Clone(t.Cards), cards.Played{Seat: v.Seat, Card: v.Hand[0]})
	}
	w, ok := t.Winning(v.In)
	return ok && w != v.Seat
}

// knownWinner reports whether the card that wins the last trick now cannot
// be beaten by any card the table has not seen: its player knows it wins,
// and a toep will not make it pass.
func knownWinner(v *toepen.View) bool {
	w, ok := winningCard(v.Current, v.In)
	if !ok || !lastTrick(v) {
		return false
	}
	seen := map[cards.Card]bool{}
	for _, tr := range append(slices.Clone(v.Tricks), v.Current) {
		for _, p := range tr.Cards {
			seen[p.Card] = true
		}
	}
	for _, c := range v.Checks {
		for _, x := range c.Cards {
			seen[x] = true
		}
	}
	for s := range v.Players {
		if s != int(v.Seat) {
			for _, x := range v.Open[s] {
				seen[x] = true
			}
		}
	}
	for _, c := range cards.NewDeck() {
		if !seen[c] && toepen.Beats(c, w) {
			return false
		}
	}
	return true
}

// pointless reports whether raising the stake can only cost v.Seat more:
// it cannot take the last trick, and who will knows it.
func pointless(v *toepen.View) bool { return lostForSure(v) && knownWinner(v) }

// Toep decides, on v.Seat's turn to play, whether to toep first.
func (p *Player) Toep(v toepen.View) bool {
	if !v.CanToep || pointless(&v) {
		return false // a bluff nobody falls for only raises the bot's own loss
	}
	q := p.winChance(&v)
	bar := 0.62 - 0.12*p.aggr
	switch p.lvl {
	case Makkelijk:
		bar = 0.7 - 0.1*p.aggr
	case Sterk:
		// Toepen asks the others to pay the stake or play for more: with a
		// fair chance, more of them pass than it costs. Fewer players in,
		// a higher bar: one opponent left is a coin flip for more points.
		bar = 0.6 + 0.06*float64(3-min(v.InCount(), 3)) - 0.1*p.aggr
	}
	if q >= bar {
		return true
	}
	if p.lvl == Makkelijk {
		return q < 0.12 && v.Stake <= 2 && p.rng.Float64() < 0.04
	}
	// Balanced: a bot that toeps only on a good hand is read at once. So a
	// hopeless hand bluffs now and then at any stake (less above 2, and
	// seldom when being caught would put it out), and a hand just under the
	// bar toeps now and then too.
	bluff, semi := 0.04+0.1*p.aggr, 0.08+0.14*p.aggr
	if p.lvl == Sterk {
		bluff, semi = 0.025+0.07*p.aggr, 0.05+0.1*p.aggr // just enough to be unreadable
	}
	if v.Stake > 2 {
		bluff *= 0.6
	}
	if p.outIfLost(&v, v.Stake+1) {
		bluff *= 0.25
	}
	switch {
	case q < 0.15:
		return p.rng.Float64() < bluff
	case q >= bar-0.1:
		return p.rng.Float64() < semi
	}
	return false
}

// passCost is what passing costs v.Seat: the stake it last agreed to (in
// a view made by hand without it, the stake before the toep).
func passCost(v *toepen.View) int {
	if v.PassCost > 0 {
		return v.PassCost
	}
	return v.Stake - 1
}

// distrust scales the risk of going along by what the table saw of the
// toeper's bluffs: below 1 for one who bluffs more than one in eight,
// above for one who never did.
// Not when losing would put it out: a bluffer's toep still ends the match
// of whoever calls it and loses.
func (p *Player) distrust(v *toepen.View) float64 {
	if v.Toeper == cards.NoSeat || p.outIfLost(v, v.Stake) {
		return 1
	}
	b := toepBluffRate(v, v.Toeper)
	return min(max(1-1.2*(b-priorBluffs/priorSeen), 0.7), 1.15)
}

// outIfLost reports whether losing stake puts v.Seat out of the match.
func (p *Player) outIfLost(v *toepen.View, stake int) bool {
	return v.Points[v.Seat]+stake >= v.Rules.Limit
}

// Overtoep decides, asked about a toep, whether to toep again: only with
// a hand that should take the last trick, and the higher the stake, the
// surer (the toeper shows a good hand, and toeping back and forth soon
// costs more than the round is worth).
func (p *Player) Overtoep(v toepen.View) bool {
	if !v.CanRaise || v.Stake >= 5 {
		return false
	}
	q := p.winChance(&v)
	climb := 0.06 * float64(v.Stake-2)
	switch {
	case p.lvl == Makkelijk:
		return q >= 0.9 && p.rng.Float64() < 0.5
	case p.lvl == Sterk && q >= 0.68+climb+0.05*float64(3-min(v.InCount(), 3))-0.08*p.aggr:
		return true
	case p.lvl == Normaal && q >= 0.85+climb-0.05*p.aggr:
		return true
	}
	// Now and then a bluff back, while the stake is low and being caught
	// would not put it out: an overtoep is not always the nuts either.
	return q < 0.1 && v.Stake <= 3 && !p.outIfLost(&v, v.Stake+1) && !pointless(&v) && p.rng.Float64() < 0.02+0.04*p.aggr
}

// Answer decides whether to go along with a toep (true) or pass, taking
// the stake from before it. Under the anti-lijntoep rule it may have to go
// along.
func (p *Player) Answer(v toepen.View) bool {
	if v.InCount() <= 1 || v.MustStay {
		return true
	}
	me := v.Points[v.Seat]
	limit := v.Rules.Limit
	fold := cost(me, passCost(&v), limit)
	stay := cost(me, v.Stake, limit)
	if fold >= stay {
		return true // passing puts it out as surely as losing
	}
	if lostForSure(&v) {
		return false // the last trick is lost: passing costs less
	}
	q := p.winChance(&v)
	if p.lvl == Makkelijk {
		return q > 0.35-0.15*p.aggr || p.rng.Float64() < 0.15 && !p.outIfLost(&v, v.Stake)
	}
	// Going along costs the stake when the last trick is lost (and maybe
	// more after another toep, so a bit more than that); passing costs the
	// stake it agreed to. Against whoever the table saw bluff often, a bot
	// goes along more readily.
	risk := 1.2 - 0.25*p.aggr
	if p.lvl == Sterk {
		risk = 1.25 - 0.15*p.aggr
	}
	risk *= p.distrust(&v)
	return (1-q)*stay*risk < fold
}

// ---- the was ----

// Was decides whether to claim a was: always with a real one (a fresh
// hand beats four pictures), now and then as a bluff with a hopeless hand.
func (p *Player) Was(v toepen.View) bool {
	if !v.CanClaim {
		return false
	}
	if toepen.Was(v.Hand) != toepen.NoWas {
		return p.lvl != Makkelijk || p.rng.Float64() < 0.7
	}
	q := p.winChance(&v)
	if q > 0.12 {
		return false
	}
	rate := map[Level]float64{Makkelijk: 0.04, Normaal: 0.08, Sterk: 0.12}[p.lvl]
	return p.rng.Float64() < rate*(0.5+p.aggr)
}

// Check decides whether to check the claimed was of v.Claimant. The cards
// v.Seat can see make a real was more or less likely; a check of a real one
// costs a point, of a bluff it costs the claimant one, and the round.
func (p *Player) Check(v toepen.View) bool {
	if p.lvl == Makkelijk {
		return p.rng.Float64() < 0.15
	}
	g := wasChance(unseen(&v))
	bluff := claimBluffRate(&v, v.Claimant) // who bluffed before is checked sooner
	pb := bluff * (1 - g) / (bluff*(1-g) + g)
	bar := 0.5
	if cost(v.Points[v.Seat], 1, v.Rules.Limit) > 1 {
		bar = 0.85 // a wrong check would put it out
	}
	return pb > bar
}

// wasChance is the chance that four cards drawn from pool are a was.
func wasChance(pool []cards.Card) float64 {
	pics, sevens := 0, 0
	for _, c := range pool {
		switch {
		case toepen.Plaatje(c.Rank):
			pics++
		case c.Rank == cards.Seven:
			sevens++
		}
	}
	all := choose(len(pool), 4)
	if all == 0 {
		return 0
	}
	return (choose(pics, 4) + choose(pics, 3)*float64(sevens)) / all
}

func choose(n, k int) float64 {
	if k < 0 || n < k {
		return 0
	}
	r := 1.0
	for i := range k {
		r = r * float64(n-i) / float64(i+1)
	}
	return r
}
