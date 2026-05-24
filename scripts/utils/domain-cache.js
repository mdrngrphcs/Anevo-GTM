"use strict";

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
const CACHE_FILE = path.join(ROOT, "config/domain-cache.json");

// Approximate cost of one GPT-4o-mini + web_search_preview call
const COST_PER_CALL = 0.025;

// Per-process hit/miss counters (reset each invocation)
let cacheHits = 0;
let cacheMisses = 0;

// In-memory cache — loaded once, written back on each mutation
let _cache = null;

function loadCache() {
  if (_cache !== null) return _cache;
  if (!fs.existsSync(CACHE_FILE)) {
    _cache = {};
    return _cache;
  }
  try {
    _cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    _cache = {};
  }
  return _cache;
}

function persistCache() {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache, null, 2));
}

function normalizeDomain(website) {
  if (!website) return null;
  try {
    const url = new URL(website.startsWith("http") ? website : `https://${website}`);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    const stripped = website
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split("/")[0]
      .toLowerCase();
    return stripped || null;
  }
}

/**
 * Returns the cached summary for a given website URL, or null if not cached.
 * Increments timesUsed in the cache file on every hit.
 */
function getCachedSummary(website) {
  const domain = normalizeDomain(website);
  if (!domain) return null;
  const cache = loadCache();
  const entry = cache[domain];
  if (!entry?.summary) return null;
  entry.timesUsed = (entry.timesUsed ?? 0) + 1;
  cacheHits++;
  persistCache();
  return entry.summary;
}

/**
 * Saves a website summary to the cache.
 * Preserves existing timesUsed so the count survives re-caching.
 */
function saveSummary(website, summary) {
  const domain = normalizeDomain(website);
  if (!domain || !summary) return;
  const cache = loadCache();
  cache[domain] = {
    summary,
    cachedAt: new Date().toISOString(),
    timesUsed: cache[domain]?.timesUsed ?? 0,
  };
  cacheMisses++;
  persistCache();
}

/**
 * Returns stats for the current process run and the full cache.
 */
function getCacheStats() {
  const cache = loadCache();
  const totalCached = Object.keys(cache).length;
  return {
    totalCached,
    hits: cacheHits,
    misses: cacheMisses,
    estimatedSaved: `$${(cacheHits * COST_PER_CALL).toFixed(3)}`,
  };
}

module.exports = { getCachedSummary, saveSummary, getCacheStats, normalizeDomain };
