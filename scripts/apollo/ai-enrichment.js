"use strict";

const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { parse } = require("csv-parse/sync");
const OpenAI = require("openai");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const ROOT = path.resolve(__dirname, "../..");
const BATCH_SIZE = 50;
const domainCache = require("../utils/domain-cache");

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const openrouter = axios.create({
  baseURL: "https://openrouter.ai/api/v1",
  headers: {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://anevomarketing.com",
    "X-Title": "Anevo-GTM",
  },
  timeout: 60000,
});

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
    path.join(logDir, `ai-enrichment-${ts.slice(0, 10)}.log`),
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Rate limiters (sliding window)
// ---------------------------------------------------------------------------

class RateLimiter {
  constructor(maxPerMinute, name) {
    this.maxPerMinute = maxPerMinute;
    this.name = name;
    this.timestamps = [];
  }

  async acquire() {
    const now = Date.now();
    // Evict timestamps older than 1 minute
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);

    if (this.timestamps.length >= this.maxPerMinute) {
      // Wait until the oldest request falls off the window
      const waitMs = 60_000 - (now - this.timestamps[0]) + 50;
      log(
        `Rate limit approached (${this.name}: ${this.timestamps.length}/${this.maxPerMinute} RPM), ` +
        `throttling ${(waitMs / 1000).toFixed(1)}s…`
      );
      await sleep(waitMs);
      return this.acquire(); // recheck after waiting
    }

    this.timestamps.push(Date.now());
  }
}

// OpenAI: 500 RPM limit → use 450 (10% buffer)
const openaiLimiter = new RateLimiter(450, "OpenAI");

// OpenRouter: 80 RPM (conservative; adjust if your tier is higher)
const openrouterLimiter = new RateLimiter(80, "OpenRouter");

// ---------------------------------------------------------------------------
// Retry wrapper (exponential backoff on 429 / transient errors)
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];

