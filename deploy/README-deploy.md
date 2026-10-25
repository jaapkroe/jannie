# Running klaverjas on shrek

One rootless podman pod under `jaap`, with two containers that share its network namespace. Nginx Proxy Manager (NPM) terminates TLS and forwards to the pod over plain HTTP on loopback:

```
internet ──443──> NPM ──http──> 127.0.0.1:8093 ┌ pod klaverjas ────────────────────────────────┐
                                               │ klaverjas-web     nginx :8080                 │
                                               │   /, /ABCD, files  from the image             │
                                               │   /ws, /api/  ───> klaverjas-server :8081     │
                                               └───────────────────────────────────────────────┘
```

| Container | Image | Role |
|---|---|---|
| `klaverjas-web` | `localhost/klaverjas-web:current`, nginx-unprivileged | Serves `web/`, proxies `/ws` and `/api/`, sets the security headers |
| `klaverjas-server` | `localhost/klaverjas-server:current`, `FROM scratch` | The game server, on `127.0.0.1:8081` inside the pod only |

Both images are built here from the checkout; nothing is pulled at start (`Pull=never`). There is no secret and no database: games live in the server's memory, so **every restart ends every game in progress**. The one volume, `klaverjas-games`, holds the game log (see below).

The settings are at the top of the `Makefile`:

| Setting | Value | Used for |
|---|---|---|
| `SITE` | `klaverjas.kroes.dev` | The CSP's `wss://` source and the link preview's `og:image` (both built into the web image), and the unit descriptions |
| `ADDR` | `127.0.0.1:8093` | Where the pod publishes nginx; NPM forwards here |
| `DEV_PORT`, `E2E_PORT` | `18093`, `18094` | `make dev` and `make e2e`, clear of the installed pod |

`make install` writes them into the three units; `make quadlet` shows the result. A change to `SITE` needs `make deploy` as well, because it is part of the web image.

## First time

The checkout is already at `/storage/klaverjas`, and NPM already has the proxy host (ID 37); until the pod runs, it answers `502 Bad Gateway`. As `jaap`, who already has lingering enabled for the other rootless services (`loginctl show-user jaap -p Linger` says `Linger=yes`):

1. Commit everything, until `git status` lists nothing: `make deploy` builds only a committed tree, so that what runs in public is a commit that is on Forgejo. Then put the source on Forgejo, once. Create the empty repository `jaap/klaverjas` in Forgejo's web interface (no README, no licence), then push the checkout to it:

   ```sh
   git -C /storage/klaverjas remote add origin ssh://git@shrek.home:2222/jaap/klaverjas.git
   git -C /storage/klaverjas push -u origin main
   ```

2. Build and start the pod:

   ```sh
   cd /storage/klaverjas
   make test        # optional: go vet, Go and JS tests from source, and the deployment files
   make install     # klaverjas.pod, klaverjas-web.container and klaverjas-server.container, for your user
   make deploy      # builds both images (go vet and the tests run inside the build), starts the pod, runs make check
   ```

3. Compare the proxy host with `deploy/npm-advanced.conf` (below), then run the check through NPM.
4. Have the name's own rate tier installed in NPM **before the link goes to anyone**. Until then the name has NPM's default limit for web pages, which one page load nearly uses up: a second player at the same address, or one player reloading, gets `429` and a page that never starts. It needs root, in shrek-infra: step 4 of its `docs/services/klaverjas.md`.
5. Check from outside the house (below), and that the pod comes back from a restart: `systemctl --user restart klaverjas-pod`, then `make status` shows both containers `healthy`.

From scratch on another machine, `git clone ssh://git@shrek.home:2222/jaap/klaverjas.git /storage/klaverjas` replaces step 1, and the proxy host is created as below.

## Nginx Proxy Manager

`*.kroes.dev` already resolves to the house through the wildcard DNS record, so no DNS work is needed. The proxy host exists; these are its settings, as `deploy/npm-advanced.conf` records them (to create it from scratch, add a proxy host with the same):

