# ---- site settings: one file per game, games/<game>/<game>.mk -----------------------
# Every game has a pod, an address and images of its own. Its settings are in
# games/<game>/<game>.mk: the public host name (SITE), where the pod listens (ADDR),
# the ports of the server from source and the rest. Change them there, then
# `make install GAME=<game> && make deploy GAME=<game>`. The games are the names of
# those files; a new file is a new game (deploy/README-deploy.md, "Adding a game").
#
# GAME, from make's command line only (one left in the shell's environment is
# ignored, so that it never picks what is deployed), is one game or `all`:
#   install deploy uninstall dev image image-server image-web   need it
#   status check logs quadlet e2e dev-stop                      every game without it
#   help test test-all                                          do not take it
# GAME=all goes through the games one after another, in the order of their names,
# under one build tag, and stops at the first one that fails.
#
# One setting belongs to the deployment rather than a game: SUPPORT_URL, the
# payment link behind "Support deze app" on every game's home page. It goes in
# local.mk next to this Makefile, which git ignores, as
#   SUPPORT_URL = https://…
# (or on make's command line; one in the shell's environment is ignored). Without
# it the web images have no support button.
# ---------------------------------------------------------------------------------------
GAMES := $(sort $(basename $(notdir $(wildcard games/*/*.mk))))
SETTINGS := TITLE VERB SITE ADDR DEV_PORT E2E_PORT E2E_SIM
NEED_GAME := install deploy uninstall dev image image-server image-web
EVERY_GAME := status check quadlet e2e dev-stop
ifeq ($(GAMES),)
$(error no game: games/*/*.mk is missing)
endif
ifneq ($(origin GAME),command line)
override GAME :=
endif
ifneq ($(filter-out all $(GAMES),$(GAME))$(word 2,$(GAME)),)
$(error GAME=$(GAME) is not a game; the games are $(GAMES), and GAME=all is every one)
endif
-include local.mk
ifeq ($(origin SUPPORT_URL),environment)
override SUPPORT_URL :=
endif
# One https URL, quoted as it is in the web image's build (the Containerfile
# checks it again).
ifneq ($(strip $(filter-out https://%,$(SUPPORT_URL))$(word 2,$(SUPPORT_URL))$(foreach c,' " < >,$(findstring $(c),$(SUPPORT_URL)))),)
$(error SUPPORT_URL=$(SUPPORT_URL): not an https URL without quotes, spaces, < or > (local.mk; see the top of the Makefile))
endif
# The one game the targets act on, or empty for all of them (GAME=all, or no GAME).
ONE := $(filter $(GAMES),$(GAME))
ifeq ($(ONE),)
$(foreach v,$(SETTINGS),$(if $(filter command line,$(origin $(v))),\
  $(error $(v) on the command line is a setting of one game: add GAME=<game>)))
endif

# The commit the images are built from, with -dirty when the working tree, which
# is what the build copies, differs from it (untracked files included). It is the
# images' revision label and the version in /api/health.
GIT_SHA := $(shell git rev-parse HEAD 2>/dev/null || echo dev)$(shell git status --porcelain --untracked-files=normal 2>/dev/null | grep -q . && echo -dirty)
# Each build's own tag, so the build before it is still there to go back to, even
# after a rebuild of the same commit. Only `make deploy` moves :current, the tag the
# units run, so a `make image` on its own never changes what the pod restarts into.
BUILD_TAG := $(GIT_SHA)-$(shell date +%Y%m%d-%H%M%S)
# --pull=newer: a Go, nginx or Alpine fix re-published under the same base tag
# reaches the next build (podman's default reuses a local base image forever).
BUILD_ARGS = --pull=newer --build-arg GIT_SHA=$(GIT_SHA)
QUADLET_DIR ?= $(HOME)/.config/containers/systemd
GO = scripts/go
JS_TESTS = $(wildcard test/*.test.mjs test/ui/*.test.mjs)
# Polls the health endpoint at $$addr for up to $$tries seconds; exits 1 if it never answers.
WAIT_HEALTH = i=0; until curl -fs -o /dev/null "http://$$addr/api/health"; do i=$$((i + 1)); \
	if [ $$i -ge $$tries ]; then echo "no answer from http://$$addr/api/health" >&2; exit 1; fi; sleep 1; done
# Stops the development server on port $(1), if it is still there.
STOP_DEV = podman stop -t 3 kj-dev-$(1) >/dev/null 2>&1 || true

.PHONY: help test test-all e2e dev dev-up dev-stop image image-server image-web quadlet \
	install deploy check status logs uninstall

help:      ## list targets
	@grep -E '^[a-z0-9-]+:.*## ' $(firstword $(MAKEFILE_LIST)) | sed -E 's/:[^#]*## /\t/'
	@echo "GAME: $(GAMES), or all (games/*/*.mk; see the top of the Makefile)"

# ---- development, no images ---------------------------------------------------------
test:      ## go vet, the short Go tests, the JS tests and the deployment files
	$(GO) vet ./...
	$(GO) test -short ./...
ifneq ($(JS_TESTS),)
	node --test $(JS_TESTS)
endif
	scripts/deploy-test
test-all:  ## every Go test, including the slow bot arena
	$(GO) test ./...

ifneq ($(ONE),)
# ---- one game: GAME -----------------------------------------------------------------
include games/$(ONE)/$(ONE).mk
$(foreach v,$(SETTINGS),$(if $($(v)),,$(error games/$(ONE)/$(ONE).mk: $(v) is not set)))
# Its three units, <game>.pod from deploy/game.pod.in and so on.
UNIT_SUFFIXES := .pod -web.container -server.container
UNITS = $(addprefix $(GAME),$(UNIT_SUFFIXES))
RENDER = sed -e 's|@GAME@|$(GAME)|g' -e 's|@TITLE@|$(TITLE)|g' -e 's|@SITE@|$(SITE)|g' -e 's|@ADDR@|$(ADDR)|g'
# The web image is the game's: its files, its host name in the CSP and the link
# preview, and its name and verb on the 404 page; and the deployment's support
# link, if any.
WEB_ARGS = --build-arg GAME=$(GAME) --build-arg SITE=$(SITE) --build-arg 'TITLE=$(TITLE)' --build-arg 'VERB=$(VERB)' \
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
image-server:   ## build GAME's server image (fresh base image), tagged BUILD_TAG; go vet and the short tests run inside the build
	podman build --target server-$(GAME) $(BUILD_ARGS) -t localhost/$(GAME)-server:$(BUILD_TAG) .
image-web:      ## build GAME's web image, tagged BUILD_TAG: nginx, its configuration for SITE, platform/web and games/GAME/web
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
	@case "$(GIT_SHA)" in *-dirty) [ "$(ALLOW_DIRTY)" = 1 ] || { \
	  echo "make deploy: the working tree has changes that are not committed (git status)." \
	    "Commit them, or deploy anyway with ALLOW_DIRTY=1." >&2; exit 1; };; esac
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
# Each game in turn, in a make of its own with this make's revision and build tag
# (run under -n too, which the sub-makes then honour: `make -n deploy GAME=all`).
EACH = for g in $(GAMES); do \
	  $(MAKE) --no-print-directory $@ GAME=$$g GIT_SHA=$(GIT_SHA) BUILD_TAG=$(BUILD_TAG) || exit 1; done
# Every game's development port, for `make dev GAME=all`.
define dev-port
include games/$(1)/$(1).mk
$(1).DEV_PORT := $$(DEV_PORT)
endef
$(foreach g,$(GAMES),$(eval $(call dev-port,$(g))))
$(foreach v,$(SETTINGS),$(eval undefine $(v)))

$(EVERY_GAME):
	@+$(EACH)
logs:
	journalctl --user $(foreach g,$(GAMES),-u $(g)-web.service -u $(g)-server.service) -f
ifeq ($(GAME),all)
$(filter-out dev,$(NEED_GAME)):
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
