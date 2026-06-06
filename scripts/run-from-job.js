"use strict";

/**
 * Pipeline entry-point for the web UI.
 * Takes a jobId as the first argument — the job JSON must already exist
 * in jobs/queued/ (new run) or jobs/completed/ / jobs/failed/ (resume).
 *
 * Checkpoint behaviour
 * ─────────────────────
 * On start   : loads jobs/checkpoints/{jobId}.json if it exists
 * Each step  : skips if listed in checkpoint.completedSteps
 * On failure : saves checkpoint, logs "Run again to resume from checkpoint"
 * On success : clears checkpoint
 */

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { saveCheckpoint, loadCheckpoint, clearCheckpoint } = require("./utils/checkpoint");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const ROOT = path.resolve(__dirname, "..");

const PULL_SCRIPTS = {
  apollo: "scripts/apollo/apollo-pull.js",
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

let pipelineLogPath = null;

function log(pipelineId, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${pipelineId}] ${message}`;
  console.log(line);
  if (pipelineLogPath) fs.appendFileSync(pipelineLogPath, line + "\n");
}

// ---------------------------------------------------------------------------
// Job lookup — searches queued → processing → completed → failed
// ---------------------------------------------------------------------------

function findJobAnywhere(jobId) {
  for (const dir of ["queued", "processing", "completed", "failed"]) {
    const p = path.join(ROOT, "jobs", dir, `${jobId}.json`);
    if (fs.existsSync(p)) return { job: JSON.parse(fs.readFileSync(p, "utf8")), dir };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("Usage: node scripts/run-from-job.js <jobId>");
    process.exit(1);
  }

  const found = findJobAnywhere(jobId);
  if (!found) {
    console.error(`Job not found in any jobs/ directory: ${jobId}`);
    process.exit(1);
  }
  const { job } = found;

  const pipelineId = `pipeline_${Date.now()}`;
  const logDir = path.join(ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  pipelineLogPath = path.join(logDir, `pipeline-${new Date().toISOString().slice(0, 10)}.log`);

  // ── Checkpoint: load or initialise ────────────────────────────────────────
  let checkpoint = loadCheckpoint(jobId);
  const isResume = checkpoint !== null;

  if (isResume) {
    log(pipelineId, `♻  Checkpoint found — resuming from step "${checkpoint.failedStep ?? "unknown"}"`);
    if (checkpoint.enrichmentStartBatch > 0) {
      log(pipelineId, `   Enrichment will resume from batch ${checkpoint.enrichmentStartBatch}`);
    }
  } else {
    checkpoint = { jobId, completedSteps: [], enrichmentStartBatch: 0 };
  }

  const divider = "═".repeat(52);
  const header = [
    "",
    divider,
    isResume ? "  ANEVO-GTM PIPELINE (resuming from checkpoint)" : "  ANEVO-GTM PIPELINE (from job)",
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

  // Helper: run a step with checkpoint skip/save/fail handling
  function runCheckedStep(stepKey, label, scriptPath, args = []) {
    if (checkpoint.completedSteps.includes(stepKey)) {
      log(pipelineId, `↩  ${label} — skipped (already completed in prior run)`);
      return true;
    }

    const ok = runStep(label, scriptPath, pipelineId, args);

    if (!ok) {
      checkpoint.failedStep = stepKey;
      saveCheckpoint(jobId, checkpoint);
      log(pipelineId, `💾 Checkpoint saved at step "${stepKey}"`);
      log(pipelineId, `   Completed steps: [${checkpoint.completedSteps.join(", ") || "none"}]`);
      log(pipelineId, `   Run again to resume from checkpoint`);
      return false;
    }

    checkpoint.completedSteps.push(stepKey);
    delete checkpoint.failedStep;
    saveCheckpoint(jobId, checkpoint);
    return true;
  }

  // ── Steps 2–3: Apollo Search + Email Enrichment ──────────────────────────
  // apollo-pull.js runs both internally: people search (free) then bulk_match (credits)
  if (!runCheckedStep(`pull_${job.source}`, `Step 2-3 / Apollo Search + Email Enrichment`, pullScript, [jobId])) {
    process.exit(1);
  }

  // ── Step 4: Email Validation ──────────────────────────────────────────────
  if (!runCheckedStep("email_validation", "Step 4 / Email Validation", "scripts/apollo/email-validation.js")) {
    process.exit(1);
  }

  // ── Step 5: AI Enrichment ─────────────────────────────────────────────────
  const enrichArgs = [`--job-id=${jobId}`];
  if (checkpoint.enrichmentStartBatch > 0) {
    enrichArgs.push(`--start-batch=${checkpoint.enrichmentStartBatch}`);
    log(pipelineId, `   Enrichment resuming from batch ${checkpoint.enrichmentStartBatch}`);
  }

  if (!runCheckedStep("enrichment", "Step 5 / AI Enrichment", "scripts/apollo/ai-enrichment.js", enrichArgs)) {
    process.exit(1);
  }

  // ── Step 6: QA Flagging ───────────────────────────────────────────────────
  if (!runCheckedStep("qa_flagging", "Step 6 / QA Flagging", "scripts/apollo/qa-flagging.js")) {
    process.exit(1);
  }

  // ── Success: clear checkpoint ─────────────────────────────────────────────
  clearCheckpoint(jobId);
  log(pipelineId, "✓  Checkpoint cleared");

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
