import { prisma } from "@/server/db";
import { enforceRateLimit, jsonResponse } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Readiness only: never expose participant counts, versions or source details. */
export async function GET() {
  try {
    enforceRateLimit("health-readiness", 120);
    await prisma.$queryRaw`SELECT 1`;
    return jsonResponse({ status: "ok" });
  } catch {
    return jsonResponse({ status: "unavailable" }, 503);
  }
}
