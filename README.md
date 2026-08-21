# dcxv-cli

**Manage your DCXV servers, orders and payments from the terminal.** The command is `dcxv`.

![Linux · macOS · Windows](https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-informational)
![Single binary](https://img.shields.io/badge/install-single%20binary-brightgreen)
![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-blue)
![MIT license](https://img.shields.io/badge/license-MIT-green)

List and inspect servers, order cloud servers and Kubernetes clusters, run power actions,
reinstall an OS, manage snapshots, backups and ISO images, pay invoices, switch between
sub-accounts — and watch deployments stream live. Ships as a single self-contained binary with
no runtime to install.

```console
$ dcxv orders
ID    HOSTNAME  IP             TYPE   OS            CPU                   RAM  PRICE  STATUS
2481  web1      185.255.96.42  cloud  Ubuntu 24.04  Platinum 2.4-3.9 GHz  8    38     active
2482  gpu1      185.255.96.51  cloud  Ubuntu 24.04  Platinum 2.4-3.9 GHz  32   102    inactive

$ dcxv watch 2482
#2482 [##################------]  74% cloudinit
```

## Contents

- [What you can order](#what-you-can-order)
- [Install](#install)
- [Quick start](#quick-start)
- [Authentication](#authentication)
- [Commands](#commands)
- [Ordering a server](#ordering-a-server)
- [Using DCXV with an MCP client](#using-dcxv-with-an-mcp-client)
- [Examples](#examples)
- [Configuration](#configuration)
- [Shell completions](#shell-completions)
- [Contributing](#contributing)
- [License](#license)

## What you can order

DCXV runs Tier III data centres in Prague (CZ) and Covilhã (PT) on its own network, AS204057.

**Straight from the CLI:**

| Product | Command |
|---|---|
| [Cloud servers](https://dcxv.com/cloud-server) | `dcxv order --cluster … --vcpu 4 --ram 8 --disk 80 --ip 1 --yes` |
| [Kubernetes clusters](https://dcxv.com/k8s-kubernetes) | `dcxv order --type k8s --cluster … --yes` — k3s, k0s, MicroK8s or RKE2, installed for you |
| [Storage](https://dcxv.com/data-center#storage) | `dcxv order --set type=storage --set vol=5 --yes` (TB) |

**Priced on the website**, where the calculator lets you build the machine part by part:

- [Dedicated servers](https://dcxv.com/dedicated-server) — pick the chassis, CPUs, RAM, drives and
  RAID, and see the monthly price update as you go
- [AI / GPU servers](https://dcxv.com/gpu-server) — NVIDIA GPU builds for training and inference
- [IPv4 addresses](https://dcxv.com/ipv4) — buy, sell or lease blocks; DCXV is an approved broker
  for RIPE NCC, APNIC and ARIN

Configure one there, order it, then manage it from the CLI like anything else — `dcxv orders`,
`dcxv get <id>`, power actions, reinstalls and live progress all work the same regardless of how
the server was bought.

## Install

```bash
curl -fsSL https://dcxv.com/cli/install.sh | sh
```

Installs to `~/.local/bin/dcxv`. The script picks the right build for your machine, verifies it
against the published `SHA256SUMS`, and refuses to install on a mismatch.

Prefer to do it by hand? Download a binary from <https://dcxv.com/cli>, `chmod +x`, and put it on
your `PATH`:

| Platform | Asset |
|---|---|
| Linux x64 | `dcxv-linux-x64` |
| Linux ARM64 | `dcxv-linux-arm64` |
| macOS (Apple Silicon) | `dcxv-macos-arm64` |
| macOS (Intel) | `dcxv-macos-x64` |
| Windows x64 | `dcxv-windows-x64.exe` |

**Already have Node ≥ 18?** Run it without installing anything:

```bash
npx dcxv-cli --help
npm i -g dcxv-cli        # or install it globally, then just `dcxv`
```

The package is `dcxv-cli`; the command it installs is `dcxv`. Same JavaScript client — the
standalone binaries above simply bundle a runtime so you don't need one.

<details>
<summary>From source</summary>

Requires [Bun](https://bun.sh) or Node ≥ 18.

```bash
git clone https://github.com/dcxv-com/dcxv-cli.git && cd dcxv-cli
bun install && bun link      # puts `dcxv` on your PATH
```

</details>

## Quick start

```console
$ dcxv login                    # opens your browser to authorize this device
First, visit: https://dcxv.com/my/cli/A3F9-2B7C
Your code: A3F9-2B7C
Logged in. Saved to /home/you/.config/dcxv/config.json

$ dcxv orders                   # your servers
$ dcxv get 2481                 # one server in full
$ dcxv balance                  # balance + payment methods
```

## Authentication

```bash
dcxv login
```

Opens your browser so you can approve the device in a tab where you are already signed in, then
saves the token for you — nothing to paste. No polling: approval is pushed to the waiting CLI.

For CI or an SSH-only box, create a personal API token at <https://dcxv.com/my/api> and use it
directly:

```bash
dcxv login <token>          # saved to ~/.config/dcxv/config.json (chmod 600)
export DCXV_TOKEN=<token>   # or per-shell, nothing written to disk
```

### Profiles

Keep several accounts side by side:

```bash
dcxv login <token> --profile work
dcxv profile ls             # * marks the active one
dcxv profile use work       # or --profile / DCXV_PROFILE per command
dcxv profile rm work
```

## Commands

```
dcxv login [<token>]                 Authorize this device (or save a token directly)
dcxv whoami                          Authenticated account
dcxv account                         Full profile (org/address/language/currency/SSH key)
dcxv account set <field> <value>     Update a profile field
dcxv account export [outfile]        Download your account data as JSON
dcxv balance                         Balance + accepted payment methods

dcxv orders                          List servers/products      (alias: ls, list, products)
dcxv get <id>                        Full details: specs, live status, usage, IPs, access
dcxv get <id> ips                    IP / MAC / PTR table
dcxv get <id> stats                  Resource usage charts (CPU/RAM/Net/Disk)
dcxv get <id> snapshots|backups|iso  List snapshots / backups / ISOs
dcxv get <id> kubeconfig [file]      Download kubeconfig (Kubernetes clusters)

dcxv os [filter...]                  Available OS images
dcxv clusters [filter...]            Available clusters / price tiers
dcxv order --cluster … --vcpu …      Order a server (dry-run unless --yes)

dcxv set <id> power <cmd>            start | stop | shutdown | reset | pass
dcxv set <id> reinstall <os|id>      Reinstall the OS                   (--yes, --watch)
dcxv set <id> rename <hostname>      Rename the server
dcxv set <id> password [<pass>]      Set a password (generates one if omitted)
dcxv set <id> renew                  Renew now (charges balance)
dcxv set <id> autoprolong <on|off>   Toggle auto-renew
dcxv set <id> lock | unlock          Lock / unlock the server
dcxv set <id> notify-emails <e>      Expiration-notice recipients
dcxv set <id> mac <ip> <mac>         Set MAC for an IP
dcxv set <id> ptr <ip> <ptr>         Set PTR (rDNS) for an IP
dcxv set <id> upgrade <item> <val>   Change a resource / add-on
dcxv set <id> snap-add [name]        Create a snapshot
dcxv set <id> snap-restore <name>    Restore a snapshot                 (--yes)
dcxv set <id> snap-rem <name>        Delete a snapshot                  (--yes)
dcxv set <id> backup-add             Create a backup now
dcxv set <id> backup-restore <bid>   Restore a backup                   (--yes)
dcxv set <id> backup-rem <bid>       Delete a backup                    (--yes)
dcxv set <id> iso-mount <url> [file] Attach an ISO
dcxv set <id> iso-rm                 Detach the ISO                     (--yes)
dcxv rm <id>                         Delete the product                 (--yes)

dcxv tx [<id>]                       Transactions, or one in detail  (alias: txns, history)
dcxv tx <id> invoice [outfile]       PDF invoice (prints the URL, saves it if given a file)
dcxv pay [<method> <amount>]         Show methods, or create a payment
dcxv sub [ls|add|login|exit]         Manage / switch into sub-accounts
dcxv watch [<id>]                    Stream live deploy/task progress
dcxv console <id>                    Attach to the serial console (Ctrl-] to detach);
                                      --vnc opens the graphical console in a browser
dcxv completion <bash|zsh|fish>      Print a shell completion script
dcxv version                         Print the CLI version

dcxv mcp [--allow-write]             Run a local MCP server over stdio for an MCP-aware
         [--allow-billing]           agent (see "Using DCXV with an MCP client" below)
```

Two global flags matter everywhere:

- **`--json`** on any read command gives machine-readable output.
- **`--yes`** (`-y`) confirms anything that bills your account or destroys data. Without it,
  those commands refuse to run — and `dcxv order` prints a dry run instead of ordering.

Names accept a **word-by-word** match, so extra words narrow the result:

```bash
dcxv os windows 2022 en std        # -> Windows Server 2022 EN (Standard)
dcxv os windows 2022               # -> lists the candidates, refuses to guess
```

Anything ambiguous is an error listing the matches, never a guess. Numeric ids work everywhere a
name does.

## Ordering a server

```bash
dcxv clusters                      # pick a location / price tier
dcxv os ubuntu                     # pick an image

# dry run: prints exactly what would be ordered, charges nothing
dcxv order --cluster portugal --vcpu 4 --ram 8 --disk 80 --ip 1 --os ubuntu

# just the price
dcxv order --cluster portugal --vcpu 4 --ram 8 --disk 80 --ip 1 --os ubuntu --price

# order it, and stream provisioning until it is ready
dcxv order --cluster portugal --vcpu 4 --ram 8 --disk 80 --ip 1 --os ubuntu --yes --watch
```

When provisioning finishes, the access details and a ready-to-paste `ssh` command are printed
(`xfreerdp` for Windows images).

| Flag | Meaning |
|---|---|
| `--cluster <name\|id>` | Location / price tier — see `dcxv clusters` |
| `--vcpu <n>` | vCPU count |
| `--ram <n>` | RAM in GB |
| `--disk <n>` | Disk in GB |
| `--ip <n>` | Number of IPv4 addresses |
| `--os <name\|id>` | Image — see `dcxv os`. Omit for the newest supported Ubuntu |
| `--backup <0-7>` | `0`–`6` = copies per week, `7` = daily. Defaults to `0` |
| `--hostname <h>` | Optional — generated for you if omitted |
| `--price` | Print the price only, order nothing |
| `--watch` | With `--yes`, stream progress right after ordering |

The price is fetched from the API before submitting, so you never compute or pass it yourself.

<details>
<summary>Kubernetes clusters</summary>

```bash
dcxv order --type k8s --cluster portugal --vcpu 4 --ram 8 --disk 60 --ip 1 --yes
dcxv order --k8s rke2 --cluster portugal --vcpu 4 --ram 8 --disk 60 --ip 1 --yes
```

`--k8s` selects the distro: `K3S` (default), `K0S`, `K8S` (MicroK8s) or `RKE2`. The OS is chosen
for you, and `--vcpu`/`--ram`/`--disk` are raised to the enforced minimums (4 vCPU / 8 GB / 60 GB)
with a note if you ask for less. Fetch the kubeconfig once the cluster is up:

```bash
dcxv get <id> kubeconfig cluster.yaml
export KUBECONFIG=cluster.yaml && kubectl get nodes
```

</details>

<details>
<summary>Advanced: --set and --spec</summary>

Set any raw order field, or pass a whole JSON payload. Friendly flags win on conflict.

```bash
dcxv order --set cpu=8 --set ram=32 --yes
dcxv order --spec @order.json --yes
```

</details>

## Using DCXV with an MCP client

`dcxv mcp` runs a local [Model Context Protocol](https://modelcontextprotocol.io) server over
stdio, so an MCP-aware agent (Claude Code, Claude Desktop, etc.) can use this same
already-authenticated session — there is no hosted DCXV MCP endpoint and no separate login;
whatever `dcxv login` already saved is what the server uses.

Add it to your client's MCP config (Claude Code: `.mcp.json`; Claude Desktop:
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "dcxv": {
      "command": "dcxv",
      "args": ["mcp"]
    }
  }
}
```

**Tool tiers, gated by flag:**

| Tier | Flag | Tools |
|---|---|---|
| Public | (none) | `search_products`, `get_product`, `list_locations` — no login required |
| Read-only | (none, once logged in) | `whoami`, `get_account`, `balance`, `list_orders`, `get_order`, `list_os`, `list_clusters`, `list_transactions` |
| Write | `--allow-write` | `set_power`, `rename_order`, `lock_order`, `unlock_order` — reversible, never charges the account |
| Billing | `--allow-write --allow-billing` + `DCXV_MCP_ALLOW_BILLING=1` | `create_order` (price-check only unless `confirm: true`), `renew_order` |

`rm`, `pay`, `account set`/`export`, `sub login` and `watch` are **never** exposed as MCP
tools, at any flag combination — the same destructive/irreversible/streaming set this CLI
already treats carefully everywhere else. The billing tier needs both a flag and an
environment variable on purpose: a tool result can echo back free text you or a colleague
wrote (a server's hostname, notes, notice-to-client), which is a route for a malicious
instruction to reach an agent — a single flag isn't enough friction for anything that
charges your account.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}
```

## Examples

**Check your balance**

```console
$ dcxv balance
Balance: €500.00 EUR
  Payment methods: stripe, usdt
```

**Reinstall an OS** (erases the disk, so `--yes` is required)

```bash
dcxv set 2481 reinstall 'Ubuntu 24.04' --yes --watch
```

**Watch every deployment on the account**

```bash
dcxv watch
```

**Script against it with `--json`**

```bash
dcxv orders --json | jq -r '.[] | select(.active) | "\(.hostname)\t\(.ip)"'
dcxv get 2481 --json | jq .k8sStatus
```

**Pay an invoice**

```bash
dcxv pay stripe 100        # creates the payment and prints the pay link
dcxv tx                    # recent transactions
dcxv tx 900 invoice inv.pdf
```

**Manage sub-accounts** (resellers)

```bash
dcxv sub ls
dcxv sub add client@example.com "Client Name"
dcxv sub login 7           # work as that sub-account
dcxv sub exit              # back to your own
```

## Configuration

| Variable | Purpose |
|---|---|
| `DCXV_TOKEN` | API token, instead of logging in |
| `DCXV_URL` | Override the API base URL (default `https://dcxv.com`) |
| `DCXV_PROFILE` | Select a saved profile |
| `DCXV_INSTALL_DIR` | Install location for `install.sh` (default `~/.local/bin`) |
| `DCXV_WATCH_IDLE_SEC` | Seconds before `watch` reports that nothing is running |
| `DCXV_WATCH_SILENT_SEC` | Seconds before `watch` warns that no progress arrived |

Config lives in `~/.config/dcxv/config.json` (`chmod 600`), or `$XDG_CONFIG_HOME/dcxv/`.
A flag beats the environment, which beats the saved profile — so `--url` wins over `DCXV_URL`,
which wins over the profile's URL. The token has no flag: use `DCXV_TOKEN`, or `dcxv login` to
save one.

## Shell completions

```bash
source <(dcxv completion bash)          # bash
source <(dcxv completion zsh)           # zsh
dcxv completion fish > ~/.config/fish/completions/dcxv.fish
```

## Notes

- The serial console is exposed as `dcxv console <id>`; the graphical (VNC) console still needs
  a browser window, so `dcxv console <id> --vnc` opens it there instead of rendering it here.
- Sensitive account changes (password, PIN, 2FA, account closure) are left to the web app.

## Contributing

Bug reports and patches are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development
setup, test suites and release process.

## Support

- Docs and downloads: <https://dcxv.com/cli>
- Support: <support@dcxv.com> · Sales: <sales@dcxv.com>

## License

[MIT](LICENSE) © DCXV INTERNATIONAL LTD
