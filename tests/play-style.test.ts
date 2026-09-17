import assert from "node:assert/strict";
import test from "node:test";
import type { PlayPersonaInput } from "../src/domain/play";
import {
  classifyPlayStyleScene,
  distillPlayStyle,
  graphemeLength,
  PLAY_STYLE_VERSION,
  resolvePlayStyle,
  selectStyleExamples,
  styleSourceHash,
  summarizePlayStyle,
} from "../src/server/play-style";

function persona(
  examplesText: string,
  extra: Partial<PlayPersonaInput> = {},
): PlayPersonaInput {
  return {
    displayName: "老王",
    bio: "喜欢骑车",
    memories: "朋友去过上海",
    style: "自然地聊天",
    examplesText,
    ...extra,
  };
}

test("distillation learns only the host, with authentic preceding friend context", () => {
  const profile = distillPlayStyle(
    persona(
      "朋友：今天写了很多代码🤩！（歪头笑）\n我：累不累\n我：歇会呗\n朋友：挺累的\n本人：哈哈\n对方：笑啥\nself: 哈哈",
    ),
  );
  assert.deepEqual(
    profile.samples.map(({ text, prompt }) => ({ text, prompt })),
    [
      { text: "累不累", prompt: "今天写了很多代码🤩！（歪头笑）" },
      { text: "歇会呗", prompt: undefined },
      { text: "哈哈", prompt: "挺累的" },
      { text: "哈哈", prompt: "笑啥" },
    ],
  );
  assert.equal(profile.metrics.emojiRate, 0);
  assert.equal(profile.metrics.exclamationRate, 0);
  assert.equal(profile.metrics.actionRate, 0);
  assert.deepEqual(
    profile.recurringPhrases.find(({ text }) => text === "哈哈")?.evidenceIds,
    ["s3", "s4"],
  );
  assert(!JSON.stringify(profile).includes("喜欢骑车"));
  assert(!JSON.stringify(profile).includes("朋友去过上海"));
});

test("custom explicit speaker names on their own lines are correctly attributed", () => {
  const profile = distillPlayStyle(
    persona(
      "aaa小王\n哈喽哈喽\naaa老王\n来了\naaa小王\n听多了？啥\naaa老王\n我刚那句说岔了",
      { displayName: "昵称", exampleSpeaker: "aaa老王" },
    ),
  );
  assert.equal(profile.targetSpeaker, "aaa老王");
  assert.deepEqual(profile.samples, [
    { id: "s1", text: "来了", prompt: "哈喽哈喽", scene: "greeting" },
    {
      id: "s2",
      text: "我刚那句说岔了",
      prompt: "听多了？啥",
      scene: "clarification",
    },
  ]);
});

test("an explicit example speaker overrides the public display name", () => {
  const profile = distillPlayStyle(
    persona("小王：这句是朋友说的\n老王：收到", {
      displayName: "小王",
      exampleSpeaker: "老王",
    }),
  );
  assert.deepEqual(
    profile.samples.map(({ text }) => text),
    ["收到"],
  );
  assert.equal(profile.samples[0].prompt, "这句是朋友说的");
  const alias = distillPlayStyle(
    persona("我：这是朋友说的话😊\n老王：行", { exampleSpeaker: "老王" }),
  );
  assert.deepEqual(
    alias.samples.map(({ text }) => text),
    ["行"],
  );
  assert.equal(alias.metrics.emojiRate, 0);
  assert.equal(
    distillPlayStyle(persona("我：朋友说的话\n老王：行")).samples.length,
    1,
  );
});

test("explicit speaker labels support emoji and punctuation literally", () => {
  for (const label of ["老王🍵", "老王（本人）", "Alice: CEO"]) {
    const profile = distillPlayStyle(
      persona(`朋友：在吗\n${label}：在呢`, { exampleSpeaker: label }),
    );
    assert.deepEqual(
      profile.samples.map(({ text, prompt }) => ({ text, prompt })),
      [{ text: "在呢", prompt: "在吗" }],
    );
  }
  const profile = distillPlayStyle(
    persona("老王：行\n小王🍵：这是朋友的话\n老王：嗯"),
  );
  assert.deepEqual(
    profile.samples.map(({ text }) => text),
    ["行", "嗯"],
  );
  assert.equal(profile.samples[1].prompt, "这是朋友的话");
});

