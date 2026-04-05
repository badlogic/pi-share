#!/usr/bin/env node --experimental-strip-types --no-warnings=ExperimentalWarning

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type Severity = "low" | "medium" | "high" | "critical";
type DetectorName = "literal-secret" | "secret-pattern" | "image" | "parse-error";type AboutProject = "yes" | "no" | "mixed";
type Shareable = "yes" | "no" | "manual_review";
type MissedSensitiveData = "yes" | "no" | "maybe";

interface WorkspaceConfig {
  cwd: string;
  repo: string;
  envFile: string;
}

interface CollectOptions {
  cwd: string;
  repo: string;
  workspace: string;
  envFile: string;
  secrets: string[];
  force: boolean;
}

interface ReviewOptions {
  workspace: string;
  contextFiles: string[];
  provider?: string;
  model?: string;
  thinking?: string;
  parallel: number;
  denyPatterns: RegExp[];
}

interface UploadOptions {
  workspace: string;
  dryRun: boolean;
}

interface Finding {
  detector: DetectorName;
  severity: Severity;
  jsonPath: string;
  replacement: string;
  count: number;
  detail?: string;
  manual_review?: boolean;
}

interface RedactionResult {
  redacted: JsonObject;
  findings: Finding[];
}

interface LocalManifestEntry {
  file: string;
  source_file: string;
  source_hash: string;
  redacted_hash: string;
  entry_count: number;
  findings: number;
  lines_with_findings: number;
}

interface RemoteManifestEntry {
  file: string;
  source_hash: string;
  redacted_hash: string;
}

interface ReviewFlaggedPart {
  reason: string;
  evidence: string;
  chunk_index?: number;
}

interface ChunkReviewResult {
  about_project: AboutProject;
  shareable: Shareable;
  missed_sensitive_data: MissedSensitiveData;
  flagged_parts: ReviewFlaggedPart[];
  summary: string;
}

interface SessionReviewFile {
  file: string;
  context_files: string[];
  context_hashes: Record<string, string>;
  provider?: string;
  model?: string;
  redacted_hash: string;
  review_key: string;
  prompt_version: number;
  chunk_count: number;
  chunk_char_limit: number;
  chunks: Array<{
    chunk_index: number;
    chunk_file: string;
    chars: number;
    result?: ChunkReviewResult;
    error?: string;
  }>;
  aggregate: ChunkReviewResult;
}

interface SecretPattern {
  name: string;
  regex: RegExp;
  replacement: string;
  severity: Severity;
}

const CHARS_PER_REVIEW_TOKEN = 5;
const REVIEW_TOKEN_LIMIT = 100_000;
const REVIEW_CHUNK_CHAR_LIMIT = CHARS_PER_REVIEW_TOKEN * REVIEW_TOKEN_LIMIT;
const REVIEW_PROMPT_VERSION = 3;
const REMOTE_MANIFEST_FILE = "manifest.jsonl";
const WORKSPACE_CONFIG_FILE = "workspace.json";
const LOCAL_MANIFEST_FILE = "manifest.local.jsonl";
const REMOTE_MANIFEST_CACHE_FILE = "remote-manifest.jsonl";

