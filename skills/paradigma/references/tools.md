# Paradigma tools and commands

## MCP tools by permission

The user grants permissions per connection on the consent screen, and only for the projects and repositories they select. Write tools also check the user's current GitHub write access (or organization ownership for alerts and billing). Tools marked *(read)* change nothing.

### Arguments, lists and errors
- `projectId` accepts the project UUID or its production domain (`acme.com`, `https://acme.com/blog`). Only projects selected for this connection match; a domain shared by several projects returns their UUIDs to choose from.
- `ruleId` (`set_rule_mute`, `set_repository_rule_mute`) accepts the rule id from `list_findings` (`indexing/noindex-added`), its short mute name (`noindex`) or a family prefix ending in `/`.
- Every list answers with `total`, `page`, `pageSize` and `hasMore`. `total: null` means the list is not counted (use `hasMore`), never zero.
- Errors say what to change: the argument and allowed values, the permission the connection lacks (the user must reconnect and approve it), or the tool that lists valid ids. They never include keys, tokens or internal details.

### projects:read
- `get_onboarding_status` *(read)*: setup checklist with absolute hand-off links; `ready` once the dashboard is unlocked. Also works with projects:write.
- `get_setup_links` *(read)*: browser links for the GitHub App, Google setup, Search Console, GA4, Slack and billing. Also works with projects:write.
- `get_google_setup` *(read)*: "Set up Google for me" state: consent link, verification-file PR, GA4 measurement ID and tag instructions. Also works with projects:write.
- `get_verification_instructions` *(read)*: DNS TXT, well-known file or meta tag for a project's domain. Also works with projects:write.
- `list_projects` *(read)*: sites selected for this connection (`page` or `offset`, `limit` up to 100).
- `get_project` *(read)*: one project's identity, `orgId` and `repoId`.
- `get_project_scan` *(read)*: the latest four-pillar scan: `status`, `scannedAt`, the scores of SEO, AEO, GEO and Agents with labels and counts, the top 5 fixes (title, pillar, status, summary, fix, `autopilot`), `locked` until the domain is verified, and `next`.
- `get_activity` *(read)*: what Paradigma did and when it acts next: events newest first since `since` (default 24 hours, at most 7 days): scans with their scores, planned tasks, claims, PRs opened, merged, live or not live, failed and skipped tasks with a short reason; `schedule` and `projects` (last and next scan, when Autopilot plans) and the user's `runners` (online or not). Optional `projectId`.
- `list_repositories` *(read)*: repositories selected for this connection.
- `list_prompts` *(read)*: stored GEO prompts with state, source and segment (discovery or brand), plus counts against the 100-prompt and 10-brand-prompt limits, 25 per page.
- `list_prompt_suggestions` *(read)*: template, Search Console, Bing AI and Search Console AI page prompt suggestions.
- `get_connection_status` *(read)*: which sources and GEO keys are connected (never the keys).
- `get_indexnow_status` *(read)*: IndexNow setup and what recent production deploys sent (Bing, Yandex and others; not Google).
- `get_index_coverage` *(read)*: how many pages Google has indexed (Google's URL Inspection on the user's Search Console connection): indexed out of checked, not checked yet, counts by reason, today's pages to request, recent indexed-after-request wins, sitemap status.
- `get_index_requests` *(read)*: today's up to 10 pages worth requesting, each with `inspectUrl` (Search Console's URL Inspection page, where the user clicks "Request indexing").

### projects:write
- `list_project_targets` *(read)*: repositories with the GitHub App and their detected site roots and frameworks, 25 repositories per page.
- `check_google_setup`: finish Search Console after Google's verification file is deployed.
- `choose_ga4_account`: create the GA4 property in the Analytics account the user picks.
- `create_project`: create the project for `repoId` + `appRoot`; returns verification instructions.
- `update_project`: change URL, sitemap, brand, aliases, category, use case or competitors.
- `verify_project_domain`: check DNS, then the well-known file, then the meta tag.
- `set_repository_enabled`: turn PR checks and monitoring on or off for a repository.
- `set_preview_bypass_secret`: store or clear the Vercel deployment protection bypass secret (write-only).
- `setup_indexnow`: open (or reuse) the pull request that adds the public IndexNow key file. After it is merged and deployed, each production deploy sends its new and changed pages (sitemap changes, and changed Next.js App Router pages) to Bing, Yandex, Naver, Seznam and Yep. Google does not take part.
- `set_indexnow_enabled`: pause or resume IndexNow submissions after deploys.
- `mark_index_requested`: record that indexing was requested for these pages (`requested: false` clears it), so tomorrow's list moves on. Does not contact Google.

