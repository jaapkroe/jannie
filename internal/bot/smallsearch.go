package bot

import (
	"math"
	"math/rand/v2"
	"slices"

	"klaverjas/internal/game"
)

// Decisions at a table of two or three players: the player's methods hand
// a view with v.Players below 4 to these.

// talonSeat stands for the two cards of the talon (or the soloist's
// discards) among the holders of hidden cards: three players use seats
// 0..2 only.
const talonSeat game.Seat = 3

// smallSampler deals the cards a seat has not seen to their holders, as
// the four-player sampler does: uniformly, within what the play showed.
func smallSampler(holders [3]game.Seat, need [3]int, unk cardSet, excl *[4]cardSet) *sampler {
	sp := &sampler{seats: holders, need: need}
	sp.cards = unk.appendCards(make([]game.Card, 0, 24))
	sp.allow = make([]uint8, len(sp.cards))
	for ci, c := range sp.cards {
		for j, s := range holders {
			if need[j] > 0 && (excl == nil || !excl[s].has(c)) {
				sp.allow[ci] |= 1 << j
			}
		}
	}
	if !sp.feasible(sp.counts(), sp.need) {
		for ci := range sp.allow {
			sp.allow[ci] = 0
			for j := range holders {
				if need[j] > 0 {
					sp.allow[ci] |= 1 << j
				}
			}
		}
	}
	return sp
}

// smallWorld is a sampled deal of what v.Seat cannot see during play.
type smallWorld struct {
	hidden   [4][]game.Card // per seat: its hand (three players) or its face-down cards (two)
	discards []game.Card    // three players: the soloist's discards
}

// playSampler prepares sampling for a view in phase play: with three
// players the other two hands and, for the soloist's opponents, the
// discards; with two the face-down cards on both sides.
func playSampler(v *game.View, t *pubTable) (*sampler, cardSet) {
	hand := setOf(v.Hand)
	if v.Players == 2 {
		opp := openOf(v, 1-v.Seat)
		unk := t.unseen(hand, opp)
		var need [3]int
		for s := range 2 {
			for _, p := range v.Piles[s] {
				need[s] += p.N - b2i(p.N > 0 && p.Up)
			}
		}
		return smallSampler([3]game.Seat{0, 1, talonSeat}, need, unk, nil), unk
	}
	unk := t.unseen(hand, 0)
	if v.Seat == v.Bidder {
		unk &^= setOf(v.Discards)
	}
	var holders [3]game.Seat
	var need [3]int
	k := 0
	for s := range game.Seat(3) {
		if s == v.Seat {
			continue
		}
		holders[k] = s
		need[k] = t.size - countPlayed(v, s)
		k++
	}
	holders[2] = talonSeat
	if v.Seat != v.Bidder {
		need[2] = 2
	}
	return smallSampler(holders, need, unk, &t.excl), unk
}

// countPlayed is the number of cards seat has played in v.
func countPlayed(v *game.View, seat game.Seat) int {
	n := 0
	for _, tr := range v.Tricks {
		for _, p := range tr.Cards {
			n += b2i(p.Seat == seat)
		}
	}
	if len(v.Current.Cards) < v.Players {
		for _, p := range v.Current.Cards {
			n += b2i(p.Seat == seat)
		}
	}
	return n
}

// world draws one deal of the hidden cards for v.
func (sp *sampler) world(v *game.View, rng *rand.Rand) smallWorld {
	var h [4]cardSet
	sp.sample(rng, &h)
	var w smallWorld
	if v.Players == 2 {
		// Face-down cards go to their places in pile order, at random.
		for s := range 2 {
			cs := h[s].appendCards(make([]game.Card, 0, 16))
			rng.Shuffle(len(cs), func(i, j int) { cs[i], cs[j] = cs[j], cs[i] })
			w.hidden[s] = cs
		}
		return w
	}
	for s := range game.Seat(3) {
		if s == v.Seat {
			w.hidden[s] = slices.Clone(v.Hand)
		} else {
			w.hidden[s] = h[s].appendCards(make([]game.Card, 0, 12))
		}
	}
	if v.Seat == v.Bidder {
		w.discards = v.Discards
	} else {
		w.discards = h[talonSeat].appendCards(nil)
	}
	return w
}