const SECRET_PATTERNS: SecretPattern[] = [
  { name: "openai-project", regex: /sk-proj-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "anthropic", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "openrouter", regex: /sk-or-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "groq", regex: /gsk_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "github", regex: /gh[pousr]_[A-Za-z0-9]{30,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "huggingface", regex: /hf_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "aws-access-key", regex: /AKIA[A-Z0-9]{12,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "xai", regex: /xai-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "google-ai", regex: /AIza[A-Za-z0-9_-]{30,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "cerebras", regex: /csk-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "bearer-token", regex: /Bearer\s+[A-Za-z0-9_\-.]{20,}/g, replacement: "Bearer [REDACTED_SECRET]", severity: "critical" },
  { name: "jwt", regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
];

function printUsage(): void {
  console.log(`
pi-share-hf

Usage:
  pi-share-hf collect --cwd <dir> --repo <hf-dataset-repo> --workspace <dir> [options]
  pi-share-hf review --workspace <dir> <context-file>+
  pi-share-hf upload --workspace <dir>

Commands:
  collect   Redact new or changed sessions for a cwd into a workspace
  review    Run pi over redacted sessions in a workspace using project context files
  upload    Upload approved redacted sessions and update manifest.jsonl in the dataset repo

Collect options:
  --cwd <dir>            Working directory whose pi sessions should be collected
  --repo <repo>          Hugging Face dataset repo, for example badlogic/pi-mono-sessions
  --workspace <dir>      Workspace directory for redacted files and private sidecars
  --env-file <path>      Secret source file (default: ~/.zshrc)
  --secret <file>|<text> Additional literal secret or line-based secret file (repeatable)
  --force                Reprocess all sessions even if source_hash matches remote manifest

Review options:
  --workspace <dir>      Existing workspace created by collect
  --provider <name>      pi provider override for review
  --model <id>           pi model override for review
  --thinking <level>     Thinking level override (off, minimal, low, medium, high, xhigh)
  --parallel <n>         Number of parallel LLM reviews (default: 1)
  --deny <file>|<regex>  Deny pattern: file with one regex per line, or a regex string (repeatable)
  <context-file>+        One or more files that define project context for the LLM review

Upload options:
  --workspace <dir>      Existing workspace created by collect
  --dry-run              Show upload stats without uploading
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h" || args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  await ensureStartupTools(command);

  if (command === "collect") {
    await runCollect(parseCollectArgs(args.slice(1)));
    return;
  }

  if (command === "review") {
    await runReview(parseReviewArgs(args.slice(1)));
    return;
  }

  if (command === "upload") {
    await runUpload(parseUploadArgs(args.slice(1)));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseCollectArgs(args: string[]): CollectOptions {
  let cwd = "";
  let repo = "";
  let workspace = "";
  let envFile = path.join(os.homedir(), ".zshrc");
  const secrets: string[] = [];
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--cwd") cwd = path.resolve(requireValue(args, ++i, "--cwd"));
    else if (arg === "--repo") repo = requireValue(args, ++i, "--repo");
    else if (arg === "--workspace") workspace = path.resolve(requireValue(args, ++i, "--workspace"));
    else if (arg === "--env-file") envFile = path.resolve(requireValue(args, ++i, "--env-file"));
    else if (arg === "--secret") secrets.push(requireValue(args, ++i, "--secret"));
    else if (arg === "--force") force = true;
    else throw new Error(`Unknown collect option: ${arg}`);
  }

  if (!cwd || !repo || !workspace) {
    throw new Error("collect requires --cwd, --repo, and --workspace");
  }

  return { cwd, repo, workspace, envFile, secrets, force };
}

function parseReviewArgs(args: string[]): ReviewOptions {
  let workspace = "";
  let provider: string | undefined;
  let model: string | undefined;
  let thinking: string | undefined;
  let parallel = 1;
  const denyInputs: string[] = [];
  const contextFiles: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--workspace") workspace = path.resolve(requireValue(args, ++i, "--workspace"));
    else if (arg === "--provider") provider = requireValue(args, ++i, "--provider");
    else if (arg === "--model") model = requireValue(args, ++i, "--model");
    else if (arg === "--thinking") thinking = requireValue(args, ++i, "--thinking");
    else if (arg === "--parallel") parallel = parseInt(requireValue(args, ++i, "--parallel"), 10);
    else if (arg === "--deny") denyInputs.push(requireValue(args, ++i, "--deny"));
    else contextFiles.push(arg);
  }

  if (!workspace || contextFiles.length === 0) {
    throw new Error("review requires --workspace and at least one context file");
  }

  if (parallel < 1 || !Number.isFinite(parallel)) parallel = 1;

  const denyPatterns = loadDenyPatterns(denyInputs);

  return { workspace, contextFiles, provider, model, thinking, parallel, denyPatterns };
}

function loadDenyPatterns(inputs: string[]): RegExp[] {
  const patterns: RegExp[] = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      const lines = fs.readFileSync(resolved, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          patterns.push(new RegExp(trimmed));
        }
      }
    } else {
      patterns.push(new RegExp(input));
    }
  }
  return patterns;
}

function parseUploadArgs(args: string[]): UploadOptions {
  let workspace = "";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--workspace") workspace = path.resolve(requireValue(args, ++i, "--workspace"));
    else if (arg === "--dry-run") dryRun = true;
    else throw new Error(`Unknown upload option: ${arg}`);
  }

  if (!workspace) {
    throw new Error("upload requires --workspace");
  }

  return { workspace, dryRun };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`Missing value for ${flag}`);
  return value;
}

class Redactor {
  private readonly literalSecrets: Array<{ name: string; value: string; replacement: string }>;

  constructor(
    envFile: string,
    secrets: string[],
  ) {
    this.literalSecrets = buildLiteralSecrets(envFile, secrets);
  }

  async redactEvent(event: JsonObject): Promise<RedactionResult> {
    return this.redactObject(event, "$", undefined, undefined);
  }

  private async redactValue(
    value: JsonValue,
    jsonPath: string,
    parentKey?: string,
    parentObject?: JsonObject,
  ): Promise<{ value: JsonValue; findings: Finding[] }> {
    if (value === null) return { value, findings: [] };

    if (typeof value === "string") {
      if (parentKey === "data" && parentObject && typeof parentObject.mimeType === "string" && value.length > 256) {
        return {
          value,
          findings: [{
            detector: "image",
            severity: "medium",
            jsonPath,
            replacement: "[PRESERVED_IMAGE]",
            count: 1,
            detail: parentObject.mimeType,
            manual_review: true,
          }],
        };
      }
      return this.redactString(value, jsonPath);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return { value, findings: [] };
    }

    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      const findings: Finding[] = [];
      for (let i = 0; i < value.length; i++) {
        const result = await this.redactValue(value[i], `${jsonPath}[${i}]`);
        out.push(result.value);
        findings.push(...result.findings);
      }
      return { value: out, findings };
    }

    const result = await this.redactObject(value, jsonPath, parentKey, parentObject);
    return { value: result.redacted, findings: result.findings };
  }

  private async redactObject(
    value: JsonObject,
    jsonPath: string,
    _parentKey?: string,
    _parentObject?: JsonObject,
  ): Promise<{ redacted: JsonObject; findings: Finding[] }> {
    const out: JsonObject = {};
    const findings: Finding[] = [];

    for (const [key, child] of Object.entries(value)) {
      const childPath = `${jsonPath}${formatObjectKey(key)}`;
      const result = await this.redactValue(child, childPath, key, value);
      out[key] = result.value;
      findings.push(...result.findings);
    }

    return { redacted: out, findings };
  }

  private async redactString(text: string, jsonPath: string): Promise<{ value: JsonValue; findings: Finding[] }> {
    let result = text;
    const findings: Finding[] = [];

    for (const secret of this.literalSecrets) {
      const count = countOccurrences(result, secret.value);
      if (count > 0) {
        result = result.replaceAll(secret.value, secret.replacement);
        findings.push({
          detector: "literal-secret",
          severity: "critical",
          jsonPath,
          replacement: secret.replacement,
          count,
          detail: secret.name,
        });
      }
    }

    for (const pattern of SECRET_PATTERNS) {
      const count = countRegexMatches(result, pattern.regex);
      if (count > 0) {
        result = result.replace(pattern.regex, pattern.replacement);
        findings.push({
          detector: "secret-pattern",
          severity: pattern.severity,
          jsonPath,
          replacement: pattern.replacement,
          count,
          detail: pattern.name,
        });
      }
    }

    return { value: result, findings };
  }
}

function buildLiteralSecrets(envFile: string, secretInputs: string[]): Array<{ name: string; value: string; replacement: string }> {
  const secrets = new Map<string, string>();
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, "utf-8");
    const pattern = /^export\s+([A-Za-z_][A-Za-z_0-9]*)=["']?([^"'\n#]+)/gm;
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      const value = match[2].trim().replace(/["']$/, "");
      if (looksSensitiveName(name) && value.length > 4) {
        secrets.set(name, value);
      }
    }
  }

  let secretIndex = 1;
  for (const input of secretInputs) {
    const resolved = path.resolve(input);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      const lines = fs.readFileSync(resolved, "utf-8").split("\n");
      for (const line of lines) {
        const value = line.trim();
        if (value.length > 0) {
          secrets.set(`SECRET_${secretIndex++}`, value);
        }
      }
      continue;
    }

    if (input.length > 0) {
      secrets.set(`SECRET_${secretIndex++}`, input);
    }
  }

  return [...secrets.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, value]) => ({
      name,
      value,
      replacement: `[REDACTED_${name}]`,
    }));
}

function looksSensitiveName(name: string): boolean {
  const upper = name.toUpperCase();
  return ["KEY", "TOKEN", "SECRET", "PASSWORD", "PWD", "COOKIE"].some((part) => upper.includes(part));
}

function countOccurrences(text: string, value: string): number {
  if (!value) return 0;
  return text.split(value).length - 1;
}

function countRegexMatches(text: string, regex: RegExp): number {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const globalRegex = new RegExp(regex.source, flags);
  let count = 0;
  while (globalRegex.exec(text) !== null) count++;
  return count;
}

function formatObjectKey(key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `.${key}`;
  return `[${JSON.stringify(key)}]`;
}

function cwdToSessionDirName(cwd: string): string {
  return `--${cwd.replace(/\//g, "-").slice(1)}--`;
}

function findSessionDir(cwd: string): string {
  const sessionsBase = path.join(os.homedir(), ".pi", "agent", "sessions");
  const dir = path.join(sessionsBase, cwdToSessionDirName(cwd));
  if (!fs.existsSync(dir)) {
    throw new Error(`Session directory not found for cwd: ${cwd}`);
  }
  return dir;
}

function workspacePath(workspace: string, ...segments: string[]): string {
  return path.join(workspace, ...segments);
}

function ensureWorkspaceDirs(workspace: string): void {
  fs.mkdirSync(workspacePath(workspace, "redacted"), { recursive: true });
  fs.mkdirSync(workspacePath(workspace, "reports"), { recursive: true });
  fs.mkdirSync(workspacePath(workspace, "review"), { recursive: true });
  fs.mkdirSync(workspacePath(workspace, "review-chunks"), { recursive: true });
}

function resetWorkspaceForCollect(workspace: string): void {
  fs.mkdirSync(workspace, { recursive: true });
  ensureWorkspaceDirs(workspace);
}

function resetReviewDir(workspace: string): void {
  fs.mkdirSync(workspacePath(workspace, "review"), { recursive: true });
  fs.mkdirSync(workspacePath(workspace, "review-chunks"), { recursive: true });
}

function writeWorkspaceConfig(workspace: string, config: WorkspaceConfig): void {
  fs.writeFileSync(workspacePath(workspace, WORKSPACE_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

function readWorkspaceConfig(workspace: string): WorkspaceConfig {
  const file = workspacePath(workspace, WORKSPACE_CONFIG_FILE);
  if (!fs.existsSync(file)) throw new Error(`Missing workspace config: ${file}`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  if (!isWorkspaceConfig(parsed)) throw new Error(`Invalid workspace config: ${file}`);
  return parsed;
}

function isWorkspaceConfig(value: unknown): value is WorkspaceConfig {
  if (!isRecord(value)) return false;
  return typeof value.cwd === "string"
    && typeof value.repo === "string"
    && typeof value.envFile === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return `sha256:${hash.digest("hex")}`;
}

function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function readJsonlFile<T>(filePath: string, parser: (value: unknown) => T | undefined): T[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter((line) => line.trim() !== "");
  const results: T[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const value = parser(parsed);
      if (value) results.push(value);
    } catch {
      // Ignore malformed lines in manifests or sidecars.
    }
  }
  return results;
}

function appendJsonlLine(filePath: string, value: unknown): void {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function writeJsonlFile(filePath: string, values: unknown[]): void {
  const content = values.map((value) => JSON.stringify(value)).join("\n");
  fs.writeFileSync(filePath, content.length > 0 ? `${content}\n` : "");
}

function loadRemoteManifest(filePath: string): Map<string, RemoteManifestEntry> {
  const entries = readJsonlFile(filePath, parseRemoteManifestEntry);
  return new Map(entries.map((entry) => [entry.file, entry]));
}

function loadLocalManifest(filePath: string): Map<string, LocalManifestEntry> {
  const entries = readJsonlFile(filePath, parseLocalManifestEntry);
  return new Map(entries.map((entry) => [entry.file, entry]));
}

function parseRemoteManifestEntry(value: unknown): RemoteManifestEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.file !== "string") return undefined;
  if (typeof value.source_hash !== "string") return undefined;
  if (typeof value.redacted_hash !== "string") return undefined;
  return {
    file: value.file,
    source_hash: value.source_hash,
    redacted_hash: value.redacted_hash,
  };
}

function parseLocalManifestEntry(value: unknown): LocalManifestEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.file !== "string") return undefined;
  if (typeof value.source_file !== "string") return undefined;
  if (typeof value.source_hash !== "string") return undefined;
  if (typeof value.redacted_hash !== "string") return undefined;
  if (typeof value.entry_count !== "number") return undefined;
  if (typeof value.findings !== "number") return undefined;
  if (typeof value.lines_with_findings !== "number") return undefined;
  return {
    file: value.file,
    source_file: value.source_file,
    source_hash: value.source_hash,
    redacted_hash: value.redacted_hash,
    entry_count: value.entry_count,
    findings: value.findings,
    lines_with_findings: value.lines_with_findings,
  };
}

async function processSessionFile(
  inputPath: string,
  redactedPath: string,
  reportPath: string,
  redactor: Redactor,
): Promise<{ redactedHash: string; entryCount: number; findings: number; linesWithFindings: number }> {
  const input = fs.createReadStream(inputPath, { encoding: "utf-8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  const redactedStream = fs.createWriteStream(redactedPath, { encoding: "utf-8" });
  const reportStream = fs.createWriteStream(reportPath, { encoding: "utf-8" });
  const redactedHash = createHash("sha256");

  let lineNumber = 0;
  let entryCount = 0;
  let findingsCount = 0;
  let linesWithFindings = 0;

  for await (const line of reader) {
    lineNumber++;
    if (line.trim() === "") continue;

    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("Expected a JSON object");
      }
      const event = parsed as JsonObject;
      const result = await redactor.redactEvent(event);
      const serialized = `${JSON.stringify(result.redacted)}\n`;
      await writeToStream(redactedStream, serialized);
      redactedHash.update(serialized);
      entryCount++;

      if (result.findings.length > 0) {
        linesWithFindings++;
        findingsCount += result.findings.length;
        appendReportLine(reportStream, {
          line_number: lineNumber,
          entry_type: typeof event.type === "string" ? event.type : undefined,
          entry_id: typeof event.id === "string" ? event.id : undefined,
          findings: result.findings,
        });
      }
    } catch (error) {
      appendReportLine(reportStream, {
        line_number: lineNumber,
        findings: [
          {
            detector: "parse-error",
            severity: "high",
            jsonPath: "$",
            replacement: "",
            count: 1,
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      });
      linesWithFindings++;
      findingsCount++;
    }
  }

  await closeStream(redactedStream);
  await closeStream(reportStream);

  return {
    redactedHash: `sha256:${redactedHash.digest("hex")}`,
    entryCount,
    findings: findingsCount,
    linesWithFindings,
  };
}

function appendReportLine(stream: fs.WriteStream, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function writeToStream(stream: fs.WriteStream, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function runCollect(options: CollectOptions): Promise<void> {
  resetWorkspaceForCollect(options.workspace);
  ensureWorkspaceDirs(options.workspace);

  writeWorkspaceConfig(options.workspace, {
    cwd: options.cwd,
    repo: options.repo,
    envFile: options.envFile,
  });

  const remoteManifestCachePath = workspacePath(options.workspace, REMOTE_MANIFEST_CACHE_FILE);
  const remoteManifest = await downloadRemoteManifest(options.repo, remoteManifestCachePath);
  const sessionDir = findSessionDir(options.cwd);
  const sessionFiles = fs.readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl")).sort();
  const redactor = new Redactor(options.envFile, options.secrets);
  const localManifestPath = workspacePath(options.workspace, LOCAL_MANIFEST_FILE);
  const localManifest = loadLocalManifest(localManifestPath);

  let skippedLocal = 0;
  let skippedRemote = 0;
  let processed = 0;
  let totalFindings = 0;

  console.log(`Workspace: ${options.workspace}`);
  console.log(`Session directory: ${sessionDir}`);
  console.log(`Remote manifest entries: ${remoteManifest.size}`);
  console.log(`Local manifest entries: ${localManifest.size}`);
  console.log(`Session files: ${sessionFiles.length}`);

  for (let index = 0; index < sessionFiles.length; index++) {
    const file = sessionFiles[index];
    process.stdout.write(`\r[${index + 1}/${sessionFiles.length}] processed=${processed} skipped-local=${skippedLocal} skipped-remote=${skippedRemote} ${file}`);

    const inputPath = path.join(sessionDir, file);
    const sourceHash = await sha256File(inputPath);
    const remoteEntry = remoteManifest.get(file);
    const localEntry = localManifest.get(file);
    const redactedPath = workspacePath(options.workspace, "redacted", file);
    const reportPath = workspacePath(options.workspace, "reports", `${file}.report.jsonl`);

    if (
      !options.force
      && localEntry
      && localEntry.source_hash === sourceHash
      && fs.existsSync(redactedPath)
      && fs.existsSync(reportPath)
    ) {
      skippedLocal++;
      continue;
    }

    if (!options.force && remoteEntry?.source_hash === sourceHash) {
      skippedRemote++;
      continue;
    }

    fs.rmSync(workspacePath(options.workspace, "review", `${file}.review.json`), { force: true });
    fs.rmSync(workspacePath(options.workspace, "review-chunks", file), { recursive: true, force: true });

    const result = await processSessionFile(inputPath, redactedPath, reportPath, redactor);

    localManifest.set(file, {
      file,
      source_file: inputPath,
      source_hash: sourceHash,
      redacted_hash: result.redactedHash,
      entry_count: result.entryCount,
      findings: result.findings,
      lines_with_findings: result.linesWithFindings,
    });
    processed++;
    totalFindings += result.findings;
  }

  const keptEntries = [...localManifest.values()]
    .filter((entry) => fs.existsSync(workspacePath(options.workspace, "redacted", entry.file)) && fs.existsSync(workspacePath(options.workspace, "reports", `${entry.file}.report.jsonl`)))
    .sort((a, b) => a.file.localeCompare(b.file));
  writeJsonlFile(localManifestPath, keptEntries);

  console.log();
  console.log(`Processed: ${processed}`);
  console.log(`Skipped local unchanged: ${skippedLocal}`);
  console.log(`Skipped remote unchanged: ${skippedRemote}`);
  console.log(`Total findings: ${totalFindings}`);
  console.log(`Local manifest: ${localManifestPath}`);
}

async function downloadRemoteManifest(repo: string, outputPath: string): Promise<Map<string, RemoteManifestEntry>> {
  fs.rmSync(outputPath, { force: true });
  const downloadDir = path.dirname(outputPath);
  fs.mkdirSync(downloadDir, { recursive: true });

  const result = await runCommand("huggingface-cli", [
    "download",
    repo,
    REMOTE_MANIFEST_FILE,
    "--repo-type",
    "dataset",
    "--local-dir",
    downloadDir,
    "--local-dir-use-symlinks",
    "False",
    "--quiet",
  ]);

  if (!result.ok || !fs.existsSync(outputPath)) {
    return new Map();
  }

  return loadRemoteManifest(outputPath);
}

function resolvePiDefaults(provider?: string, model?: string, thinking?: string): { provider: string; model: string; thinking: string } {
  let resolvedProvider = provider ?? "";
  let resolvedModel = model ?? "";
  let resolvedThinking = thinking ?? "";

  if (!resolvedProvider || !resolvedModel || !resolvedThinking) {
    const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
        if (!resolvedProvider && typeof settings.defaultProvider === "string") {
          resolvedProvider = settings.defaultProvider;
        }
        if (!resolvedModel && typeof settings.defaultModel === "string") {
          resolvedModel = settings.defaultModel;
        }
        if (!resolvedThinking && typeof settings.defaultThinkingLevel === "string") {
          resolvedThinking = settings.defaultThinkingLevel;
        }
      } catch {
        // Ignore parse errors in settings.
      }
    }
  }

  return {
    provider: resolvedProvider || "(pi default)",
    model: resolvedModel || "(pi default)",
    thinking: resolvedThinking || "(pi default)",
  };
}

async function confirmPrompt(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

async function runReview(options: ReviewOptions): Promise<void> {
  const config = readWorkspaceConfig(options.workspace);
  resetReviewDir(options.workspace);

  const contextFiles = options.contextFiles.map((file) => resolveContextFile(config.cwd, file));
  for (const file of contextFiles) {
    if (!fs.existsSync(file)) throw new Error(`Context file not found: ${file}`);
  }

  const contextHashes = await hashContextFiles(contextFiles);
  const redactedDir = workspacePath(options.workspace, "redacted");
  const sessionFiles = fs.readdirSync(redactedDir).filter((file) => file.endsWith(".jsonl")).sort();
  if (sessionFiles.length === 0) {
    console.log("No redacted session files found in workspace/redacted");
    return;
  }

  const resolved = resolvePiDefaults(options.provider, options.model, options.thinking);

  console.log(`Workspace: ${options.workspace}`);
  console.log(`Redacted session files: ${sessionFiles.length}`);
  console.log(`Context files: ${contextFiles.length}`);
  console.log(`Provider: ${resolved.provider}`);
  console.log(`Model: ${resolved.model}`);
  console.log(`Thinking: ${resolved.thinking}`);
  console.log(`Parallel: ${options.parallel}`);
  console.log(`Deny patterns: ${options.denyPatterns.length}`);

  const confirmed = await confirmPrompt("\nProceed with LLM review? (y/n) ");
  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  let reviewed = 0;
  let skipped = 0;
  let denied = 0;
  let queued = 0;

  // Build work items
  interface ReviewWorkItem {
    file: string;
    redactedPath: string;
    reviewPath: string;
    redactedHash: string;
    reviewKey: string;
  }

  const workItems: ReviewWorkItem[] = [];

  for (const file of sessionFiles) {
    const redactedPath = workspacePath(options.workspace, "redacted", file);
    const reviewPath = workspacePath(options.workspace, "review", `${file}.review.json`);
    const redactedHash = await sha256File(redactedPath);
    const reviewKey = computeReviewKey(redactedHash, contextHashes, options.provider, options.model, options.thinking);
    const existingReview = loadReviewFile(reviewPath);

    if (existingReview?.review_key === reviewKey) {
      skipped++;
      continue;
    }

    // Check deny patterns against redacted content
    if (options.denyPatterns.length > 0) {
      const content = fs.readFileSync(redactedPath, "utf-8");
      const matchedPattern = options.denyPatterns.find((p) => p.test(content));
      if (matchedPattern) {
        const denyReview = createDenyReview(
          file, contextFiles, contextHashes, redactedHash, reviewKey,
          options.provider, options.model, matchedPattern.source,
        );
        fs.writeFileSync(reviewPath, `${JSON.stringify(denyReview, null, 2)}\n`);
        denied++;
        continue;
      }
    }

    workItems.push({ file, redactedPath, reviewPath, redactedHash, reviewKey });
  }

  queued = workItems.length;
  console.log(`Skipped existing: ${skipped}`);
  console.log(`Denied by pattern: ${denied}`);
  console.log(`Queued for LLM review: ${queued}`);

  // Process work items in parallel batches
  const parallel = Math.max(1, options.parallel);

  async function processWorkItem(item: ReviewWorkItem): Promise<SessionReviewFile> {
    const chunkDir = workspacePath(options.workspace, "review-chunks", item.file);
    fs.mkdirSync(chunkDir, { recursive: true });
    const chunkFiles = await splitIntoReviewChunks(item.redactedPath, chunkDir);
    const chunkResults: SessionReviewFile["chunks"] = [];

    for (let i = 0; i < chunkFiles.length; i++) {
      const chunkFile = chunkFiles[i];
      const chunkText = fs.readFileSync(chunkFile, "utf-8");
      try {
        const result = await reviewChunkWithPi(
          config.cwd,
          contextFiles,
          chunkFile,
          i + 1,
          chunkFiles.length,
          options.provider,
          options.model,
          options.thinking,
        );
        chunkResults.push({
          chunk_index: i + 1,
          chunk_file: chunkFile,
          chars: chunkText.length,
          result,
        });
      } catch (error) {
        chunkResults.push({
          chunk_index: i + 1,
          chunk_file: chunkFile,
          chars: chunkText.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const aggregate = aggregateChunkReviews(chunkResults);
    return {
      file: item.file,
      context_files: contextFiles,
      context_hashes: contextHashes,
      provider: options.provider,
      model: options.model,
      redacted_hash: item.redactedHash,
      review_key: item.reviewKey,
      prompt_version: REVIEW_PROMPT_VERSION,
      chunk_count: chunkFiles.length,
      chunk_char_limit: REVIEW_CHUNK_CHAR_LIMIT,
      chunks: chunkResults,
      aggregate,
    };
  }

  let nextIndex = 0;
  let inflight = 0;

  function printProgress(): void {
    process.stdout.write(`\r[${reviewed + denied + skipped}/${sessionFiles.length}] reviewed=${reviewed} denied=${denied} inflight=${inflight}`);
  }

  await new Promise<void>((resolve, reject) => {
    function startNext(): void {
      while (inflight < parallel && nextIndex < workItems.length) {
        const item = workItems[nextIndex++];
        inflight++;
        printProgress();
        processWorkItem(item)
          .then((result) => {
            const reviewPath = workspacePath(options.workspace, "review", `${result.file}.review.json`);
            fs.writeFileSync(reviewPath, `${JSON.stringify(result, null, 2)}\n`);
            reviewed++;
            inflight--;
            printProgress();
            startNext();
          })
          .catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
      }
      if (inflight === 0 && nextIndex >= workItems.length) {
        resolve();
      }
    }
    startNext();
  });

  console.log();
  console.log(`Reviewed: ${reviewed}`);
  console.log(`Denied by pattern: ${denied}`);
  console.log(`Skipped existing review: ${skipped}`);
  console.log(`Review sidecars written to ${workspacePath(options.workspace, "review")}`);
}

function createDenyReview(
  file: string,
  contextFiles: string[],
  contextHashes: Record<string, string>,
  redactedHash: string,
  reviewKey: string,
  provider: string | undefined,
  model: string | undefined,
  patternSource: string,
): SessionReviewFile {
  return {
    file,
    context_files: contextFiles,
    context_hashes: contextHashes,
    provider,
    model,
    redacted_hash: redactedHash,
    review_key: reviewKey,
    prompt_version: REVIEW_PROMPT_VERSION,
    chunk_count: 0,
    chunk_char_limit: REVIEW_CHUNK_CHAR_LIMIT,
    chunks: [],
    aggregate: {
      about_project: "no",
      shareable: "no",
      missed_sensitive_data: "no",
      flagged_parts: [{ reason: "deny-pattern", evidence: patternSource }],
      summary: `Session denied by pattern: ${patternSource}`,
    },
  };
}

function resolveContextFile(cwd: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}

async function splitIntoReviewChunks(sessionFile: string, chunkDir: string): Promise<string[]> {
  fs.rmSync(chunkDir, { recursive: true, force: true });
  fs.mkdirSync(chunkDir, { recursive: true });

  const chunkFiles: string[] = [];
  let chunkIndex = 1;
  let current = "";

  const input = fs.createReadStream(sessionFile, { encoding: "utf-8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of reader) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    const blocks = serializeEntryForReview(parsed as JsonObject);
    for (const block of blocks) {
      if (!block) continue;
      const next = `${block}\n\n`;
      if (current.length > 0 && current.length + next.length > REVIEW_CHUNK_CHAR_LIMIT) {
        const file = path.join(chunkDir, `${String(chunkIndex).padStart(3, "0")}.txt`);
        fs.writeFileSync(file, current);
        chunkFiles.push(file);
        chunkIndex++;
        current = "";
      }
      current += next;
    }
  }

  if (current.length > 0 || chunkFiles.length === 0) {
    const file = path.join(chunkDir, `${String(chunkIndex).padStart(3, "0")}.txt`);
    fs.writeFileSync(file, current);
    chunkFiles.push(file);
  }

  return chunkFiles;
}

const REVIEW_TOOL_RESULT_MAX_CHARS = 2000;
const REVIEW_JSON_VALUE_MAX_CHARS = 4000;

function serializeEntryForReview(entry: JsonObject): string[] {
  const parts: string[] = [];

  if (entry.type === "session") {
    if (typeof entry.cwd === "string") parts.push(`[Session cwd]: ${entry.cwd}`);
    if (typeof entry.parentSession === "string") parts.push(`[Parent session]: ${entry.parentSession}`);
    return parts;
  }

  if (entry.type === "session_info") {
    if (typeof entry.name === "string") parts.push(`[Session info]: ${entry.name}`);
    return parts;
  }

  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    parts.push(`[Branch summary]: ${entry.summary}`);
    if (entry.details !== undefined) parts.push(`[Branch summary details]: ${truncateForReview(stringifyJson(entry.details), REVIEW_JSON_VALUE_MAX_CHARS)}`);
    return parts;
  }

  if (entry.type === "compaction" && typeof entry.summary === "string") {
    parts.push(`[Compaction summary]: ${entry.summary}`);
    if (entry.details !== undefined) parts.push(`[Compaction details]: ${truncateForReview(stringifyJson(entry.details), REVIEW_JSON_VALUE_MAX_CHARS)}`);
    return parts;
  }

  if (entry.type === "custom") {
    if (typeof entry.customType === "string") {
      parts.push(`[Custom entry:${entry.customType}]: ${truncateForReview(stringifyJson(entry.data), REVIEW_JSON_VALUE_MAX_CHARS)}`);
    } else {
      parts.push(`[Custom entry]: ${truncateForReview(stringifyJson(entry.data), REVIEW_JSON_VALUE_MAX_CHARS)}`);
    }
    return parts;
  }

  if (entry.type === "custom_message") {
    const prefix = typeof entry.customType === "string" ? `[Custom message:${entry.customType}]` : `[Custom message]`;
    const content = serializeContentLikeUser(entry.content as JsonValue | undefined);
    if (content) parts.push(`${prefix}: ${content}`);
    if (entry.details !== undefined) parts.push(`${prefix} details: ${truncateForReview(stringifyJson(entry.details), REVIEW_JSON_VALUE_MAX_CHARS)}`);
    return parts;
  }

  if (entry.type !== "message" || !isRecord(entry.message)) return parts;
  const message = entry.message as JsonObject;
  const role = typeof message.role === "string" ? message.role : undefined;
  if (!role) return parts;

  if (role === "user") {
    const content = serializeContentLikeUser(message.content as JsonValue | undefined);
    if (content) parts.push(`[User]: ${content}`);
    return parts;
  }

  if (role === "assistant") {
    const content = Array.isArray(message.content) ? message.content : [];
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: string[] = [];

    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== "string") continue;
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        thinkingParts.push(block.thinking);
      } else if (block.type === "toolCall") {
        const name = typeof block.name === "string" ? block.name : "tool";
        const args = isRecord(block.arguments) ? block.arguments : {};
        const argsText = Object.entries(args)
          .map(([key, value]) => `${key}=${stringifyJson(value as JsonValue)}`)
          .join(", ");
        const partialJson = typeof block.partialJson === "string"
          ? ` raw=${truncateForReview(block.partialJson, REVIEW_JSON_VALUE_MAX_CHARS)}`
          : "";
        toolCalls.push(`${name}(${argsText})${partialJson}`);
      }
    }

    if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
    if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
    if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    return parts;
  }

  if (role === "toolResult") {
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    const content = serializeToolResultContent(message.content as JsonValue | undefined);
    if (content) parts.push(`[Tool result:${toolName}]: ${truncateForReview(content, REVIEW_TOOL_RESULT_MAX_CHARS)}`);
    if (message.details !== undefined) {
      parts.push(`[Tool result details:${toolName}]: ${truncateForReview(stringifyJson(message.details), REVIEW_JSON_VALUE_MAX_CHARS)}`);
    }
    return parts;
  }

  if (role === "bashExecution") {
    if (typeof message.command === "string") parts.push(`[Bash command]: ${message.command}`);
    if (typeof message.output === "string") parts.push(`[Bash output]: ${truncateForReview(message.output, REVIEW_TOOL_RESULT_MAX_CHARS)}`);
    return parts;
  }

  if (role === "custom") {
    const prefix = typeof message.customType === "string" ? `[Custom message:${message.customType}]` : `[Custom message]`;
    const content = serializeContentLikeUser(message.content as JsonValue | undefined);
    if (content) parts.push(`${prefix}: ${content}`);
    if (message.details !== undefined) parts.push(`${prefix} details: ${truncateForReview(stringifyJson(message.details), REVIEW_JSON_VALUE_MAX_CHARS)}`);
    return parts;
  }

  if (role === "branchSummary" && typeof message.summary === "string") {
    parts.push(`[Branch summary]: ${message.summary}`);
    return parts;
  }

  if (role === "compactionSummary" && typeof message.summary === "string") {
    parts.push(`[Compaction summary]: ${message.summary}`);
    return parts;
  }

  return parts;
}

function serializeContentLikeUser(content: JsonValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image";
      parts.push(`[Image preserved: ${mimeType}]`);
    }
  }
  return parts.join("\n");
}

function serializeToolResultContent(content: JsonValue | undefined): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image";
      parts.push(`[Image preserved: ${mimeType}]`);
    }
  }
  return parts.join("\n");
}

function stringifyJson(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function truncateForReview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

async function reviewChunkWithPi(
  cwd: string,
  contextFiles: string[],
  chunkFile: string,
  chunkIndex: number,
  chunkCount: number,
  provider?: string,
  model?: string,
  thinking?: string,
): Promise<ChunkReviewResult> {
  const prompt = createReviewPrompt(chunkIndex, chunkCount);
  const args = [
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-tools",
  ];

  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);

  // Include all context files and the chunk file directly via @file
  for (const file of contextFiles) {
    args.push(`@${file}`);
  }
  args.push(`@${chunkFile}`);

  args.push("-p", prompt);

  const result = await runCommand("pi", args, cwd);

  if (!result.ok) {
    throw new Error(`pi review failed: ${result.stderr || result.stdout || "unknown error"}`);
  }

  const parsed = parseChunkReviewResult(result.stdout);
  if (!parsed) {
    throw new Error(`Could not parse JSON review result from pi output:\n${result.stdout}`);
  }

  return parsed;
}

function createReviewPrompt(chunkIndex: number, chunkCount: number): string {
  return [
    "Review a redacted pi session chunk for public OSS dataset sharing.",
    "",
    "The attached files include project context files followed by the session chunk as the last file.",
    "Judge whether the session chunk is about the OSS project, whether it is fit to share publicly on Hugging Face, and whether there appears to be missed sensitive data after deterministic redaction.",
    "The session chunk is a serialized plain-text transcript derived from a redacted session file. It may contain user messages, assistant text, thinking blocks, tool calls, tool results, bash output, custom entries, branch summaries, compaction summaries, preserved image markers, and verbatim JSON for details/custom data.",
    "",
    `This is chunk ${chunkIndex} of ${chunkCount}.`,
    "",
    "Return ONLY strict JSON with this schema:",
    "{",
    '  "about_project": "yes" | "no" | "mixed",',
    '  "shareable": "yes" | "no" | "manual_review",',
    '  "missed_sensitive_data": "yes" | "no" | "maybe",',
    '  "flagged_parts": [{ "reason": string, "evidence": string }],',
    '  "summary": string',
    "}",
    "",
    "Guidance:",
    "- about_project=no if the chunk is clearly unrelated to the OSS project.",
    "- about_project=mixed if it contains both project-related and unrelated/private content.",
    "- shareable=yes only if the chunk looks public-appropriate after redaction.",
    "- shareable=manual_review if there is uncertainty.",
    "- missed_sensitive_data=yes if you see likely missed secrets, API keys, tokens, passwords, PII, or confidential data.",
    "- missed_sensitive_data=maybe if you suspect it but are not confident.",
    "- Pay special attention to possible leaked API keys, bearer tokens, OAuth tokens, secret-like strings, and credentials that deterministic redaction may have missed.",
    "- Email addresses in git-related public OSS context are acceptable by default. Examples: commit author lines, public git metadata, repository history, issue or PR discussions about public contributors. Do NOT flag those by themselves as missed sensitive data.",
    "- Do NOT treat assistant thinking blocks or provider thinking signatures as missed sensitive data by themselves. They are expected to remain in the dataset unless they contain other clearly sensitive content.",
    "- Do NOT flag preserved embedded images merely because the image payload remains. Only flag them if there is specific evidence that the image likely contains sensitive content.",
    "- flagged_parts should quote short redacted excerpts only. Do not invent evidence.",
  ].join("\n");
}

function parseChunkReviewResult(text: string): ChunkReviewResult | undefined {
  const cleaned = extractJsonObject(text);
  if (!cleaned) return undefined;

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (!isAboutProject(parsed.about_project)) return undefined;
    if (!isShareable(parsed.shareable)) return undefined;
    if (!isMissedSensitiveData(parsed.missed_sensitive_data)) return undefined;
    if (typeof parsed.summary !== "string") return undefined;
    const flaggedParts = Array.isArray(parsed.flagged_parts)
      ? parsed.flagged_parts
          .map((item) => parseFlaggedPart(item))
          .filter((item): item is ReviewFlaggedPart => item !== undefined)
      : [];

    return {
      about_project: parsed.about_project,
      shareable: parsed.shareable,
      missed_sensitive_data: parsed.missed_sensitive_data,
      flagged_parts: flaggedParts,
      summary: parsed.summary,
    };
  } catch {
    return undefined;
  }
}

function parseFlaggedPart(value: unknown): ReviewFlaggedPart | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.reason !== "string") return undefined;
  if (typeof value.evidence !== "string") return undefined;
  return { reason: value.reason, evidence: value.evidence };
}

function isAboutProject(value: unknown): value is AboutProject {
  return value === "yes" || value === "no" || value === "mixed";
}

function isShareable(value: unknown): value is Shareable {
  return value === "yes" || value === "no" || value === "manual_review";
}

function isMissedSensitiveData(value: unknown): value is MissedSensitiveData {
  return value === "yes" || value === "no" || value === "maybe";
}

function extractJsonObject(text: string): string | undefined {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return undefined;
  return text.slice(firstBrace, lastBrace + 1);
}

function aggregateChunkReviews(chunks: SessionReviewFile["chunks"]): ChunkReviewResult {
  const successful = chunks.flatMap((chunk) => (chunk.result ? [{ ...chunk.result, chunk_index: chunk.chunk_index }] : []));
  if (successful.length === 0) {
    return {
      about_project: "mixed",
      shareable: "manual_review",
      missed_sensitive_data: "maybe",
      flagged_parts: [{ reason: "review-failed", evidence: "All chunk reviews failed" }],
      summary: "All chunk reviews failed.",
    };
  }

  let aboutProject: AboutProject = successful[0].about_project;
  const aboutSet = new Set(successful.map((chunk) => chunk.about_project));
  if (aboutSet.size > 1 || aboutSet.has("mixed")) aboutProject = "mixed";

  let shareable: Shareable = "yes";
  if (successful.some((chunk) => chunk.shareable === "no")) shareable = "no";
  else if (successful.some((chunk) => chunk.shareable === "manual_review")) shareable = "manual_review";

  let missedSensitiveData: MissedSensitiveData = "no";
  if (successful.some((chunk) => chunk.missed_sensitive_data === "yes")) missedSensitiveData = "yes";
  else if (successful.some((chunk) => chunk.missed_sensitive_data === "maybe")) missedSensitiveData = "maybe";

  const flaggedParts = successful.flatMap((chunk) =>
    chunk.flagged_parts.map((flag) => ({
      chunk_index: chunk.chunk_index,
      reason: flag.reason,
      evidence: flag.evidence,
    }))
  );

  const summary = successful.map((chunk) => chunk.summary).filter(Boolean).join(" | ");

  return {
    about_project: aboutProject,
    shareable,
    missed_sensitive_data: missedSensitiveData,
    flagged_parts: flaggedParts,
    summary,
  };
}

function loadReviewFile(filePath: string): SessionReviewFile | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (typeof parsed.file !== "string") return undefined;
    if (!isRecord(parsed.aggregate)) return undefined;
    const aggregate = parsed.aggregate;
    if (!isAboutProject(aggregate.about_project)) return undefined;
    if (!isShareable(aggregate.shareable)) return undefined;
    if (!isMissedSensitiveData(aggregate.missed_sensitive_data)) return undefined;
    return parsed as unknown as SessionReviewFile;
  } catch {
    return undefined;
  }
}

async function hashContextFiles(files: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of files) {
    hashes[file] = await sha256File(file);
  }
  return hashes;
}

