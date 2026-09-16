"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  Copy,
  Link2,
  LoaderCircle,
  LogOut,
  MessageCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  UserRound,
  UserRoundPlus,
  UsersRound,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

type Portal = "target" | "friend";
type PortalActor = {
  id: string;
  role: string;
  pseudonym: string;
  timezone?: string;
};
type InvitationPreview = {
  kind: string;
  portal: string;
  expiresAt: string;
  inviterPseudonym?: string;
  consentVersion?: string;
};
type Invitation = {
  id: string;
  kind?: string;
  status?: string;
  expiresAt: string;
  createdAt?: string;
  inviteUrl?: string;
  url?: string;
  path?: string;
  token?: string;
  acceptedBy?: string | null;
  inviteePseudonym?: string | null;
};
type RoomSummary = {
  peer?: { id: string; pseudonym: string };
  targetPseudonym?: string;
  friendPseudonym?: string;
  stoppedByMe?: boolean;
  id: string;
  status: string;
  title?: string;
  counterpartName?: string;
  targetName?: string;
  friendName?: string;
  lastMessage?: { text?: string; createdAt?: string } | string | null;
  updatedAt?: string;
  createdAt?: string;
  canSend?: boolean;
};
type PortalMessage = {
  id: string;
  text: string | null;
  senderId?: string;
  authorId?: string;
  senderName?: string;
  authorPseudonym?: string;
  role?: string;
  kind?: string;
  createdAt?: string;
  sentAt?: string;
  mine?: boolean;
  idempotencyKey?: string;
};
type Room = RoomSummary & {
  messages: PortalMessage[];
  consentValid?: boolean;
  consentRequired?: boolean;
  canSend?: boolean;
  hasEarlierMessages?: boolean;
};
type RoomResponse = {
  room: RoomSummary;
  messages: PortalMessage[];
  consentRequired: boolean;
  canSend: boolean;
  hasEarlierMessages?: boolean;
};
type Home = {
  timezone?: string;
  username?: string;
  friendLimit?: number;
  friendSlotsRemaining?: number;
  actor?: PortalActor;
  profile?: { pseudonym?: string; timezone?: string };
  rooms: RoomSummary[];
  invitations?: Invitation[];
  consent?:
    { participation: boolean; version?: string; recordedAt?: string } | boolean;
  participation?: boolean;
  target?: { pseudonym: string };
  notice?: string;
};
type PendingSend = {
  roomId: string;
  text: string;
  idempotencyKey: string;
  sending: boolean;
  error: string | null;
};
type Modal = "profile" | "consent" | "withdraw" | "invite" | null;
const CONSENT_VERSION = "enrollment-v1";
const PREPARATION_NOTICE =
  "这里是已邀请参与者的真人聊天准备区。AI 尚未接入，正式实验尚未开启。";

class PortalError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "",
  ) {
    super(message);
  }
}
function formatInTimezone(
  value?: string | null,
  detailed = false,
  timeZone?: string,
) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    ...(detailed
      ? { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" }),
  } as Intl.DateTimeFormatOptions).format(date);
}
function statusLabel(status?: string) {
  return (
    (
      {
        ACTIVE: "可以聊天",
        OPEN: "可以聊天",
        PAUSED: "已暂停",
        ENDED: "已结束",
        WITHDRAWN: "已退出",
        CLOSED: "已结束",
        INVITED: "等待加入",
        PENDING: "等待加入",
        ACCEPTED: "已加入",
        REVOKED: "已撤销",
        EXPIRED: "已过期",
      } as Record<string, string>
    )[status ?? ""] ?? "准备中"
  );
}
function displayName(room: RoomSummary, portal: Portal) {
  return (
    room.peer?.pseudonym ||
    room.counterpartName ||
    room.title ||
    (portal === "target"
      ? room.friendPseudonym || room.friendName
      : room.targetPseudonym || room.targetName) ||
    (portal === "target" ? "你的好友" : "邀请你的人")
  );
}
function shortMessage(room: RoomSummary) {
  return typeof room.lastMessage === "string"
    ? room.lastMessage
    : room.lastMessage?.text ||
        (room.status === "PAUSED" ? "这段对话已暂停" : "查看聊天记录");
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : "暂时无法完成，请稍后重试。";
}
function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span
      className={`pp-avatar ${small ? "pp-avatar-small" : ""}`}
      aria-hidden="true"
    >
      {Array.from(name.trim() || "你")
        .slice(-2)
        .join("")}
    </span>
  );
}