// smallSim is a hand at a small table being played out by the rules of
// thumb for every seat.
type smallSim struct {
	d game.Deal
	t pubTable
}

func (s *smallSim) play(c game.Card) {
	seat := s.d.Turn()
	if err := s.d.Play(seat, c); err != nil {
		panic("bot: playout made an illegal move: " + err.Error())
	}
	s.t.apply(seat, c)
}

func (s *smallSim) run() {
	var buf [16]game.Card
	for s.d.Phase() == game.PhasePlay {
		seat := s.d.Turn()
		hand := setOf(s.d.AppendHand(buf[:0], seat))
		legal := setOf(s.d.AppendLegal(buf[:0]))
		var opp cardSet
		if s.t.n == 2 {
			opp = setOf(s.d.AppendHand(buf[:0], 1-seat))
		}
		s.play(s.t.choose(seat, hand, legal, opp))
	}
}

// value is the outcome for side: its score minus the other side's, with
// the persona's appetite for pit.
func (s *smallSim) value(side int, aggr float64) int {
	r := s.d.Result()
	v := r.Score[side] - r.Score[1-side]
	if r.Pit && r.PitTeam == side {
		v += int(pitAppetite * aggr)
	}
	return v
}

// smallWorlds multiplies the sampled deals per card decision at a small
// table: its playouts are short, so more of them fit in the time a
// four-player search takes.
const smallWorlds = 3

// smallSearchPlay evaluates every legal card of v by playing sampled deals
// out (as searchPlay does with four players); results in v.Legal order.
func smallSearchPlay(v *game.View, cfg searchConfig, seed uint64, aggr float64) []playResult {
	t := pubFromView(v)
	sp, _ := playSampler(v, &t)
	side := t.side(v.Seat)
	res := make([]playResult, len(v.Legal))
	for i, c := range v.Legal {
		res[i].card = c
	}
	var sums [chunks][16]int64
	var counts [chunks]int
	cfg.runChunks(func(ch int) {
		n := perChunk(smallWorlds*cfg.playWorlds, ch)
		rng := chunkRNG(seed, ch)
		for range n {
			w := sp.world(v, rng)
			vv := *v
			vv.Discards = w.discards
			base, err := game.Resume(vv, w.hidden)
			if err != nil {
				panic("bot: resume: " + err.Error())
			}
			for i, c := range v.Legal {
				s := smallSim{d: *base, t: t}
				s.play(c)
				s.run()
				sums[ch][i] += int64(s.value(side, aggr))
			}
			counts[ch]++
		}
	})
	for ch := range chunks {
		for i := range res {
			res[i].total += sums[ch][i]
			res[i].n += counts[ch]
		}
	}
	return res
}

// ---- the player at a small table ----

func (b *player) smallPlay(v game.View) (c game.Card) {
	legal := v.Legal
	if len(legal) == 0 {
		return game.Card{}
	}
	if len(legal) == 1 || !v.TrumpKnown {
		return legal[0]
	}
	t := pubFromView(&v)
	var opp cardSet
	if v.Players == 2 {
		opp = openOf(&v, 1-v.Seat)
	}
	rule := t.choose(v.Seat, setOf(v.Hand), setOf(legal), opp)
	switch b.level {
	case Makkelijk:
		if b.rng.Float64() < makkelijkMistakes {
			return legal[b.rng.IntN(len(legal))]
		}
		return rule
	case Normaal:
		return rule
	}
	seed := b.rng.Uint64()
	defer func() {
		if r := recover(); r != nil {
			fallbacks.Add(1)
			c = rule
		}
	}()
	res := smallSearchPlay(&v, b.cfg, seed, b.persona.Aggression)
	return res[bestResult(res, rule, v.Trump)].card
}