function computeReviewKey(
  redactedHash: string,
  contextHashes: Record<string, string>,
  provider?: string,
  model?: string,
  thinking?: string,
): string {
  return sha256Text(JSON.stringify({
    redactedHash,
    contextHashes,
    provider,
    model,
    thinking,
    promptVersion: REVIEW_PROMPT_VERSION,
    chunkCharLimit: REVIEW_CHUNK_CHAR_LIMIT,
  }));
}

async function runUpload(options: UploadOptions): Promise<void> {
  const config = readWorkspaceConfig(options.workspace);
  const repo = config.repo;

  const localManifest = loadLocalManifest(workspacePath(options.workspace, LOCAL_MANIFEST_FILE));
  if (localManifest.size === 0) {
    console.log(`No local manifest entries found in ${workspacePath(options.workspace, LOCAL_MANIFEST_FILE)}`);
    return;
  }

  const entries = [...localManifest.values()].sort((a, b) => a.file.localeCompare(b.file));
  let approved = 0;
  let rejected = 0;
  let noReview = 0;
  let missingLocal = 0;
  let unchanged = 0;

  const remoteManifestPath = workspacePath(options.workspace, REMOTE_MANIFEST_CACHE_FILE);
  const remoteManifest = await downloadRemoteManifest(repo, remoteManifestPath);

  for (const entry of entries) {
    const reviewFile = loadReviewFile(workspacePath(options.workspace, "review", `${entry.file}.review.json`));
    const localFile = workspacePath(options.workspace, "redacted", entry.file);

    if (!fs.existsSync(localFile)) {
      missingLocal++;
      continue;
    }

    if (!reviewFile) {
      noReview++;
      continue;
    }

    if (!isUploadApproved(reviewFile.aggregate)) {
      rejected++;
      continue;
    }

    const remoteEntry = remoteManifest.get(entry.file);
    if (remoteEntry?.redacted_hash === entry.redacted_hash) {
      unchanged++;
      continue;
    }

    approved++;
  }

  console.log(`Total sessions: ${entries.length}`);
  console.log(`Approved by review: ${approved}`);
  console.log(`Rejected by review: ${rejected}`);
  console.log(`No review data: ${noReview}`);
  console.log(`Already uploaded (unchanged): ${unchanged}`);
  console.log(`Missing local redacted file: ${missingLocal}`);

  if (noReview > 0) {
    console.log(`\nRefusing to upload: ${noReview} session(s) have no review data. Run review first.`);
    return;
  }

  if (options.dryRun) {
    console.log("\nDry run, not uploading.");
    return;
  }

  if (approved === 0) {
    console.log("\nNothing to upload.");
    return;
  }

  await ensureDatasetRepo(repo);

  // Stage approved files into a temporary upload directory so we can upload
  // everything in a single commit instead of one commit per file.
  const uploadDir = workspacePath(options.workspace, "_upload_staging");
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  const updatedManifest = new Map(remoteManifest);
  let staged = 0;

  for (const entry of entries) {
    const reviewFile = loadReviewFile(workspacePath(options.workspace, "review", `${entry.file}.review.json`));
    if (!reviewFile || !isUploadApproved(reviewFile.aggregate)) continue;

    const remoteEntry = remoteManifest.get(entry.file);
    if (remoteEntry?.redacted_hash === entry.redacted_hash) continue;

    const localFile = workspacePath(options.workspace, "redacted", entry.file);
    if (!fs.existsSync(localFile)) continue;

    fs.copyFileSync(localFile, path.join(uploadDir, entry.file));
    updatedManifest.set(entry.file, {
      file: entry.file,
      source_hash: entry.source_hash,
      redacted_hash: entry.redacted_hash,
    });
    staged++;
  }

  // Write manifest into the staging directory
  const manifestContents = [...updatedManifest.values()]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  fs.writeFileSync(path.join(uploadDir, REMOTE_MANIFEST_FILE), manifestContents.length > 0 ? `${manifestContents}\n` : "");

  console.log(`Staged ${staged} files for upload`);
  console.log("Uploading...");

  await uploadFolder(repo, uploadDir);

  // Copy manifest back to workspace
  fs.copyFileSync(path.join(uploadDir, REMOTE_MANIFEST_FILE), workspacePath(options.workspace, REMOTE_MANIFEST_FILE));
  fs.rmSync(uploadDir, { recursive: true, force: true });

  console.log(`Uploaded: ${staged}`);
  console.log(`Updated remote manifest: ${REMOTE_MANIFEST_FILE}`);
}

