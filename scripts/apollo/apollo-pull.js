"use strict";

const path = require("path");
const fs = require("fs");
const axios = require("axios");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const ROOT = path.resolve(__dirname, "../..");
const SEARCH_ENDPOINT     = "https://api.apollo.io/v1/mixed_people/api_search";
const BULK_MATCH_ENDPOINT = "https://api.apollo.io/v1/people/bulk_match";
const BULK_MATCH_BATCH    = 10; // Apollo bulk_match max per call

// ---------------------------------------------------------------------------
// Filter translation
// ---------------------------------------------------------------------------

const HEADCOUNT_BUCKETS = [
  [1, 10], [11, 20], [21, 50], [51, 100], [101, 200],
  [201, 500], [501, 1000], [1001, 2000], [2001, 5000],
  [5001, 10000], [10001, 20000], [20001, 50000],
];

function headcountToRanges(min, max) {
  const lo = min ?? 0;
  const hi = max ?? Infinity;
  return HEADCOUNT_BUCKETS
    .filter(([bLo, bHi]) => bHi >= lo && bLo <= hi)
    .map(([bLo, bHi]) => `${bLo},${bHi}`);
}

// Apollo technology UIDs (slug-based)
const TECHNOLOGY_UID_MAP = {
  "salesforce": "salesforce", "hubspot": "hubspot",
  "outreach": "outreach", "salesloft": "salesloft",
  "marketo": "marketo", "pardot": "pardot",
  "zendesk": "zendesk", "intercom": "intercom",
  "slack": "slack", "microsoft teams": "microsoft_teams",
  "zoom": "zoom", "google workspace": "google_apps",
  "office 365": "office_365", "shopify": "shopify",
  "wordpress": "wordpress", "stripe": "stripe",
  "aws": "amazon_web_services", "azure": "microsoft_azure",
  "google cloud": "google_cloud", "snowflake": "snowflake",
  "databricks": "databricks", "tableau": "tableau",
  "power bi": "power_bi", "segment": "segment",
  "gong": "gong", "chorus": "chorus",
};

function translateFilters(icp) {
  const params = {};

  if (icp.titles?.length)          params.person_titles = icp.titles;
  if (icp.location?.length)        params.person_locations = icp.location;

  // Keywords and industries are both passed as keyword tags (industry tag IDs
  // are account-specific and rejected by the API if unrecognised)
  const keywords = [
    ...(icp.companyKeywords ?? []),
    ...(icp.industries ?? []),
  ];
  if (keywords.length)             params.q_organization_keyword_tags = keywords;

  if (icp.headcount?.min != null || icp.headcount?.max != null) {
    const ranges = headcountToRanges(icp.headcount.min, icp.headcount.max);
    if (ranges.length)             params.organization_num_employees_ranges = ranges;
  }

  if (icp.technologies?.length) {
    const uids = icp.technologies
      .map((t) => TECHNOLOGY_UID_MAP[t.toLowerCase()])
      .filter(Boolean);
    if (uids.length)               params.currently_using_any_of_technology_uids = uids;
  }

  return params;
}

// ---------------------------------------------------------------------------
// Job queue helpers
// ---------------------------------------------------------------------------

function loadQueuedJob(jobId) {
  const dir = path.join(ROOT, "jobs/queued");
  if (jobId) {
    const jobPath = path.join(dir, `${jobId}.json`);
    if (!fs.existsSync(jobPath)) throw new Error(`Job not found in jobs/queued/: ${jobId}`);
    return { job: JSON.parse(fs.readFileSync(jobPath, "utf8")), filePath: jobPath };
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) throw new Error("No queued jobs found in jobs/queued/");
  const jobPath = path.join(dir, files[0]);
  return { job: JSON.parse(fs.readFileSync(jobPath, "utf8")), filePath: jobPath };
}

