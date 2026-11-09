# ---- site settings: one folder per game, games/<game>/ or extra/<game>/ ---------------
# Every game has a pod, an address and images of its own. A game is a folder,
# games/<game>/, or extra/<game>/ in the overlay of a private checkout, and its
# settings are in the folder's <game>.mk: the public host name (SITE), where the pod
# listens (ADDR), the ports of the server from source and the rest. Change them
# there, then `make install GAME=<game> && make deploy GAME=<game>`. The games are
# the names of those files; a new folder is a new game (docs/adding-a-game.md#the-folder).
#
# GAME, from make's command line only (one left in the shell's environment is
# ignored, so that it never picks what is deployed), is one game or `all`:
#   install deploy uninstall dev image image-server image-web   need it
#   status check logs quadlet e2e dev-stop                      every game without it
#   help test test-all                                          do not take it
# GAME=all goes through the games one after another, in the order of their names,
# with one build time in their tags, and stops at the first one that fails.
#
# One setting belongs to the deployment rather than a game: SUPPORT_URL, the
# payment link behind "Support deze app" on every game's home page. It goes in
# local.mk next to this Makefile, which git ignores, as
#   SUPPORT_URL = https://…
# (or on make's command line; one in the shell's environment is ignored). Make
# reads local.mk, so a # in the link is written \# and a $ as $$. Without it
# the web images have no support button.
# ---------------------------------------------------------------------------------------
# The games' settings, and the folder of game $(1), games/<game> or extra/<game>.
GAME_MKS := $(wildcard games/*/*.mk extra/*/*.mk)
GAMES := $(sort $(basename $(notdir $(GAME_MKS))))
folder = $(patsubst %/$(1).mk,%,$(filter %/$(1)/$(1).mk,$(GAME_MKS)))
SETTINGS := TITLE VERB SITE ADDR DEV_PORT E2E_PORT E2E_SIM
NEED_GAME := install deploy uninstall dev image image-server image-web
EVERY_GAME := status check quadlet e2e dev-stop
ifeq ($(GAMES),)
$(error no game: games/*/*.mk and extra/*/*.mk are missing)
endif
# A folder, its settings file and its game have one name, and no game is in both
# games/ and extra/.
$(foreach f,$(GAME_MKS),$(if $(filter %/$(basename $(notdir $(f)))/,$(dir $(f))),,\
  $(error $(f): a game's settings are <folder>/<game>/<game>.mk, named after their folder)))
$(foreach g,$(GAMES),$(if $(word 2,$(call folder,$(g))),\
  $(error $(g) is a game twice, in $(call folder,$(g)): a game has one folder)))
ifneq ($(origin GAME),command line)
override GAME :=
endif
ifneq ($(filter-out all $(GAMES),$(GAME))$(word 2,$(GAME)),)
$(error GAME=$(GAME) is not a game; the games are $(GAMES), and GAME=all is every one)
endif
-include local.mk
# Not one from the environment; spaces around it dropped. One https URL, quoted
# as it is in the web image's build (the Containerfile checks it again).
override SUPPORT_URL := $(if $(filter environment%,$(origin SUPPORT_URL)),,$(strip $(SUPPORT_URL)))
ifneq ($(strip $(filter-out https://%,$(SUPPORT_URL))$(filter https://,$(SUPPORT_URL))$(word 2,$(SUPPORT_URL))$(foreach c,' " < >,$(findstring $(c),$(SUPPORT_URL)))),)
$(error SUPPORT_URL=$(SUPPORT_URL): not an https URL without quotes, spaces, < or > (local.mk; see the top of the Makefile))
endif
# The one game the targets act on, or empty for all of them (GAME=all, or no GAME).
ONE := $(filter $(GAMES),$(GAME))
ifeq ($(ONE),)
$(foreach v,$(SETTINGS),$(if $(filter command line,$(origin $(v))),\
  $(error $(v) on the command line is a setting of one game: add GAME=<game>)))
endif

# The commit the images are built from, with -dirty when the working tree, which
# is what the build copies, differs from it (untracked files included); and the
# overlay's, extra/, a git checkout of its own that this repository ignores. A
# game's revision, its images' label and the version in /api/health, is the
# first (GIT_SHA, below); a game of the overlay's adds the second after a dot,
# with -dirty when either tree is, and an extra/ that is no git checkout is never
# a commit. Worked out once and handed to the makes of each game.
dirty = $(shell git $(1) status --porcelain --untracked-files=normal 2>/dev/null | grep -q . && echo -dirty)
HEAD_REV := $(shell git rev-parse HEAD 2>/dev/null || echo dev)$(call dirty)
EXTRA_REV := $(if $(wildcard extra/.git),$(shell git -C extra rev-parse -q --verify --short=12 HEAD)$(call dirty,-C extra),-dirty)
# Each build's own tag, the revision and the time, so the build before it is still
# there to go back to, even after a rebuild of the same commit. Only `make deploy`
# moves :current, the tag the units run, so a `make image` on its own never changes
# what the pod restarts into.
STAMP := $(shell date +%Y%m%d-%H%M%S)
BUILD_TAG = $(GIT_SHA)-$(STAMP)
# --pull=newer: a Go, nginx or Alpine fix re-published under the same base tag
# reaches the next build (podman's default reuses a local base image forever).
BUILD_ARGS = --pull=newer --build-arg GIT_SHA=$(GIT_SHA)
QUADLET_DIR ?= $(HOME)/.config/containers/systemd
GO = scripts/go
# The JS tests: the shared ones and each game's, <folder>/test/*.test.mjs.
JS_TESTS = $(wildcard test/*.test.mjs test/ui/*.test.mjs $(foreach g,$(GAMES),$(call folder,$(g))/test/*.test.mjs))
# Polls the health endpoint at $$addr for up to $$tries seconds; exits 1 if it never answers.
WAIT_HEALTH = i=0; until curl -fs -o /dev/null "http://$$addr/api/health"; do i=$$((i + 1)); \
	if [ $$i -ge $$tries ]; then echo "no answer from http://$$addr/api/health" >&2; exit 1; fi; sleep 1; done
# make deploy deploys commits: it refuses revisions $(1) with -dirty, unless ALLOW_DIRTY=1.
REFUSE_DIRTY = case "$(1)" in *-dirty*) [ "$(ALLOW_DIRTY)" = 1 ] || { \
	  echo "make deploy: the working tree has changes that are not committed (git status;" \
	    "for a game of extra/ also git -C extra status, a git checkout of its own)." \
	    "Commit them, or deploy anyway with ALLOW_DIRTY=1." >&2; exit 1; };; esac
# Stops the development server on port $(1), if it is still there.
STOP_DEV = podman stop -t 3 kj-dev-$(1) >/dev/null 2>&1 || true

.PHONY: help test test-all e2e dev dev-up dev-stop image image-server image-web quadlet \
	install deploy check status logs uninstall

help:      ## list targets
	@grep -E '^[a-z0-9-]+:.*## ' $(firstword $(MAKEFILE_LIST)) | sed -E 's/:[^#]*## /\t/'
	@echo "GAME: $(GAMES), or all (games/*/*.mk and extra/*/*.mk; see the top of the Makefile)"

# ---- development, no images ---------------------------------------------------------
test:      ## go vet, the short Go tests, the JS tests and the deployment files
	$(GO) vet ./...
	$(GO) test -short ./...
ifneq ($(JS_TESTS),)
	node --test $(JS_TESTS)
endif
	scripts/deploy-test
test-all:  ## every Go test, including the slow bot arena
	$(GO) test -timeout 60m ./...

ifneq ($(ONE),)
# ---- one game: GAME -----------------------------------------------------------------
GAME_DIR := $(call folder,$(ONE))
include $(GAME_DIR)/$(ONE).mk
# Its revision (above): a game of the overlay names both commits.
ifeq ($(GAME_DIR),extra/$(ONE))
GIT_SHA := $(subst -dirty,,$(HEAD_REV))$(addprefix .,$(subst -dirty,,$(EXTRA_REV)))$(findstring -dirty,$(HEAD_REV)$(EXTRA_REV))
else
GIT_SHA := $(HEAD_REV)
endif
$(foreach v,$(SETTINGS),$(if $($(v)),,$(error $(GAME_DIR)/$(ONE).mk: $(v) is not set)))
# Its three units, <game>.pod from deploy/game.pod.in and so on.
UNIT_SUFFIXES := .pod -web.container -server.container
UNITS = $(addprefix $(GAME),$(UNIT_SUFFIXES))
RENDER = sed -e 's|@GAME@|$(GAME)|g' -e 's|@TITLE@|$(TITLE)|g' -e 's|@SITE@|$(SITE)|g' -e 's|@ADDR@|$(ADDR)|g'
# The web image is the game's: its files (its folder's web/), its host name in the
# CSP and the link preview, and its name and verb on the 404 page; and the
# deployment's support link, if any.
WEB_ARGS = --build-arg GAME=$(GAME) --build-arg GAME_DIR=$(GAME_DIR) --build-arg SITE=$(SITE) --build-arg 'TITLE=$(TITLE)' --build-arg 'VERB=$(VERB)' \
	--build-arg 'SUPPORT_URL=$(SUPPORT_URL)'

e2e:       ## play full games over the websocket against GAME's server from source (every game's without GAME), at -fast pacing
	@test -f $(E2E_SIM) || { echo "$(E2E_SIM) not found" >&2; exit 1; }
	GAME=$(GAME) scripts/dev-server $(E2E_PORT) -fast
	@trap '$(call STOP_DEV,$(E2E_PORT))' EXIT INT TERM; \
	  addr=127.0.0.1:$(E2E_PORT); tries=180; $(WAIT_HEALTH); \
	  node $(E2E_SIM) "http://$$addr"
# Starts the server from source and waits for it; `make dev`, also for GAME=all.
dev-up:
	GAME=$(GAME) scripts/dev-server $(DEV_PORT)
	@trap '$(call STOP_DEV,$(DEV_PORT)); exit 130' INT TERM; \
	  addr=127.0.0.1:$(DEV_PORT); tries=180; ($(WAIT_HEALTH)) || { $(call STOP_DEV,$(DEV_PORT)); exit 1; }; \
	  echo "Open http://$$addr/ for $(GAME)"
dev: dev-up ## run GAME's server from source on 127.0.0.1:DEV_PORT and follow its log; Ctrl-C stops it
	@trap '$(call STOP_DEV,$(DEV_PORT))' EXIT INT TERM; podman logs -f kj-dev-$(DEV_PORT)
dev-stop:  ## stop GAME's development server (every game's without GAME), if `make dev` left it running
	@$(call STOP_DEV,$(DEV_PORT))

# ---- containers, as your own user -----------------------------------------------------
# The build copies extra/, the overlay, and podman refuses to copy what is not
# there: without the overlay an empty extra/ stands in for it.
image-server:   ## build GAME's server image (fresh base image), tagged BUILD_TAG; go vet and the short tests run inside the build
	@mkdir -p extra
	podman build --target server $(BUILD_ARGS) --build-arg GAME=$(GAME) -t localhost/$(GAME)-server:$(BUILD_TAG) .
image-web:      ## build GAME's web image, tagged BUILD_TAG: nginx, its configuration for SITE, platform/web and the game's web/
	$(if $(SUPPORT_URL),,@echo "No SUPPORT_URL (local.mk): $(GAME)'s web image has no support button.")
	@mkdir -p extra
	podman build --target web $(BUILD_ARGS) $(WEB_ARGS) -t localhost/$(GAME)-web:$(BUILD_TAG) .
image: image-server image-web   ## build both images of GAME; the running pod keeps its :current ones
quadlet:   ## show the three units of GAME (every game's without GAME) with its settings filled in
	@for s in $(UNIT_SUFFIXES); do echo "# ---- $(GAME)$$s"; $(RENDER) deploy/game$$s.in; echo; done
install:   ## install GAME's pod and both its container units for your user
	install -d $(QUADLET_DIR)
	@for s in $(UNIT_SUFFIXES); do echo "$(QUADLET_DIR)/$(GAME)$$s"; \
	  $(RENDER) deploy/game$$s.in > $(QUADLET_DIR)/$(GAME)$$s || exit 1; done
	systemctl --user daemon-reload
	@loginctl show-user "$$USER" -p Linger | grep -q yes || echo "Note: run 'loginctl enable-linger $$USER' so the game starts at boot and survives logout."
# What runs in public is a commit, so the revision the site shows names its code;
# ALLOW_DIRTY=1 deploys the working tree anyway, labelled -dirty. The image builds
# run in a sub-make, after this check, with this make's revision and tag.
deploy:    ## build both images of GAME from a committed tree, (re)start its pod, then check it as `make check` does
	@$(call REFUSE_DIRTY,$(GIT_SHA))
	@$(MAKE) --no-print-directory image GAME=$(GAME) GIT_SHA=$(GIT_SHA) BUILD_TAG=$(BUILD_TAG)
	podman tag localhost/$(GAME)-server:$(BUILD_TAG) localhost/$(GAME)-server:current
	podman tag localhost/$(GAME)-web:$(BUILD_TAG) localhost/$(GAME)-web:current
	systemctl --user restart $(GAME)-pod.service
	@addr=$(ADDR); tries=30; ($(WAIT_HEALTH)) && scripts/pod-check $(ADDR) $(SITE) '$(TITLE)' || \
	  { echo "see: make status GAME=$(GAME); make logs GAME=$(GAME)" >&2; exit 1; }; \
	  echo "$(GAME) $(GIT_SHA) is up on http://$(ADDR)/ (images :current and :$(BUILD_TAG))"
check:     ## check GAME's running pod (every game's without GAME) on its ADDR without the reverse proxy: pages, websocket, security headers
	@scripts/pod-check $(ADDR) $(SITE) '$(TITLE)'
# The first column fits the longest name to come, presidenten-server.
status:    ## state, image revision and health of GAME's pod and both its containers (every game's without GAME)
	@for u in $(GAME)-pod $(GAME)-web $(GAME)-server; do \
	  printf '%-18s %s\n' "$$u" "$$(systemctl --user is-active $$u.service)"; done
	@for c in $(GAME)-web $(GAME)-server; do \
	  printf '%-18s revision %s, %s\n' "$$c" \
	    "$$(podman inspect $$c --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || echo -)" \
	    "$$(podman inspect $$c --format '{{.State.Health.Status}}' 2>/dev/null || echo 'not running')"; done
	@printf '%-18s %s\n' "http://$(ADDR)" "$$(curl -fsS --max-time 5 http://$(ADDR)/api/health || echo 'no answer')"
logs:      ## follow the logs of both containers of GAME (of every game without GAME)
	journalctl --user -u $(GAME)-web.service -u $(GAME)-server.service -f
uninstall: ## stop GAME and remove its units; keeps its images and its game log
	-systemctl --user stop $(GAME)-pod.service
	rm -f $(addprefix $(QUADLET_DIR)/,$(UNITS))
	systemctl --user daemon-reload

else
# ---- every game (GAME=all), or no GAME --------------------------------------------------
# Each game in turn, in a make of its own with this make's revisions and build time
# (run under -n too, which the sub-makes then honour: `make -n deploy GAME=all`).
EACH = for g in $(GAMES); do $(MAKE) --no-print-directory $@ GAME=$$g \
	  HEAD_REV=$(HEAD_REV) EXTRA_REV=$(EXTRA_REV) STAMP=$(STAMP) || exit 1; done
# Every game's development port, for `make dev GAME=all`.
define dev-port
include $(call folder,$(1))/$(1).mk
$(1).DEV_PORT := $$(DEV_PORT)
endef
$(foreach g,$(GAMES),$(eval $(call dev-port,$(g))))
$(foreach v,$(SETTINGS),$(eval undefine $(v)))

$(EVERY_GAME):
	@+$(EACH)
logs:
	journalctl --user $(foreach g,$(GAMES),-u $(g)-web.service -u $(g)-server.service) -f
ifeq ($(GAME),all)
$(filter-out dev deploy,$(NEED_GAME)):
	@+$(EACH)
# A tree that is not a commit stops it before the first game.
deploy:
	@$(call REFUSE_DIRTY,$(HEAD_REV) $(if $(filter extra/%,$(GAME_MKS)),$(EXTRA_REV)))
	@+$(EACH)
# Every game's server from source, each started once the one before it answers;
# then all their logs. Ctrl-C stops them all.
dev:
	@trap '$(foreach g,$(GAMES),$(call STOP_DEV,$($(g).DEV_PORT));)' EXIT INT TERM; \
	  for g in $(GAMES); do $(MAKE) --no-print-directory dev-up GAME=$$g || exit 1; done; \
	  podman logs -f --names $(foreach g,$(GAMES),kj-dev-$($(g).DEV_PORT))
else
$(NEED_GAME):
	@echo "make $@: which game? Add GAME=<game>, or GAME=all for every one; the games are $(GAMES)." >&2; exit 2
endif
endif
