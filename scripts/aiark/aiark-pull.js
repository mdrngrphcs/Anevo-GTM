"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const axios = require("axios");
const localtunnel = require("localtunnel");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const ROOT = path.resolve(__dirname, "../..");
const BASE  = "https://api.ai-ark.com/api/developer-portal/v1";
const PEOPLE_ENDPOINT      = `${BASE}/people`;
const EMAIL_FINDER_BASE    = `${BASE}/people/email-finder`;

const EMAIL_POLL_INTERVAL_MS = 5000;
const EMAIL_POLL_TIMEOUT_MS  = 180000;

// ---------------------------------------------------------------------------
// Filter translation
// ---------------------------------------------------------------------------

function translateFilters(icp) {
  const account = {};
  const contact = {};

  // Titles → contact.experience.latest.title (any.include with SMART mode)
  if (icp.titles?.length) {
    contact.experience = {
      latest: {
        title: {
          any: { include: { mode: "SMART", content: icp.titles } },
        },
      },
    };
  }

  // Location → contact.location.any.include (array of strings)
  if (icp.location?.length) {
    contact.location = { any: { include: icp.location } };
  }

  // Industries → account.industries.any.include (SMART mode)
  if (icp.industries?.length) {
    account.industries = {
      any: { include: { mode: "SMART", content: icp.industries } },
    };
  }

  // Company keywords → account.keyword.any.include (KEYWORD source, SMART mode)
  if (icp.companyKeywords?.length) {
    account.keyword = {
      any: {
        include: {
          sources: [{ mode: "SMART", source: "KEYWORD" }],
          content: icp.companyKeywords,
        },
      },
    };
  }

  // Headcount → account.employeeSize (RANGE type, array of {start, end})
  if (icp.headcount?.min != null || icp.headcount?.max != null) {
    account.employeeSize = {
      type: "RANGE",
      range: [{ start: icp.headcount.min ?? 0, end: icp.headcount.max ?? 999999 }],
    };
  }

  // Revenue → account.revenue (RANGE type, array of {start, end})
  if (icp.revenue?.min != null || icp.revenue?.max != null) {
    account.revenue = {
      type: "RANGE",
      range: [{ start: icp.revenue.min ?? 0, end: icp.revenue.max ?? 999999999 }],
    };
  }

  // Technologies → account.technology.any.include (array of strings)
  if (icp.technologies?.length) {
    account.technology = { any: { include: icp.technologies } };
  }

  return { account, contact };
}

// ---------------------------------------------------------------------------
// Job queue helpers
// ---------------------------------------------------------------------------

function loadQueuedJob(jobId) {
  const dir = path.join(ROOT, "jobs/queued");
  if (jobId) {
    const jobPath = path.join(dir, `${jobId}.json`);
    if (!fs.existsSync(jobPath)) throw new Error(`Job not found in jobs/queued/: ${jobId}`);
    return JSON.parse(fs.readFileSync(jobPath, "utf8"));
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) throw new Error("No queued jobs found in jobs/queued/");
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
}

