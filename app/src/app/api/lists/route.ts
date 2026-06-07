import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

const RAILWAY_URL  = process.env.RAILWAY_URL?.replace(/\/$/, "");
const LISTS_PATH   = path.resolve(process.cwd(), "../config/pulled-lists.json");

export async function GET() {
  if (RAILWAY_URL) {
    try {
      const upstream = await fetch(`${RAILWAY_URL}/api/lists`, { signal: AbortSignal.timeout(15000) });
      return NextResponse.json(await upstream.json(), { status: upstream.status });
    } catch {
      return NextResponse.json({ error: "Railway unreachable" }, { status: 502 });
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
