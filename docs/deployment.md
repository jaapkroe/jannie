# Deployment

Every game runs as a rootless podman pod of its own, on any Linux host with
podman and its quadlets (systemd units for containers), behind any reverse
proxy that terminates TLS. One address, one entry point and one pod per
game: each pod has two containers that share its network namespace, and
nothing of one game is in another's site. The reverse proxy forwards each
game's name to its pod over plain HTTP on loopback:

```
internet ──443──> reverse proxy ──http──> 127.0.0.1:8093 ┌ pod klaverjas ────────────────────────────────┐
                   (TLS)                                  │ klaverjas-web     nginx :8080                 │
                    │                                     │   /, /ABCD, files  from the image             │
                    │                                     │   /ws, /api/  ───> klaverjas-server :8081     │
                    │                                     └───────────────────────────────────────────────┘
                    └───────http──> 127.0.0.1:8095  pod toepen: toepen-web, toepen-server, the same
```

## The games

A game is a file `games/<game>/<game>.mk` with its settings; the `Makefile`
reads the games from those files. Each game's settings, and in the last two
rows the names that follow from the game's own name:

| | klaverjas | toepen | Used for |
|---|---|---|---|
| `TITLE` | `Klaverjas` | `Toepen` | The unit descriptions and the 404 page's title; `make check` expects it as the page's `<title>` and the manifest's name |
| `VERB` | `klaverjassen` | `toepen` | The 404 page's way back, "Terug naar …" |
| `SITE` | `klaverjas.kroes.dev` | `toepen.kroes.dev` | The CSP's one `wss://` source and the link preview's `og:image` (both built into the web image), and the unit descriptions |
| `ADDR` | `127.0.0.1:8093` | `127.0.0.1:8095` | Where the pod publishes nginx; the reverse proxy forwards here |
| `DEV_PORT`, `E2E_PORT` | `18093`, `18094` | `18095`, `18096` | `make dev` and `make e2e`, clear of the installed pods |
| `E2E_SIM` | `test/e2e/sim.mjs` | `test/e2e/toepen.mjs` | What `make e2e` plays |
| Game log volume | `klaverjas-games` | `toepen-games` | "The game log" below |
| Binary | `cmd/klaverjas` | `cmd/toepen` | The game server, `/<game>` in its image |