### metrics:read
- `get_seo_metrics` *(read)*: Search Console totals, daily series, comparison and coverage.
- `get_seo_breakdown` *(read)*: sampled queries or pages.
- `get_seo_detail_series` *(read)*: daily metrics for one query or page.
- `get_geo_metrics` *(read)*: AI answer visibility, citations and trends by engine and model.
- `get_geo_sources` *(read)*: domains AI answers cite over 4 weeks (own, competitor, third party), competitor citation gaps and brand mentions without a citation.
- `get_geo_brand_report` *(read)*: how AI describes the brand over 4 weeks: answers to brand prompts, per engine (names the category and use case? names competitors? which domains?), with the latest answers.
- `list_geo_samples` / `get_geo_sample` *(read)*: stored AI answer samples.
- `list_pages` / `get_page` *(read)*: page metadata from the latest audit.
- `get_gsc_ai_impressions` *(read)*: the latest imported Search Console Generative AI report (AI Overviews and AI Mode impressions by page and day).
- `get_portfolio_summary` *(read)*: SEO and GEO across all authorized projects.

### findings:read
- `list_findings` / `get_finding` *(read)*: findings for a site, with diagnostics and location.
- `list_repository_findings` / `get_repository_finding` *(read)*: PR findings without a site.
- `get_agent_task` / `get_repository_agent_task` *(read)*: a reviewable fix brief and prefilled issue URL.
- `get_finding_outcomes` / `get_repository_finding_outcomes` *(read)*: post-merge observations (also need metrics:read).
- `list_alerts` *(read)*: alert decisions for a site.

### operations:read
- `list_operations` / `get_operation` *(read)*: status and outcome of requested work for a project.
- `list_repository_operations` / `get_repository_operation` *(read)*: the same for repository-level work.

### operations:write
- `run_crawl`: production audit (20 per workspace per hour).
- `request_project_scan`: scan the production URL again, then poll `get_project_scan`. `requested: false` with `reason` `in_flight` or `too_soon` when one is running or ran minutes ago. Works before verification.
- `sync_search_console`, `sync_bing`, `sync_ga4`, `sync_performance`, `sync_plausible`, `sync_posthog`: request a data sync.
- `prepare_fix` → `create_fix_pr`: preview one statically checked metadata edit, then open a draft PR after review (`reviewed: true`). Never merges.
- `prepare_repository_fix` → `create_repository_fix_pr`: the same for findings without a site.
- `submit_finding_feedback` / `submit_repository_finding_feedback`: mark an alert useful or noise.
- `run_geo_sample`: one AI answer sample on the user's key; needs `acceptCharges: true`.
- `analyze_geo_sample`: extra analysis of a sample that mentions the brand; needs `acceptCharges: true`.

### settings:write
- `save_prompt`, `set_prompt_active`: add, enable or disable the user's own GEO prompts (`segment`: discovery by default, or brand; at most 10 active brand prompts).
- `approve_template_prompts`, `approve_gsc_prompt`, `approve_bing_ai_prompt`, `approve_gsc_ai_prompt`: activate suggested prompts.
- `set_geo_schedule`: automatic daily sampling (1, 3, 5 or 10 per day); enabling needs `acceptCharges: true`.
- `set_geo_auto_enrichment`: automatic analysis of new answers; needs its own `acceptCharges: true`.
- `set_performance_targets`: which URLs CrUX tracks.
- `set_rule_mute` / `set_repository_rule_mute`: mute or unmute a rule (id, short mute name or family prefix) for the whole repository.

### credentials:write
- `connect_bing`, `connect_crux`, `connect_plausible`, `connect_posthog`: store a source key and request a sync.
- `connect_geo_key`: Gemini, OpenAI, Anthropic or Perplexity key for GEO samples.
- `connect_dataforseo`: DataForSEO login for Google AI Overview and AI Mode samples (AI Mode is off until its schedule is enabled; weekly by default).
- `disconnect_geo_credential`: remove a GEO key.

Keys are write-only and never returned. Prefer `paradigma connect` (stdin) so the key never passes through the chat.

### alerts:write
- `set_alert_budget`: paid-site alerts per week (0–3), organization owner.
- `disconnect_slack`: disconnect Slack alerts.

### billing:write
- `create_checkout_session`: hosted Stripe Checkout URL for `pro` or `agency`; the user pays there.
- `open_billing_portal`: hosted Stripe customer portal URL.
- `cancel_pending_checkout`, `set_pro_extra_sites`, `prioritize_billing_site`, `reset_billing_site_order`.

