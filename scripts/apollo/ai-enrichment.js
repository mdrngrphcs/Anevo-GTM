"use strict";

const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { parse } = require("csv-parse/sync");
const OpenAI = require("openai");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const ROOT = path.resolve(__dirname, "../..");
const RATE_LIMIT_MS = 500;

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
// Enrichment functions
// ---------------------------------------------------------------------------

async function enrichWebsiteSummary(row) {
  const prompt =
    `I want you to visit this website ${row.company_website || "(no website)"} ` +
    `for this company ${row.company || "(unknown)"} and summarize what their business ` +
    `does, what are all the products or services they sell, and all possible relevant ` +
    `information. Please make an exhaustive business research summary that includes ` +
    `all possible data you can find. Stop at nothing.`;

  const res = await openai.responses.create({
    model: "gpt-4o-mini",
    tools: [{ type: "web_search_preview" }],
    input: prompt,
  });
  return res.output_text?.trim() ?? "";
}

async function enrichIcpClassification(row, icpCriteria) {
  const userPrompt =
    `Determine if this company is a good fit based on:\n${row.website_summary}\n` +
    `ICP criteria: ${icpCriteria}\n` +
    `If good fit respond ONLY with: icp fit\n` +
    `If bad fit respond ONLY with: not a fit`;

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
}

async function enrichBusinessType(row) {
  const prompt =
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
    `- all others: choose most natural 1-2 word label\n\n` +
    `Here is the business description: ${row.website_summary}\n\n` +
    `Output ONLY the label. No explanations. Maximum 2 words.`;

  const res = await openrouter.post("/chat/completions", {
    model: "openai/gpt-4o-mini",
    max_tokens: 10,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  return res.data.choices[0].message.content?.trim() ?? "";
}

async function enrichDecisionMakers(row) {
  const prompt =
    `I want you to output the first and last name of the most senior person from this company ${row.company || "(unknown)"}. ` +
    `Here is their website: ${row.company_website || "(no website)"}. ` +
    `Assess seniority based on common hierarchical titles (CEO > VP > Director > Manager > Associate). ` +
    `If the person who best fits has the same name as ${row.first_name || ""} ${row.last_name || ""} then select a different person. ` +
    `If there is no other person output: No other contact. ` +
    `Ignore middle names, initials, prefixes, suffixes. ` +
    `Output only the cleaned first and last name. ` +
    `No job titles, no explanations, no other text. ` +
    `Scour the internet including LinkedIn. Stop at nothing.`;

  const res = await openai.responses.create({
    model: "gpt-4o-mini",
    tools: [{ type: "web_search_preview" }],
    input: prompt,
  });
  return res.output_text?.trim() ?? "";
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

    log(`━━━ Processing: ${filename}`);

    // Find matching job config
    const job = findJobForCleanedFile(filename);
    const enrichments = job?.enrichments ?? {
      websiteSummary: true,
      icpClassification: true,
      businessLabeling: true,
      decisionMakerDiscovery: true,
    };
    const icpCriteria = job ? formatIcpCriteria(job.icp) : "";

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
    if (enrichments.websiteSummary)        newCols.push("website_summary");
    if (enrichments.icpClassification)     newCols.push("icp_classification");
    if (enrichments.businessLabeling)      newCols.push("business_type");
    if (enrichments.decisionMakerDiscovery) newCols.push("additional_decision_makers");

    const outHeaders = [...Object.keys(rows[0] || {}), ...newCols];

    let processed = 0;
    let skipped = 0;

    for (const row of rows) {
      // Initialize new columns
      for (const col of newCols) row[col] = "";

      if (row["Valid Email"] !== "Valid Email") {
        log(`  SKIP  ${row.email || row.first_name} — not a valid email`);
        skipped++;
        continue;
      }

      log(`  ── ${row.first_name} ${row.last_name || ""} <${row.email}> @ ${row.company}`);

      // 1. Website Summary (OpenAI)
      if (enrichments.websiteSummary) {
        try {
          row.website_summary = await enrichWebsiteSummary(row);
          log(`     website_summary: ${row.website_summary.slice(0, 80)}…`);
        } catch (err) {
          row.website_summary = "error";
          log(`     website_summary ERROR: ${err.message}`);
        }
        await sleep(RATE_LIMIT_MS);
      }

      // 2. ICP Classification (DeepSeek via OpenRouter)
      if (enrichments.icpClassification) {
        try {
          row.icp_classification = await enrichIcpClassification(row, icpCriteria);
          log(`     icp_classification: ${row.icp_classification}`);
        } catch (err) {
          row.icp_classification = "error";
          log(`     icp_classification ERROR: ${err.message}`);
        }
        await sleep(RATE_LIMIT_MS);
      }

      // 3. Business Type (GPT-4o Mini via OpenRouter)
      if (enrichments.businessLabeling) {
        try {
          row.business_type = await enrichBusinessType(row);
          log(`     business_type: ${row.business_type}`);
        } catch (err) {
          row.business_type = "error";
          log(`     business_type ERROR: ${err.message}`);
        }
        await sleep(RATE_LIMIT_MS);
      }

      // 4. Decision Maker Discovery (OpenAI)
      if (enrichments.decisionMakerDiscovery) {
        try {
          row.additional_decision_makers = await enrichDecisionMakers(row);
          log(`     additional_decision_makers: ${row.additional_decision_makers}`);
        } catch (err) {
          row.additional_decision_makers = "error";
          log(`     additional_decision_makers ERROR: ${err.message}`);
        }
        await sleep(RATE_LIMIT_MS);
      }

      processed++;
    }

    fs.writeFileSync(enrichedPath, stringifyCSV(outHeaders, rows));

    log(`━━━ Done: ${filename}`);
    log(`    Enriched : ${processed}`);
    log(`    Skipped  : ${skipped}`);
    log(`    Saved to : data/enriched/${enrichedFilename}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