These are the live sites. A deployment of your own changes `SITE` (and
`ADDR` if the port is taken) in those files, and commits that on a branch
of its own, because `make deploy` builds a committed tree only ("Day to
day" below). `scripts/deploy-test`, in `make test`, pins klaverjas's
settings to the values above, so that they cannot change by accident: such
a branch puts its own values in those pins as well, or `make test` fails.
The other way leaves the tree, and `make test`, as they are: give the
settings on make's command line, with `GAME`, to every make command of that
game (`make install`, `make deploy`, `make check`, …).

## Names

Everything else is named after the game, `G` below:

| What | Name |
|---|---|
| Pod and its units | pod `G`; `G.pod`, `G-web.container`, `G-server.container` in `~/.config/containers/systemd/`; services `G-pod`, `G-web`, `G-server` |
| `G-web` | `localhost/G-web:current`, nginx-unprivileged: serves the game's files (`platform/web` and `games/G/web`), proxies `/ws` and `/api/`, sets the security headers |
| `G-server` | `localhost/G-server:current`, `FROM scratch`: the game server `/G` (its health check `["/G", "-healthcheck"]`), on `127.0.0.1:8081` inside the pod only |
| Game log | the volume `G-games`, never shared with another game |

For klaverjas these are the names from before there were more games, and
its rendered units are byte for byte the same.

All images are built on the host from the checkout; nothing is pulled at
start (`Pull=never`). There is no secret and no database: games live in the
server's memory, so **every restart of a pod ends every game in progress in
it** (and only there). The one volume of each pod holds its game log
("The game log" below).

## Settings

A game's settings in `games/<game>/<game>.mk` are `TITLE` to `E2E_SIM` in
the table of "The games" above, which says what each is for.

The port rule: `ADDR`'s port is an odd `P`, `DEV_PORT` is `10000+P` and
`E2E_PORT` `10001+P`, so no two games ever share a port.
`scripts/deploy-test` (in `make test`) checks it, that every `ADDR` is on
loopback, and that no two games share a host name or a port.

The settings are plain `=`: a `SITE` in the shell's environment changes
nothing; one on make's command line does, for the one game named (`make
quadlet GAME=toepen ADDR=127.0.0.1:9001`). `make install GAME=<game>` writes
them into the game's three units; `make quadlet GAME=<game>` shows the
result. A change to `SITE`, `TITLE` or `VERB` needs `make deploy
GAME=<game>` as well, because they are part of the web image.

### SUPPORT_URL

One setting is the deployment's rather than a game's: `SUPPORT_URL`, the
payment link behind *Support deze app* on the home page of every game
([frontend.md, "Home"](frontend.md#home)). It goes in `local.mk` next to
the `Makefile`; git ignores that file, so the tree stays the commit:

```make
SUPPORT_URL = https://…
```

or on make's command line; one in the shell's environment is ignored, as
`GAME` is. It must be a single `https://` URL without quotes, spaces, `<`
or `>`: the `Makefile` stops at anything else, before it builds. It is part
of every web image, so a change needs `make deploy GAME=all`. Without it
the sites have no support button, and neither has a server run from source.

### GAME

Every command that acts on a pod takes `GAME=`, a game or `all`, on make's
command line (a `GAME` left in the shell's environment is ignored, so it
never picks what is deployed; an unknown one is an error that lists the
games):

| Commands | Without `GAME` |
|---|---|
| `install`, `deploy`, `uninstall`, `dev`, `image`, `image-server`, `image-web` | refuse (exit 2, nothing run), and list the games |
| `status`, `check`, `logs`, `quadlet`, `e2e`, `dev-stop` | every game |
| `help`, `test`, `test-all` | do not take it |

`GAME=all` goes through the games one after another, in the order of their
names, all under one build tag, and stops at the first game that fails:
`make deploy GAME=all` deploys klaverjas, checks it, and only then builds
toepen (`make -n deploy GAME=all` shows the plan). A setting on the command
line without one `GAME` is refused.

## Images

The `Containerfile`'s stages:

- `build` (the official golang Alpine image): copies `cmd/` and the Go code
  of `platform/` and `games/` (no `web/`, `*.md` or `*.mk`, so a change to a
  site, the docs or a game's settings reruns neither the tests nor the
  build, and a Go test reads no file outside the Go code); runs `go vet` and
  `go test -short ./...`, then builds every `cmd/<game>` statically to
  `/out/<game>` with `-trimpath -ldflags "-s -w -X main.version=$GIT_SHA"`.
- `server-<game>`, one per game (`FROM scratch`, its binary only, `USER
  65532:65532`): an exec-form `ENTRYPOINT` cannot expand a build argument,
  and the empty image has no shell that could, so each game has a target of
  its own.
- `web-conf` and `web` (`nginxinc/nginx-unprivileged`, Alpine), with `ARG
  GAME`, `SITE`, `TITLE`, `VERB` and `SUPPORT_URL` (empty by default):
  `web-conf` refuses an empty or odd `GAME`, a `SUPPORT_URL` that is not an
  `https://` URL without quotes, spaces, `<` or `>`, and any path in both
  `platform/web` and `games/G/web`; renders `@SITE@`, `@TITLE@` and
  `@VERB@` into `nginx.conf` (checked with `nginx -t`) and `@SITE@`,
  `@VERSION@` and `@SUPPORT_URL@` into the game's `index.html` (`og:image`,
  the version, and `<meta name="support">`, empty without a link); `web`
  copies the union of the two trees and that `index.html`.

The base tags (minor versions) live only in the `Containerfile`;
`scripts/go` and `scripts/dev-server` read the build image from its `FROM …
AS build` line, and `make image` builds with `--pull=newer`, so a fix
re-published under the same tag reaches the next deploy.

## nginx

