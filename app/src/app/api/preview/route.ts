import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const APOLLO_ENDPOINT = "https://api.apollo.io/v1/mixed_people/api_search";

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

function translateFilters(icp: any): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  if (icp.titles?.length)    params.person_titles    = icp.titles;
  if (icp.location?.length)  params.person_locations = icp.location;

  // Keywords and industries both go into keyword tags
  const keywords = [
    ...((icp.companyKeywords as string[]) ?? []),
    ...((icp.industries     as string[]) ?? []),
  ];
  if (keywords.length) params.q_organization_keyword_tags = keywords;

  if (icp.headcount?.min != null || icp.headcount?.max != null) {
    const ranges = headcountToRanges(icp.headcount.min, icp.headcount.max);
    if (ranges.length) params.organization_num_employees_ranges = ranges;
  }

  return params;
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

  const { icp } = body;
  if (!icp) {
    return NextResponse.json({ error: "icp is required" }, { status: 400 });
  }

  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { count: null, source: "Apollo", error: "Unable to preview — check API credentials" },
      { status: 200 }
    );
  }

  const filters = translateFilters(icp);

  try {
    const res = await fetch(APOLLO_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({ page: 1, per_page: 1, ...filters }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 401 || res.status === 403) {
      return NextResponse.json(
        { count: null, source: "Apollo", error: "Unable to preview — check API credentials" },
        { status: 200 }
      );
    }
    if (!res.ok) {
      return NextResponse.json(
        { count: null, source: "Apollo", error: "Preview unavailable — you can still place your order" },
        { status: 200 }
      );
    }

    const data = await res.json();
    // api_search returns total_entries at the top level (no pagination wrapper)
    const count: number = data.total_entries ?? data.pagination?.total_entries ?? 0;

    return NextResponse.json({ count, source: "Apollo" });
  } catch {
    return NextResponse.json(
      { count: null, source: "Apollo", error: "Preview unavailable — you can still place your order" },
      { status: 200 }
    );
  }
}
