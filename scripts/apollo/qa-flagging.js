"use strict";

const path = require("path");
const fs = require("fs");
const { parse } = require("csv-parse/sync");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { uploadToDrive } = require("../utils/drive-uploader");

const ROOT = path.resolve(__dirname, "../..");

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
    path.join(logDir, `qa-flagging-${ts.slice(0, 10)}.log`),
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
// Job config lookup
// ---------------------------------------------------------------------------

function findJobForEnrichedFile(enrichedFilename) {
  const rawFilename = enrichedFilename.replace("_enriched_", "_raw_");
  const completedDir = path.join(ROOT, "jobs/completed");
  if (!fs.existsSync(completedDir)) return null;
  for (const f of fs.readdirSync(completedDir).filter((x) => x.endsWith(".json"))) {
    const job = JSON.parse(fs.readFileSync(path.join(completedDir, f), "utf8"));
    if (job.outputFilename === rawFilename) return job;
  }
  return null;
}

function buildFinalFilename(job, enrichedFilename) {
  if (!job) return enrichedFilename.replace("_enriched_", "_final_");
  const clientSlug = job.clientName.replace(/\s+/g, "");
  const listSlug = job.listName.replace(/\s+/g, "");
  const d = new Date(job.createdAt);
  const m = d.getMonth() + 1;
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${clientSlug}_${listSlug}_${m}_${dd}_${yy}.csv`;
}

// ---------------------------------------------------------------------------
// Flagging logic
// ---------------------------------------------------------------------------

function flagRow(row) {
  const flags = [];

  if (!row.website_summary || row.website_summary.trim().length < 20)
    flags.push("missing_website_summary");

  if (!row.icp_classification || row.icp_classification.trim() === "")
    flags.push("icp_unclassified");

  if (!row.business_type || row.business_type.trim() === "")
    flags.push("missing_business_type");

  if (row["Result"] === "catch_all")
    flags.push("catch_all_email");

  if (row["Valid Email"] === "Invalid Email")
    flags.push("invalid_email");

  const dm = (row.additional_decision_makers || "").trim().toLowerCase();
  if (!dm || dm === "no other contact")
    flags.push("missing_decision_maker");

  if (!row.company_website || row.company_website.trim() === "")
    flags.push("no_company_website");

  return flags;
}

// ---------------------------------------------------------------------------
// Persist driveUrl into the completed job JSON
// ---------------------------------------------------------------------------

function saveJobDriveUrl(job, driveUrl) {
  if (!job) {
    log("  Warning: saveJobDriveUrl called with no job — driveUrl not persisted");
    return;
  }
  const jobPath = path.join(ROOT, "jobs/completed", `${job.jobId}.json`);
  log(`  Saving driveUrl to: ${jobPath}`);
  if (!fs.existsSync(jobPath)) {
    log(`  Warning: job file not found at ${jobPath} — driveUrl not persisted`);
    return;
  }
  try {
    const updated = { ...job, driveUrl };
    fs.writeFileSync(jobPath, JSON.stringify(updated, null, 2));
    log(`  driveUrl saved successfully to ${jobPath}`);
  } catch (err) {
    log(`  Warning: could not save driveUrl to job JSON: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const enrichedDir = path.join(ROOT, "data/enriched");
  const finalDir = path.join(ROOT, "data/final");
  fs.mkdirSync(finalDir, { recursive: true });

  const enrichedFiles = fs.readdirSync(enrichedDir).filter((f) => f.endsWith(".csv"));
  if (!enrichedFiles.length) throw new Error("No CSV files found in data/enriched/");

  for (const filename of enrichedFiles) {
    const enrichedPath = path.join(enrichedDir, filename);
    const job = findJobForEnrichedFile(filename);
    const finalFilename = buildFinalFilename(job, filename);
    const finalPath = path.join(finalDir, finalFilename);

    log(`━━━ QA flagging: ${filename}`);

    const rows = parse(fs.readFileSync(enrichedPath, "utf8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const flagCounts = {
      missing_website_summary: 0,
      icp_unclassified: 0,
      missing_business_type: 0,
      catch_all_email: 0,
      invalid_email: 0,
      missing_decision_maker: 0,
      no_company_website: 0,
    };

    let approved = 0;
    let needsReview = 0;

    for (const row of rows) {
      const flags = flagRow(row);
      row.qa_flags = flags.join(" | ");
      row.qa_status = flags.length === 0 ? "approved" : "needs_review";

      if (flags.length === 0) {
        approved++;
      } else {
        needsReview++;
        for (const f of flags) flagCounts[f]++;
      }

      log(`  ${row.email || row.first_name} → ${row.qa_status}${flags.length ? ": " + flags.join(", ") : ""}`);
    }

    const outHeaders = [...Object.keys(rows[0] || {}).filter(k => k !== "qa_flags" && k !== "qa_status"), "qa_flags", "qa_status"];
    fs.writeFileSync(finalPath, stringifyCSV(outHeaders, rows));

    // ── Google Drive upload ────────────────────────────────────────────────
    try {
      const driveUrl = await uploadToDrive(finalPath, finalFilename);
      log(`Uploaded to Drive: ${driveUrl}`);
      saveJobDriveUrl(job, driveUrl);
    } catch (err) {
      log(`  Warning: Drive upload failed (file still saved locally): ${err.message}`);
    }

    // ── QA Summary Report ──────────────────────────────────────────────────
    const divider = "═".repeat(50);
    const report = [
      "",
      divider,
      "  QA SUMMARY REPORT",
      divider,
      `  File          : ${finalFilename}`,
      `  Total records : ${rows.length}`,
      `  Approved      : ${approved}`,
      `  Needs review  : ${needsReview}`,
      "",
      "  Flag breakdown:",
      ...Object.entries(flagCounts).map(
        ([flag, count]) => `    ${flag.padEnd(28)} ${count}`
      ),
      divider,
      "",
    ].join("\n");

    console.log(report);
    log(`Saved to data/final/${finalFilename}`);
    log(`Approved: ${approved} | Needs review: ${needsReview}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
