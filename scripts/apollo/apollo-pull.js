"use strict";

const path = require("path");
const fs = require("fs");
const axios = require("axios");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const ROOT = path.resolve(__dirname, "../..");
const SEARCH_ENDPOINT     = "https://api.apollo.io/v1/mixed_people/api_search";
const BULK_MATCH_ENDPOINT = "https://api.apollo.io/v1/people/bulk_match";
const BULK_MATCH_BATCH    = 10; // Apollo bulk_match max per call

const { logApiCall }    = require("../utils/usage-tracker");
const { uploadJobJson } = require("../utils/drive-uploader");

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

// Real Apollo industry MongoDB ObjectIDs — discovered via organizations/search API
const APOLLO_INDUSTRY_IDS = {
  "accounting":                           "5567ce1f7369643b78570000",
  "airlines/aviation":                    "5567e0bf7369641d115f0200",
  "animation":                            "5567e36f73696431a4970000",
  "apparel & fashion":                    "5567cd82736964540d0b0000",
  "architecture & planning":              "5567cdb77369645401080000",
  "arts & crafts":                        "5567cd4d73696439d9030000",
  "automotive":                           "5567cdf27369644cfd800000",
  "aviation & aerospace":                 "5567e0dd73696416d3c20100",
  "banking":                              "5567ce237369644ee5490000",
  "biotechnology":                        "5567d08e7369645dbc4b0000",
  "broadcast media":                      "5567e0f973696416d34e0200",
  "building materials":                   "5567e1a17369641ea9d30100",
  "business supplies & equipment":        "5567e0fa73696410e4c51200",
  "capital markets":                      "5567cdb773696439a9080000",
  "chemicals":                            "5567e21e73696426a1030000",
  "civic & social organization":          "5567cdda7369644eed130000",
  "civil engineering":                    "5567e13a73696418756e0200",
  "commercial real estate":               "5567e1887369641d68d40100",
  "computer & network security":          "5567cd877369644cf94b0000",
  "computer games":                       "5567cd8b736964540d0f0000",
  "computer hardware":                    "5567e0d47369641233eb0600",
  "computer networking":                  "5567cdbe7369643b78360000",
  "computer software":                    "5567cd4e7369643b70010000",
  "construction":                         "5567cd4773696439dd350000",
  "consumer electronics":                 "5567e1947369641ead570000",
  "consumer goods":                       "5567ce987369643b789e0000",
  "consumer services":                    "5567d1127261697f2b1d0000",
  "cosmetics":                            "5567e1ae73696423dc040000",
  "defense & space":                      "5567e1097369641b5f810500",
  "design":                               "5567cdbc73696439d90b0000",
  "e-learning":                           "5567e19c7369641c48e70100",
  "education management":                 "5567ce9e736964540d540000",
  "electrical & electronic manufacturing":"5567cd4c73696439c9030000",
  "entertainment":                        "5567cdd37369643b80510000",
  "environmental services":               "5567ce5b736964540d280000",
  "events services":                      "5567cd8e7369645409450000",
  "facilities services":                  "5567ce9c7369643bc9980000",
  "farming":                              "5567cd4f7369644d2d010000",
  "financial services":                   "5567cdd67369643e64020000",
  "fine art":                             "5567e2097369642420150000",
  "fishery":                              "5567f96c7369642a22080000",
  "food & beverages":                     "5567ce1e7369643b806a0000",
  "food production":                      "5567e1b3736964208b280000",
  "fund-raising":                         "5567d2ad7261697f2b1f0100",
  "fundraising":                          "5567d2ad7261697f2b1f0100",
  "furniture":                            "5567cede73696440d0040000",
  "gambling & casinos":                   "5567e0cf7369641233e50600",
  "glass, ceramics & concrete":           "5567cd4f736964397e030000",
  "government administration":            "5567cd527369643981050000",
  "government relations":                 "5567e29b736964256c370100",
  "graphic design":                       "5567cd4d73696439d9040000",
  "health, wellness & fitness":           "5567cddb7369644d250c0000",
  "higher education":                     "5567cd4c73696453e1300000",
  "hospital & health care":               "5567cdde73696439812c0000",
  "hospitality":                          "5567ce9d7369643bc19c0000",
  "human resources":                      "5567e0e37369640e5ac10c00",
  "industrial automation":                "5567e1337369641ad2970000",
  "information services":                 "5567e0c97369640d2b3b1600",
  "information technology & services":    "5567cd4773696439b10b0000",
  "insurance":                            "5567cdd973696453d93f0000",
  "international affairs":                "5567e3657369642f4ec90000",
  "international trade & development":    "5567ce9c7369644eed680000",
  "internet":                             "5567cd4d736964397e020000",
  "investment banking":                   "5567e1ab7369641f6d660100",
  "investment management":                "5567e0bc7369641d11550200",
  "law enforcement":                      "5567e0e073696408da441e00",
  "law practice":                         "5567ce1f7369644d391c0000",
  "legal services":                       "5567ce2d7369644d25250000",
  "leisure, travel & tourism":            "5567cdd87369643bc12f0000",
  "logistics & supply chain":             "5567cd4973696439b9010000",
  "luxury goods & jewelry":               "5567cda97369644cfd3e0000",
  "machinery":                            "5567cd4973696439d53c0000",
  "management consulting":                "5567cdd47369643dbf260000",
  "maritime":                             "5567cd8273696439b1240000",
  "market research":                      "5567e1387369641ec75d0200",
  "marketing & advertising":              "5567cd467369644d39040000",
  "mechanical or industrial engineering": "5567ce2673696453d95c0000",
  "media production":                     "5567e0ea7369640d2ba31600",
  "medical device":                       "5567e1b97369641ea9690200",
  "medical practice":                     "5567d0467369645dbc200000",
  "mental health care":                   "5567ce2773696454308f0000",
  "military":                             "5567e2c572616932bb3b0000",
  "mining & metals":                      "5567e3f3736964395d7a0000",
  "mobile games":                         "5567cd8b736964540d0f0000",
  "motion pictures & film":               "5567cdd7736964540d130000",
  "museums & institutions":               "5567e15373696422aa0a0000",
  "music":                                "5567cd4f736964540d050000",
  "nanotechnology":                       "5567e7be736964110e210000",
  "newspapers":                           "5567cd4a73696439a9010000",
  "non-profit organization management":   "5567cd4773696454303a0000",
  "oil & energy":                         "5567cdd97369645624020000",
  "online media":                         "5567cdb373696439dd540000",
  "outsourcing/offshoring":               "5567d04173696457ee520000",
  "package/freight delivery":             "5567e8bb7369641a658f0000",
  "packaging & containers":               "5567e36973696431a4480000",
  "paper & forest products":              "5567e97f7369641e57730100",
  "performing arts":                      "5567e0af7369641ec7300000",
  "pharmaceuticals":                      "5567e0eb73696410e4bd1200",
  "philanthropy":                         "5567ce9673696453d99f0000",
  "photography":                          "5567cd4f7369644cfd250000",
  "plastics":                             "5567cdda7369644cf95d0000",
  "political organization":               "5567e25f736964256cff0000",
  "primary/secondary education":          "5567cdd97369645430680000",
  "printing":                             "5567cd4d7369644d513e0000",
  "professional training & coaching":     "5567cd49736964541d010000",
  "public policy":                        "5567e28a7369642ae2500000",
  "public relations & communications":    "5567ce5973696453d9780000",
  "public safety":                        "5567cd4a7369643ba9010000",
  "publishing":                           "5567ce5b73696439a17a0000",
  "railroad manufacture":                 "5567e14673696416d38c0300",
  "ranching":                             "5567fd5a73696442b0f20000",
  "real estate":                          "5567cd477369645401010000",
  "recreational facilities & services":   "5567e134736964214f5e0000",
  "religious institutions":               "5567e0f27369640e5aed0c00",
  "renewables & environment":             "5567cd49736964540d020000",
  "research":                             "5567e09f736964160ebb0100",
  "restaurants":                          "5567e0e0736964198de70700",
  "retail":                               "5567ced173696450cb580000",
  "security & investigations":            "5567e19b7369641ead740000",
  "semiconductors":                       "5567e0d87369640e5aa30c00",
  "shipbuilding":                         "5568047d7369646d406c0000",
  "sporting goods":                       "5567e113736964198d5e0800",
  "sports":                               "5567ce227369644eed290000",
  "staffing & recruiting":                "5567e09973696410db020800",
  "supermarkets":                         "5567e2a97369642a553d0000",
  "telecommunications":                   "5567cd4c7369644d39080000",
  "textiles":                             "5567e1327369641d91ce0300",
  "think tanks":                          "5567e1de7369642069ea0100",
  "tobacco":                              "55680085736964551e070000",
  "translation & localization":           "5567e1097369641d91230300",
  "transportation/trucking/railroad":     "5567cd4e7369644cf93b0000",
  "utilities":                            "5567e2127369642420170000",
  "venture capital & private equity":     "5567e1587369641c48370000",
  "veterinary":                           "5567ce9673696439d5c10000",
  "warehousing":                          "5567e127736964181e700200",
  "wholesale":                            "5567d01e73696457ee100000",
  "wine & spirits":                       "5567cd4d7369643b78100000",
  "wireless":                             "5567e3ca736964371b130000",
  "writing & editing":                    "5567cdd973696439a1370000",
};

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

  if (icp.titles?.length)   params.person_titles    = icp.titles;
  if (icp.location?.length) params.person_locations = icp.location;

  // Map known industry names to Apollo hex IDs; unknown ones fall back to keyword tags
  const industryIds = [];
  const unmappedIndustries = [];
  for (const ind of (icp.industries ?? [])) {
    const id = APOLLO_INDUSTRY_IDS[ind.toLowerCase()];
    if (id) {
      if (!industryIds.includes(id)) industryIds.push(id);
    } else {
      unmappedIndustries.push(ind);
    }
  }
  if (industryIds.length) params.organization_industry_tag_ids = industryIds;

  // Company keywords only (industries with known IDs go via organization_industry_tag_ids above)
  const keywords = [...(icp.companyKeywords ?? []), ...unmappedIndustries];
  if (keywords.length) params.q_organization_keyword_tags = keywords;

  // Industry exclusions — map to hex IDs where known, keyword fallback for unknowns
  const excludeIndustryIds = [];
  const unmappedExcludes = [...(icp.companyKeywordsExclude ?? [])];
  for (const ind of (icp.industriesExclude ?? [])) {
    const id = APOLLO_INDUSTRY_IDS[ind.toLowerCase()];
    if (id) {
      if (!excludeIndustryIds.includes(id)) excludeIndustryIds.push(id);
    } else {
      unmappedExcludes.push(ind);
    }
  }
  if (excludeIndustryIds.length) params.not_organization_industry_tag_ids = excludeIndustryIds;
  if (unmappedExcludes.length)   params.q_not_organization_keyword_tags   = unmappedExcludes;

  if (icp.headcount?.min != null || icp.headcount?.max != null) {
    const ranges = headcountToRanges(icp.headcount.min, icp.headcount.max);
    if (ranges.length) params.organization_num_employees_ranges = ranges;
  }

  if (icp.technologies?.length) {
    const uids = icp.technologies
      .map((t) => TECHNOLOGY_UID_MAP[t.toLowerCase()])
      .filter(Boolean);
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
  uploadJobJson(job.jobId, job).catch((err) =>
    log(job.jobId, `Drive sync failed (status=${toStatus}): ${err.message}`)
  );
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
      logApiCall(jobId, job.clientName, job.listName, "apollo_search", `search page ${page}`, batch.length);

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

  // Hard cap — safety net if the loop exited via batch-size check instead of
  // the limit check (e.g. last page returned exactly PER_PAGE records).
  if (recordLimit && people.length > recordLimit) {
    const before = people.length;
    people.splice(recordLimit);
    log(jobId, `Record limit applied: returning ${people.length} of ${before} results`);
  } else if (recordLimit) {
    log(jobId, `Record limit applied: returning ${people.length} of ${totalEntries ?? people.length} results`);
  }

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
      logApiCall(jobId, job.clientName, job.listName, "apollo_enrichment", `bulk_match batch ${batchNum}/${totalBatches}`, batchFound, { apolloCredits: credits });
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
