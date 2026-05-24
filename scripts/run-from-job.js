"use strict";

/**
 * Alternate pipeline entry-point for the web UI.
 * Takes a jobId as the first argument — the job JSON must already exist
 * in jobs/queued/. Runs steps 2-5 (pull → validate → enrich → QA).
 *
 * Usage: node scripts/run-from-job.js <jobId>
 */

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const ROOT = path.resolve(__dirname, "..");

const PULL_SCRIPTS = {
  apollo: "scripts/apollo/apollo-pull.js",
  aiark:  "scripts/aiark/aiark-pull.js",
};

let pipelineLogPath = null;

function log(pipelineId, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${pipelineId}] ${message}`;
  console.log(line);
  if (pipelineLogPath) fs.appendFileSync(pipelineLogPath, line + "\n");
}

function runStep(label, scriptPath, pipelineId, args = []) {
  const divider = "─".repeat(52);
  console.log(`\n${divider}\n  ${label}\n${divider}`);
  log(pipelineId, `▶  ${label} — start`);

  const start = Date.now();
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env },
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (result.status !== 0) {
    log(pipelineId, `✗  ${label} — FAILED (${elapsed}s)`);
    return false;
  }

  log(pipelineId, `✓  ${label} — success (${elapsed}s)`);
  return true;
}

function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("Usage: node scripts/run-from-job.js <jobId>");
    process.exit(1);
  }

  const jobPath = path.join(ROOT, "jobs/queued", `${jobId}.json`);
  if (!fs.existsSync(jobPath)) {
    console.error(`Job not found in jobs/queued/: ${jobId}`);
    process.exit(1);
  }

  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  const pipelineId = `pipeline_${Date.now()}`;
  const logDir = path.join(ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  pipelineLogPath = path.join(logDir, `pipeline-${new Date().toISOString().slice(0, 10)}.log`);

  const divider = "═".repeat(52);
  const header = [
    "",
    divider,
    "  ANEVO-GTM PIPELINE (from job)",
    divider,
    `  Job ID  : ${jobId}`,
    `  Client  : ${job.clientName}`,
    `  List    : ${job.listName}`,
    `  Source  : ${job.source}`,
    `  Run ID  : ${pipelineId}`,
    `  Started : ${new Date().toISOString()}`,
    divider,
    "",
  ].join("\n");

  console.log(header);
  fs.appendFileSync(pipelineLogPath, header + "\n");

  const pullScript = PULL_SCRIPTS[job.source];
  if (!pullScript) {
    log(pipelineId, `ERROR — unknown source "${job.source}"`);
    process.exit(1);
  }

  if (!runStep(`Step 2 / Pull [${job.source}]`, pullScript, pipelineId, [job.jobId])) process.exit(1);
  if (!runStep("Step 3 / Email Validation", "scripts/apollo/email-validation.js", pipelineId)) process.exit(1);
  if (!runStep("Step 4 / AI Enrichment",    "scripts/apollo/ai-enrichment.js",    pipelineId)) process.exit(1);
  if (!runStep("Step 5 / QA Flagging",      "scripts/apollo/qa-flagging.js",      pipelineId)) process.exit(1);

  const summary = [
    "",
    divider,
    "  PIPELINE COMPLETE ✓",
    divider,
    `  Client : ${job.clientName}`,
    `  List   : ${job.listName}`,
    `  Source : ${job.source}`,
    divider,
    "",
  ].join("\n");

  console.log(summary);
  fs.appendFileSync(pipelineLogPath, summary + "\n");
}

main();