function moveJob(job, fromStatus, toStatus) {
  const fromPath = path.join(ROOT, `jobs/${fromStatus}`, `${job.jobId}.json`);
  const toPath   = path.join(ROOT, `jobs/${toStatus}`,   `${job.jobId}.json`);
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
    path.join(logDir, `aiark-pull-${ts.slice(0, 10)}.log`),
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

function extractDomain(person) {
  const d = person.company?.link?.domain;
  if (d) return d;
  const url = person.company?.link?.website;
  if (!url) return "";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function mapContact(p, emailLookup) {
  const profile = p.profile ?? {};
  const company = p.company ?? {};
  const summary = company.summary ?? {};
  const cLink   = company.link ?? {};
  const loc     = p.location ?? {};

  // Match by refId first, then fall back to name+domain
  const byRef    = emailLookup.get(p.id ?? "");
  const domain   = extractDomain(p);
  const nameKey  = `${(profile.first_name ?? "").trim()}|${(profile.last_name ?? "").trim()}|${domain}`.toLowerCase();
  const byName   = emailLookup.get(nameKey);
  const found    = byRef ?? byName;

  return {
    first_name:       profile.first_name  ?? "",
    last_name:        profile.last_name   ?? "",
    title:            profile.title       ?? "",
    email:            found?.email        ?? "",
    email_status:     found?.email ? "pending_validation" : "",
    phone:            "",
    linkedin_url:     p.link?.linkedin    ?? "",
    company:          summary.name        ?? "",
    company_website:  cLink.website       ?? "",
    company_linkedin: cLink.linkedin      ?? "",
    industry:         p.industry          ?? "",
    headcount:        summary.staff?.total ?? "",
    city:             loc.city    ?? "",
    state:            loc.state   ?? "",
    country:          loc.country ?? "",
  };
}

function recordsToCsv(records, emailLookup) {
  const header = CSV_COLUMNS.join(",");
  const rows = records.map((p) => {
    const mapped = mapContact(p, emailLookup);
    return CSV_COLUMNS.map((col) => escapeCell(mapped[col])).join(",");
  });
  return [header, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(apiKey) {
  return { "Content-Type": "application/json", "X-TOKEN": apiKey };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiKey = process.env.AI_ARK_API_KEY;
  if (!apiKey) throw new Error("AI_ARK_API_KEY is not set in .env");

  const jobIdArg = process.argv[2] ?? null;
  const job = loadQueuedJob(jobIdArg);
  const { jobId } = job;

  log(jobId, `Loaded job — client: ${job.clientName}, list: ${job.listName}`);
  moveJob(job, "queued", "processing");
  log(jobId, "Status → processing");

  const filters = translateFilters(job.icp);
  log(jobId, `AI Ark filters: ${JSON.stringify(filters)}`);

  // ── Step 1: People search ────────────────────────────────────────────────

  log(jobId, "Step 1 — Calling AI Ark /people …");

  let people;
  let trackId;

  try {
    const { data } = await axios.post(
      PEOPLE_ENDPOINT,
      { account: filters.account, contact: filters.contact, page: 0, size: 5 },
      { headers: authHeaders(apiKey), timeout: 30000 }
    );

    log(jobId, `Step 1 — Raw response keys: ${Object.keys(data).join(", ")}`);
    log(jobId, `Step 1 — Full response (non-content): ${JSON.stringify({ ...data, content: `[${(data.content ?? []).length} records]` })}`);

    people  = data.content ?? [];
    trackId = data.trackId ?? data.track_id ?? data.id ?? null;

    log(jobId, `Step 1 — ${people.length} record(s) returned, trackId = ${trackId}`);
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    log(jobId, `Step 1 — Failed: ${JSON.stringify(detail)}`);
    moveJob(job, "processing", "failed");
    process.exit(1);
  }

  // ── Steps 2–4: Email finder ──────────────────────────────────────────────

  let emailLookup = new Map();

  if (!trackId || people.length === 0) {
    log(jobId, "Step 2 — No trackId or no records, skipping email finder");
  } else {
    let server = null;
    let tunnel = null;

    try {
      // 2 — Start local webhook receiver + tunnel
      log(jobId, "Step 2 — Starting local webhook receiver …");

      const webhookPayload = await new Promise(async (resolve) => {
        let settled = false;

        // Local HTTP server — captures first POST body
        server = http.createServer((req, res) => {
          if (req.method !== "POST") { res.writeHead(200); res.end("ok"); return; }
          let raw = "";
          req.on("data", (chunk) => { raw += chunk; });
          req.on("end", () => {
            res.writeHead(200); res.end("ok");
            if (!settled) { settled = true; resolve(raw); }
          });
        });

        await new Promise((ok) => server.listen(0, ok));
        const port = server.address().port;
        log(jobId, `Step 2 — Local server on port ${port}`);

        // Expose via localtunnel
        tunnel = await localtunnel({ port });
        log(jobId, `Step 2 — Tunnel URL: ${tunnel.url}`);

        // Trigger email finder
        log(jobId, `Step 2 — Triggering email finder: POST ${EMAIL_FINDER_BASE}`);
        const triggerRes = await axios.post(
          EMAIL_FINDER_BASE,
          { trackId, webhook: tunnel.url },
          { headers: authHeaders(apiKey), timeout: 30000 }
        );
        log(jobId, `Step 2 — Trigger response: ${JSON.stringify(triggerRes.data)}`);

        // 3 — Poll statistics until DONE (webhook may arrive first)
        log(jobId, `Step 3 — Polling statistics every ${EMAIL_POLL_INTERVAL_MS / 1000}s (max ${EMAIL_POLL_TIMEOUT_MS / 1000}s) …`);
        const deadline = Date.now() + EMAIL_POLL_TIMEOUT_MS;
        let attempt = 0;

        while (!settled && Date.now() < deadline) {
          await sleep(EMAIL_POLL_INTERVAL_MS);
          attempt++;

          let statsData;
          try {
            const statsRes = await axios.get(
              `${EMAIL_FINDER_BASE}/${trackId}/statistics`,
              { headers: authHeaders(apiKey), timeout: 30000 }
            );
            statsData = statsRes.data;
          } catch (pollErr) {
            log(jobId, `Step 3 — Poll ${attempt} error: ${pollErr.message}`);
            continue;
          }

          const state = statsData.state ?? "";
          log(jobId, `Step 3 — Poll ${attempt}: state=${state} found=${statsData.statistics?.found ?? "?"}/${statsData.statistics?.total ?? "?"}`);

          if (state === "DONE" || state === "done" || state === "completed") {
            log(jobId, "Step 3 — Statistics show DONE — waiting up to 60s for webhook …");
            await sleep(60000);
            if (!settled) { settled = true; resolve(null); }
            break;
          }
        }

        if (!settled) {
          log(jobId, `Step 3 — Timed out after ${EMAIL_POLL_TIMEOUT_MS / 1000}s`);
          settled = true;
          resolve(null);
        }
      });

      // 4 — Parse webhook payload
      if (webhookPayload) {
        log(jobId, `Step 4 — Webhook received. Raw payload:\n${webhookPayload}`);
        let results;
        try {
          const parsed = JSON.parse(webhookPayload);
          results = Array.isArray(parsed)
            ? parsed
            : parsed.content ?? parsed.results ?? parsed.data ?? parsed.emails ?? [];
          log(jobId, `Step 4 — ${results.length} email result(s) in payload`);
          log(jobId, `Step 4 — Full parsed payload:\n${JSON.stringify(parsed, null, 2)}`);
        } catch {
          log(jobId, "Step 4 — Could not parse webhook payload as JSON");
          results = [];
        }

        for (const r of results) {
          // AI Ark webhook: email is in output[0].address; names/domain are in input.*
          const email = r.output?.[0]?.address ?? r.email ?? r.emailAddress ?? r.email_address ?? "";
          if (!email) continue;

          const refId  = r.refId ?? r.ref_id ?? r.id ?? "";
          const fn     = r.input?.firstname ?? r.firstname ?? r.first_name ?? r.firstName ?? "";
          const ln     = r.input?.lastname  ?? r.lastname  ?? r.last_name  ?? r.lastName  ?? "";
          const domain = r.input?.domain    ?? r.domain    ?? r.website    ?? "";

          if (refId) emailLookup.set(refId, { email });
          const nameKey = `${fn.trim()}|${ln.trim()}|${domain}`.toLowerCase();
          if (nameKey !== "||") emailLookup.set(nameKey, { email });

          log(jobId, `  Email matched: ${fn} ${ln} @ ${domain} → ${email}`);
        }
        log(jobId, `Step 4 — ${emailLookup.size} unique email(s) mapped`);
      } else {
        log(jobId, "Step 4 — No webhook payload received (emails unavailable)");
      }

    } catch (err) {
      const status = err.response?.status ?? "no-response";
      const detail = err.response?.data ?? err.message;
      log(jobId, `Email finder failed (non-fatal) [HTTP ${status}]: ${JSON.stringify(detail)}`);
    } finally {
      if (tunnel) tunnel.close();
      if (server) server.close();
    }
  }

  // ── Step 5: Save CSV ─────────────────────────────────────────────────────

  const rawDir = path.join(ROOT, "data/raw");
  fs.mkdirSync(rawDir, { recursive: true });
  const csvPath = path.join(rawDir, job.outputFilename);
  fs.writeFileSync(csvPath, recordsToCsv(people, emailLookup));
  log(jobId, `Saved ${people.length} record(s) → data/raw/${job.outputFilename}`);

  moveJob(job, "processing", "completed");
  log(jobId, "Status → completed");
  log(jobId, "Done.");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