async function withRetry(fn, label, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status ?? err.response?.status;
      const is429 = status === 429;
      const isTransient =
        is429 ||
        err.code === "ECONNRESET" ||
        err.code === "ETIMEDOUT" ||
        err.code === "ECONNABORTED" ||
        status === 503 ||
        status === 502;

      if (attempt >= maxAttempts) {
        log(`${label}: failed after ${maxAttempts} attempts — ${err.message}`);
        throw err;
      }

      if (!isTransient) throw err; // don't retry hard errors (400, 401, etc.)

      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 16000;
      log(
        `${label}: ${is429 ? "429 rate limit" : err.code ?? status} received, ` +
        `retrying in ${delay / 1000}s… (attempt ${attempt}/${maxAttempts})`
      );
      await sleep(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Job config lookup
// ---------------------------------------------------------------------------

function findJobForCleanedFile(cleanedFilename) {
  const rawFilename = cleanedFilename.replace("_cleaned_", "_raw_");
  const completedDir = path.join(ROOT, "jobs/completed");
  if (!fs.existsSync(completedDir)) return null;
  for (const f of fs.readdirSync(completedDir).filter((x) => x.endsWith(".json"))) {
    const job = JSON.parse(fs.readFileSync(path.join(completedDir, f), "utf8"));
    if (job.outputFilename === rawFilename) return job;
  }
  return null;
}

function formatIcpCriteria(icp) {
  const lines = [];
  if (icp.titles?.length)          lines.push(`Titles: ${icp.titles.join(", ")}`);
  if (icp.industries?.length)      lines.push(`Industries: ${icp.industries.join(", ")}`);
  if (icp.companyKeywords?.length) lines.push(`Company keywords: ${icp.companyKeywords.join(", ")}`);
  if (icp.headcount?.min != null || icp.headcount?.max != null)
    lines.push(`Headcount: ${icp.headcount.min ?? 0}–${icp.headcount.max ?? "∞"}`);
  if (icp.location?.length)        lines.push(`Location: ${icp.location.join(", ")}`);
  if (icp.technologies?.length)    lines.push(`Technologies: ${icp.technologies.join(", ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Enrichment functions (each acquires a rate-limit token before every attempt)
// ---------------------------------------------------------------------------

async function enrichWebsiteSummary(row) {
  const label = `[${row.first_name}] website_summary`;
  const prompt =
    `I want you to visit this website ${row.company_website || "(no website)"} ` +
    `for this company ${row.company || "(unknown)"} and summarize what their business ` +
    `does, what are all the products or services they sell, and all possible relevant ` +
    `information. Please make an exhaustive business research summary that includes ` +
    `all possible data you can find. Stop at nothing.`;

  return withRetry(async () => {
    await openaiLimiter.acquire();
    const res = await openai.responses.create({
      model: "gpt-4o-mini",
      tools: [{ type: "web_search_preview" }],
      input: prompt,
    });
    return res.output_text?.trim() ?? "";
  }, label);
}

async function enrichIcpClassification(row, icpCriteria, icpContext) {
  const label = `[${row.first_name}] icp_classification`;
  let userPrompt =
    `Determine if this company is a good fit based on:\n${row.website_summary}\n` +
    `ICP criteria: ${icpCriteria}\n`;
  if (icpContext) userPrompt += `Additional context: ${icpContext}\n`;
  userPrompt +=
    `If good fit respond ONLY with: icp fit\n` +
    `If bad fit respond ONLY with: not a fit`;

  return withRetry(async () => {
    await openrouterLimiter.acquire();
    const res = await openrouter.post("/chat/completions", {
      model: "deepseek/deepseek-v3.2",
      max_tokens: 50,
      temperature: 0,
      reasoning: { enabled: false },
      messages: [
        {
          role: "system",
          content:
            "You are a B2B company classifier. Respond with ONLY the exact classification label. No explanations, no preamble, no extra text.",
        },
        { role: "user", content: userPrompt },
      ],
    });
    return res.data.choices[0].message.content?.trim() ?? "";
  }, label);
}

async function enrichBusinessType(row, templateSentence) {
  const label = `[${row.first_name}] business_type`;
  let prompt =
    `I am going to feed you a company's business description and I want you to find a label (1-2 words) ` +
    `to describe the company type. I want you to choose a label that someone who works at the company ` +
    `would likely use to describe what kind of company it is.\n\n` +
    `Follow these classification rules strictly:\n` +
    `- manufactures physical goods → manufacturer\n` +
    `- hospital, health system, multi-site medical group → health system\n` +
    `- medical or dental clinic or private practice → medical practice\n` +
    `- law firm → law firm\n` +
    `- CPA firm or accounting practice → accounting firm\n` +
    `- staffing or workforce solutions → staffing firm\n` +
    `- bank or credit union → financial institution\n` +
    `- insurance carrier or brokerage → insurance company\n` +
    `- K-12 school or school district → school district\n` +
    `- college or university → university\n` +
    `- builds or develops real estate → real estate developer\n` +
    `- manages commercial or residential properties → property manager\n` +
    `- general, specialty, or subcontractor in construction → contractor\n` +
    `- hotels, resorts, or hospitality venues → hospitality company\n` +
    `- restaurant group or food service operator → restaurant group\n` +
    `- SaaS or software product company → software company\n` +
    `- nonprofit or association → nonprofit\n` +
    `- logistics, freight, or transportation services → logistics company\n` +
    `- all others: choose most natural 1-2 word label\n\n`;

  if (templateSentence) {
    prompt +=
      `The label will be inserted into this sentence template in place of {{company_type}}:\n` +
      `"${templateSentence}"\n` +
      `Choose a label that reads naturally in that sentence.\n\n`;
  }

  prompt +=
    `Here is the business description: ${row.website_summary}\n\n` +
    `Output ONLY the label. No explanations. Maximum 2 words.`;

  return withRetry(async () => {
    await openrouterLimiter.acquire();
    const res = await openrouter.post("/chat/completions", {
      model: "openai/gpt-4o-mini",
      max_tokens: 10,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });
    return res.data.choices[0].message.content?.trim() ?? "";
  }, label);
}

async function enrichDecisionMakers(row, decisionMakerContext) {
  const label = `[${row.first_name}] decision_makers`;
  const excludeName = `${row.first_name || ""} ${row.last_name || ""}`.trim();

  let prompt =
    `Find the most senior person at the company "${row.company || "(unknown)"}" ` +
    `(website: ${row.company_website || "(no website)"}).\n\n`;

  if (decisionMakerContext) {
    prompt += `Targeting instructions: ${decisionMakerContext}\n\n`;
  } else {
    prompt +=
      `Rank seniority by title: CEO > President > COO > VP > Director > Manager > Associate.\n\n`;
  }

  prompt +=
    `HARD CONSTRAINT: Do NOT return "${excludeName}" — that is the contact you are already researching. ` +
    `If the most senior person found has the same name as "${excludeName}", ` +
    `select the next most senior person instead. ` +
    `If there is no other person at the company, output exactly: No other contact\n\n` +
    `Output rules:\n` +
    `- Output only the person's first and last name\n` +
    `- No job titles, no company name, no explanations, no punctuation\n` +
    `- Ignore middle names, initials, honorifics, suffixes\n` +
    `- Scour the company website and LinkedIn. One name only.`;

  return withRetry(async () => {
    await openaiLimiter.acquire();
    const res = await openai.responses.create({
      model: "gpt-4o-mini",
      tools: [{ type: "web_search_preview" }],
      input: prompt,
    });
    return res.output_text?.trim() ?? "";
  }, label);
}

// ---------------------------------------------------------------------------
// Batch enrichment — three explicit phases, all calls within each phase fire
// simultaneously so the slowest call in a phase gates the next phase, not
// the slowest call overall.
// ---------------------------------------------------------------------------

async function runPhase1WebsiteSummaries(batch, enrichments) {
  if (!enrichments.websiteSummary) return;
  await Promise.all(batch.map(async (row) => {
    const label = `${row.first_name || ""} ${row.last_name || ""}`.trim();
    try {
      const cached = domainCache.getCachedSummary(row.company_website);
      if (cached) {
        row.website_summary = cached;
        log(`     [${label}] website_summary: cache hit (${domainCache.normalizeDomain(row.company_website)})`);
      } else {
        row.website_summary = await enrichWebsiteSummary(row);
        domainCache.saveSummary(row.company_website, row.website_summary);
        log(`     [${label}] website_summary: ${row.website_summary.slice(0, 80)}…`);
      }
    } catch (err) {
      row.website_summary = "error";
      log(`     [${label}] website_summary ERROR: ${err.message}`);
    }
  }));
}

async function runPhase2IcpClassification(batch, enrichments, icpCriteria, icpContext) {
  if (!enrichments.icpClassification) return;
  await Promise.all(batch.map(async (row) => {
    const label = `${row.first_name || ""} ${row.last_name || ""}`.trim();
    try {
      row.icp_classification = await enrichIcpClassification(row, icpCriteria, icpContext);
      log(`     [${label}] icp_classification: ${row.icp_classification}`);
    } catch (err) {
      row.icp_classification = "error";
      log(`     [${label}] icp_classification ERROR: ${err.message}`);
    }
  }));
}

async function runPhase3IcpFitEnrichments(icpFits, enrichments, businessTypeTemplate, decisionMakerCtx) {
  if (!icpFits.length) return;
  await Promise.all(icpFits.flatMap((row) => {
    const label = `${row.first_name || ""} ${row.last_name || ""}`.trim();
    return [
      enrichments.businessLabeling
        ? enrichBusinessType(row, businessTypeTemplate)
            .then((r) => { row.business_type = r; log(`     [${label}] business_type: ${r}`); })
            .catch((err) => { row.business_type = "error"; log(`     [${label}] business_type ERROR: ${err.message}`); })
        : Promise.resolve(),
      enrichments.decisionMakerDiscovery
        ? enrichDecisionMakers(row, decisionMakerCtx)
            .then((r) => { row.additional_decision_makers = r; log(`     [${label}] decision_makers: ${r}`); })
            .catch((err) => { row.additional_decision_makers = "error"; log(`     [${label}] decision_makers ERROR: ${err.message}`); })
        : Promise.resolve(),
    ];
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.includes("your_"))
    throw new Error("OPENAI_API_KEY is not configured in .env");
  if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY.includes("your_"))
    throw new Error("OPENROUTER_API_KEY is not configured in .env");

  const cleanedDir = path.join(ROOT, "data/cleaned");
  const enrichedDir = path.join(ROOT, "data/enriched");
  fs.mkdirSync(enrichedDir, { recursive: true });

  const cleanedFiles = fs.readdirSync(cleanedDir).filter((f) => f.endsWith(".csv"));
  if (!cleanedFiles.length) throw new Error("No CSV files found in data/cleaned/");

  for (const filename of cleanedFiles) {
    const cleanedPath = path.join(cleanedDir, filename);
    const enrichedFilename = filename.replace("_cleaned_", "_enriched_");
    const enrichedPath = path.join(enrichedDir, enrichedFilename);

    const runStart = Date.now();
    log(`━━━ Processing: ${filename}`);

    // Find matching job config
    const job = findJobForCleanedFile(filename);
    const enrichments = job?.enrichments ?? {
      websiteSummary: true,
      icpClassification: true,
      businessLabeling: true,
      decisionMakerDiscovery: true,
    };
    const icpCriteria           = job ? formatIcpCriteria(job.icp) : "";
    const icpContext             = job?.enrichments?.icpClassificationContext ?? "";
    const businessTypeTemplate   = job?.enrichments?.businessTypeLabelTemplate ?? "";
    const decisionMakerCtx       = job?.enrichments?.decisionMakerContext ?? "";

    if (job) {
      log(`  Job: ${job.jobId}`);
      log(`  Enrichments enabled: ${Object.entries(enrichments).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
    } else {
      log(`  No matching job found — running all enrichments`);
    }

    const rows = parse(fs.readFileSync(cleanedPath, "utf8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const newCols = [];
    if (enrichments.websiteSummary)         newCols.push("website_summary");
    if (enrichments.icpClassification)      newCols.push("icp_classification");
    if (enrichments.businessLabeling)       newCols.push("business_type");
    if (enrichments.decisionMakerDiscovery) newCols.push("additional_decision_makers");

    const outHeaders = [...Object.keys(rows[0] || {}), ...newCols];

    // Initialize new columns for all rows upfront
    for (const row of rows) {
      for (const col of newCols) row[col] = "";
    }

    // Separate valid-email rows from skipped
    let processed = 0;
    let skipped = 0;
    const toProcess = [];

    for (const row of rows) {
      if (row["Valid Email"] !== "Valid Email") {
        log(`  SKIP  ${row.email || row.first_name} — not a valid email`);
        skipped++;
      } else {
        toProcess.push(row);
      }
    }

    log(`  ${toProcess.length} record(s) to enrich — batch size: ${BATCH_SIZE}`);

    // Process in parallel batches — three explicit phases per batch
    const totalBatches = Math.ceil(toProcess.length / BATCH_SIZE);

    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const batch = toProcess.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const batchStart = Date.now();

      log(`  ── Batch ${batchNum}/${totalBatches} (${batch.length} records)`);

      // Phase 1: all website summaries simultaneously
      const p1Start = Date.now();
      await runPhase1WebsiteSummaries(batch, enrichments);
      log(`  ── Phase 1 (website summaries): ${((Date.now() - p1Start) / 1000).toFixed(1)}s`);

      // Phase 2: all ICP classifications simultaneously
      const p2Start = Date.now();
      await runPhase2IcpClassification(batch, enrichments, icpCriteria, icpContext);
      const icpFits = enrichments.icpClassification
        ? batch.filter((r) => r.icp_classification === "icp fit")
        : batch;
      log(
        `  ── Phase 2 (ICP classification): ${((Date.now() - p2Start) / 1000).toFixed(1)}s` +
        ` — ${icpFits.length}/${batch.length} fit` +
        (enrichments.icpClassification
          ? ` (${batch.length - icpFits.length} skipped)`
          : "")
      );

      // Phase 3: business type + decision makers for ICP fits simultaneously
      const p3Start = Date.now();
      await runPhase3IcpFitEnrichments(icpFits, enrichments, businessTypeTemplate, decisionMakerCtx);
      if (icpFits.length > 0) {
        log(`  ── Phase 3 (business type + decision makers): ${((Date.now() - p3Start) / 1000).toFixed(1)}s`);
      }

      const batchElapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
      log(`  ── Batch ${batchNum}/${totalBatches} completed in ${batchElapsed}s`);

      processed += batch.length;
    }

    const totalElapsed = ((Date.now() - runStart) / 1000).toFixed(1);

    fs.writeFileSync(enrichedPath, stringifyCSV(outHeaders, rows));

    const cacheStats = domainCache.getCacheStats();
    log(`━━━ Done: ${filename}`);
    log(`    Enriched   : ${processed}`);
    log(`    Skipped    : ${skipped}`);
    log(`    Total time : ${totalElapsed}s`);
    log(`    Cache hits : ${cacheStats.hits} (${cacheStats.estimatedSaved} saved)`);
    log(`    Cache misses: ${cacheStats.misses} (new API calls)`);
    log(`    Cached domains: ${cacheStats.totalCached} total in cache`);
    log(`    Saved to   : data/enriched/${enrichedFilename}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
