import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

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

function buildFinalFilename(job: any): string {
  const clientSlug = job.clientName.replace(/\s+/g, "");
  const listSlug = job.listName.replace(/\s+/g, "");
  const d = new Date(job.createdAt);
  const m = d.getMonth() + 1;
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${clientSlug}_${listSlug}_${m}_${dd}_${yy}.csv`;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const job = findJobById(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const filename = buildFinalFilename(job);
  const filePath = path.join(PIPELINE_ROOT, "data", "final", filename);

  if (!fs.existsSync(filePath)) {
    return NextResponse.json(
      { error: "Output file not found — pipeline may still be running" },
      { status: 404 }
    );
  }

  const content = fs.readFileSync(filePath);

  return new NextResponse(content, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