test("the summary records the actual learned speaker for follow-up corrections", () => {
  assert.equal(distillPlayStyle(persona("我：来了")).targetSpeaker, "我");
  assert.equal(distillPlayStyle(persona("Me: hey")).targetSpeaker, "me");
  assert.equal(distillPlayStyle(persona("老王：来了")).targetSpeaker, "老王");
  assert.equal(distillPlayStyle(persona("改天约呗")).targetSpeaker, "我");
});

test("irregular header-only exports never absorb unidentified speakers into host speech", () => {
  const profile = distillPlayStyle(
    persona("老王\n第一句\n小王\n朋友的话\n老王\n第二句\n未识别的换行内容"),
  );
  assert.deepEqual(
    profile.samples.map(({ text }) => text),
    ["第一句", "第二句"],
  );
  assert(profile.warnings.includes("ignored_lines"));
});

test("ambiguous named conversations require identification, never mix both speakers", () => {
  for (const examples of [
    "张三：你好\n李四：来了",
    "张三\n你好\n李四\n来了\n张三\n好",
    "张三：你好\n张三：还有事吗",
  ]) {
    const profile = distillPlayStyle(persona(examples));
    assert.equal(profile.samples.length, 0);
    assert.equal(profile.summary.status, "needs_examples");
    assert(profile.warnings.includes("unrecognized_speakers"));
  }
  assert.equal(
    distillPlayStyle(
      persona("张三：你好\n李四：来了", { exampleSpeaker: "李四" }),
    ).samples[0].text,
    "来了",
  );
});

test("unlabeled personal messages remain usable and are explicitly marked", () => {
  const profile = distillPlayStyle(persona("改天约呗\n哈哈\n行啊\n没睡醒"));
  assert.deepEqual(
    profile.samples.map(({ text }) => text),
    ["改天约呗", "哈哈", "行啊", "没睡醒"],
  );
  assert(profile.warnings.includes("unlabeled_self"));
  assert.equal(profile.summary.status, "limited");
  assert.equal(profile.summary.pairedExampleCount, 0);
});

test("odd header exports and read receipts do not leak another person's speech", () => {
  const profile = distillPlayStyle(
    persona("老王\n行啊\n小王\n那说定了\n老王\n晚点见\n已读", {
      displayName: "昵称",
    }),
  );
  assert.equal(profile.samples.length, 0);
  assert(profile.warnings.includes("unrecognized_speakers"));
  assert(profile.warnings.includes("ignored_lines"));
});

test("example boundaries and system events prevent invented cross-conversation pairs", () => {
  const profile = distillPlayStyle(
    persona(
      "朋友：旧的问题\n\n我：独立的一句\n---\n朋友：新问题\n2026-09-16 12:03\n我：新回答\n朋友：撤回前的问题\n系统：你撤回了一条消息\n我：还有事吗",
    ),
  );
  assert.equal(profile.samples[0].prompt, undefined);
  assert.equal(profile.samples[1].prompt, "新问题");
  assert.equal(profile.samples[2].prompt, undefined);
  assert(profile.warnings.includes("ignored_lines"));
});

test("timestamps cannot become speakers, and message colons and URLs stay intact", () => {
  const profile = distillPlayStyle(
    persona(
      "12:34\n朋友：链接呢\n我：https://example.com/a:b\n昨天 13:00\n朋友：你说啥\n我：我是说：下周再来",
    ),
  );
  assert.deepEqual(
    profile.samples.map(({ text }) => text),
    ["https://example.com/a:b", "我是说：下周再来"],
  );
  assert.equal(profile.samples[0].prompt, "链接呢");
  assert.equal(profile.samples[1].prompt, "你说啥");
});

test("metrics use host graphemes, including emoji sequences and combining characters", () => {
  assert.equal(graphemeLength("👨‍👩‍👧‍👦"), 1);
  assert.equal(graphemeLength("e\u0301"), 1);
  const profile = distillPlayStyle(
    persona("我：嗯\n我：好呀\n我：👨‍👩‍👧‍👦！\n我：啥？\n我：哈哈（歪头笑）"),
  );
  assert.equal(profile.metrics.medianLength, 2);
  assert.equal(profile.metrics.p90Length, 7);
  assert.equal(profile.metrics.emojiRate, 0.2);
  assert.equal(profile.metrics.questionRate, 0.2);
  assert.equal(profile.metrics.exclamationRate, 0.2);
  assert.equal(profile.metrics.finalPunctuationRate, 0.4);
  assert.equal(profile.metrics.actionRate, 0.2);
  assert.equal(
    distillPlayStyle(persona("我：吃过了（中午）")).metrics.actionRate,
    0,
  );
});

