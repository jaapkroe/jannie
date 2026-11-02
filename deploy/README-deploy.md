# Running the games on shrek

One address, one entry point and one pod per game: every game runs as a rootless podman pod of its own under `jaap`, with two containers that share the pod's network namespace, and nothing of one game is in another's site. Nginx Proxy Manager (NPM) terminates TLS and forwards each game's name to its pod over plain HTTP on loopback:

```
internet ──443──> NPM ──http──> 127.0.0.1:8093 ┌ pod klaverjas ────────────────────────────────┐
                   │                           │ klaverjas-web     nginx :8080                 │
                   │                           │   /, /ABCD, files  from the image             │
                   │                           │   /ws, /api/  ───> klaverjas-server :8081     │
                   │                           └───────────────────────────────────────────────┘
                   └───────http──> 127.0.0.1:8095  pod toepen: toepen-web, toepen-server, the same
```

## The games

| `GAME` | `SITE` | `ADDR` | NPM proxy host | Game log volume |
|---|---|---|---|---|
| `klaverjas` | `klaverjas.kroes.dev` | `127.0.0.1:8093` | ID 37 | `klaverjas-games` |
| `toepen` | `toepen.kroes.dev` | `127.0.0.1:8095` | ID … (fill in once made) | `toepen-games` |

A game is a file `deploy/games/<game>.mk` with its settings; the `Makefile` reads the games from those files. Everything else is named after the game, `G` below:

| What | Name |
|---|---|
| Pod and its units | pod `G`; `G.pod`, `G-web.container`, `G-server.container` in `~/.config/containers/systemd/`; services `G-pod`, `G-web`, `G-server` |
| `G-web` | `localhost/G-web:current`, nginx-unprivileged: serves the game's files (`web/shared` and `web/G`), proxies `/ws` and `/api/`, sets the security headers |
| `G-server` | `localhost/G-server:current`, `FROM scratch`: the game server `/G`, on `127.0.0.1:8081` inside the pod only |
| Game log | the volume `G-games`, never shared with another game |

All images are built here from the checkout; nothing is pulled at start (`Pull=never`). There is no secret and no database: games live in the server's memory, so **every restart of a pod ends every game in progress in it** (and only there). The one volume of each pod holds its game log (below).

The settings of a game, in `deploy/games/<game>.mk`:

| Setting | klaverjas | toepen | Used for |
|---|---|---|---|
| `TITLE` | `Klaverjas` | `Toepen` | The unit descriptions and the 404 page's title; `make check` expects it as the page's `<title>` and the manifest's name |
| `VERB` | `klaverjassen` | `toepen` | The 404 page's way back, "Terug naar …" |
| `SITE` | `klaverjas.kroes.dev` | `toepen.kroes.dev` | The CSP's one `wss://` source and the link preview's `og:image` (both built into the web image), and the unit descriptions |
| `ADDR` | `127.0.0.1:8093` | `127.0.0.1:8095` | Where the pod publishes nginx; NPM forwards here |
| `DEV_PORT`, `E2E_PORT` | `18093`, `18094` | `18095`, `18096` | `make dev` and `make e2e`, clear of the installed pods |
| `E2E_SIM` | `test/e2e/sim.mjs` | `test/e2e/toepen.mjs` | What `make e2e` plays |

The port rule: `ADDR`'s port is an odd `P`, `DEV_PORT` is `10000+P` and `E2E_PORT` `10001+P`, so no two games ever share a port. `scripts/deploy-test` (in `make test`) checks it, that every `ADDR` is on loopback, and that no two games share a host name or a port.

The settings are plain `=`: a `SITE` in the shell's environment changes nothing; one on make's command line does, for the one game named (`make quadlet GAME=toepen ADDR=127.0.0.1:9001`). `make install GAME=<game>` writes them into the game's three units; `make quadlet GAME=<game>` shows the result. A change to `SITE`, `TITLE` or `VERB` needs `make deploy GAME=<game>` as well, because they are part of the web image.

### GAME

Every command that acts on a pod takes `GAME=`, a game or `all`, on make's command line (a `GAME` left in the shell's environment is ignored, so it never picks what is deployed):

