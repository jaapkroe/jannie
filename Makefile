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

GIT_SHA ?= $(shell git rev-parse HEAD 2>/dev/null || echo dev)
BUILD_ARGS = --build-arg GIT_SHA=$(GIT_SHA) --build-arg SITE=$(SITE)
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
	deploy status logs uninstall

help:      ## list targets
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:[^#]*## /\t/'

# ---- development, no images ---------------------------------------------------------
test:      ## go vet, the short Go tests and the JS tests
	$(GO) vet ./...
	$(GO) test -short ./...
ifneq ($(JS_TESTS),)
	node --test $(JS_TESTS)
endif
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
image-server:   ## build the server image; go vet and the short tests run inside the build
	podman build --target server $(BUILD_ARGS) -t localhost/klaverjas-server:$(GIT_SHA) -t localhost/klaverjas-server:current .
image-web:      ## build the web image: nginx, its configuration for SITE, and web/
	podman build --target web $(BUILD_ARGS) -t localhost/klaverjas-web:$(GIT_SHA) -t localhost/klaverjas-web:current .
image: image-server image-web   ## build both images
quadlet:   ## show the three units with your settings filled in
	@for u in $(UNITS); do echo "# ---- $$u"; $(RENDER) deploy/$$u.in; echo; done
install:   ## install the pod and both container units for your user
	install -d $(QUADLET_DIR)
	@for u in $(UNITS); do echo "$(QUADLET_DIR)/$$u"; $(RENDER) deploy/$$u.in > $(QUADLET_DIR)/$$u || exit 1; done
	systemctl --user daemon-reload
	@loginctl show-user "$$USER" -p Linger | grep -q yes || echo "Note: run 'loginctl enable-linger $$USER' so the game starts at boot and survives logout."
deploy: image   ## build both images, (re)start the pod, then check that the game answers
	systemctl --user restart klaverjas-pod.service
	@addr=$(ADDR); tries=30; ($(WAIT_HEALTH)) || { echo "see: make status; make logs" >&2; exit 1; }; \
	  echo "klaverjas $(GIT_SHA) is up on http://$(ADDR)/"
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