1. **Details:** domain `klaverjas.kroes.dev`, scheme `http`, forward to `127.0.0.1` port `8093`. **Block Common Exploits** on, **Websockets Support on**, Cache Assets off. No access list: the game is public.
2. **SSL:** the existing `*.kroes.dev` wildcard certificate, Force SSL. HTTP/2 Support is off, as on most of the house's proxy hosts; switching it on works too. Leave **HSTS Enabled** off. Do not request a new certificate.
3. **Advanced:** leave it empty.

Without Websockets Support the page loads and then never connects. With Cache Assets on, NPM caches scripts, styles and images itself and drops the pod's `Cache-Control`, so a deploy is not picked up at once.

HSTS comes from the pod with the other security headers, and NPM passes it on; with NPM's HSTS box ticked as well, browsers would get it twice. The header comment of `deploy/nginx.conf` says why a header pasted into the Advanced box is never sent.

Check through NPM from shrek, with `--resolve` so the request carries the right SNI. This works only from inside the house: curl's user agent is on NPM's list of bots, which the house is exempt from (outside, NPM closes the connection without an answer).

```sh
curl -s -o /dev/null -w '%{http_code}\n' --resolve klaverjas.kroes.dev:443:192.168.2.34 https://klaverjas.kroes.dev/   # 200
curl -sI --resolve klaverjas.kroes.dev:443:192.168.2.34 https://klaverjas.kroes.dev/ \
  | grep -ci '^strict-transport-security'                                                                  # 1
curl -si --http1.1 --max-time 2 --resolve klaverjas.kroes.dev:443:192.168.2.34 https://klaverjas.kroes.dev/ws \
  -H 'Origin: https://klaverjas.kroes.dev' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' | head -1           # HTTP/1.1 101 Switching Protocols
```

`502` means the pod is not running. The websocket line tells the two causes of a page that loads and never connects apart: `426 Upgrade Required` comes from the game server when NPM did not pass the upgrade on, so **Websockets Support** is off on the proxy host; `502` means the pod or its server is down. `curl -sI` shows `HTTP/1.1` or `HTTP/2` depending on the proxy host's HTTP/2 setting, and either is fine; a websocket upgrade is HTTP/1.1 either way, hence `--http1.1`.

## Check from outside the house

The house (shrek, the LAN, the VPN and its own public address) is exempt from NPM's bot filter and rate limits, so the checks above pass from home even where a stranger would be turned away. After the first deploy, and after a change to the proxy host or to the name's rate tier, check from a network outside, such as a phone on mobile data with Wi-Fi and the VPN off:

- `https://klaverjas.kroes.dev/` loads with its styles, and **Snel spelen** starts a game, which means the page reached the server over `wss://`.
- **Nieuw spel** gives a code and a link; the link, opened on a second device, joins that table.
- Reload twice within a few seconds: the page starts every time. Without the name's rate tier the second load gets `429`.
- Send yourself a join link in WhatsApp: the preview shows the felt with the cards (`og.png`). WhatsApp builds it on the sending phone, so it works from anywhere. iMessage's previewer calls itself `facebookexternalhit`, which NPM's bot filter turns away outside the house, so iMessage shows the image only when the sender is at home; Telegram, Slack and Discord fetch from datacenter addresses, which the firewall drops, so they show the bare link.

One full game through NPM, TLS and `wss://`, from any machine with Node 22 or later and the checkout:

```sh
node test/e2e/sim.mjs --url wss://klaverjas.kroes.dev/ws --humans 2 --hands 16 --tempo snel
```

Use at most four humans: through NPM they all come from one address, and share the server's per-address limits (16 connections).

## Checks without NPM

```sh
make check       # scripts/pod-check ADDR SITE; `make deploy` runs it too
```