| Commands | Without `GAME` |
|---|---|
| `install`, `deploy`, `uninstall`, `dev`, `image`, `image-server`, `image-web` | refuse, and list the games |
| `status`, `check`, `logs`, `quadlet`, `e2e`, `dev-stop` | every game |
| `help`, `test`, `test-all` | do not take it |

`GAME=all` goes through the games one after another, in the order of their names, all under one build tag, and stops at the first game that fails: `make deploy GAME=all` deploys klaverjas, checks it, and only then builds toepen.

## Upgrading klaverjas to one pod per game (once)

klaverjas keeps its name, address, units, images, volume and NPM proxy host; only the way they are made changes (the templates `deploy/game*.in`, the settings in `deploy/games/klaverjas.mk`, a web image built from `web/shared` and `web/klaverjas`). On shrek, as `jaap`, when nobody is playing:

1. Pull the change, then check that the new templates render exactly the units that are installed. **The diff must print nothing**; if it does, stop and look at what it shows before installing anything.

   ```sh
   cd /storage/klaverjas
   git pull
   for u in klaverjas.pod klaverjas-web.container klaverjas-server.container; do
     echo "# ---- $u"; cat ~/.config/containers/systemd/$u; echo
   done > /tmp/klaverjas-units.txt
   make quadlet GAME=klaverjas | diff /tmp/klaverjas-units.txt -      # nothing
   ```

2. Install and deploy, both with `GAME=klaverjas` (without it they refuse now):

   ```sh
   make install GAME=klaverjas      # the same three files again
   make deploy GAME=klaverjas       # new images under the old names, restart, make check
   ```

   `make check` now also checks the page's title, that the CSP allows the websocket of `klaverjas.kroes.dev` and of no other site, and the manifest's name.
3. Check from outside the house (below). If anything is wrong, go back to the image before the upgrade (*Going back*, below): the units did not change, so it runs as before.

## First time: toepen

klaverjas runs already; toepen gets its own proxy host, pod and volume next to it.

1. **NPM:** add a proxy host `toepen.kroes.dev` → `http://127.0.0.1:8095`, with the same settings as klaverjas's (ID 37, see *Nginx Proxy Manager* below), **Websockets Support on**. Write its ID into the games table above and into `deploy/npm-advanced.conf`, and commit. Until the pod runs it answers `502 Bad Gateway`.
2. **shrek-infra, before the link goes to anyone** (needs root): the name's own rate tier in NPM, as klaverjas has (step 4 of its `docs/services/klaverjas.md`), and a `docs/services/toepen.md` saying what the house's web filters and rate limits mean for the game. Without the rate tier the name has NPM's default limit for web pages, which one page load nearly uses up: a second player at the same address, or one player reloading, gets `429` and a page that never starts. In the same go: the volume `toepen-games` out of the backups, as `klaverjas-games` is (it holds personal data, see *The game log*), and `localhost/toepen-*` in the Trivy scan and the monitoring next to `localhost/klaverjas-*`.
3. **The pod:** with everything committed (`make deploy` builds only a committed tree):

   ```sh
   cd /storage/klaverjas
   make install GAME=toepen         # toepen.pod, toepen-web.container, toepen-server.container
   make deploy GAME=toepen          # builds both images (go vet and the tests run inside the build), starts the pod, runs make check
   ```

   klaverjas's units, images and pod are not touched.
4. Check through NPM (below, with `toepen.kroes.dev`), then from outside the house.
5. Check that the pod comes back from a restart: `systemctl --user restart toepen-pod`, then `make status GAME=toepen` shows both containers `healthy`.

## From scratch on another machine

The source is on Forgejo (`jaap/klaverjas`, created once as an empty repository and pushed with `git -C /storage/klaverjas remote add origin ssh://git@shrek.home:2222/jaap/klaverjas.git` and `git push -u origin main`). Elsewhere, as a user with lingering enabled (`loginctl show-user $USER -p Linger` says `Linger=yes`):

