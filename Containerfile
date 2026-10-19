# Two images from one build, for the two containers of the klaverjas pod:
#   server  the game server: one static Go binary in an empty image
#   web     nginx serving web/ and proxying /ws and /api/ to the server
# The server binary is built only after go vet and the short tests pass; the
# web image only with an nginx configuration that passes `nginx -t`.
#   podman build --target server --build-arg GIT_SHA=$(git rev-parse HEAD) -t localhost/klaverjas-server:current .
#   podman build --target web --build-arg GIT_SHA=$(git rev-parse HEAD) \
#                --build-arg SITE=klaverjas.kroes.dev -t localhost/klaverjas-web:current .
# (`make image` builds both.)

FROM docker.io/library/golang:1.27-alpine AS build
ENV CGO_ENABLED=0 GOFLAGS=-buildvcs=false GOTOOLCHAIN=local
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go vet ./... && go test -short ./...
ARG GIT_SHA=dev
RUN go build -trimpath -ldflags "-s -w -X main.version=${GIT_SHA}" -o /out/klaverjas ./cmd/klaverjas

FROM scratch AS server
ARG GIT_SHA=dev
LABEL org.opencontainers.image.title="klaverjas server" org.opencontainers.image.revision="${GIT_SHA}"
COPY --from=build /out/klaverjas /klaverjas
USER 65532:65532
EXPOSE 8081
ENTRYPOINT ["/klaverjas"]
CMD ["-addr", "127.0.0.1:8081"]

# The nginx configuration with the public host name filled in, checked here so
# a broken one never reaches the web image.
FROM docker.io/nginxinc/nginx-unprivileged:1.31-alpine AS web-conf
ARG SITE=klaverjas.kroes.dev
COPY deploy/nginx.conf /tmp/nginx.conf.in
RUN sed "s|@SITE@|${SITE}|g" /tmp/nginx.conf.in > /tmp/nginx.conf && nginx -t -q -c /tmp/nginx.conf

FROM docker.io/nginxinc/nginx-unprivileged:1.31-alpine AS web
ARG GIT_SHA=dev
LABEL org.opencontainers.image.title="klaverjas web" org.opencontainers.image.revision="${GIT_SHA}"
ENV NGINX_ENTRYPOINT_QUIET_LOGS=1
# The image's own site and server block; deploy/nginx.conf replaces both.
USER root
RUN rm -rf /etc/nginx/conf.d/default.conf /usr/share/nginx/html/*
USER 101
COPY --from=web-conf --chown=0:0 /tmp/nginx.conf /etc/nginx/nginx.conf
COPY web/ /usr/share/nginx/html/
EXPOSE 8080
