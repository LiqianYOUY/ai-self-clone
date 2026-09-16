"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  MessageCircle,
  Send,
  Sparkles,
} from "lucide-react";
type Data = Record<string, any>;
export default function Development({
  act,
  busy,
}: {
  act: (a: string, p?: Data, m?: string) => Promise<any>;
  busy: boolean;
}) {
  const [data, setData] = useState<Data>({});
  const [tab, setTab] = useState("calibration");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<Data | null>(null);
  const [practice, setPractice] = useState<Data | null>(null);
  const [device, setDevice] = useState("COMPUTER");
  const [practiceText, setPracticeText] = useState("");
  const firstInput = useRef<number | null>(null);
  const [error, setError] = useState("");
  const load = async () => {
    try {
      const r = await fetch("/api/study?view=development");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setData(d);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    load();
  }, [tab]);
  const run = async (a: string, p: Data = {}, m = "已保存。") => {
    const result = await act(a, p, m);
    if (result) await load();
    return result;
  };
  const questions = data.questions || [];
  const available = questions.filter(
    (q: Data) => !(data.answers || []).some((a: Data) => a.questionId === q.id),
  );
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>校准与开发练习</h2>
          <p>与正式会话及独立留出分别记录</p>
        </div>
        <Sparkles size={21} />
      </div>
      <div className="development-tabs tabs">
        {[
          ["calibration", "校准问题"],
          ["preview", "DEV 预览"],
          ["practice", "节奏练习"],
        ].map(([k, l]) => (
          <button
            key={k}
            className={tab === k ? "active" : ""}
            onClick={() => setTab(k)}
          >
            {l}
          </button>
        ))}
      </div>
      {error && <div className="alert error">{error}</div>}
      {tab === "calibration" && (
        <div className="form-body">
          <div className="study-banner">
            <CheckCircle2 size={22} />
            <div>
              <strong>{data.answers?.length || 0} 个校准问题已记录</strong>
              <p>每个回答独立保存；提交后保留版本，不直接覆盖。</p>
            </div>
          </div>
          {available.length ? (
            <>
              <label className="field-label">
                选择校准问题
                <select
                  value={question || available[0]?.id || ""}
                  onChange={(e) => setQuestion(e.target.value)}
                >
                  {available.map((q: Data) => (
                    <option value={q.id} key={q.id}>
                      {q.text}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                你的回答
                <textarea
                  maxLength={1500}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="请使用合成资料演练，避免真实个人信息。"
                />
              </label>
              <button
                className="button primary"
                disabled={busy || !answer.trim()}
                onClick={async () => {
                  if (
                    await run("saveCalibration", {
                      questionId: question || available[0]?.id,
                      answer,
                    })
                  ) {
                    setAnswer("");
                    setQuestion("");
                  }
                }}
              >
                保存校准回答
                <ArrowRight size={15} />
              </button>
            </>
          ) : (
            <p className="muted">
              当前题组已完成。你可以进行开发预览或独立节奏练习。
            </p>
          )}
          <div className="calibration-list">
            {(data.answers || []).map((a: Data) => (
              <details key={a.questionId}>
                <summary>
                  {questions.find((q: Data) => q.id === a.questionId)?.text ||
                    a.questionId}
                </summary>
                <p>{a.answer || "内容已删除"}</p>
              </details>
            ))}
          </div>
        </div>
      )}
      {tab === "preview" && (
        <div className="form-body">
          <p className="muted">
            先在上方构建新草稿，再用独立 DEV 问题检查表达。每个草稿最多 10
            次；不允许使用 HOLDOUT 问题。
          </p>
          <div className="alert">
            当前是固定规则的合成回复，用于验证调用和记录流程；不代表真实模型的个人表达能力。
          </div>
          <label className="field-label">
            开发问题
            <textarea
              maxLength={1500}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="假设周末有半天空闲，你想做什么？"
            />
          </label>
          <button
            className="button primary"
            disabled={busy || !prompt.trim() || !data.drafts?.length}
            onClick={async () => {
              const result = await run(
                "previewPersona",
                { personaId: data.drafts[0]?.id, prompt },
                "开发预览已单独记录。",
              );
              if (result) setPreview(result);
            }}
          >
            <Sparkles size={16} />
            预览最新草稿
          </button>
          {!data.drafts?.length && (
            <p className="muted">
              暂时没有可预览的草稿，点击上方“构建新版本”后刷新即可。
            </p>
          )}
          {preview && (
            <div className="preview-reply">
              {(preview.bursts || []).map((text: string, i: number) => (
                <p key={i}>{text}</p>
              ))}
              {preview.notice && <p>{preview.notice}</p>}
              <small>本草稿已使用 {preview.previewCount} 次开发预览</small>
            </div>
          )}
        </div>
      )}
      {tab === "practice" && (
        <div className="form-body">
          <p className="muted">
            独立练习只保存开始到发送、首次输入到发送的时间与设备。不保存练习正文、逐键内容或剪贴板。
          </p>
          <label className="field-label">
            当前设备
            <select value={device} onChange={(e) => setDevice(e.target.value)}>
              <option value="COMPUTER">电脑</option>
              <option value="PHONE">手机</option>
              <option value="TABLET">平板</option>
              <option value="OTHER">其他</option>
            </select>
          </label>
          {!practice ? (
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                const result = await run("beginPractice", {}, "");
                if (result) {
                  setPractice(result);
                  firstInput.current = null;
                  setPracticeText("");
                }
              }}
            >
              <Clock3 size={16} />
              开始独立练习
            </button>
          ) : (
            <>
              <div className="stimulus">
                <small>练习题目</small>
                <p>{practice.prompt}</p>
              </div>
              <textarea
                aria-label="练习回复（不保存正文）"
                value={practiceText}
                onChange={(e) => {
                  firstInput.current ??= performance.now();
                  setPracticeText(e.target.value);
                }}
                placeholder="像平时一样输入，发送时只记录时间。"
              />
              <button
                className="button primary"
                disabled={busy || !practiceText.trim()}
                onClick={async () => {
                  const result = await run(
                    "finishPractice",
                    {
                      token: practice.token,
                      device,
                      firstInputToSendMs: Math.round(
                        performance.now() -
                          (firstInput.current ?? performance.now()),
                      ),
                    },
                    "练习时间已记录，正文未保存。",
                  );
                  if (result) {
                    setPractice(null);
                    setPracticeText("");
                  }
                }}
              >
                <Send size={16} />
                结束本轮练习
              </button>
            </>
          )}
          <p className="muted">
            支持不足的基线始终标为 LOW_SUPPORT；具体时序容差与采样策略需在 pilot
            后批准。
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>练习时间</th>
                  <th>总响应时间</th>
                  <th>输入到发送</th>
                  <th>设备</th>
                </tr>
              </thead>
              <tbody>
                {(data.baseline || []).map((s: Data) => (
                  <tr key={s.id}>
                    <td>{new Date(s.createdAt).toLocaleString("zh-CN")}</td>
                    <td>{(s.responseMs / 1000).toFixed(1)} 秒</td>
                    <td>{(s.firstInputToSendMs / 1000).toFixed(1)} 秒</td>
                    <td>{s.device}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
