import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

const PIPELINE_ROOT = path.resolve(process.cwd(), "..");

function findJobById(jobId: string) {
  for (const dir of ["completed", "failed", "processing", "queued"]) {
    const jobPath = path.join(PIPELINE_ROOT, "jobs", dir, `${jobId}.json`);
    if (fs.existsSync(jobPath)) {
      return JSON.parse(fs.readFileSync(jobPath, "utf8"));
    }
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const RAILWAY_URL = process.env.RAILWAY_URL?.replace(/\/$/, "");
  console.log("[download route] id:", id, "RAILWAY_URL:", RAILWAY_URL ?? "(not set)");

  if (RAILWAY_URL) {
    const forwardUrl = `${RAILWAY_URL}/api/orders/${id}/download`;
    console.log("[download route] forwarding to:", forwardUrl);
    try {
      // redirect:'follow' so fetch follows Railway's 302→Drive redirect automatically
      const upstream = await fetch(forwardUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });

      if (!upstream.ok) {
        const error = await upstream.json().catch(() => ({ error: "Download failed" }));
        return NextResponse.json(error, { status: upstream.status });
      }

      const contentType        = upstream.headers.get("content-type")        ?? "text/csv";
      const contentDisposition = upstream.headers.get("content-disposition") ?? `attachment; filename="${id}.csv"`;
      const body = await upstream.arrayBuffer();

      return new NextResponse(body, {
        status: 200,
        headers: { "Content-Type": contentType, "Content-Disposition": contentDisposition },
      });
    } catch (err: any) {
      console.error("[download route] Railway forward failed:", err?.message);
      return NextResponse.json({ error: "Railway unreachable", detail: err?.message }, { status: 502 });
    }
  }

  // Local fallback (dev / no Railway)
  const job = findJobById(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (job.driveUrl) {
    return NextResponse.redirect(job.driveUrl, 302);
  }

  const base  = job.outputFilename as string;
  const tries = [
    path.join(PIPELINE_ROOT, "data", "final",    base.replace("_raw_", "_final_")),
    path.join(PIPELINE_ROOT, "data", "enriched", base.replace("_raw_", "_enriched_")),
    path.join(PIPELINE_ROOT, "data", "cleaned",  base.replace("_raw_", "_cleaned_")),
    path.join(PIPELINE_ROOT, "data", "raw",      base),
  ];

  const filePath = tries.find((p) => fs.existsSync(p));
  if (!filePath) {
    return NextResponse.json(
      { error: "Output file not found — pipeline may still be running" },
      { status: 404 }
    );
  }

  const filename = path.basename(filePath);
  const content  = fs.readFileSync(filePath);

  return new NextResponse(content, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
