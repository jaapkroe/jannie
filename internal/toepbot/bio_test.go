package toepbot

import (
	"regexp"
	"strings"
	"testing"

	"klaverjas/internal/persona"
)

// klaverjasWords are words of klaverjas a toepen bio has no business with.
var klaverjasWords = regexp.MustCompile(`(?i)\b(roem|pit|nat|troef|klaverjas\w*)\b|café de klaver`)

// Every persona has a bio at a table of toepen, about toepen only.
func TestBios(t *testing.T) {
	for _, p := range persona.All() {
		bio := Bio(p.ID)
		switch {
		case bio == "":
			t.Errorf("%s has no toepen bio", p.ID)
		case klaverjasWords.MatchString(bio):
			t.Errorf("%s's bio speaks of klaverjas: %q", p.ID, bio)
		case !strings.HasSuffix(bio, ".") || strings.Contains(bio, "\n"):
			t.Errorf("%s's bio is not one line: %q", p.ID, bio)
		}
	}
	if len(bios) != len(persona.All()) {
		t.Errorf("%d bios for %d personas", len(bios), len(persona.All()))
	}
	if Bio("niemand") != "" {
		t.Error("a bio for nobody")
	}
}
