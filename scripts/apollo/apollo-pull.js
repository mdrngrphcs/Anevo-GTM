"use strict";

const path = require("path");
const fs = require("fs");
const axios = require("axios");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const ROOT = path.resolve(__dirname, "../..");
const APOLLO_ENDPOINT = "https://api.apollo.io/v1/mixed_people/api_search";

// ---------------------------------------------------------------------------
// Apollo filter mappings
// ---------------------------------------------------------------------------

// Apollo headcount buckets — filter to whichever overlap [min, max]
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

// Apollo industry tag IDs (partial — extend as needed)
const INDUSTRY_TAG_MAP = {
  "accounting": 5567, "advertising": 5568, "aerospace": 5569,
  "agriculture": 5570, "automotive": 5573, "banking": 5575,
  "biotechnology": 5577, "cloud computing": 5579,
  "computer software": 5582, "construction": 5583,
  "consumer electronics": 5584, "cybersecurity": 6778,
  "e-commerce": 5594, "education": 5595, "energy": 5596,
  "engineering": 5597, "environmental": 5598,
  "financial services": 5601, "food & beverage": 5602,
  "government": 5605, "healthcare": 5607,
  "human resources": 5610, "information technology": 5614,
  "insurance": 5615, "internet": 5617, "legal services": 5620,
  "logistics": 5622, "management consulting": 5624,
  "manufacturing": 5625, "marketing": 5626, "media": 5628,
  "medical devices": 5629, "non-profit": 5633,
  "oil & gas": 5634, "pharmaceuticals": 5637,
  "real estate": 5641, "retail": 5643, "saas": 5645,
  "software": 5582, "staffing": 5649,
  "telecommunications": 5653, "transportation": 5654,
  "venture capital": 5657, "wholesale": 5659,
};

function industriesToTagIds(industries) {
  // Return all as unmapped keywords — Apollo tag IDs are account-specific
  // and the /mixed_people/api_search endpoint rejects unrecognised IDs.
  return { ids: [], unmapped: industries };
}

// Apollo technology UIDs (slug-based — extend as needed)
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

function technologiesToUids(technologies) {
  return technologies
    .map((t) => TECHNOLOGY_UID_MAP[t.toLowerCase()])
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Translate job ICP → Apollo API payload
// ---------------------------------------------------------------------------

function translateFilters(icp) {
  const params = {};

  if (icp.titles?.length) params.person_titles = icp.titles;
  if (icp.location?.length) params.person_locations = icp.location;
  if (icp.companyKeywords?.length) params.q_organization_keyword_tags = icp.companyKeywords;

  if (icp.industries?.length) {
    const { ids, unmapped } = industriesToTagIds(icp.industries);
    if (ids.length) params.organization_industry_tag_ids = ids;
    if (unmapped.length) {
      params.q_organization_keyword_tags = [
        ...(params.q_organization_keyword_tags || []),
        ...unmapped,
      ];
    }
  }

  if (icp.headcount?.min != null || icp.headcount?.max != null) {
    const ranges = headcountToRanges(icp.headcount.min, icp.headcount.max);
    if (ranges.length) params.organization_num_employees_ranges = ranges;
  }

  if (icp.technologies?.length) {
    const uids = technologiesToUids(icp.technologies);
    if (uids.length) params.currently_using_any_of_technology_uids = uids;
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
  // fallback: oldest queued job
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) throw new Error("No queued jobs found in jobs/queued/");
  const jobPath = path.join(dir, files[0]);
  return { job: JSON.parse(fs.readFileSync(jobPath, "utf8")), filePath: jobPath };
}

function moveJob(job, fromStatus, toStatus) {
  const fromPath = path.join(ROOT, `jobs/${fromStatus}`, `${job.jobId}.json`);
  const toPath = path.join(ROOT, `jobs/${toStatus}`, `${job.jobId}.json`);
  job.status = toStatus;
  if (toStatus === "processing") job.startedAt = new Date().toISOString();
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
    const phone = p.phone_numbers?.[0]?.sanitized_number || "";
    return [
      p.first_name, p.last_name, p.title,
      p.email, p.email_status, phone, p.linkedin_url,
      org.name, org.website_url, org.linkedin_url,
      org.industry, org.estimated_num_employees,
      p.city, p.state, p.country,
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

  const PER_PAGE = recordLimit ? Math.min(recordLimit, 100) : 100;
  let people = [];
  let page = 1;
  let totalEntries = null;

  try {
    while (true) {
      const payload = {
        page,
        per_page: PER_PAGE,
        reveal_personal_emails: true,
        reveal_phone_number: true,
        ...filters,
      };

      log(jobId, `Fetching page ${page} (per_page=${PER_PAGE}) …`);
      const { data } = await axios.post(APOLLO_ENDPOINT, payload, { headers: apolloHeaders });
      const batch = data.people || [];

      if (totalEntries === null) {
        totalEntries = data.pagination?.total_entries ?? null;
        log(jobId, `Total matching entries: ${totalEntries ?? "unknown"}`);
      }

      people.push(...batch);
      log(jobId, `Page ${page}: ${batch.length} record(s) — total so far: ${people.length}`);

      // Stop if we have enough records
      if (recordLimit && people.length >= recordLimit) {
        people = people.slice(0, recordLimit);
        log(jobId, `Record limit (${recordLimit}) reached — stopping pagination`);
        break;
      }

      // Stop if this was the last page
      const totalPages = data.pagination?.total_pages ?? null;
      if (batch.length < PER_PAGE || (totalPages && page >= totalPages)) {
        break;
      }

      page++;
      await sleep(1000); // respect Apollo rate limits between pages
    }
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    log(jobId, `Apollo request failed: ${JSON.stringify(detail)}`);
    moveJob(job, "processing", "failed");
    log(jobId, "Status → failed");
    process.exit(1);
  }

  log(jobId, `Pull complete — ${people.length} total record(s)`);

  const rawDir = path.join(ROOT, "data/raw");
  fs.mkdirSync(rawDir, { recursive: true });
  const csvPath = path.join(rawDir, job.outputFilename);
  fs.writeFileSync(csvPath, recordsToCsv(people));
  log(jobId, `Saved ${people.length} record(s) → data/raw/${job.outputFilename}`);

  moveJob(job, "processing", "completed");
  log(jobId, "Status → completed");
  log(jobId, "Done.");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
