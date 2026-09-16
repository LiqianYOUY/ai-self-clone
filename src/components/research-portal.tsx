"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Copy,
  FlaskConical,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessageCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import StudyApp from "./study-app";

type Actor = { id: string; role: "RESEARCHER" | "ANALYST"; pseudonym: string };
type Data = Record<string, any>;
const roleNames: Record<string, string> = {
  RESEARCHER: "Researcher",
  ANALYST: "分析人员",
  TARGET: "Target",
  FRIEND: "Friend",
};
const statuses: Record<string, string> = {
  PENDING: "待接受",
  ACCEPTED: "已加入",
  EXPIRED: "已过期",
  REVOKED: "已撤销",
  ACTIVE: "进行中",
  PAUSED: "已暂停",
  ENDED: "已结束",
  WITHDRAWN: "已退出",
};
const formatDate = (date?: string) =>
  date
    ? new Date(date).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
async function portalRequest(
  view: string,
  parameters: Record<string, string> = {},
) {
  const res = await fetch(
    `/api/portal?${new URLSearchParams({ view, ...parameters })}`,
    { headers: { "x-study-portal": "research" }, cache: "no-store" },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "暂时无法连接，请稍后重试。");
  return data;
}
async function portalCommand(action: string, payload: Data = {}) {
  const res = await fetch("/api/portal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-study-portal": "research",
    },
    body: JSON.stringify({ action, payload }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "操作未完成，请稍后重试。");
  return data;
}
function invitationToken(value: string) {
  try {
    const url = new URL(value);
    return (
      new URLSearchParams(url.hash.slice(1)).get("token") ||
      url.searchParams.get("invite") ||
      value.trim()
    );
  } catch {
    return value.trim();
  }
}

