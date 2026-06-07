// Railway Express API server — handles long-running pipeline jobs
"use strict";

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");
const cp      = require("child_process");
const axios   = require("axios");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { getUsageSummary } = require("../scripts/utils/usage-tracker");

const app  = express();
const PORT = process.env.PORT || 3001;
const ROOT = path.resolve(__dirname, "..");

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
  const script = path.resolve(ROOT, "scripts", "run-from-job.js");
  const child  = cp.spawn(process.execPath, [script, jobId], {
    cwd: ROOT, detached: true, stdio: "ignore",
    env: { ...process.env },
  });
  child.on("error", (err) => {
    const logDir = path.join(ROOT, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, "spawn-errors.log"),
      `[${new Date().toISOString()}] [${jobId}] Spawn error: ${err.message}\n`
    );
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

  res.status(201).json({ jobId, message: "Pipeline started" });
});

// ---------------------------------------------------------------------------
// GET /api/orders — list jobs by status
// ---------------------------------------------------------------------------

app.get("/api/orders", (req, res) => {
  const status = req.query.status;
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

  res.json({ orders });
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

app.get("/api/orders/:id/download", (req, res) => {
  const job = findJobById(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  // Prefer Drive URL if the job was uploaded successfully
  if (job.driveUrl) return res.redirect(302, job.driveUrl);

  const base  = job.outputFilename; // e.g. testclient_apollo_raw_6_7_26.csv
  const tries = [
    path.join(ROOT, "data", "final",    base.replace("_raw_", "_final_")),
    path.join(ROOT, "data", "enriched", base.replace("_raw_", "_enriched_")),
    path.join(ROOT, "data", "cleaned",  base.replace("_raw_", "_cleaned_")),
    path.join(ROOT, "data", "raw",      base),
  ];

  const filePath = tries.find((p) => fs.existsSync(p));
  if (!filePath) return res.status(404).json({ error: "Output file not found" });

  const filename = path.basename(filePath);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Railway API server running on port ${PORT}`);
});
