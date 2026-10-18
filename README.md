# paradigma-cli

SEO and AI search monitoring that your coding agent sets up and runs from your repository.

`paradigma-cli` is the open-source command line for [Paradigma](https://paradigma.click). The npm package is `paradigma-cli`; the installed command is `paradigma`.

```sh
npx paradigma-cli init
```

Run it inside the git repository of your site (Next.js, Astro, SvelteKit, Hugo, plain HTML or any other framework). `init` signs you in, finds the repository from `git remote` and the app from the current directory, waits for the Paradigma GitHub App if it is not installed yet (it prints the install link), infers the production URL and brand from the code (`metadataBase` and `title` in `app/layout`, `vercel.json`, `package.json`, README) and asks you to confirm, creates the project, checks that merges reach production (see `doctor deploy` below), verifies the domain and waits for the first site scan (up to `--wait` seconds, 3 minutes by default) to print the four scores and the top 3 fixes. If the domain is not verified yet, it opens a PR that adds `public/.well-known/paradigma-verification.txt` (or leaves the file in your checkout when `gh` is not available) and prints the command to verify after the deploy. Running `init` again resumes where it stopped.

If you copied the setup prompt from the Paradigma dashboard (Onboarding → *Set up with your AI agent*), it includes a one-time token: `npx paradigma-cli init --token pdg_setup_…`. Without a token, `init` pairs this machine with a code you confirm in the browser.

Requirements: Node 20+, `git`, and the GitHub CLI (`gh auth login`) for pull requests.

## Commands

| Command | What it does |
| --- | --- |
| `check seo\|aeo\|geo\|agents <domain> [--json] [--rescan]` | Free check of one pillar, no sign-in: score, label, what to fix first and the suggestions count. `--json` prints the public API JSON. Exit 3 when rate-limited |
| `check risk <domain> [--json]` | The penalty risk checker: practices Google, Bing and AI engines punish, each with its evidence, affected pages, a fix and the policy. Private to you, never cached; one free use per 30 days, or 30 an hour for your own projects when signed in. Exit 3 when the free use is spent |
| `check all [--project ID] [--wait S] [--json]` | All four pillars of your project (signed in): the scores, pass/partial/fail counts and what to fix first, from the latest scan. With no completed scan yet it requests one and waits up to `--wait` seconds (180). Exit 3 while the scan still runs, 1 if it failed |
| `init [--token T] [--server URL] [--url U] [--brand B] [--category C] [--use-case U] [--app-root P] [--mcp claude\|codex\|cursor\|none] [--yes] [--fix-deploy] [--no-pr] [--wait S] [--level 0\|1\|2\|3 [--confirm-full-autopilot]] [--json]` | Full setup, idempotent. Runs the deploy doctor after creating the project; `--fix-deploy --yes` lets it run `vercel git connect` (otherwise it only reports what it would run). `--level` turns Autopilot on for the repository (asked after the scan in a terminal); fixes are made by the Paradigma agent, hosted or in your GitHub Actions |
| `doctor deploy [--json] [--fix [--yes]] [--app-root P]` | How the site is published and whether a merged PR goes live (exit 3 when it does not). See [Deploys](#deploys) |
| `status [--json]` | Account checklist and this machine's sign-in |
| `links [--json]` | Hand-off links: GitHub App, Search Console, GA4, Slack, billing |
| `projects list\|create\|update [--project ID] [--url …] [--brand …] [--category …] [--use-case …]` | Manage projects |
| `verify [--method dns\|file\|meta]... [--project ID]` | Check domain ownership (exit 3 while unverified) |
| `tasks [--project ID \| --repo owner/name] [--all] [--json]` | The project's tasks with counts: status, title, PR link. Defaults to the project of the current checkout, else every project; `--all` adds finished ones. `--json` prints the API response (`{projects: [{project, counts, tasks}]}`) |
| `tasks start <task id> [--checkout] [--json]` | Takes a task for your current agent and prints its brief: branch to create, allowed paths, diff budget, acceptance criteria, instructions and the finish commands. `--checkout` creates the branch from the default branch when the current directory is a clean clone of the task's repository |
| `tasks finish <task id> --pr URL \| --done \| --skip --reason R \| --failed --reason R` / `tasks release <task id>` | Closes a started task (the PR must be a github.com pull request URL; the reason is one line of at most 200 characters), or gives it back to the queue |
| `tasks prompt [--project ID] [--copy]` | The prompt that hands a project's open tasks to an agent; `--copy` puts it on the clipboard (pbcopy, wl-copy, xclip or xsel) |
| `audit [--project ID]` | Request a production audit |
| `sync gsc\|bing\|ga4\|performance\|plausible\|posthog` | Request a data sync |
| `indexnow [status\|setup\|on\|off] [--project ID]` | IndexNow: opens the key-file PR, then each production deploy tells Bing, Yandex, Naver, Seznam and Yep (not Google) which pages changed; `status` shows recent deploys (exit 3 until the key file is live) |
| `index [--project ID]` / `index requested <url>...` / `index check` | Google index coverage (URL Inspection on your own Search Console connection) and today's up to 10 pages to request, each with its Search Console link where you click "Request indexing"; mark them as requested; run today's inspection batch now |
| `connect bing [--project ID]` | Connect Bing Webmaster Tools with the Microsoft consent in the browser (no key to copy); the CLI waits for it. `--key-env NAME` or a piped key uses an API key instead |
| `connect ai [--project ID \| --all] [--yes] [--own]` | AI visibility. On Pro and Agency it is included: Paradigma samples Gemini, OpenAI, Claude, Perplexity, Google AI Overviews and AI Mode on its own accounts, so there is nothing to connect. With `--own` (or on other plans) it connects AI keys already in the environment (names shown, never values), then one OpenRouter consent covers the missing engines; your own keys then take over and bill your accounts |
| `connect <provider> [--key-env NAME]` | Store a key: `bing`, `crux`, `plausible`, `posthog --region us\|eu --posthog-project ID`, `gemini`, `openai`, `anthropic`, `perplexity`, `dataforseo --login L [--location 2840] [--language en]` |
| `geo prompts [list\|add "TEXT"]` | GEO questions |
| `geo schedule --engine E --daily 1\|3\|5\|10 --accept-charges` / `--off` | Automatic sampling on your provider key |
| `geo sample --engine E --prompt ID --accept-charges` | One manual sample on your provider key |
| `alerts budget 0\|1\|2\|3 [--org ID]` | Weekly alert budget (organization owner) |
| `billing checkout --plan pro\|agency` / `billing portal` `[--open]` | Prints the hosted Stripe URL |
| `autopilot level 0\|1\|2\|3` / `autopilot pause [--reason R]` / `autopilot resume` | Server-side Autopilot policy for the repository; level 0 needs `--confirm-full-autopilot` |
| `autopilot default 0\|1\|2\|3\|off [--org ID]` | Workspace default level for every repository that follows it, new ones included; needs write access to every repository, level 0 needs `--confirm-full-autopilot` |
| `autopilot follow-default [--repo owner/name]` | The repository follows the workspace default again (`autopilot level` makes it keep its own) |
| `mcp install --agent claude\|codex\|cursor` | Connects the Paradigma MCP server to your agent |
| `fix --task <token> [--api-url URL] [--build CMD] [--test CMD]` | Runs one fix that Paradigma dispatched to your GitHub Actions workflow; the Paradigma GitHub Action calls it. See [GitHub Action](#github-action) |
| `doctor` | Setup checks: Node, git, sign-in, the server and its pinned key |
| `logout` | Removes the CLI credential from this machine |

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

## Project tasks

Each project keeps its own list of tasks: the fixes the site scan and the checks found. The Paradigma agent makes the fixes, hosted or in your GitHub Actions (see [GitHub Action](#github-action)), within your plan's fix allowance. Tasks that need a person show as "needs you"; do those with the agent you are talking to:

```sh
npx paradigma-cli init                         # add the repository, verify, first scan
paradigma tasks                                # this checkout's project and its tasks
paradigma tasks start <task id> --checkout     # brief + branch; the agent edits and opens a PR
paradigma tasks finish <task id> --pr https://github.com/owner/repo/pull/123
paradigma tasks prompt --copy                  # or hand all open tasks to your agent at once
```

`tasks start` leases the task (Paradigma's agent will not take it meanwhile) and prints what the agent needs: the branch, the paths it may change, the diff budget, the acceptance criteria and the instructions, then the exact `finish` (`--pr`, `--done`, `--skip --reason`, `--failed --reason`) and `release` commands. A project whose domain is not verified yet is locked (exit 3, verify first); a task already running answers 409.

## Deploys

Paradigma's fixes arrive as pull requests. They only reach your live site if a merge to the default branch deploys. That is not the case when the hosting project is not connected to Git, for example a Vercel project deployed with `vercel deploy` from a laptop.

```sh
npx paradigma-cli doctor deploy          # human report
npx paradigma-cli doctor deploy --json   # for agents
npx paradigma-cli doctor deploy --fix    # runs `vercel git connect` after asking (--yes to skip the question)
```

It finds the host from files only, never running project code: `.vercel/project.json`, `.vercel/repo.json` and `vercel.json` (Vercel), `netlify.toml` and `.netlify/state.json` (Netlify), `wrangler.toml`/`wrangler.json[c]` (Cloudflare), deploy workflows in `.github/workflows/` (GitHub Pages, Vercel, Netlify, Cloudflare, Fly.io or a custom `deploy` job), `fly.toml`, `render.yaml` and `Dockerfile`. A workflow that deploys on push counts as deploying merges.

Then it checks the host with your own CLI login. The CLI never reads, passes or prints your token:

- **Vercel**: `vercel api /v9/projects/<id>` (Git link) and `vercel api /v7/deployments` (latest production state). When the installed CLI has no `vercel api`, it uses `npx vercel@latest`. Not connected: the fix is `vercel git connect`. It also warns about Vercel's commit-author check: when the latest production deployment is `BLOCKED`, or recent default-branch commits use a GitHub noreply address (for example from a merge on github.com), connect GitHub in Vercel Account › Settings › Authentication.
- **Netlify**: `netlify api getSite` with the site id from `.netlify/state.json`. The fix is `netlify init` (continuous deployment), or `netlify link` first.
- **Cloudflare**: prints the check (`npx wrangler pages project list`, Git Provider column) and where to connect the repository. A Pages project made by direct upload cannot switch to Git, so use a GitHub Actions workflow with `cloudflare/wrangler-action`.
- **Others**: generic guidance, never a guess.

The JSON report has `host`, `evidence`, `project` (ids only), `gitConnected`, `workflow`, `deploysOnMerge`, `blocked`, `noreplyAuthor`, `fix` (the first fix's command) and `fixes`. `init`'s `done` event carries `deploy: {host, gitConnected, deploysOnMerge, blocked, fix}`, plus `wouldRun` when it did not run the fix.

## Privacy and safety

- **The CLI reads your checkout locally.** Setup commands send metadata (the repository, the app root, the URL and brand you confirm), never file contents. In the GitHub Action, `paradigma fix` sends the files it changed for Paradigma's check. On the Paradigma model (the default), each model turn, which holds the files the agent read, also goes through Paradigma's model proxy to the AI model provider, in memory only and never stored; with Use my own key, model calls go straight to your provider instead. Its report carries paths, line counts, the commit and the pull request link, never file contents.
- **Your host credentials stay with your host CLI.** `doctor deploy` asks `vercel`/`netlify` to make read-only API calls with their own login and never reads their token; it changes nothing unless you pass `--fix` and confirm (or `--yes`).
- **Secrets stay out of arguments and logs.** API keys are read from stdin or from an environment variable named with `--key-env`, never from command-line arguments, and are never printed or returned by the server.
- **Signed tasks only.** A GitHub Action run takes one short-lived task token signed by Paradigma, for one task in one repository; it expires with the task's lease.
- **Guard rails on every change.** Changed paths must match the task's allowed paths; manifests, lockfiles, CI, `.env*`, git and agent config are never allowed; a diff budget is enforced; added lines are scanned for secrets.
- **No charges without consent.** Included AI visibility is paid by Paradigma. Samples and schedules on your own provider account need `--accept-charges` every time.

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

## GitHub Action

Fixes are made by the Paradigma agent. It runs on Paradigma's servers by default, or in your own GitHub Actions, for fixes that need a build or tests. Both count against the same plan allowance. No secret is needed: in the Action the agent uses the same model as the hosted agent, provided by Paradigma.

In the dashboard, Autopilot > "Set up GitHub Action" opens a pull request that adds `.github/workflows/paradigma-fix.yml`:

```yaml
name: Paradigma fix
on:
  repository_dispatch:
    types: [paradigma-fix]
permissions:
  contents: write
  pull-requests: write
jobs:
  fix:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: Paradigma-click/paradigma-cli/action@v1
        with:
          task: ${{ github.event.client_payload.task }}
          api-url: https://paradigma.click
          build-command: ""   # optional, e.g. "npm ci && npm run build"
          test-command: ""    # optional, e.g. "npm test"
        # Optional: your own model key, only if you turn on Use my own key in Paradigma.
        # env:
        #   ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        #   OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

Then turn on "Allow GitHub Actions to create and approve pull requests" (Settings > Actions > General), so the workflow token can open the pull request.

Where your code goes:

- **The Paradigma model (default).** Each model turn goes from your runner to Paradigma's model proxy, authenticated by the run's task token, and on to the AI model provider with zero data retention and data collection denied, the same setup as the hosted agent. Paradigma reads the conversation in memory and never stores or logs it; it records tokens and cost only. The same token and turn caps apply, and the cost counts against your plan.
- **Use my own key.** Turn it on for the repository in Paradigma (Autopilot > GitHub Action), add `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` as a repository secret (Settings > Secrets and variables > Actions) and uncomment the `env` lines above. The runner then calls your provider directly, under your terms, and the agent's model calls never pass through Paradigma's servers. The CLI masks the key in the job's logs before using it. Fixes still count against your plan's allowance. Without the setting, the Action ignores these secrets.

How a run works: Paradigma starts the workflow with `repository_dispatch` and a short-lived token for one task. `paradigma fix` fetches the task (the brief, the acceptance items, the tools and the limits come from the server; no playbook or rule ships in this CLI), runs the agent's tool loop over the checkout with the same limits as the hosted agent (allowed paths, diff budget, no secret files, no protected files), runs your build and tests if you set them, asks Paradigma to check the edit, commits to `paradigma/fix-<task>`, opens the pull request with the workflow's `GITHUB_TOKEN` (a draft for penalty risk cleanups) and reports the outcome. The report carries paths, line counts, the commit and the pull request link, never file contents. Pull requests opened with `GITHUB_TOKEN` do not start your other workflows; Paradigma's own pull request checks and your preview deploys still run.

## Environment

- `PARADIGMA_HOME`: config directory (default `~/.paradigma`, mode 0700; the config file is 0600).
- `PARADIGMA_SERVER`: server used by `init` (default `https://paradigma.click`).
- `PARADIGMA_FIX_TASK`, `PARADIGMA_API_URL`, `PARADIGMA_BUILD_COMMAND`, `PARADIGMA_TEST_COMMAND`: what the GitHub Action passes to `paradigma fix` (the task token, the server, and the optional build and test commands).

## Development

```sh
pnpm install
pnpm typecheck
pnpm test        # unit and end-to-end tests (temp git repos, fake gh, fake API)
pnpm build       # bundles src/index.ts to dist/paradigma.mjs
node dist/paradigma.mjs --help
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[MIT](LICENSE)
