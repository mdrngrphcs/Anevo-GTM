// Railway Express API server — handles long-running pipeline jobs
"use strict";

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

console.log("[startup] Loading modules…");

let express, cors, path, fs, cp, axios, getUsageSummary,
    uploadJobJson, listJobJsonFiles, downloadJobJson, getJobFromDrive;
try {
  express        = require("express");          console.log("[startup] express ✓");
  cors           = require("cors");             console.log("[startup] cors ✓");
  path           = require("path");
  fs             = require("fs");
  cp             = require("child_process");
  axios          = require("axios");            console.log("[startup] axios ✓");
  require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
  ({ getUsageSummary } = require("../scripts/utils/usage-tracker"));
                                                console.log("[startup] usage-tracker ✓");
  ({ uploadJobJson, listJobJsonFiles, downloadJobJson, getJobFromDrive } =
    require("../scripts/utils/drive-uploader")); console.log("[startup] drive-uploader ✓");
} catch (err) {
  console.error("[startup] FATAL — module load failed:", err.message, err.stack);
  process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3001;
const ROOT = path.resolve(__dirname, "..");

// Pre-create all directories the server reads/writes so Railway's ephemeral
// filesystem doesn't cause readdir errors on first boot.
for (const dir of [
  "jobs/queued", "jobs/processing", "jobs/completed", "jobs/failed",
  "data/raw", "data/cleaned", "data/enriched", "data/final",
  "logs", "config",
]) {
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
}
console.log("[startup] directories ensured ✓");

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Helpers shared with the pipeline scripts
// ---------------------------------------------------------------------------

function toSlug(s) {
  return s.trim().toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildJobId(clientName, listName, ts) {
  return `${toSlug(clientName)}_${toSlug(listName)}_${ts}`;
}

function buildOutputFilename(clientName, date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = String(date.getFullYear()).slice(-2);
  return `${toSlug(clientName)}_apollo_raw_${m}_${d}_${y}.csv`;
}

function readJobsFromDir(dirName) {
  const dir = path.join(ROOT, "jobs", dirName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
      catch { return null; }
    })
    .filter(Boolean);
}

function findJobById(jobId) {
  for (const status of ["queued", "processing", "completed", "failed"]) {
    const p = path.join(ROOT, "jobs", status, `${jobId}.json`);
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    }
  }
  return null;
}

