import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import cp from "child_process";

export const runtime = "nodejs";

const RAILWAY_URL   = process.env.RAILWAY_URL?.replace(/\/$/, "");
const PIPELINE_ROOT = path.resolve(process.cwd(), "..");

function spawnPipeline(jobId: string) {
  const nodeExe = process.execPath;
  const scriptAbs = path.resolve(PIPELINE_ROOT, "scripts", "run-from-job.js");
  const child = cp.spawn(nodeExe, [scriptAbs, jobId], {
    cwd: PIPELINE_ROOT,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.on("error", (err) => {
    const logDir = path.join(PIPELINE_ROOT, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, "spawn-errors.log"),
      `[${new Date().toISOString()}] [${jobId}] Spawn error: ${err.message}\n`
    );
  });
  child.unref();
}

// Strip characters that are unsafe in filenames (slashes, brackets, parens, etc.)
function toSlug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, "") // remove anything that isn't alphanumeric, space, _ or -
    .replace(/\s+/g, "_")           // spaces → underscores
    .replace(/_+/g, "_")            // collapse consecutive underscores
    .replace(/^_+|_+$/g, "");       // trim leading/trailing underscores
}

function buildJobId(clientName: string, listName: string, ts: number): string {
  return `${toSlug(clientName)}_${toSlug(listName)}_${ts}`;
}

function buildOutputFilename(clientName: string, source: string, date: Date): string {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = String(date.getFullYear()).slice(-2);
  return `${toSlug(clientName)}_${source}_raw_${m}_${d}_${y}.csv`;
}

function readJobsFromDir(dirName: string) {
  const dir = path.join(PIPELINE_ROOT, "jobs", dirName);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function GET(req: NextRequest) {
  if (RAILWAY_URL) {
    const status = req.nextUrl.searchParams.get("status");
    const url = status ? `${RAILWAY_URL}/api/orders?status=${status}` : `${RAILWAY_URL}/api/orders`;
    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(15000) });
      return NextResponse.json(await upstream.json(), { status: upstream.status });
    } catch {
      return NextResponse.json({ error: "Railway unreachable" }, { status: 502 });
    }
  }

  const status = req.nextUrl.searchParams.get("status");

  let orders: unknown[] = [];

  if (status === "active") {
    orders = [
      ...readJobsFromDir("queued"),
      ...readJobsFromDir("processing"),
    ];
  } else if (status === "completed") {
    orders = [
      ...readJobsFromDir("completed"),
      ...readJobsFromDir("failed"),
    ].sort((a: any, b: any) =>
      (b.endedAt ?? b.createdAt) > (a.endedAt ?? a.createdAt) ? 1 : -1
    );
  } else {
    orders = [
      ...readJobsFromDir("queued"),
      ...readJobsFromDir("processing"),
      ...readJobsFromDir("completed"),
      ...readJobsFromDir("failed"),
    ];
  }

  return NextResponse.json({ orders });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (RAILWAY_URL) {
    try {
      const upstream = await fetch(`${RAILWAY_URL}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      return NextResponse.json(await upstream.json(), { status: upstream.status });
    } catch {
      return NextResponse.json({ error: "Railway unreachable" }, { status: 502 });
    }
  }

  const { clientName, listName, icp, enrichments, outputDestination, recordLimit } = body;

  if (!clientName?.trim() || !listName?.trim()) {
    return NextResponse.json({ error: "clientName and listName are required" }, { status: 400 });
  }

  const now = new Date();
  const ts = now.getTime();
  const jobId = buildJobId(clientName, listName, ts);
  const outputFilename = buildOutputFilename(clientName, "apollo", now);

  const job = {
    jobId,
    createdAt: now.toISOString(),
    status: "queued",
    clientName: clientName.trim(),
    listName: listName.trim(),
    source: "apollo",
    icp: {
      titles: icp?.titles ?? [],
      industries: icp?.industries ?? [],
      industriesExclude: icp?.industriesExclude ?? [],
      companyKeywords: icp?.companyKeywords ?? [],
      companyKeywordsExclude: icp?.companyKeywordsExclude ?? [],
      headcount: {
        min: icp?.headcount?.min ?? null,
        max: icp?.headcount?.max ?? null,
      },
      location: icp?.location ?? [],
      revenue: {
        min: icp?.revenue?.min ?? null,
        max: icp?.revenue?.max ?? null,
      },
      technologies: icp?.technologies ?? [],
      additionalCriteria: icp?.additionalCriteria ?? "",
    },
    enrichments: {
      websiteSummary: enrichments?.websiteSummary ?? false,
      icpClassification: enrichments?.icpClassification ?? false,
      icpClassificationContext: enrichments?.icpClassificationContext ?? "",
      businessLabeling: enrichments?.businessLabeling ?? false,
      businessTypeLabelTemplate: enrichments?.businessTypeLabelTemplate ?? "",
      decisionMakerDiscovery: enrichments?.decisionMakerDiscovery ?? false,
      decisionMakerContext: enrichments?.decisionMakerContext ?? "",
    },
    recordLimit: typeof recordLimit === "number" && recordLimit > 0 ? recordLimit : null,
    outputDestination: outputDestination ?? "data/final",
    outputFilename,
  };

  const queuedDir = path.join(PIPELINE_ROOT, "jobs", "queued");
  fs.mkdirSync(queuedDir, { recursive: true });
  fs.writeFileSync(path.join(queuedDir, `${jobId}.json`), JSON.stringify(job, null, 2));

  spawnPipeline(jobId);

  return NextResponse.json({ jobId, message: "Pipeline started" }, { status: 201 });
}