### autopilot:write
- `set_autopilot_policy`: level (3 Notify, 2 Open PR, 1 Autopilot, 0 Full autopilot), schedule and limits. Level 0 needs `confirmFullAutopilot: true` every time and an allowlisted account.
- `set_autopilot_default`: workspace default level for every repository of an organization that follows it (new repositories included). Needs every repository of the organization selected and write access to all of them; level 0 as above.
- `follow_autopilot_default`: a repository follows the workspace default again; `set_autopilot_policy` with a level makes it keep its own. Following a level-0 default needs `confirmFullAutopilot: true`.
- `pause_autopilot`, `resume_autopilot`, `cancel_autopilot_task`, `revoke_autopilot_runner`.

### No permission needed
- `revoke_mcp_connection`: revoke this connection's own authorization.

## CLI commands

Run with `npx paradigma-cli <command>` or, after `npm i -g paradigma-cli`, `paradigma <command>`. Add `--json` everywhere.

| Command | What it does |
| --- | --- |
| `init [--token T] [--server URL] [--url U] [--brand B] [--category C] [--use-case U] [--app-root PATH] [--mcp claude\|codex\|cursor\|none] [--yes] [--fix-deploy] [--no-pr] [--wait S] [--dir PATH] [--level 0\|1\|2\|3 [--confirm-full-autopilot]]` | Sign in, create the project, check the deploy pipeline, verify the domain, wait for the site scan (up to `--wait` seconds, 180 by default here). Idempotent. `--level` turns Autopilot on (step `autopilot`; step `fixes` says the Paradigma agent makes the fixes). `--fix-deploy --yes` runs `vercel git connect` when needed; without it, `done.deploy.wouldRun` says what it would run. |
| `doctor deploy [--fix [--yes]] [--app-root PATH] [--dir PATH]` | How the site is published (Vercel, Netlify, Cloudflare, GitHub Pages, Fly.io, Render, Docker, custom workflow) and whether a merge deploys, checked with the user's own host CLI login (token never read). `--fix` runs `vercel git connect` after confirming or with `--yes`. Exit 3 when merges do not deploy or the latest production deploy is BLOCKED |
| `check all [--project ID] [--wait S]` | The project's four-pillar scan: scores, counts and the top fixes. Requests a scan and waits up to `--wait` seconds (180) when none completed yet; exit 3 while it still runs |
| `check seo\|aeo\|geo\|agents <domain> [--rescan]` | Free public check of one pillar of any domain, no sign-in |
| `check risk <domain>` | Penalty risk checker: practices search engines punish, with evidence and the policy. Private; one free use per 30 days, the member limit for your own projects |
| `status` | Account checklist and this machine's sign-in |
| `links` | Hand-off links: GitHub App, Google, Slack, billing |
| `projects list\|create\|update [--project ID] [--repo owner/name] [--app-root P] [--url U] [--brand B] [--category C] [--use-case U] [--sitemap URL] [--alias N]... [--competitor N]...` | Manage projects |
| `verify [--method dns\|file\|meta]... [--project ID]` | Check domain ownership (exit 3 while unverified) |
| `tasks [--project ID \| --repo owner/name] [--all]` | The project's tasks and counts (default: the checkout's project, else all). JSON: `{projects: [{project: {id, name, url, repo, verified, autopilot: {enabled, level}}, counts: {queued, needsYou, running, open, done}, tasks: [{id, title, category, risk, status, mode, plannedFor, prUrl, prNumber, findingUrl, startedBy, updatedAt}]}]}`; `status` is `queued`, `needs_you`, `running`, `pr_opened`, `merged`, `live`, `failed` or `skipped` |
| `tasks start <task id> [--checkout]` | Leases a task to this agent. JSON: `{task: {id, title, instructions, acceptance, allowedPaths, diffBudget, category, risk, repo, project, findingUrl, branch, leaseExpiresAt}, commands: {branch, pr, done, skip, failed, release}, checkout?: {ok, branch, problem}}`. Exit 3 when the project is locked (verify the domain); 409 when the task is already running |
| `tasks finish <task id> --pr URL \| --done \| --skip --reason R \| --failed --reason R` | Closes a started task. The PR must be a github.com pull request URL; the reason is one line, at most 200 characters, no code |
| `tasks release <task id>` | Gives a started task back to the queue |
| `tasks prompt [--project ID] [--copy]` | `{prompt}` (with `copied`: the clipboard tool used, or null) |
| `audit [--project ID]` | Request a production audit |
| `sync gsc\|bing\|ga4\|performance\|plausible\|posthog [--project ID]` | Request a data sync |
| `indexnow [status\|setup\|on\|off] [--project ID]` | IndexNow state and recent deploys (exit 3 until the key file is live), open the key-file PR (exit 3 until merged and deployed), or pause and resume submissions |
| `index [--project ID]` / `index requested <url>... [--project ID] [--undo]` / `index check [--project ID]` | Google index coverage and today's up to 10 pages to request with their Search Console links (exit 3 = pages to request); mark pages as requested; run today's URL Inspection batch now, within the daily budget |
| `connect <provider> [--project ID] [--key-env NAME]` | Store a key from stdin or an env var: `bing`, `crux`, `plausible [--site-domain D]`, `posthog --region us\|eu --posthog-project ID`, `gemini`, `openai`, `anthropic`, `perplexity`, `dataforseo --login L [--location 2840] [--language en]` |
| `geo prompts [list [--state all\|active\|inactive] \| add "TEXT"]` | GEO questions |
| `geo schedule --engine E --daily 1\|3\|5\|10 --accept-charges` / `--off` | Automatic sampling on the user's key |
| `geo sample --engine E --prompt ID --accept-charges` | One sample on the user's key |
| `alerts budget 0\|1\|2\|3 [--org ID]` | Weekly alert budget (organization owner) |
| `billing checkout --plan pro\|agency [--org ID] [--open]` / `billing portal [--org ID] [--open]` | Prints the hosted Stripe URL |
| `autopilot level 0\|1\|2\|3 [--repo owner/name]` / `autopilot pause [--reason R]` / `autopilot resume` | Server-side Autopilot policy (level 0 needs `--confirm-full-autopilot`) |
| `autopilot default 0\|1\|2\|3\|off [--org ID]` / `autopilot follow-default [--repo owner/name]` | Workspace default level and following it again (level 0 needs `--confirm-full-autopilot`) |
| `mcp install --agent claude\|codex\|cursor` | Connect the MCP server to the agent |
| `fix --task <token> [--api-url URL] [--build CMD] [--test CMD]` | Runs one fix Paradigma dispatched to the repository's GitHub Actions workflow (the Paradigma GitHub Action calls it; not for agents) |
| `doctor` | Setup checks: Node, git, sign-in, the server and its pinned key |
| `logout` | Removes the CLI credential from this machine |