function spawnPipeline(jobId) {
  const script  = path.resolve(ROOT, "scripts", "run-from-job.js");
  const command = process.execPath;
  const args    = [script, jobId];
  console.log(`[spawn] Spawning pipeline: ${command} ${args.join(" ")} (cwd: ${ROOT})`);

  const child = cp.spawn(command, args, {
    cwd: ROOT, detached: true, stdio: "inherit",
    env: { ...process.env },
  });

  child.on("error", (err) => {
    console.error(`[spawn] Pipeline spawn error [${jobId}]:`, err.message);
  });
  child.on("exit", (code) => {
    console.log(`[spawn] Pipeline exited [${jobId}] with code:`, code);
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// POST /api/orders — create job + spawn pipeline
// ---------------------------------------------------------------------------

app.post("/api/orders", (req, res) => {
  const { clientName, listName, icp, enrichments, outputDestination, recordLimit } = req.body || {};

  if (!clientName?.trim() || !listName?.trim()) {
    return res.status(400).json({ error: "clientName and listName are required" });
  }

  const now  = new Date();
  const ts   = now.getTime();
  const jobId = buildJobId(clientName, listName, ts);

  const job = {
    jobId,
    createdAt: now.toISOString(),
    status: "queued",
    clientName: clientName.trim(),
    listName:   listName.trim(),
    source:     "apollo",
    icp: {
      titles:                   icp?.titles                   ?? [],
      industries:                icp?.industries               ?? [],
      industriesExclude:         icp?.industriesExclude        ?? [],
      companyKeywords:           icp?.companyKeywords          ?? [],
      companyKeywordsExclude:    icp?.companyKeywordsExclude   ?? [],
      headcount: { min: icp?.headcount?.min ?? null, max: icp?.headcount?.max ?? null },
      location:                  icp?.location                 ?? [],
      revenue:   { min: icp?.revenue?.min   ?? null, max: icp?.revenue?.max   ?? null },
      technologies:              icp?.technologies             ?? [],
      additionalCriteria:        icp?.additionalCriteria       ?? "",
    },
    enrichments: {
      websiteSummary:              enrichments?.websiteSummary              ?? false,
      icpClassification:           enrichments?.icpClassification           ?? false,
      icpClassificationContext:    enrichments?.icpClassificationContext    ?? "",
      businessLabeling:            enrichments?.businessLabeling            ?? false,
      businessTypeLabelTemplate:   enrichments?.businessTypeLabelTemplate   ?? "",
      decisionMakerDiscovery:      enrichments?.decisionMakerDiscovery      ?? false,
      decisionMakerContext:        enrichments?.decisionMakerContext        ?? "",
    },
    recordLimit:         typeof recordLimit === "number" && recordLimit > 0 ? recordLimit : null,
    outputDestination:   outputDestination ?? "data/final",
    outputFilename:      buildOutputFilename(clientName, now),
  };

  const queuedDir = path.join(ROOT, "jobs", "queued");
  fs.mkdirSync(queuedDir, { recursive: true });
  fs.writeFileSync(path.join(queuedDir, `${jobId}.json`), JSON.stringify(job, null, 2));

  spawnPipeline(jobId);
  uploadJobJson(jobId, job).catch((err) => console.warn(`[orders POST] Drive upload failed: ${err.message}`));

  res.status(201).json({ jobId, message: "Pipeline started" });
});

// ---------------------------------------------------------------------------
// GET /api/orders — list jobs by status
// ---------------------------------------------------------------------------

app.get("/api/orders", async (req, res) => {
  const status = req.query.status;

  // Drive-primary: fetch all job JSONs from Drive
  try {
    const files = await listJobJsonFiles();
    const jobs  = (
      await Promise.all(files.map((f) => downloadJobJson(f.id).catch(() => null)))
    ).filter(Boolean);

    let orders;
    if (status === "active") {
      orders = jobs.filter((j) => j.status === "queued" || j.status === "processing");
    } else if (status === "completed") {
      orders = jobs
        .filter((j) => j.status === "completed" || j.status === "failed")
        .sort((a, b) => ((b.endedAt ?? b.createdAt) > (a.endedAt ?? a.createdAt) ? 1 : -1));
    } else {
      orders = jobs;
    }
    return res.json({ orders, source: "drive" });
  } catch (err) {
    console.warn("[orders GET] Drive read failed, falling back to local:", err.message);
  }

  // Local fallback (Railway ephemeral — only has jobs created this session)
  let orders;
  if (status === "active") {
    orders = [...readJobsFromDir("queued"), ...readJobsFromDir("processing")];
  } else if (status === "completed") {
    orders = [...readJobsFromDir("completed"), ...readJobsFromDir("failed")]
      .sort((a, b) => ((b.endedAt ?? b.createdAt) > (a.endedAt ?? a.createdAt) ? 1 : -1));
  } else {
    orders = [
      ...readJobsFromDir("queued"),   ...readJobsFromDir("processing"),
      ...readJobsFromDir("completed"), ...readJobsFromDir("failed"),
    ];
  }
  res.json({ orders, source: "local" });
});

// ---------------------------------------------------------------------------
// POST /api/preview — Apollo record count (no credits)
// ---------------------------------------------------------------------------

const APOLLO_ENDPOINT   = "https://api.apollo.io/v1/mixed_people/api_search";
const HEADCOUNT_BUCKETS = [
  [1,10],[11,20],[21,50],[51,100],[101,200],
  [201,500],[501,1000],[1001,2000],[2001,5000],
  [5001,10000],[10001,20000],[20001,50000],
];

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

function translateFilters(icp) {
  const params = {};
  if (icp.titles?.length)   params.person_titles    = icp.titles;
  if (icp.location?.length) params.person_locations = icp.location;

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

  const keywords = [...(icp.companyKeywords ?? []), ...unmappedIndustries];
  if (keywords.length) params.q_organization_keyword_tags = keywords;

  // Industry exclusions — hex IDs where known, keyword fallback for unmapped
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
    const lo = icp.headcount.min ?? 0;
    const hi = icp.headcount.max ?? Infinity;
    const ranges = HEADCOUNT_BUCKETS
      .filter(([bLo, bHi]) => bHi >= lo && bLo <= hi)
      .map(([bLo, bHi]) => `${bLo},${bHi}`);
    if (ranges.length) params.organization_num_employees_ranges = ranges;
  }
  return params;
}

app.post("/api/preview", async (req, res) => {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return res.json({ count: null, source: "Apollo", error: "APOLLO_API_KEY not set" });

  const { icp } = req.body || {};
  if (!icp) return res.status(400).json({ error: "icp is required" });

  try {
    const { data } = await axios.post(
      APOLLO_ENDPOINT,
      { page: 1, per_page: 1, ...translateFilters(icp) },
      {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": apiKey },
        timeout: 15000,
      }
    );
    const count = data.total_entries ?? data.pagination?.total_entries ?? 0;
    res.json({ count, source: "Apollo" });
  } catch (err) {
    res.json({ count: null, source: "Apollo", error: "Preview unavailable" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/lists — pulled-lists registry
// ---------------------------------------------------------------------------

app.get("/api/lists", (_req, res) => {
  const listsPath = path.join(ROOT, "config", "pulled-lists.json");
  try {
    const lists = fs.existsSync(listsPath)
      ? JSON.parse(fs.readFileSync(listsPath, "utf8"))
      : [];
    res.json({ lists });
  } catch {
    res.json({ lists: [] });
  }
});

// ---------------------------------------------------------------------------
// GET /api/usage — aggregated cost dashboard data
// ---------------------------------------------------------------------------

app.get("/api/usage", (_req, res) => {
  try {
    res.json(getUsageSummary());
  } catch {
    res.status(500).json({ error: "Failed to read usage log" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/orders/:id/download — stream final CSV
// ---------------------------------------------------------------------------

app.get("/api/orders/:id/download", async (req, res) => {
  const jobId = req.params.id;
  console.log(`[download] Requested job ID: ${jobId}`);

  // Try Drive first (survives Railway restarts)
  let job = null;
  try {
    job = await getJobFromDrive(jobId);
    if (job) {
      console.log(`[download] Job found in Drive — status: ${job.status}, driveUrl: ${job.driveUrl ?? "(not set)"}`);
    } else {
      console.log(`[download] Job not in Drive, trying local...`);
    }
  } catch (err) {
    console.warn(`[download] Drive lookup failed: ${err.message}`);
  }

  // Fall back to local
  if (!job) {
    job = findJobById(jobId);
    if (job) {
      console.log(`[download] Job found locally — status: ${job.status}, driveUrl: ${job.driveUrl ?? "(not set)"}`);
    }
  }

  if (!job) {
    console.log(`[download] Job not found: ${jobId}`);
    return res.status(404).json({ error: "Job not found" });
  }

  if (job.driveUrl) {
    console.log(`[download] Returning Drive URL: ${job.driveUrl}`);
    return res.json({ driveUrl: job.driveUrl });
  }

  const base  = job.outputFilename;
  const tries = [
    path.join(ROOT, "data", "final",    base.replace("_raw_", "_final_")),
    path.join(ROOT, "data", "enriched", base.replace("_raw_", "_enriched_")),
    path.join(ROOT, "data", "cleaned",  base.replace("_raw_", "_cleaned_")),
    path.join(ROOT, "data", "raw",      base),
  ];
  console.log(`[download] Checking local paths:\n${tries.map((p) => `  ${p} — ${fs.existsSync(p) ? "EXISTS" : "not found"}`).join("\n")}`);

  const filePath = tries.find((p) => fs.existsSync(p));
  if (!filePath) {
    console.log(`[download] No local file found for job ${jobId}`);
    return res.status(404).json({ error: "Output file not found" });
  }

  const filename = path.basename(filePath);
  console.log(`[download] Streaming local file: ${filePath}`);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ---------------------------------------------------------------------------
// GET /api/test-download — inspect driveUrl on the most recent completed job
// ---------------------------------------------------------------------------

app.get("/api/test-download", async (_req, res) => {
  let driveJobs = [];
  let driveError = null;

  try {
    const files = await listJobJsonFiles();
    driveJobs = (
      await Promise.all(files.map((f) => downloadJobJson(f.id).catch(() => null)))
    ).filter(Boolean);
  } catch (err) {
    driveError = err.message;
  }

  const driveCompleted = driveJobs
    .filter((j) => j.status === "completed" || j.status === "failed")
    .sort((a, b) => ((b.endedAt ?? b.createdAt) > (a.endedAt ?? a.createdAt) ? 1 : -1));

  if (driveCompleted.length) {
    const job = driveCompleted[0];
    return res.json({
      source:          "drive",
      jobId:           job.jobId,
      clientName:      job.clientName,
      listName:        job.listName,
      outputFilename:  job.outputFilename,
      driveUrl:        job.driveUrl ?? null,
      status:          job.status,
      endedAt:         job.endedAt ?? null,
      totalJobsInDrive: driveJobs.length,
    });
  }

  // Fall back to local
  const localCompleted = readJobsFromDir("completed")
    .sort((a, b) => ((b.endedAt ?? b.createdAt) > (a.endedAt ?? a.createdAt) ? 1 : -1));

  if (!localCompleted.length) {
    return res.json({ found: false, source: "local", message: "No completed jobs", driveError });
  }

  const job = localCompleted[0];
  const jobPath = path.join(ROOT, "jobs", "completed", `${job.jobId}.json`);
  res.json({
    source:         "local",
    jobId:          job.jobId,
    clientName:     job.clientName,
    listName:       job.listName,
    outputFilename: job.outputFilename,
    driveUrl:       job.driveUrl ?? null,
    jobFilePath:    jobPath,
    jobFileExists:  fs.existsSync(jobPath),
    endedAt:        job.endedAt ?? null,
    driveError,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Railway API server running on port ${PORT}`);
});
