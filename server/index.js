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

function translateFilters(icp) {
  const params = {};
  if (icp.titles?.length)   params.person_titles    = icp.titles;
  if (icp.location?.length) params.person_locations = icp.location;

  const keywords = [...(icp.companyKeywords ?? []), ...(icp.industries ?? [])];
  if (keywords.length) params.q_organization_keyword_tags = keywords;

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
    console.log(`[download] Redirecting to Drive URL: ${job.driveUrl}`);
    return res.redirect(302, job.driveUrl);
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
