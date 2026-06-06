import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const APOLLO_ENDPOINT = "https://api.apollo.io/v1/mixed_people/api_search";
const AIARK_ENDPOINT  = "https://api.ai-ark.com/api/developer-portal/v1/people";

// ---------------------------------------------------------------------------
// Apollo filter translation (mirrors scripts/apollo/apollo-pull.js)
// ---------------------------------------------------------------------------

const HEADCOUNT_BUCKETS: [number, number][] = [
  [1, 10], [11, 20], [21, 50], [51, 100], [101, 200],
  [201, 500], [501, 1000], [1001, 2000], [2001, 5000],
  [5001, 10000], [10001, 20000], [20001, 50000],
];

function headcountToRanges(min: number | null, max: number | null): string[] {
  const lo = min ?? 0;
  const hi = max ?? Infinity;
  return HEADCOUNT_BUCKETS
    .filter(([bLo, bHi]) => bHi >= lo && bLo <= hi)
    .map(([bLo, bHi]) => `${bLo},${bHi}`);
}

function translateApolloFilters(icp: any): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (icp.titles?.length)          params.person_titles = icp.titles;
  if (icp.location?.length)        params.person_locations = icp.location;
  if (icp.companyKeywords?.length) params.q_organization_keyword_tags = icp.companyKeywords;
  if (icp.industries?.length) {
    params.q_organization_keyword_tags = [
      ...((params.q_organization_keyword_tags as string[]) ?? []),
      ...icp.industries,
    ];
  }
  if (icp.headcount?.min != null || icp.headcount?.max != null) {
    const ranges = headcountToRanges(icp.headcount.min, icp.headcount.max);
    if (ranges.length) params.organization_num_employees_ranges = ranges;
  }
  return params;
}

// ---------------------------------------------------------------------------
// AI Ark filter translation (mirrors scripts/aiark/aiark-pull.js)
// ---------------------------------------------------------------------------

function translateAiarkFilters(icp: any): { account: Record<string, unknown>; contact: Record<string, unknown> } {
  const account: Record<string, unknown> = {};
  const contact: Record<string, unknown> = {};

  if (icp.titles?.length) {
    contact.experience = {
      latest: { title: { any: { include: { mode: "SMART", content: icp.titles } } } },
    };
  }
  if (icp.location?.length) {
    contact.location = { any: { include: icp.location } };
  }
  if (icp.industries?.length) {
    account.industries = { any: { include: { mode: "SMART", content: icp.industries } } };
  }
  if (icp.companyKeywords?.length) {
    account.keyword = {
      any: { include: { sources: [{ mode: "SMART", source: "KEYWORD" }], content: icp.companyKeywords } },
    };
  }
  if (icp.headcount?.min != null || icp.headcount?.max != null) {
    account.employeeSize = {
      type: "RANGE",
      range: [{ start: icp.headcount?.min ?? 0, end: icp.headcount?.max ?? 999999 }],
    };
  }
  if (icp.revenue?.min != null || icp.revenue?.max != null) {
    account.revenue = {
      type: "RANGE",
      range: [{ start: icp.revenue?.min ?? 0, end: icp.revenue?.max ?? 999999999 }],
    };
  }
  if (icp.technologies?.length) {
    account.technology = { any: { include: icp.technologies } };
  }

  return { account, contact };
}

// ---------------------------------------------------------------------------
// Per-source preview functions
// ---------------------------------------------------------------------------

type PreviewResult = { count: number | null; error?: string };

async function previewApollo(icp: any): Promise<PreviewResult> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return { count: null, error: "Unable to preview — check API credentials" };

  try {
    const res = await fetch(APOLLO_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({ page: 1, per_page: 1, ...translateApolloFilters(icp) }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 401 || res.status === 403) {
      return { count: null, error: "Unable to preview — check API credentials" };
    }
    if (!res.ok) {
      return { count: null, error: "Preview unavailable — you can still place order" };
    }

    const data = await res.json();
    const count: number = data.pagination?.total_entries ?? 0;
    if (count === 0) return { count: 0, error: "No matching records found — try broader filters" };
    return { count };
  } catch {
    return { count: null, error: "Preview unavailable — you can still place order" };
  }
}

async function previewAiark(icp: any): Promise<PreviewResult> {
  const apiKey = process.env.AI_ARK_API_KEY;
  if (!apiKey) return { count: null, error: "Unable to preview — check API credentials" };

  const { account, contact } = translateAiarkFilters(icp);

  try {
    const res = await fetch(AIARK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TOKEN": apiKey },
      body: JSON.stringify({ account, contact, page: 0, size: 1 }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await res.json();

    // AI Ark returns 200 even for credit errors — check body first
    if (data.status === 4021000) {
      return { count: null, error: "Preview unavailable — you can still place order" };
    }
    if (res.status === 401 || res.status === 403) {
      return { count: null, error: "Unable to preview — check API credentials" };
    }
    if (!res.ok) {
      return { count: null, error: "Preview unavailable — you can still place order" };
    }

    const count: number = data.totalElements ?? 0;
    if (count === 0) return { count: 0, error: "No matching records found — try broader filters" };
    return { count };
  } catch {
    return { count: null, error: "Preview unavailable — you can still place order" };
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { source, icp } = body;
  if (!source || !icp) {
    return NextResponse.json({ error: "source and icp are required" }, { status: 400 });
  }

  const sources: string[] = source === "both" ? ["apollo", "aiark"] : [source];
  const [apolloResult, aiarkResult] = await Promise.all([
    sources.includes("apollo") ? previewApollo(icp) : Promise.resolve(undefined),
    sources.includes("aiark") ? previewAiark(icp)  : Promise.resolve(undefined),
  ]);

  return NextResponse.json({
    ...(apolloResult !== undefined && { apollo: apolloResult }),
    ...(aiarkResult  !== undefined && { aiark:  aiarkResult  }),
  });
}
