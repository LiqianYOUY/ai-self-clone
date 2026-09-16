import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import type { Actor } from "../domain/types";
import { scanPII, nearDuplicate } from "../domain/privacy";
import { generateReply } from "../domain/provider";
import { ApiError } from "./engine";
import { hashText } from "./seed";

class InputError extends ApiError {
  constructor() {
    super(422, "INVALID_INPUT", "请检查输入内容。");
  }
}
async function authorized(actor: Actor) {
  const user = await prisma.participant.findUnique({ where: { id: actor.id } });
  const consent = await prisma.consent.findFirst({
    where: { participantId: actor.id },
    orderBy: { recordedAt: "desc" },
  });
  if (
    actor.role !== "TARGET" ||
    !user?.active ||
    user.role !== actor.role ||
    !consent?.participation ||
    !consent.corpusUse ||
    consent.revokedAt
  )
    throw new ApiError(403, "FORBIDDEN", "无权访问此研究数据。");
}
export const CALIBRATION_QUESTIONS = [
  "你通常怎么开始一段轻松的聊天？",
  "朋友分享好消息时，你会怎么回应？",
  "你喜欢用哪些语气词？",
  "你通常使用哪些标点或 emoji？",
  "一条消息通常多长？会拆成几条吗？",
  "中文与英文会怎样混用？",
  "你喜欢怎样结束一段聊天？",
  "面对记不清的往事，你会怎么说？",
  "不想聊某个话题时，你会怎么表达？",
  "最近有哪些可以公开的日常爱好？",
  "你喜欢安静的活动还是热闹的活动？",
  "只是假设周末有空，你会提议做什么？",
  "朋友说今天有点累，你会怎样简单回应？",
  "如何温和拒绝一个不方便答应的请求？",
  "哪些交流需要由你本人确认？",
];
export async function getDevelopment(actor: Actor) {
  await authorized(actor);
  const [answers, previews, baseline, personas] = await Promise.all([
    prisma.calibrationAnswer.findMany({
      where: { targetId: actor.id },
      orderBy: { questionId: "asc" },
    }),
    prisma.corpusItem.findMany({
      where: { targetId: actor.id, partition: "DEV", destroyedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.baselineSample.findMany({
      where: { targetId: actor.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.personaVersion.findMany({
      where: { targetId: actor.id, status: "DRAFT", destroyedAt: null },
      orderBy: { version: "desc" },
    }),
  ]);
  return {
    questions: CALIBRATION_QUESTIONS.map((text, index) => ({
      id: `calibration-${String(index + 1).padStart(2, "0")}`,
      text,
    })),
    answers: answers.map((a) => ({
      questionId: a.questionId,
      answer: a.answer,
    })),
    previews: previews.map((p) => ({
      id: p.id,
      text: p.text,
      createdAt: p.createdAt.toISOString(),
    })),
    baseline: baseline.map((b) => ({
      id: b.id,
      responseMs: b.responseMs,
      firstInputToSendMs: b.firstInputToSendMs,
      device: b.device,
      createdAt: b.createdAt.toISOString(),
    })),
    drafts: personas.map((p) => ({
      id: p.id,
      version: p.version,
      previewCount: p.previewCount,
    })),
  };
}
export async function saveCalibration(
  actor: Actor,
  p: Record<string, unknown>,
) {
  await authorized(actor);
  if (
    typeof p.questionId !== "string" ||
    !/^calibration-(0[1-9]|1[0-5])$/.test(p.questionId) ||
    typeof p.answer !== "string" ||
    !p.answer.trim() ||
    p.answer.length > 1500 ||
    scanPII(p.answer).length
  )
    throw new InputError();
  const answer = p.answer.trim();
  const id = p.questionId;
  return prisma.$transaction(async (tx) => {
    const prior = await tx.calibrationAnswer.findUnique({
      where: { targetId_questionId: { targetId: actor.id, questionId: id } },
    });
    if (prior) throw Object.assign(new InputError(), { code: "LOCKED" });
    await tx.calibrationAnswer.create({
      data: { targetId: actor.id, questionId: id, answer, partition: "BUILD" },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: "CALIBRATION_SAVED",
        entityType: "Participant",
        entityId: actor.id,
        metadata: { questionId: id },
      },
    });
    return { ok: true };
  });
}
const practices = new Map<
  string,
  { actorId: string; startedAt: number; expiresAt: number }
>();
export async function beginPractice(actor: Actor) {
  await authorized(actor);
  for (const [key, p] of practices)
    if (p.expiresAt < Date.now()) practices.delete(key);
  if (practices.size > 500) throw new InputError();
  const token = randomUUID();
  const startedAt = Date.now();
  practices.set(token, {
    actorId: actor.id,
    startedAt,
    expiresAt: startedAt + 600000,
  });
  return {
    token,
    prompt: "假设今天有一段空闲，你会想做什么轻松的事？",
    startedAt: new Date(startedAt).toISOString(),
  };
}
export async function finishPractice(actor: Actor, p: Record<string, unknown>) {
  await authorized(actor);
  const practice = practices.get(String(p.token));
  if (
    !practice ||
    practice.actorId !== actor.id ||
    practice.expiresAt < Date.now()
  )
    throw new InputError();
  const responseMs = Date.now() - practice.startedAt;
  const firstInputToSendMs = Number(p.firstInputToSendMs);
  if (
    !Number.isSafeInteger(firstInputToSendMs) ||
    firstInputToSendMs < 0 ||
    firstInputToSendMs > responseMs + 2000 ||
    responseMs > 600000
  )
    throw new InputError();
  if (!["COMPUTER", "PHONE", "TABLET", "OTHER"].includes(String(p.device)))
    throw new InputError();
  practices.delete(String(p.token));
  await prisma.baselineSample.create({
    data: {
      targetId: actor.id,
      responseMs,
      firstInputToSendMs,
      burstCount: 1,
      device: String(p.device),
      inputTool: "SELF_REPORTED_STANDARD_INPUT",
    },
  });
  await prisma.auditEvent.create({
    data: {
      actorId: actor.id,
      action: "PRACTICE_TIMING_SAVED",
      entityType: "Participant",
      entityId: actor.id,
      metadata: { serverResponseMs: responseMs, clientTimingUntrusted: true },
    },
  });
  return { ok: true, responseMs, support: "LOW_SUPPORT" };
}
export async function previewPersona(actor: Actor, p: Record<string, unknown>) {
  await authorized(actor);
  if (
    typeof p.prompt !== "string" ||
    !p.prompt.trim() ||
    p.prompt.length > 1500 ||
    scanPII(p.prompt).length
  )
    throw new InputError();
  const prompt = p.prompt.trim();
  const started = Date.now();
  const persona = await prisma.personaVersion.findFirst({
    where: {
      id: typeof p.personaId === "string" ? p.personaId : undefined,
      targetId: actor.id,
      status: "DRAFT",
      destroyedAt: null,
    },
    orderBy: { version: "desc" },
  });
  if (!persona)
    throw Object.assign(new InputError(), { code: "PERSONA_REQUIRED" });
  const holdout = await prisma.corpusItem.findMany({
    where: { targetId: actor.id, partition: "HOLDOUT", destroyedAt: null },
  });
  if (holdout.some((h) => nearDuplicate(prompt, h.text ?? "")))
    throw Object.assign(new InputError(), { code: "PARTITION_LEAKAGE" });
  const claimed = await prisma.personaVersion.updateMany({
    where: { id: persona.id, status: "DRAFT", previewCount: { lt: 10 } },
    data: { previewCount: { increment: 1 } },
  });
  if (!claimed.count) throw Object.assign(new InputError(), { code: "LOCKED" });
  const reply = await generateReply(
    {
      targetId: actor.id,
      personaVersion: persona.id,
      pseudonym: actor.pseudonym,
      styleProfile: JSON.stringify(persona.style),
      interactionProfile: JSON.stringify(persona.interaction),
      boundaries: JSON.stringify(persona.boundaries),
      knowledge: [],
      messages: [{ role: "FRIEND", text: prompt }],
    },
    { mode: "SYNTHETIC" },
  );
  await prisma.$transaction(async (tx) => {
    const pNow = await tx.personaVersion.findUnique({
      where: { id: persona.id },
    });
    const consent = await tx.consent.findFirst({
      where: { participantId: actor.id },
      orderBy: { recordedAt: "desc" },
    });
    if (
      pNow?.status !== "DRAFT" ||
      pNow.destroyedAt ||
      !consent?.corpusUse ||
      !consent.participation
    )
      throw Object.assign(new InputError(), { code: "CONSENT_REQUIRED" });
    for (const text of [prompt, ...reply.bursts]) {
      const item = await tx.corpusItem.create({
        data: {
          targetId: actor.id,
          partition: "DEV",
          text,
          contentHash: hashText(text),
          reviewStatus: "APPROVED",
          approvedAt: new Date(),
          riskCodes: [],
        },
      });
      await tx.dataLineage.create({
        data: {
          ownerId: actor.id,
          parentType: "PersonaVersion",
          parentId: persona.id,
          childType: "CorpusItem",
          childId: item.id,
        },
      });
    }
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: "DEV_PREVIEW_COMPLETED",
        entityType: "PersonaVersion",
        entityId: persona.id,
        metadata: {
          elapsedMs: Date.now() - started,
          previewIndex: persona.previewCount + 1,
        },
      },
    });
  });
  return {
    ok: true,
    bursts: reply.bursts,
    notice:
      reply.action === "REPLY"
        ? null
        : "该问题触发了研究边界，请选择其他开发问题。",
    previewCount: persona.previewCount + 1,
  };
}