```sh
git clone ssh://git@shrek.home:2222/jaap/klaverjas.git /storage/klaverjas
cd /storage/klaverjas
make test                 # optional: go vet, Go and JS tests from source, and the deployment files
make install GAME=all     # every game's units, for your user
make deploy GAME=all      # every game's images and pod, one after another
```

Then a proxy host per game in NPM as below, each name's rate tier, and the checks.

## Nginx Proxy Manager

`*.kroes.dev` already resolves to the house through the wildcard DNS record, so no DNS work is needed. Every game has a proxy host of its own, all with the same settings but the name and the port, as `deploy/npm-advanced.conf` records them:

1. **Details:** domain `SITE` (e.g. `klaverjas.kroes.dev`), scheme `http`, forward to `127.0.0.1` port `ADDR`'s port (`8093`). **Block Common Exploits** on, **Websockets Support on**, Cache Assets off. No access list: the games are public.
2. **SSL:** the existing `*.kroes.dev` wildcard certificate, Force SSL. HTTP/2 Support is off, as on most of the house's proxy hosts; switching it on works too. Leave **HSTS Enabled** off. Do not request a new certificate.
3. **Advanced:** leave it empty.

Without Websockets Support the page loads and then never connects. With Cache Assets on, NPM caches scripts, styles and images itself and drops the pod's `Cache-Control`, so a deploy is not picked up at once.

HSTS comes from the pod with the other security headers, and NPM passes it on; with NPM's HSTS box ticked as well, browsers would get it twice. The header comment of `deploy/nginx.conf` says why a header pasted into the Advanced box is never sent.

Check through NPM from shrek, with `--resolve` so the request carries the right SNI; for toepen, put `toepen.kroes.dev` for `SITE`. This works only from inside the house: curl's user agent is on NPM's list of bots, which the house is exempt from (outside, NPM closes the connection without an answer).

```sh
SITE=klaverjas.kroes.dev
curl -s -o /dev/null -w '%{http_code}\n' --resolve $SITE:443:192.168.2.34 https://$SITE/   # 200
curl -sI --resolve $SITE:443:192.168.2.34 https://$SITE/ | grep -ci '^strict-transport-security'   # 1
curl -si --http1.1 --max-time 2 --resolve $SITE:443:192.168.2.34 https://$SITE/ws \
  -H "Origin: https://$SITE" -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' | head -1   # HTTP/1.1 101 Switching Protocols
```

`502` means the pod is not running. The websocket line tells the two causes of a page that loads and never connects apart: `426 Upgrade Required` comes from the game server when NPM did not pass the upgrade on, so **Websockets Support** is off on the proxy host; `502` means the pod or its server is down. `curl -sI` shows `HTTP/1.1` or `HTTP/2` depending on the proxy host's HTTP/2 setting, and either is fine; a websocket upgrade is HTTP/1.1 either way, hence `--http1.1`.

## Check from outside the house

The house (shrek, the LAN, the VPN and its own public address) is exempt from NPM's bot filter and rate limits, so the checks above pass from home even where a stranger would be turned away. After a game's first deploy, and after a change to its proxy host or to its name's rate tier, check that game from a network outside, such as a phone on mobile data with Wi-Fi and the VPN off:

- `https://SITE/` loads with its styles and the game's own name and look, and **Snel spelen** starts a game, which means the page reached the server over `wss://`.
- **Nieuw spel** gives a code and a link; the link, opened on a second device, joins that table.
- Reload twice within a few seconds: the page starts every time. Without the name's rate tier the second load gets `429`.
- Send yourself a join link in WhatsApp: the preview shows the game's own `og.png`. WhatsApp builds it on the sending phone, so it works from anywhere. iMessage's previewer calls itself `facebookexternalhit`, which NPM's bot filter turns away outside the house, so iMessage shows the image only when the sender is at home; Telegram, Slack and Discord fetch from datacenter addresses, which the firewall drops, so they show the bare link.

One full game through NPM, TLS and `wss://`, from any machine with Node 22 or later and the checkout, with the game's simulation (`E2E_SIM`; `test/e2e/README.md` has the options):

```sh
node test/e2e/sim.mjs --url wss://klaverjas.kroes.dev/ws --humans 2 --hands 16 --tempo snel
node test/e2e/toepen.mjs --url wss://toepen.kroes.dev/ws
```

