import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

const LISTS_PATH = path.resolve(process.cwd(), "../config/pulled-lists.json");

export async function GET() {
  const RAILWAY_URL = process.env.RAILWAY_URL?.replace(/\/$/, "");
  console.log("[lists GET] RAILWAY_URL:", RAILWAY_URL ?? "(not set)");

  if (RAILWAY_URL) {
    const forwardUrl = `${RAILWAY_URL}/api/lists`;
    console.log("[lists GET] forwarding to:", forwardUrl);
    try {
      const upstream = await fetch(forwardUrl, { signal: AbortSignal.timeout(15000) });
      return NextResponse.json(await upstream.json(), { status: upstream.status });
    } catch (err: any) {
      console.error("[lists GET] Railway forward failed:", err?.message);
      return NextResponse.json({ error: "Railway unreachable", detail: err?.message }, { status: 502 });
    }
  }

  try {
    const lists = fs.existsSync(LISTS_PATH)
      ? JSON.parse(fs.readFileSync(LISTS_PATH, "utf8"))
      : [];
    return NextResponse.json({ lists });
  } catch {
    return NextResponse.json({ lists: [] });
  }
}
