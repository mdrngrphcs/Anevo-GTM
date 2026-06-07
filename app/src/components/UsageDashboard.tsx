"use client";

import { useEffect, useState, useCallback } from "react";

interface WeekSummary {
  totalCost: number;
  totalRecords: number;
  apolloCredits: number;
  callCount: number;
}

interface ClientRow {
  clientName: string;
  totalCost: number;
  totalRecords: number;
  jobCount: number;
  callCount: number;
}

interface JobRow {
  jobId: string;
  clientName: string;
  listName: string;
  totalCost: number;
  totalRecords: number;
  apolloCredits: number;
  callCount: number;
  firstCall: string;
  lastCall: string;
}

interface CachePerf {
  hits: number;
  misses: number;
  hitRate: number;
  savedCost: number;
}

interface UsageData {
  thisWeek: WeekSummary;
  overall: WeekSummary;
  byClient: ClientRow[];
  byJob: JobRow[];
  cachePerformance: CachePerf;
}

function fmt$(n: number) {
  return `$${n.toFixed(4)}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default function UsageDashboard() {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/usage");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setLastRefresh(new Date());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load usage data");
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">
        Failed to load usage data: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-sm text-gray-400 py-8 text-center">Loading usage data…</div>
    );
  }

  const { thisWeek, overall, byClient, byJob, cachePerformance } = data;
  const hasData = overall.callCount > 0;

  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">API Usage &amp; Cost Tracking</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : "Loading…"} · auto-refreshes every 30s
          </p>
        </div>
        <button
          onClick={load}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
        >
          Refresh now
        </button>
      </div>

      {!hasData && (
        <div className="rounded-lg border border-dashed border-gray-200 p-10 text-center text-sm text-gray-400">
          No usage data yet. Run a pipeline job to start tracking.
        </div>
      )}

      {hasData && (
        <>
          {/* This Week Summary */}
          <section>
            <h3 className="text-sm font-medium text-gray-700 mb-3">This Week (last 7 days)</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Est. Cost",      value: fmt$(thisWeek.totalCost),            sub: "USD" },
                { label: "Records",        value: thisWeek.totalRecords.toLocaleString(), sub: "emails pulled / verified" },
                { label: "Apollo Credits", value: thisWeek.apolloCredits.toLocaleString(), sub: "enrichment credits" },
                { label: "API Calls",      value: thisWeek.callCount.toLocaleString(),  sub: "total calls logged" },
              ].map((stat) => (
                <div key={stat.label} className="rounded-lg border border-gray-200 bg-white p-4">
                  <p className="text-xs text-gray-500">{stat.label}</p>
                  <p className="text-xl font-semibold text-gray-900 mt-1">{stat.value}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{stat.sub}</p>
                </div>
              ))}
            </div>
          </section>

          {/* By Client */}
          {byClient.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-gray-700 mb-3">By Client</h3>
              <div className="rounded-lg border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {["Client", "Est. Cost", "Records", "Jobs", "API Calls"].map((h) => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {byClient.map((row) => (
                      <tr key={row.clientName} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 font-medium text-gray-900">{row.clientName}</td>
                        <td className="px-4 py-2.5 text-gray-700 font-mono">{fmt$(row.totalCost)}</td>
                        <td className="px-4 py-2.5 text-gray-700">{row.totalRecords.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-gray-700">{row.jobCount}</td>
                        <td className="px-4 py-2.5 text-gray-700">{row.callCount.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* By Job */}
          {byJob.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-gray-700 mb-3">By Job (last 50)</h3>
              <div className="rounded-lg border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {["Client", "List", "Est. Cost", "Records", "Credits", "Last Activity"].map((h) => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {byJob.map((row) => (
                      <tr key={row.jobId} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 font-medium text-gray-900">{row.clientName}</td>
                        <td className="px-4 py-2.5 text-gray-600 max-w-[180px] truncate" title={row.listName}>{row.listName}</td>
                        <td className="px-4 py-2.5 text-gray-700 font-mono">{fmt$(row.totalCost)}</td>
                        <td className="px-4 py-2.5 text-gray-700">{row.totalRecords.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-gray-700">{row.apolloCredits}</td>
                        <td className="px-4 py-2.5 text-gray-400 text-xs">{fmtDate(row.lastCall)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Cache Performance */}
          <section>
            <h3 className="text-sm font-medium text-gray-700 mb-3">Domain Cache Performance</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Cache Hits",    value: cachePerformance.hits.toLocaleString(),   sub: "website summaries served from cache" },
                { label: "Cache Misses",  value: cachePerformance.misses.toLocaleString(), sub: "new API calls made" },
                { label: "Hit Rate",      value: `${cachePerformance.hitRate}%`,            sub: "of website summary requests" },
                { label: "Cost Saved",    value: fmt$(cachePerformance.savedCost),          sub: "via cache (est.)" },
              ].map((stat) => (
                <div key={stat.label} className="rounded-lg border border-gray-200 bg-white p-4">
                  <p className="text-xs text-gray-500">{stat.label}</p>
                  <p className="text-xl font-semibold text-gray-900 mt-1">{stat.value}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{stat.sub}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Overall totals footer */}
          <div className="rounded-lg bg-gray-50 border border-gray-200 px-5 py-4 flex gap-8 flex-wrap text-sm">
            <div>
              <span className="text-gray-500">All-time cost: </span>
              <span className="font-semibold text-gray-900">{fmt$(overall.totalCost)}</span>
            </div>
            <div>
              <span className="text-gray-500">All-time records: </span>
              <span className="font-semibold text-gray-900">{overall.totalRecords.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-gray-500">All-time Apollo credits: </span>
              <span className="font-semibold text-gray-900">{overall.apolloCredits.toLocaleString()}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