test("status describes evidence quantity and requires multiple authentic pairs", () => {
  assert.equal(distillPlayStyle(persona("")).summary.status, "needs_examples");
  const unpaired = Array.from({ length: 8 }, (_, i) => `我：第${i}句`).join(
    "\n",
  );
  assert.equal(distillPlayStyle(persona(unpaired)).summary.status, "limited");
  const paired = Array.from(
    { length: 8 },
    (_, i) => `朋友：问题${i}\n我：回答${i}`,
  ).join("\n");
  const profile = distillPlayStyle(persona(paired));
  assert.equal(profile.summary.status, "ready");
  assert.equal(profile.summary.pairedExampleCount, 8);
  assert(!profile.warnings.includes("limited_examples"));
  assert.deepEqual(summarizePlayStyle(profile), profile.summary);
});

test("retrieval uses the friend's scene and avoids unrelated life-history examples", () => {
  const profile = distillPlayStyle(
    persona(
      "朋友：你住哪里\n我：我住在火星基地\n朋友：哈喽哈喽\n我：来了\n朋友：听多了？啥\n我：我刚说岔了\n朋友：一眼AI\n我：这么明显吗哈哈\n朋友：要不要一起喝咖啡\n我：走呗",
    ),
  );
  assert.deepEqual(
    selectStyleExamples(profile, "你好").map(({ text }) => text),
    ["来了"],
  );
  assert.deepEqual(
    selectStyleExamples(profile, "什么意思").map(({ text }) => text),
    ["我刚说岔了"],
  );
  assert.deepEqual(
    selectStyleExamples(profile, "一眼ai").map(({ text }) => text),
    ["这么明显吗哈哈"],
  );
  assert.deepEqual(selectStyleExamples(profile, "今天天气晴朗"), []);
  assert.deepEqual(selectStyleExamples(profile, "你好", 0), []);
  assert.deepEqual(
    selectStyleExamples(profile, "你好"),
    selectStyleExamples(profile, "你好"),
  );
});

test("retrieval deduplicates speech and favors paired examples over standalone samples", () => {
  const profile = distillPlayStyle(
    persona(
      "我：哈喽\n朋友：你好\n我：来了\n朋友：嗨\n我：来了\n朋友：哈喽\n我：在呢",
    ),
  );
  const selected = selectStyleExamples(profile, "你好");
  assert.deepEqual(
    selected.map(({ text }) => text),
    ["来了", "在呢", "哈喽"],
  );
  assert.equal(selected[2].prompt, undefined);
});

test("short conversational paraphrases retrieve authentic reply pairs without exact wording", () => {
  const profile = distillPlayStyle(
    persona(
      [
        "朋友：哟在不\n我：在 咋啦",
        "朋友：好久没唠了\n我：是啊 最近咋样",
        "朋友：你说跑偏是啥意思\n我：就我刚才说岔了",
        "朋友：这句像机器人发的\n我：笑死 有那么夸张吗",
        "朋友：今天有点烦\n我：咋啦 说来听听",
        "朋友：明天一起买菜不\n我：行啊 几点",
        "朋友：没看懂你上一句\n我：我没说清 就是太困了",
        "朋友：你这话太客套了吧\n我：行行行 我正常点",
        "朋友：有点甜的饮料是哪瓶\n我：左边那瓶",
      ].join("\n\n"),
    ),
  );
  for (const [input, ids] of [
    ["哈喽哈喽", ["s1", "s2"]],
    ["一眼ai", ["s4", "s8"]],
    ["听多了？啥", ["s3", "s7"]],
    ["有点累 不想出门", ["s5"]],
  ] as const) {
    const selected = selectStyleExamples(profile, input);
    assert.deepEqual(
      selected.map(({ id }) => id),
      ids,
      input,
    );
    for (const sample of selected)
      assert.deepEqual(
        sample,
        profile.samples.find(({ id }) => id === sample.id),
      );
  }
  assert.deepEqual(selectStyleExamples(profile, "天气预报说明天降温"), []);
  assert.deepEqual(selectStyleExamples(profile, "我很开心"), []);
  assert.deepEqual(selectStyleExamples(profile, "我不太累"), []);
});

