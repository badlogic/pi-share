#!/usr/bin/env node --experimental-strip-types --no-warnings=ExperimentalWarning

import { parseCollectArgs, parseGrepArgs, parseInitArgs, parseListArgs, parseRejectArgs, parseReviewArgs, parseUploadArgs, printUsage } from "./cli.ts";
import { runCollect, runInit } from "./collect.ts";
import { ensureStartupTools } from "./process.ts";
import { runReject } from "./reject.ts";
import { runReview } from "./review.ts";
import { runUpload } from "./upload.ts";
import { runGrep, runList } from "./query.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h" || args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  await ensureStartupTools(command);

  if (command === "init") {
    await runInit(parseInitArgs(args.slice(1)));
    return;
  }

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

  if (command === "reject") {
    await runReject(parseRejectArgs(args.slice(1)));
    return;
  }

  if (command === "list") {
    await runList(parseListArgs(args.slice(1)));
    return;
  }

  if (command === "grep") {
    await runGrep(parseGrepArgs(args.slice(1)));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
