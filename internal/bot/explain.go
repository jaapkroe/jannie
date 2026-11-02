package bot

import (
	"klaverjas/internal/game"
)

// Explanation is the engine's reasoning for one decision, for the expert
// mode: what the rule-based policy of normaal chooses and why, what sterk
// and the hint choose, and what the search found every option worth. The
// values are those of the hints and the review: the expected difference
// between the scores of the player's team and the opponents at the end of
// the hand, without an appetite for pit.
type Explanation struct {
	Normaal  Choice // the rule-based choice
	Rule     string // a card: the hint text for the rule that chose it ("Speel ♠A: …"); else ""
	Sterk    Choice // sterk's choice from this search, at average aggression
	SterkWhy string // a card: why sterk's card is not one the search values most; else ""
	Hint     Choice // the training hint
	HintText string
	HintWhy  string   // a card: why the hint keeps the rule-based card while sterk plays another; else ""
	Worlds   int      // sampled deals per option; 0 without a search (one legal card)
	Options  []Option // every option: the legal cards, the allowed suits, or spelen and passen
}

// Option is what the search found one option worth.
type Option struct {
	Choice
	Value float64 // expected score difference
	SE    float64 // standard error of the difference with the best option (paired); 0 for the best
	Outcome
	Parts []float64 // a card: its value per part (see searchWhy), in the order of the part constants
	Why   string    // a card below the best: why the best brings more (optionWhy); else ""
}

// Explain returns the reasoning for the decision of the player of v, whose
// turn it must be, at a table of four. It searches as Advise does, on the
// same view with the same seed, so it agrees with the hint and the review.
// Should the search fail, it returns no explanation.
func Explain(v game.View) (e Explanation) {
	if small(&v) || v.Turn.Valid() && v.Turn != v.Seat {
		return Explanation{}
	}
	defer func() {
		if r := recover(); r != nil {
			fallbacks.Add(1)
			e = Explanation{}
		}
	}()
	seed := viewSeed(&v)
	switch v.Phase {
	case game.PhaseTrump:
		return explainTrump(&v, seed)
	case game.PhaseBid:
		return explainBid(&v, seed)
	case game.PhasePlay:
		return explainPlay(&v, seed)
	}
	return Explanation{}
}

func explainTrump(v *game.View, seed uint64) Explanation {
	st := searchTrump(v, adviseSearch, seed, 0.5)
	best := bestSuit(st, v.Forced, v.Turned)
	normal := bestTrumpNormal(setOf(v.Hand), v.Forced, v.Turned)
	e := Explanation{HintText: trumpText(v, best, st[best]), Worlds: st[best].n}
	e.Normaal.Suit, e.Sterk.Suit, e.Hint.Suit = &normal, &best, &best
	for s := game.Suit(0); s < game.NumSuits; s++ {
		if v.Forced && s == v.Turned {
			continue
		}
		o := Option{Value: st[s].mean(), Outcome: st[s].outcome()}
		o.Suit = &s
		if s != best {
			o.SE = st[best].pairSE(st[s], int(s))
		}
		e.Options = append(e.Options, o)
	}
	return e
}

func explainBid(v *game.View, seed uint64) Explanation {
	play, pass := searchBid(v, adviseSearch, seed, 0.5)
	p := play.mean() > pass.mean()
	normal := trumpValue(setOf(v.Hand), v.Turned) >= bidThreshold(0.5)
	e := Explanation{HintText: bidText(v, p, play), Worlds: play.n}
	e.Normaal.Play, e.Sterk.Play, e.Hint.Play = &normal, &p, &p
	yes, no := true, false
	py, pn := Option{Value: play.mean(), Outcome: play.outcome()}, Option{Value: pass.mean(), Outcome: pass.outcome()}
	py.Play, pn.Play = &yes, &no
	if p {
		pn.SE = play.pairSE(pass, 1)
	} else {
		py.SE = pass.pairSE(play, 0)
	}
	e.Options = []Option{py, pn}
	return e
}

func explainPlay(v *game.View, seed uint64) Explanation {
	legal := legalCards(*v)
	if len(legal) == 0 {
		return Explanation{}
	}
	v.Legal = legal
	tab := tableFromView(v)
	m := newMover(&tab, v.Seat, setOf(v.Hand), setOf(legal), 0.5)
	c, r := m.decide()
	e := Explanation{Rule: hintText(c, m.ruleWhy(c, r))}
	e.Normaal.Card = &c
	if len(legal) == 1 {
		e.Sterk.Card, e.Hint.Card, e.HintText = &c, &c, e.Rule
		e.Options = []Option{{Choice: Choice{Card: &c}}}
		return e
	}
	res := searchPlay(v, &tab, adviseSearch, seed, 0.5)
	si, why := sterkChoose(&m, res, c)
	sterk := res[si].card
	hint, text := teachPick(&m, res, c, r)
	e.Sterk.Card, e.Hint.Card, e.HintText, e.Worlds = &sterk, &hint, text, res[0].n
	e.SterkWhy = m.sterkReason(res, si, why)
	if hint != sterk {
		e.HintWhy = hintKeptReason(res, si, resultIndex(res, c))
	}
	best := 0
	for i := range res {
		if res[i].mean() > res[best].mean() {
			best = i
		}
	}
	for i := range res {
		o := Option{Value: res[i].mean(), SE: pairSE(res, best, i), Outcome: res[i].outcome(), Parts: make([]float64, numParts)}
		o.Card = &res[i].card
		for k := range o.Parts {
			o.Parts[k] = res[i].part(k)
		}
		if i != best {
			o.Why = m.optionWhy(res, best, i)
		}
		e.Options = append(e.Options, o)
	}
	return e
}