test("pressure and overload paraphrases retrieve the host's real emotional response, never a greeting", () => {
  const profile = distillPlayStyle(
    persona(
      [
        "朋友：好久没唠了\n我：是啊 最近咋样",
        "朋友：今天有点烦\n我：咋啦 说来听听",
        "朋友：feeling down today\n我：want to talk about it",
        "朋友：hello\n我：hey how's it going",
      ].join("\n\n"),
    ),
  );
  for (const query of [
    "今天被工作压得喘不过气，脑子都转不动了",
    "这周任务压得我喘不过气",
    "脑子已经转不动了",
    "生活压得我扛不住了",
    "最近忙不过来",
    "工作太多根本做不完",
  ]) {
    assert.equal(classifyPlayStyleScene(query), "low_mood", query);
    assert.deepEqual(
      selectStyleExamples(profile, query),
      [profile.samples[1]],
      query,
    );
  }
  for (const query of [
    "I'm completely overwhelmed",
    "I feel burned out",
    "feeling burnt out lately",
    "work is crushing me",
    "I'm under pressure",
    "overwhelmed today",
  ]) {
    assert.equal(classifyPlayStyleScene(query), "low_mood", query);
    assert.deepEqual(
      selectStyleExamples(profile, query),
      [profile.samples[2]],
      query,
    );
  }
});

test("overload matching excludes positive, negated and factual uses", () => {
  const profile = distillPlayStyle(
    persona(
      "朋友：今天有点烦\n我：说来听听\n朋友：feeling down today\n我：want to talk",
    ),
  );
  for (const query of [
    "工作没有压得我喘不过气",
    "脑子不会转不动了",
    "最近工作顺利 心情很好",
    "脑子转不动是什么原因",
    "工作压得喘不过气怎么翻译",
    "压力传感器的原理是什么",
    "I'm not overwhelmed",
    "I don't feel burned out",
    "I am no longer feeling burnt out",
    "I'm overwhelmed with joy",
    "feeling overwhelmed by gratitude",
    "what does burned out mean?",
    "what causes people to feel overwhelmed?",
    "definition of feeling burned out",
  ]) {
    assert.notEqual(classifyPlayStyleScene(query), "low_mood", query);
    assert.deepEqual(selectStyleExamples(profile, query), [], query);
  }
});

test("retrieval recalculates scenes from original text in compatible stored profiles", () => {
  const input = persona(
    "朋友：哟在不\n我：在呢\n朋友：今天有点烦\n我：说来听听",
  );
  const original = distillPlayStyle(input);
  const stored = {
    ...original,
    samples: original.samples.map((sample) => ({
      ...sample,
      scene: "other" as const,
    })),
  };
  const profile = resolvePlayStyle(input, stored);
  const before = JSON.stringify(profile);
  assert.equal(profile.version, original.version);
  assert.deepEqual(
    selectStyleExamples(profile, "你好").map(({ id }) => id),
    ["s1"],
  );
  assert.deepEqual(
    selectStyleExamples(profile, "最近压力大").map(({ id }) => id),
    ["s2"],
  );
  assert.equal(
    JSON.stringify(profile),
    before,
    "retrieval must not mutate stored evidence",
  );
});

test("conversational clarification and teasing do not match unrelated factual questions", () => {
  const profile = distillPlayStyle(
    persona(
      [
        "朋友：听不懂你刚才说的\n我：我换个说法",
        "朋友：你说话像机器人\n我：有这么明显吗",
        "朋友：你家在哪里\n我：火星基地",
        "朋友：为什么天空是蓝色的\n我：光的散射吧",
      ].join("\n"),
    ),
  );
  for (const query of [
    "今晚吃啥",
    "这个机器人多少钱",
    "哪里能买到书",
    "为什么海水是咸的",
  ])
    assert.deepEqual(selectStyleExamples(profile, query), [], query);
  assert.deepEqual(
    selectStyleExamples(profile, "你刚才那句什么意思").map(({ id }) => id),
    ["s1"],
  );
  assert.deepEqual(
    selectStyleExamples(profile, "你这回复也太官方了").map(({ id }) => id),
    ["s2"],
  );
});

