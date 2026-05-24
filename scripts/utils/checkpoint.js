"use strict";

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
const CHECKPOINTS_DIR = path.join(ROOT, "jobs/checkpoints");

/**
 * Saves (or updates) the checkpoint for a job.
 * data is merged with { jobId, updatedAt } automatically.
 */
function saveCheckpoint(jobId, data) {
  fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  const filePath = path.join(CHECKPOINTS_DIR, `${jobId}.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ ...data, jobId, updatedAt: new Date().toISOString() }, null, 2)
  );
}

/**
 * Loads the checkpoint for a job. Returns null if none exists or it can't be parsed.
 */
function loadCheckpoint(jobId) {
  const filePath = path.join(CHECKPOINTS_DIR, `${jobId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Deletes the checkpoint file for a job on successful pipeline completion.
 */
function clearCheckpoint(jobId) {
  const filePath = path.join(CHECKPOINTS_DIR, `${jobId}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { saveCheckpoint, loadCheckpoint, clearCheckpoint };