export default function ResearchPortal({
  sandbox = false,
}: {
  sandbox?: boolean;
}) {
  const [actor, setActor] = useState<Actor | null>(null);
  const [boot, setBoot] = useState(true);
  const [bootstrapAvailable, setBootstrapAvailable] = useState(false);
  const [mode, setMode] = useState<"login" | "bootstrap" | "register">("login");
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<Data | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pseudonym, setPseudonym] = useState("");
  const [home, setHome] = useState<Data>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"participants" | "invitations">(
    "participants",
  );
  const [inviteKind, setInviteKind] = useState("TARGET");
  const [freshInvite, setFreshInvite] = useState<Data | null>(null);
  const [copied, setCopied] = useState(false);

  const loadHome = useCallback(async () => {
    setHome(await portalRequest("home"));
  }, []);
  const loadMe = useCallback(async () => {
    const me = await portalRequest("me");
    setActor(me.actor);
    setBootstrapAvailable(Boolean(me.bootstrapAvailable));
    return me;
  }, []);
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const invite =
      params.get("token") ||
      new URLSearchParams(window.location.search).get("invite");
    if (invite) {
      setToken(invite);
      setMode("register");
      window.history.replaceState(null, "", window.location.pathname);
    }
    loadMe()
      .then((me) => {
        if (active && !invite && !me.actor && me.bootstrapAvailable)
          setMode("bootstrap");
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBoot(false);
      });
    return () => {
      active = false;
    };
  }, [loadMe]);
  useEffect(() => {
    if (!actor || sandbox) return;
    loadHome().catch((e) => setError(e.message));
  }, [actor, loadHome, sandbox]);
  useEffect(() => {
    if (mode !== "register" || !token) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      portalCommand("inspectInvitation", { token: invitationToken(token) })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(timer);
  }, [token, mode]);
  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await portalCommand(mode, {
        username,
        password,
        ...(mode !== "login" ? { pseudonym } : {}),
        ...(mode === "register" ? { token: invitationToken(token) } : {}),
      });
      setPassword("");
      setToken("");
      setPreview(null);
      await loadMe();
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    setBusy(true);
    setError("");
    try {
      await portalCommand("logout");
      setActor(null);
      setHome({});
      setFreshInvite(null);
      setMode("login");
      await loadMe();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const createInvite = async () => {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const invite = await portalCommand("invite", { kind: inviteKind });
      setFreshInvite({ ...invite, url: window.location.origin + invite.path });
      await loadHome();
      setTab("invitations");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const revokeInvite = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await portalCommand("revoke", { id });
      if (freshInvite?.id === id) setFreshInvite(null);
      await loadHome();
      setNotice("邀请已撤销，原链接无法再用于注册。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (boot)
    return (
      <div className="rp-loading">
        <LoaderCircle className="spin" size={28} />
        <p>正在连接研究端…</p>
      </div>
    );
  if (!actor)
    return (
      <main className="rp-auth">
        <a href="/" className="portal-brand">
          <span className="portal-mark">s/</span>
          <b>self / study</b>
        </a>
        <div className="rp-auth-grid">
          <section className="rp-auth-intro">
            <span className="portal-eyebrow">RESEARCH WORKSPACE</span>
            <h1>
              让研究有序，
              <br />
              让参与安心。
            </h1>
            <p>
              研究人员与分析人员的独立工作空间。
              <br />
              通过邀请连接 Target，再由本人邀请朋友加入。
            </p>
            <div className="rp-flow">
              <span>
                <FlaskConical size={22} />
                研究人员
              </span>
              <ArrowRight size={18} />
              <span>
                <Users size={22} />
                Target
              </span>
              <ArrowRight size={18} />
              <span>
                <MessageCircle size={22} />
                Friend
              </span>
            </div>
            <div className="rp-auth-note">
              <ShieldCheck size={20} />
              <p>
                账号角色在创建时确定。参与者从自己的门户进入，AI
                模型目前尚未启用。
              </p>
            </div>
          </section>
          <section className="rp-auth-card">
            <span className="rp-chip">
              <LockKeyhole size={14} />
              研究端 · RESEARCH
            </span>
            <h2>
              {mode === "bootstrap"
                ? "设置首个研究员账号"
                : mode === "register"
                  ? "接受分析人员邀请"
                  : "欢迎回到研究工作台"}
            </h2>
            <p>
              {mode === "bootstrap"
                ? "首次本机启动，请创建你的研究员账号。完成后，这个初始化入口会自动关闭。"
                : mode === "register"
                  ? "使用研究员提供的邀请链接创建账号，权限由邀请确定。"
                  : "使用你的研究员或分析人员账号登录。"}
            </p>
            <form onSubmit={signIn} className="rp-form">
              {mode === "register" && (
                <label>
                  邀请链接或邀请码
                  <input
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    required
                    autoComplete="off"
                    placeholder="粘贴分析人员邀请链接"
                  />
                  {preview && (
                    <small>
                      邀请身份：{roleNames[preview.kind] || "分析人员"} · 到期{" "}
                      {formatDate(preview.expiresAt)}
                    </small>
                  )}
                </label>
              )}
              {mode !== "login" && (
                <label>
                  显示名称
                  <input
                    value={pseudonym}
                    onChange={(e) => setPseudonym(e.target.value)}
                    required
                    maxLength={40}
                    autoComplete="nickname"
                    placeholder="例如：林研究员"
                  />
                </label>
              )}
              <label>
                用户名
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  minLength={3}
                  maxLength={40}
                  autoComplete="username"
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}"
                  placeholder="使用字母、数字、下划线或短横线"
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === "login" ? 1 : 12}
                  maxLength={128}
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  placeholder={mode === "login" ? "输入密码" : "至少 12 个字符"}
                />
              </label>
              {error && (
                <div className="rp-error" role="alert">
                  {error}
                </div>
              )}
              <button className="rp-button rp-primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle size={18} className="spin" />
                ) : (
                  <ArrowRight size={18} />
                )}
                {mode === "bootstrap"
                  ? "创建研究员账号"
                  : mode === "register"
                    ? "创建账号并进入"
                    : "登录研究端"}
              </button>
            </form>
            <div className="rp-auth-options">
              {mode !== "login" && (
                <button
                  onClick={() => {
                    setMode("login");
                    setError("");
                  }}
                >
                  已有账号？登录
                </button>
              )}
              {mode !== "register" && (
                <button
                  onClick={() => {
                    setMode("register");
                    setError("");
                  }}
                >
                  我有分析人员邀请
                </button>
              )}
              {bootstrapAvailable && mode !== "bootstrap" && (
                <button
                  onClick={() => {
                    setMode("bootstrap");
                    setError("");
                  }}
                >
                  首次设置研究员
                </button>
              )}
            </div>
            <a className="rp-back" href="/">
              <ArrowLeft size={14} />
              返回入口选择
            </a>
          </section>
        </div>
      </main>
    );
  if (sandbox)
    return (
      <StudyApp authenticatedActor={actor} onSignOut={() => void logout()} />
    );
  const isResearcher = actor.role === "RESEARCHER";
  const participants: Data[] = home.participants || [];
  const invitations: Data[] = home.invitations || [];
  return (
    <div className="rp-shell">
      <aside className="rp-sidebar">
        <a href="/" className="portal-brand">
          <span className="portal-mark">s/</span>
          <b>self / study</b>
        </a>
        <div className="rp-workspace">
          <FlaskConical size={21} />
          <div>
            <strong>研究工作台</strong>
            <small>Research workspace</small>
          </div>
        </div>
        <nav>
          <button
            className="rp-nav active"
            onClick={() => setTab("participants")}
          >
            <Users size={19} />
            参与者与邀请
          </button>
          <a href="/research/sandbox" className="rp-nav">
            <LayoutDashboard size={19} />
            研究流程演练
            <ArrowUpRight size={16} />
          </a>
        </nav>
        <div className="rp-sidebar-bottom">
          <div className="rp-model-state">
            <span />
            模型未连接<small>正式实验尚未开启</small>
          </div>
          <button className="rp-account" onClick={logout} disabled={busy}>
            <span className="rp-avatar">{actor.pseudonym.slice(0, 1)}</span>
            <span>
              <b>{actor.pseudonym}</b>
              <small>{roleNames[actor.role]}</small>
            </span>
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="rp-main">
        <header className="rp-topbar">
          <span>
            研究空间 <span className="rp-slash">/</span>
            <b>参与者与邀请</b>
          </span>
          <a href="/">
            全部入口
            <ArrowUpRight size={15} />
          </a>
        </header>
        <main className="rp-content">
          <div className="rp-heading">
            <div>
              <span className="portal-eyebrow">PARTICIPANT ENROLLMENT</span>
              <h1>
                让参与，从邀请开始<span>。</span>
              </h1>
              <p>
                {isResearcher
                  ? "邀请本人加入，查看账号注册与聊天准备进度。"
                  : "查看参与和聊天准备进度；邀请由研究人员管理。"}
              </p>
            </div>
            <button
              className="rp-button"
              onClick={() => {
                setError("");
                loadHome().catch((e) => setError(e.message));
              }}
            >
              <RefreshCw size={16} />
              刷新
            </button>
          </div>
          {error && (
            <div role="alert" className="rp-error">
              {error}
            </div>
          )}
          {notice && (
            <div className="rp-notice" role="status">
              <CheckCircle2 size={18} />
              {notice}
              <button onClick={() => setNotice("")} aria-label="关闭提示">
                <X size={16} />
              </button>
            </div>
          )}
          <div className="rp-stage-banner">
            <span className="rp-stage-icon">
              <MessageCircle size={24} />
            </span>
            <div>
              <h2>当前阶段：账号加入与真人聊天准备</h2>
              <p>
                双方通过专属入口聊天；AI
                模型尚未连接。准备区聊天不会进入实验评分、分身语料或冻结分组。
              </p>
            </div>
            <span className="rp-chip">准备阶段</span>
          </div>
          <div className="rp-stats">
            {[
              ["targets", "已加入 Target", Users],
              ["friends", "已加入 Friend", Users],
              ["rooms", "专属聊天室", MessageCircle],
              ["activeRooms", "进行中的聊天", CheckCircle2],
            ].map(([key, label, Icon]) => {
              const MetricIcon = Icon as typeof Users;
              return (
                <div className="rp-stat" key={String(key)}>
                  <span>
                    {String(label)}
                    <MetricIcon size={19} />
                  </span>
                  <strong>{home.stats?.[String(key)] ?? "—"}</strong>
                  <small>真人准备区</small>
                </div>
              );
            })}
          </div>
          <section className="rp-invite-strip">
            <div>
              <h2>{isResearcher ? "邀请新成员" : "按权限协作"}</h2>
              <p>
                {isResearcher
                  ? "Target 加入后，可从自己的空间邀请最多三位 Friend。"
                  : "分析人员可查看准备进度和研究演练数据，不读取私人聊天正文。"}
              </p>
            </div>
            {isResearcher ? (
              <div className="rp-inline">
                <select
                  aria-label="邀请身份"
                  value={inviteKind}
                  onChange={(e) => setInviteKind(e.target.value)}
                >
                  <option value="TARGET">邀请 Target</option>
                  <option value="ANALYST">邀请分析人员</option>
                </select>
                <button
                  className="rp-button rp-primary"
                  disabled={busy}
                  onClick={createInvite}
                >
                  <Plus size={18} />
                  {busy ? "正在创建…" : "创建邀请链接"}
                </button>
              </div>
            ) : (
              <a className="rp-button" href="/research/sandbox">
                查看研究演练
                <ArrowUpRight size={17} />
              </a>
            )}
          </section>
          {freshInvite && (
            <section className="rp-fresh-invite" aria-label="新邀请链接">
              <div className="rp-inline">
                <Link2 size={20} />
                <strong>{roleNames[freshInvite.kind]} 邀请已创建</strong>
                <span>到期 {formatDate(freshInvite.expiresAt)}</span>
              </div>
              <p>
                复制链接并自行分享给受邀人。链接仅供一人注册，本次关闭后不会再次显示完整链接。
              </p>
              <div className="rp-inline">
                <input
                  aria-label="邀请链接"
                  readOnly
                  value={freshInvite.url}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  className="rp-button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(freshInvite.url);
                      setCopied(true);
                    } catch {
                      setNotice("请选中邀请链接并手动复制。");
                    }
                  }}
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? "已复制" : "复制链接"}
                </button>
              </div>
            </section>
          )}
          <section className="rp-panel">
            <div className="rp-panel-head">
              <div className="rp-tabs">
                <button
                  className={tab === "participants" ? "active" : ""}
                  onClick={() => setTab("participants")}
                >
                  已加入成员<span>{participants.length}</span>
                </button>
                {isResearcher && (
                  <button
                    className={tab === "invitations" ? "active" : ""}
                    onClick={() => setTab("invitations")}
                  >
                    邀请记录<span>{invitations.length}</span>
                  </button>
                )}
              </div>
              <span className="rp-muted">真实账号 · 独立于合成演练</span>
            </div>
            {tab === "participants" ? (
              participants.length ? (
                <div className="rp-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>成员</th>
                        <th>身份</th>
                        <th>参与状态</th>
                        <th>加入时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {participants.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <span className="rp-name">
                              <span className="rp-avatar">
                                {p.pseudonym.slice(0, 1)}
                              </span>
                              <b>{p.pseudonym}</b>
                            </span>
                          </td>
                          <td>{roleNames[p.role] || p.role}</td>
                          <td>
                            <span
                              className={`rp-status ${!p.active || p.participation === false ? "muted" : ""}`}
                            >
                              {!p.active
                                ? "已退出"
                                : p.participation === false
                                  ? "已暂停参与"
                                  : p.participation === null
                                    ? "管理成员"
                                    : "已同意参与"}
                            </span>
                          </td>
                          <td>{formatDate(p.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rp-empty">
                  <Users size={34} />
                  <h3>等待第一位参与者加入</h3>
                  <p>
                    {isResearcher
                      ? "创建 Target 邀请链接，分享给准备加入的本人。"
                      : "研究员发出邀请、成员注册后，将在这里显示进度。"}
                  </p>
                </div>
              )
            ) : invitations.length ? (
              <div className="rp-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>邀请身份</th>
                      <th>状态</th>
                      <th>创建时间</th>
                      <th>到期时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((invite) => (
                      <tr key={invite.id}>
                        <td>
                          <b>{roleNames[invite.kind]}</b>
                        </td>
                        <td>
                          <span
                            className={`rp-status ${invite.status === "PENDING" || invite.status === "ACCEPTED" ? "" : "muted"}`}
                          >
                            {statuses[invite.status] || invite.status}
                          </span>
                        </td>
                        <td>{formatDate(invite.createdAt)}</td>
                        <td>{formatDate(invite.expiresAt)}</td>
                        <td>
                          {invite.status === "PENDING" ? (
                            <button
                              className="rp-text-button"
                              disabled={busy}
                              onClick={() => revokeInvite(invite.id)}
                            >
                              撤销邀请
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rp-empty">
                <Link2 size={34} />
                <h3>还没有邀请记录</h3>
                <p>创建邀请后，可以在这里查看是否已被接受。</p>
              </div>
            )}
          </section>
          <footer className="rp-footer">
            <b>SELF / STUDY</b>
            <span>
              <ShieldCheck size={14} />
              研究端仅显示准备进度，不展示私人聊天正文。
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
