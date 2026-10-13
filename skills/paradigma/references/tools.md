# Paradigma tools and commands

## MCP tools by permission

The user grants permissions per connection on the consent screen, and only for the projects and repositories they select. Write tools also check the user's current GitHub write access (or organization ownership for alerts and billing). Tools marked *(read)* change nothing.

### projects:read
- `get_onboarding_status` *(read)*: setup checklist with absolute hand-off links; `ready` once the dashboard is unlocked. Also works with projects:write.
- `get_setup_links` *(read)*: browser links for the GitHub App, Search Console, GA4, Slack and billing. Also works with projects:write.
- `get_verification_instructions` *(read)*: DNS TXT, well-known file or meta tag for a project's domain. Also works with projects:write.
- `list_projects` *(read)*: sites selected for this connection.
- `get_project` *(read)*: one project's identity and repository.
- `list_repositories` *(read)*: repositories selected for this connection.
- `list_prompts` *(read)*: stored GEO prompts with state and source, 25 per page.
- `list_prompt_suggestions` *(read)*: template, Search Console and Bing AI prompt suggestions.
- `get_connection_status` *(read)*: which sources and GEO keys are connected (never the keys).

### projects:write
- `list_project_targets` *(read)*: repositories with the GitHub App and their detected Next.js app roots.
- `create_project`: create the project for `repoId` + `appRoot`; returns verification instructions.
- `update_project`: change URL, sitemap, brand, aliases, category, use case or competitors.
- `verify_project_domain`: check DNS, then the well-known file, then the meta tag.
- `set_repository_enabled`: turn PR checks and monitoring on or off for a repository.
- `set_preview_bypass_secret`: store or clear the Vercel deployment protection bypass secret (write-only).

### metrics:read
- `get_seo_metrics` *(read)*: Search Console totals, daily series, comparison and coverage.
- `get_seo_breakdown` *(read)*: sampled queries or pages.
- `get_seo_detail_series` *(read)*: daily metrics for one query or page.
- `get_geo_metrics` *(read)*: AI answer visibility, citations and trends by engine and model.
- `list_geo_samples` / `get_geo_sample` *(read)*: stored AI answer samples.
- `list_pages` / `get_page` *(read)*: page metadata from the latest audit.
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
- `sync_search_console`, `sync_bing`, `sync_ga4`, `sync_performance`, `sync_plausible`, `sync_posthog`: request a data sync.
- `prepare_fix` → `create_fix_pr`: preview one statically checked metadata edit, then open a draft PR after review (`reviewed: true`). Never merges.
- `prepare_repository_fix` → `create_repository_fix_pr`: the same for findings without a site.
- `submit_finding_feedback` / `submit_repository_finding_feedback`: mark an alert useful or noise.
- `run_geo_sample`: one AI answer sample on the user's key; needs `acceptCharges: true`.
- `analyze_geo_sample`: extra analysis of a sample that mentions the brand; needs `acceptCharges: true`.

### settings:write
- `save_prompt`, `set_prompt_active`: add, enable or disable the user's own GEO prompts.
- `approve_template_prompts`, `approve_gsc_prompt`, `approve_bing_ai_prompt`: activate suggested prompts.
- `set_geo_schedule`: automatic daily sampling (1, 3, 5 or 10 per day); enabling needs `acceptCharges: true`.
- `set_geo_auto_enrichment`: automatic analysis of new answers; needs its own `acceptCharges: true`.
- `set_performance_targets`: which URLs CrUX tracks.
- `set_rule_mute` / `set_repository_rule_mute`: mute or unmute a rule for the whole repository.

### credentials:write
- `connect_bing`, `connect_crux`, `connect_plausible`, `connect_posthog`: store a source key and request a sync.
- `connect_geo_key`: Gemini, OpenAI, Anthropic or Perplexity key for GEO samples.
- `connect_dataforseo`: DataForSEO login for Google AI Overview samples.
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
- `pause_autopilot`, `resume_autopilot`, `cancel_autopilot_task`, `revoke_autopilot_runner`.

### No permission needed
- `revoke_mcp_connection`: revoke this connection's own authorization.

## CLI commands

Run with `npx paradigma-cli <command>` or, after `npm i -g paradigma-cli`, `paradigma <command>`. Add `--json` everywhere.

| Command | What it does |
| --- | --- |
| `init [--token T] [--server URL] [--url U] [--brand B] [--category C] [--use-case U] [--app-root PATH] [--mcp claude\|codex\|cursor\|none] [--yes] [--no-pr] [--wait S] [--dir PATH]` | Sign in, create the project, verify the domain. Idempotent. |
| `status` | Account checklist, local runner and server policy |
| `links` | Hand-off links: GitHub App, Google, Slack, billing |
| `projects list\|create\|update [--project ID] [--repo owner/name] [--app-root P] [--url U] [--brand B] [--category C] [--use-case U] [--sitemap URL] [--alias N]... [--competitor N]...` | Manage projects |
| `verify [--method dns\|file\|meta]... [--project ID]` | Check domain ownership (exit 3 while unverified) |
| `audit [--project ID]` | Request a production audit |
| `sync gsc\|bing\|ga4\|performance\|plausible\|posthog [--project ID]` | Request a data sync |
| `connect <provider> [--project ID] [--key-env NAME]` | Store a key from stdin or an env var: `bing`, `crux`, `plausible [--site-domain D]`, `posthog --region us\|eu --posthog-project ID`, `gemini`, `openai`, `anthropic`, `perplexity`, `dataforseo --login L [--location 2840] [--language en]` |
| `geo prompts [list [--state all\|active\|inactive] \| add "TEXT"]` | GEO questions |
| `geo schedule --engine E --daily 1\|3\|5\|10 --accept-charges` / `--off` | Automatic sampling on the user's key |
| `geo sample --engine E --prompt ID --accept-charges` | One sample on the user's key |
| `alerts budget 0\|1\|2\|3 [--org ID]` | Weekly alert budget (organization owner) |
| `billing checkout --plan pro\|agency [--org ID] [--open]` / `billing portal [--org ID] [--open]` | Prints the hosted Stripe URL |
| `autopilot level 0\|1\|2\|3 [--repo owner/name]` / `autopilot pause [--reason R]` / `autopilot resume` | Server-side Autopilot policy (level 0 needs `--confirm-full-autopilot`) |
| `mcp install --agent claude\|codex\|cursor` | Connect the MCP server to the agent |
| `setup [--server URL] [--name N] [--repo owner/name=PATH]... [--clone] [--agent A] [--schedule [--hour H]]` | Pair this machine as an Autopilot runner |
| `run [--once] [--dry-run] [--agent claude\|codex\|cursor] [--max N] [--keep-worktrees] [--skip-checks]` | Claim and process Autopilot tasks |
| `repos [set owner/name PATH \| scan [--clone]]` | Repository to local clone mappings |
| `schedule install\|uninstall\|print [--hour H] [--minute M]` | Daily run via launchd, systemd or schtasks |
| `pause` / `resume` | Local kill switch for this machine only |
| `doctor` | Checks git, gh, agents, server, token and pinned key |
| `logout` | Removes the credential from this machine |

GEO engines: `gemini`, `openai`, `claude`, `perplexity`, `google_ai_overview`.

## Output and exit codes

- `init --json` prints one JSON event per line: `step` (`auth`, `repository`, `github_app`, `domain`, `mcp` with `done`, `action_required` or `skipped`), `needs_input` (`fields` with the flag to pass and candidates found in the code) and `done`.
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
