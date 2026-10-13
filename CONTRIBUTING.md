# Contributing

Thanks for helping improve the Paradigma CLI.

This repository is published from Paradigma's main codebase. Pull requests are welcome here: once reviewed, the change is applied upstream and appears in the next sync, with you credited as co-author.

## Before you open a pull request

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

- Keep runtime dependencies at zero: the published `dist/paradigma.mjs` is a single bundled file.
- Never send repository file contents or diffs to the server, and never accept secrets as command-line arguments.
- `src/contract/` is the wire contract shared with the Paradigma server. Changes there must stay backward compatible with released CLI versions; open an issue first.
- Add or update tests for behavior changes. Tests must not call the real Paradigma server or need credentials.
- Skill or manifest changes: update `last-updated` in `skills/paradigma/SKILL.md`.

## Reporting bugs

Open an issue with the command you ran, the `--json` output (remove tokens and keys) and `paradigma --version`. Security problems go to [SECURITY.md](SECURITY.md) instead.
