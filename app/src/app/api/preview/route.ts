import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const APOLLO_ENDPOINT = "https://api.apollo.io/v1/mixed_people/api_search";

// ---------------------------------------------------------------------------
// Apollo filter translation (mirrors scripts/apollo/apollo-pull.js)
// ---------------------------------------------------------------------------


// Real Apollo industry MongoDB ObjectIDs — discovered via organizations/search API
const APOLLO_INDUSTRY_IDS: Record<string, string> = {
  "accounting":                           "5567ce1f7369643b78570000",
  "airlines/aviation":                    "5567e0bf7369641d115f0200",
  "animation":                            "5567e36f73696431a4970000",
  "apparel & fashion":                    "5567cd82736964540d0b0000",
  "architecture & planning":              "5567cdb77369645401080000",
  "arts & crafts":                        "5567cd4d73696439d9030000",
  "automotive":                           "5567cdf27369644cfd800000",
  "aviation & aerospace":                 "5567e0dd73696416d3c20100",
  "banking":                              "5567ce237369644ee5490000",
  "biotechnology":                        "5567d08e7369645dbc4b0000",
  "broadcast media":                      "5567e0f973696416d34e0200",
  "building materials":                   "5567e1a17369641ea9d30100",
  "business supplies & equipment":        "5567e0fa73696410e4c51200",
  "capital markets":                      "5567cdb773696439a9080000",
  "chemicals":                            "5567e21e73696426a1030000",
  "civic & social organization":          "5567cdda7369644eed130000",
  "civil engineering":                    "5567e13a73696418756e0200",
  "commercial real estate":               "5567e1887369641d68d40100",
  "computer & network security":          "5567cd877369644cf94b0000",
  "computer games":                       "5567cd8b736964540d0f0000",
  "computer hardware":                    "5567e0d47369641233eb0600",
  "computer networking":                  "5567cdbe7369643b78360000",
  "computer software":                    "5567cd4e7369643b70010000",
  "construction":                         "5567cd4773696439dd350000",
  "consumer electronics":                 "5567e1947369641ead570000",
  "consumer goods":                       "5567ce987369643b789e0000",
  "consumer services":                    "5567d1127261697f2b1d0000",
  "cosmetics":                            "5567e1ae73696423dc040000",
  "defense & space":                      "5567e1097369641b5f810500",
  "design":                               "5567cdbc73696439d90b0000",
  "e-learning":                           "5567e19c7369641c48e70100",
  "education management":                 "5567ce9e736964540d540000",
  "electrical & electronic manufacturing":"5567cd4c73696439c9030000",
  "entertainment":                        "5567cdd37369643b80510000",
  "environmental services":               "5567ce5b736964540d280000",
  "events services":                      "5567cd8e7369645409450000",
  "facilities services":                  "5567ce9c7369643bc9980000",
  "farming":                              "5567cd4f7369644d2d010000",
  "financial services":                   "5567cdd67369643e64020000",
  "fine art":                             "5567e2097369642420150000",
  "fishery":                              "5567f96c7369642a22080000",
  "food & beverages":                     "5567ce1e7369643b806a0000",
  "food production":                      "5567e1b3736964208b280000",
  "fund-raising":                         "5567d2ad7261697f2b1f0100",
  "fundraising":                          "5567d2ad7261697f2b1f0100",
  "furniture":                            "5567cede73696440d0040000",
  "gambling & casinos":                   "5567e0cf7369641233e50600",
  "glass, ceramics & concrete":           "5567cd4f736964397e030000",
  "government administration":            "5567cd527369643981050000",
  "government relations":                 "5567e29b736964256c370100",
  "graphic design":                       "5567cd4d73696439d9040000",
  "health, wellness & fitness":           "5567cddb7369644d250c0000",
  "higher education":                     "5567cd4c73696453e1300000",
  "hospital & health care":               "5567cdde73696439812c0000",
  "hospitality":                          "5567ce9d7369643bc19c0000",
  "human resources":                      "5567e0e37369640e5ac10c00",
  "industrial automation":                "5567e1337369641ad2970000",
  "information services":                 "5567e0c97369640d2b3b1600",
  "information technology & services":    "5567cd4773696439b10b0000",
  "insurance":                            "5567cdd973696453d93f0000",
  "international affairs":                "5567e3657369642f4ec90000",
  "international trade & development":    "5567ce9c7369644eed680000",
  "internet":                             "5567cd4d736964397e020000",
  "investment banking":                   "5567e1ab7369641f6d660100",
  "investment management":                "5567e0bc7369641d11550200",
  "law enforcement":                      "5567e0e073696408da441e00",
  "law practice":                         "5567ce1f7369644d391c0000",
  "legal services":                       "5567ce2d7369644d25250000",
  "leisure, travel & tourism":            "5567cdd87369643bc12f0000",
  "logistics & supply chain":             "5567cd4973696439b9010000",
  "luxury goods & jewelry":               "5567cda97369644cfd3e0000",
  "machinery":                            "5567cd4973696439d53c0000",
  "management consulting":                "5567cdd47369643dbf260000",
  "maritime":                             "5567cd8273696439b1240000",
  "market research":                      "5567e1387369641ec75d0200",
  "marketing & advertising":              "5567cd467369644d39040000",
  "mechanical or industrial engineering": "5567ce2673696453d95c0000",
  "media production":                     "5567e0ea7369640d2ba31600",
  "medical device":                       "5567e1b97369641ea9690200",
  "medical practice":                     "5567d0467369645dbc200000",
  "mental health care":                   "5567ce2773696454308f0000",
  "military":                             "5567e2c572616932bb3b0000",
  "mining & metals":                      "5567e3f3736964395d7a0000",
  "mobile games":                         "5567cd8b736964540d0f0000",
  "motion pictures & film":               "5567cdd7736964540d130000",
  "museums & institutions":               "5567e15373696422aa0a0000",
  "music":                                "5567cd4f736964540d050000",
  "nanotechnology":                       "5567e7be736964110e210000",
  "newspapers":                           "5567cd4a73696439a9010000",
  "non-profit organization management":   "5567cd4773696454303a0000",
  "oil & energy":                         "5567cdd97369645624020000",
  "online media":                         "5567cdb373696439dd540000",
  "outsourcing/offshoring":               "5567d04173696457ee520000",
  "package/freight delivery":             "5567e8bb7369641a658f0000",
  "packaging & containers":               "5567e36973696431a4480000",
  "paper & forest products":              "5567e97f7369641e57730100",
  "performing arts":                      "5567e0af7369641ec7300000",
  "pharmaceuticals":                      "5567e0eb73696410e4bd1200",
  "philanthropy":                         "5567ce9673696453d99f0000",
  "photography":                          "5567cd4f7369644cfd250000",
  "plastics":                             "5567cdda7369644cf95d0000",
  "political organization":               "5567e25f736964256cff0000",
  "primary/secondary education":          "5567cdd97369645430680000",
  "printing":                             "5567cd4d7369644d513e0000",
  "professional training & coaching":     "5567cd49736964541d010000",
  "public policy":                        "5567e28a7369642ae2500000",
  "public relations & communications":    "5567ce5973696453d9780000",
  "public safety":                        "5567cd4a7369643ba9010000",
  "publishing":                           "5567ce5b73696439a17a0000",
  "railroad manufacture":                 "5567e14673696416d38c0300",
  "ranching":                             "5567fd5a73696442b0f20000",
  "real estate":                          "5567cd477369645401010000",
  "recreational facilities & services":   "5567e134736964214f5e0000",
  "religious institutions":               "5567e0f27369640e5aed0c00",
  "renewables & environment":             "5567cd49736964540d020000",
  "research":                             "5567e09f736964160ebb0100",
  "restaurants":                          "5567e0e0736964198de70700",
  "retail":                               "5567ced173696450cb580000",
  "security & investigations":            "5567e19b7369641ead740000",
  "semiconductors":                       "5567e0d87369640e5aa30c00",
  "shipbuilding":                         "5568047d7369646d406c0000",
  "sporting goods":                       "5567e113736964198d5e0800",
  "sports":                               "5567ce227369644eed290000",
  "staffing & recruiting":                "5567e09973696410db020800",
  "supermarkets":                         "5567e2a97369642a553d0000",
  "telecommunications":                   "5567cd4c7369644d39080000",
  "textiles":                             "5567e1327369641d91ce0300",
  "think tanks":                          "5567e1de7369642069ea0100",
  "tobacco":                              "55680085736964551e070000",
  "translation & localization":           "5567e1097369641d91230300",
  "transportation/trucking/railroad":     "5567cd4e7369644cf93b0000",
  "utilities":                            "5567e2127369642420170000",
  "venture capital & private equity":     "5567e1587369641c48370000",
  "veterinary":                           "5567ce9673696439d5c10000",
  "warehousing":                          "5567e127736964181e700200",
  "wholesale":                            "5567d01e73696457ee100000",
  "wine & spirits":                       "5567cd4d7369643b78100000",
  "wireless":                             "5567e3ca736964371b130000",
  "writing & editing":                    "5567cdd973696439a1370000",
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

  // Industry exclusions — hex IDs where known, keyword fallback for unmapped
  const excludeIndustryIds: string[] = [];
  const unmappedExcludes: string[] = [...((icp.companyKeywordsExclude as string[]) ?? [])];
  for (const ind of ((icp.industriesExclude as string[]) ?? [])) {
    const id = APOLLO_INDUSTRY_IDS[ind.toLowerCase()];
    if (id) {
      if (!excludeIndustryIds.includes(id)) excludeIndustryIds.push(id);
    } else {
      unmappedExcludes.push(ind);
    }
  }
  if (excludeIndustryIds.length) params.not_organization_industry_tag_ids = excludeIndustryIds;
  if (unmappedExcludes.length)   params.q_not_organization_keyword_tags   = unmappedExcludes;

  if (icp.headcount?.min != null || icp.headcount?.max != null) {
    const lo = icp.headcount.min != null ? icp.headcount.min : "";
    const hi = icp.headcount.max != null ? icp.headcount.max : "";
    params.organization_num_employees_ranges = [`${lo},${hi}`];
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