`deploy/nginx.conf`, the web container's configuration: listen 8080; `/ws`
→ `http://127.0.0.1:8081` with Upgrade headers and a long read timeout;
`/api/score` (the score sheets of a game that has them) the same; `/api/` →
the same server; `location ~ "^/[A-Za-z]{4}$"` → `/index.html`; the 404
page names the game (`Niet gevonden - @TITLE@`, `Terug naar @VERB@`);
security headers in one place (CSP `default-src 'self';
connect-src 'self' wss://@SITE@; img-src 'self' data:; style-src 'self';
script-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self';
object-src 'none'; form-action 'none'`, so a site's page reaches its own
server only, nosniff, Referrer-Policy,
Permissions-Policy (camera and microphone for the page itself, for the
call; geolocation, payment and USB for nobody), COOP, HSTS
`max-age=31536000; includeSubDomains`), each sent
once on every path (`scripts/pod-check`); `Cache-Control: no-cache` for
html, js, css, json and the manifest (ETag revalidation) so a deploy is
picked up at once, a day for images, but never for a 404, which is
`text/html` whatever the path's extension; gzip; `X-Real-IP` forwarding:
the reverse proxy's `X-Real-IP` is trusted from `127.0.0.1` only and passed
on as the one client address (`X-Forwarded-For` is dropped); `Host` is
passed unchanged (`$http_host`), which the websocket Origin check compares
against. nginx runs as uid 101 on a read-only root, writing only to its
tmpfs mounts, and logs errors only: the reverse proxy logs the requests.

## Pods and units

The quadlets are rendered by `make install GAME=G` into
`~/.config/containers/systemd/` from `deploy/game*.in` (`@GAME@`,
`@TITLE@`, `@SITE@`, `@ADDR@`):

- `G.pod`: `PublishPort=ADDR:8080`, the only published port;
  `Network=pasta:--host-lo-to-ns-lo`, so the reverse proxy's connections
  to the host's loopback arrive from `127.0.0.1` in the pod instead of from
  the host's LAN address, and nginx can trust exactly that hop's
  `X-Real-IP`; `ExitPolicy=continue`, so both containers dying at once does
  not stop the pod for good.
- `G-web.container` and `G-server.container`: `Pod=G.pod`, `Pull=never`,
  `ReadOnly`, `NoNewPrivileges`, `DropCapability=ALL`, a health check every
  60 s (three failures kill the container, and `Restart=on-failure` brings
  it back); nginx gets tmpfs for `/tmp` and `/var/cache/nginx`. The server's
  unit mounts the named volume `G-games` at `/data`, owned by the server's
  user (`:U`), and runs `-addr 127.0.0.1:8081 -games /data`: the game log,
  which `make uninstall` keeps.

Every unit is `WantedBy=default.target`: with lingering enabled for your
user, the pods start at boot.

## Make targets

`help test test-all e2e dev dev-stop image image-server image-web install
deploy check status logs uninstall quadlet` (`make help` lists them; `GAME`
as above). The revision (`GIT_SHA`, the image label and `/api/health`'s
version) is `HEAD`, with `-dirty` when `git status` lists anything; each
build tags both images `<GIT_SHA>-YYYYmmdd-HHMMSS`, and only `make deploy`
then moves `:current` (what the units run) to it, so `make image` alone
never changes what a restart starts. `make deploy` refuses a dirty tree
unless `ALLOW_DIRTY=1`, and ends with `make check`.

## Reverse proxy

Each game needs a host in your reverse proxy: `SITE` → `http://ADDR`
(`http://127.0.0.1:8093` for klaverjas), public, with no access list,
because players join from wherever they are with a code or a link. The pod
expects the proxy to:

- **Terminate TLS** for `SITE`, on the same host as the pod, and forward
  plain HTTP to `ADDR` on loopback. The pod's nginx trusts `X-Real-IP` only
  from the loopback hop; a proxy elsewhere makes every player one address,
  which soon hits the per-address limits.
