# mixamocli

`mixamo` is a small Node.js CLI for [Mixamo](https://www.mixamo.com/) (Adobe's free character animation library). It reuses an already logged-in Chrome over the DevTools protocol to pick up Mixamo's access token, then calls Mixamo's own web API. No password handling and no headless login flow: it borrows your browser session.

Sister tools that use the same signed-in Chrome: [fabcli](https://github.com/eiei114/fabcli) (Fab) and [sfabcli](https://github.com/eiei114/sfabcli) (Sketchfab).

Messages are in Japanese for now; commands and flags are English.

```console
$ mixamo status
$ mixamo search "jump" --limit 5 --details
$ mixamo download "Jumping" --out ./anims --format fbx7_2019 --fps 30 --inplace
$ mixamo batch "walk" --limit 10 --out ./anims --skin false
```

## Requirements

- Node.js 22 or newer (uses the built-in `fetch` and `WebSocket`); no dependencies
- A Chrome instance started with `--remote-debugging-port` and logged in to Mixamo

## Install

```console
npm install -g github:eiei114/mixamocli   # installs the `mixamo` command
# or run from a checkout
node mixamo.mjs --help
```

The default CDP endpoint is `http://127.0.0.1:9223`; override it with `MIXAMO_CDP`.

## Commands

| command | what it does |
|---|---|
| `login` | Open the Mixamo login page in the CDP browser |
| `status` | Check CDP, the token, and the primary character |
| `token [--save] [--set <jwt>]` | Re-read the token from the browser, or store one you pass in |
| `chars [--query <text>] [--json]` | List characters (filtered locally; the API ignores its query parameter) |
| `char <name\|uuid>` | Switch the primary character, which sets the skeleton exports use |
| `search <text> [--limit N] [--page N] [--details] [--json]` | Search motions and motion packs |
| `show <id\|name>` | Duration, loopability, in-place support, and the export hash |
| `download <id\|name> --out DIR [options]` | Export one animation and download it |
| `batch <text> --out DIR [--limit N\|--all] [options]` | Export several search results in a row |

Export options: `--format fbx7_2019|fbx7_2019_ascii|fbx7_unity|fbx7_2014|fbx6|dae_mixamo`, `--skin true|false`, `--fps 24|30|60`, `--reducekf 0|1|2`, `--inplace`, `--mirror`, `--overdrive N`, `--trim 0-100`, `--params "0"`, `--char <uuid>`.

Every download is recorded in `MIXAMO_SOURCE.json` in the output folder (product id, options, character, source URL), including failures.

## Token

The token comes from `localStorage.access_token` of a Mixamo tab in the CDP browser. It is cached in `~/.config/mixamocli/credentials.json` (mode 600) and refreshed from the browser when the API rejects it. `MIXAMO_TOKEN` overrides the cache. `mixamo token` prints only the first 12 characters.

## Licensing of what you download

Mixamo characters and animations are free to use in your own projects, including commercial games, under Adobe's terms, but they cannot be redistributed on their own. This tool does not change those terms; read them before you ship.

## License

MIT