test("scene matching stays within the language of the current conversation", () => {
  const profile = distillPlayStyle(
    persona(
      [
        "朋友：好久没聊了\n我：在呢",
        "朋友：你这话太客套了\n我：我正常点",
        "朋友：我今天很难过\n我：愿意说说吗",
        "朋友：yo are you around?\n我：yeah what's up",
        "朋友：you sound so formal\n我：haha fair point",
        "朋友：I don't get what you said\n我：let me put that differently",
        "朋友：feeling down today\n我：want to talk about it",
        "朋友：hello\n我：这句只有中文",
      ].join("\n"),
    ),
  );
  for (const [query, ids] of [
    ["哈喽", ["s1"]],
    ["hi", ["s4"]],
    ["are you a bot?", ["s5"]],
    ["what do you mean?", ["s6"]],
    ["I'm stressed", ["s7"]],
    ["有点累", ["s3"]],
  ] as const)
    assert.deepEqual(
      selectStyleExamples(profile, query).map(({ id }) => id),
      ids,
      query,
    );
  assert.deepEqual(selectStyleExamples(profile, "I'm not tired"), []);
  assert.deepEqual(
    selectStyleExamples(
      distillPlayStyle(persona("朋友：你好\n我：来了")),
      "hello",
    ),
    [],
  );
});

test("recalling an event never retrieves an invitation just because both mention doing things together", () => {
  const profile = distillPlayStyle(
    persona(
      [
        "朋友：要不要一起逛书店\n我：行啊 几点",
        "朋友：Want to join me for dinner?\n我：sure what time",
      ].join("\n\n"),
    ),
  );
  for (const query of [
    "你还记得前年咱俩一起去露营的事吗",
    "上回一起修自行车，你还有印象吗",
    "记不记得我们之前一起排过队",
    "Do you remember our walk together last spring?",
    "Can you recall when we had lunch after the concert?",
    "Remember that dinner we shared?",
  ]) {
    assert.equal(classifyPlayStyleScene(query), "recollection", query);
    assert.deepEqual(selectStyleExamples(profile, query), [], query);
  }
});

test("memory examples require a shared topic instead of generic recall cues", () => {
  const profile = distillPlayStyle(
    persona(
      [
        "朋友：记不记得以前一起露营\n我：记得 我带了帐篷",
        "朋友：还记得一起看展那次吗\n我：记得 门口下雨",
        "朋友：Do you remember our camping trip?\n我：yeah I brought the tent",
        "朋友：Remember that dinner together?\n我：yeah we ate outside",
      ].join("\n\n"),
    ),
  );
  for (const [query, ids] of [
    ["你还记得露营那回吗", ["s1"]],
    ["Do you recall our old camping trip?", ["s3"]],
    ["还记得那回一起排队的事吗", []],
    ["Do you remember that day together?", []],
    ["今晚一起露营不", []],
  ] as const) {
    assert.deepEqual(
      selectStyleExamples(profile, query).map(({ id }) => id),
      ids,
      query,
    );
  }
});

test("contrasting what was asked and what was answered is conversational clarification", () => {
  const profile = distillPlayStyle(
    persona(
      [
        "朋友：没看懂你上一句\n我：我没说清",
        "朋友：一起去买菜吗\n我：行啊",
        "朋友：I don't get what you said\n我：let me put that differently",
      ].join("\n\n"),
    ),
  );
  for (const query of [
    "我问的是价格，你怎么答起重量了",
    "我刚才说上午，你却回我晚上",
    "你是不是把八点说成十点了",
    "不是北门，我说的是南门",
    "我说的是数量，而不是颜色",
    "I asked about cost, but you answered about weight",
    "I said the north gate, not the south gate",
    "You said afternoon before, but now you are saying evening",
  ]) {
    assert.equal(classifyPlayStyleScene(query), "clarification", query);
    assert.deepEqual(
      selectStyleExamples(profile, query).map(({ id }) => id),
      /[\u4e00-\u9fff]/u.test(query) ? ["s1"] : ["s3"],
      query,
    );
  }
});

test("ordinary questions, prospective reminders and real invitations retain their intent", () => {
  for (const query of [
    "我问你怎么去车站",
    "我问一下，你怎么知道的",
    "你觉得这条线路怎么样",
    "How do people remember names?",
    "怎样才能记得更多单词",
  ]) {
    assert.notEqual(classifyPlayStyleScene(query), "clarification", query);
    assert.notEqual(classifyPlayStyleScene(query), "recollection", query);
  }
  for (const query of [
    "明天记得一起去买菜",
    "记得下周一起吃饭",
    "Remember to join us for lunch tomorrow",
    "要不要一起去看电影",
  ])
    assert.equal(classifyPlayStyleScene(query), "invitation", query);
});

