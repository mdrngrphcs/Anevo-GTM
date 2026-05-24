"use strict";

/**
 * One-off: re-trigger the AI Ark email finder for an existing trackId,
 * wait for the webhook, then patch the email columns into a raw CSV.
 *
 * Usage: node scripts/patch-emails.js <trackId> <rawCsvPath>
 */

const path   = require("path");
const fs     = require("fs");
const http   = require("http");
const axios  = require("axios");
const localtunnel = require("localtunnel");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const EMAIL_FINDER_BASE = "https://api.ai-ark.com/api/developer-portal/v1/people/email-finder";
const POLL_INTERVAL_MS  = 5000;
const POLL_TIMEOUT_MS   = 180000;
const WEBHOOK_WAIT_MS   = 90000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function authHeaders(key) {
  return { "Content-Type": "application/json", "X-TOKEN": key };
}

async function main() {
  const trackId  = process.argv[2];
  const csvPath  = path.resolve(process.argv[3]);
  if (!trackId || !csvPath) {
    console.error("Usage: node scripts/patch-emails.js <trackId> <rawCsvPath>");
    process.exit(1);
  }

  const apiKey = process.env.AI_ARK_API_KEY;
  if (!apiKey) throw new Error("AI_ARK_API_KEY not set");

  console.log(`trackId : ${trackId}`);
  console.log(`CSV     : ${csvPath}`);

  // ── Start local webhook + tunnel ──────────────────────────────────────────

  let server = null;
  let tunnel = null;

  const webhookPayload = await new Promise(async (resolve) => {
    let settled = false;

    server = http.createServer((req, res) => {
      if (req.method !== "POST") { res.writeHead(200); res.end("ok"); return; }
      let raw = "";
      req.on("data", c => { raw += c; });
      req.on("end", () => {
        res.writeHead(200); res.end("ok");
        if (!settled) { settled = true; resolve(raw); }
      });
    });

    await new Promise(ok => server.listen(0, ok));
    const port = server.address().port;
    console.log(`Local server on port ${port}`);

    tunnel = await localtunnel({ port });
    console.log(`Tunnel: ${tunnel.url}`);

    // Re-trigger email finder
    const triggerRes = await axios.post(
      EMAIL_FINDER_BASE,
      { trackId, webhook: tunnel.url },
      { headers: authHeaders(apiKey), timeout: 30000 }
    );
    console.log("Trigger response:", JSON.stringify(triggerRes.data));

    // Poll until DONE then wait for webhook
    console.log("Polling …");
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let attempt = 0;

    while (!settled && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      attempt++;
      try {
        const r = await axios.get(
          `${EMAIL_FINDER_BASE}/${trackId}/statistics`,
          { headers: authHeaders(apiKey), timeout: 30000 }
        );
        const state = r.data.state ?? "";
        console.log(`Poll ${attempt}: state=${state} found=${r.data.statistics?.found ?? "?"}/${r.data.statistics?.total ?? "?"}`);
        if (state === "DONE" || state === "done" || state === "completed") {
          console.log(`DONE — waiting up to ${WEBHOOK_WAIT_MS / 1000}s for webhook …`);
          await sleep(WEBHOOK_WAIT_MS);
          if (!settled) { settled = true; resolve(null); }
          break;
        }
      } catch (e) {
        console.log(`Poll ${attempt} error: ${e.message}`);
      }
    }

    if (!settled) { settled = true; resolve(null); }
  });

  if (tunnel) tunnel.close();
  if (server) server.close();

  if (!webhookPayload) {
    console.error("No webhook payload received.");
    process.exit(1);
  }

  console.log("\nWebhook received. Raw payload:");
  console.log(webhookPayload);

  // ── Parse emails ──────────────────────────────────────────────────────────

  let results;
  try {
    const parsed = JSON.parse(webhookPayload);
    results = Array.isArray(parsed)
      ? parsed
      : parsed.content ?? parsed.results ?? parsed.data ?? parsed.emails ?? [];
  } catch {
    console.error("Could not parse webhook payload as JSON");
    process.exit(1);
  }

  console.log(`\n${results.length} email result(s) in payload`);

  // Build lookup: nameKey → email
  const lookup = new Map();
  for (const r of results) {
    const email = r.output?.[0]?.address ?? r.email ?? r.emailAddress ?? "";
    if (!email) continue;
    const refId  = r.refId ?? r.ref_id ?? r.id ?? "";
    const fn     = (r.input?.firstname ?? r.firstname ?? r.first_name ?? "").trim();
    const ln     = (r.input?.lastname  ?? r.lastname  ?? r.last_name  ?? "").trim();
    const domain = (r.input?.domain    ?? r.domain    ?? r.website    ?? "").trim();
    if (refId) lookup.set(refId, email);
    const nameKey = `${fn}|${ln}|${domain}`.toLowerCase();
    if (nameKey !== "||") lookup.set(nameKey, email);
    console.log(`  ${fn} ${ln} @ ${domain} → ${email}`);
  }

  // ── Patch raw CSV ─────────────────────────────────────────────────────────

  const lines = fs.readFileSync(csvPath, "utf8").split("\n");
  const headers = lines[0].split(",");
  const emailIdx       = headers.indexOf("email");
  const emailStatusIdx = headers.indexOf("email_status");
  const fnIdx          = headers.indexOf("first_name");
  const lnIdx          = headers.indexOf("last_name");
  const websiteIdx     = headers.indexOf("company_website");

  let patched = 0;

  const updatedLines = lines.map((line, i) => {
    if (i === 0) return line;
    const cells = line.split(",");
    if (cells.length < headers.length) return line;

    const fn     = (cells[fnIdx] ?? "").replace(/^"|"$/g, "").trim();
    const ln     = (cells[lnIdx] ?? "").replace(/^"|"$/g, "").trim();
    const website = (cells[websiteIdx] ?? "").replace(/^"|"$/g, "").trim();
    let domain = "";
    try { domain = new URL(website).hostname.replace(/^www\./, ""); } catch { domain = website; }

    const nameKey = `${fn}|${ln}|${domain}`.toLowerCase();
    const email = lookup.get(nameKey) ?? "";

    if (email) {
      cells[emailIdx]       = email;
      cells[emailStatusIdx] = "pending_validation";
      patched++;
      return cells.join(",");
    }
    return line;
  });

  fs.writeFileSync(csvPath, updatedLines.join("\n"));
  console.log(`\nPatched ${patched} email(s) into ${csvPath}`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