function isUploadApproved(result: ChunkReviewResult): boolean {
  if (result.shareable !== "yes") return false;
  if (result.missed_sensitive_data !== "no") return false;
  if (result.about_project === "no") return false;
  return true;
}

async function ensureDatasetRepo(repo: string): Promise<void> {
  // huggingface-cli repo create expects just the repo name, with --organization
  // for namespaced repos. For personal accounts (user/repo), pass just the name.
  const slash = repo.indexOf("/");
  const name = slash === -1 ? repo : repo.slice(slash + 1);
  const owner = slash === -1 ? undefined : repo.slice(0, slash);

  const args = ["repo", "create", name, "--type", "dataset", "-y"];
  if (owner) args.splice(4, 0, "--organization", owner);

  const result = await runCommand("huggingface-cli", args);
  if (!result.ok) {
    const text = `${result.stdout}\n${result.stderr}`;
    if (text.includes("already exists") || text.includes("You already created") || text.includes("409")) {
      return;
    }
    // If creation failed for another reason, the first upload will fail with
    // a clear error, so we do not throw here.
  }
}


async function uploadFolder(repo: string, localDir: string): Promise<void> {
  const result = await runCommand("huggingface-cli", [
    "upload",
    repo,
    localDir,
    ".",
    "--repo-type",
    "dataset",
    "--commit-message",
    `pi-share-hf upload ${new Date().toISOString()}`,
  ]);
  if (!result.ok) {
    throw new Error(`Upload failed: ${result.stderr || result.stdout}`);
  }
}

async function ensureStartupTools(command: string): Promise<void> {
  const missing: string[] = [];

  if (command === "collect" || command === "upload") {
    if (!(await commandExists("huggingface-cli"))) {
      missing.push([
        "Missing required command: huggingface-cli",
        "Install it with:",
        '  python3 -m pip install --user "huggingface_hub[cli]"',
        "Then log in with:",
        "  huggingface-cli login",
      ].join("\n"));
    }
  }

  if (command === "review") {
    if (!(await commandExists("pi"))) {
      missing.push([
        "Missing required command: pi",
        "Install it with:",
        "  npm install -g @mariozechner/pi-coding-agent",
      ].join("\n"));
    }
  }

  if (missing.length > 0) {
    throw new Error(missing.join("\n\n"));
  }
}

async function commandExists(command: string): Promise<boolean> {
  const result = await runCommand(command, ["--help"]);
  return result.ok || !result.stderr.includes("ENOENT");
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += String(error);
      resolve({ ok: false, stdout, stderr });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
