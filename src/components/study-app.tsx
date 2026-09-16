"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Database,
  FileCheck2,
  Fingerprint,
  FlaskConical,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  Square,
  Users,
  X,
  CalendarDays,
  Layers3,
  CircleDot,
  AlertTriangle,
  CheckCircle2,
  Clock3,
} from "lucide-react";
import Development from "./development";
import Evaluations from "./evaluations";
import { io, type Socket } from "socket.io-client";

const FeedbackContext = createContext("");
type RecordData = Record<string, any>;
type Actor = {
  id: string;
  role: "RESEARCHER" | "TARGET" | "FRIEND" | "ANALYST";
  pseudonym: string;
};
type View =
  | "dashboard"
  | "sessions"
  | "onboarding"
  | "offline"
  | "consent"
  | "safety"
  | "data"
  | "settings"
  | "relationship"
  | "evaluations";
const labels: Record<string, string> = {
  SCHEDULED: "待排期",
  READY: "待开始",
  ACTIVE: "进行中",
  PAUSED_TECHNICAL: "技术暂停",
  PAUSED_SAFETY: "安全暂停",
  STAFF_CONTACT: "研究人员处理",
  ENDED: "已结束",
  WITHDRAWN: "已退出",
  APPROVED: "已批准",
  PENDING: "待审查",
  FLAGGED: "需处理",
  FROZEN: "已冻结",
  DRAFT: "草稿",
  COMPLETED: "已完成",
  OPEN: "待处理",
  ACKNOWLEDGED: "已确认",
  RESOLVED: "已处理",
  REVOKED: "已撤销",
  INVALIDATED: "已失效",
  REQUESTED: "已申请",
};
const roleNames = {
  RESEARCHER: "研究者",
  TARGET: "Target · 本人",
  FRIEND: "Friend · 朋友",
  ANALYST: "分析人员",
};
const navItems: {
  id: View;
  label: string;
  icon: typeof Activity;
  group?: string;
}[] = [
  { id: "dashboard", label: "研究概览", icon: LayoutDashboard },
  { id: "sessions", label: "会话与排期", icon: MessageCircle },
  { id: "onboarding", label: "分身构建", icon: Fingerprint },
  { id: "offline", label: "片段评价", icon: ClipboardList },
  { id: "evaluations", label: "自我—他者评价", icon: Users },
  { id: "relationship", label: "关系测量", icon: Users },
  { id: "consent", label: "同意与撤回", icon: FileCheck2 },
  { id: "safety", label: "安全监控", icon: ShieldCheck, group: "研究管理" },
  { id: "data", label: "数据与审计", icon: Database },
  { id: "settings", label: "研究配置", icon: Settings2 },
];
const subtitles: Record<View, string> = {
  evaluations: "用相同内容独立评价，保留每个人的表达判断。",
  dashboard: "掌握研究进度，让每一次对话有序进行。",
  sessions: "统一聊天入口，按既定流程开始、暂停和结束。",
  onboarding: "从经过授权的文字，建立可追溯的表达档案。",
  offline: "独立阅读片段，记录你对表达的判断。",
  relationship: "记录此刻的关系感受，每个问题都可以跳过。",
  consent: "你始终可以决定资料如何被使用。",
  safety: "查看研究暂停事件与处置记录。",
  data: "按权限导出数据，并保留完整的操作轨迹。",
  settings: "查看冻结配置、研究版本与启动条件。",
};
const topicNames: Record<string, string> = {
  CATCH_UP: "近况闲聊",
  SHARED_MEMORY: "低敏感共同往事",
  OPINIONS: "一般观点",
  BOUNDED_SUPPORT: "有限边界的情绪支持",
  HYPOTHETICAL_PLAN: "假设共同计划",
};
const topicName = (t?: string) => topicNames[t || ""] || t || "日常话题";
const time = (s?: string) =>
  s
    ? new Date(s).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
