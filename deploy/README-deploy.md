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

Both images are built here from the checkout; nothing is pulled at start (`Pull=never`). There is no volume, no secret and no database: games live in the server's memory, so **every restart ends every game in progress**.

The settings are at the top of the `Makefile`:

| Setting | Value | Used for |
|---|---|---|
| `SITE` | `klaverjas.kroes.dev` | The CSP's `wss://` source (built into the web image) and the unit descriptions |
| `ADDR` | `127.0.0.1:8093` | Where the pod publishes nginx; NPM forwards here |
| `DEV_PORT`, `E2E_PORT` | `18093`, `18094` | `make dev` and `make e2e`, clear of the installed pod |

`make install` writes them into the three units; `make quadlet` shows the result. A change to `SITE` needs `make deploy` as well, because it is part of the web image.

## First time

As `jaap`, who already has lingering enabled for the other rootless services (`loginctl show-user jaap -p Linger` says `Linger=yes`):

```sh
git clone https://git.kroes.dev/jaap/klaverjas.git /storage/klaverjas && cd /storage/klaverjas
make test        # optional: go vet, Go and JS tests from source
make install     # klaverjas.pod, klaverjas-web.container and klaverjas-server.container, for your user
make deploy      # builds both images (go vet and the tests run inside the build), starts the pod, checks /api/health
```

Then create the proxy host (below). Until it exists, NPM answers `klaverjas.kroes.dev` with its own 404 page.

## Nginx Proxy Manager

`*.kroes.dev` already resolves to the house through the wildcard DNS record, so no DNS work is needed. In NPM, add a proxy host as `deploy/npm-advanced.conf` records:

1. **Details:** domain `klaverjas.kroes.dev`, scheme `http`, forward to `127.0.0.1` port `8093`. **Block Common Exploits** on, **Websockets Support on**, Cache Assets off. No access list: the game is public.
2. **SSL:** the existing `*.kroes.dev` wildcard certificate, Force SSL, HTTP/2. Do not request a new certificate.
3. **Advanced:** paste the `add_header Strict-Transport-Security` line from `deploy/npm-advanced.conf`.

Without Websockets Support the page loads and then never connects. With Cache Assets on, NPM caches scripts, styles and images itself and drops the pod's `Cache-Control`, so a deploy is not picked up at once.

Check through NPM from shrek, with `--resolve` so the request carries the right SNI:

```sh
curl -sI --resolve klaverjas.kroes.dev:443:192.168.2.34 https://klaverjas.kroes.dev/ | head -1    # HTTP/2 200
```

## Checks without NPM

```sh
curl -s http://127.0.0.1:8093/api/health                                         # the server, through nginx
curl -s http://127.0.0.1:8093/ | grep -o '<title>[^<]*</title>'                   # the page
curl -sI http://127.0.0.1:8093/KQXB | head -1                                     # a join link: 200, the same page
curl -sI http://127.0.0.1:8093/bestaat-niet | head -1                             # 404
curl -si --max-time 2 http://127.0.0.1:8093/ws -H 'Origin: http://127.0.0.1:8093' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' | head -1                       # HTTP/1.1 101 Switching Protocols
```

The websocket check needs the `Origin` header: the server refuses an origin that does not match the host, which is what keeps other sites from opening a game connection in a visitor's browser. A `403` there means the `Host` header did not reach the server unchanged.

## Day to day

| Task | Command |
|---|---|
| State, image revision and health | `make status` |
| Logs of both containers | `make logs` |
| Update after merging changes | `git pull && make deploy` (ends the games in progress) |
| Restart | `systemctl --user restart klaverjas-pod` (also ends them) |
| Changed a setting in the Makefile | `make install && make deploy` |
| Stop and remove the units; keeps the images | `make uninstall` |

Each `make deploy` tags both images with the commit as well as `:current`, so the previous build is still there to go back to: `podman tag localhost/klaverjas-server:<sha> localhost/klaverjas-server:current` (and the same for `-web`), then restart the pod. Old builds pile up; `podman images 'localhost/klaverjas-*'` lists them and `podman rmi` removes them.

## Updating

Deploy when nobody is playing if you can: the restart takes seconds, but the rooms are gone afterwards. On shutdown the server tells connected players it is restarting; their pages reconnect and find their room no longer exists.

Static files are sent with `Cache-Control: no-cache` and revalidated by ETag, so browsers pick up a new frontend at the next page load; images are cached for a day.

## Logs

`make logs` follows both containers in the journal. nginx logs errors only: NPM already logs every request at the edge, with query strings redacted. The server logs to the journal with `log/slog`; it never logs chat text or seat tokens.

```sh
journalctl --user -u klaverjas-server -n 100          # recent server log
podman inspect klaverjas-server --format '{{.State.Health.Status}}'
```

A failing health check (three in a row, a minute apart) kills the container and systemd restarts it; that also ends the games.

## What is exposed, and why

The proxy host is public with no access list, because players join from wherever they are with a code or a link. What that exposes:

- **No accounts and no persistence.** There is nothing to log in to and nothing stored: names, chat and games exist in memory only, until the room is removed (30 minutes without players) or the server restarts. A seat token in the player's browser only returns them to their own seat.
- **Small, contained processes.** nginx runs as uid 101 and the server as 65532; rootless podman maps both to subordinate UIDs, not to `jaap`'s own. Both containers have a read-only root, no capabilities, no new privileges, no volume and no secret; the server image holds nothing but its binary, so there is no shell. Only nginx is published, and only on loopback.
- **Limits in the server** (`docs/design.md`, section 6): websocket messages of at most 4 KiB and 20 per second, chat lines of at most 200 characters at one a second (bursts of five), at most 20 new rooms per 10 minutes and 16 connections per client address, at most 500 rooms. The client address comes from NPM's `X-Real-IP`, which nginx accepts only from the loopback hop.
- **The house's web filters apply as to every public name:** the firewall drops addresses outside Europe and datacenters (so also commercial VPNs), and NPM refuses bot user agents and rate-limits each address to 2 requests a second with bursts of 20. A page load is at most 16 requests and the websocket counts once, however long the game lasts. A friend abroad cannot join; one behind a VPN has to turn it off.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| NPM shows `502 Bad Gateway` | The pod is not running: `make status`, `systemctl --user status klaverjas-pod` |
| The page loads, but it never connects | Websockets Support is off on the proxy host, or the server container is down (`/api/health` through nginx answers `502`) |
| `/ws` answers `403` | The `Origin` does not match the host: something rewrote `Host` between the browser and the server |
| Everyone shares one address and hits the room limit | NPM's connections no longer arrive from `127.0.0.1` in the pod: `ADDR` is not loopback, or `Network=pasta:--host-lo-to-ns-lo` is missing from the pod unit |
| Old scripts or styles after a deploy | Cache Assets is on in the proxy host |
| A page loads half, without styles or scripts | NPM's rate limit (`429` in its log): several players behind one address loaded at the same moment. A reload a few seconds later works; if it keeps happening, give the host the `app` tier in shrek-infra's `quadlets/root/npm-http-top.conf` |
| Unit fails with `image not known` | `make deploy` has not built the images yet (`Pull=never`) |
