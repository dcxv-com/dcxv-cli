# dcxv-cli

`dcxv`: terminal client for the DCXV GraphQL API (servers, orders, payments, live deploy progress, local MCP server). npm package `dcxv-cli` (bare `dcxv` is rejected by npm's similarity check), MIT, deps `graphql-sse`, `ws`. Version in `package.json` + `src/version.js`. `README.md` is the user doc, shipped to npm and checked by `test/release-sync.test.js`.

Rules: never print success for something that may not have happened; a failure says what to run instead.

## Layout

- `bin/dcxv.js` entry, wires real deps into `src/cli.js` `run(argv, deps)` (dispatch, flags, all handlers; injected client / config / output so tests use fakes).
- `src/client.js` GraphQL over HTTP + subscriptions over SSE. `src/queries.js` every operation. `src/config.js` profiles in `~/.config/dcxv/config.json` (0600, honours `$XDG_CONFIG_HOME`); token = `DCXV_TOKEN` > profile `subToken` > `token`.
- `src/output.js` (`NO_COLOR`), `src/console.js` serial console (`/api2/json/...` hard-coded: api-kvm contract), `src/browser.js` (`tryOpenBrowser` for login / `--vnc`), `src/mcp.js` MCP stdio server. `packaging/` brew / choco templates; `server.json` MCP registry manifest.

## Behaviour

- API host fixed `https://dcxv.com`; `--url` / `DCXV_URL` is an error, config `url` ignored.
- `--json` on reads; `--yes/-y` required for billing or destructive actions (`order` dry-runs without it). Name args match word-by-word; ambiguity errors with the matches.
- Env: `DCXV_TOKEN`, `DCXV_PROFILE`, `DCXV_WATCH_IDLE_SEC`, `DCXV_WATCH_SILENT_SEC`, `DCXV_MCP_ALLOW_BILLING`; install.sh `DCXV_INSTALL_DIR` (`~/.local/bin`), `DCXV_BASE_URL` (`https://dcxv.com/cli`).
- MCP tiers: read-only always; write (`set_power`, rename, lock/unlock) needs `--allow-write`; billing (`create_order`, price-check unless `confirm`; `renew_order`) needs `--allow-write --allow-billing` AND `DCXV_MCP_ALLOW_BILLING=1`. Never exposed: `rm`, `pay`, `account set/export`, `sub login`, `watch`.
- k8s order `--k8s K3S|K0S|K8S|RKE2`: minimums 4 vCPU / 8 GB / 60 GB, raised with a note.

## API gotchas

- `null` payload = action did not happen (prod masks resolver errors as `null`; auth failure and locked product look the same): treat as error.
- An unknown field nulls the whole response: keep `queries.js` in sync with the schema.
- Input argument is `inp:`, not `input:` (mismatch -> empty 200).
- Progress is push-only: `watch` reads current progress once on attach, resolves after completion callbacks finish.
- Price endpoint prices only cloud and storage; other types echo the submitted price (`--set type=dedi` -> `Price: 0.00`); custom dedicated cannot be ordered via API.

## Tests

`bun test`. `schema-sync.test.js` checks every `queries.js` export against `../api-my` SDL (skips without it); a new query must also be mapped in `NAME_BY_QUERY` of `cli.test.js` / `mcp.test.js`. `release-sync.test.js` keeps versions, `build.sh` / install.sh targets, README platforms, `--help` and the 3 shell completions in agreement.

## Build / release

- `bun run build` -> `dist/dcxv` (compiled snapshot: rebuild before testing the binary); `build:all` -> linux x64/arm64, macos arm64/x64, windows x64 + `dist/SHA256SUMS`, stamps `src/version.js`.
- `./deploy.sh [patch|minor|major]` (default minor): bump, build, commit, push, GitHub Release. Irreversible (triggers npm, brew, choco). Then manually put `dist/dcxv-*` + `SHA256SUMS` on dcxv.com/cli/ (install.sh source) and bump the download page version.
- On release: `.github/workflows/publish.yml` (test, tag == version, `npm publish --provenance` via OIDC Trusted Publishing, no `NPM_TOKEN`); `packages.yml` runs `scripts/package-brew-choco.sh` -> `dcxv-com/homebrew-tap` `Formula/dcxv.rb` (`TAP_REPO_TOKEN`) and choco push (`CHOCO_API_KEY`). `bin` must be `bin/dcxv.js` without `./`; `npx` runs `src/` under Node.

## Open

- `engines.node >=20` but README says Node >= 18.
- `bun run lint` fails: no ESLint config in this package.