function Badge({ value, children }: { value?: string; children?: ReactNode }) {
  return (
    <span className={`badge badge-${value?.toLowerCase() || "default"}`}>
      <i />
      {children || labels[value || ""] || value}
    </span>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <Layers3 size={30} />
      <p>{children}</p>
    </div>
  );
}
function Button({
  children,
  onClick,
  primary = false,
  danger = false,
  disabled = false,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      className={`button ${primary ? "primary" : ""} ${danger ? "danger" : ""} ${className}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const error = useContext(FeedbackContext);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className={`modal ${wide ? "wide" : ""}`}
      ref={ref}
      onCancel={onClose}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button aria-label="关闭" className="icon-button" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {error && (
        <div role="alert" className="alert error modal-error">
          {error}
        </div>
      )}
      {children}
    </dialog>
  );
}
async function request(view: string, id?: string) {
  const res = await fetch(
    `/api/study?view=${encodeURIComponent(view)}${id ? `&id=${encodeURIComponent(id)}` : ""}`,
    { cache: "no-store", headers: researchHeaders() },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "暂时无法读取数据。");
  return data;
}
async function command(action: string, payload: RecordData = {}) {
  const res = await fetch("/api/study", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...researchHeaders() },
    body: JSON.stringify({ action, payload }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "操作未完成。");
  return data;
}

function researchHeaders(): Record<string, string> {
  return typeof window !== "undefined" &&
    window.location.pathname.startsWith("/research")
    ? { "x-study-portal": "research" }
    : {};
}

export default function StudyApp({
  authenticatedActor,
  onSignOut,
}: {
  authenticatedActor?: Actor;
  onSignOut?: () => void;
} = {}) {
  const researchPortal = Boolean(authenticatedActor);
  const [actor, setActor] = useState<Actor | null>(authenticatedActor || null);
  const [boot, setBoot] = useState(!authenticatedActor);
  const [synthetic, setSynthetic] = useState(false);
  const [view, setView] = useState<View>("dashboard");
  const [data, setData] = useState<RecordData>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecordData | null>(null);
  const [survey, setSurvey] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [loginRole, setLoginRole] = useState<Actor["role"]>("RESEARCHER");
  const [mobileNav, setMobileNav] = useState(false);
  const socket = useRef<Socket | null>(null);
  useEffect(() => {
    if (authenticatedActor) {
      setActor(authenticatedActor);
      setSynthetic(true);
      setView(authenticatedActor.role === "ANALYST" ? "data" : "dashboard");
      setBoot(false);
      return;
    }
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d) => {
        setActor(d.actor);
        setSynthetic(d.synthetic);
        if (d.actor)
          setView(
            d.actor.role === "RESEARCHER"
              ? "dashboard"
              : d.actor.role === "TARGET"
                ? "onboarding"
                : d.actor.role === "ANALYST"
                  ? "data"
                  : "sessions",
          );
      })
      .catch(() => setFailure("无法连接研究服务。"))
      .finally(() => setBoot(false));
  }, [authenticatedActor]);
  const refresh = useCallback(async () => {
    if (!actor) return;
    setLoading(true);
    try {
      const next = await request(
        view === "data" ? "audit" : view === "settings" ? "study" : view,
      );
      setData(Array.isArray(next) ? { items: next } : next);
      setFailure("");
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [actor, view]);
  useEffect(() => {
    setData({});
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!actor || !selected) return;
    let alive = true;
    const fetchDetail = () =>
      request("session", selected)
        .then((d) => {
          if (alive) setDetail(d);
        })
        .catch((e) => {
          if (alive) setFailure(e.message);
        });
    fetchDetail();
    const timer = setInterval(fetchDetail, 2000);
    const conn = researchPortal
      ? null
      : io({
          path: "/socket.io",
          transports: ["websocket", "polling"],
          reconnectionAttempts: 3,
        });
    socket.current = conn;
    conn?.on("connect", () =>
      conn.emit("session:watch", { sessionId: selected }),
    );
    conn?.on("session:update", (d: RecordData) => {
      if (alive && d.id === selected) setDetail(d);
    });
    return () => {
      alive = false;
      clearInterval(timer);
      conn?.disconnect();
      socket.current = null;
    };
  }, [selected, actor, researchPortal]);
  const act = async (
    action: string,
    payload: RecordData = {},
    message = "已保存。",
  ) => {
    setBusy(true);
    setFailure("");
    try {
      const result = await command(action, payload);
      if (message) setNotice(message);
      await refresh();
      if (selected) {
        try {
          setDetail(await request("session", selected));
        } catch {
          setSelected(null);
          setDetail(null);
        }
      }
      return result;
    } catch (e) {
      setFailure((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const login = async (role: Actor["role"]) => {
    setBusy(true);
    setFailure("");
    try {
      const r = await fetch("/api/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { "x-demo-access-token": accessToken } : {}),
        },
        body: JSON.stringify({ role }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      const session = await fetch("/api/auth").then((x) => x.json());
      setActor(session.actor);
      setView(
        role === "RESEARCHER"
          ? "dashboard"
          : role === "TARGET"
            ? "onboarding"
            : role === "ANALYST"
              ? "data"
              : "sessions",
      );
      setSelected(null);
      setDetail(null);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    if (onSignOut) {
      onSignOut();
      return;
    }
    await fetch("/api/auth", { method: "DELETE" });
    setActor(null);
    setSelected(null);
    setData({});
  };
  const staff = actor?.role === "RESEARCHER";
  const analyst = actor?.role === "ANALYST";
  const target = actor?.role === "TARGET";
  const allowed = (id: View) =>
    staff
      ? id !== "relationship"
      : analyst
        ? ["data", "settings", "evaluations"].includes(id)
        : target
          ? [
              "sessions",
              "onboarding",
              "consent",
              "relationship",
              "evaluations",
            ].includes(id)
          : [
              "sessions",
              "consent",
              "offline",
              "relationship",
              "evaluations",
            ].includes(id);
  const navigate = (id: View) => {
    setView(id);
    setSelected(null);
    setDetail(null);
    setFailure("");
    setMobileNav(false);
    setFilter("ALL");
    setSearch("");
  };
  if (boot)
    return (
      <div className="boot">
        <div className="brand-mark">
          s<span>/</span>
        </div>
        <p>正在连接研究工作台…</p>
      </div>
    );
  if (!actor)
    return (
      <main className="login-shell">
        <div className="login-brand">
          <div className="brand-mark">
            s<span>/</span>
          </div>
          <span>self / study</span>
        </div>
        <div className="login-grid">
          <section className="login-intro">
            <span className="eyebrow">AI SELF-CLONE RESEARCH</span>
            <h1>
              理解表达，
              <br />
              也理解关系。
            </h1>
            <p>一个用于 AI 分身、熟人识别与关系真实性研究的工作空间。</p>
            <div className="login-values">
              <span>
                <ShieldCheck size={18} />
                知情参与
              </span>
              <span>
                <LockKeyhole size={18} />
                独立权限
              </span>
              <span>
                <RefreshCw size={18} />
                随时撤回
              </span>
            </div>
            <div className="orbital" aria-hidden="true">
              <div className="orbit-one" />
              <div className="orbit-two" />
              <div className="orbit-label">self</div>
              <div className="orbit-label second">other</div>
            </div>
          </section>
          <section className="login-card">
            <span className="badge badge-ready">
              <FlaskConical size={14} />
              合成数据演练
            </span>
            <h2>进入研究工作台</h2>
            <p>
              所有示例人物、语料和对话均为合成数据。当前不会调用外部模型服务。
            </p>
            <label className="field-label" htmlFor="role">
              选择演练视角
            </label>
            <div className="role-options">
              {Object.entries(roleNames).map(([r, n]) => (
                <button
                  key={r}
                  onClick={() => setLoginRole(r as Actor["role"])}
                  className={loginRole === r ? "chosen" : ""}
                >
                  <span>{n}</span>
                  {loginRole === r ? (
                    <CheckCircle2 size={18} />
                  ) : (
                    <span className="radio-dot" />
                  )}
                </button>
              ))}
            </div>
            <details className="access-token">
              <summary>有演练访问码？</summary>
              <input
                type="password"
                autoComplete="off"
                aria-label="演练访问码"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="输入管理员提供的访问码"
              />
            </details>
            {failure && (
              <div role="alert" className="alert error">
                {failure}
              </div>
            )}
            <Button
              primary
              disabled={busy || !synthetic}
              onClick={() => login(loginRole)}
            >
              {busy ? "正在进入…" : "进入演练空间"}
              <ArrowRight size={17} />
            </Button>
            <div className="login-foot">
              <LockKeyhole size={14} />
              {synthetic
                ? "仅限本机演练 · 真人研究尚未开放"
                : "研究访问未开放，请联系管理员。"}
            </div>
          </section>
        </div>
        <footer>
          SELF / STUDY <span>知情、可追溯、可撤回的研究基础设施</span>
        </footer>
      </main>
    );
  return (
    <FeedbackContext.Provider value={failure}>
      <div className="app-shell">
        <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
          <button
            className="brand"
            onClick={() => navigate(staff ? "dashboard" : "sessions")}
          >
            <div className="brand-mark">
              s<span>/</span>
            </div>
            <strong>self / study</strong>
          </button>
          <div className="workspace-label">
            <span className="workspace-icon">
              <FlaskConical size={18} />
            </span>
            <div>
              <b>AI 分身研究</b>
              <small>Research workspace</small>
            </div>
            <ChevronDown size={15} />
          </div>
          <nav aria-label="主导航">
            {researchPortal && (
              <a className="nav-item" href="/research">
                <Users size={19} />
                <span>参与者与邀请</span>
                <ArrowUpRight size={16} />
              </a>
            )}
            {navItems
              .filter((n) => allowed(n.id))
              .map((n) => (
                <div key={n.id}>
                  {n.group && <div className="nav-group">{n.group}</div>}
                  <button
                    className={`nav-item ${view === n.id ? "active" : ""}`}
                    onClick={() => navigate(n.id)}
                  >
                    <n.icon size={19} />
                    <span>{n.label}</span>
                    {view === n.id && <span className="nav-current" />}
                  </button>
                </div>
              ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="synthetic-note">
              <FlaskConical size={17} />
              <div>
                <b>合成数据环境</b>
                <p>用于功能验证与流程演练</p>
              </div>
            </div>
            <button className="profile" onClick={logout}>
              <span className="avatar small">
                {actor.pseudonym.slice(0, 1)}
              </span>
              <span>
                <b>{actor.pseudonym}</b>
                <small>{roleNames[actor.role]}</small>
              </span>
              <LogOut size={17} />
            </button>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="mobile-toggle icon-button"
                onClick={() => setMobileNav(!mobileNav)}
                aria-label="切换导航"
              >
                <Layers3 size={20} />
              </button>
              <span>工作空间</span>
              <ChevronRight size={14} />
              <b>{navItems.find((n) => n.id === view)?.label}</b>
            </div>
            <div className="topbar-right">
              <span className="environment-dot" />
              合成数据模式
              <span className="top-separator" />
              {synthetic && !researchPortal && (
                <select
                  aria-label="切换演练视角"
                  value={actor.role}
                  onChange={(e) => login(e.target.value as Actor["role"])}
                >
                  {Object.entries(roleNames).map(([r, n]) => (
                    <option key={r} value={r}>
                      {n}
                    </option>
                  ))}
                </select>
              )}
              <span className="avatar tiny">{actor.pseudonym.slice(0, 1)}</span>
            </div>
          </header>
          <main className="content">
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  {view === "dashboard" ? "STUDY OVERVIEW" : view.toUpperCase()}
                </div>
                <h1>
                  {view === "dashboard"
                    ? "研究概览"
                    : navItems.find((n) => n.id === view)?.label}
                  <span className="heading-dot">.</span>
                </h1>
                <p>{subtitles[view]}</p>
              </div>
              <div className="heading-actions">
                <Button onClick={refresh} disabled={loading}>
                  <RefreshCw size={16} className={loading ? "spin" : ""} />
                  刷新
                </Button>
                {view === "dashboard" && (
                  <Button primary onClick={() => navigate("sessions")}>
                    查看会话
                    <ArrowUpRight size={16} />
                  </Button>
                )}
                {view === "onboarding" && target && (
                  <Button primary onClick={() => setImportOpen(true)}>
                    <Plus size={16} />
                    导入文字
                  </Button>
                )}
              </div>
            </div>
            {failure && (
              <div role="alert" className="alert error">
                <AlertTriangle size={18} />
                {failure}
                <button
                  className="icon-button"
                  aria-label="关闭错误提示"
                  onClick={() => setFailure("")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {notice && (
              <div role="status" className="toast">
                <CheckCircle2 size={18} />
                {notice}
              </div>
            )}
            {view === "dashboard" && (
              <Dashboard
                data={data}
                navigate={navigate}
                open={(id) => {
                  setSelected(id);
                  setView("sessions");
                }}
              />
            )}
            {view === "sessions" && (
              <>
                <div className="section-toolbar">
                  <div className="tabs" aria-label="会话筛选">
                    {[
                      ["ALL", "全部会话"],
                      ["ACTIVE", "进行中"],
                      ["READY", "待开始"],
                      ["ENDED", "已结束"],
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        className={filter === id ? "active" : ""}
                        onClick={() => setFilter(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="search">
                    <Search size={16} />
                    <input
                      aria-label="搜索会话"
                      placeholder="搜索参与者或话题"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                </div>
                <div className="panel">
                  <SessionTable
                    sessions={(data.sessions || data.items || []).filter(
                      (s: RecordData) =>
                        (filter === "ALL" || s.status === filter) &&
                        `${s.targetName} ${s.friendName} ${s.topic}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                    )}
                    onOpen={setSelected}
                    staff={staff}
                  />
                </div>
                <div className="footnote">
                  <ShieldCheck size={15} />
                  对话可能由本人或 AI 分身回复。你可以随时跳过话题、暂停或退出。
                </div>
              </>
            )}
            {view === "onboarding" && (
              <>
                <Onboarding
                  data={data}
                  target={target}
                  act={act}
                  busy={busy}
                  openImport={() => setImportOpen(true)}
                />
                {target && <Development act={act} busy={busy} />}
              </>
            )}
            {view === "offline" && (
              <Offline data={data} act={act} busy={busy} />
            )}
            {view === "consent" && (
              <Consent
                data={data}
                act={act}
                busy={busy}
                openWithdrawal={() => setWithdrawOpen(true)}
                staff={staff || analyst}
              />
            )}
            {view === "evaluations" && (
              <Evaluations data={data} actor={actor} act={act} busy={busy} />
            )}
            {view === "relationship" && (
              <Relationship data={data} act={act} busy={busy} />
            )}
            {view === "safety" && (
              <Safety
                data={data}
                act={act}
                busy={busy}
                open={(id) => {
                  setSelected(id);
                  setView("sessions");
                }}
              />
            )}
            {view === "data" && (
              <DataView data={data} act={act} setFailure={setFailure} />
            )}
            {view === "settings" && <SettingsView data={data} />}
            <footer className="content-footer">
              <span>SELF / STUDY</span>
              <span>
                <LockKeyhole size={12} />
                本机研究空间 · 合成数据演练
              </span>
            </footer>
          </main>
        </div>
        {selected && detail && (
          <Modal
            title="研究对话"
            onClose={() => {
              setSelected(null);
              setDetail(null);
            }}
            wide
          >
            <Chat
              detail={detail}
              actor={actor}
              act={act}
              busy={busy}
              onSurvey={() => setSurvey(true)}
            />
          </Modal>
        )}
        {survey && selected && (
          <Modal title="会话后评价" onClose={() => setSurvey(false)}>
            <Survey
              sessionId={selected}
              act={act}
              busy={busy}
              onDone={() => setSurvey(false)}
            />
          </Modal>
        )}
        {importOpen && (
          <Modal title="导入构建语料" onClose={() => setImportOpen(false)}>
            <ImportForm
              act={act}
              busy={busy}
              onDone={() => setImportOpen(false)}
            />
          </Modal>
        )}
        {withdrawOpen && (
          <Modal title="撤回研究数据" onClose={() => setWithdrawOpen(false)}>
            <Withdrawal
              act={act}
              busy={busy}
              onDone={() => setWithdrawOpen(false)}
            />
          </Modal>
        )}
      </div>
    </FeedbackContext.Provider>
  );
}