GEO engines: `gemini`, `openai`, `claude`, `perplexity`, `google_ai_overview`, `google_ai_mode`.

## Output and exit codes

- `init --json` prints one JSON event per line: `step` (`auth`, `repository`, `github_app`, `project`, `deploy`, `domain`, `mcp`, `scan` with `done`, `action_required`, `skipped`, for `deploy` also `fixed` or `failed`, for `scan` also `running`), `needs_input` (`fields` with the flag to pass and candidates found in the code) and `done`. `done.scan` holds the four scores, the top 3 fixes and `locked`, or `{"status":"running","check":"npx paradigma-cli check all --project …"}` when the scan was not done in time. `done.deploy` is `{host, gitConnected, deploysOnMerge, blocked?, fix, fixed?, wouldRun?}` (null values mean unknown, never a guess).
- `doctor deploy --json` prints `{ok, host, label, evidence, project, gitConnected, gitRepo, workflow, deploysOnMerge, blocked, noreplyAuthor, cli, fix, fixes, checks, problem, fixed?}`.
- Other commands print one JSON object. Failures print `{"ok":false,"error":"<code>","message":"…"}`.
- Exit codes: `0` ok, `1` failed, `2` usage error, `3` needs the user or more input (missing fields, GitHub App not installed, domain not verified yet).

## Error codes

| Code | Meaning |
| --- | --- |
| `invalid_token` | The credential is missing, expired or revoked. Run `init` again (with a fresh dashboard token if needed). |
| `invalid_request`, `invalid_json`, `invalid_body`, `invalid_input` | The request was malformed or failed validation. Fix the flags; secret values are never echoed. |
| `payload_too_large` | The request body is too large. |
| `disabled` | The feature is turned off on the server. |
| `not_found` | The project, repository or organization is unknown or not yours. |
| `forbidden` | Missing GitHub write access or permission. |
| `billing_owner_required` | Only the GitHub account or organization owner can do this. |
| `full_autopilot_forbidden` | Level 0 needs an allowlisted account and explicit confirmation. |
| `confirmation_required` | Pass the explicit consent flag (`--accept-charges`, `--confirm-full-autopilot`) after asking the user. |
| `unverified` | The domain is not verified yet. |
| `unavailable`, `internal` | Temporary server problem. Retry later with the same idempotency key. |
