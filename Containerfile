# The images of every game's pod (games/<game>/<game>.mk), two per game, from one
# build:
#   server-<game>  the game server: the game's static Go binary in an empty image
#   web            nginx serving platform/web and games/<game>/web, and proxying /ws and
#                  /api/ to the server; the build argument GAME says which game
# The server binaries are built only after go vet and the short tests pass; a
# web image only with an nginx configuration that passes `nginx -t`, and only
# when platform/web and games/<game>/web have no path in common.
#   podman build --target server-klaverjas --build-arg GIT_SHA=$(git rev-parse HEAD) \
#                -t localhost/klaverjas-server:test .
#   podman build --target web --build-arg GIT_SHA=$(git rev-parse HEAD) --build-arg GAME=klaverjas \
#                --build-arg SITE=klaverjas.kroes.dev --build-arg TITLE=Klaverjas \
#                --build-arg VERB=klaverjassen -t localhost/klaverjas-web:test .
# (`make image GAME=<game>` builds both with the game's settings, with -dirty after
# the commit when the tree is not that commit, and a tag of its own for each build;
# `make deploy GAME=<game>` then points :current, which the units run, at that build.)

# scripts/go takes its toolchain image from this line, so keep its form:
# FROM <golang image> AS build.
FROM docker.io/library/golang:1.27-alpine AS build
ENV CGO_ENABLED=0 GOFLAGS=-buildvcs=false GOTOOLCHAIN=local
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
# The Go code only, so a change to a site, the docs or a game's settings reruns
# neither the tests nor the build.
COPY cmd/ cmd/
COPY --exclude=**/web --exclude=**/*.md --exclude=**/*.mk platform/ platform/
COPY --exclude=**/web --exclude=**/*.md --exclude=**/*.mk games/ games/
RUN go vet ./... && go test -short ./...
ARG GIT_SHA=dev
# Every game's server, /out/<game> from cmd/<game>.
RUN go build -trimpath -ldflags "-s -w -X main.version=${GIT_SHA}" -o /out/ ./cmd/...

# A server target per game, each with only its own binary: an exec-form
# ENTRYPOINT cannot expand a build argument, and the empty image has no shell
# that could. The binary's name is the game's, as in the unit's HealthCmd.
FROM scratch AS server-klaverjas
ARG GIT_SHA=dev
LABEL org.opencontainers.image.title="klaverjas server" org.opencontainers.image.revision="${GIT_SHA}"
COPY --from=build /out/klaverjas /klaverjas
USER 65532:65532
EXPOSE 8081
ENTRYPOINT ["/klaverjas"]
CMD ["-addr", "127.0.0.1:8081"]

FROM scratch AS server-toepen
ARG GIT_SHA=dev
LABEL org.opencontainers.image.title="toepen server" org.opencontainers.image.revision="${GIT_SHA}"
COPY --from=build /out/toepen /toepen
USER 65532:65532
EXPOSE 8081
ENTRYPOINT ["/toepen"]
CMD ["-addr", "127.0.0.1:8081"]

# The game's files, platform/web and games/GAME/web, checked to have no path in common
# (a file in both would leave the image with whichever was copied last); the
# nginx configuration with the public host name, the game's name and its verb
# filled in, checked here so a broken one never reaches the web image; and
# index.html with the host name, for the link preview's og:image, which must be
# an absolute URL, and with the commit, the version the home page shows.
FROM docker.io/nginxinc/nginx-unprivileged:1.31-alpine AS web-conf
ARG GAME
ARG SITE
ARG TITLE
ARG VERB
ARG GIT_SHA=dev
# Before the COPY below: with an empty GAME, games/${GAME}/web/ names no game.
RUN test -n "$GAME" && test -n "$SITE" && test -n "$TITLE" && test -n "$VERB" || { \
      echo "the web target needs --build-arg GAME, SITE, TITLE and VERB (make image-web GAME=<game>)" >&2; exit 1; } && \
    case "$GAME" in *[!a-z0-9-]*) echo "GAME=$GAME: not a game's name" >&2; exit 1;; esac
COPY platform/web/ /tmp/shared/
COPY games/${GAME}/web/ /tmp/game/
COPY deploy/nginx.conf /tmp/nginx.conf.in
RUN both=$( { (cd /tmp/shared && find . ! -type d; cd /tmp/game && find .) | sort | uniq -d; \
              (cd /tmp/game && find . ! -type d; cd /tmp/shared && find .) | sort | uniq -d; } | sort -u) && \
    { [ -z "$both" ] || { echo "in both platform/web and games/$GAME/web:" $both >&2; exit 1; }; } && \
    sed -e "s|@SITE@|${SITE}|g" -e "s|@TITLE@|${TITLE}|g" -e "s|@VERB@|${VERB}|g" /tmp/nginx.conf.in > /tmp/nginx.conf && \
    ! grep -q '@[A-Z_]*@' /tmp/nginx.conf && nginx -t -q -c /tmp/nginx.conf && \
    sed -e "s|@SITE@|${SITE}|g" -e "s|@VERSION@|${GIT_SHA}|g" /tmp/game/index.html > /tmp/index.html && \
    ! grep -q -e @SITE@ -e @VERSION@ /tmp/index.html

FROM docker.io/nginxinc/nginx-unprivileged:1.31-alpine AS web
ARG GAME
ARG GIT_SHA=dev
LABEL org.opencontainers.image.title="${GAME} web" org.opencontainers.image.revision="${GIT_SHA}"
ENV NGINX_ENTRYPOINT_QUIET_LOGS=1
# The image's own site and server block; deploy/nginx.conf replaces both.
USER root
RUN rm -rf /etc/nginx/conf.d/default.conf /usr/share/nginx/html/*
USER 101
COPY --from=web-conf --chown=0:0 /tmp/nginx.conf /etc/nginx/nginx.conf
# What web-conf checked, so nothing here depends on GAME being set.
COPY --from=web-conf --chown=0:0 /tmp/shared/ /usr/share/nginx/html/
COPY --from=web-conf --chown=0:0 /tmp/game/ /usr/share/nginx/html/
COPY --from=web-conf --chown=0:0 /tmp/index.html /usr/share/nginx/html/index.html
EXPOSE 8080
