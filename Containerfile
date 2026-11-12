# The images of every game's pod, two per game, from one build. A game is a folder,
# games/<game>/ or extra/<game>/ (the overlay), with its settings in <game>.mk:
#   server  the game server: the game's static Go binary in an empty image; the
#           build argument GAME says which game
#   web     nginx serving platform/web and the game's web/, and proxying /ws and
#           /api/ to the server; the build arguments GAME and GAME_DIR, its folder,
#           say which game
# The server binaries are built only after go vet and the short tests pass; a
# web image only with an nginx configuration that passes `nginx -t`, and only
# when platform/web and the game's web/ have no path in common. The build copies
# extra/, which podman refuses when it is missing: without the overlay, run
# `mkdir -p extra` first.
#   podman build --target server --build-arg GIT_SHA=$(git rev-parse HEAD) --build-arg GAME=klaverjas \
#                -t localhost/klaverjas-server:test .
#   podman build --target web --build-arg GIT_SHA=$(git rev-parse HEAD) --build-arg GAME=klaverjas \
#                --build-arg GAME_DIR=games/klaverjas --build-arg SITE=klaverjas.kroes.dev \
#                --build-arg TITLE=Klaverjas --build-arg VERB=klaverjassen -t localhost/klaverjas-web:test .
# The web target also takes SUPPORT_URL, the deployment's payment link behind
# the home page's support button; without it there is no button.
# (`make image GAME=<game>` builds both with the game's settings, with -dirty after
# the commit when the tree is not that commit (for a game of extra/, the overlay's
# commit after a dot; docs/deployment.md#make-targets), and a tag of its own for each build;
# `make deploy GAME=<game>` then points :current, which the units run, at that build.)

# scripts/go takes its toolchain image from this line, so keep its form:
# FROM <golang image> AS build.
FROM docker.io/library/golang:1.27-alpine AS build
ENV CGO_ENABLED=0 GOFLAGS=-buildvcs=false GOTOOLCHAIN=local
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
# The Go code only, so a change to a site, the docs, a game's settings or its JS
# tests reruns neither the tests nor the build; and no git directory of the overlay.
COPY cmd/ cmd/
COPY --exclude=**/web --exclude=**/*.md --exclude=**/*.mk platform/ platform/
COPY --exclude=**/web --exclude=**/*.md --exclude=**/*.mk --exclude=**/*.mjs games/ games/
COPY --exclude=**/web --exclude=**/*.md --exclude=**/*.mk --exclude=**/*.mjs --exclude=**/.git extra/ extra/
# Go's build cache is a cache mount, which podman keeps on the host between
# builds and outside the image. A change so compiles and tests the packages it
# reaches and no others: go test prints "(cached)" for a package whose code and
# flags are those of a run that passed.
RUN --mount=type=cache,id=jannie-go-build,target=/root/.cache/go-build \
    go vet ./... && go test -short ./...
ARG GIT_SHA=dev
# Every game's server, /out/<game>/<game> from its main package, cmd/<game> or
# <folder>/cmd/<game> (not any other command of a folder), with /out/<game>/server,
# a link to it, for the ENTRYPOINT.
RUN --mount=type=cache,id=jannie-go-build,target=/root/.cache/go-build \
    mains=$(for m in cmd/*; do [ ! -d "$m" ] || echo "./$m"; done; \
      for d in games/* extra/*; do [ ! -d "$d/cmd/${d##*/}" ] || echo "./$d/cmd/${d##*/}"; done) && \
    twice=$(for m in $mains; do echo "${m##*/}"; done | sort | uniq -d) && \
    { [ -z "$twice" ] || { echo "two servers named" $twice >&2; exit 1; }; } && \
    go build -trimpath -ldflags "-s -w -X main.version=${GIT_SHA}" -o /out/.bin/ $mains && \
    for b in /out/.bin/*; do g=${b##*/}; mkdir "/out/$g" && mv "$b" "/out/$g/$g" && ln -s "$g" "/out/$g/server"; done && \
    rmdir /out/.bin
# The server target takes one of them: GAME must name one (an empty GAME would
# copy them all).
ARG GAME
RUN case "$GAME" in '' | *[!a-z0-9-]*) false;; esac && [ -x "/out/$GAME/$GAME" ] || { \
      echo "GAME=$GAME: no server of that name (the server target needs --build-arg GAME=<game>)" >&2; exit 1; }

# The game's server alone, /<game>, and /server, the link to it that the
# ENTRYPOINT runs: an exec-form ENTRYPOINT cannot expand a build argument, and the
# empty image has no shell that could. The binary's name is the game's, as in the
# unit's HealthCmd.
FROM scratch AS server
ARG GAME
ARG GIT_SHA=dev
LABEL org.opencontainers.image.title="${GAME} server" org.opencontainers.image.revision="${GIT_SHA}"
COPY --from=build /out/${GAME}/ /
USER 65532:65532
EXPOSE 8081
ENTRYPOINT ["/server"]
CMD ["-addr", "127.0.0.1:8081"]

