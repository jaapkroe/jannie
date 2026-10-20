# ---- site settings: change here, then `make install && make deploy` -------------------
# Public host name. NPM terminates TLS for it and forwards to ADDR.
SITE ?= klaverjas.kroes.dev
# Where the pod listens. Loopback, because NPM runs on the same machine; see
# deploy/README-deploy.md before changing it.
ADDR ?= 127.0.0.1:8093
# The server from source, for `make dev` and `make e2e`; clear of the installed pod.
DEV_PORT ?= 18093
E2E_PORT ?= 18094
# ---------------------------------------------------------------------------------------

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
BUILD_ARGS = --pull=newer --build-arg GIT_SHA=$(GIT_SHA) --build-arg SITE=$(SITE)
QUADLET_DIR ?= $(HOME)/.config/containers/systemd
UNITS = klaverjas.pod klaverjas-web.container klaverjas-server.container
RENDER = sed -e 's|@SITE@|$(SITE)|g' -e 's|@ADDR@|$(ADDR)|g'
GO = scripts/go
JS_TESTS = $(wildcard test/*.test.mjs test/ui/*.test.mjs)
# Polls the health endpoint at $$addr for up to $$tries seconds; exits 1 if it never answers.
WAIT_HEALTH = i=0; until curl -fs -o /dev/null "http://$$addr/api/health"; do i=$$((i + 1)); \
	if [ $$i -ge $$tries ]; then echo "no answer from http://$$addr/api/health" >&2; exit 1; fi; sleep 1; done
# Stops the development server on port $(1), if it is still there.
STOP_DEV = podman stop -t 3 kj-dev-$(1) >/dev/null 2>&1 || true

.PHONY: help test test-all e2e dev dev-stop image image-server image-web quadlet install \
	deploy check status logs uninstall

help:      ## list targets
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:[^#]*## /\t/'

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
e2e:       ## play full games over the websocket against the server from source, at -fast pacing
	@test -f test/e2e/sim.mjs || { echo "test/e2e/sim.mjs not found" >&2; exit 1; }
	scripts/dev-server $(E2E_PORT) -fast
	@trap '$(call STOP_DEV,$(E2E_PORT))' EXIT INT TERM; \
	  addr=127.0.0.1:$(E2E_PORT); tries=180; $(WAIT_HEALTH); \
	  node test/e2e/sim.mjs "http://$$addr"
dev:       ## run the server from source on 127.0.0.1:DEV_PORT and follow its log; Ctrl-C stops it
	scripts/dev-server $(DEV_PORT)
	@trap '$(call STOP_DEV,$(DEV_PORT))' EXIT INT TERM; \
	  addr=127.0.0.1:$(DEV_PORT); tries=180; $(WAIT_HEALTH); \
	  echo "Open http://$$addr/"; podman logs -f kj-dev-$(DEV_PORT)
dev-stop:  ## stop the development server, if `make dev` left it running
	@$(call STOP_DEV,$(DEV_PORT))

# ---- containers, as your own user -----------------------------------------------------
image-server:   ## build the server image (fresh base image), tagged BUILD_TAG; go vet and the short tests run inside the build
	podman build --target server $(BUILD_ARGS) -t localhost/klaverjas-server:$(BUILD_TAG) .
image-web:      ## build the web image, tagged BUILD_TAG: nginx, its configuration for SITE, and web/
	podman build --target web $(BUILD_ARGS) -t localhost/klaverjas-web:$(BUILD_TAG) .
image: image-server image-web   ## build both images; the running pod keeps its :current ones
quadlet:   ## show the three units with your settings filled in
	@for u in $(UNITS); do echo "# ---- $$u"; $(RENDER) deploy/$$u.in; echo; done
install:   ## install the pod and both container units for your user
	install -d $(QUADLET_DIR)
	@for u in $(UNITS); do echo "$(QUADLET_DIR)/$$u"; $(RENDER) deploy/$$u.in > $(QUADLET_DIR)/$$u || exit 1; done
	systemctl --user daemon-reload
	@loginctl show-user "$$USER" -p Linger | grep -q yes || echo "Note: run 'loginctl enable-linger $$USER' so the game starts at boot and survives logout."
# What runs in public is a commit, the one on Forgejo; ALLOW_DIRTY=1 deploys the
# working tree anyway, labelled -dirty. The image builds run in a sub-make, after
# this check, with this make's revision and tag.
deploy:    ## build both images from a committed tree, (re)start the pod, then check it as `make check` does
	@case "$(GIT_SHA)" in *-dirty) [ "$(ALLOW_DIRTY)" = 1 ] || { \
	  echo "make deploy: the working tree has changes that are not committed (git status)." \
	    "Commit them, or deploy anyway with ALLOW_DIRTY=1." >&2; exit 1; };; esac
	@$(MAKE) --no-print-directory image GIT_SHA=$(GIT_SHA) BUILD_TAG=$(BUILD_TAG)
	podman tag localhost/klaverjas-server:$(BUILD_TAG) localhost/klaverjas-server:current
	podman tag localhost/klaverjas-web:$(BUILD_TAG) localhost/klaverjas-web:current
	systemctl --user restart klaverjas-pod.service
	@addr=$(ADDR); tries=30; ($(WAIT_HEALTH)) && scripts/pod-check $(ADDR) $(SITE) || \
	  { echo "see: make status; make logs" >&2; exit 1; }; \
	  echo "klaverjas $(GIT_SHA) is up on http://$(ADDR)/ (images :current and :$(BUILD_TAG))"
check:     ## check the running pod on ADDR without NPM: pages, websocket, security headers
	@scripts/pod-check $(ADDR) $(SITE)
status:    ## state, image revision and health of the pod and both containers
	@for u in klaverjas-pod klaverjas-web klaverjas-server; do \
	  printf '%-17s %s\n' "$$u" "$$(systemctl --user is-active $$u.service)"; done
	@for c in klaverjas-web klaverjas-server; do \
	  printf '%-17s revision %s, %s\n' "$$c" \
	    "$$(podman inspect $$c --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || echo -)" \
	    "$$(podman inspect $$c --format '{{.State.Health.Status}}' 2>/dev/null || echo 'not running')"; done
	@printf '%-17s ' "http://$(ADDR)"; curl -fsS --max-time 5 http://$(ADDR)/api/health || echo "no answer"
logs:      ## follow the logs of both containers
	journalctl --user -u klaverjas-web.service -u klaverjas-server.service -f
uninstall: ## stop the game and remove the units; keeps the images
	-systemctl --user stop klaverjas-pod.service
	rm -f $(addprefix $(QUADLET_DIR)/,$(UNITS))
	systemctl --user daemon-reload
