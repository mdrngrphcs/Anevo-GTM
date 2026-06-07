"use strict";

const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { parse } = require("csv-parse/sync");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const ROOT = path.resolve(__dirname, "../..");
const RATE_LIMIT_MS = 300;

const { logApiCall } = require("../utils/usage-tracker");

// Resolve job context from filename (best-effort — used for usage logging)
function resolveJobContext(rawFilename) {
  const dirs = ["processing", "completed", "failed", "queued"];
  for (const status of dirs) {
    const dir = path.join(ROOT, `jobs/${status}`);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (job.outputFilename && rawFilename.startsWith(job.outputFilename.replace("_raw_", ""))) {
          return { jobId: job.jobId, clientName: job.clientName, listName: job.listName };
        }
        // Also match by jobId embedded in filename
        if (rawFilename.includes(job.jobId)) {
          return { jobId: job.jobId, clientName: job.clientName, listName: job.listName };
        }
      } catch {}
    }
  }
  return { jobId: "unknown", clientName: "unknown", listName: rawFilename };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}`;
  console.log(line);
  const logDir = path.join(ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(
    path.join(logDir, `email-validation-${ts.slice(0, 10)}.log`),
    line + "\n"
  );
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function escapeCell(val) {
  if (val == null) return "";
  const s = String(val);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function stringifyCSV(headers, rows) {
  const header = headers.map(escapeCell).join(",");
  const body = rows.map((row) =>
    headers.map((h) => escapeCell(row[h])).join(",")
  );
  return [header, ...body].join("\n");
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyMillionVerifier(email, apiKey) {
  const { data } = await axios.get("https://api.millionverifier.com/api/v3/", {
    params: { api: apiKey, email },
    timeout: 15000,
  });
  // result: ok | catch_all | invalid | unknown
  return data.result ?? "unknown";
}

// ---------------------------------------------------------------------------
// Valid email determination
// ---------------------------------------------------------------------------

function determineValidEmail(result, result1) {
  if (result === "ok") return "Valid Email";
  if (result1 === "catch_all_valid") return "Valid Email";
  if (result1 === "valid") return "Valid Email";
  return "Invalid Email";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const mvKey = process.env.MILLIONVERIFIER_API_KEY;
  if (!mvKey || mvKey.includes("your_")) throw new Error("MILLIONVERIFIER_API_KEY is not configured in .env");

  const rawDir = path.join(ROOT, "data/raw");
  const cleanedDir = path.join(ROOT, "data/cleaned");
  fs.mkdirSync(cleanedDir, { recursive: true });

  const rawFiles = fs.readdirSync(rawDir).filter((f) => f.endsWith(".csv"));
  if (!rawFiles.length) throw new Error("No CSV files found in data/raw/");

  for (const filename of rawFiles) {
    const rawPath = path.join(rawDir, filename);
    const cleanedFilename = filename.replace("_raw_", "_cleaned_");
    const cleanedPath = path.join(cleanedDir, cleanedFilename);

    const jobCtx = resolveJobContext(filename);
    log(`━━━ Processing: ${filename}`);

    const rows = parse(fs.readFileSync(rawPath, "utf8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const outHeaders = [
      ...Object.keys(rows[0] || {}),
      "Result",
      "Result (1)",
      "Valid Email",
    ];

    let validated = 0;
    let skipped = 0;
    let catchAllCount = 0;

    for (const row of rows) {
      const email = row["email"]?.trim();
      row["Result"] = "";
      row["Result (1)"] = "";
      row["Valid Email"] = "";

      if (!email) {
        log(`  SKIP  ${row["first_name"] || "(no name)"} — no email`);
        skipped++;
        continue;
      }

      // Layer 1 — MillionVerifier
      try {
        row["Result"] = await verifyMillionVerifier(email, mvKey);
        log(`  MV    ${email} → ${row["Result"]}`);
        logApiCall(jobCtx.jobId, jobCtx.clientName, jobCtx.listName, "millionverifier", `verify ${email}`, 1);
      } catch (err) {
        row["Result"] = "unknown";
        log(`  MV    ${email} → ERROR: ${err.response?.data?.error ?? err.message}`);
      }
      await sleep(RATE_LIMIT_MS);

      // catch_all — flag for manual review
      if (row["Result"] === "catch_all") {
        catchAllCount++;
        row["Result (1)"] = "pending_manual_review";
        log(`  FLAG  ${email} → pending_manual_review`);
      }

      row["Valid Email"] = determineValidEmail(row["Result"], row["Result (1)"]);
      log(`  ✓     ${email} → ${row["Valid Email"]}`);
      validated++;
    }

    fs.writeFileSync(cleanedPath, stringifyCSV(outHeaders, rows));

    log(`━━━ Done: ${filename}`);
    log(`    Validated       : ${validated}`);
    log(`    Catch-all flagged: ${catchAllCount}`);
    log(`    Skipped          : ${skipped} (no email)`);
    log(`    Saved to         : data/cleaned/${cleanedFilename}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
