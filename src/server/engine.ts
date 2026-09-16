import { randomUUID, createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { STUDY_ID, hashText } from "./seed";
import { Actor, SessionStatus } from "../domain/types";
import { canTransition } from "../domain/state-machine";
import {
  inspectText,
  SOURCE_QUERY_NOTICE,
  BOUNDARY_NOTICE,
} from "../domain/safety";
import { scanPII, nearDuplicate } from "../domain/privacy";
import { csvCell } from "../domain/instruments";
import { generateReply } from "../domain/provider";

type Tx = Prisma.TransactionClient;
type Payload = Record<string, any>;
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function demand(
  ok: unknown,
  message = "无权访问此研究数据。",
  status = 403,
  code = "FORBIDDEN",
): asserts ok {
  if (!ok) throw new ApiError(status, code, message);
}
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value));
const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;
async function audit(
  tx: Tx,
  actor: Actor | null,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: unknown = {},
) {
  await tx.auditEvent.create({
    data: {
      actorId: actor?.id,
      action,
      entityType,
      entityId,
      metadata: json(metadata),
    },
  });
}
async function validateActor(actor: Actor) {
  const p = await prisma.participant.findUnique({
    where: { id: actor?.id },
    include: { account: { select: { id: true } } },
  });
  demand(p?.active && p.role === actor.role);
  demand(
    ["RESEARCHER", "ANALYST"].includes(p.role) ||
      (p.id.startsWith("demo-") && !p.account),
    "真实参与者请使用独立的 Target 或 Friend 入口。",
  );
  return p;
}
const syntheticParticipant = {
  id: { startsWith: "demo-" },
  account: { is: null },
} satisfies Prisma.ParticipantWhereInput;
const syntheticAudit = {
  NOT: { action: { startsWith: "PORTAL_" } },
} satisfies Prisma.AuditEventWhereInput;
function staff(actor: Actor) {
  demand(actor.role === "RESEARCHER");
}
const includeSession = {
  dyad: { include: { target: true, friend: true } },
  messages: {
    where: { status: "DELIVERED" },
    orderBy: { sequence: "asc" as const },
  },
};
async function sessionFor(tx: Tx, actor: Actor, id: string, lock = false) {
  if (lock)
    await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${id} FOR UPDATE`;
  const s = await tx.session.findUnique({
    where: { id },
    include: includeSession,
  });
  demand(s, "找不到此会话。", 404, "NOT_FOUND");
  demand(
    actor.role === "RESEARCHER" ||
      (actor.role === "FRIEND" && s.dyad.friendId === actor.id) ||
      (actor.role === "TARGET" &&
        s.dyad.targetId === actor.id &&
        s.privateCondition === "HUMAN"),
  );
  return s;
}
async function latestConsent(tx: Tx, id: string) {
  return tx.consent.findFirst({
    where: { participantId: id },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
  });
}
async function validConsents(
  tx: Tx,
  s: { dyad: { targetId: string; friendId: string } },
) {
  const [t, f] = await Promise.all([
    latestConsent(tx, s.dyad.targetId),
    latestConsent(tx, s.dyad.friendId),
  ]);
  return Boolean(
    t?.participation &&
    t.aiProcessing &&
    !t.revokedAt &&
    f?.participation &&
    f.aiProcessing &&
    !f.revokedAt,
  );
}
async function append(
  tx: Tx,
  s: { id: string; epoch: number },
  role: string,
  text: string,
  extra: Record<string, any> = {},
) {
  const updated = await tx.session.update({
    where: { id: s.id },
    data: { nextSequence: { increment: 1 } },
  });
  return tx.message.create({
    data: {
      sessionId: s.id,
      sequence: updated.nextSequence - 1,
      epoch: s.epoch,
      publicRole: role,
      text,
      deliveredAt: new Date(),
      ...extra,
    },
  });
}
async function stop(
  tx: Tx,
  actor: Actor | null,
  s: { id: string; epoch: number; status: string },
  status: string,
  reason: string,
) {
  const next = await tx.session.update({
    where: { id: s.id },
    data: {
      status,
      epoch: { increment: 1 },
      currentTurnId: null,
      ...(["ENDED", "WITHDRAWN"].includes(status)
        ? { endedAt: new Date() }
        : {}),
      ...(["WITHDRAWN", "PAUSED_SAFETY", "STAFF_CONTACT"].includes(status) ||
      reason === "EARLY_DEBRIEF_REQUEST"
        ? { excluded: true }
        : {}),
    },
  });
  await tx.generation.updateMany({
    where: { sessionId: s.id, status: "PENDING" },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  await tx.outbox.updateMany({
    where: { sessionId: s.id, status: "QUEUED" },
    data: { status: "CANCELLED", text: null },
  });
  await tx.sessionEvent.create({
    data: {
      sessionId: s.id,
      kind: status,
      actorId: actor?.id,
      epoch: next.epoch,
      metadata: { reasonCode: reason },
    },
  });
  await audit(tx, actor, "SESSION_" + status, "Session", s.id, {
    reasonCode: reason,
    epoch: next.epoch,
  });
  return next;
}
function publicMessage(m: any) {
  return {
    id: m.id,
    sequence: m.sequence,
    role: m.publicRole,
    text: m.text ?? "［内容已删除］",
    deliveredAt: iso(m.deliveredAt),
    acknowledgedAt: iso(m.acknowledgedAt),
  };
}
function sessionDto(s: any, actor: Actor, full = false) {
  const data: any = {
    id: s.id,
    index: s.index,
    status: s.status,
    topic: s.actualTopic,
    targetName: s.dyad.target.pseudonym,
    friendName: s.dyad.friend.pseudonym,
    scheduledAt: iso(s.scheduledAt),
    startedAt: iso(s.startedAt),
    endedAt: iso(s.endedAt),
    canSend:
      s.status === "ACTIVE" &&
      (actor.role === "FRIEND" || actor.role === "TARGET"),
    surveyCompleted:
      s.surveys?.some((x: any) => x.participantId === actor.id) ?? false,
  };
  if (full) data.messages = s.messages.map(publicMessage);
  if (actor.role === "RESEARCHER") {
    data.condition = s.privateCondition;
    data.epoch = s.epoch;
    data.dyadId = s.dyadId;
    data.excluded = s.excluded;
  }
  return data;
}
function sessionWhere(actor: Actor) {
  if (actor.role === "RESEARCHER") return {};
  if (actor.role === "FRIEND") return { dyad: { friendId: actor.id } };
  if (actor.role === "TARGET")
    return { dyad: { targetId: actor.id }, privateCondition: "HUMAN" };
  return { id: "no-access" };
}
export async function getSessions(actor: Actor) {
  await validateActor(actor);
  const sessions = await prisma.session.findMany({
    where: sessionWhere(actor),
    include: {
      dyad: { include: { target: true, friend: true } },
      surveys: { select: { participantId: true } },
    },
    orderBy: [{ scheduledAt: "asc" }, { index: "asc" }],
  });
  return { sessions: sessions.map((s) => sessionDto(s, actor)) };
}
export async function getSession(actor: Actor, id: string) {
  await validateActor(actor);
  await prisma.$transaction((tx) => sessionFor(tx, actor, id));
  await processDeliveries(id);
  return prisma.$transaction(async (tx) => {
    const s = await sessionFor(tx, actor, id);
    const surveys = await tx.liveSurvey.findMany({
      where: { sessionId: id },
      select: { participantId: true },
    });
    const dto = sessionDto({ ...s, surveys }, actor, true);
    if (
      actor.role === "FRIEND" &&
      (await tx.sourceRevealGrant.findUnique({
        where: {
          participantId_sessionId: { participantId: actor.id, sessionId: s.id },
        },
      }))
    )
      dto.revealedSource = s.privateCondition;
    return dto;
  });
}
const readinessMissing = [
  "伦理审批与正式研究编号",
  "供应商协议、固定模型与区域",
  "值守、备援与安全响应流程",
  "数据保留、备份清理与撤回政策",
  "独立时序容差与泄漏验收",
  "正式量表、预注册与 offline 抽样数量",
];
export async function getDashboard(actor: Actor) {
  await validateActor(actor);
  const study = await prisma.study.findUniqueOrThrow({
    where: { id: STUDY_ID },
  });
  if (!["RESEARCHER", "ANALYST"].includes(actor.role)) {
    const result = await getSessions(actor);
    return {
      study: { name: study.name, mode: study.mode, status: study.status },
      stats: {
        sessions: result.sessions.length,
        active: result.sessions.filter((x) => x.status === "ACTIVE").length,
        completed: result.sessions.filter((x) => x.status === "ENDED").length,
      },
      recentSessions: result.sessions.slice(0, 6),
      activity: [],
      readiness: { ready: false, missing: [] },
    };
  }
  const [
    targets,
    friends,
    dyads,
    sessions,
    active,
    completed,
    paused,
    openSafety,
    personas,
    activity,
    recent,
  ] = await Promise.all([
    prisma.participant.count({
      where: { role: "TARGET", ...syntheticParticipant },
    }),
    prisma.participant.count({
      where: { role: "FRIEND", ...syntheticParticipant },
    }),
    prisma.dyad.count(),
    prisma.session.count(),
    prisma.session.count({ where: { status: "ACTIVE" } }),
    prisma.session.count({ where: { status: "ENDED" } }),
    prisma.session.count({
      where: {
        status: { in: ["PAUSED_SAFETY", "PAUSED_TECHNICAL", "STAFF_CONTACT"] },
      },
    }),
    prisma.safetyEvent.count({ where: { status: "OPEN" } }),
    prisma.personaVersion.count({
      where: { status: "FROZEN", target: syntheticParticipant },
    }),
    prisma.auditEvent.findMany({
      where: syntheticAudit,
      take: 8,
      orderBy: { createdAt: "desc" },
    }),
    prisma.session.findMany({
      where: { status: { not: "SCHEDULED" } },
      include: { dyad: { include: { target: true, friend: true } } },
      orderBy: { scheduledAt: "desc" },
      take: 6,
    }),
  ]);
  return {
    study: { name: study.name, mode: study.mode, status: study.status },
    stats: {
      targets,
      friends,
      dyads,
      sessions,
      active,
      completed,
      paused,
      openSafety,
      personas,
    },
    recentSessions:
      actor.role === "RESEARCHER"
        ? recent.map((s) => sessionDto(s, actor))
        : [],
    activity: activity.map((a) => ({
      id: a.id,
      action: a.action,
      createdAt: iso(a.createdAt),
    })),
    readiness: { ready: false, missing: readinessMissing },
    balance: study.balance,
  };
}
export async function getStudyConfig(actor: Actor) {
  await validateActor(actor);
  demand(["RESEARCHER", "ANALYST"].includes(actor.role));
  const s = await prisma.study.findUniqueOrThrow({ where: { id: STUDY_ID } });
  return actor.role === "RESEARCHER"
    ? {
        ...s,
        readiness: { ready: false, missing: readinessMissing },
        frozenAt: iso(s.frozenAt),
        createdAt: iso(s.createdAt),
      }
    : {
        id: s.id,
        name: s.name,
        mode: s.mode,
        status: s.status,
        readiness: { ready: false, missing: readinessMissing },
        config: { measurementVersion: "synthetic-v1", sourceMasked: true },
        frozenAt: iso(s.frozenAt),
        createdAt: iso(s.createdAt),
      };
}

export async function controlSession(actor: Actor, p: Payload) {
  await validateActor(actor);
  demand(typeof p.sessionId === "string", "请选择会话。", 422, "INVALID_INPUT");
  return prisma.$transaction(async (tx) => {
    const s = await sessionFor(tx, actor, p.sessionId, true);
    const action = p.action;
    if (action === "skip") {
      demand(s.status === "ACTIVE", "会话尚未开始。", 409, "INVALID_STATE");
      await tx.session.update({
        where: { id: s.id },
        data: {
          actualTopic:
            typeof p.topic === "string" ? p.topic.slice(0, 80) : "自由轻松话题",
          switchReason: "PARTICIPANT_SKIPPED",
        },
      });
      await audit(tx, actor, "TOPIC_SKIPPED", "Session", s.id);
      return { ok: true };
    }
    const statuses: Record<string, string> = {
      start: "ACTIVE",
      pause: "PAUSED_TECHNICAL",
      resume: "ACTIVE",
      end: "ENDED",
      withdraw: "WITHDRAWN",
    };
    const target = statuses[action];
    demand(target, "不支持的会话操作。", 422, "INVALID_INPUT");
    if (action === "start" || action === "resume") {
      demand(actor.role === "RESEARCHER", "会话由研究人员启动或恢复。");
      demand(
        (action === "resume" && s.status === "PAUSED_TECHNICAL") ||
          canTransition(s.status as SessionStatus, target as SessionStatus),
        "当前状态不允许此操作。",
        409,
        "INVALID_STATE",
      );
      demand(
        await validConsents(tx, s),
        "双方尚未完成有效同意。",
        409,
        "CONSENT_REQUIRED",
      );
      const persona = s.personaVersionId
        ? await tx.personaVersion.findUnique({
            where: { id: s.personaVersionId },
          })
        : null;
      demand(
        persona?.status === "FROZEN" && !persona.destroyedAt,
        "需要有效的冻结版本。",
        409,
        "PERSONA_REQUIRED",
      );
      demand(
        !(await tx.safetyEvent.count({
          where: { sessionId: s.id, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        })),
        "安全事件需要先完成处置。",
        409,
        "SAFETY_OPEN",
      );
      const study = await tx.study.findUniqueOrThrow({
        where: { id: STUDY_ID },
      });
      demand(
        study.mode === "SYNTHETIC",
        "正式研究配置尚未批准。",
        409,
        "LIVE_BLOCKED",
      );
      const updated = await tx.session.update({
        where: { id: s.id },
        data: { status: "ACTIVE", startedAt: s.startedAt ?? new Date() },
      });
      await append(
        tx,
        updated,
        "STUDY_NOTICE",
        "研究对话已开始。两种来源均可能出现，你可以随时跳题、暂停或结束。",
      );
      await audit(tx, actor, "SESSION_STARTED", "Session", s.id);
      return { ok: true, status: "ACTIVE" };
    }
    demand(
      !["ENDED", "WITHDRAWN"].includes(s.status),
      "会话已结束。",
      409,
      "INVALID_STATE",
    );
    demand(
      canTransition(s.status as SessionStatus, target as SessionStatus),
      "当前状态不允许此操作。",
      409,
      "INVALID_STATE",
    );
    const updated = await stop(
      tx,
      actor,
      s,
      target,
      "PARTICIPANT_OR_STAFF_CONTROL",
    );
    await append(
      tx,
      updated,
      "STUDY_NOTICE",
      target === "ENDED"
        ? "研究对话已结束。你可以选择完成问卷，也可以直接退出。"
        : target === "WITHDRAWN"
          ? "研究对话已停止。你可以选择撤回数据或请求研究说明。"
          : "研究对话已暂停。暂停期间不会继续发送回复。",
    );
    return { ok: true, status: target };
  });
}
export async function sendMessage(actor: Actor, p: Payload) {
  await validateActor(actor);
  demand(actor.role === "FRIEND" || actor.role === "TARGET");
  demand(
    typeof p.text === "string" &&
      p.text.trim().length > 0 &&
      p.text.length <= 4000,
    "请输入 1–4000 字符。",
    422,
    "INVALID_INPUT",
  );
  demand(
    typeof p.idempotencyKey === "string" &&
      p.idempotencyKey.length >= 8 &&
      p.idempotencyKey.length <= 128,
    "缺少有效的重试标识。",
    422,
    "INVALID_INPUT",
  );
  let generationId: string | null = null;
  const result = await prisma.$transaction(async (tx) => {
    const s = await sessionFor(tx, actor, p.sessionId, true);
    const existing = await tx.message.findUnique({
      where: {
        sessionId_clientIdempotencyKey: {
          sessionId: s.id,
          clientIdempotencyKey: p.idempotencyKey,
        },
      },
    });
    if (existing) {
      demand(existing.authorId === actor.id);
      return { ok: true, message: publicMessage(existing), duplicate: true };
    }
    demand(
      s.status === "ACTIVE",
      "会话已暂停或结束，消息未发送。",
      409,
      "SESSION_NOT_ACTIVE",
    );
    demand(
      await validConsents(tx, s),
      "有效同意已撤销，消息未发送。",
      409,
      "CONSENT_REQUIRED",
    );
    const check = inspectText(p.text);
    if (check.decision === "EDIT_REQUIRED")
      throw new ApiError(
        422,
        "EDIT_REQUIRED",
        "消息可能包含敏感信息或超出研究范围，请编辑后重试。",
      );
    if (check.decision === "PAUSE_SAFETY" || check.decision === "WITHDRAW") {
      const status =
        check.decision === "WITHDRAW" ? "WITHDRAWN" : "PAUSED_SAFETY";
      const updated = await stop(tx, actor, s, status, check.reasonCode);
      if (status === "PAUSED_SAFETY")
        await tx.safetyEvent.create({
          data: {
            sessionId: s.id,
            reasonCode: check.reasonCode,
            actorId: actor.id,
          },
        });
      const notice =
        check.notice ??
        (status === "WITHDRAWN"
          ? "研究对话已停止。你可以查看研究说明和撤回选项。"
          : "研究对话已暂停。这个平台不是紧急援助服务；若存在即时危险，请使用当地紧急服务。");
      await append(tx, updated, "STUDY_NOTICE", notice, {
        clientIdempotencyKey: p.idempotencyKey,
        authorId: actor.id,
      });
      return { ok: true, status, notice };
    }
    const m = await append(
      tx,
      s,
      actor.role === "FRIEND" ? "FRIEND" : "SOURCE",
      p.text.trim(),
      { clientIdempotencyKey: p.idempotencyKey, authorId: actor.id },
    );
    if (check.decision === "STUDY_NOTICE") {
      await append(tx, s, "STUDY_NOTICE", check.notice ?? SOURCE_QUERY_NOTICE);
      return { ok: true, message: publicMessage(m) };
    }
    if (actor.role === "FRIEND" && s.privateCondition === "AI") {
      const turnId = randomUUID();
      await tx.session.update({
        where: { id: s.id },
        data: { currentTurnId: turnId },
      });
      await tx.generation.updateMany({
        where: { sessionId: s.id, status: "PENDING" },
        data: { status: "STALE", cancelledAt: new Date() },
      });
      await tx.outbox.updateMany({
        where: { sessionId: s.id, status: "QUEUED" },
        data: { status: "STALE", text: null },
      });
      const g = await tx.generation.create({
        data: {
          sessionId: s.id,
          epoch: s.epoch,
          turnId,
          sourceVersion: s.personaVersionId ?? "missing",
        },
      });
      generationId = g.id;
    }
    await audit(tx, actor, "MESSAGE_ACCEPTED", "Session", s.id, {
      messageId: m.id,
    });
    return { ok: true, message: publicMessage(m) };
  });
  if (generationId) {
    const id = generationId;
    const timer = setTimeout(() => {
      void completeGeneration(id).catch(() => {});
    }, 550);
    timer.unref?.();
  }
  return result;
}
export async function completeGeneration(id: string) {
  const g = await prisma.generation.findUnique({
    where: { id },
    include: { session: { include: { dyad: true } } },
  });
  if (!g || g.status !== "PENDING") return;
  const s = g.session;
  if (
    s.status !== "ACTIVE" ||
    s.epoch !== g.epoch ||
    s.currentTurnId !== g.turnId ||
    !(await validConsents(prisma, s))
  )
    return;
  const persona = await prisma.personaVersion.findUnique({
    where: { id: g.sourceVersion },
  });
  if (!persona || persona.status !== "FROZEN" || persona.destroyedAt) return;
  const target = await prisma.participant.findUniqueOrThrow({
    where: { id: s.dyad.targetId },
  });
  const [knowledge, messages] = await Promise.all([
    prisma.knowledgeItem.findMany({
      where: {
        targetId: target.id,
        personaVersionId: persona.id,
        approved: true,
        destroyedAt: null,
        permissionScope: "CURRENT_TARGET_SESSION",
      },
    }),
    prisma.message.findMany({
      where: {
        sessionId: s.id,
        status: "DELIVERED",
        destroyedAt: null,
        publicRole: { in: ["FRIEND", "SOURCE"] },
      },
      orderBy: { sequence: "asc" },
      take: 40,
    }),
  ]);
  let response: Awaited<ReturnType<typeof generateReply>>;
  try {
    response = await generateReply(
      {
        targetId: target.id,
        personaVersion: persona.id,
        pseudonym: target.pseudonym,
        styleProfile: JSON.stringify(persona.style),
        interactionProfile: JSON.stringify(persona.interaction),
        boundaries: JSON.stringify(persona.boundaries),
        knowledge: knowledge.map((k) => ({
          id: k.id,
          text: k.text ?? "",
          targetId: k.targetId,
          personaVersion: k.personaVersionId,
          approved: k.approved,
          partition: "BUILD",
        })),
        messages: messages.map((m) => ({
          role: m.publicRole as "FRIEND" | "SOURCE",
          text: m.text ?? "",
        })),
      },
      { mode: "SYNTHETIC" },
    );
  } catch {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${s.id} FOR UPDATE`;
      const current = await tx.session.findUniqueOrThrow({
        where: { id: s.id },
      });
      if (
        current.status === "ACTIVE" &&
        current.epoch === g.epoch &&
        current.currentTurnId === g.turnId
      )
        await stop(
          tx,
          null,
          current,
          "PAUSED_TECHNICAL",
          "SYNTHETIC_PROVIDER_FAILURE",
        );
    });
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${s.id} FOR UPDATE`;
    const current = await tx.session.findUniqueOrThrow({
      where: { id: s.id },
      include: { dyad: true },
    });
    const latest = await tx.generation.findUniqueOrThrow({ where: { id } });
    const allowed =
      current.status === "ACTIVE" &&
      current.epoch === g.epoch &&
      current.currentTurnId === g.turnId &&
      current.personaVersionId === g.sourceVersion &&
      latest.status === "PENDING" &&
      (await validConsents(tx, current));
    if (!allowed) {
      await tx.generation.update({
        where: { id },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      return;
    }
    const freshPersona = await tx.personaVersion.findUnique({
      where: { id: g.sourceVersion },
    });
    if (freshPersona?.status !== "FROZEN" || freshPersona.destroyedAt) {
      await stop(tx, null, current, "PAUSED_TECHNICAL", "PERSONA_INVALID");
      return;
    }
    if (
      response.action === "PAUSE_REQUEST" ||
      response.bursts.some((b) => inspectText(b).decision === "PAUSE_SAFETY")
    ) {
      const updated = await stop(
        tx,
        null,
        current,
        "PAUSED_SAFETY",
        response.safety_reason_code ?? "OUTPUT_SAFETY",
      );
      await tx.safetyEvent.create({
        data: {
          sessionId: s.id,
          reasonCode: response.safety_reason_code ?? "OUTPUT_SAFETY",
        },
      });
      await append(
        tx,
        updated,
        "STUDY_NOTICE",
        "研究对话已暂停。请通过研究支持流程联系研究人员；即时危险请使用当地紧急服务。",
      );
      return;
    }
    const output =
      response.action === "SOURCE_QUERY"
        ? [SOURCE_QUERY_NOTICE]
        : response.action === "BOUNDARY"
          ? [BOUNDARY_NOTICE]
          : response.bursts;
    const safeOutput = output.every((b) => {
      const result = inspectText(b);
      return (
        result.decision === "ALLOW" ||
        (response.action === "SOURCE_QUERY" &&
          result.decision === "STUDY_NOTICE")
      );
    });
    if (!safeOutput) {
      await stop(
        tx,
        null,
        current,
        "PAUSED_TECHNICAL",
        "OUTPUT_BOUNDARY_REVIEW",
      );
      return;
    }
    const finishedAt = new Date();
    await tx.generation.update({
      where: { id },
      data: { status: "COMPLETED", finishedAt },
    });
    for (let i = 0; i < output.length; i++)
      await tx.outbox.create({
        data: {
          sessionId: s.id,
          generationId: id,
          epoch: g.epoch,
          turnId: g.turnId,
          sourceVersion: g.sourceVersion,
          publicRole:
            response.action === "SOURCE_QUERY" || response.action === "BOUNDARY"
              ? "STUDY_NOTICE"
              : "SOURCE",
          text: output[i],
          eligibleAt: new Date(
            Math.max(g.triggeredAt.getTime() + 900, finishedAt.getTime()) +
              i * 650,
          ),
          generatedAt: finishedAt,
        },
      });
    await audit(tx, null, "GENERATION_COMPLETED", "Session", s.id, {
      generationId: id,
      burstCount: output.length,
    });
  });
}
export async function processDeliveries(sessionId?: string) {
  const pending = await prisma.generation.findMany({
    where: {
      status: "PENDING",
      triggeredAt: { lte: new Date(Date.now() - 550) },
      ...(sessionId ? { sessionId } : {}),
    },
    select: { id: true },
    take: 10,
  });
  for (const generation of pending) await completeGeneration(generation.id);
  const due = await prisma.outbox.findMany({
    where: {
      status: "QUEUED",
      eligibleAt: { lte: new Date() },
      ...(sessionId ? { sessionId } : {}),
    },
    select: { sessionId: true },
    distinct: ["sessionId"],
    take: 30,
  });
  for (const { sessionId: id } of due)
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${id} FOR UPDATE`;
      const s = await tx.session.findUniqueOrThrow({
        where: { id },
        include: { dyad: true },
      });
      const rows = await tx.outbox.findMany({
        where: {
          sessionId: id,
          status: "QUEUED",
          eligibleAt: { lte: new Date() },
        },
        orderBy: { eligibleAt: "asc" },
      });
      const consentValid = await validConsents(tx, s);
      for (const row of rows) {
        const persona = row.sourceVersion
          ? await tx.personaVersion.findUnique({
              where: { id: row.sourceVersion },
            })
          : null;
        const valid =
          s.status === "ACTIVE" &&
          s.epoch === row.epoch &&
          s.currentTurnId === row.turnId &&
          s.personaVersionId === row.sourceVersion &&
          consentValid &&
          persona?.status === "FROZEN" &&
          !persona.destroyedAt;
        if (!valid) {
          await tx.outbox.update({
            where: { id: row.id },
            data: { status: "CANCELLED", text: null },
          });
          continue;
        }
        const m = await append(tx, s, row.publicRole, row.text ?? "", {
          generatedAt: row.generatedAt,
        });
        await tx.outbox.update({
          where: { id: row.id },
          data: {
            status: "DELIVERED",
            deliveredAt: m.deliveredAt,
            messageId: m.id,
            text: null,
          },
        });
      }
    });
}
export async function ackMessage(actor: Actor, p: Payload) {
  await validateActor(actor);
  return prisma.$transaction(async (tx) => {
    const s = await sessionFor(tx, actor, p.sessionId, true);
    const m = await tx.message.findFirst({
      where: { id: p.messageId, sessionId: s.id, status: "DELIVERED" },
    });
    demand(m, "消息不可确认。", 404, "NOT_FOUND");
    const isRecipient =
      (actor.role === "FRIEND" && m.publicRole !== "FRIEND") ||
      (actor.role === "TARGET" && m.publicRole !== "SOURCE");
    if (isRecipient && !m.acknowledgedAt)
      await tx.message.update({
        where: { id: m.id },
        data: { acknowledgedAt: new Date() },
      });
    return { ok: true };
  });
}