export default function ParticipantPortal({ portal }: { portal: Portal }) {
  const [actor, setActor] = useState<PortalActor | null>(null);
  const [booting, setBooting] = useState(true);
  const [authError, setAuthError] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [invitationLoading, setInvitationLoading] = useState(false);
  const [invitationError, setInvitationError] = useState("");
  const [registration, setRegistration] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pseudonym, setPseudonym] = useState("");
  const [registrationConsent, setRegistrationConsent] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [home, setHome] = useState<Home | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [roomLoading, setRoomLoading] = useState(false);
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "offline"
  >("connecting");
  const [pageError, setPageError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingByRoom, setPendingByRoom] = useState<
    Record<string, PendingSend>
  >({});
  const pending = selectedId ? (pendingByRoom[selectedId] ?? null) : null;
  const setPending = (value: PendingSend | null) => {
    const roomId = value?.roomId ?? selectedId;
    if (!roomId) return;
    setPendingByRoom((previous) => {
      const next = { ...previous };
      if (value) next[roomId] = value;
      else delete next[roomId];
      return next;
    });
  };
  const [profileName, setProfileName] = useState("");
  const [timezone, setTimezone] = useState("Australia/Sydney");
  const [consentChecked, setConsentChecked] = useState(true);
  const [destroyContent, setDestroyContent] = useState(false);
  const [withdrawConfirmed, setWithdrawConfirmed] = useState(false);
  const [createdInvite, setCreatedInvite] = useState<Invitation | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [mobileConversation, setMobileConversation] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const messageEnd = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const inviteInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  // Keep the invitation across StrictMode's setup/cleanup/setup cycle after
  // removing it from the visible URL. It is never persisted to browser storage.
  const initialInvitationToken = useRef<string | null | undefined>(undefined);

  const api = useCallback(
    async <T,>(
      view: string,
      options: {
        signal?: AbortSignal;
        action?: string;
        payload?: unknown;
        params?: Record<string, string>;
      } = {},
    ): Promise<T> => {
      const params = new URLSearchParams({ view, ...options.params });
      const timeout = AbortSignal.timeout(15000);
      const response = await fetch(
        options.action ? "/api/portal" : `/api/portal?${params}`,
        {
          method: options.action ? "POST" : "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: options.signal
            ? AbortSignal.any([options.signal, timeout])
            : timeout,
          headers: {
            "x-study-portal": portal,
            ...(options.action ? { "content-type": "application/json" } : {}),
          },
          ...(options.action
            ? {
                body: JSON.stringify({
                  action: options.action,
                  payload: options.payload ?? {},
                }),
              }
            : {}),
        },
      ).catch((error) => {
        if (options.signal?.aborted) throw error;
        throw new PortalError(
          timeout.aborted
            ? "请求超时，请检查连接后重试。"
            : "网络暂时不可用，请检查连接后重试。",
        );
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new PortalError(
          typeof data.error === "string"
            ? data.error
            : "暂时无法完成，请稍后重试。",
          response.status,
          data.code,
        );
      return data as T;
    },
    [portal],
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (initialInvitationToken.current === undefined)
      initialInvitationToken.current = new URLSearchParams(
        window.location.hash.slice(1),
      ).get("token");
    const hashToken = initialInvitationToken.current;
    if (hashToken) {
      setToken(hashToken);
      setRegistration(true);
      setInvitationLoading(true);
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
      void api<InvitationPreview>("", {
        action: "inspectInvitation",
        payload: { token: hashToken },
        signal: controller.signal,
      })
        .then((value) => {
          if (value.portal !== portal)
            throw new PortalError(
              "这份邀请不属于当前入口，请重新打开邀请人发给你的完整链接。",
            );
          setInvitation(value);
        })
        .catch((error) => {
          if (error.name !== "AbortError") setInvitationError(errorText(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setInvitationLoading(false);
        });
    }
    void api<{ actor: PortalActor | null }>("me", { signal: controller.signal })
      .then((data) => setActor(data.actor))
      .catch((error) => {
        if (error.name !== "AbortError") setAuthError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBooting(false);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [api, portal]);

  useEffect(() => {
    if (!actor) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (selectedId) setRoomLoading(true);
    const refresh = async () => {
      try {
        const [nextHome, nextRoom] = await Promise.all([
          api<Home>("home", { signal: controller.signal }),
          selectedId
            ? api<RoomResponse>("room", {
                params: { id: selectedId },
                signal: controller.signal,
              })
            : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        setHome({ ...nextHome, rooms: nextHome.rooms ?? [] });
        setConnection("connected");
        setPageError("");
        if (nextHome.actor)
          setActor((current) =>
            current?.id === nextHome.actor!.id &&
            current.pseudonym === nextHome.actor!.pseudonym
              ? current
              : nextHome.actor!,
          );
        if (nextRoom)
          setRoom({
            ...nextRoom.room,
            messages: nextRoom.messages,
            canSend: nextRoom.canSend,
            consentRequired: nextRoom.consentRequired,
            hasEarlierMessages: nextRoom.hasEarlierMessages,
          });
        if (!selectedId && nextHome.rooms?.length)
          setSelectedId(nextHome.rooms[0].id);
      } catch (error: any) {
        if (controller.signal.aborted || error.name === "AbortError") return;
        if (error instanceof PortalError && error.status === 401) {
          setActor(null);
          setHome(null);
          setRoom(null);
          setAuthError("登录已过期，请重新登录。");
          return;
        }
        setConnection("offline");
        setPageError(errorText(error));
      } finally {
        if (!controller.signal.aborted) {
          setRoomLoading(false);
          timeout = setTimeout(refresh, 2000);
        }
      }
    };
    void refresh();
    return () => {
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [actor?.id, api, selectedId, pollRevision]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [room?.messages?.length, pending?.idempotencyKey, selectedId]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    modalRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setModal(null);
      if (event.key === "Tab") {
        const elements = modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
        );
        if (!elements?.length) return;
        const first = elements[0],
          last = elements[elements.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === modalRef.current)
        ) {
          event.preventDefault();
          last.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [modal, busy]);

  const formatTime = (value?: string | null, detailed = false) =>
    formatInTimezone(
      value,
      detailed,
      home?.timezone || home?.profile?.timezone || actor?.timezone,
    );
  const participation =
    typeof home?.consent === "boolean"
      ? home.consent
      : (home?.consent?.participation ?? home?.participation ?? true);
  const selectedSummary = home?.rooms?.find((value) => value.id === selectedId);
  const currentRoom = room?.id === selectedId ? room : null;
  const counterpart = currentRoom
    ? displayName(currentRoom, portal)
    : selectedSummary
      ? displayName(selectedSummary, portal)
      : "";
  const canSend = Boolean(
    currentRoom &&
    participation &&
    (currentRoom.canSend ?? ["ACTIVE", "OPEN"].includes(currentRoom.status)) &&
    !currentRoom.consentRequired,
  );
  const currentDraft = selectedId ? (drafts[selectedId] ?? "") : "";
  const ownPending = pending?.roomId === selectedId ? pending : null;
  const inviteLink = createdInvite
    ? createdInvite.inviteUrl ||
      createdInvite.url ||
      (createdInvite.path
        ? `${typeof window !== "undefined" ? window.location.origin : ""}${createdInvite.path}`
        : "") ||
      (createdInvite.token
        ? `${typeof window !== "undefined" ? window.location.origin : ""}/friend/join#token=${encodeURIComponent(createdInvite.token)}`
        : "")
    : "";

  async function authenticate(event: React.FormEvent) {
    event.preventDefault();
    setAuthError("");
    setAuthBusy(true);
    try {
      if (registration && (!token || !invitation || !registrationConsent))
        throw new PortalError("请先通过有效邀请阅读并确认参与同意。");
      const result = await api<{ actor: PortalActor }>("", {
        action: registration ? "register" : "login",
        payload: registration
          ? {
              token,
              username: username.trim().toLowerCase(),
              password,
              pseudonym: pseudonym.trim(),
              consent: { participation: true, version: CONSENT_VERSION },
            }
          : { username: username.trim().toLowerCase(), password },
      });
      setActor(result.actor);
      setPassword("");
      setToken(null);
      setInvitation(null);
      setRegistration(false);
      setHome(null);
      setSelectedId(null);
      setConnection("connecting");
    } catch (error) {
      setAuthError(errorText(error));
    } finally {
      setAuthBusy(false);
    }
  }
  async function act(
    action: string,
    payload: unknown = {},
    onSuccess?: (data: any) => void,
  ) {
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const data = await api<any>("", { action, payload });
      if (!mounted.current) return;
      onSuccess?.(data);
      setPollRevision((value) => value + 1);
    } catch (error) {
      if (mounted.current) setActionError(errorText(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function openModal(next: Modal) {
    setActionError("");
    setModal(next);
    setProfileName(home?.profile?.pseudonym || actor?.pseudonym || "");
    setTimezone(
      home?.timezone ||
        home?.profile?.timezone ||
        actor?.timezone ||
        "Australia/Sydney",
    );
    setConsentChecked(participation);
    setWithdrawConfirmed(false);
    setDestroyContent(false);
  }
  async function send(value?: PendingSend) {
    if (
      !selectedId ||
      (!value && !canSend) ||
      !participation ||
      pending?.sending
    )
      return;
    const draft = value ?? {
      roomId: selectedId,
      text: currentDraft.trim(),
      idempotencyKey: crypto.randomUUID(),
      sending: true,
      error: null,
    };
    if (!draft.text || draft.text.length > 4000) return;
    setPending({ ...draft, sending: true, error: null });
    if (!value) setDrafts((previous) => ({ ...previous, [selectedId]: "" }));
    try {
      const sent = await api<{ messageId: string; sequence: number }>("", {
        action: "send",
        payload: {
          roomId: draft.roomId,
          text: draft.text,
          idempotencyKey: draft.idempotencyKey,
        },
      });
      if (!mounted.current) return;
      setRoom((previous) =>
        previous?.id === draft.roomId &&
        !previous.messages.some((message) => message.id === sent.messageId)
          ? {
              ...previous,
              messages: [
                ...previous.messages,
                {
                  id: sent.messageId,
                  text: draft.text,
                  mine: true,
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : previous,
      );
      setPending(null);
      setPollRevision((previous) => previous + 1);
      composer.current?.focus();
    } catch (error) {
      if (mounted.current)
        setPending({ ...draft, sending: false, error: errorText(error) });
    }
  }
  async function copyInvitation() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(
        new URL(inviteLink, window.location.origin).toString(),
      );
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
      inviteInput.current?.focus();
      inviteInput.current?.select();
    }
  }
  function restorePending(value: PendingSend) {
    setDrafts((previous) => ({
      ...previous,
      [value.roomId]: [value.text, previous[value.roomId]]
        .filter(Boolean)
        .join("\n"),
    }));
    setPendingByRoom((previous) => {
      const next = { ...previous };
      delete next[value.roomId];
      return next;
    });
    setNotice(
      "原文已保留到草稿。消息也可能已经送达，请先查看对话，避免重复发送。",
    );
  }
  function clearAccount() {
    setActor(null);
    setHome(null);
    setRoom(null);
    setSelectedId(null);
    setPendingByRoom({});
    setDrafts({});
    setModal(null);
  }

  if (booting)
    return (
      <div className="pp-root pp-boot">
        <div className="pp-brand-mark">
          <MessageCircle size={25} />
        </div>
        <LoaderCircle className="pp-spin" size={23} />
        <p>正在打开你的聊天空间…</p>
      </div>
    );

  if (!actor)
    return (
      <main className="pp-root pp-auth">
        <section className="pp-auth-story" aria-label="参与者门户介绍">
          <a
            className="pp-brand pp-brand-light"
            href={portal === "target" ? "/target" : "/friend"}
          >
            <span className="pp-brand-mark">
              <MessageCircle size={24} />
            </span>
            <span>
              self / study<span className="pp-brand-en">PARTICIPANT SPACE</span>
            </span>
          </a>
          <a className="pp-all-portals pp-auth-all-portals" href="/">
            <ArrowLeft size={14} />
            全部入口
          </a>
          <div className="pp-story-copy">
            <span className="pp-eyebrow">PARTICIPANT SPACE</span>
            <h1>
              熟悉的人。
              <br />
              自在的对话。
            </h1>
            <p>
              从一份邀请开始，
              <br />
              把想说的话，留在彼此的聊天空间。
            </p>
            <div className="pp-story-illustration" aria-hidden="true">
              <div className="pp-illustration-orbit" />
              <div className="pp-illustration-bubble">
                <span />
                <span />
                <span />
              </div>
              <div className="pp-illustration-bubble pp-illustration-reply">
                <CheckCheck size={36} />
              </div>
              <div className="pp-orbit-dot" />
            </div>
          </div>
          <div className="pp-story-footer">
            <ShieldCheck size={19} />
            <span>仅向受邀参与者开放 · 尊重每一次同意与退出</span>
          </div>
        </section>
        <section className="pp-auth-side">
          <div className="pp-auth-card">
            <span className="pp-role-label">
              <UserRound size={15} />
              {portal === "target" ? "本人入口" : "好友入口"}
            </span>
            <h2>{registration ? "接受邀请，开始连接" : "欢迎回来"}</h2>
            <p className="pp-auth-subtitle">
              {registration
                ? "创建你的专属账号，加入真人聊天准备区。"
                : "登录你的账号，接着聊一聊。"}
            </p>
            <div className="pp-preparation-note">
              <ShieldCheck size={18} />
              <p>{PREPARATION_NOTICE}</p>
            </div>
            {invitationLoading && (
              <div className="pp-inline-loading">
                <LoaderCircle size={17} className="pp-spin" />
                正在验证邀请…
              </div>
            )}
            {invitationError && (
              <div className="pp-error" role="alert">
                {invitationError}
                <button
                  type="button"
                  onClick={() => {
                    setRegistration(false);
                    setInvitationError("");
                  }}
                >
                  返回登录
                </button>
              </div>
            )}
            {registration && invitation && (
              <div className="pp-invite-preview">
                <span>
                  <Link2 size={16} />
                  专属邀请
                </span>
                <strong>
                  {invitation.inviterPseudonym || "邀请人"} 邀请你以
                  {portal === "target" ? "本人" : "好友"}身份加入
                </strong>
                <p>有效期至 {formatTime(invitation.expiresAt, true)}</p>
              </div>
            )}
            {(!registration || invitation) && (
              <form className="pp-auth-form" onSubmit={authenticate}>
                {registration && (
                  <label>
                    聊天显示名
                    <input
                      value={pseudonym}
                      onChange={(event) => setPseudonym(event.target.value)}
                      placeholder="希望对方怎样称呼你"
                      autoComplete="nickname"
                      required
                      maxLength={40}
                    />
                  </label>
                )}
                <label>
                  用户名
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="输入你的用户名"
                    autoComplete="username"
                    required
                    maxLength={40}
                    minLength={3}
                    pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,39}"
                    title="3–40 位英文字母、数字、句点、下划线或连字符，首位为字母或数字"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </label>
                <label>
                  密码
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={
                      registration ? "设置一个至少 12 位的密码" : "输入密码"
                    }
                    autoComplete={
                      registration ? "new-password" : "current-password"
                    }
                    required
                    minLength={registration ? 12 : undefined}
                    maxLength={128}
                  />
                </label>
                {registration && (
                  <div className="pp-enrollment-consent">
                    <label className="pp-check">
                      <input
                        type="checkbox"
                        checked={registrationConsent}
                        onChange={(event) =>
                          setRegistrationConsent(event.target.checked)
                        }
                      />
                      <span>
                        我已阅读并同意加入真人聊天准备区。我知道当前没有 AI
                        代聊，也未开始正式实验；聊天内容会保存在此平台，我可随时暂停、退出或申请删除准备区数据。
                      </span>
                    </label>
                    <small>参与同意版本：{CONSENT_VERSION}</small>
                  </div>
                )}
                {authError && (
                  <div className="pp-error" role="alert">
                    {authError}
                  </div>
                )}
                <button
                  className="pp-button pp-button-primary pp-full"
                  type="submit"
                  disabled={authBusy || (registration && !registrationConsent)}
                >
                  {authBusy ? (
                    <LoaderCircle size={18} className="pp-spin" />
                  ) : (
                    <ArrowRight size={18} />
                  )}
                  {registration ? "同意并创建账号" : "登录聊天空间"}
                </button>
              </form>
            )}
            {registration ? (
              <button
                className="pp-text-button pp-auth-switch"
                onClick={() => {
                  setRegistration(false);
                  setAuthError("");
                }}
              >
                已有账号？返回登录
              </button>
            ) : invitation && token ? (
              <button
                className="pp-text-button pp-auth-switch"
                onClick={() => {
                  setRegistration(true);
                  setAuthError("");
                }}
              >
                使用这份邀请创建账号
              </button>
            ) : (
              <p className="pp-invite-only">
                还没有账号？请向
                {portal === "target"
                  ? "邀请你的研究负责人"
                  : "邀请你的本人参与者"}
                获取专属邀请链接。
                <br />
                本入口仅支持受邀注册。
              </p>
            )}
            <p className="pp-auth-footnote">
              请勿转发邀请或让他人使用你的账号。
            </p>
          </div>
          <span className="pp-auth-bottom">为真实的连接，留一点空间。</span>
        </section>
      </main>
    );

  return (
    <div className="pp-root pp-app" ref={rootRef}>
      <header className="pp-topbar">
        <a
          className="pp-brand"
          href={portal === "target" ? "/target" : "/friend"}
        >
          <span className="pp-brand-mark">
            <MessageCircle size={22} />
          </span>
          <span>
            self / study<span className="pp-brand-en">PARTICIPANT SPACE</span>
          </span>
        </a>
        <span className="pp-topbar-purpose">只属于参与者的聊天空间</span>
        <div className="pp-topbar-right">
          <a className="pp-all-portals" href="/">
            <ArrowLeft size={13} />
            <span>全部入口</span>
          </a>
          <span className="pp-human-pill">
            <span />
            真人聊天
          </span>
          <button
            className="pp-icon-button"
            onClick={() => openModal("profile")}
            title="个人资料"
            aria-label="打开个人资料"
          >
            <UserRound size={20} />
          </button>
        </div>
      </header>
      <div className="pp-stage-notice">
        <ShieldCheck size={16} />
        <span>{PREPARATION_NOTICE}</span>
        <button onClick={() => openModal("consent")}>
          查看参与同意
          <ArrowRight size={13} />
        </button>
      </div>
      <div
        className={`pp-workspace ${mobileConversation ? "pp-show-conversation" : ""}`}
      >
        <aside className="pp-sidebar" aria-label="聊天与邀请">
          <div className="pp-sidebar-heading">
            <div>
              <span className="pp-eyebrow">YOUR CONVERSATIONS</span>
              <h1>聊天</h1>
            </div>
            {portal === "target" && (
              <button
                className="pp-icon-button pp-invite-add"
                onClick={() => openModal("invite")}
                aria-label="邀请好友"
              >
                <Plus size={21} />
              </button>
            )}
          </div>
          <div className="pp-connection" aria-live="polite">
            {connection === "connected" ? (
              <Wifi size={13} />
            ) : connection === "offline" ? (
              <WifiOff size={13} />
            ) : (
              <LoaderCircle size={13} className="pp-spin" />
            )}
            <span>
              {connection === "connected"
                ? "已连接 · 每 2 秒更新"
                : connection === "offline"
                  ? "连接中断，正在自动重连"
                  : "正在连接"}
            </span>
            {connection === "offline" && (
              <button
                onClick={() => setPollRevision((value) => value + 1)}
                aria-label="立即重连"
              >
                <RefreshCw size={13} />
              </button>
            )}
          </div>
          {!home && (
            <div className="pp-sidebar-skeleton">
              <div />
              <div />
              <div />
            </div>
          )}
          <nav className="pp-room-list" aria-label="选择聊天">
            {home?.rooms.map((value) => (
              <button
                key={value.id}
                className={`pp-room-item ${value.id === selectedId ? "pp-selected" : ""}`}
                onClick={() => {
                  setSelectedId(value.id);
                  setMobileConversation(true);
                  setActionError("");
                }}
                aria-current={value.id === selectedId ? "page" : undefined}
              >
                <Avatar name={displayName(value, portal)} />
                <span className="pp-room-item-copy">
                  <span className="pp-room-item-title">
                    <strong>{displayName(value, portal)}</strong>
                    <time>{formatTime(value.updatedAt)}</time>
                  </span>
                  <span className="pp-room-preview">{shortMessage(value)}</span>
                  <span
                    className={`pp-room-state pp-state-${value.status.toLowerCase()}`}
                  >
                    {statusLabel(value.status)}
                  </span>
                </span>
              </button>
            ))}
          </nav>
          {home && !home.rooms.length && (
            <div className="pp-sidebar-empty">
              <MessageCircle size={27} />
              <p>还没有对话</p>
              <span>
                {portal === "target"
                  ? "邀请好友加入，开启第一段聊天。"
                  : "加入邀请后，对话会显示在这里。"}
              </span>
            </div>
          )}
          {portal === "target" && (
            <section className="pp-invitations">
              <div className="pp-section-label">
                <span>好友邀请</span>
                <button
                  onClick={() => openModal("invite")}
                  aria-label="生成新的好友邀请"
                >
                  <Plus size={16} />
                </button>
              </div>
              {home?.invitations?.length ? (
                home.invitations.map((value) => (
                  <div className="pp-invitation-row" key={value.id}>
                    <span className="pp-invitation-symbol">
                      <Link2 size={15} />
                    </span>
                    <div>
                      <strong>{value.inviteePseudonym || "好友邀请"}</strong>
                      <p>
                        {statusLabel(value.status || "PENDING")} ·{" "}
                        {formatTime(value.expiresAt, true)} 到期
                      </p>
                    </div>
                    {["PENDING", "ACTIVE"].includes(
                      value.status || "PENDING",
                    ) && (
                      <button
                        className="pp-icon-button pp-revoke"
                        disabled={busy}
                        onClick={() =>
                          void act("revoke", { id: value.id }, () =>
                            setNotice("邀请已撤销，原链接无法继续注册。"),
                          )
                        }
                        aria-label="撤销这份邀请"
                        title="撤销邀请"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <p className="pp-muted-small">你的邀请会显示在这里。</p>
              )}
            </section>
          )}
          <div className="pp-sidebar-bottom">
            <button
              className="pp-profile-button"
              onClick={() => openModal("profile")}
            >
              <Avatar name={actor.pseudonym} small />
              <span>
                <strong>{actor.pseudonym}</strong>
                <small>
                  {portal === "target" ? "本人参与者" : "好友参与者"}
                </small>
              </span>
              <Settings2 size={17} />
            </button>
            <button
              className="pp-exit-link"
              onClick={() => openModal("withdraw")}
            >
              <LogOut size={14} />
              参与同意与退出
            </button>
          </div>
        </aside>
        <main className="pp-conversation" aria-label="真人聊天">
          {currentRoom || selectedSummary ? (
            <>
              <header className="pp-chat-header">
                <button
                  className="pp-icon-button pp-mobile-back"
                  onClick={() => setMobileConversation(false)}
                  aria-label="返回聊天列表"
                >
                  <ArrowLeft size={21} />
                </button>
                <Avatar name={counterpart} small />
                <div className="pp-chat-person">
                  <h2>{counterpart}</h2>
                  <span>
                    <span className="pp-person-dot" />
                    真人对话 ·{" "}
                    {statusLabel(
                      currentRoom?.status || selectedSummary?.status,
                    )}
                  </span>
                </div>
                <div className="pp-chat-controls">
                  {currentRoom &&
                    ["ACTIVE", "OPEN"].includes(currentRoom.status) && (
                      <button
                        aria-label="暂停聊天"
                        disabled={busy}
                        onClick={() =>
                          void act("pause", { roomId: currentRoom.id })
                        }
                      >
                        <Pause size={16} />
                        <span>暂停</span>
                      </button>
                    )}
                  {currentRoom?.status === "PAUSED" &&
                    currentRoom.stoppedByMe && (
                      <button
                        aria-label="继续聊天"
                        disabled={busy || !participation}
                        onClick={() =>
                          void act("resume", { roomId: currentRoom.id })
                        }
                      >
                        <Play size={16} />
                        <span>继续</span>
                      </button>
                    )}
                  {currentRoom &&
                    ["ACTIVE", "OPEN", "PAUSED"].includes(
                      currentRoom.status,
                    ) && (
                      <button
                        aria-label="结束聊天"
                        disabled={busy}
                        onClick={() =>
                          void act("end", { roomId: currentRoom.id }, () =>
                            setNotice("聊天室已结束。已有内容可继续查看。"),
                          )
                        }
                      >
                        <Square size={15} />
                        <span>结束</span>
                      </button>
                    )}
                </div>
              </header>
              {pageError && (
                <div className="pp-chat-alert pp-alert-network" role="status">
                  <WifiOff size={16} />
                  <span>{pageError} 已有消息仍可查看，我们会自动重连。</span>
                </div>
              )}
              {(actionError || notice) && !modal && (
                <div
                  className={`pp-chat-alert ${actionError ? "pp-alert-error" : ""}`}
                  role={actionError ? "alert" : "status"}
                >
                  <span>{actionError || notice}</span>
                  <button
                    onClick={() => {
                      setActionError("");
                      setNotice("");
                    }}
                    aria-label="关闭提示"
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              {!participation && (
                <div className="pp-chat-alert" role="status">
                  <ShieldCheck size={16} />
                  <span>你的参与同意已暂停，当前无法发送消息。</span>
                  <button onClick={() => openModal("consent")}>管理同意</button>
                </div>
              )}
              <div
                className="pp-message-area"
                aria-live="polite"
                aria-relevant="additions"
                role="log"
                aria-label="聊天消息"
              >
                <div className="pp-conversation-intro">
                  <span>
                    <ShieldCheck size={13} />
                    受邀参与者之间的真人聊天
                  </span>
                  <p>按自己的节奏交流，随时可以暂停或退出。</p>
                  {currentRoom?.hasEarlierMessages && (
                    <p>当前显示最近 1000 条消息。</p>
                  )}
                </div>
                {roomLoading && !currentRoom ? (
                  <div className="pp-chat-loading">
                    <LoaderCircle size={22} className="pp-spin" />
                    <span>正在载入对话…</span>
                  </div>
                ) : currentRoom?.messages?.length ? (
                  currentRoom.messages.map((message) => {
                    const own =
                      message.mine ??
                      (message.senderId || message.authorId) === actor.id;
                    const isNotice =
                      message.role === "STUDY_NOTICE" ||
                      message.kind === "NOTICE" ||
                      message.kind === "SYSTEM";
                    return isNotice ? (
                      <p key={message.id} className="pp-system-message">
                        {message.text || "内容已删除"}
                      </p>
                    ) : (
                      <article
                        key={message.id}
                        className={`pp-message ${own ? "pp-message-own" : ""}`}
                      >
                        <Avatar
                          name={
                            own
                              ? actor.pseudonym
                              : message.authorPseudonym ||
                                message.senderName ||
                                counterpart
                          }
                          small
                        />
                        <div className="pp-message-content">
                          <div className="pp-message-meta">
                            <span>
                              {own
                                ? "我"
                                : message.authorPseudonym ||
                                  message.senderName ||
                                  counterpart}
                            </span>
                            <time>
                              {formatTime(message.createdAt || message.sentAt)}
                            </time>
                          </div>
                          <div className="pp-bubble">
                            {message.text ?? "［内容已删除］"}
                          </div>
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="pp-chat-empty">
                    <MessageCircle size={35} />
                    <h3>说声你好吧</h3>
                    <p>没有预设的开场，轻松聊聊就好。</p>
                  </div>
                )}
                {ownPending && (
                  <article className="pp-message pp-message-own pp-pending-message">
                    <Avatar name={actor.pseudonym} small />
                    <div className="pp-message-content">
                      <div className="pp-message-meta">
                        <span>我</span>
                        <span>
                          {ownPending.sending ? "发送中" : "尚未确认送达"}
                        </span>
                      </div>
                      <div className="pp-bubble">{ownPending.text}</div>
                      {ownPending.sending ? (
                        <span className="pp-delivery-status">
                          <LoaderCircle className="pp-spin" size={12} />
                          正在发送…
                        </span>
                      ) : (
                        <div className="pp-send-failure" role="alert">
                          <span>{ownPending.error}</span>
                          <button
                            onClick={() => void send(ownPending)}
                            disabled={!participation}
                          >
                            <RefreshCw size={13} />
                            重试发送
                          </button>
                          <button onClick={() => restorePending(ownPending)}>
                            保留到草稿，取消重试
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>
              <footer className="pp-composer-wrap">
                {canSend ? (
                  <form
                    className="pp-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!pending) void send();
                    }}
                  >
                    <textarea
                      ref={composer}
                      aria-label={`给${counterpart}发送消息`}
                      placeholder={`给 ${counterpart} 发一条消息…`}
                      value={currentDraft}
                      maxLength={4000}
                      rows={2}
                      onChange={(event) =>
                        setDrafts((previous) => ({
                          ...previous,
                          [selectedId!]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          if (!pending) void send();
                        }
                      }}
                    />
                    <div className="pp-composer-bottom">
                      <span>
                        Enter 发送 · Shift + Enter 换行
                        {currentDraft.length > 3500
                          ? ` · ${currentDraft.length}/4000`
                          : ""}
                      </span>
                      <button
                        className="pp-button pp-send-button"
                        type="submit"
                        disabled={!currentDraft.trim() || Boolean(pending)}
                      >
                        <Send size={16} />
                        发送
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="pp-composer-locked">
                    <ShieldCheck size={19} />
                    <div>
                      <strong>
                        {!participation || currentRoom?.consentRequired
                          ? "发送已关闭"
                          : currentRoom?.status === "PAUSED"
                            ? "让对话休息一下"
                            : "这段对话已结束"}
                      </strong>
                      <p>
                        {!participation
                          ? "可在参与同意设置中查看或更新你的选择。"
                          : currentRoom?.consentRequired
                            ? "聊天室需要双方有效的参与同意，当前无法发送。"
                            : currentRoom?.status === "PAUSED"
                              ? "对话由暂停它的参与者恢复，双方参与同意需保持有效。"
                              : "已结束的聊天室不再接收新消息。"}
                      </p>
                    </div>
                  </div>
                )}
                {!canSend && currentDraft && (
                  <label className="pp-preserved-draft">
                    保留的草稿（可选中复制）
                    <textarea
                      readOnly
                      rows={2}
                      value={currentDraft}
                      onFocus={(event) => event.target.select()}
                    />
                  </label>
                )}
                <p className="pp-composer-note">
                  这里的回复来自对方本人，不会由 AI 自动生成。
                </p>
              </footer>
            </>
          ) : (
            <section className="pp-welcome">
              <div className="pp-welcome-art" aria-hidden="true">
                <MessageCircle size={48} />
                <span>
                  <UsersRound size={24} />
                </span>
              </div>
              <span className="pp-eyebrow">A LITTLE SPACE TO CONNECT</span>
              <h2>
                {portal === "target"
                  ? "把熟悉的人，带到这里。"
                  : "一段熟悉的对话，从这里开始。"}
              </h2>
              <p>
                {portal === "target"
                  ? "生成一份专属邀请，发给你想一起参与的好友。\n好友接受并完成同意后，就能开始真人聊天。"
                  : "接受邀请并完成同意后，\n与你相连的本人参与者会出现在左侧。"}
              </p>
              {portal === "target" && (
                <button
                  className="pp-button pp-button-primary"
                  onClick={() => openModal("invite")}
                >
                  <UserRoundPlus size={18} />
                  邀请一位好友
                </button>
              )}
              {pageError && (
                <div className="pp-error" role="alert">
                  {pageError}
                  <button onClick={() => setPollRevision((value) => value + 1)}>
                    重新连接
                  </button>
                </div>
              )}
              <div className="pp-welcome-principles">
                <span>
                  <UserRound size={16} />
                  对方本人回复
                </span>
                <span>
                  <ShieldCheck size={16} />
                  参与由你决定
                </span>
                <span>
                  <Pause size={16} />
                  随时暂停
                </span>
              </div>
            </section>
          )}
        </main>
      </div>
      {modal && (
        <div
          className="pp-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            className="pp-modal"
            ref={modalRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pp-modal-title"
          >
            <header className="pp-modal-heading">
              <div>
                <span className="pp-eyebrow">YOUR SPACE, YOUR CHOICE</span>
                <h2 id="pp-modal-title">
                  {modal === "profile"
                    ? "个人资料"
                    : modal === "consent"
                      ? "参与同意"
                      : modal === "invite"
                        ? "邀请好友"
                        : "退出聊天准备区"}
                </h2>
              </div>
              <button
                className="pp-icon-button"
                onClick={() => setModal(null)}
                disabled={busy}
                aria-label="关闭"
              >
                <X size={21} />
              </button>
            </header>
            {actionError && (
              <div className="pp-error" role="alert">
                {actionError}
              </div>
            )}
            {modal === "profile" && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(
                    "profile",
                    { pseudonym: profileName.trim(), timezone },
                    () => {
                      setActor((previous) =>
                        previous
                          ? {
                              ...previous,
                              pseudonym: profileName.trim(),
                              timezone,
                            }
                          : null,
                      );
                      setModal(null);
                      setNotice("个人资料已更新。");
                    },
                  );
                }}
              >
                <div className="pp-profile-preview">
                  <Avatar name={profileName || actor.pseudonym} />
                  <div>
                    <strong>{profileName || actor.pseudonym}</strong>
                    <p>{portal === "target" ? "本人参与者" : "好友参与者"}</p>
                  </div>
                </div>
                <label>
                  聊天显示名
                  <input
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                    maxLength={40}
                    required
                  />
                </label>
                <label>
                  显示时区
                  <select
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                  >
                    <option value="Australia/Sydney">
                      悉尼 · Australia/Sydney
                    </option>
                    <option value="Asia/Shanghai">中国 · Asia/Shanghai</option>
                    <option value="Asia/Hong_Kong">
                      香港 · Asia/Hong_Kong
                    </option>
                    <option value="Europe/London">伦敦 · Europe/London</option>
                    <option value="America/New_York">
                      纽约 · America/New_York
                    </option>
                    <option value="UTC">世界协调时间 · UTC</option>
                    {![
                      "Australia/Sydney",
                      "Asia/Shanghai",
                      "Asia/Hong_Kong",
                      "Europe/London",
                      "America/New_York",
                      "UTC",
                    ].includes(timezone) && (
                      <option value={timezone}>{timezone}</option>
                    )}
                  </select>
                </label>
                <button
                  type="submit"
                  className="pp-button pp-button-primary pp-full"
                  disabled={busy || !profileName.trim()}
                >
                  {busy ? (
                    <LoaderCircle size={17} className="pp-spin" />
                  ) : (
                    <Check size={17} />
                  )}
                  保存资料
                </button>
                <div className="pp-profile-actions">
                  <button type="button" onClick={() => openModal("consent")}>
                    <ShieldCheck size={16} />
                    管理参与同意
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act("logout", {}, clearAccount)}
                  >
                    <LogOut size={16} />
                    退出登录
                  </button>
                </div>
              </form>
            )}
            {modal === "consent" && (
              <>
                <div className="pp-preparation-note">
                  <ShieldCheck size={18} />
                  <p>{PREPARATION_NOTICE}</p>
                </div>
                <div className="pp-consent-copy">
                  <p>
                    加入后，你将与受邀的另一位参与者进行真人文字聊天。平台会保存账号、邀请、参与同意和聊天准备数据，用于提供此准备区。
                  </p>
                  <p>
                    你可以选择不继续参与。撤销同意会停止你的聊天发送；已经保存的数据可通过“退出与删除”单独处理。
                  </p>
                </div>
                <label className="pp-check pp-consent-choice">
                  <input
                    type="checkbox"
                    checked={consentChecked}
                    onChange={(event) =>
                      setConsentChecked(event.target.checked)
                    }
                  />
                  <span>我同意继续参与真人聊天准备区。</span>
                </label>
                <small className="pp-consent-version">
                  同意版本：{CONSENT_VERSION}
                </small>
                <button
                  className="pp-button pp-button-primary pp-full"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      "consent",
                      { participation: consentChecked },
                      () => {
                        setModal(null);
                        setNotice(
                          consentChecked
                            ? "参与同意已保存。"
                            : "参与同意已撤销，聊天已暂停。",
                        );
                      },
                    )
                  }
                >
                  {busy ? (
                    <LoaderCircle size={17} className="pp-spin" />
                  ) : (
                    <Check size={17} />
                  )}
                  保存我的选择
                </button>
                <button
                  className="pp-text-button pp-full pp-modal-link"
                  onClick={() => openModal("withdraw")}
                >
                  退出与删除聊天准备数据
                </button>
              </>
            )}
            {modal === "withdraw" && (
              <>
                <p className="pp-modal-intro">
                  你可以结束参与，无需继续聊天或完成其他任务。请选择是否同时删除聊天准备内容。
                </p>
                <div className="pp-withdraw-options">
                  <label
                    className={!destroyContent ? "pp-option-selected" : ""}
                  >
                    <input
                      type="radio"
                      name="withdraw-mode"
                      checked={!destroyContent}
                      onChange={() => {
                        setDestroyContent(false);
                        setWithdrawConfirmed(false);
                      }}
                    />
                    <span>
                      <strong>退出并停止聊天</strong>
                      <small>
                        撤销参与同意，停止当前聊天。准备区中已经保存的内容保留。
                      </small>
                    </span>
                  </label>
                  <label className={destroyContent ? "pp-option-selected" : ""}>
                    <input
                      type="radio"
                      name="withdraw-mode"
                      checked={destroyContent}
                      onChange={() => {
                        setDestroyContent(true);
                        setWithdrawConfirmed(false);
                      }}
                    />
                    <span>
                      <strong>退出并删除聊天内容</strong>
                      <small>
                        删除与你相关聊天室中双方的消息正文。必要的账号、退出与删除记录会保留；删除内容不可恢复。
                      </small>
                    </span>
                  </label>
                </div>
                <label className="pp-check">
                  <input
                    type="checkbox"
                    checked={withdrawConfirmed}
                    onChange={(event) =>
                      setWithdrawConfirmed(event.target.checked)
                    }
                  />
                  <span>
                    我确认
                    {destroyContent
                      ? "退出并删除聊天准备内容"
                      : "退出聊天准备区"}
                    。
                  </span>
                </label>
                <button
                  className="pp-button pp-button-danger pp-full"
                  disabled={busy || !withdrawConfirmed}
                  onClick={() =>
                    void act("withdraw", { destroyContent }, () => {
                      clearAccount();
                      setAuthError(
                        destroyContent
                          ? "你已退出，聊天准备内容已按请求删除。"
                          : "你已退出，参与同意已撤销。",
                      );
                    })
                  }
                >
                  {busy ? (
                    <LoaderCircle size={17} className="pp-spin" />
                  ) : destroyContent ? (
                    <Trash2 size={17} />
                  ) : (
                    <LogOut size={17} />
                  )}
                  {destroyContent ? "确认退出并删除" : "确认退出"}
                </button>
              </>
            )}
            {modal === "invite" && (
              <>
                <p className="pp-modal-intro">
                  给认识你的好友发送一份专属邀请。好友需独立创建账号并同意参与，才能加入与你的真人聊天。
                </p>
                {inviteLink ? (
                  <div className="pp-created-invite">
                    <span className="pp-success-heading">
                      <Check size={17} />
                      邀请已生成
                    </span>
                    <label>
                      好友邀请链接
                      <input
                        ref={inviteInput}
                        readOnly
                        value={inviteLink}
                        onFocus={(event) => event.target.select()}
                        aria-label="可复制的好友邀请链接"
                      />
                    </label>
                    <p>
                      有效期至 {formatTime(createdInvite?.expiresAt, true)}
                      。请只发给你要邀请的好友。
                    </p>
                    <button
                      className="pp-button pp-button-primary pp-full"
                      onClick={() => void copyInvitation()}
                    >
                      <Copy size={17} />
                      {copied ? "已复制链接" : "复制邀请链接"}
                    </button>
                    {copyError && (
                      <p className="pp-copy-fallback" role="status">
                        浏览器未允许自动复制。请选中上方链接，使用系统复制操作。
                      </p>
                    )}
                    <p className="pp-muted-small">
                      请在离开此页前保存邀请链接。你可以在好友邀请列表撤销它。
                    </p>
                  </div>
                ) : (
                  <div className="pp-invite-ready">
                    <span>
                      <Link2 size={28} />
                    </span>
                    <strong>一人一份，专属连接</strong>
                    <p>生成后可复制链接，并随时撤销尚未使用的邀请。</p>
                    <button
                      className="pp-button pp-button-primary pp-full"
                      disabled={
                        busy ||
                        !participation ||
                        home?.friendSlotsRemaining === 0
                      }
                      onClick={() =>
                        void act("invite", { kind: "FRIEND" }, (data) => {
                          setCreatedInvite(data.invitation || data);
                          setCopied(false);
                          setCopyError(false);
                        })
                      }
                    >
                      {busy ? (
                        <LoaderCircle size={17} className="pp-spin" />
                      ) : (
                        <UserRoundPlus size={17} />
                      )}
                      生成好友邀请
                    </button>
                    {!participation && (
                      <p className="pp-muted-small">请先恢复有效参与同意。</p>
                    )}
                    {home?.friendSlotsRemaining === 0 && (
                      <p className="pp-muted-small">
                        可用好友邀请名额已用完。可撤销未使用的邀请后重新生成。
                      </p>
                    )}
                  </div>
                )}
                {inviteLink && (
                  <button
                    className="pp-text-button pp-full pp-modal-link"
                    onClick={() => {
                      setCreatedInvite(null);
                      setCopied(false);
                      setCopyError(false);
                    }}
                  >
                    生成另一份邀请
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
