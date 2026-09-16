"use client";
import { useState } from "react";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  LockKeyhole,
  Users,
} from "lucide-react";
type Data = Record<string, any>;
export default function Evaluations({
  data,
  actor,
  act,
  busy,
}: {
  data: Data;
  actor: Data;
  act: any;
  busy: boolean;
}) {
  const [track, setTrack] = useState("MATCHED");
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<Data>({
    likeness: null,
    predictedFriendRating: null,
    endorsement: null,
  });
  const target = actor.role === "TARGET";
  const item = (data.items || []).find(
    (i: Data) => i.stimulusId === selected && i.track === track,
  );
  if (data.stats) {
    return (
      <>
        <div className="study-banner">
          <Users size={23} />
          <div>
            <strong>双层自我—他者评价</strong>
            <p>
              匹配版本固定上下文和来源知情状态；生态版本保留原始 live-blind
              观察。
            </p>
          </div>
        </div>
        <div className="stat-grid">
          {[
            ["matchedRatings", "匹配评价记录"],
            ["completedMatchedPairs", "已完成评价配对"],
            ["ecologicalTargetRatings", "生态 Target 评价"],
            ["approvedScopes", "逐片段授权"],
          ].map(([key, label]) => (
            <div key={key} className="stat-card">
              <div className="stat-label">{label}</div>
              <div className="stat-value">{data.stats[key] || 0}</div>
              <div className="stat-meta">合成研究运行记录</div>
            </div>
          ))}
        </div>
        <div className="panel">
          <div className="empty">
            <LockKeyhole size={30} />
            <p>
              原始评分独立保存。研究概览只展示进度，不显示参与者正文与彼此答案。
            </p>
          </div>
        </div>
      </>
    );
  }
  const items = (data.items || []).filter((i: Data) => i.track === track);
  return (
    <>
      <div className="study-banner">
        <Users size={23} />
        <div>
          <strong>按具体片段独立授权与评价</strong>
          <p>你只会看到被许可的上下文。提交后锁定，双方互不可见答案。</p>
        </div>
      </div>
      <div className="section-toolbar">
        <div className="tabs">
          {[
            ["MATCHED", "匹配评价"],
            ["ECOLOGICAL", "生态评价"],
          ].map(([k, l]) => (
            <button
              key={k}
              className={track === k ? "active" : ""}
              onClick={() => {
                setTrack(k);
                setSelected(null);
              }}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      {data.blocked?.targetBlockIncomplete && (
        <div className="alert">
          <LockKeyhole size={17} />此 Target
          的完整研究区组尚未结束，来源知情评价暂不开放。你仍可随时请求研究解释。
        </div>
      )}
      {data.blocked?.permissionsMissing && (
        <div className="alert">
          部分片段尚未获得双方同意或逐片段许可，因此不可见。
        </div>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>
            {track === "MATCHED"
              ? "相同片段 · 相同上下文"
              : "生态版本 · 原始观察与本人评价"}
          </h2>
          <BookOpen size={20} />
        </div>
        {!items.length ? (
          <div className="empty">
            <BookOpen size={28} />
            <p>暂时没有符合当前权限和研究阶段的片段。</p>
          </div>
        ) : (
          <div className="assignment-grid">
            {items.map((i: Data) => (
              <button
                className="assignment-card"
                key={i.stimulusId}
                onClick={() => {
                  setSelected(i.stimulusId);
                  setForm({
                    likeness: null,
                    predictedFriendRating: null,
                    endorsement: null,
                  });
                }}
              >
                <div>
                  <BookOpen size={20} />
                  <span className="badge">
                    {i.submitted
                      ? "已提交"
                      : i.approval.ownApproved
                        ? "已授权"
                        : "待授权"}
                  </span>
                </div>
                <h3>研究片段</h3>
                <p>{i.excerpt.slice(0, 80)}</p>
                <span>
                  查看与授权
                  <ArrowRight size={16} />
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      {item && (
        <section className="panel">
          <div className="panel-heading">
            <h2>片段与共同上下文</h2>
            <button className="text-button" onClick={() => setSelected(null)}>
              关闭
            </button>
          </div>
          <div className="form-body">
            <p className="muted">{item.comparisonNote}</p>
            <div className="stimulus">
              <small>最小必要上下文</small>
              <p>{item.context || "无额外上下文"}</p>
              <small>SOURCE</small>
              <p>{item.excerpt}</p>
            </div>
            {item.sourceDisclosed ? (
              <div className="alert">
                此评价已披露来源：
                {item.source === "HUMAN" ? "本人回复" : "AI 分身回复"}。
              </div>
            ) : (
              <div className="alert">
                当前仅用于片段授权，暂不披露来源。区组完成且双方批准后，正式评价会展示来源。
              </div>
            )}
            <div className="button-row">
              {!item.approval.ownApproved ? (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    act(
                      "approveExcerptSharing",
                      {
                        stimulusId: item.stimulusId,
                        scope: item.scope,
                        approved: true,
                      },
                      "已批准此片段与固定上下文。",
                    )
                  }
                >
                  批准此片段用于
                  {track === "MATCHED" ? "匹配评价" : "本人生态评价"}
                </button>
              ) : (
                <>
                  <span className="badge badge-approved">
                    <CheckCircle2 size={14} />
                    此版本已授权
                  </span>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      act(
                        "approveExcerptSharing",
                        {
                          stimulusId: item.stimulusId,
                          scope: item.scope,
                          approved: false,
                        },
                        "已撤销本片段授权。",
                      )
                    }
                  >
                    撤销本片段授权
                  </button>
                </>
              )}
            </div>
            {item.canSubmit && (
              <form
                className="evaluation-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (
                    await act(
                      "submitMatched",
                      {
                        stimulusId: item.stimulusId,
                        track,
                        likeness: form.likeness,
                        ...(target
                          ? {
                              predictedFriendRating: form.predictedFriendRating,
                              endorsement: form.endorsement,
                            }
                          : {}),
                      },
                      "你的独立评价已保存。",
                    )
                  )
                    setSelected(null);
                }}
              >
                <Rating
                  name="likeness"
                  label={target ? "表达像自己的程度" : "表达像对方的程度"}
                  value={form.likeness}
                  change={(v) => setForm({ ...form, likeness: v })}
                />
                {target && (
                  <>
                    <Rating
                      name="prediction"
                      label="你预测 Friend 会给的像本人分数"
                      value={form.predictedFriendRating}
                      change={(v) =>
                        setForm({ ...form, predictedFriendRating: v })
                      }
                    />
                    <label className="field-label">
                      你会这样说吗？
                      <select
                        value={form.endorsement || ""}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            endorsement: e.target.value || null,
                          })
                        }
                      >
                        <option value="">跳过</option>
                        <option value="YES">我会这样说</option>
                        <option value="NO">我不会这样说</option>
                        <option value="UNSURE">不确定</option>
                      </select>
                    </label>
                  </>
                )}
                <button
                  type="submit"
                  className="button primary"
                  disabled={busy}
                >
                  提交并锁定我的评价
                </button>
              </form>
            )}
            {item.submitted && (
              <div className="alert">
                <CheckCircle2 size={18} />
                你已完成此项评价。你的回答不会向对方展示。
              </div>
            )}
            {item.liveObservation && (
              <div className="alert">
                生态版本保留你在原会话后的盲态评价，不要求重新评分。
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
function Rating({
  name,
  label,
  value,
  change,
}: {
  name: string;
  label: string;
  value: number | null;
  change: (n: number | null) => void;
}) {
  return (
    <fieldset className="scale-field">
      <legend>{label}（1 低 · 5 高）</legend>
      <div className="scale-options">
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className={value === n ? "selected" : ""}>
            <input
              type="radio"
              name={name}
              checked={value === n}
              onChange={() => change(n)}
            />
            {n}
          </label>
        ))}
        <button type="button" className="skip" onClick={() => change(null)}>
          跳过
        </button>
      </div>
    </fieldset>
  );
}
