import { randomUUID, createHash } from "node:crypto";
import { prisma } from "./db";
import { generatePlan } from "../domain/randomization";
export const STUDY_ID = "synthetic-study";
export const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const SEED_BUILD_TEXTS = [
  "今天试了新口味的茶，还是乌龙比较顺口。",
  "周末想去公园慢慢走一会儿 🌿",
  "哈哈，这个电影我也觉得还不错",
  "嗯嗯，先休息一下再说吧。",
  "如果有半天空闲，我可能会选看展。",
  "有点拿不准，我们可以再看看呀。",
];
const SEED_INDEPENDENT_TEXTS = [
  "假设周末下雨，想听你挑一个室内活动。",
  "看到一盆小绿植，我会怎样自然开启话题？",
  "试着用一句话描述风经过窗边的感觉。",
  "如果书架只能留一种颜色，你会选什么？",
];
const SEED_CALIBRATION_ANSWER = "合成校准：日常短句、允许不确定、尊重退出。";
const seedTargetIds = Array.from(
  { length: 12 },
  (_, i) => `demo-target-${String(i + 1).padStart(2, "0")}`,
);
export async function seedStudy() {
  const existingStudy = await prisma.study.findUnique({
    where: { id: STUDY_ID },
  });
  if (existingStudy) {
    if (existingStudy.mode !== "SYNTHETIC")
      throw new Error(
        "Synthetic seed upgrade is not permitted for a live study",
      );
    await prisma.$transaction(async (tx) => {
      let corpusUpgraded = 0;
      let calibrationUpgraded = 0;
      for (let i = 0; i < SEED_INDEPENDENT_TEXTS.length; i++) {
        const originalText = SEED_BUILD_TEXTS[i] + "（合成练习样本）";
        const text = SEED_INDEPENDENT_TEXTS[i];
        // Match the exact original synthetic fixture identity, never a participant import.
        const updated = await tx.corpusItem.updateMany({
          where: {
            targetId: { in: seedTargetIds },
            source: "SYNTHETIC_FIXTURE",
            partition: i < 2 ? "DEV" : "HOLDOUT",
            text: originalText,
            contentHash: hashText(originalText),
            destroyedAt: null,
          },
          data: { text, contentHash: hashText(text), duplicateOf: null },
        });
        corpusUpgraded += updated.count;
      }
      const calibration = await tx.calibrationAnswer.findMany({
        where: {
          targetId: { in: seedTargetIds },
          partition: "BUILD",
          answer: SEED_CALIBRATION_ANSWER,
        },
      });
      for (const answer of calibration) {
        if (!/^q(?:[1-9]|1[0-5])$/.test(answer.questionId)) continue;
        const questionId =
          "calibration-" + answer.questionId.slice(1).padStart(2, "0");
        if (
          await tx.calibrationAnswer.findUnique({
            where: {
              targetId_questionId: { targetId: answer.targetId, questionId },
            },
          })
        )
          continue;
        await tx.calibrationAnswer.update({
          where: { id: answer.id },
          data: { questionId },
        });
        calibrationUpgraded++;
      }
      if (corpusUpgraded || calibrationUpgraded)
        await tx.auditEvent.create({
          data: {
            action: "SYNTHETIC_SEED_FIXTURES_UPGRADED",
            entityType: "Study",
            entityId: STUDY_ID,
            metadata: {
              fixtureVersion: "independent-partitions-v2",
              corpusUpgraded,
              calibrationUpgraded,
            },
          },
        });
    });
    const missing = await prisma.stimulusExcerpt.findMany({
      where: {
        status: "APPROVED",
        contextVersion: "synthetic-context-v1",
        eligibilityRuleVersion: "synthetic-rule-v1",
        session: { dyad: { studyId: STUDY_ID } },
      },
    });
    for (const stimulus of missing) {
      if (
        Array.isArray(stimulus.sourceMessageIds) &&
        stimulus.sourceMessageIds.length === 0
      ) {
        const sourceMessages = await prisma.message.findMany({
          where: {
            sessionId: stimulus.sessionId,
            publicRole: "SOURCE",
            status: "DELIVERED",
            destroyedAt: null,
          },
          orderBy: { sequence: "asc" },
        });
        await prisma.stimulusExcerpt.update({
          where: { id: stimulus.id },
          data: { sourceMessageIds: sourceMessages.map((m) => m.id) },
        });
      }
    }
    return;
  }
  const plan = generatePlan("is-it-still-you-synthetic-2026-v1");
  await prisma.$transaction(
    async (tx) => {
      await tx.study.create({
        data: {
          id: STUDY_ID,
          name: "Is It Still You?",
          seed: plan.seed,
          algorithmVersion: plan.algorithmVersion,
          assignmentHash: plan.hash,
          balance: JSON.parse(JSON.stringify(plan.balance)),
          frozenAt: new Date(),
          config: {
            syntheticOnly: true,
            provider: "LOCAL_SYNTHETIC",
            protocolApproval: null,
            providerApproval: null,
            staffingPlan: null,
            retentionPolicy: null,
            offlineSampleSize: null,
            latencyTolerance: null,
            measurementVersion: "synthetic-v1",
          },
        },
      });
      const people = [
        { id: "demo-researcher", role: "RESEARCHER", pseudonym: "林研究员" },
        { id: "demo-analyst", role: "ANALYST", pseudonym: "陈分析员" },
      ];
      const targetNames = [
        "林知夏",
        "周远",
        "陈小满",
        "许安",
        "沈一舟",
        "苏乐",
        "江晴",
        "宋南",
        "叶可",
        "陆晨",
        "白鹿",
        "温言",
      ];
      for (let i = 1; i <= 12; i++)
        people.push({
          id: `demo-target-${String(i).padStart(2, "0")}`,
          role: "TARGET",
          pseudonym: targetNames[i - 1],
        });
      for (let i = 1; i <= 36; i++)
        people.push({
          id: `demo-friend-${String(i).padStart(2, "0")}`,
          role: "FRIEND",
          pseudonym: i === 1 ? "夏禾" : `朋友 ${String(i).padStart(2, "0")}`,
        });
      await tx.participant.createMany({ data: people });
      await tx.consent.createMany({
        data: people
          .filter((p) => ["TARGET", "FRIEND"].includes(p.role))
          .map((p) => ({
            participantId: p.id,
            participation: true,
            aiProcessing: true,
            corpusUse: p.role === "TARGET",
            secondarySharing: true,
            familiarSharing: true,
            unfamiliarSharing: true,
            targetReview: true,
            quotation: false,
          })),
      });
      const personaIds = new Map<number, string>();
      for (let i = 1; i <= 12; i++) {
        const targetId = `demo-target-${String(i).padStart(2, "0")}`;
        const corpus = [];
        for (let j = 0; j < 10; j++) {
          const text =
            j < 6 ? SEED_BUILD_TEXTS[j] : SEED_INDEPENDENT_TEXTS[j - 6];
          const c = await tx.corpusItem.create({
            data: {
              targetId,
              partition: j < 6 ? "BUILD" : j < 8 ? "DEV" : "HOLDOUT",
              text,
              contentHash: hashText(text),
              reviewStatus: "APPROVED",
              riskCodes: [],
              approvedAt: new Date(),
              source: "SYNTHETIC_FIXTURE",
            },
          });
          corpus.push(c);
        }
        const p = await tx.personaVersion.create({
          data: {
            targetId,
            version: 1,
            status: "FROZEN",
            style: {
              language: "中文 / 偶尔混合英语",
              sentenceLength: "短句，保留自然分条",
              tone: "温和、轻松",
              particles: ["嗯嗯", "哈哈", "呀"],
              emoji: "偶尔 🌿",
            },
            interaction: {
              opening: "自然回应",
              uncertainty: "缺少共同经历依据时说明不确定",
              memory: "仅当前场次",
            },
            boundaries: ["不形成现实承诺", "不编造共同回忆", "不执行外部行动"],
            buildCorpusIds: corpus.slice(0, 6).map((c) => c.id),
            contentHash: hashText(targetId + "synthetic-v1"),
            frozenAt: new Date(),
          },
        });
        personaIds.set(i, p.id);
        const k = await tx.knowledgeItem.create({
          data: {
            targetId,
            personaVersionId: p.id,
            corpusItemId: corpus[0].id,
            text: "偏好乌龙茶；这是一条获批准的合成偏好。",
          },
        });
        await tx.dataLineage.createMany({
          data: [
            ...corpus.slice(0, 6).map((c) => ({
              ownerId: targetId,
              parentType: "CorpusItem",
              parentId: c.id,
              childType: "PersonaVersion",
              childId: p.id,
            })),
            {
              ownerId: targetId,
              parentType: "CorpusItem",
              parentId: corpus[0].id,
              childType: "KnowledgeItem",
              childId: k.id,
            },
          ],
        });
        await tx.calibrationAnswer.createMany({
          data: Array.from({ length: 15 }, (_, j) => ({
            targetId,
            questionId: `calibration-${String(j + 1).padStart(2, "0")}`,
            answer: "合成校准：日常短句、允许不确定、尊重退出。",
          })),
        });
        await tx.baselineSample.createMany({
          data: Array.from({ length: 6 }, (_, j) => ({
            targetId,
            firstInputToSendMs: 900 + j * 110,
            responseMs: 1500 + j * 120,
            burstCount: 2,
            intervalMs: 450 + j * 20,
            device: "synthetic-desktop",
            inputTool: "synthetic-keyboard",
          })),
        });
      }
      for (const d of plan.dyads) {
        const dyadId = randomUUID();
        const targetId = `demo-target-${String(d.targetIndex).padStart(2, "0")}`;
        const friendNumber = (d.targetIndex - 1) * 3 + d.friendIndex;
        const friendId = `demo-friend-${String(friendNumber).padStart(2, "0")}`;
        await tx.dyad.create({
          data: {
            id: dyadId,
            studyId: STUDY_ID,
            targetId,
            friendId,
            blockIndex: d.targetIndex,
          },
        });
        await tx.familiarityScreen.create({
          data: { participantId: friendId, targetId, knowsTarget: true },
        });
        for (const a of d.sessions) {
          const id = randomUUID();
          let status = "SCHEDULED";
          if (d.dyadIndex === 1)
            status =
              a.index === 1
                ? "ENDED"
                : a.index === 2
                  ? "ACTIVE"
                  : a.index === 3
                    ? "READY"
                    : "SCHEDULED";
          else if (d.dyadIndex === 2)
            status =
              a.index === 1 ? "ENDED" : a.index === 2 ? "READY" : "SCHEDULED";
          else if (d.dyadIndex === 4 && a.index === 1) status = "PAUSED_SAFETY";
          else if (d.dyadIndex < 8 && a.index === 1) status = "ENDED";
          const now = Date.now();
          await tx.session.create({
            data: {
              id,
              dyadId,
              index: a.index,
              privateCondition: a.source,
              assignedTopic: a.topic,
              actualTopic: a.topic,
              status,
              excluded: status === "PAUSED_SAFETY",
              personaVersionId: personaIds.get(d.targetIndex),
              scheduledAt: new Date(
                now + (a.index - 2) * 86400000 + (d.dyadIndex - 1) * 3600000,
              ),
              startedAt: ["ENDED", "ACTIVE", "PAUSED_SAFETY"].includes(status)
                ? new Date(now - 600000)
                : null,
              endedAt: status === "ENDED" ? new Date(now - 300000) : null,
              nextSequence: ["ENDED", "ACTIVE"].includes(status) ? 5 : 1,
            },
          });
          if (["ENDED", "ACTIVE"].includes(status)) {
            const entries = [
              [
                "STUDY_NOTICE",
                "欢迎进入合成研究对话。两种来源均可能出现，你可以随时跳题、暂停或结束。",
              ],
              ["FRIEND", "最近终于有时间慢下来啦，你呢？"],
              ["SOURCE", "听起来不错呀 🌿"],
              ["SOURCE", "如果有半天空闲，我想去公园走走。"],
            ];
            for (let j = 0; j < entries.length; j++)
              await tx.message.create({
                data: {
                  sessionId: id,
                  sequence: j + 1,
                  publicRole: entries[j][0],
                  text: entries[j][1],
                  epoch: 0,
                  deliveredAt: new Date(now - 500000 + j * 1500),
                  acknowledgedAt: new Date(now - 490000 + j * 1500),
                },
              });
          }
          if (status === "PAUSED_SAFETY")
            await tx.safetyEvent.create({
              data: { sessionId: id, reasonCode: "SYNTHETIC_STAFF_REVIEW" },
            });
          if (status === "ENDED") {
            await tx.liveSurvey.create({
              data: {
                sessionId: id,
                participantId: friendId,
                guess: d.dyadIndex % 2 ? "HUMAN" : "AI",
                confidence: 70,
                pAI: d.dyadIndex % 2 ? 0.3 : 0.7,
                likeness: 4,
                relationalFit: 4,
                naturalness: 4,
                trust: 3,
                comfort: 4,
                answers: { externalDiscussion: false, synthetic: true },
              },
            });
            const st = await tx.stimulusExcerpt.create({
              data: {
                sessionId: id,
                text: "听起来不错呀 🌿\n如果有半天空闲，我想去公园走走。",
                context: "朋友：最近终于有时间慢下来啦，你呢？",
                sourceMessageIds: (
                  await tx.message.findMany({
                    where: { sessionId: id, publicRole: "SOURCE" },
                    orderBy: { sequence: "asc" },
                  })
                ).map((m) => m.id),
                privateCondition: a.source,
                contextVersion: "synthetic-context-v1",
                eligibilityRuleVersion: "synthetic-rule-v1",
              },
            });
            const familiarNumber =
              (d.targetIndex - 1) * 3 + (d.friendIndex % 3) + 1;
            const familiarId = `demo-friend-${String(familiarNumber).padStart(2, "0")}`;
            const unfamiliarNumber = d.targetIndex === 1 ? 4 : 1;
            const unfamiliarId = `demo-friend-${String(unfamiliarNumber).padStart(2, "0")}`;
            await tx.familiarityScreen.upsert({
              where: {
                participantId_targetId: {
                  participantId: unfamiliarId,
                  targetId,
                },
              },
              create: {
                participantId: unfamiliarId,
                targetId,
                knowsTarget: false,
              },
              update: {},
            });
            await tx.offlineAssignment.createMany({
              data: [
                {
                  stimulusId: st.id,
                  participantId: familiarId,
                  familiarityRole: "FAMILIAR",
                  displayPseudonym: targetNames[d.targetIndex - 1],
                  expiresAt: new Date(now + 7 * 86400000),
                },
                {
                  stimulusId: st.id,
                  participantId: unfamiliarId,
                  familiarityRole: "UNFAMILIAR",
                  displayPseudonym: "参与者 R",
                  expiresAt: new Date(now + 7 * 86400000),
                },
              ],
            });
            await tx.dataLineage.createMany({
              data: [
                {
                  ownerId: targetId,
                  parentType: "Session",
                  parentId: id,
                  childType: "StimulusExcerpt",
                  childId: st.id,
                },
                {
                  ownerId: friendId,
                  parentType: "Session",
                  parentId: id,
                  childType: "StimulusExcerpt",
                  childId: st.id,
                },
              ],
            });
          }
        }
        await tx.relationshipTimepoint.create({
          data: {
            dyadId,
            participantId: friendId,
            timepoint: "BASELINE",
            ios: 5,
          },
        });
      }
      await tx.auditEvent.create({
        data: {
          action: "SYNTHETIC_STUDY_SEEDED",
          entityType: "Study",
          entityId: STUDY_ID,
          metadata: {
            targets: 12,
            friends: 36,
            dyads: 36,
            sessions: 216,
            assignmentHash: plan.hash,
          },
        },
      });
    },
    { timeout: 120000 },
  );
}
