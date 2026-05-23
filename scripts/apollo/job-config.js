const fs = require("fs");
const path = require("path");

const REQUIRED_FIELDS = ["clientName", "listName"];

const DEFAULTS = {
  source: "apollo",
  outputDestination: "data/final",
  icp: {
    titles: [],
    industries: [],
    companyKeywords: [],
    headcount: { min: null, max: null },
    location: [],
    revenue: { min: null, max: null },
    technologies: [],
  },
  enrichments: {
    websiteSummary: false,
    icpClassification: false,
    businessLabeling: false,
    decisionMakerDiscovery: false,
  },
};

function validate(config) {
  const missing = REQUIRED_FIELDS.filter((f) => !config[f] || String(config[f]).trim() === "");
  if (missing.length) {
    throw new Error(`Missing required fields: ${missing.join(", ")}`);
  }

  if (config.icp) {
    const { headcount, revenue } = config.icp;
    if (headcount && headcount.min != null && headcount.max != null && headcount.min > headcount.max) {
      throw new Error("icp.headcount.min cannot exceed icp.headcount.max");
    }
    if (revenue && revenue.min != null && revenue.max != null && revenue.min > revenue.max) {
      throw new Error("icp.revenue.min cannot exceed icp.revenue.max");
    }
  }
}

function buildOutputFilename(clientName, source, date = new Date()) {
  const slug = clientName.trim().toLowerCase().replace(/\s+/g, "_");
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = String(date.getFullYear()).slice(-2);
  return `${slug}_${source}_raw_${m}_${d}_${y}.csv`;
}

function buildJobId(clientName, listName, ts = Date.now()) {
  const clientSlug = clientName.trim().toLowerCase().replace(/\s+/g, "_");
  const listSlug = listName.trim().toLowerCase().replace(/\s+/g, "_");
  return `${clientSlug}_${listSlug}_${ts}`;
}

function createJob(rawConfig) {
  validate(rawConfig);

  const config = {
    ...DEFAULTS,
    ...rawConfig,
    icp: { ...DEFAULTS.icp, ...(rawConfig.icp || {}) },
    enrichments: { ...DEFAULTS.enrichments, ...(rawConfig.enrichments || {}) },
  };

  const now = new Date();
  const jobId = buildJobId(config.clientName, config.listName, now.getTime());
  const outputFilename = buildOutputFilename(config.clientName, config.source, now);

  const job = {
    jobId,
    createdAt: now.toISOString(),
    status: "queued",
    clientName: config.clientName,
    listName: config.listName,
    source: config.source,
    icp: config.icp,
    enrichments: config.enrichments,
    outputDestination: config.outputDestination,
    outputFilename,
  };

  const queuedDir = path.resolve(__dirname, "../../jobs/queued");
  fs.mkdirSync(queuedDir, { recursive: true });

  const jobPath = path.join(queuedDir, `${jobId}.json`);
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));

  console.log("=================================================");
  console.log("  Job created successfully");
  console.log("=================================================");
  console.log(`  Job ID     : ${job.jobId}`);
  console.log(`  Client     : ${job.clientName}`);
  console.log(`  List       : ${job.listName}`);
  console.log(`  Source     : ${job.source}`);
  console.log(`  Output     : ${job.outputFilename}`);
  console.log(`  Enrichments: ${Object.entries(job.enrichments).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}`);
  console.log(`  Saved to   : jobs/queued/${jobId}.json`);
  console.log("=================================================");

  return job;
}

module.exports = { createJob, buildOutputFilename };
