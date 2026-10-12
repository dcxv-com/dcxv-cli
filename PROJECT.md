# dcxv-cli

`dcxv`: terminal client for the DCXV GraphQL API (servers, orders, payments, live deploy progress, local MCP server). Package `dcxv-cli` (bare `dcxv` is rejected by npm similarity check, don't retry), command `dcxv`, MIT, version in `package.json` (+ `src/version.js`). Deps: `graphql-sse`, `ws`. `README.md` is the user-facing doc (install, commands, ordering, MCP tiers, env); it is shipped to npm and read by `test/release-sync.test.js`, so keep it. Code style: no semicolons, 2-space, single quotes; comment the why; never print success for something that may not have happened; failures must say what to run instead.

## Layout
| Path | Purpose |
|---|---|
| `bin/dcxv.js` | entry; wires real deps into `run()` |
| `src/cli.js` | dispatch, flag parsing, all handlers; dependency-injected `run(argv, deps)` (client, config, output sinks) so commands are testable with fakes |
| `src/client.js` | GraphQL over HTTP + live subscriptions over SSE; reads `DCXV_TOKEN` |
| `src/queries.js` | every GraphQL operation |
| `src/config.js` | profiles/token in `~/.config/dcxv/config.json` (0600, or `$XDG_CONFIG_HOME`); `DCXV_PROFILE` |
| `src/output.js` | tables, key/values, progress bars, sparklines |
| `src/console.js`, `src/browser.js`, `src/mcp.js` | serial console (`/api2/json/...` hardcoded, api-kvm contract), browser open (login, `--vnc`), MCP stdio server |
| `scripts/` | `build.sh`, `install.sh`, `package-brew-choco.sh`; `packaging/{homebrew,chocolatey}` templates; `server.json` = MCP registry manifest (`mcpName com.dcxv/dcxv-cli`) |

## Behaviour rules
- API host fixed at `https://dcxv.com`; `--url`/`DCXV_URL` removed (error, not no-op); `url` in config ignored.
- `--json` on reads; `--yes/-y` required for anything billing or destructive (`order` dry-runs without it). Name args match word-by-word; ambiguity is an error listing matches.
- Env: `DCXV_TOKEN`, `DCXV_PROFILE`, `DCXV_INSTALL_DIR` (install.sh, default `~/.local/bin`; `DCXV_BASE_URL` default `https://dcxv.com/cli`), `DCXV_WATCH_IDLE_SEC`, `DCXV_WATCH_SILENT_SEC`, `DCXV_MCP_ALLOW_BILLING`.
- MCP tiers: public/read-only always; write (`set_power`, rename, lock/unlock) needs `--allow-write`; billing (`create_order` price-check unless `confirm`, `renew_order`) needs `--allow-write --allow-billing` AND `DCXV_MCP_ALLOW_BILLING=1`. `rm`, `pay`, `account set/export`, `sub login`, `watch` never exposed.
- k8s order: `--k8s K3S|K0S|K8S|RKE2`, minimums 4 vCPU / 8 GB / 60 GB raised with a note.

## API gotchas (each caused a real bug)
- A `null` payload means the action did not happen (prod masks resolver exceptions as `null` for the whole field; auth failure and locked product look identical). Treat as error.
- Requesting an unknown field nulls the whole response; keep `queries.js` in sync with schema.
- Input argument is `inp:`, not `input:` (mismatch -> empty 200).
- Progress is push-only: `watch` reads current progress once on attach and resolves only after completion callbacks finish.
- Known gap: price endpoint prices only cloud and storage; other types echo the submitted price (`--set type=dedi` -> `Price: 0.00`); custom dedicated can't be ordered via API.

## Tests
`bun test` (or one file). `schema-sync.test.js` type-checks `queries.js` against the real server schema (skips if backend not alongside). `release-sync.test.js`: versions in `src/version.js`/`package.json`/`--help` agree, every install.sh OS/arch is built by `build.sh`, README lists each platform, `--help` and the 3 shell completions list the same commands. New query -> register in harness `NAME_BY_QUERY` (unmapped = failure by design). Other suites: cli, client, config, console, format, login, mcp.

## Build / release
- `bun run build` -> `dist/dcxv` (compiled snapshot, rebuild before testing the binary); `build:all` -> 5 targets (linux x64/arm64, macos arm64/x64, windows x64) + `dist/SHA256SUMS`, stamps `src/version.js`.
- `./deploy.sh [patch|minor|major]` (default minor): bump, build, commit, push, published (not draft) GitHub Release with binaries. Irreversible (triggers npm, brew, choco): check the tree first. Manual: publish `dist/dcxv-*` + `SHA256SUMS` to dcxv.com/cli/ (install.sh fetches from there) and update the download page version (release-sync fails on drift).
- npm: CI `.github/workflows/publish.yml` on release published (`bun test`, tag == version check, `npm publish --provenance`) via Trusted Publishing (OIDC, no `NPM_TOKEN`; trusted publisher set on npmjs.com for repo `dcxv-com/dcxv-cli`, workflow `publish.yml`). `files`: bin, src, README.md. `engines.node >=20` (README says >=18: stale). `bin` must be `bin/dcxv.js` without `./`. `npx` needs Node (runs `src/`); compiled-binary npx would need per-platform optionalDependencies packages (not worth it).
- Homebrew + Chocolatey: `.github/workflows/packages.yml` (same trigger) downloads release assets, `scripts/package-brew-choco.sh` stamps version + checksums into templates. Brew pushes `Formula/dcxv.rb` to `dcxv-com/homebrew-tap` (secret `TAP_REPO_TOKEN`); choco `choco pack` + push (secret `CHOCO_API_KEY`; first submission of a new id goes through manual moderation). Run the script locally after `build:all` to inspect output.
- Lint: `bun run lint` fails (no ESLint config in this package): open.