function moveJob(job, fromStatus, toStatus) {
  const fromPath = path.join(ROOT, `jobs/${fromStatus}`, `${job.jobId}.json`);
  const toPath   = path.join(ROOT, `jobs/${toStatus}`,   `${job.jobId}.json`);
  job.status = toStatus;
  if (toStatus === "processing") job.startedAt  = new Date().toISOString();
  if (toStatus === "completed" || toStatus === "failed") job.endedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  fs.writeFileSync(toPath, JSON.stringify(job, null, 2));
  if (fs.existsSync(fromPath)) fs.unlinkSync(fromPath);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(jobId, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${jobId}] ${message}`;
  console.log(line);
  const logDir = path.join(ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(
    path.join(logDir, `apollo-pull-${ts.slice(0, 10)}.log`),
    line + "\n"
  );
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
  "first_name", "last_name", "title", "email", "email_status",
  "phone", "linkedin_url",
  "company", "company_website", "company_linkedin",
  "industry", "headcount", "city", "state", "country",
];

function extractDomain(url) {
  if (!url) return "";
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
  }
}

function escapeCell(val) {
  if (val == null) return "";
  const s = String(val);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function recordsToCsv(records) {
  const header = CSV_COLUMNS.join(",");
  const rows = records.map((p) => {
    const org = p.organization || {};
    // Phone: prefer enriched value from bulk_match, fall back to search result
    const phone = p._phone || p.phone_numbers?.[0]?.sanitized_number || "";
    return [
      p.first_name,
      p.last_name,
      p.title,
      p.email        || "",
      p.email_status || "",
      phone,
      p.linkedin_url || "",
      org.name,
      org.website_url,
      org.linkedin_url,
      org.industry,
      org.estimated_num_employees,
      p.city,
      p.state,
      p.country,
    ].map(escapeCell).join(",");
  });
  return [header, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY is not set in .env");

  const jobIdArg = process.argv[2] ?? null;
  const { job } = loadQueuedJob(jobIdArg);
  const { jobId } = job;

  log(jobId, `Loaded job — client: ${job.clientName}, list: ${job.listName}`);
  moveJob(job, "queued", "processing");
  log(jobId, "Status → processing");

  const recordLimit = job.recordLimit ?? null;
  log(jobId, `Record limit: ${recordLimit ?? "none (pull all)"}`);

  const filters = translateFilters(job.icp);
  log(jobId, `Apollo filters: ${JSON.stringify(filters)}`);

  const apolloHeaders = {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "X-Api-Key": apiKey,
  };

  // ── Step 1: People Search (no credits) ────────────────────────────────────

  log(jobId, "Step 1 — People Search (no credits, POST /v1/mixed_people/search)…");
  const step1Start = Date.now();

  const PER_PAGE = recordLimit ? Math.min(recordLimit, 100) : 100;
  const people = [];
  let page = 1;
  let totalEntries = null;

  try {
    while (true) {
      const payload = { page, per_page: PER_PAGE, ...filters };

      log(jobId, `Step 1 — Fetching page ${page} (per_page=${PER_PAGE})…`);
      const { data } = await axios.post(SEARCH_ENDPOINT, payload, {
        headers: apolloHeaders,
        timeout: 30000,
      });

      const batch = data.people || [];

      if (page === 1) {
        // api_search returns total_entries at top level, not nested under pagination
        totalEntries = data.total_entries ?? data.pagination?.total_entries ?? null;
        log(jobId, `Step 1 — Total matching entries: ${totalEntries ?? "unknown"}`);
      }

      people.push(...batch);
      log(jobId, `Step 1 — Page ${page}: ${batch.length} record(s) — total so far: ${people.length}`);

      if (recordLimit && people.length >= recordLimit) {
        people.splice(recordLimit);
        log(jobId, `Step 1 — Record limit (${recordLimit}) reached — stopping pagination`);
        break;
      }

      const totalPages = data.pagination?.total_pages ?? null;
      if (batch.length < PER_PAGE || (totalPages && page >= totalPages)) break;

      page++;
      await sleep(1000);
    }
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    log(jobId, `Step 1 — Failed: ${JSON.stringify(detail)}`);
    moveJob(job, "processing", "failed");
    log(jobId, "Status → failed");
    process.exit(1);
  }

  const step1Elapsed = ((Date.now() - step1Start) / 1000).toFixed(1);
  log(jobId, `Step 1 — Complete: ${people.length} record(s) in ${step1Elapsed}s`);

  // ── Step 2: Email Enrichment (1 credit per email found) ───────────────────
  // Pass Apollo's internal person id — the free search returns id even though
  // names/LinkedIn are blinded, and bulk_match accepts id for exact matching.

  const totalBatches = Math.ceil(people.length / BULK_MATCH_BATCH);
  log(jobId, `Step 2 — Email Enrichment (POST /v1/people/bulk_match): ${people.length} records → ${totalBatches} batch(es) of ${BULK_MATCH_BATCH}…`);
  const step2Start = Date.now();

  let emailsFound    = 0;
  let emailsNotFound = 0;
  let totalCredits   = 0;

  for (let i = 0; i < people.length; i += BULK_MATCH_BATCH) {
    const batch    = people.slice(i, i + BULK_MATCH_BATCH);
    const batchNum = Math.floor(i / BULK_MATCH_BATCH) + 1;

    const details = batch.map((p) => ({ id: p.id }));

    try {
      const { data } = await axios.post(
        BULK_MATCH_ENDPOINT,
        { reveal_personal_emails: true, details },
        { headers: apolloHeaders, timeout: 30000 }
      );

      const matches    = data.matches || [];
      const credits    = data.credits_consumed ?? 0;
      totalCredits    += credits;
      let batchFound   = 0;

      for (let j = 0; j < batch.length; j++) {
        const match = matches[j];
        if (match) {
          // Overwrite blinded fields with enriched values from bulk_match
          if (match.last_name)    batch[j].last_name    = match.last_name;
          if (match.linkedin_url) batch[j].linkedin_url = match.linkedin_url;
          if (match.city)         batch[j].city         = match.city;
          if (match.state)        batch[j].state        = match.state;
          if (match.country)      batch[j].country      = match.country;
          if (match.organization?.website_url) {
            batch[j].organization = { ...(batch[j].organization || {}), ...match.organization };
          }
          if (match.email) {
            batch[j].email        = match.email;
            batch[j].email_status = match.email_status || "verified";
            batchFound++;
            emailsFound++;
          } else {
            emailsNotFound++;
          }
          if (!batch[j]._phone && match.phone_numbers?.length) {
            batch[j]._phone = match.phone_numbers[0].sanitized_number;
          }
        } else {
          emailsNotFound++;
        }
      }

      log(jobId, `Step 2 — Batch ${batchNum}/${totalBatches}: ${batchFound}/${batch.length} emails found (credits used: ${credits})`);
    } catch (err) {
      const detail = err.response?.data ?? err.message;
      log(jobId, `Step 2 — Batch ${batchNum}/${totalBatches} error (non-fatal): ${JSON.stringify(detail)}`);
      emailsNotFound += batch.length;
    }

    // Pause between batches to stay within Apollo's rate limits
    if (i + BULK_MATCH_BATCH < people.length) await sleep(1200);
  }

  const step2Elapsed = ((Date.now() - step2Start) / 1000).toFixed(1);
  log(jobId, `Step 2 — Complete in ${step2Elapsed}s: ${emailsFound} emails found, ${emailsNotFound} not found, ${totalCredits} credits consumed`);

  // ── Step 3: Save CSV ──────────────────────────────────────────────────────

  const rawDir = path.join(ROOT, "data/raw");
  fs.mkdirSync(rawDir, { recursive: true });
  const csvPath = path.join(rawDir, job.outputFilename);
  fs.writeFileSync(csvPath, recordsToCsv(people));
  log(jobId, `Saved ${people.length} record(s) → data/raw/${job.outputFilename}`);
  log(jobId, `Email summary: ${emailsFound}/${people.length} emails found (${emailsNotFound} not found)`);

  moveJob(job, "processing", "completed");
  log(jobId, "Status → completed");
  log(jobId, "Done.");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