- **Redirect plain HTTP** to HTTPS. The pod's HSTS works only once a
  browser has been on HTTPS, so a first visit by `http://` depends on the
  proxy.
- **Set `X-Real-IP`** to the client's address, and pass `Host` unchanged:
  the websocket's Origin check compares the page's `Origin` with it.
- **Pass websockets** on `/ws` (the game) and on `/api/` (`/api/score`, the
  score sheets): the `Upgrade` and `Connection` headers through, over HTTP/1.1.
  Without that the page loads and never connects. Idle timeouts of 60 s or
  more are fine: the page pings every 20 s, and the server pings a
  connection quiet for 25 s.
- **Pass `/api/` through** unchanged: `/api/health` and the score sheets.
- **Not cache**: the pod sets `Cache-Control` itself (no-cache with ETag
  for html, js, css and the manifest, a day for images, never a 404); a
  cache in the proxy would hide a deploy.
- **Not add security headers**: they come from the pod, HSTS included, and
  the proxy passes them through. With HSTS switched on in the proxy too,
  browsers get it twice.
- **Allow the request rate of a page load**: a page load is at most 17
  requests (`index.html` and what it links, all within a second or two),
  and the websocket counts once, however long the game lasts
  ([frontend.md, "Request budget"](frontend.md#request-budget)). A
  per-address rate limit must let that burst through, and more where
  players share an address (a reload, a second player at home, a club on
  one wifi); a limit tuned for ordinary web pages refuses part of the load
  with `429`, and the page never starts.
- **Let link previewers through**, if the preview matters: WhatsApp builds
  it on the sender's phone, but iMessage's previewer calls itself
  `facebookexternalhit`, and Telegram, Slack and Discord fetch from
  datacenter addresses. A bot filter or firewall that refuses them leaves
  the bare link.

HTTP/2 on the proxy may be on or off; the websocket upgrade is HTTP/1.1
either way. Nothing is uploaded, and no websocket message is larger than
16 KiB.

With nginx as the reverse proxy, for example (certificates as you manage
them):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}
server {
    listen 80;
    server_name klaverjas.example.org;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name klaverjas.example.org;
    ssl_certificate     /etc/ssl/klaverjas.example.org/fullchain.pem;
    ssl_certificate_key /etc/ssl/klaverjas.example.org/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8093;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}
```

## Installing

As a user with lingering enabled (`loginctl show-user $USER -p Linger` says
`Linger=yes`; `make install` reminds you of `loginctl enable-linger $USER`
otherwise), from a checkout of the repository:

```sh
make test                 # optional: go vet, Go and JS tests from source, and the deployment files
make install GAME=all     # every game's units, for your user
make deploy GAME=all      # every game's images and pod, one after another
```

`make test` expects klaverjas's settings to be the live site's; with
settings of your own in the files, put them in its pins as well ("The
games" above).

Then a host per game in the reverse proxy (above), and the checks (below).
Until the pod runs, the proxy answers `502 Bad Gateway`. Check that a pod
comes back from a restart: `systemctl --user restart toepen-pod`, then
`make status GAME=toepen` shows both containers `healthy`.

## Checks

### The pod, without the reverse proxy

```sh
make check                  # every game's pod; `make deploy GAME=<game>` runs it for its game
make check GAME=toepen      # one game: scripts/pod-check 127.0.0.1:8095 toepen.kroes.dev Toepen
```

It checks a pod on its `ADDR` from the host, and prints only what fails:
`/api/health` through nginx, the page and its title, a join link (`/KQXB`,
the same page), a 404 (an HTML page with the game's name, also for a missing
image, and not cached), the link preview (`og:image` is
`https://SITE/og.png`, and that image and the apple-touch-icon are there as
`image/png`), the manifest's name, the version in the page (the server's),
the websocket upgrade with the page's own `Origin` (`101`) and with another
site's (`403`), that the CSP allows the websocket of `SITE` and of no other
site, and the security headers, HSTS included, each sent exactly once on
every kind of path. `scripts/pod-check ADDR SITE TITLE` checks a pod
elsewhere. The websocket upgrade by hand:

