import { getActor, loginDemo, logout, ROLES } from "@/server/auth";
import {
  assertMutationRequest,
  enforceRateLimit,
  gatewayErrorResponse,
  GatewayError,
  jsonResponse,
  readJson,
  requestRateKey,
} from "@/server/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    enforceRateLimit(`auth-read:${requestRateKey(request)}`, 120);
    return jsonResponse({
      actor: await getActor(request),
      synthetic: process.env.STUDY_MODE === "synthetic",
    });
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    const body = await readJson(request, 2048);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new GatewayError(400, "REQUEST_REJECTED");
    const data = body as Record<string, unknown>;
    if (
      Object.keys(data).some(
        (key) => !["role", "participantId"].includes(key),
      ) ||
      typeof data.role !== "string" ||
      !ROLES.includes(data.role as (typeof ROLES)[number]) ||
      (data.participantId !== undefined &&
        typeof data.participantId !== "string")
    )
      throw new GatewayError(400, "REQUEST_REJECTED");
    return await loginDemo(
      request,
      data.role,
      data.participantId as string | undefined,
    );
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
export async function DELETE(request: Request) {
  try {
    return await logout(request);
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
