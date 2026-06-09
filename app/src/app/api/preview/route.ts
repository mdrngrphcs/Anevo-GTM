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

// Real Apollo industry MongoDB ObjectIDs — discovered via bulk_match enrichment
const APOLLO_INDUSTRY_IDS: Record<string, string> = {
  "information technology & services":  "5567cd4773696439b10b0000",
  "computer software":                  "5567cd4773696439b10b0000",
  "internet":                           "5567cd4d736964397e020000",
  "marketing & advertising":            "5567cd467369644d39040000",
  "public relations & communications":  "5567ce5973696453d9780000",
  "financial services":                 "5567cdd67369643e64020000",
  "investment management":              "5567e0bc7369641d11550200",
  "capital markets":                    "5567cdb773696439a9080000",
  "insurance":                          "5567cdd973696453d93f0000",
  "accounting":                         "5567ce1f7369643b78570000",
  "real estate":                        "5567cd477369645401010000",
  "commercial real estate":             "5567e1887369641d68d40100",
  "construction":                       "5567cd4773696439dd350000",
  "architecture & planning":            "5567cdb77369645401080000",
  "biotechnology":                      "5567d08e7369645dbc4b0000",
  "pharmaceuticals":                    "5567e0eb73696410e4bd1200",
  "research":                           "5567e09f736964160ebb0100",
  "staffing & recruiting":              "5567e09973696410db020800",
  "human resources":                    "5567e0e37369640e5ac10c00",
  "management consulting":              "5567cdd47369643dbf260000",
  "oil & energy":                       "5567cdd97369645624020000",
  "retail":                             "5567ced173696450cb580000",
  "hospitality":                        "5567ce9d7369643bc19c0000",
  "leisure, travel & tourism":          "5567cdd87369643bc12f0000",
  "higher education":                   "5567cd4c73696453e1300000",
};

function translateFilters(icp: any): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  if (icp.titles?.length)   params.person_titles    = icp.titles;
  if (icp.location?.length) params.person_locations = icp.location;

  // Map known industry names to Apollo hex IDs; unknown ones fall back to keyword tags
  const industryIds: string[] = [];
  const unmappedIndustries: string[] = [];
  for (const ind of ((icp.industries as string[]) ?? [])) {
    const id = APOLLO_INDUSTRY_IDS[ind.toLowerCase()];
    if (id) {
      if (!industryIds.includes(id)) industryIds.push(id);
    } else {
      unmappedIndustries.push(ind);
    }
  }
  if (industryIds.length) params.organization_industry_tag_ids = industryIds;

  const keywords = [
    ...((icp.companyKeywords as string[]) ?? []),
    ...unmappedIndustries,
  ];
  if (keywords.length) params.q_organization_keyword_tags = keywords;

  if ((icp.companyKeywordsExclude as string[] | undefined)?.length) {
    params.q_not_organization_keyword_tags = icp.companyKeywordsExclude;
  }

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
  const RAILWAY_URL = process.env.RAILWAY_URL?.replace(/\/$/, "");
  console.log("[preview POST] RAILWAY_URL:", RAILWAY_URL ?? "(not set)");

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (RAILWAY_URL) {
    const forwardUrl = `${RAILWAY_URL}/api/preview`;
    console.log("[preview POST] forwarding to:", forwardUrl);
    try {
      const upstream = await fetch(forwardUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      return NextResponse.json(await upstream.json(), { status: upstream.status });
    } catch (err: any) {
      console.error("[preview POST] Railway forward failed:", err?.message);
      return NextResponse.json(
        { count: null, source: "Apollo", error: "Preview unavailable — you can still place your order" },
        { status: 200 }
      );
    }
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
