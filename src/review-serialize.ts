import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { JsonObject, JsonValue } from "./types.ts";
import { REVIEW_CHUNK_CHAR_LIMIT, REVIEW_JSON_VALUE_MAX_CHARS, REVIEW_TOOL_RESULT_MAX_CHARS } from "./types.ts";
import { isRecord } from "./workspace.ts";

const CHUNK_CONTINUATION_PREFIX = "[continued]\n";

export async function splitIntoReviewChunks(sessionFile: string, chunkDir: string): Promise<string[]> {
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
      const pieces = splitBlockForChunkLimit(block, REVIEW_CHUNK_CHAR_LIMIT - 2);
      for (const piece of pieces) {
        const next = `${piece}\n\n`;
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
  }

  if (current.length > 0 || chunkFiles.length === 0) {
    const file = path.join(chunkDir, `${String(chunkIndex).padStart(3, "0")}.txt`);
    fs.writeFileSync(file, current);
    chunkFiles.push(file);
  }

  return chunkFiles;
}

export function extractImagesFromSession(sessionPath: string, imagesDir: string, sessionFile: string): string[] {
  fs.mkdirSync(imagesDir, { recursive: true });
  const extracted: string[] = [];
  const content = fs.readFileSync(sessionPath, "utf-8");
  const lines = content.split("\n");

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const sessionBase = sessionFile.replace(".jsonl", "");
    let imgIndex = 0;

    function walk(val: unknown): void {
      if (val === null || val === undefined) return;
      if (Array.isArray(val)) {
        for (const item of val) walk(item);
        return;
      }
      if (typeof val === "object") {
        const rec = val as Record<string, unknown>;
        if (
          rec.type === "image" &&
          typeof rec.data === "string" &&
          typeof rec.mimeType === "string" &&
          (rec.data as string).length > 256
        ) {
          const mime = rec.mimeType as string;
          const ext = ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" } as Record<string, string>)[mime] ?? ".bin";
          try {
            const raw = Buffer.from(rec.data as string, "base64");
            const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
            const fname = `${sessionBase}_L${lineNum + 1}_${imgIndex}_${hash}${ext}`;
            const outPath = path.join(imagesDir, fname);
            fs.writeFileSync(outPath, raw);
            extracted.push(outPath);
            imgIndex++;
          } catch {
            // Skip malformed base64
          }
        } else {
          for (const v of Object.values(rec)) walk(v);
        }
      }
    }

    walk(obj);
  }

  return extracted;
}

export function serializeEntryForReview(entry: JsonObject): string[] {
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

function splitBlockForChunkLimit(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const pieces: string[] = [];
  let remaining = text;
  let first = true;

  while (remaining.length > 0) {
    const prefix = first ? "" : CHUNK_CONTINUATION_PREFIX;
    const budget = prefix.length < maxChars ? maxChars - prefix.length : maxChars;
    const piece = remaining.slice(0, budget);
    pieces.push(prefix.length < maxChars ? `${prefix}${piece}` : piece);
    remaining = remaining.slice(budget);
    first = false;
  }

  return pieces;
}