It checks the pod on `ADDR` from the host, and prints only what fails: `/api/health` through nginx, the page, a join link (`/KQXB`, the same page), a 404 (an HTML page, also for a missing image, and not cached), the link preview (`og:image` is `https://SITE/og.png`, and that image and the apple-touch-icon are there as `image/png`), the websocket upgrade with the page's own `Origin` (`101`) and with another site's (`403`), and the security headers, HSTS included, each sent exactly once on every kind of path. `scripts/pod-check HOST:PORT [SITE]` checks a pod elsewhere. The websocket upgrade by hand:

```sh
curl -si --max-time 2 http://127.0.0.1:8093/ws -H 'Origin: http://127.0.0.1:8093' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' | head -1                       # HTTP/1.1 101 Switching Protocols
```

The websocket check needs the `Origin` header: the server refuses an origin that does not match the host, which is what keeps other sites from opening a game connection in a visitor's browser. A `403` for the page's own origin means the `Host` header did not reach the server unchanged.

## Day to day

| Task | Command |
|---|---|
| State, image revision and health | `make status` |
| Logs of both containers | `make logs` |
| Update after merging changes | `git pull && make deploy` (ends the games in progress) |
| A Trivy finding on either image | `make deploy` (it rebuilds on the newest base image of the same tag) |
| Restart | `systemctl --user restart klaverjas-pod` (also ends them) |
| Changed a setting in the Makefile | `make install && make deploy` |
| Stop and remove the units; keeps the images | `make uninstall` |

`make deploy` builds a committed tree only, and says so when `git status` lists anything, untracked files included, because the build copies the working tree. `make deploy ALLOW_DIRTY=1` deploys it anyway, with `-dirty` after the commit in the revision that `make status` and `/api/health` show.

Each build tags both images with a tag of its own, the revision and the time (`<commit>-20261020-213000`), so every earlier build is still there to go back to, a rebuild of the same commit included. Only `make deploy` then points `:current`, the tag the units run, at the new build: a `make image` on its own, to try a build, never changes what the pod starts after a restart or a failed health check. `make deploy` ends by naming the tag. To go back, `podman images 'localhost/klaverjas-*'` lists the builds; `podman tag localhost/klaverjas-server:<tag> localhost/klaverjas-server:current`, the same for `-web`, then restart the pod. Old builds pile up; `podman rmi` removes them.

## Updating

Deploy when nobody is playing if you can: the restart takes seconds, but the rooms are gone afterwards. On shutdown the server tells connected players it is restarting; their pages reconnect and find their room no longer exists.

The `Containerfile` names its base images by minor version, without a digest (see its `FROM` lines). Security fixes in Go, nginx or Alpine are published again under those same tags, and every `make deploy` builds with `--pull=newer`, so it picks them up: rebuilding is the response to a Trivy alert on either image. A move to the next minor version is a change to the `Containerfile` (a Renovate pull request once the repository is on Forgejo). `scripts/go` and `scripts/dev-server` read the build image from the `Containerfile`, so they follow such a change.

Static files are sent with `Cache-Control: no-cache` and revalidated by ETag, so browsers pick up a new frontend at the next page load; images are cached for a day (a 404 is never cached, so an image added by a deploy shows up at once).

## Logs

`make logs` follows both containers in the journal. nginx logs errors only: NPM already logs every request at the edge, with query strings redacted. The server logs to the journal with `log/slog`; it never logs chat text or seat tokens.

```sh
journalctl --user -u klaverjas-server -n 100          # recent server log
podman inspect klaverjas-server --format '{{.State.Health.Status}}'
```

A failing health check (three in a row, a minute apart) kills the container and systemd restarts it; that also ends the games.

## What is exposed, and why

The proxy host is public with no access list, because players join from wherever they are with a code or a link. What that exposes:

