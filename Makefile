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
#   status check playing logs quadlet e2e dev-stop              every game without it
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
# So are make deploy's SERVER=1 and ALLOW_PLAYING=1, so that one left in the shell
# never ends the games in progress.
ifneq ($(origin SERVER),command line)
override SERVER :=
endif
ifneq ($(origin ALLOW_PLAYING),command line)
override ALLOW_PLAYING :=
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
	install deploy check playing status logs uninstall

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
# A unit is written only when its text changes: make deploy restarts the pod for a
# unit written after it started.
install:   ## install GAME's pod and both its container units for your user
	install -d $(QUADLET_DIR)
	@for s in $(UNIT_SUFFIXES); do f=$(QUADLET_DIR)/$(GAME)$$s; \
	  $(RENDER) deploy/game$$s.in > "$$f.new" || exit 1; \
	  if cmp -s "$$f.new" "$$f"; then rm -f "$$f.new"; echo "$$f (unchanged)"; else mv "$$f.new" "$$f" && echo "$$f"; fi; done
	systemctl --user daemon-reload
	@loginctl show-user "$$USER" -p Linger | grep -q yes || echo "Note: run 'loginctl enable-linger $$USER' so the game starts at boot and survives logout."
# The code the game's server is built from, as git pathspecs: the module, the
# Containerfile, the platform and the game packages it imports (PLATFORM_GAMES:
# klaverjas's rules, for its built-in game), the game's main package and its
# folder, without what the build stage leaves out (web/, docs, settings, JS tests;
# see the Containerfile) and what no binary holds (Go tests and their data). The
# folder of a game of the overlay is in extra/'s own repository: SERVER_CODE_EXTRA.
NOT_IN_SERVER := ':(exclude,glob)**/web/**' ':(exclude,glob)**/*.md' ':(exclude,glob)**/*.mk' \
	':(exclude,glob)**/*.mjs' ':(exclude,glob)**/*_test.go' ':(exclude,glob)**/testdata/**'
SERVER_CODE = go.mod go.sum Containerfile platform $(PLATFORM_GAMES) cmd/$(GAME) $(filter games/%,$(GAME_DIR)) $(NOT_IN_SERVER)
SERVER_CODE_EXTRA = $(GAME) $(NOT_IN_SERVER)
# The revision of image $(1), web or server, that the units run: the label of :current.
CURRENT_REV = podman image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
	localhost/$(GAME)-$(1):current 2>/dev/null
# Succeeds when the game's server container runs.
SERVER_RUNS = podman container inspect --format '{{.State.Running}}' $(GAME)-server 2>/dev/null | grep -qx true
ifneq ($(filter deploy,$(MAKECMDGOALS)),)
# The server the pod runs, looked up before the deploy moves :current; not for a
# tree with changes, which gets a new server anyway.
RUNNING := $(if $(findstring -dirty,$(GIT_SHA)),,$(shell $(call CURRENT_REV,server)))
PLATFORM_GAMES := $(shell grep -rhoE --include='*.go' --exclude='*_test.go' '"jannie/games/[^"]+"' platform 2>/dev/null \
	| tr -d '"' | sed 's|^jannie/||' | sort -u)
# A deploy builds and starts a new server (NEW_SERVER is yes) when the server's
# code changed since the commit RUNNING names (for a game of the overlay, since
# either of its two commits), with SERVER=1, for a tree with changes, and when no
# server built from a commit runs; a commit git does not know counts as a change.
ifeq ($(GAME_DIR),extra/$(ONE))
SERVER_CHANGED = r='$(RUNNING)'; case $$r in *.?*) ;; *) echo yes; exit;; esac; \
	git diff --quiet "$${r%%.*}" HEAD -- $(SERVER_CODE) 2>/dev/null && \
	git -C extra diff --quiet "$${r\#*.}" HEAD -- $(SERVER_CODE_EXTRA) 2>/dev/null || echo yes
else
SERVER_CHANGED = git diff --quiet '$(RUNNING)' HEAD -- $(SERVER_CODE) 2>/dev/null || echo yes
endif
NEW_SERVER := $(if $(filter 1,$(SERVER))$(findstring -dirty,$(GIT_SHA)$(RUNNING))$(if $(RUNNING),,none),yes,$(shell $(SERVER_CHANGED)))
# With the server left as it was, the whole pod restarts all the same when `make
# install` wrote its pod's or its server's unit after it started (a setting, a
# change to deploy/*.in; the web container's own unit comes with nginx's restart),
# when systemd cannot say when it started (systemd 251 and later can), and when
# its server is not running.
ifeq ($(NEW_SERVER),)
POD_SINCE := $(shell systemctl --user show --timestamp=unix -P ActiveEnterTimestamp $(GAME)-pod.service 2>/dev/null)
NEW_UNITS := $(if $(filter @%,$(POD_SINCE)),$(shell find $(QUADLET_DIR)/$(GAME).pod $(QUADLET_DIR)/$(GAME)-server.container \
	-newermt '$(POD_SINCE)' 2>/dev/null),unknown)
