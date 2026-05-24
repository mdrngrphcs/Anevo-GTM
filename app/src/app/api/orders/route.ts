import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import cp from "child_process";

export const runtime = "nodejs";

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

function buildJobId(clientName: string, listName: string, ts: number): string {
  const clientSlug = clientName.trim().toLowerCase().replace(/\s+/g, "_");
  const listSlug = listName.trim().toLowerCase().replace(/\s+/g, "_");
  return `${clientSlug}_${listSlug}_${ts}`;
}

function buildOutputFilename(clientName: string, source: string, date: Date): string {
  const slug = clientName.trim().toLowerCase().replace(/\s+/g, "_");
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = String(date.getFullYear()).slice(-2);
  return `${slug}_${source}_raw_${m}_${d}_${y}.csv`;
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

  const { clientName, listName, source, icp, enrichments, outputDestination, recordLimit } = body;

  if (!clientName?.trim() || !listName?.trim()) {
    return NextResponse.json({ error: "clientName and listName are required" }, { status: 400 });
  }

  const validSources = ["aiark", "apollo", "both"];
  if (!validSources.includes(source)) {
    return NextResponse.json({ error: `source must be one of: ${validSources.join(", ")}` }, { status: 400 });
  }

  const sources: string[] = source === "both" ? ["aiark", "apollo"] : [source];
  const jobIds: string[] = [];

  for (const src of sources) {
    const now = new Date();
    const ts = now.getTime();
    const jobId = buildJobId(clientName, listName + (source === "both" ? `_${src}` : ""), ts);
    const outputFilename = buildOutputFilename(clientName, src, now);

    const job = {
      jobId,
      createdAt: now.toISOString(),
      status: "queued",
      clientName: clientName.trim(),
      listName: (listName + (source === "both" ? `_${src}` : "")).trim(),
      source: src,
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

    jobIds.push(jobId);
  }

  return NextResponse.json(
    { jobId: jobIds.length === 1 ? jobIds[0] : jobIds, message: "Pipeline started" },
    { status: 201 }
  );
}