```sh
curl -si --max-time 2 http://127.0.0.1:8093/ws -H 'Origin: http://127.0.0.1:8093' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' | head -1                       # HTTP/1.1 101 Switching Protocols
```

The websocket check needs the `Origin` header: the server refuses an origin
that does not match the host, which is what keeps other sites, the other
games' included, from opening a game connection in a visitor's browser. A
`403` for the page's own origin means the `Host` header did not reach the
server unchanged.

### Through the reverse proxy

With `--resolve`, so the request carries the right SNI; `PROXY` is the
proxy's address, and for toepen put `toepen.kroes.dev` for `SITE`:

```sh
SITE=klaverjas.kroes.dev PROXY=192.0.2.10
curl -s -o /dev/null -w '%{http_code}\n' --resolve $SITE:443:$PROXY https://$SITE/   # 200
curl -sI --resolve $SITE:443:$PROXY https://$SITE/ | grep -ci '^strict-transport-security'   # 1
curl -si --http1.1 --max-time 2 --resolve $SITE:443:$PROXY https://$SITE/ws \
  -H "Origin: https://$SITE" -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' | head -1   # HTTP/1.1 101 Switching Protocols
```

`502` means the pod is not running. The websocket line tells the two causes
of a page that loads and never connects apart: `426 Upgrade Required` comes
from the game server when the proxy did not pass the upgrade on; `502`
means the pod or its server is down. `curl -sI` shows `HTTP/1.1` or
`HTTP/2` depending on the proxy, and either is fine; a websocket upgrade is
HTTP/1.1 either way, hence `--http1.1`. A bot filter in the proxy may turn
curl's user agent away.

### From outside

After a game's first deploy, and after a change to its proxy host or to its
rate limit, check that game from a network outside your own, such as a
phone on mobile data with Wi-Fi off, in case the proxy treats your own
addresses differently:

- `https://SITE/` loads with its styles and the game's own name and look, and **Snel spelen** starts a game, which means the page reached the server over `wss://`.
- **Nieuw spel** gives a code and a link; the link, opened on a second device, joins that table.
- Reload twice within a few seconds: the page starts every time. A rate limit too tight for the page budget gets the second load `429`.
- Send yourself a join link in WhatsApp: the preview shows the game's own `og.png`.

One full game through the proxy, TLS and `wss://`, from any machine with
Node 22 or later and the checkout, with the game's simulation (`E2E_SIM`;
[test/e2e/README.md](../test/e2e/README.md) has the options):

```sh
node test/e2e/sim.mjs --url wss://klaverjas.kroes.dev/ws --humans 2 --hands 16 --tempo snel
node test/e2e/toepen.mjs --url wss://toepen.kroes.dev/ws
```

Through the proxy all simulated players come from one address, and share the
server's per-address limits (150 connections).

## Day to day

| Task | Command |
|---|---|
| State, image revision and health | `make status` (every game), `make status GAME=toepen` |
| Logs of both containers | `make logs GAME=toepen`; `make logs` follows every game's |
| Update a game after merging changes | `git pull && make deploy GAME=toepen` (ends its games in progress) |
| Update every game | `git pull && make deploy GAME=all` (ends every game in progress, pod after pod) |
| A fix in a base image (a vulnerability scanner's finding on a game's images) | `make deploy GAME=<game>` (it rebuilds on the newest base image of the same tag); `GAME=all` for a base image every game has |
| Restart | `systemctl --user restart toepen-pod` (also ends its games) |
| Changed a game's settings | `make install GAME=toepen && make deploy GAME=toepen` |
| Stop a game and remove its units; keeps its images and game log | `make uninstall GAME=toepen` |

`make deploy` builds a committed tree only, and says so when `git status`
lists anything, untracked files included, because the build copies the
working tree. `make deploy GAME=<game> ALLOW_DIRTY=1` deploys it anyway,
with `-dirty` after the commit in the revision that `make status` and
`/api/health` show.

One game's commands touch only that game: `make deploy GAME=toepen` builds,
tags and restarts `toepen-*` alone, and klaverjas plays on.

