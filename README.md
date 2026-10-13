# paradigma-cli

SEO and AI search monitoring that your coding agent sets up and runs from your repository.

`paradigma-cli` is the open-source command line for [Paradigma](https://paradigma.click). The npm package is `paradigma-cli`; the installed command is `paradigma`.

```sh
npx paradigma-cli init
```

Run it inside the git repository of your Next.js site. `init` signs you in, finds the repository from `git remote` and the app from the current directory, waits for the Paradigma GitHub App if it is not installed yet (it prints the install link), infers the production URL and brand from the code (`metadataBase` and `title` in `app/layout`, `vercel.json`, `package.json`, README) and asks you to confirm, creates the project and verifies the domain. If the domain is not verified yet, it opens a PR that adds `public/.well-known/paradigma-verification.txt` (or leaves the file in your checkout when `gh` is not available) and prints the command to verify after the deploy. Running `init` again resumes where it stopped.

If you copied the setup prompt from the Paradigma dashboard (Onboarding → *Set up with your AI agent*), it includes a one-time token: `npx paradigma-cli init --token pdg_setup_…`. Without a token, `init` pairs this machine with a code you confirm in the browser.

Requirements: Node 20+, `git`, and the GitHub CLI (`gh auth login`) for pull requests.

## Commands

| Command | What it does |
| --- | --- |
| `init [--token T] [--server URL] [--url U] [--brand B] [--category C] [--use-case U] [--app-root P] [--mcp claude\|codex\|cursor\|none] [--yes] [--no-pr] [--wait S] [--json]` | Full setup, idempotent |
| `status [--json]` | Account checklist, local runner config and server policy |
| `links [--json]` | Hand-off links: GitHub App, Search Console, GA4, Slack, billing |
| `projects list\|create\|update [--project ID] [--url …] [--brand …] [--category …] [--use-case …]` | Manage projects |
| `verify [--method dns\|file\|meta]... [--project ID]` | Check domain ownership (exit 3 while unverified) |
| `audit [--project ID]` | Request a production audit |
| `sync gsc\|bing\|ga4\|performance\|plausible\|posthog` | Request a data sync |
| `connect <provider> [--key-env NAME]` | Store a key: `bing`, `crux`, `plausible`, `posthog --region us\|eu --posthog-project ID`, `gemini`, `openai`, `anthropic`, `perplexity`, `dataforseo --login L [--location 2840] [--language en]` |
| `geo prompts [list\|add "TEXT"]` | GEO questions |
| `geo schedule --engine E --daily 1\|3\|5\|10 --accept-charges` / `--off` | Automatic sampling on your provider key |
| `geo sample --engine E --prompt ID --accept-charges` | One manual sample on your provider key |
| `alerts budget 0\|1\|2\|3 [--org ID]` | Weekly alert budget (organization owner) |
| `billing checkout --plan pro\|agency` / `billing portal` `[--open]` | Prints the hosted Stripe URL |
| `autopilot level 0\|1\|2\|3` / `autopilot pause [--reason R]` / `autopilot resume` | Server-side Autopilot policy for the repository (all runners); level 0 needs `--confirm-full-autopilot` |
| `mcp install --agent claude\|codex\|cursor` | Connects the Paradigma MCP server to your agent |
| `setup [--server URL] [--name NAME] [--repo o/n=PATH]... [--clone] [--agent A] [--schedule --hour H]` | Pair this machine as an Autopilot runner (device code) |
| `run [--once] [--dry-run] [--agent claude\|codex\|cursor] [--max N] [--keep-worktrees] [--skip-checks]` | Claim and process Autopilot tasks |
| `repos [set owner/name PATH \| scan [--clone]]` | List or change repository mappings |
| `schedule install\|uninstall\|print [--hour H] [--minute M]` | Daily run via launchd, systemd user timer or schtasks |
| `pause` / `resume` | Local kill switch for this machine only |
| `doctor` | Checks git, gh, agents, server, token and pinned key |
| `logout` | Removes the credential from this machine |

Commands that need a project use `--project`, else the project of the current checkout, else the one `init` chose, else the only one. Organization commands use `--org` or the project's organization.

### For agents

Everything is flag-driven and machine-readable:

```sh
npx paradigma-cli init --token … --yes --json \
  --url https://acme.com --brand Acme \
  --category "Analytics software" --use-case "Track product usage" \
  --mcp claude
```

With `--json`, `init` prints one JSON event per line (`step`, `needs_input`, `done`); other commands print one JSON object, and failures also print `{"ok":false,"error":code,"message":…}`. Exit codes: `0` ok, `1` failed, `2` usage, `3` needs the person or more input (missing fields, GitHub App not installed yet, domain not verified yet).

## Privacy and safety

- **File contents and diffs never reach Paradigma's servers.** The CLI reads your checkout locally. Autopilot edits run with your own agent on your machine; the server only receives metadata: agent name and version, changed paths, line counts, check results, the review verdict with short reasons, and error codes. Your agent provider and GitHub (through your own `git` and `gh`) see what they normally see.
- **Secrets stay out of arguments and logs.** API keys are read from stdin or from an environment variable named with `--key-env`, never from command-line arguments, and are never printed or returned by the server.
- **Signed tasks only.** Pairing pins the server's Ed25519 public key. Every Autopilot task must verify against that key, be addressed to this runner and be unexpired, or it is ignored.
- **Guard rails on every change.** Changed paths must match the task's allowed paths; manifests, lockfiles, CI, `.env*`, git and agent config are never allowed; a diff budget is enforced; added lines are scanned for secrets.
- **No charges without consent.** GEO samples and schedules run on your own provider account and need `--accept-charges` every time.

## Use with your AI agent

This repository also ships the Paradigma skill and plugin manifests, so your agent knows how to set up and operate Paradigma through the CLI and the hosted MCP server (`https://paradigma.click/api/mcp`).

Claude Code:

```
/plugin marketplace add Paradigma-click/paradigma-cli
/plugin install paradigma@paradigma-cli
/reload-plugins
```

Then authorize the Paradigma MCP server when prompted (`/plugin` → Installed → Paradigma).

Cursor, Codex CLI and others: `npx skills add Paradigma-click/paradigma-cli`, or add `https://paradigma.click/api/mcp` as a remote MCP connector (`npx paradigma-cli mcp install --agent claude|codex|cursor` does this for you) and copy `skills/paradigma/` into your skills directory.

Then ask your agent:

> Set up Paradigma in this repo.

What is in this repository:

- `src/`: the CLI. `src/contract/` holds the wire contract shared with the Paradigma server.
- `skills/paradigma/SKILL.md`: when and how an agent uses Paradigma, and the rules it follows.
- `skills/paradigma/references/tools.md`: MCP tools by permission, CLI commands, error and exit codes.
- `skills/paradigma/.mcp.json`: the hosted MCP server.
- Plugin manifests for Claude Code (`.claude-plugin`), Cursor (`.cursor-plugin`) and Codex (`plugins/paradigma`, `.agents`).

## Autopilot runner

Every day the runner asks the Paradigma server for signed SEO/GEO tasks, applies them with **your own** coding agent (Claude Code, Codex or Cursor Agent, on your subscription), runs your repo's checks, has the agent review its own diff, and then saves a patch, opens a PR or requests an auto-merge, using your own `git` and `gh` credentials.

```sh
npm i -g paradigma-cli      # Node 20+, git and the GitHub CLI (gh auth login)
paradigma init              # or: paradigma setup (device pairing only)
paradigma run --dry-run     # shows what would run
paradigma schedule install --hour 9
```

Repositories are matched to local clones by their `origin` remote under `~/code`, `~/projects`, `~/dev`, `~/src`, `~/Developer`, `~/Documents/GitHub`, the current directory and its parent. Override with `--repo owner/name=PATH` or `paradigma repos set owner/name PATH`, or pass `--clone` to clone missing ones into `~/.paradigma/repos`.

What a run does per task:

1. Fetches `origin/<default branch>` and creates a worktree on `paradigma/autopilot/<task id prefix>` under `~/.paradigma/worktrees`.
2. Runs the agent with restricted tools (Claude Code: `Read,Edit,Write,Glob,Grep`, no Bash or web; Codex: `workspace-write` sandbox, approvals off; Cursor: print mode with its sandbox on), stdin closed and a 15 minute timeout. Revert tasks use `git revert` of the PR's merge commit, without the agent.
3. Guards: allowed paths, protected files, diff budget and secret scan (see above).
4. Checks: `lint`, `typecheck`, `test` and `build` scripts (dependencies are installed with the frozen lockfile if missing). A check that also fails on the base commit is recorded as skipped. Override per repo with `"checks": {"<repoId>": ["make test"]}` in `~/.paradigma/config.json`.
5. Self-review: the agent reads the diff locally and answers approved or rejected. One retry; rejected twice becomes a local patch.
6. Publish by task mode: `notify` saves `~/.paradigma/patches/<task>.patch`; `pull_request` commits, pushes and runs `gh pr create`; `auto_merge` also runs `gh pr merge --auto --squash` (branch protection still applies), and only for low-risk categories with passing checks and an approved review, unless you chose Full autopilot.

Heartbeats run every 60 s; if the server cancels the task or the lease is lost, the agent is stopped and the worktree removed.

## Environment

- `PARADIGMA_HOME`: config directory (default `~/.paradigma`, mode 0700; the config file is 0600).
- `PARADIGMA_SERVER`: server used by `init` and `setup` (default `https://paradigma.click`).
- `PARADIGMA_AGENT_COMMAND`: custom agent command. It receives the prompt file path as its last argument and `PARADIGMA_AGENT_MODE=edit|review`.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test        # unit and end-to-end tests (temp git repos, fake gh/claude, fake API)
pnpm build       # bundles src/index.ts to dist/paradigma.mjs
node dist/paradigma.mjs --help
```

The real-agent end-to-end test runs only with `REAL_AGENT=claude` or `REAL_AGENT=codex` set. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[MIT](LICENSE)