// smallTrump chooses trump: with two players voorhand (utrechts, or after
// both passed), with three the soloist after laying its discards away.
func (b *player) smallTrump(v game.View) (s game.Suit) {
	h := setOf(v.Hand)
	if v.Players == 3 {
		if b.level == Makkelijk {
			return longestSuit(h, false, 0)
		}
		best, bestV := game.Suit(0), -1<<30
		for su := game.Suit(0); su < game.NumSuits; su++ {
			if x := soloValue(h, su); x > bestV {
				best, bestV = su, x
			}
		}
		if b.level == Normaal {
			return best
		}
		defer func() {
			if r := recover(); r != nil {
				fallbacks.Add(1)
				s = best
			}
		}()
		st := soloSearch(&v, b.cfg, b.rng.Uint64(), func(su game.Suit) bool { return true })
		return bestSuit(st, false, 0)
	}
	mine, theirs := openOf(&v, v.Seat), openOf(&v, 1-v.Seat)
	switch b.level {
	case Makkelijk:
		return longestSuit(mine, v.Forced, v.Turned)
	case Normaal:
		return bestTwo(mine, theirs, v.Forced, v.Turned)
	}
	defer func() {
		if r := recover(); r != nil {
			fallbacks.Add(1)
			s = bestTwo(mine, theirs, v.Forced, v.Turned)
		}
	}()
	st := twoSearch(&v, b.cfg, b.rng.Uint64(), b.persona.Aggression)
	return bestSuit(st, v.Forced, v.Turned)
}

// smallBid says spelen or passen on the turned suit with two players.
func (b *player) smallBid(v game.View) (play bool) {
	mine, theirs := openOf(&v, v.Seat), openOf(&v, 1-v.Seat)
	bar := 24 - int(30*(b.persona.Aggression-0.5))
	normal := twoValue(mine, theirs, v.Turned) >= bar
	switch b.level {
	case Makkelijk:
		return makkelijkBid(mine.inSuit(v.Turned), v.Turned, b.persona.Aggression)
	case Normaal:
		return normal
	}
	defer func() {
		if r := recover(); r != nil {
			fallbacks.Add(1)
			play = normal
		}
	}()
	st := twoSearch(&v, b.cfg, b.rng.Uint64(), b.persona.Aggression)
	return st[v.Turned].mean()+bidBias(b.persona.Aggression) > 0
}

// Auction bids in the three-player auction (design §2): the lowest bid
// at which playing alone is worth more than defending, else it passes.
// All levels estimate by playing sampled deals out, makkelijk with few
// and carelessly. The estimate is kept for the hand.
func (b *player) Auction(v game.View) int {
	if v.Players != 3 || v.Phase != game.PhaseAuction {
		return 0
	}
	bid := v.MinNextBid()
	if bid > game.MaxBid {
		return 0
	}
	h := setOf(v.Hand)
	if b.est.hand != h || b.est.handNo != v.HandNo {
		worlds := map[Level]int{Makkelijk: 24, Normaal: 96, Sterk: 320}[b.level]
		b.est = auctionEstimate{hand: h, handNo: v.HandNo, deals: estimateSolo(&v, worlds, b.rng.Uint64())}
	}
	// Defending is worth defendValue on average; bold personas think less
	// of it, and makkelijk bids wildly.
	pass := defendValue
	if b.cfg.defend != 0 {
		pass = b.cfg.defend
	}
	pass -= 30 * (b.persona.Aggression - 0.5)
	if b.level == Makkelijk {
		pass -= 25
	}
	if b.est.value(bid) > pass {
		return bid
	}
	return 0
}

// defendValue is what a player expects from a hand in which another plays
// alone, in the soloist's terms of soloOutcome: its gain minus the
// others' average. Fitted in self-play.
var defendValue = -30.0

// soloOutcome is what playing alone for bid brings, as the soloist's gain
// minus the average gain of the other two: made, the soloist scores its
// points and roem and they share the rest; nat, they share everything.
func soloOutcome(bid int, d soloDeal) float64 {
	if d.made >= bid {
		return float64(d.made) - float64(d.total-d.made)/2
	}
	return -float64(d.total) / 2
}

// soloDeal is one sampled deal played out by a soloist: what it made
// (points and roem) and all points and roem of the hand.
type soloDeal struct{ made, total int }

// auctionEstimate holds the sampled deals for the hand of one auction.
type auctionEstimate struct {
	hand   cardSet
	handNo int
	deals  []soloDeal
}

// value is the average soloOutcome of bid over the sampled deals.
func (e *auctionEstimate) value(bid int) float64 {
	if len(e.deals) == 0 {
		return math.Inf(-1)
	}
	sum := 0.0
	for _, d := range e.deals {
		sum += soloOutcome(bid, d)
	}
	return sum / float64(len(e.deals))
}