# The game's files, platform/web and GAME_DIR/web, checked to have no path in common
# (a file in both would leave the image with whichever was copied last); the
# nginx configuration with the public host name, the game's name and its verb
# filled in, checked here so a broken one never reaches the web image; and
# index.html with the host name, for the link preview's og:image, which must be
# an absolute URL, with the commit, the version the home page shows, and with
# the payment link, empty without one.
FROM docker.io/nginxinc/nginx-unprivileged:1.31-alpine AS web-conf
ARG GAME
ARG GAME_DIR
ARG SITE
ARG TITLE
ARG VERB
ARG GIT_SHA=dev
ARG SUPPORT_URL=
# Before the COPY below: GAME_DIR is the game's folder, games/GAME or extra/GAME.
# The payment link goes into an HTML attribute as it is: an https URL with
# no quote, space, < or >.
RUN test -n "$GAME" && test -n "$GAME_DIR" && test -n "$SITE" && test -n "$TITLE" && test -n "$VERB" || { \
      echo "the web target needs --build-arg GAME, GAME_DIR, SITE, TITLE and VERB (make image-web GAME=<game>)" >&2; exit 1; } && \
    case "$GAME" in *[!a-z0-9-]*) echo "GAME=$GAME: not a game's name" >&2; exit 1;; esac && \
    case "$GAME_DIR" in "games/$GAME" | "extra/$GAME") ;; *) \
      echo "GAME_DIR=$GAME_DIR: not the folder of GAME=$GAME, games/$GAME or extra/$GAME" >&2; exit 1;; esac && \
    case "$SUPPORT_URL" in '' | https://?*) ;; *) false;; esac && \
    case "$SUPPORT_URL" in *[\"\'\<\>[:space:]]*) false;; esac || { \
      echo "SUPPORT_URL=$SUPPORT_URL: not an https URL without quotes, spaces, < or >" >&2; exit 1; }
COPY platform/web/ /tmp/shared/
COPY ${GAME_DIR}/web/ /tmp/game/
COPY deploy/nginx.conf /tmp/nginx.conf.in
# ASSETS is the hash of the site's stylesheets and scripts, names and
# contents, and of nginx's configuration, which says how they are sent. The
# page links them under /v/ASSETS/, where nginx lets a browser keep them for
# good: a build with the same files gives the same paths, one with a changed
# file new ones (deploy/nginx.conf).
RUN both=$( { (cd /tmp/shared && find . ! -type d; cd /tmp/game && find .) | sort | uniq -d; \
              (cd /tmp/game && find . ! -type d; cd /tmp/shared && find .) | sort | uniq -d; } | sort -u) && \
    { [ -z "$both" ] || { echo "in both platform/web and $GAME_DIR/web:" $both >&2; exit 1; }; } && \
    (cd /tmp && find shared game nginx.conf.in -type f \
       \( -path '*/css/*' -o -path '*/js/*' -o -name nginx.conf.in \) -exec sha256sum {} + > sums) && \
    grep -q ' shared/js/main.js$' /tmp/sums && grep -q ' nginx.conf.in$' /tmp/sums && \
    assets=$(sort /tmp/sums | sha256sum | cut -c 1-16) && [ ${#assets} -eq 16 ] && \
    sed -e "s|@SITE@|${SITE}|g" -e "s|@TITLE@|${TITLE}|g" -e "s|@VERB@|${VERB}|g" -e "s|@ASSETS@|${assets}|g" \
      /tmp/nginx.conf.in > /tmp/nginx.conf && \
    ! grep -q '@[A-Z_]*@' /tmp/nginx.conf && nginx -t -q -c /tmp/nginx.conf && \
    support=$(printf '%s\n' "$SUPPORT_URL" | sed -e 's/&/\&amp;/g' -e 's/[\\|&]/\\&/g') && \
    sed -e "s|@SITE@|${SITE}|g" -e "s|@VERSION@|${GIT_SHA}|g" -e "s|@SUPPORT_URL@|${support}|g" \
        -e "s|=\"/css/|=\"/v/${assets}/css/|g" -e "s|=\"/js/|=\"/v/${assets}/js/|g" \
      /tmp/game/index.html > /tmp/index.html && \
    ! grep -q -e @SITE@ -e @VERSION@ -e @SUPPORT_URL@ /tmp/index.html && \
    grep -q "src=\"/v/${assets}/js/main.js\"" /tmp/index.html

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
