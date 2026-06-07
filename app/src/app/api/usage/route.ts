import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

const RAILWAY_URL = process.env.RAILWAY_URL?.replace(/\/$/, "");

const USAGE_LOG = path.resolve(process.cwd(), "../logs/usage-log.json");

interface UsageEntry {
  timestamp: string;
  jobId: string;
  clientName: string;
  listName: string;
  api: string;
  action: string;
  recordCount: number;
  estimatedCost: number;
  cumulativeCostThisJob: number;
  apolloCredits?: number;
  cacheHit?: boolean;
}

function readLog(): UsageEntry[] {
  try {
    if (!fs.existsSync(USAGE_LOG)) return [];
    const raw = fs.readFileSync(USAGE_LOG, "utf8").trim();
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function GET() {
  if (RAILWAY_URL) {
    try {
      const upstream = await fetch(`${RAILWAY_URL}/api/usage`, { signal: AbortSignal.timeout(15000) });
      return NextResponse.json(await upstream.json(), { status: upstream.status });
    } catch {
      return NextResponse.json({ error: "Railway unreachable" }, { status: 502 });
    }
  }

  const entries = readLog();

  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const thisWeek = entries.filter((e) => new Date(e.timestamp) >= weekAgo);

  const sumCost    = (arr: UsageEntry[]) => arr.reduce((s, e) => s + (e.estimatedCost || 0), 0);
  const sumRecords = (arr: UsageEntry[]) => arr.reduce((s, e) => s + (e.recordCount  || 0), 0);
  const sumCredits = (arr: UsageEntry[], api: string) =>
    arr.filter((e) => e.api === api).reduce((s, e) => s + (e.apolloCredits || 0), 0);

  // By client
  const clientMap: Record<string, { totalCost: number; totalRecords: number; jobIds: Set<string>; callCount: number }> = {};
  for (const e of entries) {
    if (!clientMap[e.clientName]) {
      clientMap[e.clientName] = { totalCost: 0, totalRecords: 0, jobIds: new Set(), callCount: 0 };
    }
    clientMap[e.clientName].totalCost    += e.estimatedCost || 0;
    clientMap[e.clientName].totalRecords += e.recordCount  || 0;
    clientMap[e.clientName].jobIds.add(e.jobId);
    clientMap[e.clientName].callCount++;
  }
  const byClient = Object.entries(clientMap).map(([name, d]) => ({
    clientName:   name,
    totalCost:    parseFloat(d.totalCost.toFixed(4)),
    totalRecords: d.totalRecords,
    jobCount:     d.jobIds.size,
    callCount:    d.callCount,
  })).sort((a, b) => b.totalCost - a.totalCost);

  // By job
  const jobMap: Record<string, {
    jobId: string; clientName: string; listName: string;
    totalCost: number; totalRecords: number; apolloCredits: number;
    callCount: number; firstCall: string; lastCall: string;
  }> = {};
  for (const e of entries) {
    if (!jobMap[e.jobId]) {
      jobMap[e.jobId] = {
        jobId: e.jobId, clientName: e.clientName, listName: e.listName,
        totalCost: 0, totalRecords: 0, apolloCredits: 0,
        callCount: 0, firstCall: e.timestamp, lastCall: e.timestamp,
      };
    }
    const j = jobMap[e.jobId];
    j.totalCost    += e.estimatedCost || 0;
    j.totalRecords += e.recordCount  || 0;
    j.apolloCredits += e.apolloCredits || 0;
    j.callCount++;
    if (e.timestamp < j.firstCall) j.firstCall = e.timestamp;
    if (e.timestamp > j.lastCall)  j.lastCall  = e.timestamp;
  }
  const byJob = Object.values(jobMap).map((j) => ({
    ...j,
    totalCost: parseFloat(j.totalCost.toFixed(4)),
  })).sort((a, b) => b.lastCall.localeCompare(a.lastCall));

  // Cache performance
  const cacheHits   = entries.filter((e) => e.api === "openai_website" && e.cacheHit);
  const cacheMisses = entries.filter((e) => e.api === "openai_website" && !e.cacheHit);

  const payload = {
    thisWeek: {
      totalCost:     parseFloat(sumCost(thisWeek).toFixed(4)),
      totalRecords:  sumRecords(thisWeek),
      apolloCredits: sumCredits(thisWeek, "apollo_enrichment"),
      callCount:     thisWeek.length,
    },
    overall: {
      totalCost:     parseFloat(sumCost(entries).toFixed(4)),
      totalRecords:  sumRecords(entries),
      apolloCredits: sumCredits(entries, "apollo_enrichment"),
      callCount:     entries.length,
    },
    byClient,
    byJob: byJob.slice(0, 50),
    cachePerformance: {
      hits:      cacheHits.length,
      misses:    cacheMisses.length,
      hitRate:   cacheHits.length + cacheMisses.length > 0
        ? Math.round((cacheHits.length / (cacheHits.length + cacheMisses.length)) * 100)
        : 0,
      savedCost: parseFloat(sumCost(cacheHits).toFixed(4)),
    },
  };

  return NextResponse.json(payload);
}