## Going back

Each build tags both of a game's images with a tag of its own, the revision
and the time (`<commit>-20261020-213000`), so every earlier build is still
there to go back to, a rebuild of the same commit included; a `GAME=all`
build gives every game the same tag. Only `make deploy` then points
`:current`, the tag the units run, at the new build: a `make image
GAME=<game>` on its own, to try a build, never changes what the pod starts
after a restart or a failed health check. `make deploy` ends by naming the
tag. To take one game back, here toepen:

```sh
podman images 'localhost/toepen-*'                                          # the builds
podman tag localhost/toepen-server:<tag> localhost/toepen-server:current
podman tag localhost/toepen-web:<tag> localhost/toepen-web:current
systemctl --user restart toepen-pod
```

The same with `klaverjas` for klaverjas; the other games are not affected.
Old builds pile up; `podman rmi` removes them.

## Updating

Deploy when nobody is playing if you can: the restart takes seconds, but the
rooms of that game are gone afterwards. On shutdown the server tells
connected players it is restarting; their pages reconnect and find their
room no longer exists.

The `Containerfile` names its base images by minor version, without a
digest (see its `FROM` lines). Security fixes in Go, nginx or Alpine are
published again under those same tags, and every `make deploy` builds with
`--pull=newer`, so it picks them up: rebuilding is the response to a
vulnerability found in any game's image. A move to the next minor version is
a change to the `Containerfile` (a dependency update), for every game at
once. `scripts/go` and `scripts/dev-server` read the build image from the
`Containerfile`, so they follow such a change.

Static files are sent with `Cache-Control: no-cache` and revalidated by
ETag, so browsers pick up a new frontend at the next page load; images are
cached for a day (a 404 is never cached, so an image added by a deploy shows
up at once).

## Logs

`make logs GAME=<game>` follows both containers of a game in the journal,
`make logs` every game's. nginx logs errors only: the reverse proxy logs
the requests at the edge. The server logs to the journal with `log/slog`;
it never logs chat text or seat tokens.

```sh
journalctl --user -u toepen-server -n 100          # recent server log of one game
podman inspect toepen-server --format '{{.State.Health.Status}}'
```

A failing health check (three in a row, a minute apart) kills the container
and systemd restarts it; that also ends the games in that pod.

## Security model

The proxy hosts are public with no access list, because players join from
wherever they are with a code or a link. What that exposes:

- **No accounts and no persistence.** There is nothing to log in to and
  nothing stored but the game log: names, chat and games exist in memory
  only, until the room is removed or the server restarts. A room with
  nobody connected goes after 5 minutes in its lobby, after the game or
  once every player has left, and after 30 minutes while a game is in
  progress; a finished game goes 30 minutes after it ended. A seat token in
  the player's browser only returns them to their own seat.
