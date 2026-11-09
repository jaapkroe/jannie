# Contributing

Bug reports, ideas and pull requests are welcome. The games' interface is
in Dutch; issues and pull requests may be in English or Dutch.

## Before your first pull request

- **License.** Jannie is published under the GNU Affero General Public
  License, version 3 only ([LICENSE](LICENSE)).
- **Contributor agreement.** Before your first pull request can be merged,
  you sign the [Contributor License Agreement](CLA.md). A bot asks you on
  the pull request, and one signature covers everything you contribute,
  including issues and comments. You keep the copyright of your work. The
  agreement lets the maintainer, or a successor such as the maintainer's
  company, also distribute it under other terms, which the store apps and
  paid parts such as bridge lessons need. Every version published in the
  public repository stays under the AGPL, your contributions included.
- **AI tools** are fine to use. You are responsible for what you submit:
  read and test it as if you had written it by hand, and say in the pull
  request when a substantial part was generated.

## Making a change

- Read [CLAUDE.md](CLAUDE.md) for the commands and conventions, and the
  doc of the part you change ([docs/](docs/) or the game's
  `games/<game>/README.md`).
- One change per pull request, with the docs that describe it updated in
  the same commit.
- Code, comments and docs are in English; every string a player sees is in
  Dutch.
- `make test` must pass. For a change to what players see, a screenshot in
  the pull request helps.
- For a new game, open an issue first to agree on the rules and the
  variant; [docs/adding-a-game.md](docs/adding-a-game.md) says what a game
  needs. A pull request that adds a game touches only its folder,
  `games/<game>/` ([docs/adding-a-game.md, "The folder"](docs/adding-a-game.md#the-folder)).

## Security

Report a security problem privately, through *Report a vulnerability* on
the repository's Security tab on GitHub, not in a public issue.