function consentDto(c: any) {
  return {
    participation: c?.participation ?? false,
    aiProcessing: c?.aiProcessing ?? false,
    corpusUse: c?.corpusUse ?? false,
    secondarySharing: {
      familiarRaters: c?.familiarSharing ?? false,
      unfamiliarRaters: c?.unfamiliarSharing ?? false,
      targetReview: c?.targetReview ?? false,
      publicQuote: c?.quotation ?? false,
    },
    quotation: c?.quotation ?? false,
    version: c?.version ?? "synthetic-v1",
    recordedAt: iso(c?.recordedAt),
  };
}
export async function getConsent(actor: Actor) {
  await validateActor(actor);
  return consentDto(await latestConsent(prisma, actor.id));
}
export async function saveConsent(actor: Actor, p: Payload) {
  await validateActor(actor);
  demand(["TARGET", "FRIEND"].includes(actor.role));
  const scopes =
    typeof p.secondarySharing === "object" ? p.secondarySharing : {};
  return prisma.$transaction(async (tx) => {
    const c = await tx.consent.create({
      data: {
        participantId: actor.id,
        participation: p.participation === true,
        aiProcessing: p.aiProcessing === true,
        corpusUse: actor.role === "TARGET" && p.corpusUse === true,
        familiarSharing: scopes.familiarRaters === true,
        unfamiliarSharing: scopes.unfamiliarRaters === true,
        targetReview: scopes.targetReview === true,
        secondarySharing:
          scopes.familiarRaters === true || scopes.unfamiliarRaters === true,
        quotation: scopes.publicQuote === true,
        revokedAt: p.participation === true ? null : new Date(),
      },
    });
    const sessions = await tx.session.findMany({
      where: { dyad: { OR: [{ targetId: actor.id }, { friendId: actor.id }] } },
    });
    if (!c.participation || !c.aiProcessing)
      for (const s of sessions) {
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${s.id} FOR UPDATE`;
        const current = await tx.session.findUniqueOrThrow({
          where: { id: s.id },
        });
        if (!["ENDED", "WITHDRAWN"].includes(current.status))
          await stop(tx, actor, current, "WITHDRAWN", "CONSENT_REVOKED");
      }
    if (actor.role === "TARGET" && !c.corpusUse) {
      await tx.personaVersion.updateMany({
        where: { targetId: actor.id, status: { not: "DESTROYED" } },
        data: { status: "INVALIDATED" },
      });
      await tx.knowledgeItem.updateMany({
        where: { targetId: actor.id },
        data: { approved: false },
      });
    }
    const stimuli = await tx.stimulusExcerpt.findMany({
      where: { sessionId: { in: sessions.map((s) => s.id) } },
    });
    if (!c.familiarSharing)
      await tx.offlineAssignment.updateMany({
        where: {
          stimulusId: { in: stimuli.map((s) => s.id) },
          familiarityRole: "FAMILIAR",
          status: "PENDING",
        },
        data: { status: "REVOKED" },
      });
    if (!c.unfamiliarSharing)
      await tx.offlineAssignment.updateMany({
        where: {
          stimulusId: { in: stimuli.map((s) => s.id) },
          familiarityRole: "UNFAMILIAR",
          status: "PENDING",
        },
        data: { status: "REVOKED" },
      });
    if (!c.participation)
      await tx.offlineAssignment.updateMany({
        where: { participantId: actor.id, status: "PENDING" },
        data: { status: "REVOKED" },
      });
    await audit(tx, actor, "CONSENT_UPDATED", "Participant", actor.id, {
      participation: c.participation,
      aiProcessing: c.aiProcessing,
      sharing: {
        familiar: c.familiarSharing,
        unfamiliar: c.unfamiliarSharing,
        targetReview: c.targetReview,
      },
    });
    return { ok: true, consent: consentDto(c) };
  });
}
export async function getOnboarding(actor: Actor) {
  await validateActor(actor);
  if (["RESEARCHER", "ANALYST"].includes(actor.role)) {
    const [targets, BUILD, DEV, HOLDOUT, approved, frozen] = await Promise.all([
      prisma.participant.count({
        where: { role: "TARGET", ...syntheticParticipant },
      }),
      prisma.corpusItem.count({
        where: {
          partition: "BUILD",
          destroyedAt: null,
          target: syntheticParticipant,
        },
      }),
      prisma.corpusItem.count({
        where: {
          partition: "DEV",
          destroyedAt: null,
          target: syntheticParticipant,
        },
      }),
      prisma.corpusItem.count({
        where: {
          partition: "HOLDOUT",
          destroyedAt: null,
          target: syntheticParticipant,
        },
      }),
      prisma.corpusItem.count({
        where: {
          reviewStatus: "APPROVED",
          destroyedAt: null,
          target: syntheticParticipant,
        },
      }),
      prisma.personaVersion.count({
        where: { status: "FROZEN", target: syntheticParticipant },
      }),
    ]);
    return {
      overview: true,
      target: { id: "summary", pseudonym: "语料与冻结版本概览" },
      corpus: [],
      personas: [],
      counts: { BUILD, DEV, HOLDOUT, approved },
      baseline: { count: 0, status: "LOW_SUPPORT" },
      calibration: [],
      summary: { targets, frozen },
    };
  }
  demand(actor.role === "TARGET");
  const [corpus, personas, count, calibration] = await Promise.all([
    prisma.corpusItem.findMany({
      where: { targetId: actor.id, destroyedAt: null },
      orderBy: { createdAt: "desc" },
    }),
    prisma.personaVersion.findMany({
      where: { targetId: actor.id },
      orderBy: { version: "desc" },
    }),
    prisma.baselineSample.count({ where: { targetId: actor.id } }),
    prisma.calibrationAnswer.findMany({
      where: { targetId: actor.id },
      select: { questionId: true, answer: true },
    }),
  ]);
  return {
    target: { id: actor.id, pseudonym: actor.pseudonym },
    corpus: corpus.map((c) => ({
      id: c.id,
      text: c.text,
      partition: c.partition,
      reviewStatus: c.reviewStatus,
      riskCodes: c.riskCodes,
      duplicateOf: c.duplicateOf,
    })),
    counts: {
      BUILD: corpus.filter((x) => x.partition === "BUILD").length,
      DEV: corpus.filter((x) => x.partition === "DEV").length,
      HOLDOUT: corpus.filter((x) => x.partition === "HOLDOUT").length,
      approved: corpus.filter((x) => x.reviewStatus === "APPROVED").length,
    },
    personas: personas.map((p) => ({
      id: p.id,
      version: p.version,
      status: p.status,
      style: p.style,
      interaction: p.interaction,
      boundaries: p.boundaries,
      frozenAt: iso(p.frozenAt),
    })),
    baseline: { count, status: "LOW_SUPPORT" },
    calibration,
    requirements: {
      corpusMin: 80,
      corpusMax: 150,
      calibrationMin: 15,
      calibrationMax: 30,
      syntheticRelaxation: true,
    },
  };
}
export async function importCorpus(actor: Actor, p: Payload) {
  await validateActor(actor);
  demand(actor.role === "TARGET");
  const c = await latestConsent(prisma, actor.id);
  demand(
    c?.participation && c.corpusUse,
    "需要同意参与及语料使用。",
    409,
    "CONSENT_REQUIRED",
  );
  const texts = Array.isArray(p.texts)
    ? p.texts
    : typeof p.texts === "string"
      ? p.texts.split(/\r?\n/)
      : [];
  demand(
    texts.length > 0 && texts.length <= 150,
    "每次可导入 1–150 条文字。",
    422,
    "INVALID_INPUT",
  );
  demand(
    ["BUILD", "DEV", "HOLDOUT"].includes(p.partition),
    "需要明确分区。",
    422,
    "INVALID_INPUT",
  );
  return prisma.$transaction(async (tx) => {
    let imported = 0;
    for (const value of texts) {
      demand(
        typeof value === "string" &&
          value.trim().length > 0 &&
          value.length <= 4000,
        "每条文字需要 1–4000 字符。",
        422,
        "INVALID_INPUT",
      );
      const text = value.trim();
      const contentHash = hashText(text);
      const prior = await tx.corpusItem.findMany({
        where: { targetId: actor.id, destroyedAt: null },
        select: { id: true, text: true, partition: true },
      });
      const duplicate = prior.find((c) => nearDuplicate(c.text ?? "", text));
      demand(
        !duplicate || duplicate.partition === p.partition,
        "同一或近重复内容必须保持在原分区，不能跨 BUILD / DEV / HOLDOUT。",
        422,
        "PARTITION_LEAKAGE",
      );
      await tx.corpusItem.create({
        data: {
          targetId: actor.id,
          partition: p.partition,
          text,
          contentHash,
          riskCodes: json(scanPII(text)),
          duplicateOf: duplicate?.id,
        },
      });
      imported++;
    }
    await audit(tx, actor, "CORPUS_IMPORTED", "Participant", actor.id, {
      imported,
      partition: p.partition,
    });
    return { ok: true, imported };
  });
}
export async function approveCorpus(actor: Actor, p: Payload) {
  await validateActor(actor);
  demand(actor.role === "TARGET");
  return prisma.$transaction(async (tx) => {
    const item = await tx.corpusItem.findUnique({ where: { id: p.id } });
    demand(item?.targetId === actor.id && !item.destroyedAt);
    const derived = await tx.dataLineage.findMany({
      where: {
        parentType: "CorpusItem",
        parentId: item.id,
        childType: "PersonaVersion",
      },
    });
    const frozen = await tx.personaVersion.count({
      where: { id: { in: derived.map((d) => d.childId) }, status: "FROZEN" },
    });
    demand(
      !frozen,
      "已冻结版本引用的语料不可原地修改，请创建新语料。",
      409,
      "FROZEN",
    );
    const text = typeof p.text === "string" ? p.text.trim() : (item.text ?? "");
    demand(
      text.length > 0 && text.length <= 4000,
      "文字长度无效。",
      422,
      "INVALID_INPUT",
    );
    const related = await tx.corpusItem.findMany({
      where: { targetId: actor.id, id: { not: item.id }, destroyedAt: null },
      select: { text: true, partition: true },
    });
    demand(
      !related.some(
        (c) =>
          c.partition !== item.partition && nearDuplicate(c.text ?? "", text),
      ),
      "编辑内容与其他分区近重复。",
      422,
      "PARTITION_LEAKAGE",
    );
    const findings = scanPII(text);
    demand(
      findings.length === 0,
      "请先替换或删除本地扫描标出的敏感信息。",
      422,
      "PRIVACY_REVIEW_REQUIRED",
    );
    await tx.corpusItem.update({
      where: { id: item.id },
      data: {
        text,
        contentHash: hashText(text),
        riskCodes: [],
        reviewStatus: "APPROVED",
        approvedAt: new Date(),
      },
    });
    await audit(tx, actor, "CORPUS_APPROVED", "CorpusItem", item.id);
    return { ok: true };
  });
}
export async function buildPersona(actor: Actor) {
  await validateActor(actor);
  demand(actor.role === "TARGET");
  return prisma.$transaction(async (tx) => {
    const consent = await latestConsent(tx, actor.id);
    demand(
      consent?.participation && consent.corpusUse,
      "需要有效的语料使用同意。",
      409,
      "CONSENT_REQUIRED",
    );
    const corpus = await tx.corpusItem.findMany({
      where: {
        targetId: actor.id,
        partition: "BUILD",
        reviewStatus: "APPROVED",
        destroyedAt: null,
      },
    });
    demand(
      corpus.length >= 3,
      "至少需要 3 条已批准 BUILD 合成语料。正式研究要求另行验证。",
      422,
      "CORPUS_REQUIRED",
    );
    const old = await tx.personaVersion.findFirst({
      where: { targetId: actor.id },
      orderBy: { version: "desc" },
    });
    const calibration = (
      await tx.calibrationAnswer.findMany({
        where: {
          targetId: actor.id,
          partition: "BUILD",
          answer: { not: null },
        },
      })
    ).filter((a) => scanPII(a.answer ?? "").length === 0);
    const texts = [
      ...corpus.map((c) => c.text ?? ""),
      ...calibration.map((a) => a.answer ?? ""),
    ];
    const length = Math.round(
      texts.reduce((sum, t) => sum + [...t].length, 0) / texts.length,
    );
    const p = await tx.personaVersion.create({
      data: {
        targetId: actor.id,
        version: (old?.version ?? 0) + 1,
        style: {
          language: "中文与混合语言",
          meanCharacters: length,
          sentenceLength: length < 35 ? "短句" : "自然句长",
          tone: "由获批 BUILD 样本归纳",
          sampleCount: corpus.length,
          calibrationCount: calibration.length,
          particles: ["嗯", "呀"].filter((w) =>
            texts.some((t) => t.includes(w)),
          ),
        },
        interaction: {
          memory: "仅当前场次",
          uncertainty: "没有依据就明确不确定",
          sourceQuery: "由研究提示统一处理",
        },
        boundaries: [
          "不编造共同回忆",
          "不承诺现实行动",
          "不调用外部工具",
          "安全和退出优先",
        ],
        buildCorpusIds: corpus.map((c) => c.id),
        contentHash: hashText(texts.join("\n")),
      },
    });
    await tx.dataLineage.createMany({
      data: [
        ...corpus.map((c) => ({
          ownerId: actor.id,
          parentType: "CorpusItem",
          parentId: c.id,
          childType: "PersonaVersion",
          childId: p.id,
        })),
        ...calibration.map((c) => ({
          ownerId: actor.id,
          parentType: "CalibrationAnswer",
          parentId: c.id,
          childType: "PersonaVersion",
          childId: p.id,
        })),
      ],
    });
    for (const c of corpus
      .filter((c) => /喜欢|偏好|比较顺口|想去/.test(c.text ?? ""))
      .slice(0, 8)) {
      const k = await tx.knowledgeItem.create({
        data: {
          targetId: actor.id,
          personaVersionId: p.id,
          corpusItemId: c.id,
          text: c.text,
        },
      });
      await tx.dataLineage.create({
        data: {
          ownerId: actor.id,
          parentType: "CorpusItem",
          parentId: c.id,
          childType: "KnowledgeItem",
          childId: k.id,
        },
      });
    }
    await audit(tx, actor, "PERSONA_BUILT", "PersonaVersion", p.id, {
      version: p.version,
      buildCount: corpus.length,
    });
    return {
      ok: true,
      persona: { id: p.id, version: p.version, status: p.status },
    };
  });
}
export async function freezePersona(actor: Actor, p: Payload = {}) {
  await validateActor(actor);
  demand(actor.role === "TARGET");
  return prisma.$transaction(async (tx) => {
    const persona = p.id
      ? await tx.personaVersion.findUnique({ where: { id: p.id } })
      : await tx.personaVersion.findFirst({
          where: { targetId: actor.id, status: "DRAFT" },
          orderBy: { version: "desc" },
        });
    demand(
      persona?.targetId === actor.id && persona.status === "DRAFT",
      "没有可冻结的草稿。",
      409,
      "INVALID_STATE",
    );
    await tx.personaVersion.update({
      where: { id: persona.id },
      data: { status: "FROZEN", frozenAt: new Date() },
    });
    await audit(tx, actor, "PERSONA_FROZEN", "PersonaVersion", persona.id, {
      version: persona.version,
    });
    return { ok: true };
  });
}
function intRange(
  value: unknown,
  min: number,
  max: number,
  field: string,
  nullable = true,
) {
  if ((value === undefined || value === null || value === "") && nullable)
    return null;
  const n = Number(value);
  demand(
    Number.isInteger(n) && n >= min && n <= max,
    `${field} 必须在 ${min}–${max}。`,
    422,
    "INVALID_INPUT",
  );
  return n;
}
function responseScores(p: Payload) {
  const guess = p.guess ?? null;
  demand(
    guess === null || guess === "HUMAN" || guess === "AI",
    "来源判断无效。",
    422,
    "INVALID_INPUT",
  );
  const confidence =
    guess === null ? null : intRange(p.confidence, 50, 100, "信心");
  return {
    guess,
    confidence,
    pAI:
      guess && confidence !== null
        ? guess === "AI"
          ? confidence / 100
          : 1 - confidence / 100
        : null,
  };
}
export async function submitSurvey(actor: Actor, p: Payload) {
  await validateActor(actor);
  demand(actor.role === "FRIEND" || actor.role === "TARGET");
  return prisma.$transaction(async (tx) => {
    const s = await sessionFor(tx, actor, p.sessionId, true);
    demand(
      ["ENDED", "PAUSED_SAFETY", "STAFF_CONTACT", "WITHDRAWN"].includes(
        s.status,
      ),
      "请在会话结束后填写。",
      409,
      "INVALID_STATE",
    );
    demand(!s.destroyedAt, "已销毁的数据不能继续评价。", 409, "DESTROYED");
    demand(
      !(await tx.liveSurvey.findUnique({
        where: {
          sessionId_participantId: { sessionId: s.id, participantId: actor.id },
        },
      })),
      "已提交的问卷不可修改。",
      409,
      "LOCKED",
    );
    const scores =
      actor.role === "FRIEND"
        ? responseScores(p)
        : { guess: null, confidence: null, pAI: null };
    const reason =
      typeof p.reason === "string" ? p.reason.slice(0, 2000) : null;
    demand(
      !reason || scanPII(reason).length === 0,
      "请移除理由中的敏感信息。",
      422,
      "PRIVACY_REVIEW_REQUIRED",
    );
    await tx.liveSurvey.create({
      data: {
        sessionId: s.id,
        participantId: actor.id,
        ...scores,
        likeness: intRange(p.likeness, 1, 5, "像本人程度"),
        relationalFit: intRange(p.relationalFit, 1, 5, "关系表达"),
        naturalness: intRange(p.naturalness, 1, 5, "自然度"),
        trust: intRange(p.trust, 1, 5, "信任"),
        comfort: intRange(p.comfort, 1, 5, "舒适度"),
        reason,
        answers: {
          externalDiscussion: p.externalDiscussion === true,
          sourceHint: p.sourceHint === true,
          technicalIssue: p.technicalIssue === true,
          humanStrategyChange: p.humanStrategyChange === true,
          generativeAssistance: p.generativeAssistance === true,
        },
      },
    });
    await audit(tx, actor, "SURVEY_SUBMITTED", "Session", s.id);
    return { ok: true };
  });
}
async function offlineEligibility(tx: Tx, a: any) {
  const s = a.stimulus.session;
  const [t, f, r, screen] = await Promise.all([
    latestConsent(tx, s.dyad.targetId),
    latestConsent(tx, s.dyad.friendId),
    latestConsent(tx, a.participantId),
    tx.familiarityScreen.findUnique({
      where: {
        participantId_targetId: {
          participantId: a.participantId,
          targetId: s.dyad.targetId,
        },
      },
    }),
  ]);
  const scope =
    a.familiarityRole === "FAMILIAR" ? "familiarSharing" : "unfamiliarSharing";
  const allowed =
    t?.participation &&
    f?.participation &&
    r?.participation &&
    !t.revokedAt &&
    !f.revokedAt &&
    !r.revokedAt &&
    t[scope] &&
    f[scope] &&
    s.dyad.friendId !== a.participantId &&
    screen &&
    (a.familiarityRole === "FAMILIAR"
      ? screen.knowsTarget
      : !screen.knowsTarget) &&
    a.stimulus.status === "APPROVED" &&
    !a.stimulus.destroyedAt &&
    !s.destroyedAt &&
    !s.excluded &&
    s.safety.length === 0 &&
    a.expiresAt > new Date();
  return Boolean(allowed);
}
const includeAssignment = {
  stimulus: { include: { session: { include: { dyad: true, safety: true } } } },
  rating: true,
};
export async function getOffline(actor: Actor) {
  await validateActor(actor);
  if (["RESEARCHER", "ANALYST"].includes(actor.role)) {
    const [pending, completed, revoked, stimuli] = await Promise.all([
      prisma.offlineAssignment.count({ where: { status: "PENDING" } }),
      prisma.offlineAssignment.count({ where: { status: "COMPLETED" } }),
      prisma.offlineAssignment.count({ where: { status: "REVOKED" } }),
      prisma.stimulusExcerpt.count({ where: { status: "APPROVED" } }),
    ]);
    return {
      assignments: [],
      completed,
      overview: { pending, completed, revoked, stimuli },
    };
  }
  demand(actor.role === "FRIEND");
  const list = await prisma.offlineAssignment.findMany({
    where: { participantId: actor.id },
    include: includeAssignment,
    orderBy: { id: "asc" },
  });
  const assignments = [];
  for (const a of list) {
    if (a.status !== "PENDING" || !(await offlineEligibility(prisma, a)))
      continue;
    assignments.push({
      id: a.id,
      stimulusText: a.stimulus.text,
      context: a.stimulus.context,
      displayName: a.displayPseudonym,
      familiarityRole: a.familiarityRole,
      status: a.status,
      expiresAt: iso(a.expiresAt),
      canRatePersonLikeness: a.familiarityRole === "FAMILIAR",
    });
  }
  return {
    assignments,
    completed: list.filter((x) => x.status === "COMPLETED").length,
  };
}
export async function submitOffline(actor: Actor, p: Payload) {
  await validateActor(actor);
  demand(actor.role === "FRIEND");
  return prisma.$transaction(async (tx) => {
    const a = await tx.offlineAssignment.findUnique({
      where: { id: p.assignmentId },
      include: includeAssignment,
    });
    demand(a?.participantId === actor.id);
    demand(
      a.status === "PENDING" && (await offlineEligibility(tx, a)),
      "此评价任务已提交、到期或分享许可已失效。",
      409,
      "INELIGIBLE",
    );
    const scores = responseScores(p);
    demand(
      a.familiarityRole === "FAMILIAR" ||
        p.personLikeness === undefined ||
        p.personLikeness === null,
      "不熟悉评分不收集像本人程度。",
      422,
      "INVALID_INPUT",
    );
    await tx.offlineRating.create({
      data: {
        assignmentId: a.id,
        ...scores,
        naturalness: intRange(p.naturalness, 1, 5, "自然度"),
        personLikeness:
          a.familiarityRole === "FAMILIAR"
            ? intRange(p.personLikeness, 1, 5, "像本人程度")
            : null,
        contamination: p.contamination === true,
      },
    });
    await tx.offlineAssignment.update({
      where: { id: a.id },
      data: { status: "COMPLETED" },
    });
    await audit(
      tx,
      actor,
      "OFFLINE_RATING_SUBMITTED",
      "OfflineAssignment",
      a.id,
    );
    return { ok: true };
  });
}
export async function getSafety(actor: Actor) {
  await validateActor(actor);
  staff(actor);
  const list = await prisma.safetyEvent.findMany({
    include: {
      session: {
        include: { dyad: { include: { target: true, friend: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return {
    events: list.map((e) => ({
      id: e.id,
      sessionId: e.sessionId,
      reasonCode: e.reasonCode,
      status: e.status,
      createdAt: iso(e.createdAt),
      acknowledgedAt: iso(e.acknowledgedAt),
      outcome: e.outcome,
      targetName: e.session.dyad.target.pseudonym,
      friendName: e.session.dyad.friend.pseudonym,
    })),
  };
}
export async function resolveSafety(actor: Actor, p: Payload) {
  await validateActor(actor);
  staff(actor);
  return prisma.$transaction(async (tx) => {
    const e = await tx.safetyEvent.findUnique({ where: { id: p.id } });
    demand(e, "未找到安全事件。", 404, "NOT_FOUND");
    const s = await sessionFor(tx, actor, e.sessionId, true);
    if (p.action === "acknowledge") {
      await tx.safetyEvent.update({
        where: { id: e.id },
        data: {
          status: "ACKNOWLEDGED",
          acknowledgedBy: actor.id,
          acknowledgedAt: new Date(),
        },
      });
      if (s.status === "PAUSED_SAFETY")
        await stop(tx, actor, s, "STAFF_CONTACT", "STAFF_ACKNOWLEDGED");
    } else {
      demand(p.action === "resolve", "安全操作无效。", 422, "INVALID_INPUT");
      await tx.safetyEvent.update({
        where: { id: e.id },
        data: {
          status: "RESOLVED",
          acknowledgedBy: actor.id,
          acknowledgedAt: e.acknowledgedAt ?? new Date(),
          resolvedAt: new Date(),
          outcome: [
            "ENDED",
            "REFERRED",
            "PARTICIPANT_EXITED",
            "SYNTHETIC_REVIEW_COMPLETE",
          ].includes(p.outcome)
            ? p.outcome
            : "SYNTHETIC_REVIEW_COMPLETE",
        },
      });
      if (!["ENDED", "WITHDRAWN"].includes(s.status))
        await stop(tx, actor, s, "ENDED", "SAFETY_RESOLVED");
    }
    await audit(
      tx,
      actor,
      "SAFETY_" + p.action.toUpperCase(),
      "SafetyEvent",
      e.id,
    );
    return { ok: true };
  });
}
export async function getAudit(actor: Actor) {
  await validateActor(actor);
  demand(["RESEARCHER", "ANALYST"].includes(actor.role));
  const events = await prisma.auditEvent.findMany({
    where: syntheticAudit,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return {
    events: events.map((e) =>
      actor.role === "RESEARCHER"
        ? {
            ...e,
            actorId: e.actorId?.startsWith("demo-") ? e.actorId : null,
            createdAt: iso(e.createdAt),
          }
        : {
            id: e.id,
            action: e.action,
            entityType: e.entityType,
            createdAt: iso(e.createdAt),
          },
    ),
  };
}

export async function requestWithdrawal(actor: Actor, p: Payload) {
  await validateActor(actor);
  demand(actor.role === "FRIEND" || actor.role === "TARGET");
  const mode =
    p.mode === "CONTENT_DESTRUCTION_WITH_AUDIT_STUB"
      ? "CONTENT_DESTRUCTION"
      : p.mode;
  demand(
    ["ANALYSIS_EXCLUSION", "CONTENT_DESTRUCTION"].includes(mode),
    "请明确选择分析排除或内容销毁。",
    422,
    "INVALID_INPUT",
  );
  const scope = p.scope ?? "ALL";
  demand(
    ["ALL", "SESSION"].includes(scope),
    "撤回范围无效。",
    422,
    "INVALID_INPUT",
  );
  demand(
    scope !== "SESSION" || typeof p.sessionId === "string",
    "请选择要撤回的会话。",
    422,
    "INVALID_INPUT",
  );
  return prisma.$transaction(
    async (tx) => {
      const sessions =
        scope === "SESSION"
          ? [await sessionFor(tx, actor, p.sessionId, true)]
          : await tx.session.findMany({
              where: {
                dyad: { OR: [{ targetId: actor.id }, { friendId: actor.id }] },
              },
            });
      const sessionIds = sessions.map((s) => s.id);
      const request = await tx.withdrawalRequest.create({
        data: {
          participantId: actor.id,
          mode,
          scope,
          sessionId: scope === "SESSION" ? p.sessionId : null,
          affectedCounts: {},
        },
      });
      for (const s of sessions) {
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${s.id} FOR UPDATE`;
        const current = await tx.session.findUniqueOrThrow({
          where: { id: s.id },
        });
        await stop(tx, actor, current, "WITHDRAWN", mode);
      }
      await tx.liveSurvey.updateMany({
        where: {
          OR: [{ sessionId: { in: sessionIds } }, { participantId: actor.id }],
        },
        data: { excluded: true },
      });
      const stimuli = await tx.stimulusExcerpt.findMany({
        where: { sessionId: { in: sessionIds } },
      });
      const stimulusIds = stimuli.map((s) => s.id);
      const assignments = await tx.offlineAssignment.findMany({
        where: {
          OR: [
            { stimulusId: { in: stimulusIds } },
            ...(scope === "ALL" ? [{ participantId: actor.id }] : []),
          ],
        },
      });
      const assignmentIds = assignments.map((a) => a.id);
      await tx.offlineAssignment.updateMany({
        where: { id: { in: assignmentIds } },
        data: { status: "REVOKED" },
      });
      await tx.offlineRating.updateMany({
        where: { assignmentId: { in: assignmentIds } },
        data: { excluded: true },
      });
      await tx.matchedRating.updateMany({
        where: {
          OR: [
            { stimulusId: { in: stimulusIds } },
            ...(scope === "ALL" ? [{ participantId: actor.id }] : []),
          ],
        },
        data: { excluded: true },
      });
      await tx.relationshipTimepoint.updateMany({
        where: {
          participantId: actor.id,
          ...(scope === "SESSION"
            ? { dyadId: { in: sessions.map((s) => s.dyadId) } }
            : {}),
        },
        data: { excluded: true },
      });
      const now = new Date();
      let corpusCount = 0;
      let derivedCount = 0;
      let messageCount = 0;
      if (mode === "CONTENT_DESTRUCTION") {
        const messages = await tx.message.findMany({
          where: { sessionId: { in: sessionIds } },
          select: { id: true },
        });
        messageCount = messages.length;
        const tombstones: Prisma.DeletionTombstoneCreateManyInput[] = [
          ...sessionIds.map((id) => ({
            requestId: request.id,
            entityType: "Session",
            entityId: id,
          })),
          ...messages.map((m) => ({
            requestId: request.id,
            entityType: "Message",
            entityId: m.id,
          })),
          ...stimulusIds.map((id) => ({
            requestId: request.id,
            entityType: "StimulusExcerpt",
            entityId: id,
          })),
        ];
        await tx.session.updateMany({
          where: { id: { in: sessionIds } },
          data: { destroyedAt: now, excluded: true },
        });
        await tx.message.updateMany({
          where: { sessionId: { in: sessionIds } },
          data: { text: null, destroyedAt: now },
        });
        await tx.outbox.updateMany({
          where: { sessionId: { in: sessionIds } },
          data: { text: null, status: "CANCELLED" },
        });
        await tx.liveSurvey.updateMany({
          where: { sessionId: { in: sessionIds } },
          data: { reason: null, answers: { destroyed: true } },
        });
        await tx.stimulusExcerpt.updateMany({
          where: { id: { in: stimulusIds } },
          data: {
            text: null,
            context: null,
            sourceMessageIds: [],
            status: "DESTROYED",
            destroyedAt: now,
          },
        });
        if (actor.role === "TARGET" && scope === "ALL") {
          const [corpus, personas, knowledge] = await Promise.all([
            tx.corpusItem.findMany({ where: { targetId: actor.id } }),
            tx.personaVersion.findMany({ where: { targetId: actor.id } }),
            tx.knowledgeItem.findMany({ where: { targetId: actor.id } }),
          ]);
          corpusCount = corpus.length;
          derivedCount = personas.length + knowledge.length;
          tombstones.push(
            ...corpus.map((c) => ({
              requestId: request.id,
              entityType: "CorpusItem",
              entityId: c.id,
              contentHash: c.contentHash,
            })),
            ...personas.map((c) => ({
              requestId: request.id,
              entityType: "PersonaVersion",
              entityId: c.id,
            })),
            ...knowledge.map((c) => ({
              requestId: request.id,
              entityType: "KnowledgeItem",
              entityId: c.id,
            })),
            {
              requestId: request.id,
              entityType: "ParticipantDerived",
              entityId: actor.id,
            },
          );
          await tx.corpusItem.updateMany({
            where: { targetId: actor.id },
            data: {
              text: null,
              riskCodes: [],
              reviewStatus: "DESTROYED",
              destroyedAt: now,
            },
          });
          await tx.personaVersion.updateMany({
            where: { targetId: actor.id },
            data: {
              style: {},
              interaction: {},
              boundaries: [],
              buildCorpusIds: [],
              status: "DESTROYED",
              destroyedAt: now,
            },
          });
          await tx.knowledgeItem.updateMany({
            where: { targetId: actor.id },
            data: { text: null, approved: false, destroyedAt: now },
          });
          await tx.calibrationAnswer.updateMany({
            where: { targetId: actor.id },
            data: { answer: null },
          });
          await tx.baselineSample.deleteMany({ where: { targetId: actor.id } });
        }
        await tx.deletionTombstone.createMany({
          data: tombstones,
          skipDuplicates: true,
        });
      }
      if (scope === "ALL")
        await tx.consent.create({
          data: {
            participantId: actor.id,
            participation: false,
            aiProcessing: false,
            corpusUse: false,
            secondarySharing: false,
            familiarSharing: false,
            unfamiliarSharing: false,
            targetReview: false,
            quotation: false,
            revokedAt: now,
          },
        });
      await tx.exportManifest.updateMany({
        where: { status: "VALID" },
        data: {
          status: "INVALIDATED",
          invalidatedAt: now,
          invalidationReason: "PARTICIPANT_WITHDRAWAL",
        },
      });
      const counts = {
        sessions: sessionIds.length,
        messages: messageCount,
        stimuli: stimulusIds.length,
        assignments: assignmentIds.length,
        corpus: corpusCount,
        derived: derivedCount,
      };
      await tx.withdrawalRequest.update({
        where: { id: request.id },
        data: {
          status: "COMPLETED",
          affectedCounts: counts,
          completedAt: now,
          backupPurgeDue:
            mode === "CONTENT_DESTRUCTION"
              ? new Date(now.getTime() + 30 * 86400000)
              : null,
        },
      });
      await audit(
        tx,
        actor,
        "WITHDRAWAL_COMPLETED",
        "WithdrawalRequest",
        request.id,
        {
          mode,
          scope,
          counts,
          backupPolicy: "SYNTHETIC_NO_PRODUCTION_BACKUPS",
        },
      );
      return {
        ok: true,
        requestId: request.id,
        status: "COMPLETED",
        affectedCounts: counts,
      };
    },
    { timeout: 60000 },
  );
}
/** Mandatory restore step: tombstones must come from the live deletion ledger, not the restored snapshot. */
export async function reapplyDeletionTombstones() {
  const ledger = await prisma.deletionTombstone.findMany({
    where: { entityType: { not: "PreparationMessage" } },
  });
  if (!ledger.length) return { ok: true, tombstones: 0 };
  const ids = (type: string) =>
    ledger.filter((t) => t.entityType === type).map((t) => t.entityId);
  const now = new Date();
  await prisma.$transaction(
    async (tx) => {
      const sessionIds = ids("Session");
      await tx.session.updateMany({
        where: { id: { in: sessionIds } },
        data: {
          status: "WITHDRAWN",
          excluded: true,
          destroyedAt: now,
          currentTurnId: null,
          epoch: { increment: 1 },
        },
      });
      await tx.message.updateMany({
        where: {
          OR: [
            { id: { in: ids("Message") } },
            { sessionId: { in: sessionIds } },
          ],
        },
        data: { text: null, destroyedAt: now },
      });
      await tx.outbox.updateMany({
        where: { sessionId: { in: sessionIds } },
        data: { text: null, status: "CANCELLED" },
      });
      await tx.generation.updateMany({
        where: { sessionId: { in: sessionIds } },
        data: { status: "CANCELLED", cancelledAt: now },
      });
      await tx.liveSurvey.updateMany({
        where: { sessionId: { in: sessionIds } },
        data: { reason: null, answers: { destroyed: true }, excluded: true },
      });
      await tx.stimulusExcerpt.updateMany({
        where: {
          OR: [
            { id: { in: ids("StimulusExcerpt") } },
            { sessionId: { in: sessionIds } },
          ],
        },
        data: {
          text: null,
          context: null,
          sourceMessageIds: [],
          status: "DESTROYED",
          destroyedAt: now,
        },
      });
      await tx.corpusItem.updateMany({
        where: { id: { in: ids("CorpusItem") } },
        data: {
          text: null,
          riskCodes: [],
          reviewStatus: "DESTROYED",
          destroyedAt: now,
        },
      });
      await tx.personaVersion.updateMany({
        where: { id: { in: ids("PersonaVersion") } },
        data: {
          style: {},
          interaction: {},
          boundaries: [],
          buildCorpusIds: [],
          status: "DESTROYED",
          destroyedAt: now,
        },
      });
      await tx.knowledgeItem.updateMany({
        where: { id: { in: ids("KnowledgeItem") } },
        data: { text: null, approved: false, destroyedAt: now },
      });
      await tx.calibrationAnswer.updateMany({
        where: { targetId: { in: ids("ParticipantDerived") } },
        data: { answer: null },
      });
      await tx.baselineSample.deleteMany({
        where: { targetId: { in: ids("ParticipantDerived") } },
      });
      const stimuli = await tx.stimulusExcerpt.findMany({
        where: { status: "DESTROYED" },
        select: { id: true },
      });
      const assignments = await tx.offlineAssignment.findMany({
        where: { stimulusId: { in: stimuli.map((s) => s.id) } },
        select: { id: true },
      });
      await tx.offlineAssignment.updateMany({
        where: { id: { in: assignments.map((a) => a.id) } },
        data: { status: "REVOKED" },
      });
      await tx.offlineRating.updateMany({
        where: { assignmentId: { in: assignments.map((a) => a.id) } },
        data: { excluded: true },
      });
      await tx.matchedRating.updateMany({
        where: { stimulusId: { in: stimuli.map((s) => s.id) } },
        data: { excluded: true },
      });
      await tx.exportManifest.updateMany({
        where: { status: "VALID" },
        data: {
          status: "INVALIDATED",
          invalidatedAt: now,
          invalidationReason: "RESTORE_TOMBSTONE_REAPPLICATION",
        },
      });
      await audit(tx, null, "RESTORE_TOMBSTONES_REAPPLIED", "Study", STUDY_ID, {
        tombstones: ledger.length,
      });
    },
    { timeout: 60000 },
  );
  return { ok: true, tombstones: ledger.length };
}
export async function getWithdrawals(actor: Actor) {
  await validateActor(actor);
  demand(actor.role !== "ANALYST");
  const requests = await prisma.withdrawalRequest.findMany({
    where: {
      participant: syntheticParticipant,
      scope: { not: "PORTAL_PREPARATION" },
      ...(actor.role === "RESEARCHER" ? {} : { participantId: actor.id }),
    },
    orderBy: { requestedAt: "desc" },
  });
  return {
    requests: requests.map((r) => ({
      ...r,
      requestedAt: iso(r.requestedAt),
      completedAt: iso(r.completedAt),
      backupPurgeDue: iso(r.backupPurgeDue),
    })),
  };
}
function csv(name: string, headers: string[], rows: unknown[][]) {
  return {
    name,
    rows: rows.length,
    content:
      "\uFEFF" +
      [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
      "\r\n",
  };
}
export async function getExport(actor: Actor) {
  await validateActor(actor);
  demand(actor.role === "RESEARCHER" || actor.role === "ANALYST");
  const masked = actor.role === "ANALYST";
  const [sessions, messages, surveys, matched, offline, relationship] =
    await Promise.all([
      prisma.session.findMany({
        include: { dyad: true },
        orderBy: { id: "asc" },
      }),
      prisma.message.findMany({
        include: { session: { include: { dyad: true } } },
        orderBy: [{ sessionId: "asc" }, { sequence: "asc" }],
      }),
      prisma.liveSurvey.findMany({
        include: { session: { include: { dyad: true } } },
      }),
      prisma.matchedRating.findMany({
        include: {
          stimulus: { include: { session: { include: { dyad: true } } } },
        },
      }),
      prisma.offlineRating.findMany({
        include: {
          assignment: {
            include: {
              stimulus: { include: { session: { include: { dyad: true } } } },
            },
          },
        },
      }),
      prisma.relationshipTimepoint.findMany(),
    ]);
  const source = (v: string) =>
    masked ? (v === "AI" ? "MASK_B" : "MASK_A") : v;
  const files = [
    csv(
      "sessions.csv",
      [
        "session_id",
        "dyad_id",
        "target_id",
        "friend_id",
        "session_index",
        "source",
        "assigned_topic",
        "actual_topic",
        "status",
        "excluded",
        "started_at_utc",
        "ended_at_utc",
      ],
      sessions.map((s) => [
        s.id,
        s.dyadId,
        s.dyad.targetId,
        s.dyad.friendId,
        s.index,
        source(s.privateCondition),
        s.assignedTopic,
        s.actualTopic,
        s.status,
        s.excluded,
        iso(s.startedAt),
        iso(s.endedAt),
      ]),
    ),
    csv(
      "messages.csv",
      [
        "message_id",
        "session_id",
        "dyad_id",
        "target_id",
        "sequence",
        "public_role",
        "delivery_status",
        "generated_at_utc",
        "delivered_at_utc",
        "acknowledged_at_utc",
        "content_destroyed",
      ],
      messages.map((m) => [
        m.id,
        m.sessionId,
        m.session.dyadId,
        m.session.dyad.targetId,
        m.sequence,
        m.publicRole,
        m.status,
        iso(m.generatedAt),
        iso(m.deliveredAt),
        iso(m.acknowledgedAt),
        Boolean(m.destroyedAt),
      ]),
    ),
    csv(
      "live_surveys.csv",
      [
        "survey_id",
        "session_id",
        "dyad_id",
        "target_id",
        "participant_id",
        "guess",
        "confidence",
        "p_ai",
        "person_likeness",
        "relational_fit",
        "naturalness",
        "trust",
        "comfort",
        "excluded",
        "submitted_at_utc",
      ],
      surveys.map((s) => [
        s.id,
        s.sessionId,
        s.session.dyadId,
        s.session.dyad.targetId,
        s.participantId,
        s.guess,
        s.confidence,
        s.pAI,
        s.likeness,
        s.relationalFit,
        s.naturalness,
        s.trust,
        s.comfort,
        s.excluded,
        iso(s.submittedAt),
      ]),
    ),
    csv(
      "matched_ratings.csv",
      [
        "rating_id",
        "stimulus_id",
        "session_id",
        "dyad_id",
        "target_id",
        "participant_id",
        "role",
        "track",
        "source",
        "context_version",
        "context_hash",
        "source_disclosed",
        "likeness",
        "predicted_friend_rating",
        "endorsement",
        "excluded",
      ],
      matched.map((r) => [
        r.id,
        r.stimulusId,
        r.stimulus.sessionId,
        r.stimulus.session.dyadId,
        r.stimulus.session.dyad.targetId,
        r.participantId,
        r.role,
        r.track,
        source(r.stimulus.privateCondition),
        r.contextVersion,
        r.contextHash,
        r.sourceDisclosed,
        r.likeness,
        r.predictedFriendRating,
        r.endorsement,
        r.excluded,
      ]),
    ),
    csv(
      "offline_ratings.csv",
      [
        "rating_id",
        "stimulus_id",
        "rater_id",
        "familiarity_role",
        "session_id",
        "dyad_id",
        "target_id",
        "source",
        "guess",
        "confidence",
        "p_ai",
        "naturalness",
        "person_likeness",
        "consent_valid_at_submission",
        "contamination",
        "excluded",
        "submitted_at_utc",
      ],
      offline.map((r) => [
        r.id,
        r.assignment.stimulusId,
        r.assignment.participantId,
        r.assignment.familiarityRole,
        r.assignment.stimulus.sessionId,
        r.assignment.stimulus.session.dyadId,
        r.assignment.stimulus.session.dyad.targetId,
        source(r.assignment.stimulus.privateCondition),
        r.guess,
        r.confidence,
        r.pAI,
        r.naturalness,
        r.personLikeness,
        true,
        r.contamination,
        r.excluded,
        iso(r.submittedAt),
      ]),
    ),
    csv(
      "relationship_timepoints.csv",
      [
        "id",
        "dyad_id",
        "participant_id",
        "timepoint",
        "ios_1_to_7",
        "excluded",
        "submitted_at_utc",
      ],
      relationship.map((r) => [
        r.id,
        r.dyadId,
        r.participantId,
        r.timepoint,
        r.ios,
        r.excluded,
        iso(r.submittedAt),
      ]),
    ),
  ];
  const manifest = await prisma.exportManifest.create({
    data: {
      actorId: actor.id,
      datasetNames: files.map((f) => f.name),
      participantIds: Array.from(
        new Set(sessions.flatMap((s) => [s.dyad.targetId, s.dyad.friendId])),
      ),
      checksums: Object.fromEntries(
        files.map((f) => [
          f.name,
          createHash("sha256").update(f.content).digest("hex"),
        ]),
      ),
    },
  });
  await audit(
    prisma,
    actor,
    "RESEARCH_EXPORT_GENERATED",
    "ExportManifest",
    manifest.id,
    { datasets: 6, textIncluded: false, masked },
  );
  return {
    manifest: {
      id: manifest.id,
      status: manifest.status,
      createdAt: iso(manifest.createdAt),
      checksums: manifest.checksums,
      synthetic: true,
      textIncluded: false,
      sourceMasked: masked,
    },
    files,
    dictionary: {
      encoding: "UTF-8 BOM",
      null: "\\N",
      empty: '""',
      timestamps: "ISO-8601 UTC",
      confidence: "50–100; confidence in chosen answer",
      p_ai: "AI:confidence/100; HUMAN:1−confidence/100",
      ios: "1–7",
      ratings: "1–5",
      text: "正文导出未授权，默认只含结构化元数据。",
      withdrawal:
        "分析排除保留分母并标记 excluded；内容销毁移除正文；旧 manifest 失效。",
      limitations:
        "合成系统不声称已完成独立统计功效、临床风险识别或正式环境认证。",
    },
  };
}
export async function getRelationship(actor: Actor) {
  await validateActor(actor);
  demand(["FRIEND", "TARGET"].includes(actor.role));
  const dyads = await prisma.dyad.findMany({
    where: { OR: [{ targetId: actor.id }, { friendId: actor.id }] },
    include: { target: true, friend: true },
  });
  const ratings = await prisma.relationshipTimepoint.findMany({
    where: { participantId: actor.id },
  });
  return {
    dyads: dyads.map((d) => ({
      id: d.id,
      targetName: d.target.pseudonym,
      friendName: d.friend.pseudonym,
    })),
    ratings: ratings.map((r) => ({
      id: r.id,
      dyadId: r.dyadId,
      timepoint: r.timepoint,
      ios: r.ios,
      submittedAt: iso(r.submittedAt),
    })),
  };
}
export async function saveRelationship(actor: Actor, p: Payload) {
  await validateActor(actor);
  demand(["FRIEND", "TARGET"].includes(actor.role));
  const d = await prisma.dyad.findUnique({ where: { id: p.dyadId } });
  demand(d && (d.friendId === actor.id || d.targetId === actor.id));
  const timepoint = String(p.timepoint ?? "BASELINE").toUpperCase();
  demand(
    ["BASELINE", "PRE_DEBRIEF", "POST_DEBRIEF"].includes(timepoint),
    "时间点无效。",
    422,
    "INVALID_INPUT",
  );
  const ios = intRange(p.ios, 1, 7, "关系亲密度");
  const sessions = await prisma.session.findMany({ where: { dyadId: d.id } });
  const debriefed = await prisma.debriefRecord.count({
    where: { participantId: actor.id },
  });
  if (timepoint === "BASELINE")
    demand(
      !sessions.some((s) => s.startedAt),
      "基线窗口已结束。",
      409,
      "TIMEPOINT_CLOSED",
    );
  if (timepoint === "PRE_DEBRIEF")
    demand(
      sessions.every((s) => ["ENDED", "WITHDRAWN"].includes(s.status)) &&
        !debriefed,
      "需在全部场次结束且具体来源揭示前填写；提前退出可直接跳过。",
      409,
      "TIMEPOINT_CLOSED",
    );
  if (timepoint === "POST_DEBRIEF")
    demand(debriefed > 0, "请先阅读研究说明。", 409, "TIMEPOINT_CLOSED");
  const existing = await prisma.relationshipTimepoint.findUnique({
    where: {
      dyadId_participantId_timepoint: {
        dyadId: d.id,
        participantId: actor.id,
        timepoint,
      },
    },
  });
  demand(!existing, "此时间点已提交，不能修改。", 409, "LOCKED");
  await prisma.relationshipTimepoint.create({
    data: { dyadId: d.id, participantId: actor.id, timepoint, ios },
  });
  await audit(prisma, actor, "RELATIONSHIP_SUBMITTED", "Dyad", d.id, {
    timepoint,
    skipped: ios === null,
  });
  return { ok: true };
}
export async function debrief(actor: Actor, p: Payload = {}) {
  await validateActor(actor);
  demand(["FRIEND", "TARGET"].includes(actor.role));
  return prisma.$transaction(async (tx) => {
    const sessions = p.sessionId
      ? [await sessionFor(tx, actor, p.sessionId, true)]
      : await tx.session.findMany({ where: sessionWhere(actor) });
    for (const s of sessions) {
      if (!["ENDED", "WITHDRAWN", "SCHEDULED"].includes(s.status)) {
        await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${s.id} FOR UPDATE`;
        const current = await tx.session.findUniqueOrThrow({
          where: { id: s.id },
        });
        await stop(tx, actor, current, "ENDED", "EARLY_DEBRIEF_REQUEST");
      }
    }
    await tx.debriefRecord.create({
      data: {
        participantId: actor.id,
        revealRequested: p.reveal === true,
        countingStrategy: p.countingStrategy === true,
        inferredRatio: p.inferredRatio === true,
      },
    });
    if (p.reveal === true)
      await tx.sourceRevealGrant.createMany({
        data: sessions
          .filter((s) => s.startedAt && !s.destroyedAt)
          .map((s) => ({ participantId: actor.id, sessionId: s.id })),
        skipDuplicates: true,
      });
    await audit(tx, actor, "DEBRIEF_REQUESTED", "Participant", actor.id, {
      countingStrategy: p.countingStrategy === true,
      inferredRatio: p.inferredRatio === true,
    });
    return {
      ok: true,
      title: "研究说明与自主退出",
      explanation:
        "这项研究比较本人和 AI 文字分身在日常交流中的体验。它不是友情、关心程度或智力测试。你可以停止、请求撤回，或选择查看已经参与场次的来源。不会展示彼此的私下评价。",
      sources:
        p.reveal === true
          ? sessions
              .filter((s) => s.startedAt && !s.destroyedAt)
              .map((s) => ({
                sessionId: s.id,
                index: s.index,
                source: s.privateCondition,
              }))
          : [],
    };
  });
}
export async function query(actor: Actor, view: string, id?: string) {
  switch (view) {
    case "dashboard":
      return getDashboard(actor);
    case "sessions":
      return getSessions(actor);
    case "session":
      demand(id, "缺少会话。", 422, "INVALID_INPUT");
      return getSession(actor, id);
    case "onboarding":
      return getOnboarding(actor);
    case "offline":
      return getOffline(actor);
    case "consent":
      return getConsent(actor);
    case "safety":
      return getSafety(actor);
    case "audit":
      return getAudit(actor);
    case "withdrawals":
      return getWithdrawals(actor);
    case "export":
      return getExport(actor);
    case "study":
      return getStudyConfig(actor);
    case "relationship":
      return getRelationship(actor);
    default:
      throw new ApiError(404, "NOT_FOUND", "找不到此研究页面。");
  }
}
export async function execute(
  actor: Actor,
  action: string,
  payload: Payload = {},
) {
  switch (action) {
    case "importCorpus":
      return importCorpus(actor, payload);
    case "approveCorpus":
      return approveCorpus(actor, payload);
    case "buildPersona":
      return buildPersona(actor);
    case "freezePersona":
      return freezePersona(actor, payload);
    case "submitOffline":
      return submitOffline(actor, payload);
    case "submitSurvey":
      return submitSurvey(actor, payload);
    case "saveConsent":
      return saveConsent(actor, payload);
    case "controlSession":
      return controlSession(actor, payload);
    case "sendMessage":
      return sendMessage(actor, payload);
    case "ackMessage":
      return ackMessage(actor, payload);
    case "resolveSafety":
      return resolveSafety(actor, payload);
    case "requestWithdrawal":
      return requestWithdrawal(actor, payload);
    case "saveRelationship":
      return saveRelationship(actor, payload);
    case "debrief":
      return debrief(actor, payload);
    default:
      throw new ApiError(404, "NOT_FOUND", "不支持此研究操作。");
  }
}
