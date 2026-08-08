# Contributing

Thanks for looking. This file holds the development detail that used to clutter the README.

## Setup

Requires [Bun](https://bun.sh) (runtime, package manager and test runner) or Node ≥ 18.

```bash
bun install
bun test                  # full suite
bun bin/dcxv.js --help   # run from source without installing
```

`src/cli.js` is dependency-injected — `run(argv, deps)` takes its client, config and output
sinks as arguments — so every command is unit-testable with a fake client and captured output,
with no network and no files touched.

## Layout

| Path | Purpose |
|---|---|
| `bin/dcxv.js` | Entry point; wires real dependencies into `run()` |
| `src/cli.js` | Command dispatch, flag parsing, all handlers |
| `src/client.js` | GraphQL over HTTP + live subscriptions over SSE |
| `src/queries.js` | Every GraphQL operation the CLI can send |
| `src/config.js` | Profile/token storage in `~/.config/dcxv/` |
| `src/output.js` | Pure formatters: tables, key/values, progress bars, sparklines |
| `test/` | `bun test` suites |

## Tests

```bash
bun test                              # everything
bun test test/schema-sync.test.js     # one file
```

Beyond the per-command tests, two suites exist to catch **drift** rather than logic errors,
because drift is what has actually broken this CLI in practice:

- **`test/schema-sync.test.js`** type-checks every operation in `src/queries.js` against the
  real server schema. It skips itself when the backend isn't checked out alongside, so a
  standalone clone stays green. This catches a misspelled field, a wrong argument type, or the
  wrong input-argument name — none of which fail loudly at runtime (see [API
  behaviour](#api-behaviour-worth-knowing)).
- **`test/release-sync.test.js`** asserts the version in `src/version.js`, `package.json` and
  `--help` agree, that every OS/arch pair `install.sh` can derive is actually built by
  `scripts/build.sh`, that the README documents each platform, and that `--help` and the three
  shell completions list the same commands.

When adding a query, register it in the test harness's `NAME_BY_QUERY` map — an unmapped
operation is a hard failure by design, so the fixtures double as a record of which calls each
command makes.

## API behaviour worth knowing

These are not obvious and have each caused a real bug:

- **A `null` payload means the action did not happen.** In production the API masks resolver
  exceptions by returning `null` for the whole field; authorization failures and a locked product
  look identical. Treat `null` as an error, never as success — checking only `err` is what once
  made a rejected reinstall print "Reinstall started" and then hang forever under `--watch`.
- **Requesting an unknown field nulls the entire response**, rather than returning an error for
  that field. Keep `src/queries.js` matched to the real schema; `schema-sync` enforces it.
- **The input argument is `inp:`, not `input:`.** Some API docs say otherwise; a mismatch returns
  an empty `200` body with no error.
- **Progress is push-only.** Nothing polls. `watch` therefore reads the current progress once on
  attach — a watcher that connects between two events would otherwise sit blank with no way to
  distinguish "nothing running" from "broken" — and only resolves after any completion callback
  has finished, or the process exits before printing post-deploy details.
- **Known gap**: the price endpoint only prices cloud and storage products. For other types it
  echoes the submitted price back, so `dcxv order --price --set type=dedi` reports `Price: 0.00`.
  Custom dedicated configurations can't be ordered through the API at all.

## Building

```bash
bun run build       # single binary for this platform -> dist/dcxv
bun run build:all   # all 5 targets + dist/SHA256SUMS
```

`dist/dcxv` is a compiled snapshot, not a launcher for `src/` — rebuild after changing source
before testing the executable. `build:all` stamps `src/version.js` from `package.json` first, so
a published binary and `dcxv version` can never disagree.

## Releasing

1. Bump `version` in `package.json`.
2. `bun test` must be green, then `bun run build:all`.
3. Publish `dist/dcxv-*` and `dist/SHA256SUMS` to <https://dcxv.com/cli/> so `install.sh` can
   fetch them.
4. Update the version on the download page. `release-sync` fails if it drifts from
   `package.json`.

### npm

The package publishes as `dcxv`, so `npx dcxv` runs the CLI on any machine with Node ≥ 18 —
the plain JavaScript client, not the compiled binary. `files` keeps the tarball to `bin/`,
`src/` and the README (~36 kB, 10 files); tests, scripts and `dist/` are excluded.

```bash
npm publish --dry-run    # inspect the tarball; must warn about nothing but being logged out
npm publish
```

Keep the version in step with the binaries: publish from the same commit you tagged and built,
so `npx dcxv version` and the downloadable binary agree.

Two things to know if you touch this:

- `bin` must be `bin/dcxv.js` **without** a `./` prefix. npm rewrites `./bin/dcxv.js` on publish
  and warns that it "was invalid and removed"; the entry survives, but keep the canonical form so
  the warning stays gone (`npm pkg fix` does it for you).
- `npx dcxv` needs Node, because it runs `src/` directly. If you ever want `npx` to fetch the
  *compiled* binary instead, that means per-platform packages (`@dcxv/cli-linux-x64` and friends,
  each with `os`/`cpu` set) as `optionalDependencies` of a small launcher — the model esbuild uses.
  A `postinstall` downloader is the other option, but it breaks under `npm ci --ignore-scripts`
  and in sandboxed installs. Neither is worth it while the client is a few files of JavaScript
  with one dependency.

## Style

- Match the surrounding code: no semicolons, 2-space indent, single quotes.
  (`bun run lint` exists but has no ESLint config in this package yet, so it currently fails —
  adding one would be a welcome patch.)
- Comment the *why*, not the *what* — especially for anything that looks removable but isn't.
- User-facing failures should be actionable: say what was rejected and what to run instead.
- Never print a success message for something that might not have happened.