// estimateSolo plays out n sampled deals in which v.Seat plays alone with
// its hand and the talon, laying away and choosing trump by soloPlan.
func estimateSolo(v *game.View, n int, seed uint64) []soloDeal {
	me := v.Seat
	hand := setOf(v.Hand)
	var holders [3]game.Seat
	var need [3]int
	k := 0
	for s := range game.Seat(3) {
		if s != me {
			holders[k], need[k] = s, len(v.Hand)
			k++
		}
	}
	holders[2], need[2] = talonSeat, 2
	sp := smallSampler(holders, need, allCards&^hand, nil)
	rng := rand.New(rand.NewPCG(seed, 3))
	out := make([]soloDeal, 0, n)
	for range n {
		var h [4]cardSet
		sp.sample(rng, &h)
		h[me] = hand
		var hands [4][]game.Card
		for s := range 3 {
			hands[s] = h[s].appendCards(nil)
		}
		d := game.NewDealFor(3, v.Dealer, hands, h[talonSeat].appendCards(nil), v.Mode, v.Rules, 0)
		for d.Phase() == game.PhaseAuction {
			bid := 0
			if d.Turn() == me {
				bid = d.MinNextBid()
			}
			if err := d.Auction(d.Turn(), bid); err != nil {
				panic("bot: auction: " + err.Error())
			}
		}
		trump, ds := soloPlan(setOf(d.Hand(me)))
		if err := d.Discard(me, ds[:]); err != nil {
			panic("bot: discard: " + err.Error())
		}
		if err := d.ChooseTrump(me, trump); err != nil {
			panic("bot: trump: " + err.Error())
		}
		s := smallSim{d: *d, t: newPubTable(3, d.Voorhand(), trump, me, me, v.Rules)}
		s.run()
		r := s.d.Result()
		out = append(out, soloDeal{r.Points[0] + r.Roem[0], r.Points[0] + r.Points[1] + r.Roem[0] + r.Roem[1]})
	}
	return out
}

// Discard lays two cards away as soloist with three players: soloPlan at
// every level but sterk, which compares the plans for each trump suit by
// playing sampled deals out.
func (b *player) Discard(v game.View) (out [2]game.Card) {
	h := setOf(v.Hand)
	trump, plan := soloPlan(h)
	if v.Players != 3 || b.level != Sterk {
		return plan
	}
	defer func() {
		if r := recover(); r != nil {
			fallbacks.Add(1)
			out = plan
		}
	}()
	best, bestV := plan, -1e18
	for s := game.Suit(0); s < game.NumSuits; s++ {
		ds := discardsFor(h, s)
		w := v
		w.Hand = (h &^ bit(ds[0]) &^ bit(ds[1])).appendCards(nil)
		w.Discards = ds[:]
		w.Phase = game.PhaseTrump
		st := soloSearch(&w, b.cfg, b.rng.Uint64(), func(su game.Suit) bool { return su == s })
		if m := st[s].mean(); m > bestV || (m == bestV && s == trump) {
			best, bestV = ds, m
		}
	}
	return best
}