- **No accounts and no persistence.** There is nothing to log in to and nothing stored: names, chat and games exist in memory only, until the room is removed or the server restarts. A room with nobody connected goes after 5 minutes in its lobby, after the game or once every player has left, and after 30 minutes while a game is in progress; a finished game goes 30 minutes after it ended. A seat token in the player's browser only returns them to their own seat.
- **Small, contained processes.** nginx runs as uid 101 and the server as 65532; rootless podman maps both to subordinate UIDs, not to `jaap`'s own. Both containers have a read-only root, no capabilities, no new privileges, no volume and no secret; the server image holds nothing but its binary, so there is no shell. Only nginx is published, and only on loopback.
- **Limits in the server** (`docs/design.md`, section 6): websocket messages of at most 4 KiB and 20 per second, at most one `join` a second per connection (bursts of three), chat lines of at most 200 characters at one a second (bursts of five). Per client address: at most 20 new rooms per 10 minutes, 10 live rooms and 16 connections; after 10 failed joins within a minute (an unknown code, a full or started table), joins from that address are refused for 5 minutes, except a return to one's own seat with its token, so room codes cannot be guessed. At most 500 rooms; when full, a new game replaces the room that has had nobody connected for longest. The client address comes from NPM's `X-Real-IP`, which nginx accepts only from the loopback hop.
- **The house's web filters and rate limits apply as to every public name.** They belong to shrek-infra: its `docs/services/klaverjas.md` (in `/storage/shrek-infra`) says what they mean for the game and links the rate limit this name has. What the game brings to them: a page load is about 15 requests (`index.html` and what it links), and the websocket counts once, however long the game lasts.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| NPM shows `502 Bad Gateway` | The pod is not running: `make status`, `systemctl --user status klaverjas-pod` |
| The page loads, but it never connects | Websockets Support is off on the proxy host (the websocket check through NPM answers `426`), or the server container is down (`/api/health` through nginx answers `502`) |
| `/ws` answers `403` | The `Origin` does not match the host: something rewrote `Host` between the browser and the server |
| Everyone shares one address and hits the room limit | NPM's connections no longer arrive from `127.0.0.1` in the pod: `ADDR` is not loopback, or `Network=pasta:--host-lo-to-ns-lo` is missing from the pod unit |
| Old scripts or styles after a deploy | Cache Assets is on in the proxy host |
| The page stays on its loading dots, or loads without styles | NPM refused part of the load with `429`, its rate limit: many players behind one address loaded at the same moment. A reload a few seconds later works. If it happens to one player alone, the name's own rate tier is not installed in NPM (step 4 of First time); the name's limit is in shrek-infra (`docs/services/klaverjas.md`) |
| `make deploy` stops with "changes that are not committed" | `git status` lists something: commit it, or deploy anyway with `ALLOW_DIRTY=1` |
| Unit fails with `image not known` | `make deploy` has not built the images yet (`Pull=never`) |

## The game log

The server appends a compact record of every game to the volume `klaverjas-games`, mounted at `/data` (design §6 *Game log*): one JSON line per event in `games-YYYY-MM.jsonl` per month (UTC). It holds:
- who played: name, IP address and browser (User-Agent);
- the cards dealt and every move;
- the results and the Spelanalyse;
- the players' own choices (*bij nader inzien*) and their feedback.

It is used for statistics and to improve the game (looking at games again, tuning the engine). It grows by a few kB per game and is kept for **at most 12 months**: the server removes the month files older than the current month and the eleven before it, when it starts and every hour, and says so in its log (`game log: removed an old month`).

```sh
dir=$(podman volume inspect klaverjas-games --format '{{.Mountpoint}}')
ls -l "$dir"
tail -n 3 "$dir/games-$(date -u +%Y-%m).jsonl" | jq .
grep '"t":"feedback"' "$dir"/games-*.jsonl | jq -r '.name + ": " + .text'
```

The files are written by the server's user, mapped to a subordinate UID. They are readable by `jaap` (mode 644); to remove or change them, use `podman unshare rm …`. The log holds personal data (names, IP addresses), so keep it out of backups that leave the house, and out of any backup kept longer than 12 months. To delete a month earlier than that:

```sh
podman unshare rm "$dir/games-2026-10.jsonl"
```

`make uninstall` keeps the volume; `podman volume rm klaverjas-games` (with the pod stopped) removes it with every log.