function Dashboard({
  data,
  navigate,
  open,
}: {
  data: RecordData;
  navigate: (v: View) => void;
  open: (id: string) => void;
}) {
  const s = data.stats || {};
  const total = s.sessions || 0;
  const completed = s.completed || 0;
  return (
    <>
      <div className="study-banner">
        <div className="study-banner-icon">
          <FlaskConical size={23} />
        </div>
        <div>
          <strong>当前为合成数据演练</strong>
          <p>正式研究尚未开放。所有参与者与记录均为虚构，供完整流程验证。</p>
        </div>
        <button onClick={() => navigate("settings")}>
          查看启动条件
          <ArrowRight size={16} />
        </button>
      </div>
      <div className="stat-grid">
        {[
          {
            label: "研究参与者",
            value: (s.targets || 0) + (s.friends || 0),
            meta: `${s.targets || 0} 位 Target · ${s.friends || 0} 位 Friend`,
            icon: Users,
          },
          {
            label: "研究配对",
            value: s.dyads || 0,
            meta: "每对独立分配与记录",
            icon: Layers3,
          },
          {
            label: "计划会话",
            value: total,
            meta: `${completed} 场已完成`,
            icon: MessageCircle,
          },
          {
            label: "当前进行中",
            value: s.active || 0,
            meta: `${s.paused || 0} 场暂停待处理`,
            icon: Activity,
          },
        ].map((x, i) => (
          <div className="stat-card" key={x.label}>
            <div className="stat-label">
              {x.label}
              <x.icon size={18} />
            </div>
            <div className="stat-value">
              {x.value.toString().padStart(2, "0")}
              <span className={`stat-mini stat-mini-${i}`}>
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
            <div className="stat-meta">{x.meta}</div>
          </div>
        ))}
      </div>
      <div className="overview-grid">
        <section className="panel progress-panel">
          <div className="panel-heading">
            <div>
              <h2>研究进度</h2>
              <p>从表达档案到独立评价</p>
            </div>
            <span className="muted">当前研究版本</span>
          </div>
          <div className="progress-main">
            <strong>
              {Math.round((completed / Math.max(total, 1)) * 100)}
              <small>%</small>
            </strong>
            <div>
              <b>会话完成进度</b>
              <p>
                {completed} / {total} 场会话已结束
              </p>
            </div>
            <span className="badge badge-ready">演练阶段</span>
          </div>
          <div className="progress-track">
            <span
              style={{ width: `${(completed / Math.max(total, 1)) * 100}%` }}
            />
          </div>
          <div className="milestones">
            {[
              {
                n: "01",
                label: "参与与同意",
                value: "独立授权",
                icon: FileCheck2,
              },
              {
                n: "02",
                label: "构建与冻结",
                value: `${s.personas || 0} 个表达档案`,
                icon: Fingerprint,
              },
              {
                n: "03",
                label: "研究对话",
                value: `${s.active || 0} 场进行中`,
                icon: MessageCircle,
              },
              {
                n: "04",
                label: "评价与揭示",
                value: "按阶段开放",
                icon: ClipboardList,
              },
            ].map((m, i) => (
              <div
                className={`milestone ${i === 2 ? "current" : ""}`}
                key={m.n}
              >
                <span className="milestone-icon">
                  <m.icon size={18} />
                </span>
                <small>{m.n}</small>
                <b>{m.label}</b>
                <p>{m.value}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="panel attention-panel">
          <div className="panel-heading">
            <h2>需要关注</h2>
            <span className="count-label">{(s.openSafety || 0) + 1}</span>
          </div>
          <div className="attention-item">
            <span className="attention-icon amber">
              <ShieldAlert size={19} />
            </span>
            <div>
              <b>正式研究启动条件</b>
              <p>伦理审批、供应商及值守配置待确认</p>
              <button onClick={() => navigate("settings")}>
                查看配置清单
                <ArrowRight size={14} />
              </button>
            </div>
          </div>
          <div className="attention-item">
            <span
              className={`attention-icon ${s.openSafety ? "amber" : "green"}`}
            >
              <Activity size={19} />
            </span>
            <div>
              <b>
                {s.openSafety
                  ? `${s.openSafety} 个安全事件待处理`
                  : "安全监控正常"}
              </b>
              <p>
                {s.openSafety
                  ? "研究已暂停，请按流程处理。"
                  : "暂停与退出入口始终可达。"}
              </p>
              <button onClick={() => navigate("safety")}>
                进入安全监控
                <ArrowRight size={14} />
              </button>
            </div>
          </div>
          <div className="privacy-reminder">
            <LockKeyhole size={15} />
            <span>参与者评分与未授权记录保持独立访问。</span>
          </div>
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div className="inline-heading">
            <h2>近期会话</h2>
            <span className="count-label">
              {data.recentSessions?.length || 0}
            </span>
          </div>
          <button className="text-button" onClick={() => navigate("sessions")}>
            全部会话
            <ArrowRight size={15} />
          </button>
        </div>
        <SessionTable
          sessions={data.recentSessions || []}
          onOpen={open}
          staff
          compact
        />
      </section>
      <div className="bottom-grid">
        <div className="panel small-panel">
          <span className="round-icon">
            <Fingerprint size={22} />
          </span>
          <div>
            <h3>构建个人表达档案</h3>
            <p>审查语料、预览风格并冻结版本。</p>
          </div>
          <button
            aria-label="打开分身构建"
            className="icon-button"
            onClick={() => navigate("onboarding")}
          >
            <ArrowUpRight size={21} />
          </button>
        </div>
        <div className="panel small-panel">
          <span className="round-icon">
            <Database size={22} />
          </span>
          <div>
            <h3>研究数据可追溯</h3>
            <p>查看审计记录与去标识化导出。</p>
          </div>
          <button
            aria-label="打开数据与审计"
            className="icon-button"
            onClick={() => navigate("data")}
          >
            <ArrowUpRight size={21} />
          </button>
        </div>
      </div>
    </>
  );
}
function SessionTable({
  sessions,
  onOpen,
  staff = false,
  compact = false,
}: {
  sessions: RecordData[];
  onOpen: (id: string) => void;
  staff?: boolean;
  compact?: boolean;
}) {
  return sessions.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>参与配对</th>
            <th>会话</th>
            <th>话题</th>
            <th>状态</th>
            <th>计划时间</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {sessions.slice(0, compact ? 5 : undefined).map((s) => (
            <tr key={s.id}>
              <td>
                <div className="person-cell">
                  <span className="avatar">
                    {(s.targetName || "T").slice(0, 1)}
                  </span>
                  <div>
                    <b>{s.targetName || "研究对象"}</b>
                    <small>{s.friendName || "研究参与者"}</small>
                  </div>
                </div>
              </td>
              <td>
                <span className="mono">
                  {String(s.index || s.sessionIndex || 1).padStart(2, "0")}
                </span>
              </td>
              <td>{topicName(s.topic || s.assignedTopic)}</td>
              <td>
                <Badge value={s.status} />
              </td>
              <td className="muted nowrap">{time(s.scheduledAt)}</td>
              <td>
                <button className="row-action" onClick={() => onOpen(s.id)}>
                  {staff ? "查看" : "进入"}
                  <ArrowUpRight size={15} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty>当前没有符合条件的会话。</Empty>
  );
}
function Chat({
  detail,
  actor,
  act,
  busy,
  onSurvey,
}: {
  detail: RecordData;
  actor: Actor;
  act: (a: string, p?: RecordData, m?: string) => Promise<any>;
  busy: boolean;
  onSurvey: () => void;
}) {
  const [text, setText] = useState("");
  const [debriefInfo, setDebriefInfo] = useState<RecordData | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const requestKey = useRef<string | null>(null);
  const acknowledged = useRef(new Set<string>());
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    for (const m of detail.messages || []) {
      if (
        m.deliveredAt &&
        !m.acknowledgedAt &&
        !acknowledged.current.has(m.id)
      ) {
        acknowledged.current.add(m.id);
        command("ackMessage", { sessionId: detail.id, messageId: m.id }).catch(
          () => acknowledged.current.delete(m.id),
        );
      }
    }
  }, [detail.messages, detail.id]);
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) return;
    requestKey.current ||= crypto.randomUUID();
    const result = await act(
      "sendMessage",
      { sessionId: detail.id, text, idempotencyKey: requestKey.current },
      "",
    );
    if (result) {
      setText("");
      requestKey.current = null;
    }
  };
  const control = (action: string) =>
    act("controlSession", { sessionId: detail.id, action });
  return (
    <div className="chat">
      <div className="chat-person">
        <span className="avatar">{detail.targetName?.slice(0, 1) || "T"}</span>
        <div>
          <b>{detail.targetName}</b>
          <small>{topicName(detail.topic)}</small>
        </div>
        <Badge value={detail.status} />
      </div>
      <div className="chat-notice">
        <ShieldCheck size={16} />
        <span>
          回复可能来自本人或 AI
          分身。研究暂不揭示当场来源。你可以随时跳过、暂停或结束。
        </span>
      </div>
      {actor.role === "TARGET" && (
        <div className="chat-notice">
          像日常一样聊天，不刻意证明自己是真人，也不刻意模仿 AI。
        </div>
      )}
      <div className="chat-messages" aria-label="对话记录" aria-live="polite">
        {!(detail.messages || []).length && (
          <Empty>会话准备就绪后，就可以开始交流。</Empty>
        )}
        {(detail.messages || []).map((m: RecordData) =>
          m.role === "STUDY_NOTICE" ? (
            <div className="study-notice" key={m.id}>
              {m.text}
            </div>
          ) : (
            <div
              key={m.id}
              className={`message ${m.role === "FRIEND" ? "from-friend" : "from-source"}`}
            >
              <small>
                {m.role === "FRIEND" ? detail.friendName : detail.targetName}
              </small>
              <p>{m.text}</p>
              <time>
                {m.deliveredAt
                  ? new Date(m.deliveredAt).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : ""}
              </time>
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>
      <form className="chat-compose" onSubmit={send}>
        <textarea
          aria-label="消息内容"
          placeholder={detail.canSend ? "写一条消息…" : "当前会话不可发送消息"}
          disabled={!detail.canSend || busy}
          value={text}
          maxLength={1200}
          onChange={(e) => {
            setText(e.target.value);
            requestKey.current = null;
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button
          primary
          type="submit"
          disabled={!detail.canSend || busy || !text.trim()}
        >
          <Send size={17} />
          <span>发送</span>
        </Button>
      </form>
      <div className="chat-actions">
        {["SCHEDULED", "READY"].includes(detail.status) &&
          actor.role === "RESEARCHER" && (
            <Button onClick={() => control("start")} disabled={busy}>
              <Play size={15} />
              开始会话
            </Button>
          )}
        {detail.status === "ACTIVE" && (
          <>
            <Button onClick={() => control("skip")} disabled={busy}>
              跳过话题
            </Button>
            <Button onClick={() => control("pause")} disabled={busy}>
              <Pause size={14} />
              暂停
            </Button>
          </>
        )}
        {detail.status === "PAUSED_TECHNICAL" &&
          actor.role === "RESEARCHER" && (
            <Button onClick={() => control("resume")} disabled={busy}>
              <Play size={15} />
              恢复
            </Button>
          )}
        {!["ENDED", "WITHDRAWN"].includes(detail.status) && (
          <Button onClick={() => control("end")} disabled={busy}>
            <Square size={13} />
            结束对话
          </Button>
        )}
        {detail.status === "ENDED" && actor.role === "FRIEND" && (
          <Button primary onClick={onSurvey}>
            填写评价
            <ArrowRight size={14} />
          </Button>
        )}
        {actor.role === "FRIEND" && (
          <Button
            onClick={async () => {
              const result = await act(
                "debrief",
                { sessionId: detail.id },
                "研究对话已结束。",
              );
              if (result) setDebriefInfo(result);
            }}
            disabled={busy}
          >
            结束盲测 / 请求解释
          </Button>
        )}
        {!["ENDED", "WITHDRAWN"].includes(detail.status) && (
          <Button danger onClick={() => control("withdraw")} disabled={busy}>
            退出本场
          </Button>
        )}
      </div>
      {debriefInfo && (
        <div className="debrief-info">
          <h3>{debriefInfo.title}</h3>
          <p>{debriefInfo.explanation}</p>
          {!detail.revealedSource && (
            <Button
              onClick={async () => {
                const result = await act(
                  "debrief",
                  { sessionId: detail.id, reveal: true },
                  "已按你的选择揭示来源。",
                );
                if (result) setDebriefInfo(result);
              }}
            >
              自愿查看已参与场次的来源
            </Button>
          )}
        </div>
      )}
      {detail.revealedSource && (
        <div className="alert">
          已按你的请求揭示：
          {detail.revealedSource === "HUMAN" ? "本人回复" : "AI 分身回复"}
          。来源判断不是友情或能力的测验。
        </div>
      )}
    </div>
  );
}
function Scale({
  name,
  label,
  min = 1,
  max = 5,
  value,
  onChange,
}: {
  name: string;
  label: string;
  min?: number;
  max?: number;
  value: any;
  onChange: (v: number | null) => void;
}) {
  return (
    <fieldset className="scale-field">
      <legend>{label}</legend>
      <div className="scale-options">
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
          <label key={n} className={Number(value) === n ? "selected" : ""}>
            <input
              type="radio"
              name={name}
              value={n}
              checked={Number(value) === n}
              onChange={() => onChange(n)}
            />
            {n}
          </label>
        ))}
        <button
          type="button"
          className={
            value === null || value === undefined ? "skip active" : "skip"
          }
          onClick={() => onChange(null)}
        >
          跳过
        </button>
      </div>
    </fieldset>
  );
}
function Survey({
  sessionId,
  act,
  busy,
  onDone,
}: {
  sessionId: string;
  act: any;
  busy: boolean;
  onDone: () => void;
}) {
  const [form, setForm] = useState<RecordData>({
    guess: null,
    confidence: null,
    likeness: null,
    relationalFit: null,
    naturalness: null,
    trust: null,
    comfort: null,
    reason: "",
    externalDiscussion: null,
  });
  const update = (key: string, value: any) =>
    setForm({ ...form, [key]: value });
  return (
    <form
      className="form-body"
      onSubmit={async (e) => {
        e.preventDefault();
        if (
          await act("submitSurvey", { ...form, sessionId }, "会话评价已保存。")
        )
          onDone();
      }}
    >
      <p className="muted">所有问题均可跳过；回答不会向聊天对象展示。</p>
      <fieldset>
        <legend>你认为这场回复的来源是？</legend>
        <div className="choice-row">
          {[
            ["HUMAN", "本人"],
            ["AI", "AI 分身"],
            ["", "跳过"],
          ].map(([v, l]) => (
            <label key={l}>
              <input
                name="guess"
                type="radio"
                checked={form.guess === (v || null)}
                onChange={() => {
                  update("guess", v || null);
                }}
              />
              {l}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field-label">
        对这个答案的信心（50–100，可留空）
        <input
          type="number"
          min="50"
          max="100"
          placeholder="跳过"
          value={form.confidence ?? ""}
          disabled={!form.guess}
          onChange={(e) =>
            update("confidence", e.target.value ? Number(e.target.value) : null)
          }
        />
      </label>
      {[
        ["likeness", "表达像对方的程度"],
        ["relationalFit", "符合你们通常的交流方式"],
        ["naturalness", "表达自然度"],
        ["trust", "信任程度"],
        ["comfort", "交流舒适程度"],
      ].map(([k, l]) => (
        <Scale
          key={k}
          name={k}
          label={l + "（1 低 · 5 高）"}
          value={form[k]}
          onChange={(v) => update(k, v)}
        />
      ))}
      <label className="field-label">
        可选理由
        <textarea
          maxLength={2000}
          value={form.reason}
          onChange={(e) => update("reason", e.target.value)}
          placeholder="哪些表达让你形成了这个判断？可留空。"
        />
      </label>
      <label className="field-label">
        是否在系统外讨论来源或收到直接提示？
        <select
          value={
            form.externalDiscussion === null
              ? ""
              : String(form.externalDiscussion)
          }
          onChange={(e) =>
            update(
              "externalDiscussion",
              e.target.value === "" ? null : e.target.value === "true",
            )
          }
        >
          <option value="">跳过</option>
          <option value="false">没有</option>
          <option value="true">有</option>
        </select>
      </label>
      <div className="modal-actions">
        <Button onClick={onDone}>暂不填写</Button>
        <Button primary type="submit" disabled={busy}>
          保存评价
        </Button>
      </div>
    </form>
  );
}
function Onboarding({
  data,
  target,
  act,
  busy,
  openImport,
}: {
  data: RecordData;
  target: boolean;
  act: any;
  busy: boolean;
  openImport: () => void;
}) {
  const c = data.counts || {};
  return (
    <>
      {data.overview && (
        <div className="study-banner">
          <Fingerprint size={23} />
          <div>
            <strong>
              {data.summary?.targets || 0} 位 Target ·{" "}
              {data.summary?.frozen || 0} 个冻结档案
            </strong>
            <p>
              研究者只查看构建进度。请切换到 Target
              演练视角，查看或操作自己的语料和开发预览。
            </p>
          </div>
        </div>
      )}
      <div className="stat-grid three">
        {[
          ["BUILD", "构建语料", "仅批准后用于表达档案"],
          ["DEV", "开发预览", "独立记录，不作效果评价"],
          ["HOLDOUT", "独立留出", "始终不进入构建与检索"],
        ].map(([k, l, m]) => (
          <div className="stat-card" key={k}>
            <div className="stat-label">
              {l}
              <span className="tag">{k}</span>
            </div>
            <div className="stat-value">
              {c[k] || 0}
              <small>条</small>
            </div>
            <div className="stat-meta">{m}</div>
          </div>
        ))}
      </div>
      <div className="overview-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>表达档案</h2>
              <p>{data.target?.pseudonym || "Target"} · 版本化管理</p>
            </div>
            <Fingerprint size={22} />
          </div>
          {(data.personas || []).length ? (
            data.personas.map((p: RecordData) => (
              <div className="persona-card" key={p.id}>
                <div className="persona-title">
                  <span className="avatar">T</span>
                  <h3>Persona v{p.version}</h3>
                  <Badge value={p.status} />
                </div>
                <dl>
                  <dt>语言风格</dt>
                  <dd>
                    {typeof p.style === "string"
                      ? p.style
                      : [
                          p.style?.language,
                          p.style?.sentenceLength,
                          p.style?.tone,
                          p.style?.emoji,
                          p.style?.particles?.length
                            ? `常用语气词：${p.style.particles.join("、")}`
                            : null,
                          p.style?.sampleCount
                            ? `依据 ${p.style.sampleCount} 条构建语料`
                            : null,
                          p.style?.calibrationCount
                            ? `${p.style.calibrationCount} 项校准`
                            : null,
                        ]
                          .filter(Boolean)
                          .join("；")}
                  </dd>
                  <dt>互动习惯</dt>
                  <dd>
                    {typeof p.interaction === "string"
                      ? p.interaction
                      : [
                          p.interaction?.opening,
                          p.interaction?.uncertainty,
                          p.interaction?.memory,
                        ]
                          .filter(Boolean)
                          .join("；")}
                  </dd>
                  <dt>冻结时间</dt>
                  <dd>{time(p.frozenAt)}</dd>
                </dl>
                {target && p.status !== "FROZEN" && (
                  <Button
                    onClick={() =>
                      act("freezePersona", { id: p.id }, "表达档案已冻结。")
                    }
                    disabled={busy}
                  >
                    <LockKeyhole size={15} />
                    冻结此版本
                  </Button>
                )}
              </div>
            ))
          ) : (
            <Empty>
              {data.overview
                ? "表达档案正文由各 Target 独立查看。"
                : "批准构建语料后，可以生成第一个表达档案。"}
            </Empty>
          )}
          {target && (
            <div className="panel-bottom">
              <Button
                primary
                disabled={busy}
                onClick={() => act("buildPersona", {}, "新的表达档案已生成。")}
              >
                <Sparkles size={16} />
                构建新版本
              </Button>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>构建流程</h2>
            <ShieldCheck size={20} />
          </div>
          <ol className="workflow-list">
            <li>
              <span>1</span>
              <div>
                <b>导入本人授权文字</b>
                <p>逐条保存消息边界，分配构建、开发与留出分区。</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <b>本地隐私审查</b>
                <p>标记联系方式及敏感信息，逐条处理后批准。</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <b>构建表达档案</b>
                <p>仅使用已批准的 BUILD 语料，保留来源记录。</p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <b>版本冻结</b>
                <p>冻结后不可原地修改，后续变更产生新版本。</p>
              </div>
            </li>
          </ol>
          <div className="privacy-reminder">
            <Clock3 size={16} />
            <span>
              节奏练习支持数：{data.baseline?.count || 0} ·{" "}
              {data.baseline?.status === "SUPPORTED"
                ? "已记录"
                : "证据不足，未验收"}
            </span>
          </div>
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>语料审查</h2>
          <span className="muted">{c.approved || 0} 条已批准</span>
        </div>
        {(data.corpus || []).length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>文字内容</th>
                  <th>分区</th>
                  <th>审查状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.corpus.map((item: RecordData) => (
                  <tr key={item.id}>
                    <td className="corpus-text">
                      {item.text || "正文已删除"}
                      {item.riskCodes?.length > 0 && (
                        <small className="risk-text">
                          需处理：
                          {item.riskCodes
                            .map((r: any) =>
                              typeof r === "string"
                                ? r
                                : r.kind || r.code || "隐私信息",
                            )
                            .join("、")}
                        </small>
                      )}
                    </td>
                    <td>
                      <span className="tag">{item.partition}</span>
                    </td>
                    <td>
                      <Badge value={item.reviewStatus} />
                    </td>
                    <td>
                      {target && item.reviewStatus !== "APPROVED" && (
                        <ReviewItem item={item} act={act} busy={busy} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            {data.overview ? "研究概览不展示个人语料正文。" : "尚未导入语料。"}
            {target && (
              <button className="text-button" onClick={openImport}>
                导入第一批文字
                <ArrowRight size={15} />
              </button>
            )}
          </Empty>
        )}
      </section>
    </>
  );
}
function ReviewItem({
  item,
  act,
  busy,
}: {
  item: RecordData;
  act: any;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(item.text);
  return (
    <>
      <Button onClick={() => setOpen(true)}>审查</Button>
      {open && (
        <Modal title="审查并批准文字" onClose={() => setOpen(false)}>
          <div className="form-body">
            <p>删除或替换识别性信息，保留自然语气与消息边界。</p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="处理后的文字"
              maxLength={4000}
            />
            <Button
              primary
              disabled={busy}
              onClick={async () => {
                if (
                  await act(
                    "approveCorpus",
                    { id: item.id, text },
                    "语料已批准。",
                  )
                )
                  setOpen(false);
              }}
            >
              批准处理后的文字
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function ImportForm({
  act,
  busy,
  onDone,
}: {
  act: any;
  busy: boolean;
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [partition, setPartition] = useState("BUILD");
  return (
    <form
      className="form-body"
      onSubmit={async (e) => {
        e.preventDefault();
        if (
          await act(
            "importCorpus",
            { texts: text.split("\n").filter((x) => x.trim()), partition },
            "语料已导入，等待逐条审查。",
          )
        )
          onDone();
      }}
    >
      <div className="alert">
        演练环境仅使用合成文字，请勿导入真实参与者资料。
      </div>
      <label className="field-label">
        数据分区
        <select
          value={partition}
          onChange={(e) => setPartition(e.target.value)}
        >
          <option>BUILD</option>
          <option>DEV</option>
          <option>HOLDOUT</option>
        </select>
      </label>
      <label className="field-label">
        每行一条消息
        <textarea
          required
          rows={8}
          maxLength={50000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"今天的小猫又在窗边睡着了哈哈\n周末想去散散步，你呢？"}
        />
      </label>
      <p className="muted">
        已检测到 {text.split("\n").filter((x) => x.trim()).length}{" "}
        条消息。近重复文本会保留关联并防止跨分区污染。
      </p>
      <div className="modal-actions">
        <Button onClick={onDone}>取消</Button>
        <Button primary type="submit" disabled={busy || !text.trim()}>
          导入并检查
        </Button>
      </div>
    </form>
  );
}
function Offline({
  data,
  act,
  busy,
}: {
  data: RecordData;
  act: any;
  busy: boolean;
}) {
  const [current, setCurrent] = useState<RecordData | null>(null);
  const [form, setForm] = useState<RecordData>({
    guess: null,
    confidence: null,
    naturalness: null,
    personLikeness: null,
  });
  return (
    <>
      <div className="study-banner">
        <span className="study-banner-icon">
          <BookOpen size={22} />
        </span>
        <div>
          <strong>独立片段评价</strong>
          <p>只展示经过双方授权的最小必要上下文。两种来源都可能出现。</p>
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>你的评价任务</h2>
          <span className="muted">已完成 {data.completed || 0} 项</span>
        </div>
        {(data.assignments || []).length ? (
          <div className="assignment-grid">
            {data.assignments.map((a: RecordData) => (
              <button
                className="assignment-card"
                key={a.id}
                onClick={() => {
                  setCurrent(a);
                  setForm({
                    guess: null,
                    confidence: null,
                    naturalness: null,
                    personLikeness: null,
                  });
                }}
              >
                <div>
                  <BookOpen size={21} />
                  <Badge value={a.status} />
                </div>
                <h3>{a.displayName || "匿名对话片段"}</h3>
                <p>{a.context || "阅读一段日常对话并完成独立判断。"}</p>
                <span>
                  查看片段
                  <ArrowRight size={16} />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <Empty>
            暂时没有可评价的授权片段。任务会在满足同意与研究阶段要求后开放。
          </Empty>
        )}
      </section>
      {current && (
        <Modal title="片段评价" onClose={() => setCurrent(null)}>
          <form
            className="form-body"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await act(
                  "submitOffline",
                  { ...form, assignmentId: current.id },
                  "独立评价已保存。",
                )
              )
                setCurrent(null);
            }}
          >
            <div className="stimulus">
              <small>对话上下文</small>
              <p>{current.context || "无额外上下文"}</p>
              <small>SOURCE</small>
              <p>{current.stimulusText}</p>
            </div>
            <label className="field-label">
              你认为 SOURCE 回复来自？
              <select
                value={form.guess || ""}
                onChange={(e) =>
                  setForm({ ...form, guess: e.target.value || null })
                }
              >
                <option value="">跳过</option>
                <option value="HUMAN">本人</option>
                <option value="AI">AI 分身</option>
              </select>
            </label>
            <label className="field-label">
              对答案的信心（50–100，可留空）
              <input
                type="number"
                min={50}
                max={100}
                value={form.confidence ?? ""}
                disabled={!form.guess}
                onChange={(e) =>
                  setForm({
                    ...form,
                    confidence: e.target.value ? +e.target.value : null,
                  })
                }
              />
            </label>
            <Scale
              name="naturalness"
              label="自然度（1 低 · 5 高）"
              value={form.naturalness}
              onChange={(v) => setForm({ ...form, naturalness: v })}
            />
            {current.canRatePersonLikeness && (
              <Scale
                name="personLikeness"
                label="表达像对方的程度"
                value={form.personLikeness}
                onChange={(v) => setForm({ ...form, personLikeness: v })}
              />
            )}
            <Button
              primary
              type="submit"
              disabled={busy || current.status === "COMPLETED"}
            >
              提交独立评价
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
function Consent({
  data,
  act,
  busy,
  openWithdrawal,
  staff,
}: {
  data: RecordData;
  act: any;
  busy: boolean;
  openWithdrawal: () => void;
  staff: boolean;
}) {
  const [form, setForm] = useState<RecordData>({});
  useEffect(() => setForm(data), [data]);
  const sharing = form.secondarySharing || {};
  const set = (k: string, v: boolean) => setForm({ ...form, [k]: v });
  return (
    <div className="consent-grid">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>独立知情同意</h2>
            <p>可以分别选择，后续也可以撤销。</p>
          </div>
          <FileCheck2 size={23} />
        </div>
        <div className="consent-body">
          <div className="alert">
            你知道研究对话可能由本人或 AI
            分身回复；你可以随时跳题、暂停、退出或请求研究解释。
          </div>
          {[
            [
              "participation",
              "参与研究",
              "同意在研究平台进行来源暂不披露的文字交流。",
            ],
            [
              "aiProcessing",
              "获批准的模型处理",
              "同意必要的已处理消息由获批准供应商处理。演练不会外发。",
            ],
            [
              "corpusUse",
              "构建语料使用",
              "允许本人授权文字用于构建个人表达档案。",
            ],
          ].map(([k, l, d]) => (
            <label className="consent-row" key={k}>
              <input
                type="checkbox"
                checked={!!form[k]}
                onChange={(e) => set(k, e.target.checked)}
              />
              <span>
                <b>{l}</b>
                <small>{d}</small>
              </span>
            </label>
          ))}
          <h3 className="subsection-label">可选的片段分享</h3>
          {[
            [
              "targetReview",
              "向原始 Target 分享",
              "仅限独立批准的片段，且整个 Target 区组已结束。",
            ],
            [
              "familiarRaters",
              "供其他熟悉评分者评价",
              "不包括片段原始 dyad 的朋友。",
            ],
            ["unfamiliarRaters", "供不熟悉评分者评价", "仅展示去标识化片段。"],
            ["publicQuote", "去标识化发表引用", "仅按许可范围使用获批准片段。"],
          ].map(([k, l, d]) => (
            <label className="consent-row" key={k}>
              <input
                type="checkbox"
                checked={!!sharing[k]}
                onChange={(e) =>
                  setForm({
                    ...form,
                    secondarySharing: { ...sharing, [k]: e.target.checked },
                  })
                }
              />
              <span>
                <b>{l}</b>
                <small>{d}</small>
              </span>
            </label>
          ))}
          <div className="panel-bottom">
            <Button
              primary
              disabled={busy || staff}
              onClick={() => act("saveConsent", form, "同意范围已更新。")}
            >
              保存我的选择
            </Button>
            <span className="muted">版本 {data.version || "consent-v1"}</span>
          </div>
          {staff && (
            <p className="muted">请切换到参与者演练视角，操作个人同意范围。</p>
          )}
        </div>
      </section>
      <aside>
        <section className="panel">
          <div className="panel-heading">
            <h2>撤回与删除</h2>
          </div>
          <div className="consent-body">
            <p>退出不需要先填完问卷，也不会要求说明理由。</p>
            <div className="withdraw-option">
              <h3>分析排除</h3>
              <p>停止后续使用，将对应数据从新分析和新导出中排除。</p>
            </div>
            <div className="withdraw-option">
              <h3>正文销毁</h3>
              <p>删除正文与相关衍生数据，保留不含正文的最小处理存根。</p>
            </div>
            <Button danger onClick={openWithdrawal} disabled={staff}>
              申请撤回或删除
            </Button>
          </div>
        </section>
        <div className="footnote">
          <LockKeyhole size={17} />
          正式研究的适用范围与期限将以批准的参与者说明为准。
        </div>
      </aside>
    </div>
  );
}
function Withdrawal({
  act,
  busy,
  onDone,
}: {
  act: any;
  busy: boolean;
  onDone: () => void;
}) {
  const [mode, setMode] = useState("ANALYSIS_EXCLUSION");
  const [confirmed, setConfirmed] = useState(false);
  return (
    <form
      className="form-body"
      onSubmit={async (e) => {
        e.preventDefault();
        if (
          await act(
            "requestWithdrawal",
            { mode, scope: "ALL" },
            mode === "ANALYSIS_EXCLUSION"
              ? "已停止后续使用，并从新导出中排除。"
              : "正文删除完成，最小审计存根已保存。",
          )
        )
          onDone();
      }}
    >
      <p>此操作将停止你的相关会话。请选择你希望的处理方式。</p>
      <label className="consent-row">
        <input
          type="radio"
          name="mode"
          checked={mode === "ANALYSIS_EXCLUSION"}
          onChange={() => setMode("ANALYSIS_EXCLUSION")}
        />
        <span>
          <b>分析排除</b>
          <small>保留获准数据，但停止后续研究使用。</small>
        </span>
      </label>
      <label className="consent-row">
        <input
          type="radio"
          name="mode"
          checked={mode === "CONTENT_DESTRUCTION"}
          onChange={() => setMode("CONTENT_DESTRUCTION")}
        />
        <span>
          <b>正文销毁</b>
          <small>
            删除相关正文和衍生物，无法撤销。无法分离的共同对话将整场移除。
          </small>
        </span>
      </label>
      <label className="consent-row">
        <input
          required
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <span>我了解所选操作的影响并确认提交。</span>
      </label>
      <div className="modal-actions">
        <Button onClick={onDone}>返回</Button>
        <Button danger type="submit" disabled={busy || !confirmed}>
          确认撤回
        </Button>
      </div>
    </form>
  );
}
function Safety({
  data,
  act,
  busy,
  open,
}: {
  data: RecordData;
  act: any;
  busy: boolean;
  open: (id: string) => void;
}) {
  return (
    <>
      <div className="study-banner">
        <span className="study-banner-icon">
          <ShieldAlert size={24} />
        </span>
        <div>
          <strong>安全暂停优先于实验流程</strong>
          <p>
            暂停会作废待发消息。工作人员以明确的研究人员身份处理，不继续代表聊天对象。
          </p>
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>事件记录</h2>
          <span className="muted">不展示危机原始正文</span>
        </div>
        {(data.events || []).length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>事件</th>
                  <th>参与配对</th>
                  <th>发生时间</th>
                  <th>状态</th>
                  <th>处置</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e: RecordData) => (
                  <tr key={e.id}>
                    <td>
                      <span className="risk-code">
                        <ShieldAlert size={17} />
                        {e.reasonCode}
                      </span>
                    </td>
                    <td>
                      {e.targetName} / {e.friendName}
                    </td>
                    <td>{time(e.createdAt)}</td>
                    <td>
                      <Badge value={e.status} />
                    </td>
                    <td>
                      <div className="button-row">
                        {e.status === "OPEN" && (
                          <Button
                            disabled={busy}
                            onClick={() =>
                              act(
                                "resolveSafety",
                                { id: e.id, action: "acknowledge" },
                                "已确认事件。",
                              )
                            }
                          >
                            确认
                          </Button>
                        )}
                        {e.status !== "RESOLVED" && (
                          <Button
                            disabled={busy}
                            onClick={() =>
                              act(
                                "resolveSafety",
                                {
                                  id: e.id,
                                  action: "resolve",
                                  outcome: "SYNTHETIC_DRILL_COMPLETED",
                                },
                                "演练处置已记录。",
                              )
                            }
                          >
                            完成处置
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>暂无安全事件。会话中的暂停与退出入口始终可用。</Empty>
        )}
      </section>
      <div className="footnote">
        演练中的本地规则仅用于验证处理流程，不能代替获批准的风险识别与人工值守。
      </div>
    </>
  );
}
function DataView({
  data,
  act,
  setFailure,
}: {
  data: RecordData;
  act: any;
  setFailure: (s: string) => void;
}) {
  const [exported, setExported] = useState<RecordData | null>(null);
  const [working, setWorking] = useState(false);
  const [withdrawals, setWithdrawals] = useState<RecordData | null>(null);
  useEffect(() => {
    request("withdrawals")
      .then(setWithdrawals)
      .catch(() => {});
  }, [data]);
  const generate = async () => {
    setWorking(true);
    try {
      setExported(await request("export"));
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const download = (name: string, content: string) => {
    const url = URL.createObjectURL(
      new Blob([name.endsWith(".json") ? content : "\uFEFF" + content], {
        type: name.endsWith(".json")
          ? "application/json"
          : "text/csv;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <section className="panel export-panel">
        <span className="export-icon">
          <Database size={28} />
        </span>
        <div>
          <h2>研究数据导出</h2>
          <p>
            六组关联数据、独立时间点与数据字典。每次导出生成可失效的 manifest。
          </p>
          <small>UTF-8 CSV · UTC 时间 · 保留缺答 · 公式注入防护</small>
        </div>
        <Button primary onClick={generate} disabled={working}>
          <ArrowDownToLine size={17} />
          {working ? "正在生成…" : "生成数据导出"}
        </Button>
      </section>
      {exported && (
        <section className="panel">
          <div className="panel-heading">
            <h2>本次导出文件</h2>
            <span className="mono muted">
              {exported.manifest?.id?.slice(0, 12)}
            </span>
          </div>
          <div className="export-files">
            {(exported.files || []).map((f: RecordData) => (
              <button key={f.name} onClick={() => download(f.name, f.content)}>
                <FileCheck2 size={22} />
                <div>
                  <b>{f.name}</b>
                  <small>{f.rows ?? "—"} 条记录</small>
                </div>
                <ArrowDownToLine size={17} />
              </button>
            ))}
            <button
              onClick={() =>
                download(
                  "manifest.json",
                  JSON.stringify(exported.manifest, null, 2),
                )
              }
            >
              <FileCheck2 size={22} />
              <div>
                <b>manifest.json</b>
                <small>导出追踪</small>
              </div>
              <ArrowDownToLine size={17} />
            </button>
            <button
              onClick={() =>
                download(
                  "dictionary.json",
                  JSON.stringify(exported.dictionary, null, 2),
                )
              }
            >
              <BookOpen size={22} />
              <div>
                <b>dictionary.json</b>
                <small>数据字典</small>
              </div>
              <ArrowDownToLine size={17} />
            </button>
          </div>
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>操作审计</h2>
          <span className="muted">日志不复制正文、提示词或身份信息</span>
        </div>
        {(data.logs || data.events || data.items || []).length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作</th>
                  <th>对象</th>
                  <th>原因代码</th>
                </tr>
              </thead>
              <tbody>
                {(data.logs || data.events || data.items || []).map(
                  (a: RecordData) => (
                    <tr key={a.id}>
                      <td className="nowrap">{time(a.createdAt)}</td>
                      <td>
                        <span className="audit-action">
                          <CircleDot size={13} />
                          {a.action}
                        </span>
                      </td>
                      <td className="mono">
                        {a.entityType ||
                          a.entityId?.slice(0, 16) ||
                          a.entity ||
                          "—"}
                      </td>
                      <td className="muted">{a.reasonCode || "—"}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>暂无操作记录。</Empty>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>撤回处理记录</h2>
        </div>
        {withdrawals?.requests?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>申请时间</th>
                  <th>处理方式</th>
                  <th>状态</th>
                  <th>完成时间</th>
                </tr>
              </thead>
              <tbody>
                {withdrawals.requests.map((r: RecordData) => (
                  <tr key={r.id}>
                    <td>{time(r.requestedAt)}</td>
                    <td>
                      {r.mode === "ANALYSIS_EXCLUSION"
                        ? "分析排除"
                        : "正文销毁"}
                    </td>
                    <td>
                      <Badge value={r.status} />
                    </td>
                    <td>{time(r.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>暂无撤回申请。</Empty>
        )}
      </section>
    </>
  );
}
function SettingsView({ data }: { data: RecordData }) {
  const missing = data.readiness?.missing || [];
  return (
    <>
      <div className="study-banner">
        <span className="study-banner-icon">
          <LockKeyhole size={24} />
        </span>
        <div>
          <strong>真人研究未开放</strong>
          <p>
            配置未获批准时，仅允许合成数据模式。界面无法绕过服务端启动条件。
          </p>
        </div>
        <Badge value="PENDING">待批准</Badge>
      </div>
      <div className="overview-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>研究合同</h2>
            <span className="tag">{data.status || "DRAFT"}</span>
          </div>
          <dl className="config-list">
            <dt>研究名称</dt>
            <dd>{data.name || "AI Self-Clone Study"}</dd>
            <dt>运行模式</dt>
            <dd>合成数据演练</dd>
            <dt>分配计划</dt>
            <dd>服务端冻结，参与者无权读取</dd>
            <dt>版本指纹</dt>
            <dd className="mono hash">{data.assignmentHash || "待生成"}</dd>
            <dt>数据边界</dt>
            <dd>无跨场记忆，无实时学习，无外部行动</dd>
          </dl>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>待批准配置</h2>
            <span className="count-label">{missing.length}</span>
          </div>
          <ul className="readiness-list">
            {missing.length ? (
              missing.map((m: any, i: number) => (
                <li key={i}>
                  <span className="pending-circle" />
                  <div>
                    <b>
                      {typeof m === "string" ? m : m.label || m.path || m.code}
                    </b>
                    <small>缺失或尚未批准</small>
                  </div>
                  <LockKeyhole size={15} />
                </li>
              ))
            ) : (
              <li>
                <span className="pending-circle" />
                <div>
                  <b>机构审批与正式发布验收</b>
                  <small>尚未开放</small>
                </div>
              </li>
            )}
          </ul>
        </section>
      </div>
      {data.balance && (
        <section className="panel">
          <div className="panel-heading">
            <h2>分配平衡报告</h2>
            <span className="muted">研究者私有</span>
          </div>
          <pre className="json-report">
            {JSON.stringify(data.balance, null, 2)}
          </pre>
        </section>
      )}
    </>
  );
}
function Relationship({
  data,
  act,
  busy,
}: {
  data: RecordData;
  act: any;
  busy: boolean;
}) {
  const [ios, setIos] = useState<number | null>(null);
  const [point, setPoint] = useState("BASELINE");
  const [dyadId, setDyadId] = useState("");
  return (
    <section className="panel relationship-panel">
      <div className="panel-heading">
        <div>
          <h2>此刻，你们的关系有多亲近？</h2>
          <p>选择最接近你感受的一组圆，也可以跳过。</p>
        </div>
        <Users size={23} />
      </div>
      <div className="form-body">
        <label className="field-label">
          关系配对
          <select
            value={dyadId || data.dyads?.[0]?.id || ""}
            onChange={(e) => setDyadId(e.target.value)}
          >
            {(data.dyads || []).map((d: RecordData) => (
              <option key={d.id} value={d.id}>
                {d.targetName} / {d.friendName}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          测量时间点
          <select value={point} onChange={(e) => setPoint(e.target.value)}>
            <option value="BASELINE">基线</option>
            <option value="PRE_DEBRIEF">最后会话后 · 揭示前</option>
            <option value="POST_DEBRIEF">揭示后</option>
          </select>
        </label>
        <fieldset className="ios-field">
          <legend>关系亲密度（七档）</legend>
          <div className="ios-options">
            {Array.from({ length: 7 }, (_, i) => i + 1).map((n) => (
              <label key={n} className={ios === n ? "selected" : ""}>
                <input
                  type="radio"
                  name="ios"
                  checked={ios === n}
                  onChange={() => setIos(n)}
                />
                <span
                  className="ios-circles"
                  style={
                    { "--overlap": `${(n - 1) * 7}px` } as React.CSSProperties
                  }
                >
                  <i />
                  <i />
                </span>
                <b>{n}</b>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="muted">
          圆分别代表“你”和“对方”；重叠越多，表示你感到越亲近。图示为平台演练版，正式测量题图与版本需批准。
        </p>
        <div className="button-row">
          <Button onClick={() => setIos(null)}>跳过</Button>
          <Button
            primary
            disabled={busy}
            onClick={() =>
              act(
                "saveRelationship",
                {
                  timepoint: point,
                  ios,
                  dyadId: dyadId || data.dyads?.[0]?.id,
                },
                "关系测量已保存。",
              )
            }
          >
            保存感受
          </Button>
        </div>
        {(data.ratings || data.measures || []).map((m: RecordData) => (
          <div className="measure-row" key={m.id}>
            <span>{m.timepoint}</span>
            <b>{m.ios ?? "已跳过"}</b>
            <span>{time(m.submittedAt)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