SERVER_UP := $(shell $(SERVER_RUNS) && echo yes)
endif
RESTART_POD := $(NEW_SERVER)$(NEW_UNITS)$(if $(NEW_SERVER)$(SERVER_UP),,down)
endif
# The games in progress on the pod, /api/health's playing: says how many, and fails
# when there is one. A pod that does not answer has none if its server does not
# run either, and an unknown number (a failure) if it does; a server from before
# that count says how many players are connected instead, and fails when one is.
PLAYING = h=$$(curl -fsS --max-time 5 "http://$(ADDR)/api/health" 2>/dev/null) || { \
	  if $(SERVER_RUNS); then echo "$(GAME): its server runs, but http://$(ADDR) does not answer: games in progress unknown"; exit 1; fi; \
	  echo "$(GAME): no server running, so no game in progress"; exit 0; }; \
	n=$$(printf '%s\n' "$$h" | sed -n 's/.*"playing":\([0-9]*\).*/\1/p'); \
	p=$$(printf '%s\n' "$$h" | sed -n 's/.*"players":\([0-9]*\).*/\1/p'); p=$${p:-0}; \
	if [ -n "$$n" ]; then echo "$(GAME): games in progress $$n, players connected $$p"; [ "$$n" -eq 0 ]; \
	else echo "$(GAME): players connected $$p (this server does not count its games in progress)"; [ "$$p" -eq 0 ]; fi
# A restart of the pod ends the games in progress: only when there is none, or with ALLOW_PLAYING=1.
GUARD_PLAYING = ($(PLAYING)) || [ "$(ALLOW_PLAYING)" = 1 ] || { \
	  echo "make deploy: restarting the $(GAME) pod ends its games in progress. Deploy when they are over" \
	    "(make playing GAME=$(GAME)), or now with ALLOW_PLAYING=1." >&2; exit 1; }
SAY_WEB = echo "$(GAME): the server's code is that of $(RUNNING), which runs: a new web image only, and the games go on"
POD_WHY = $(if $(filter unknown,$(NEW_UNITS)),systemd cannot say when it started,$(if $(NEW_UNITS),its units changed since it started,its server is not running))
SAY_POD = echo "$(GAME): the server's code is that of $(RUNNING), but the pod restarts: $(POD_WHY)"
# The pod's own checks, and that it runs its :current images.
POD_CHECK = scripts/pod-check $(ADDR) $(SITE) '$(TITLE)' "$$($(call CURRENT_REV,web))" "$$($(call CURRENT_REV,server))"
# What runs in public is a commit, so the revision the site shows names its code;
# ALLOW_DIRTY=1 deploys the working tree anyway, labelled -dirty. The image builds
# run in a sub-make, after this check, with this make's revision and tag. Restarting
# nginx alone keeps the games (their pages reconnect), so the web image is new at
# every deploy; a restart of the pod ends them, so it comes only with a change to
# the server's code (NEW_SERVER) or for the reasons above (RESTART_POD), and only
# when no game is in progress, checked before the build and again after it. A
# server left as it was gets the build's tag as well, so that each tag still names
# both images to go back to.
deploy:    ## build GAME's web image, and its server if the server's code changed; restart them (the pod only while no game is in progress), then check the pod as `make check` does
	@$(call REFUSE_DIRTY,$(GIT_SHA))
	@$(if $(RESTART_POD),$(if $(NEW_SERVER),,$(SAY_POD); )$(GUARD_PLAYING),$(SAY_WEB))
	@$(MAKE) --no-print-directory $(if $(NEW_SERVER),image-server) image-web GAME=$(GAME) GIT_SHA=$(GIT_SHA) BUILD_TAG=$(BUILD_TAG)
	@$(if $(RESTART_POD),$(GUARD_PLAYING))
	$(if $(NEW_SERVER),podman tag localhost/$(GAME)-server:$(BUILD_TAG) localhost/$(GAME)-server:current,podman tag localhost/$(GAME)-server:current localhost/$(GAME)-server:$(BUILD_TAG))
	podman tag localhost/$(GAME)-web:$(BUILD_TAG) localhost/$(GAME)-web:current
	systemctl --user restart $(GAME)-$(if $(RESTART_POD),pod,web).service
	@addr=$(ADDR); tries=30; ($(WAIT_HEALTH)) && $(POD_CHECK) || \
	  { echo "see: make status GAME=$(GAME); make logs GAME=$(GAME)" >&2; exit 1; }; \
	  echo "$(GAME) $(GIT_SHA) is up on http://$(ADDR)/ (images :current and :$(BUILD_TAG)$(if $(NEW_SERVER),,; the server's revision $(RUNNING)))"
check:     ## check GAME's running pod (every game's without GAME) on its ADDR without the reverse proxy: pages, websocket, security headers, its :current images
	@$(POD_CHECK)
playing:   ## the games in progress on GAME's pod (every game's without GAME), which a new server would end; fails when there is one
	@$(PLAYING)
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
# Every game's, also after one with a game in progress.
playing:
	@+s=0; for g in $(GAMES); do $(MAKE) --no-print-directory $@ GAME=$$g \
	  HEAD_REV=$(HEAD_REV) EXTRA_REV=$(EXTRA_REV) STAMP=$(STAMP) || s=1; done; exit $$s
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