// soloSearch evaluates trump suits (those try accepts) for the soloist
// v.Seat with three players, whose hand and discards are in v, by playing
// sampled deals out. The value is the soloist's gain over an opponent's.
func soloSearch(v *game.View, cfg searchConfig, seed uint64, try func(game.Suit) bool) [game.NumSuits]optionStats {
	me := v.Seat
	hand := setOf(v.Hand)
	unk := allCards &^ hand &^ setOf(v.Discards)
	var holders [3]game.Seat
	var need [3]int
	k := 0
	for s := range game.Seat(3) {
		if s != me {
			holders[k], need[k] = s, len(v.Hand)
			k++
		}
	}
	holders[2] = talonSeat
	sp := smallSampler(holders, need, unk, nil)
	var stats [chunks][game.NumSuits]optionStats
	cfg.runChunks(func(ch int) {
		rng := chunkRNG(seed, ch)
		for range perChunk(cfg.trumpWorlds, ch) {
			var h [4]cardSet
			sp.sample(rng, &h)
			var hands [4][]game.Card
			for s := range game.Seat(3) {
				if s == me {
					hands[s] = slices.Clone(v.Hand)
				} else {
					hands[s] = h[s].appendCards(nil)
				}
			}
			for su := game.Suit(0); su < game.NumSuits; su++ {
				if !try(su) {
					continue
				}
				vv := *v
				vv.Phase, vv.Trump, vv.TrumpKnown, vv.TrumpBy = game.PhasePlay, su, true, me
				vv.Tricks, vv.Current = nil, game.Trick{Leader: v.Voorhand, Winner: game.NoSeat}
				d, err := game.Resume(vv, hands)
				if err != nil {
					panic("bot: resume: " + err.Error())
				}
				s := smallSim{d: *d, t: newPubTable(3, v.Voorhand, su, me, me, v.Rules)}
				s.run()
				r := s.d.Result()
				st := &stats[ch][su]
				st.total += int64(r.Gains[me] - r.Gains[(me+1)%3])
				st.n++
				st.made += b2i(!r.Nat)
			}
		}
	})
	var out [game.NumSuits]optionStats
	for ch := range chunks {
		for s := range out {
			out[s].total += stats[ch][s].total
			out[s].n += stats[ch][s].n
			out[s].made += stats[ch][s].made
		}
	}
	return out
}

// twoSearch evaluates each trump suit for v.Seat with two players before
// play, as if v.Seat made it: the face-down cards are dealt at random,
// then the hand is played out. The value is v.Seat's score minus the
// opponent's.
func twoSearch(v *game.View, cfg searchConfig, seed uint64, aggr float64) [game.NumSuits]optionStats {
	me := v.Seat
	var known [2][16]game.Card
	var isUp [2]uint16
	var shown cardSet
	for s := range 2 {
		for i, p := range v.Piles[s] {
			if p.Up {
				known[s][i] = p.Card
				isUp[s] |= 1 << i
				shown |= bit(p.Card)
			}
		}
	}
	cards := (allCards &^ shown).appendCards(make([]game.Card, 0, 24))
	var stats [chunks][game.NumSuits]optionStats
	cfg.runChunks(func(ch int) {
		rng := chunkRNG(seed, ch)
		deck := slices.Clone(cards)
		for range perChunk(cfg.trumpWorlds, ch) {
			rng.Shuffle(len(deck), func(i, j int) { deck[i], deck[j] = deck[j], deck[i] })
			var hands [4][]game.Card
			k := 0
			for s := range 2 {
				hands[s] = make([]game.Card, 16)
				for i := range 16 {
					if isUp[s]&(1<<i) != 0 {
						hands[s][i] = known[s][i]
					} else {
						hands[s][i], k = deck[k], k+1
					}
				}
			}
			for su := game.Suit(0); su < game.NumSuits; su++ {
				if v.Forced && su == v.Turned {
					continue
				}
				d := game.NewDealFor(2, v.Dealer, hands, nil, game.Utrechts, v.Rules, 0)
				if d.Turn() != me {
					// Utrechts gives voorhand the choice: let the opponent
					// say it in our place, the outcome is the same.
					if err := d.ChooseTrump(d.Turn(), su); err != nil {
						panic("bot: trump: " + err.Error())
					}
				} else if err := d.ChooseTrump(me, su); err != nil {
					panic("bot: trump: " + err.Error())
				}
				s := smallSim{d: *d, t: newPubTable(2, d.Voorhand(), su, me, game.NoSeat, v.Rules)}
				s.run()
				st := &stats[ch][su]
				st.total += int64(s.valueAsMaker(me, aggr))
				st.n++
			}
		}
	})
	var out [game.NumSuits]optionStats
	for ch := range chunks {
		for s := range out {
			out[s].total += stats[ch][s].total
			out[s].n += stats[ch][s].n
		}
	}
	return out
}

// valueAsMaker is the outcome for seat me as if it had made trump: the
// nat rule judged for me, whoever the deal says chose.
func (s *smallSim) valueAsMaker(me game.Seat, aggr float64) int {
	r := s.d.Result()
	side := int(me)
	score, _ := game.ScoreHand(side, r.Points, r.Roem)
	v := score[side] - score[1-side]
	if r.Pit && r.PitTeam == side {
		v += int(pitAppetite * aggr)
	}
	return v
}
