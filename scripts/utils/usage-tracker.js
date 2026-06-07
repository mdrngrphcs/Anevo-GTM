"use strict";

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
const USAGE_LOG = path.join(ROOT, "logs/usage-log.json");

// ---------------------------------------------------------------------------
// Cost estimates per API call type (USD)
// ---------------------------------------------------------------------------

const COST_PER_UNIT = {
  apollo_search:      0,          // free
  apollo_enrichment:  0,          // tracked as credits, not USD
  millionverifier:    0.001,      // per email verified
  openai_website:     0.00086,    // per record (website summary)
  deepseek_icp:       0.00014,    // per record (ICP classification)
  openai_decision:    0.00319,    // per record (decision maker discovery)
  anthropic_label:    0.00319,    // per record (business label)
};

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function readLog() {
  try {
    if (!fs.existsSync(USAGE_LOG)) return [];
    const raw = fs.readFileSync(USAGE_LOG, "utf8").trim();
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLog(entries) {
  const dir = path.dirname(USAGE_LOG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(USAGE_LOG, JSON.stringify(entries, null, 2));
}

// ---------------------------------------------------------------------------
// logApiCall
//
// jobId         — pipeline job ID
// clientName    — e.g. "Acme Corp"
// listName      — e.g. "CEOs NYC"
// api           — one of the COST_PER_UNIT keys
// action        — free-text description ("search page 1", "batch 2/5", etc.)
// recordCount   — number of records affected by this call
// extraData     — optional object with additional fields (e.g. apolloCredits)
// ---------------------------------------------------------------------------

function logApiCall(jobId, clientName, listName, api, action, recordCount, extraData = {}) {
  const costPerUnit = COST_PER_UNIT[api] ?? 0;
  const estimatedCost = costPerUnit * (recordCount || 0);

  const entries = readLog();

  // Compute cumulative cost for this job
  const priorJobCost = entries
    .filter((e) => e.jobId === jobId)
    .reduce((sum, e) => sum + (e.estimatedCost || 0), 0);

  const entry = {
    timestamp: new Date().toISOString(),
    jobId,
    clientName,
    listName,
    api,
    action,
    recordCount: recordCount || 0,
    estimatedCost: parseFloat(estimatedCost.toFixed(6)),
    cumulativeCostThisJob: parseFloat((priorJobCost + estimatedCost).toFixed(6)),
    ...extraData,
  };

  entries.push(entry);
  writeLog(entries);
}

// ---------------------------------------------------------------------------
// getUsageSummary
//
// Returns aggregated stats. Optional filters: { jobId, clientName, since }
// ---------------------------------------------------------------------------

function getUsageSummary(filters = {}) {
  const entries = readLog();

  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const filtered = entries.filter((e) => {
    if (filters.jobId && e.jobId !== filters.jobId) return false;
    if (filters.clientName && e.clientName !== filters.clientName) return false;
    if (filters.since && new Date(e.timestamp) < new Date(filters.since)) return false;
    return true;
  });

  // This week (last 7 days)
  const thisWeek = entries.filter((e) => new Date(e.timestamp) >= weekAgo);

  const sumCost = (arr) => arr.reduce((s, e) => s + (e.estimatedCost || 0), 0);
  const sumRecords = (arr) => arr.reduce((s, e) => s + (e.recordCount || 0), 0);
  const sumCredits = (arr, api) =>
    arr.filter((e) => e.api === api).reduce((s, e) => s + (e.apolloCredits || 0), 0);

  // By client
  const clientMap = {};
  for (const e of filtered) {
    if (!clientMap[e.clientName]) {
      clientMap[e.clientName] = { totalCost: 0, totalRecords: 0, jobCount: new Set(), callCount: 0 };
    }
    clientMap[e.clientName].totalCost    += e.estimatedCost || 0;
    clientMap[e.clientName].totalRecords += e.recordCount || 0;
    clientMap[e.clientName].jobCount.add(e.jobId);
    clientMap[e.clientName].callCount++;
  }
  const byClient = Object.entries(clientMap).map(([name, d]) => ({
    clientName: name,
    totalCost: parseFloat(d.totalCost.toFixed(4)),
    totalRecords: d.totalRecords,
    jobCount: d.jobCount.size,
    callCount: d.callCount,
  })).sort((a, b) => b.totalCost - a.totalCost);

  // By job
  const jobMap = {};
  for (const e of filtered) {
    if (!jobMap[e.jobId]) {
      jobMap[e.jobId] = {
        jobId: e.jobId,
        clientName: e.clientName,
        listName: e.listName,
        totalCost: 0,
        totalRecords: 0,
        apolloCredits: 0,
        callCount: 0,
        firstCall: e.timestamp,
        lastCall: e.timestamp,
      };
    }
    const j = jobMap[e.jobId];
    j.totalCost    += e.estimatedCost || 0;
    j.totalRecords += e.recordCount || 0;
    j.apolloCredits += e.apolloCredits || 0;
    j.callCount++;
    if (e.timestamp < j.firstCall) j.firstCall = e.timestamp;
    if (e.timestamp > j.lastCall)  j.lastCall  = e.timestamp;
  }
  const byJob = Object.values(jobMap).map((j) => ({
    ...j,
    totalCost: parseFloat(j.totalCost.toFixed(4)),
  })).sort((a, b) => b.lastCall.localeCompare(a.lastCall));

  // Cache performance (domain cache hits vs misses from website_summary calls)
  const cacheHitEntries  = filtered.filter((e) => e.api === "openai_website" && e.cacheHit);
  const cacheMissEntries = filtered.filter((e) => e.api === "openai_website" && !e.cacheHit);

  return {
    thisWeek: {
      totalCost:       parseFloat(sumCost(thisWeek).toFixed(4)),
      totalRecords:    sumRecords(thisWeek),
      apolloCredits:   sumCredits(thisWeek, "apollo_enrichment"),
      callCount:       thisWeek.length,
    },
    overall: {
      totalCost:       parseFloat(sumCost(filtered).toFixed(4)),
      totalRecords:    sumRecords(filtered),
      apolloCredits:   sumCredits(filtered, "apollo_enrichment"),
      callCount:       filtered.length,
    },
    byClient,
    byJob,
    cachePerformance: {
      hits:   cacheHitEntries.length,
      misses: cacheMissEntries.length,
      hitRate: cacheHitEntries.length + cacheMissEntries.length > 0
        ? Math.round((cacheHitEntries.length / (cacheHitEntries.length + cacheMissEntries.length)) * 100)
        : 0,
      savedCost: parseFloat(sumCost(cacheHitEntries).toFixed(4)),
    },
  };
}

// ---------------------------------------------------------------------------
// clearOldLogs — remove entries older than daysToKeep days
// ---------------------------------------------------------------------------

function clearOldLogs(daysToKeep = 30) {
  const entries = readLog();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysToKeep);
  const kept = entries.filter((e) => new Date(e.timestamp) >= cutoff);
  writeLog(kept);
  return { removed: entries.length - kept.length, kept: kept.length };
}

module.exports = { logApiCall, getUsageSummary, clearOldLogs };
