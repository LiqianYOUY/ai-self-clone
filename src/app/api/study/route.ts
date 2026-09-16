import {
  getEvaluations,
  getEvaluationOverview,
  approveExcerptSharing,
  submitMatched,
} from "@/server/evaluation";
import {
  getDevelopment,
  saveCalibration,
  beginPractice,
  finishPractice,
  previewPersona,
} from "@/server/onboarding";
import { requireActor, assertMutationRequest } from "@/server/auth";
import { ApiError, query, execute } from "@/server/engine";
import { GatewayError, jsonResponse, readJson } from "@/server/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const labels: Record<string, string> = {
  AUTHENTICATION_REQUIRED: "登录已失效，请重新进入。",
  FORBIDDEN: "你没有访问此内容的权限。",
  UNAUTHORIZED: "登录已失效，请重新进入。",
  NOT_FOUND: "记录不存在或已撤回。",
  INVALID_STATE: "当前研究状态不允许这项操作。",
  CONSENT_REQUIRED: "请先完成所需的独立知情同意。",
  FROZEN: "这个版本已冻结，无法直接修改。",
  VALIDATION_ERROR: "请检查输入内容和量表范围。",
  LIVE_BLOCKED: "正式研究尚未满足启动条件。",
  PRIVACY_REVIEW_REQUIRED: "内容需要隐私审查，请处理标记项后重试。",
  INVALID_INPUT: "请检查输入内容和量表范围。",
  LOCKED: "这条记录已锁定，无法重复提交。",
  TIMEPOINT_CLOSED: "当前阶段不开放这个测量时间点；你可以跳过或请求解释。",
  PARTITION_LEAKAGE: "检测到与其他分区近重复的内容，请保持独立留出。",
  SESSION_NOT_ACTIVE: "会话已经暂停或结束，消息未发送。",
  EDIT_REQUIRED: "内容可能包含敏感信息或超出研究范围，请编辑后重试。",
  INELIGIBLE: "任务当前不可用，分享许可或研究状态可能已改变。",
  PERSONA_REQUIRED: "需要有效的冻结版本。",
  SAFETY_OPEN: "安全事件需要先完成处置。",
  TRY_AGAIN_LATER: "操作过于频繁，请稍后再试。",
  REQUEST_REJECTED: "操作未完成，请检查输入、权限及研究状态。",
};
const safeError = (error: unknown) => {
  const controlled = error instanceof ApiError || error instanceof GatewayError;
  const code =
    controlled && Object.hasOwn(labels, error.code)
      ? error.code
      : "REQUEST_REJECTED";
  return jsonResponse(
    { error: labels[code], code },
    controlled ? error.status : 500,
  );
};
function requireSyntheticParticipant(actor: { id: string; role: string }): void {
  // Real participant enrollment must never enter or mutate the demonstration study.
  // Staff can inspect the explicitly marked research sandbox with their staff account.
  if (["TARGET", "FRIEND"].includes(actor.role) && !actor.id.startsWith("demo-"))
    throw new GatewayError(403, "FORBIDDEN");
}
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    requireSyntheticParticipant(actor);
    const url = new URL(request.url);
    return jsonResponse(
      url.searchParams.get("view") === "evaluations"
        ? await (["RESEARCHER", "ANALYST"].includes(actor.role)
            ? getEvaluationOverview(actor)
            : getEvaluations(actor))
        : url.searchParams.get("view") === "development"
          ? await getDevelopment(actor)
          : await query(
              actor,
              url.searchParams.get("view") || "dashboard",
              url.searchParams.get("id") || undefined,
            ),
    );
  } catch (error) {
    return safeError(error);
  }
}
export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    const actor = await requireActor(request);
    requireSyntheticParticipant(actor);
    const body = await readJson(request, 100_000);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new GatewayError(400, "REQUEST_REJECTED");
    const data = body as Record<string, unknown>;
    if (
      Object.keys(data).some((key) => !["action", "payload"].includes(key)) ||
      typeof data.action !== "string"
    )
      throw new GatewayError(400, "REQUEST_REJECTED");
    const payload = data.payload ?? {};
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      ["actor", "actorId", "role"].some((key) => Object.hasOwn(payload, key))
    )
      throw new GatewayError(400, "REQUEST_REJECTED");
    const extra: Record<
      string,
      (a: typeof actor, p: Record<string, unknown>) => Promise<unknown>
    > = {
      saveCalibration,
      beginPractice,
      finishPractice,
      previewPersona,
      approveExcerptSharing,
      submitMatched,
    };
    return jsonResponse(
      Object.hasOwn(extra, data.action)
        ? await extra[data.action](actor, payload as Record<string, unknown>)
        : await execute(actor, data.action, payload as Record<string, unknown>),
    );
  } catch (error) {
    return safeError(error);
  }
}
