# Klaverjas, https://klaverjas.kroes.dev/: the settings of `make … GAME=klaverjas`.
# Plain `=`: a variable of the same name in the shell's environment does not change
# a build, one on make's command line does (`make quadlet GAME=klaverjas ADDR=…`).
# After a change: make install GAME=klaverjas && make deploy GAME=klaverjas.

# The game's name, in the unit descriptions and the 404 page's title ("Niet gevonden
# - Klaverjas"); scripts/pod-check expects it as the <title> and the manifest's name
# of web/klaverjas/.
TITLE = Klaverjas
# The 404 page's way back: "Terug naar klaverjassen".
VERB = klaverjassen
# Public host name. NPM terminates TLS for it and forwards to ADDR.
SITE = klaverjas.kroes.dev
# Where the pod listens. Loopback, because NPM runs on the same machine; see
# deploy/README-deploy.md before changing it. The port rule of every game: an odd
# port P here, DEV_PORT 10000+P and E2E_PORT 10001+P (scripts/deploy-test checks it).
ADDR = 127.0.0.1:8093
# The server from source, for `make dev` and `make e2e`; clear of the installed pods.
DEV_PORT = 18093
E2E_PORT = 18094
# What `make e2e` plays against it, given the server's http://127.0.0.1:E2E_PORT.
E2E_SIM = test/e2e/sim.mjs
