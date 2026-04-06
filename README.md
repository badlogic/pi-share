# pi-share-hf

Collect, review, reject, and upload redacted [pi](https://github.com/badlogic/pi-mono) session files to a Hugging Face dataset.

> **Sharing coding agent sessions risks leaking secrets and PII.** Read this README fully before use. Understand what gets redacted, what does not, and the assumptions in the [Limitations](#limitations) section.

## What it does

1. `init`: create a workspace for one OSS project
2. `collect`: redact sessions and run LLM review
3. `reject`: manually exclude a session from upload
4. `upload`: upload approved sessions to a Hugging Face dataset

## What gets redacted

Every string field in every JSON object is scanned:

- literal secrets from `~/.zshrc`, `--env-file`, and `--secret`
- common API key and token patterns

For maximum safety, pass known secrets explicitly with `--secret`. It accepts a file (one secret per line) or a literal string, and can be repeated.

## What does not get redacted deterministically

- **Embedded images**: preserved unchanged by default, or stripped with `init --no-images`
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
pip install "huggingface_hub[cli]"
huggingface-cli login
```

When logging in:
- create a token at https://huggingface.co/settings/tokens with **write** scope (Repositories > Write access)
- say **Y** when asked to add the token as a git credential (HF dataset repos are git-backed, uploads use git credentials)
- do **not** set `HF_TOKEN` as an environment variable, it overrides the saved login and causes confusion when rotating tokens

`collect` and `review` need `pi`:

```bash
npm install -g @mariozechner/pi-coding-agent
```

The CLI checks at startup and prints install instructions if missing.

## Quick start

Pick one OSS project you want to share regularly. Create one workspace and keep reusing it. The workspace tracks what has already been collected, reviewed, rejected, and uploaded, so you do not redo work.

Preferred setup: one Hugging Face dataset repo per OSS project.

It is fine to use multiple machines for the same OSS project and point them at the same dataset repo. It is not recommended to mix traces from different OSS projects into one dataset repo, because the generated dataset card and review context are project-specific.

A good place for the workspace is inside your project directory, added to `.gitignore`:

```bash
cd /path/to/my-project
echo ".pi/hf-sessions/" >> .gitignore
```

Initialize the workspace once:

```bash
# personal account
pi-share-hf init --repo myuser/my-project-sessions

# organization or explicit namespace
pi-share-hf init --repo my-project-sessions --organization myorg
```

Then collect + review:

```bash
pi-share-hf collect \
  --secret secrets.txt \
  --provider openai-codex --model gpt-5.4 --thinking low \
  --parallel 4 \
  --deny deny.txt \
  README.md AGENTS.md
```

Optionally reject individual sessions after manual inspection:

```bash
pi-share-hf reject 2026-01-16T11-03-04-216Z_b8b30402-d134-4f0d-9e6e-e2f72ada5a2f.jsonl
pi-share-hf reject .pi/hf-sessions/images/2026-01-20T02-11-25-504Z_147339a0-f4ca-4ec6-b420-670213ec3ec6_L2181_0_aa43d6a2d140.png
```

Then upload approved sessions:

```bash
pi-share-hf upload
```

Defaults:
- `--cwd`: current directory for `init`
- `--workspace`: `.pi/hf-sessions` for all commands
- context files for `collect` and `review`: `README.md` and `AGENTS.md` if present

Where:
- `secrets.txt` has one secret per line (API keys, tokens, passwords)
- `deny.txt` has one regex per line for topics that should never be shared (private project names, personal contacts, etc.)
- `README.md AGENTS.md ...` are project context files for the review LLM so it can tell project work from unrelated activity

Review is token-heavy. Each session chunk can be up to 100k tokens, and large sessions produce multiple chunks. Pick a model that balances cost and quality.

Run the first few rounds manually so you can verify your secret and deny lists are catching everything. Check the review sidecars and use the [verification workflow](#verifying-results) to search for private keywords. Once the setup looks good, put the commands in a project-local script and keep using the same workspace.

## Commands

### `init`

```bash
pi-share-hf init [--cwd /path/to/project] --repo user/dataset [--workspace .pi/hf-sessions] [--no-images]
pi-share-hf init [--cwd /path/to/project] --repo dataset-name --organization myorg [--workspace .pi/hf-sessions] [--no-images]
```

- `--cwd <dir>`: project directory to map to pi session storage (default: current directory)
- `--repo <id>`: HF dataset repo id (`user/dataset`) or bare repo name when used with `--organization`
- `--organization <name>`: optional HF organization or user namespace when `--repo` is a bare repo name
- `--workspace <dir>`: persistent workspace directory (default: `.pi/hf-sessions`)
- `--no-images`: strip embedded images from redacted output instead of preserving them

### `collect`

```bash
pi-share-hf collect [--workspace .pi/hf-sessions] \
  --secret secrets.txt --secret "my-token" \
  --provider openai-codex --model gpt-5.4 --thinking low \
  --parallel 4 \
  --deny deny.txt \
  README.md AGENTS.md
```

- `--env-file <path>`: secret source file (default: `~/.zshrc`)
- `--secret <file>|<text>`: literal secret or secret file (repeatable)
- `--force`: reprocess all sessions
- `--provider <name>`: pi provider override for review
- `--model <id>`: pi model override (supports `provider/model` shorthand)
- `--thinking <level>`: thinking level override
- `--parallel <n>`: concurrent LLM reviews (default: 1)
- `--deny <file>|<regex>`: reject sessions matching this pattern without calling the LLM (repeatable)
- `--session <file>`: process a single session (for testing)
- positional args: project context files for relevance judgment (defaults to `README.md` and `AGENTS.md` if present)

`collect` does both deterministic redaction and LLM review. It skips sessions whose `source_hash` matches local workspace or remote manifest. Reprocessing removes stale review sidecars.

Sessions are serialized to plain-text transcripts, chunked, and attached to `pi` via `@file`. Existing review sidecars are reused when redacted hash, context hashes, provider, model, and prompt version all match.

If images are preserved, `collect` extracts them for the review LLM. After review finishes, `workspace/images/` retains only images from sessions with `shareable === "yes"`. Images from sessions marked `shareable === "no"` or `shareable === "manual_review"` are deleted. If your chosen model does not support images, preserved images are not meaningfully reviewed.

Output per session includes:
- `about_project`: `yes` | `no` | `mixed`
- `shareable`: `yes` | `no` | `manual_review`
- `missed_sensitive_data`: `yes` | `no` | `maybe`
- `flagged_parts`: `[{ reason, evidence }]`
- `summary`

### `review`

`review` reruns the LLM step only on already-redacted sessions.

```bash
pi-share-hf review [--workspace .pi/hf-sessions] README.md AGENTS.md
```

It supports the same review-related flags as `collect`: `--provider`, `--model`, `--thinking`, `--parallel`, `--deny`, and `--session`.

### `reject`

```bash
pi-share-hf reject [--workspace .pi/hf-sessions] <session.jsonl|image.png>
```

Adds the derived session filename to `workspace/reject.txt`. Upload always skips sessions listed there.

### `upload`

```bash
pi-share-hf upload [--workspace .pi/hf-sessions] [--dry-run]
```

- `--dry-run`: print stats without uploading

Repo is read from `workspace.json`. Requires review data for every session. Refuses to upload if any session has no review sidecar. Uploads only sessions where `shareable === "yes"`, `missed_sensitive_data === "no"`, and `about_project !== "no"`. Skips unchanged sessions and sessions listed in `reject.txt`.

## Verifying results

After `collect` completes, spot-check the results. Search the redacted sessions for keywords related to private topics you know appear in your sessions:

```bash
# find sessions containing a keyword
rg -l 'my-private-project' .pi/hf-sessions/redacted/

# check if those sessions are blocked
for f in $(rg -l 'my-private-project' .pi/hf-sessions/redacted/); do
  base=$(basename "$f")
  python3 -c "import json; d=json.load(open('.pi/hf-sessions/review/${base}.review.json')); a=d['aggregate']; print(a['shareable'], a['about_project'], base)"
done
```

If any session containing private content is marked `shareable=yes`, add it to `--deny` and rerun `collect` or `review`. Common things to search for: private project names, personal contacts, private infrastructure, financial references, non-OSS work topics.

## Workspace layout

```text
.pi/hf-sessions/
  workspace.json
  manifest.local.jsonl
  remote-manifest.jsonl
  manifest.jsonl
  redacted/       # public, uploaded to HF
  reports/        # private deterministic findings
  review/         # private LLM review sidecars
  review-chunks/  # private transcript chunks
  images/         # extracted preserved images from sessions with shareable=yes
  reject.txt      # one rejected session filename per line
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