test("whole-message casual check-ins use greetings without swallowing specific activity questions", () => {
  const profile = distillPlayStyle(
    persona(
      ["朋友：在吗\n我：在 咋啦", "朋友：hello\n我：hey what's up"].join(
        "\n\n",
      ),
    ),
  );
  for (const query of [
    "哟，在忙什么呢？",
    "你现在在干啥",
    "忙啥呀",
    "What are you up to?",
    "Hey, what are you doing right now?",
  ]) {
    assert.equal(classifyPlayStyleScene(query), "greeting", query);
    assert.deepEqual(
      selectStyleExamples(profile, query).map(({ id }) => id),
      /[\u4e00-\u9fff]/u.test(query) ? ["s1"] : ["s2"],
      query,
    );
  }
  for (const query of [
    "你在做什么项目",
    "你现在在看什么书",
    "What are you doing with that camera?",
  ]) {
    assert.notEqual(classifyPlayStyleScene(query), "greeting", query);
    assert.deepEqual(selectStyleExamples(profile, query), [], query);
  }
});

test("old scene labels are reinterpreted without changing frozen original evidence or its hash", () => {
  const input = persona(
    [
      "朋友：还记得一起露营那次吗\n我：记得 我带了帐篷",
      "朋友：我问的是价格，你怎么答起重量了\n我：我没说清",
    ].join("\n\n"),
  );
  const original = distillPlayStyle(input);
  const stored = {
    ...original,
    samples: original.samples.map((sample, index) => ({
      ...sample,
      scene: index === 0 ? ("invitation" as const) : ("question" as const),
    })),
  };
  const before = JSON.stringify(stored);
  const resolved = resolvePlayStyle(input, stored);
  assert.equal(resolved.version, PLAY_STYLE_VERSION);
  assert.equal(resolved.sourceHash, stored.sourceHash);
  assert.deepEqual(resolved.samples, stored.samples);
  assert.deepEqual(
    selectStyleExamples(resolved, "还记得露营那回吗").map(({ id }) => id),
    ["s1"],
  );
  assert.deepEqual(
    selectStyleExamples(resolved, "我说的是距离，不是面积").map(({ id }) => id),
    ["s2"],
  );
  assert.deepEqual(selectStyleExamples(resolved, "一起露营不"), []);
  assert.equal(JSON.stringify(stored), before);
});

test("versioned source hashes and profile resolution invalidate edits and corrupt caches", () => {
  const input = persona("朋友：嗨\n我：来了\n朋友：嗨\n我：来了");
  const profile = distillPlayStyle(input);
  assert.equal(profile.version, PLAY_STYLE_VERSION);
  assert.deepEqual(profile, distillPlayStyle(input));
  assert.equal(profile.sourceHash, styleSourceHash(input));
  assert.notEqual(
    profile.sourceHash,
    styleSourceHash({ ...input, exampleSpeaker: "别人" }),
  );
  assert.deepEqual(
    resolvePlayStyle(input, JSON.parse(JSON.stringify(profile))),
    profile,
  );
  assert.deepEqual(
    resolvePlayStyle(input, {
      ...profile,
      metrics: { ...profile.metrics, medianLength: NaN },
    }),
    profile,
  );
  assert.deepEqual(
    resolvePlayStyle(input, { ...profile, samples: [null] }),
    profile,
  );
  assert.deepEqual(
    resolvePlayStyle(input, { ...profile, version: "obsolete" }),
    profile,
  );
  assert.deepEqual(
    resolvePlayStyle(input, {
      ...profile,
      samples: [{ ...profile.samples[0], text: "凭空编造的样本" }],
    }),
    profile,
  );
  const edited = { ...input, examplesText: "我：改了" };
  assert.deepEqual(resolvePlayStyle(edited, profile), distillPlayStyle(edited));
});

test("large or truncated sources cannot overflow samples or retrieval budgets", () => {
  const profile = distillPlayStyle(
    persona(
      Array.from(
        { length: 300 },
        (_, i) => `朋友：你好${i}\n我：来了${i}`,
      ).join("\n"),
    ),
  );
  assert.equal(profile.samples.length, 200);
  assert(profile.warnings.includes("ignored_lines"));
  assert(selectStyleExamples(profile, "你好", 100).length <= 6);
  const overlong = distillPlayStyle(persona("我：" + "啊".repeat(20_000)));
  assert.equal(overlong.samples.length, 0);
  assert(overlong.warnings.includes("ignored_lines"));
  const retrieved = selectStyleExamples(profile, "你好");
  assert(
    retrieved.reduce(
      (sum, sample) =>
        sum + graphemeLength(sample.text) + graphemeLength(sample.prompt ?? ""),
      0,
    ) <= 2_000,
  );
});