- **One pod per game.** The games share nothing at run time: each has its
  own containers, address, volume and origin, a page of one game cannot open
  the websocket of another (the server's Origin check), and its CSP names
  its own `wss://` only.
- **Small, contained processes.** nginx runs as uid 101 and the server as
  65532; rootless podman maps both to subordinate UIDs, not to the user's
  own. Both containers have a read-only root, no capabilities, no new
  privileges and no secret, and only the server has a volume, its game
  log; the server image holds nothing but its binary, so there is no shell.
  Only nginx is published, and only on loopback.
- **Limits in each server** ([server.md, "Limits"](server.md#limits)):
  websocket messages of at most 16 KiB (a call's session description takes
  several) and 20 per second, at most one `join` a second per connection
  (bursts of three), chat lines of at most 200 characters at one a second
  (bursts of five), call messages (joining, switching, session
  descriptions) at two a second (bursts of ten). Per client address, where
  a whole club on one wifi shares the limits: at most 60 new rooms per 10
  minutes, 60 live rooms and 150 connections; after 200 failed joins within
  a minute (an unknown code, a full or started table), joins from that
  address are refused for 5 minutes, except a return to one's own seat with
  its token, so guessing room codes stays slow. At most 1500 rooms; when
  full, a new game replaces the room that has had nobody connected for
  longest. The limits are per game: each server counts its own. The client
  address comes from the reverse proxy's `X-Real-IP`, which nginx accepts
  only from the loopback hop.
- **The reverse proxy's filters and rate limits** apply as to any public
  name. What a game brings to them: a page load is at most 17 requests
  (`index.html` and what it links), and the websocket counts once, however
  long the game lasts.

## The game log

Each game's server appends a compact record of every game to its own
volume, `G-games` (`klaverjas-games`, `toepen-games`), mounted at `/data`:
one JSON line per event in `games-YYYY-MM.jsonl` per month (UTC). The
records are in [server.md, "Game log"](server.md#game-log). It holds:

- who played: per player the name, IP address and browser (User-Agent);
- the cards dealt and every move;
- the results (for klaverjas also the Spelanalyse, the review of each
  player's decisions);
- the players' feedback (in klaverjas's expert mode and training also
  about one of their own decisions).

toepen's volume also holds the score sheets of games at a real table
([games/toepen/README.md, "Score bijhouden"](../games/toepen/README.md#score-bijhouden))
in `scores/<CODE>.json`: the names a host typed in and the rounds, removed
seven days after their last change. The prune of the game log leaves that
directory alone.

It is used for statistics and to improve the games (looking at games again,
tuning the engines). It grows by a few kB per game and is kept for **at most
12 months**: each server removes the month files older than the current
month and the eleven before it, when it starts and every hour, and says so
in its log (`game log: removed an old month`).

```sh
dir=$(podman volume inspect toepen-games --format '{{.Mountpoint}}')
ls -l "$dir"
tail -n 3 "$dir/games-$(date -u +%Y-%m).jsonl" | jq .
grep '"t":"feedback"' "$dir"/games-*.jsonl | jq -r '.name + ": " + .text'
```

The files are written by the server's user, mapped to a subordinate UID.
They are readable by the user who runs the pod (mode 644); to remove or
change them, use `podman unshare rm …`. The log holds personal data (names,
IP addresses), so keep every game's volume out of backups you do not
control, and out of any backup kept longer than 12 months. To delete a
month earlier than that:

```sh
podman unshare rm "$dir/games-2026-10.jsonl"
```

`make uninstall GAME=<game>` keeps the volume; `podman volume rm
<game>-games` (with that pod stopped) removes it with every log of that
game.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The proxy shows `502 Bad Gateway` | The game's pod is not running: `make status GAME=<game>`, `systemctl --user status <game>-pod` |
| The page loads, but it never connects | The proxy does not pass websockets on (the websocket check through the proxy answers `426`), or the server container is down (`/api/health` through nginx answers `502`) |
| `/ws` answers `403` | The `Origin` does not match the host: something rewrote `Host` between the browser and the server |
| One game's site shows another game | The proxy host forwards to the other game's port: compare it with `ADDR` in `games/<game>/<game>.mk` |
| Everyone shares one address and hits the room limit | The proxy's connections no longer arrive from `127.0.0.1` in the pod: the proxy is on another host, `ADDR` is not loopback, or `Network=pasta:--host-lo-to-ns-lo` is missing from the pod unit |
| Old scripts or styles after a deploy | The proxy caches assets |
| The page stays on its loading dots, or loads without styles | The proxy refused part of the load with `429`, its rate limit: many players behind one address loaded at the same moment. A reload a few seconds later works. If it happens to one player alone, the limit for the name is too tight for the page budget ("Reverse proxy" above) |
| `make deploy` stops with "which game?" | Add `GAME=<game>`, or `GAME=all` |
| `make deploy` stops with "changes that are not committed" | `git status` lists something: commit it, or deploy anyway with `ALLOW_DIRTY=1` |
| No *Support deze app* on the home page | No `SUPPORT_URL` in `local.mk` when the web image was built ("SUPPORT_URL" above) |
| Unit fails with `image not known` | `make deploy GAME=<game>` has not built the game's images yet (`Pull=never`) |