Through NPM all simulated players come from one address, and share the server's per-address limits (150 connections).

## Checks without NPM

```sh
make check                  # every game's pod; `make deploy GAME=<game>` runs it for its game
make check GAME=toepen      # one game: scripts/pod-check 127.0.0.1:8095 toepen.kroes.dev Toepen
```

It checks a pod on its `ADDR` from the host, and prints only what fails: `/api/health` through nginx, the page and its title, a join link (`/KQXB`, the same page), a 404 (an HTML page with the game's name, also for a missing image, and not cached), the link preview (`og:image` is `https://SITE/og.png`, and that image and the apple-touch-icon are there as `image/png`), the manifest's name, the websocket upgrade with the page's own `Origin` (`101`) and with another site's (`403`), that the CSP allows the websocket of `SITE` and of no other site, and the security headers, HSTS included, each sent exactly once on every kind of path. `scripts/pod-check ADDR SITE TITLE` checks a pod elsewhere. The websocket upgrade by hand:

```sh
curl -si --max-time 2 http://127.0.0.1:8093/ws -H 'Origin: http://127.0.0.1:8093' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' | head -1                       # HTTP/1.1 101 Switching Protocols
```

The websocket check needs the `Origin` header: the server refuses an origin that does not match the host, which is what keeps other sites, the other games' included, from opening a game connection in a visitor's browser. A `403` for the page's own origin means the `Host` header did not reach the server unchanged.

## Day to day

| Task | Command |
|---|---|
| State, image revision and health | `make status` (every game), `make status GAME=toepen` |
| Logs of both containers | `make logs GAME=toepen`; `make logs` follows every game's |
| Update a game after merging changes | `git pull && make deploy GAME=toepen` (ends its games in progress) |
| Update every game | `git pull && make deploy GAME=all` (ends every game in progress, pod after pod) |
| A Trivy finding on a game's images | `make deploy GAME=<game>` (it rebuilds on the newest base image of the same tag); `GAME=all` for a base image every game has |
| Restart | `systemctl --user restart toepen-pod` (also ends its games) |
| Changed a game's settings | `make install GAME=toepen && make deploy GAME=toepen` |
| Stop a game and remove its units; keeps its images and game log | `make uninstall GAME=toepen` |

`make deploy` builds a committed tree only, and says so when `git status` lists anything, untracked files included, because the build copies the working tree. `make deploy GAME=<game> ALLOW_DIRTY=1` deploys it anyway, with `-dirty` after the commit in the revision that `make status` and `/api/health` show.

One game's commands touch only that game: `make deploy GAME=toepen` builds, tags and restarts `toepen-*` alone, and klaverjas plays on.

## Going back

Each build tags both of a game's images with a tag of its own, the revision and the time (`<commit>-20261020-213000`), so every earlier build is still there to go back to, a rebuild of the same commit included; a `GAME=all` build gives every game the same tag. Only `make deploy` then points `:current`, the tag the units run, at the new build: a `make image GAME=<game>` on its own, to try a build, never changes what the pod starts after a restart or a failed health check. `make deploy` ends by naming the tag. To take one game back, here toepen:

```sh
podman images 'localhost/toepen-*'                                          # the builds
podman tag localhost/toepen-server:<tag> localhost/toepen-server:current
podman tag localhost/toepen-web:<tag> localhost/toepen-web:current
systemctl --user restart toepen-pod
```

The same with `klaverjas` for klaverjas; the other games are not affected. Old builds pile up; `podman rmi` removes them.

## Updating

Deploy when nobody is playing if you can: the restart takes seconds, but the rooms of that game are gone afterwards. On shutdown the server tells connected players it is restarting; their pages reconnect and find their room no longer exists.

The `Containerfile` names its base images by minor version, without a digest (see its `FROM` lines). Security fixes in Go, nginx or Alpine are published again under those same tags, and every `make deploy` builds with `--pull=newer`, so it picks them up: rebuilding is the response to a Trivy alert on any game's image. A move to the next minor version is a change to the `Containerfile` (a Renovate pull request once the repository is on Forgejo), for every game at once. `scripts/go` and `scripts/dev-server` read the build image from the `Containerfile`, so they follow such a change.

Static files are sent with `Cache-Control: no-cache` and revalidated by ETag, so browsers pick up a new frontend at the next page load; images are cached for a day (a 404 is never cached, so an image added by a deploy shows up at once).

## Logs

`make logs GAME=<game>` follows both containers of a game in the journal, `make logs` every game's. nginx logs errors only: NPM already logs every request at the edge, with query strings redacted. The server logs to the journal with `log/slog`; it never logs chat text or seat tokens.

```sh
journalctl --user -u toepen-server -n 100          # recent server log of one game
podman inspect toepen-server --format '{{.State.Health.Status}}'
```

A failing health check (three in a row, a minute apart) kills the container and systemd restarts it; that also ends the games in that pod.

## What is exposed, and why

The proxy hosts are public with no access list, because players join from wherever they are with a code or a link. What that exposes:

- **No accounts and no persistence.** There is nothing to log in to and nothing stored: names, chat and games exist in memory only, until the room is removed or the server restarts. A room with nobody connected goes after 5 minutes in its lobby, after the game or once every player has left, and after 30 minutes while a game is in progress; a finished game goes 30 minutes after it ended. A seat token in the player's browser only returns them to their own seat.
- **One pod per game.** The games share nothing at run time: each has its own containers, address, volume and origin, a page of one game cannot open the websocket of another (the server's Origin check), and its CSP names its own `wss://` only.
- **Small, contained processes.** nginx runs as uid 101 and the server as 65532; rootless podman maps both to subordinate UIDs, not to `jaap`'s own. Both containers have a read-only root, no capabilities, no new privileges and no secret, and only the server has a volume, its game log; the server image holds nothing but its binary, so there is no shell. Only nginx is published, and only on loopback.
- **Limits in each server** (`docs/design.md`, section 6): websocket messages of at most 16 KiB (a call's session description takes several) and 20 per second, at most one `join` a second per connection (bursts of three), chat lines of at most 200 characters at one a second (bursts of five), call messages (joining, switching, session descriptions) at two a second (bursts of ten). Per client address, where a whole club on one wifi shares the limits: at most 60 new rooms per 10 minutes, 60 live rooms and 150 connections; after 200 failed joins within a minute (an unknown code, a full or started table), joins from that address are refused for 5 minutes, except a return to one's own seat with its token, so guessing room codes stays slow. At most 1500 rooms; when full, a new game replaces the room that has had nobody connected for longest. The limits are per game: each server counts its own. The client address comes from NPM's `X-Real-IP`, which nginx accepts only from the loopback hop.
- **The house's web filters and rate limits apply as to every public name.** They belong to shrek-infra: its `docs/services/<game>.md` (in `/storage/shrek-infra`) says what they mean for the game and links the rate limit the name has. What a game brings to them: a page load is at most 17 requests (`index.html` and what it links), and the websocket counts once, however long the game lasts.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| NPM shows `502 Bad Gateway` | The game's pod is not running: `make status GAME=<game>`, `systemctl --user status <game>-pod` |
| The page loads, but it never connects | Websockets Support is off on the proxy host (the websocket check through NPM answers `426`), or the server container is down (`/api/health` through nginx answers `502`) |
| `/ws` answers `403` | The `Origin` does not match the host: something rewrote `Host` between the browser and the server |
| One game's site shows another game | The proxy host forwards to the other game's port: compare it with `ADDR` in `deploy/games/<game>.mk` and `deploy/npm-advanced.conf` |
| Everyone shares one address and hits the room limit | NPM's connections no longer arrive from `127.0.0.1` in the pod: `ADDR` is not loopback, or `Network=pasta:--host-lo-to-ns-lo` is missing from the pod unit |
| Old scripts or styles after a deploy | Cache Assets is on in the proxy host |
| The page stays on its loading dots, or loads without styles | NPM refused part of the load with `429`, its rate limit: many players behind one address loaded at the same moment. A reload a few seconds later works. If it happens to one player alone, the name's own rate tier is not installed in NPM (*First time: toepen*, step 2); the name's limit is in shrek-infra (`docs/services/<game>.md`) |
| `make deploy` stops with "which game?" | Add `GAME=<game>`, or `GAME=all` |
| `make deploy` stops with "changes that are not committed" | `git status` lists something: commit it, or deploy anyway with `ALLOW_DIRTY=1` |
| Unit fails with `image not known` | `make deploy GAME=<game>` has not built the game's images yet (`Pull=never`) |

## The game log

Each game's server appends a compact record of every game to its own volume, `G-games` (`klaverjas-games`, `toepen-games`), mounted at `/data` (design §6 *Game log*): one JSON line per event in `games-YYYY-MM.jsonl` per month (UTC). It holds:
- who played: name, IP address and browser (User-Agent);
- the cards dealt and every move;
- the results (for klaverjas also the Spelanalyse);
- the players' feedback (in klaverjas's expert mode also about one of their own decisions).

It is used for statistics and to improve the games (looking at games again, tuning the engines). It grows by a few kB per game and is kept for **at most 12 months**: each server removes the month files older than the current month and the eleven before it, when it starts and every hour, and says so in its log (`game log: removed an old month`).

```sh
dir=$(podman volume inspect toepen-games --format '{{.Mountpoint}}')
ls -l "$dir"
tail -n 3 "$dir/games-$(date -u +%Y-%m).jsonl" | jq .
grep '"t":"feedback"' "$dir"/games-*.jsonl | jq -r '.name + ": " + .text'
```

The files are written by the server's user, mapped to a subordinate UID. They are readable by `jaap` (mode 644); to remove or change them, use `podman unshare rm …`. The log holds personal data (names, IP addresses), so keep every game's volume out of backups that leave the house, and out of any backup kept longer than 12 months. To delete a month earlier than that:

```sh
podman unshare rm "$dir/games-2026-10.jsonl"
```

`make uninstall GAME=<game>` keeps the volume; `podman volume rm <game>-games` (with that pod stopped) removes it with every log of that game.

## Adding a game

A game `G` (say `pesten`) is ready to go public when every step below is done; `make test` checks the ones in the repository.

1. **Rules and tests:** `internal/G`, the rules engine, with its tests.
2. **Bots and an arena:** `internal/Gbot`, and an arena test in `make test-all` that shows each level beats the one below it.
3. **Server package:** `internal/Gserver`, the game on the table library's exported API (`internal/server`), tested with `internal/server/servertest`.
4. **Command:** `cmd/G`, through `internal/serve`; the binary is named after the game (the units' `HealthCmd` runs `/G`).
5. **Web:** `web/G/` with `index.html` (`<title>TITLE</title>`, `@SITE@` in the `og:image`, `@VERSION@`), `manifest.webmanifest` (name `TITLE`), `favicon.svg`, the icon PNGs, `og.png`, `js/` and `css/`; no path that `web/shared` has too.
6. **Settings:** `deploy/games/G.mk`, a copy of another game's with every value changed: `TITLE`, `VERB`, `SITE` (`G.kroes.dev`), `ADDR` on the next free odd port `P`, `DEV_PORT` `10000+P`, `E2E_PORT` `10001+P`, and `E2E_SIM`, its simulation, `test/e2e/G.mjs`.
7. **Containerfile:** a target `server-G`, a copy of `server-klaverjas` with the name changed in its four places.
8. **Tests:** `make test` (`scripts/deploy-test` checks the settings, the units, the target, `cmd/G` and `web/G`), `make e2e GAME=G`, the UI checks against `make dev GAME=G`.
9. **NPM and shrek-infra:** a proxy host `G.kroes.dev` → `http://127.0.0.1:P` as in *Nginx Proxy Manager*; the name's rate tier and `docs/services/G.md` before the link goes out; `G-games` out of the backups; `localhost/G-*` in Trivy and the monitoring.
10. **Docs:** the games tables here, `deploy/npm-advanced.conf` (with the proxy host's ID), `docs/design.md` and `README.md`.
11. **Deploy:** `make install GAME=G && make deploy GAME=G`, then the checks of *First time: toepen* with `G`.
