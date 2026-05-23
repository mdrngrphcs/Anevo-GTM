"use strict";

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { parse } = require("csv-parse/sync");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const ROOT = path.resolve(__dirname, "..");

const PULL_SCRIPTS = {
  apollo: "scripts/apollo/apollo-pull.js",
  aiark:  "scripts/aiark/aiark-pull.js",
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
// Step runner
// ---------------------------------------------------------------------------

function runStep(label, scriptPath, pipelineId, args = []) {
  const divider = "─".repeat(52);
  console.log(`\n${divider}`);
  console.log(`  ${label}`);
  console.log(divider);
  log(pipelineId, `▶  ${label} — start`);

  const start = Date.now();
  const result = spawnSync("node", [scriptPath, ...args], {
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
// Job queue helpers
// ---------------------------------------------------------------------------

function snapshotQueue() {
  const dir = path.join(ROOT, "jobs/queued");
  fs.mkdirSync(dir, { recursive: true });
  return new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".json")));
}

function findNewQueuedJob(before) {
  const dir = path.join(ROOT, "jobs/queued");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const newFile = files.find((f) => !before.has(f));
  if (!newFile) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, newFile), "utf8"));
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

function findLatestFinalCSV() {
  const dir = path.join(ROOT, "data/final");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".csv"))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.name ?? null;
}

function parseFinalStats(finalFilename) {
  const rows = parse(
    fs.readFileSync(path.join(ROOT, "data/final", finalFilename), "utf8"),
    { columns: true, skip_empty_lines: true, trim: true }
  );
  return {
    total: rows.length,
    validEmails: rows.filter((r) => r["Valid Email"] === "Valid Email").length,
    icpFit: rows.filter((r) => r["icp_classification"] === "icp fit").length,
    qaApproved: rows.filter((r) => r["qa_status"] === "approved").length,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const configArg = process.argv[2];
  if (!configArg) {
    console.error("Usage: node scripts/run-pipeline.js <job-config-file>");
    console.error("Example: node scripts/run-pipeline.js testing/sample-job.js");
    process.exit(1);
  }

  const configPath = path.resolve(ROOT, configArg);
  if (!fs.existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  const pipelineId = `pipeline_${Date.now()}`;
  const logDir = path.join(ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  pipelineLogPath = path.join(logDir, `pipeline-${new Date().toISOString().slice(0, 10)}.log`);

  const divider = "═".repeat(52);
  const header = [
    "",
    divider,
    "  ANEVO-GTM PIPELINE",
    divider,
    `  Config  : ${configArg}`,
    `  Run ID  : ${pipelineId}`,
    `  Started : ${new Date().toISOString()}`,
    divider,
    "",
  ].join("\n");

  console.log(header);
  fs.appendFileSync(pipelineLogPath, header + "\n");

  // ── Step 1: Create job ───────────────────────────────────────────────────
  const queueBefore = snapshotQueue();

  if (!runStep("Step 1 / Job Config", configPath, pipelineId)) {
    process.exit(1);
  }

  const job = findNewQueuedJob(queueBefore);
  if (!job) {
    log(pipelineId, "ERROR — could not find newly queued job after Step 1");
    process.exit(1);
  }
  log(pipelineId, `Job queued: ${job.jobId} | source: ${job.source} | client: ${job.clientName}`);

  // ── Step 2: Pull (source-dependent) ─────────────────────────────────────
  const pullScript = PULL_SCRIPTS[job.source];

  if (!pullScript) {
    log(pipelineId, `ERROR — unknown source "${job.source}", no pull script mapped`);
    process.exit(1);
  }

  if (!runStep(`Step 2 / Pull [${job.source}]`, pullScript, pipelineId, [job.jobId])) {
    process.exit(1);
  }

  // ── Step 3: Email Validation ─────────────────────────────────────────────
  if (!runStep("Step 3 / Email Validation", "scripts/apollo/email-validation.js", pipelineId)) {
    process.exit(1);
  }

  // ── Step 4: AI Enrichment ────────────────────────────────────────────────
  if (!runStep("Step 4 / AI Enrichment", "scripts/apollo/ai-enrichment.js", pipelineId)) {
    process.exit(1);
  }

  // ── Step 5: QA Flagging ──────────────────────────────────────────────────
  if (!runStep("Step 5 / QA Flagging", "scripts/apollo/qa-flagging.js", pipelineId)) {
    process.exit(1);
  }

  // ── Final Summary ────────────────────────────────────────────────────────
  const finalFile = findLatestFinalCSV();
  const stats = finalFile ? parseFinalStats(finalFile) : null;

  const summary = [
    "",
    divider,
    "  PIPELINE COMPLETE ✓",
    divider,
    `  Client         : ${job.clientName}`,
    `  List           : ${job.listName}`,
    `  Source         : ${job.source}`,
    ...(stats
      ? [
          `  Records pulled : ${stats.total}`,
          `  Valid emails   : ${stats.validEmails}`,
          `  ICP fit        : ${stats.icpFit}`,
          `  QA approved    : ${stats.qaApproved}`,
        ]
      : ["  (could not parse final CSV for stats)"]),
    `  Output file    : data/final/${finalFile ?? "unknown"}`,
    `  Pipeline log   : logs/${path.basename(pipelineLogPath)}`,
    divider,
    "",
  ].join("\n");

  console.log(summary);
  fs.appendFileSync(pipelineLogPath, summary + "\n");
}

main();
