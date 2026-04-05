# pi-share

Collect, review, and upload redacted [pi](https://github.com/badlogic/pi-mono) session files to a Hugging Face dataset.

> **Sharing coding agent sessions risks leaking secrets and PII.** Read this README fully before use. Understand what gets redacted, what does not, and the assumptions in the [Limitations](#limitations) section.

## What it does

1. `collect`: redacts secrets in pi session files for a `--cwd`, writes redacted JSONL and private reports
2. `review`: sends redacted sessions to an LLM via `pi` for semantic review
3. `upload`: uploads reviewed and approved sessions to a Hugging Face dataset

## What gets redacted

Every string field in every JSON object is scanned:

- literal secrets from `~/.zshrc`, `--env-file`, and `--secret`
- common API key and token patterns

For maximum safety, pass known secrets explicitly with `--secret`. It accepts a file (one secret per line) or a literal string, and can be repeated.

## What does not get redacted

- **Embedded images**: preserved unchanged, marked `manual_review: true` in reports
- **Emails, names, non-standard secrets**: not caught deterministically, the LLM review step flags these

## Limitations

Redacting coding agent sessions with 100% precision is not a solved problem.

This tool targets OSS project sessions. These typically contain little private data. Most personal information (committer emails, GitHub usernames) is already public in git history. However, sessions can involve API keys and may mix project work with unrelated private tasks.

Deterministic redaction handles known secrets reliably but does not catch all PII or non-standard secrets. The LLM review step fills that gap by judging whether sessions are project-related, safe to share, and free of leaked sensitive data. LLMs are imperfect, but currently the best approach for semantic review of unstructured content.

If your OSS work does not involve many secrets, the dataset is likely in good shape after both steps. If it does, provide secrets explicitly with `--secret`.

## Install

```bash
npm install
npm link
```

### External tools

`collect` and `upload` need `huggingface-cli`:

```bash
python3 -m pip install --user "huggingface_hub[cli]"
huggingface-cli login
```

`review` needs `pi`:

```bash
npm install -g @mariozechner/pi-coding-agent
```

The CLI checks at startup and prints install instructions if missing.

## Workflow

```bash
pi-share collect --cwd /path/to/project --repo user/dataset --workspace ./workspace
pi-share review --workspace ./workspace README.md docs/design.md
pi-share upload --repo user/dataset --workspace ./workspace
```

## Commands

### `collect`

```bash
pi-share collect --cwd /path/to/project --repo user/dataset --workspace ./workspace
pi-share collect --cwd /path/to/project --repo user/dataset --workspace ./workspace \
  --secret secrets.txt --secret "my-token"
```

- `--env-file <path>`: secret source file (default: `~/.zshrc`)
- `--secret <file>|<text>`: literal secret or secret file (repeatable)
- `--force`: reprocess all sessions

Skips sessions whose `source_hash` matches local workspace or remote manifest. Reprocessing removes stale review sidecars.

### `review`

```bash
pi-share review --workspace ./workspace [--provider anthropic] [--model claude-sonnet-4-5] \
  [--parallel 4] [--deny deny.txt] [--deny "earendil|finances"] README.md AGENTS.md
```

- `--provider <name>`: pi provider override
- `--model <id>`: pi model override (supports `provider/model` shorthand)
- `--parallel <n>`: concurrent LLM reviews (default: 1)
- `--deny <file>|<regex>`: reject sessions matching this pattern without calling the LLM (repeatable)
- positional args: project context files for relevance judgment

LLM review is token-heavy. Each chunk can be up to 100k tokens, large sessions produce multiple chunks. Use a cost-effective model for bulk review.

Sessions are serialized to plain-text transcripts, chunked, and attached to `pi` via `@file`. Existing review sidecars are reused when redacted hash, context hashes, provider, model, and prompt version all match.

Output per session:

- `about_project`: `yes` | `no` | `mixed`
- `shareable`: `yes` | `no` | `manual_review`
- `missed_sensitive_data`: `yes` | `no` | `maybe`
- `flagged_parts`: `[{ reason, evidence }]`
- `summary`

### `upload`

```bash
pi-share upload --repo user/dataset --workspace ./workspace [--dry-run]
```

- `--dry-run`: print stats without uploading

Requires review data for every session. Refuses to upload if any session has no review sidecar. Uploads only sessions where `shareable === "yes"`, `missed_sensitive_data === "no"`, and `about_project !== "no"`. Skips unchanged sessions.

## Workspace layout

```text
workspace/
  workspace.json
  manifest.local.jsonl
  remote-manifest.jsonl
  manifest.jsonl
  redacted/       # public, uploaded to HF
  reports/        # private deterministic findings
  review/         # private LLM review sidecars
  review-chunks/  # private transcript chunks
```

Workspaces are incremental. Re-running `collect` or `review` reuses matching outputs.

## Dataset layout

```text
manifest.jsonl
<session>.jsonl
```

Each `<session>.jsonl` is a redacted pi session. See the [session format docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md).

`manifest.jsonl` has one entry per session:

```json
{"file": "2026-04-04T16-43-06-494Z_aed55f07.jsonl", "source_hash": "sha256:...", "redacted_hash": "sha256:..."}
```

## Development

```bash
npm run check
```
