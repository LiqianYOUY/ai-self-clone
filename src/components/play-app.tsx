"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Fingerprint,
  Link2,
  LoaderCircle,
  LogOut,
  MessageCircle,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import type {
  PlayHomeDto,
  PlayHostRoomDto,
  PlayIdentity,
  PlayInvitationDto,
  PlayPersonaInput,
  PlayRoomDto,
  PlayStats,
} from "@/domain/play";
import { SelfBrand } from "@/components/self-brand";

const API = "/api/play";

async function request<T>(url: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(result?.error || "暂时无法连接，请稍后重试。");
    return result as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("连接超时，请重试。已发送的消息不会重复提交。");
    if (error instanceof TypeError)
      throw new Error("网络连接中断，请检查网络后重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function action<T>(name: string, payload: object = {}): Promise<T> {
  return request<T>(API, { action: name, payload });
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作没有完成，请稍后重试。";
}

function Frame({
  children,
  side,
  compact = false,
}: {
  children: ReactNode;
  side?: ReactNode;
  compact?: boolean;
}) {
  return (
    <main
      className={`play-root play-shell${compact ? " play-shell-compact" : ""}`}
    >
      <header className="play-topbar">
        <SelfBrand />
        {side}
      </header>
      {children}
      <footer className="play-shell-footer">
        五轮对话，一次关于熟悉感的小实验。
      </footer>
    </main>
  );
}

function Notice({
  text,
  error = false,
  retry,
}: {
  text: string;
  error?: boolean;
  retry?: () => void;
}) {
  return (
    <div
      className={`play-notice${error ? " play-notice-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      <span>{text}</span>
      {retry && (
        <button onClick={retry} className="play-text-link">
          <RefreshCw size={14} />
          重试
        </button>
      )}
    </div>
  );
}

function Loading() {
  return (
    <Frame>
      <div className="play-loading">
        <LoaderCircle size={25} className="play-spin" />
        <p>正在打开你的空间…</p>
      </div>
    </Frame>
  );
}

function Auth({
  onSignedIn,
  networkError,
}: {
  onSignedIn: () => Promise<void>;
  networkError: string;
}) {
  const [mode, setMode] = useState<"register" | "login">("register");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current) return;
    const form = new FormData(event.currentTarget);
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await action(mode, {
        username: String(form.get("username") || "").trim(),
        password: String(form.get("password") || ""),
        ...(mode === "register"
          ? { pseudonym: String(form.get("pseudonym") || "").trim() }
          : {}),
      });
      await onSignedIn();
    } catch (error) {
      setError(errorText(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <Frame
      side={
        <a href="/" className="play-text-link">
          <ArrowLeft size={15} />
          返回首页
        </a>
      }
    >
      <section className="play-auth-grid">
        <div className="play-auth-copy">
          <span className="play-eyebrow">THE PERSON BEHIND THE WORDS</span>
          <h1>
            把你的语气，
            <br />
            交给朋友来<span>辨认。</span>
          </h1>
          <p>
            先准备一个属于你的 AI 分身，
            <br />
            再邀请熟悉的朋友，聊五轮、猜一次。
          </p>
          <div className="play-auth-flow">
            <span>
              <Fingerprint size={24} />
              写下你的样子
            </span>
            <ArrowRight size={17} />
            <span>
              <MessageCircle size={24} />
              一起聊五轮
            </span>
            <ArrowRight size={17} />
            <span>
              <Sparkles size={24} />
              揭晓答案
            </span>
          </div>
          <p className="play-fine-print">
            <ShieldCheck size={17} />
            朋友会事先知道这是本人与 AI 的猜测游戏。你随时可以结束一局。
          </p>
        </div>
        <div className="play-card play-auth-card">
          <span className="play-eyebrow">YOUR PLAY SPACE</span>
          <h2>{mode === "register" ? "创建我的游戏空间" : "欢迎回来"}</h2>
          <p className="play-muted">
            {mode === "register"
              ? "账号用于保存分身资料和查看每次揭晓。"
              : "已有 Target 账号也可以在这里登录。"}
          </p>
          <div className="play-tabs" aria-label="账号操作">
            <button
              type="button"
              className={mode === "register" ? "is-active" : ""}
              onClick={() => {
                setMode("register");
                setError("");
              }}
              disabled={busy}
            >
              注册
            </button>
            <button
              type="button"
              className={mode === "login" ? "is-active" : ""}
              onClick={() => {
                setMode("login");
                setError("");
              }}
              disabled={busy}
            >
              登录
            </button>
          </div>
          <form className="play-form" onSubmit={submit}>
            {mode === "register" && (
              <label>
                朋友熟悉的名字
                <input
                  name="pseudonym"
                  placeholder="大家平常怎么叫你"
                  autoComplete="nickname"
                  required
                  maxLength={40}
                  disabled={busy}
                />
              </label>
            )}
            <label>
              用户名
              <input
                name="username"
                placeholder="3–40 个字母、数字或下划线"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                minLength={3}
                maxLength={40}
                pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,39}"
                disabled={busy}
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                placeholder="至少 12 位，保护你的个人资料"
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                required
                minLength={12}
                maxLength={128}
                disabled={busy}
              />
            </label>
            {(error || networkError) && (
              <Notice text={error || networkError} error />
            )}
            <button
              className="play-button play-button-primary play-full"
              disabled={busy}
            >
              {busy ? (
                <LoaderCircle className="play-spin" size={17} />
              ) : (
                <ArrowRight size={17} />
              )}
              {busy
                ? "正在进入…"
                : mode === "register"
                  ? "创建空间"
                  : "进入我的空间"}
            </button>
          </form>
          <p className="play-caption">朋友只需要邀请链接和昵称，无需注册。</p>
        </div>
      </section>
    </Frame>
  );
}

const emptyPersona: PlayPersonaInput = {
  displayName: "",
  bio: "",
  style: "",
  memories: "",
  examplesText: "",
};

function PersonaEditor({
  persona,
  name,
  onSaved,
}: {
  persona: PlayPersonaInput | null;
  name: string;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<PlayPersonaInput>(
    persona || { ...emptyPersona, displayName: name },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const locked = useRef(false);
  function update(field: keyof PlayPersonaInput, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaved(false);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await action("save_persona", draft);
      setSaved(true);
      await onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="play-card play-persona">
      <div className="play-section-heading">
        <div>
          <span className="play-eyebrow">01 / YOUR PERSONA</span>
          <h2>让它慢慢像你</h2>
        </div>
        <Fingerprint size={27} strokeWidth={1.3} />
      </div>
      <p className="play-muted">
        用日常语言写就好。真实的短句，比一长串性格标签更有用。
      </p>
      <form className="play-form" onSubmit={submit}>
        <label>
          对朋友显示的名字
          <input
            value={draft.displayName}
            onChange={(event) => update("displayName", event.target.value)}
            maxLength={40}
            required
            disabled={busy}
          />
        </label>
        <label>
          关于你
          <textarea
            value={draft.bio}
            onChange={(event) => update("bio", event.target.value)}
            rows={3}
            maxLength={2000}
            required
            disabled={busy}
            placeholder="平常在做什么、喜欢什么、最近在忙什么…"
          />
        </label>
        <label>
          你怎么说话
          <textarea
            value={draft.style}
            onChange={(event) => update("style", event.target.value)}
            rows={3}
            maxLength={2000}
            required
            disabled={busy}
            placeholder="比如：句子很短，少用标点，笑的时候说哈哈哈哈，通常先吐槽再认真回答。"
          />
        </label>
        <label>
          可以聊起的共同经历 <span className="play-optional">选填</span>
          <textarea
            value={draft.memories}
            onChange={(event) => update("memories", event.target.value)}
            rows={3}
            maxLength={4000}
            disabled={busy}
            placeholder="写下你愿意在游戏中分享的小事；不知道的事情，让分身直接说不记得。"
          />
        </label>
        <label>
          真实的对话示例
          <textarea
            className="play-example-input"
            value={draft.examplesText}
            onChange={(event) => update("examplesText", event.target.value)}
            rows={6}
            maxLength={16000}
            required
            disabled={busy}
            placeholder={
              "朋友：今晚吃什么？\n我：你别问我 我已经纠结半小时了\n\n朋友：周末出门吗？\n我：先让我睡个懒觉再说哈哈"
            }
          />
          <small className="play-muted">
            可以先写 3–5 组，之后补到约 30
            组。只放你有权使用、愿意用于游戏的内容。
          </small>
        </label>
        {error && <Notice text={error} error />}
        {saved && <Notice text="资料已保存，将用于下一局。" />}
        <div className="play-form-footer">
          <span className="play-caption">已创建的房间保留开局时的资料。</span>
          <button className="play-button play-button-primary" disabled={busy}>
            {busy ? (
              <LoaderCircle size={16} className="play-spin" />
            ) : (
              <Check size={16} />
            )}
            {busy ? "保存中…" : "保存分身资料"}
          </button>
        </div>
      </form>
    </section>
  );
}

function RoundDots({
  completed,
  max = 5,
}: {
  completed: number;
  max?: number;
}) {
  return (
    <div className="play-rounds" aria-label={`已完成 ${completed} / ${max} 轮`}>
      <div className="play-round-dots">
        {Array.from({ length: max }, (_, index) => (
          <span key={index} className={index < completed ? "is-done" : ""} />
        ))}
      </div>
      <span>
        {completed} / {max} 轮
      </span>
    </div>
  );
}

function Conversation({
  room,
  host = false,
}: {
  room: PlayRoomDto;
  host?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [room.messages.length]);
  return (
    <div
      className="play-messages"
      ref={scroller}
      role="log"
      aria-label="聊天记录"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {room.messages.length === 0 ? (
        <div className="play-chat-empty">
          <MessageCircle size={35} strokeWidth={1.1} />
          <h3>{host ? "等朋友说第一句话" : `和${room.hostName}聊点什么吧`}</h3>
          <p>
            {host
              ? "朋友加入后就可以开始五轮对话。"
              : "问问熟悉的小事，或者照常闲聊。"}
          </p>
        </div>
      ) : (
        room.messages.map((message) => {
          const mine = host
            ? message.speaker === "SOURCE"
            : message.speaker === "FRIEND";
          return (
            <div
              key={message.id}
              className={`play-message${mine ? " is-mine" : ""}`}
            >
              <span className="play-message-name">
                {message.speaker === "FRIEND"
                  ? room.friendName || "朋友"
                  : room.hostName}
              </span>
              <div className="play-bubble">{message.text}</div>
            </div>
          );
        })
      )}
      {room.status === "ACTIVE" && room.waitingFor === "SOURCE" && (
        <p className="play-chat-wait">
          <span className="play-wait-dots">
            <i />
            <i />
            <i />
          </span>
          {host ? "等待本轮回复" : "等待回复中"}
        </p>
      )}
    </div>
  );
}

function Composer({
  disabled,
  hint,
  onSend,
}: {
  disabled: boolean;
  hint: string;
  onSend: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const composing = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  async function send() {
    if (locked.current || disabled || !draft.trim()) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await onSend(draft.trim());
      setDraft("");
    } catch (error) {
      setError(errorText(error));
    } finally {
      locked.current = false;
      setBusy(false);
      input.current?.focus();
    }
  }
  return (
    <div className="play-composer-area">
      {error && <Notice text={error} error />}
      <form
        className="play-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              !composing.current &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={hint}
          aria-label="聊天消息"
          maxLength={2000}
          rows={2}
          disabled={disabled || busy}
        />
        <button
          type="submit"
          className="play-button play-button-primary play-send"
          disabled={disabled || busy || !draft.trim()}
          aria-label={busy ? "发送中" : "发送消息"}
        >
          {busy ? (
            <LoaderCircle className="play-spin" size={18} />
          ) : (
            <Send size={18} />
          )}
        </button>
      </form>
      <div className="play-composer-note">
        <span>
          {busy
            ? "发送中…"
            : disabled
              ? hint
              : "Enter 发送 · Shift + Enter 换行"}
        </span>
        <span>{draft.length}/2000</span>
      </div>
    </div>
  );
}

function Result({ room, host = false }: { room: PlayRoomDto; host?: boolean }) {
  if (!room.result) return null;
  const { answer, guess, correct, reason } = room.result;
  return (
    <section className="play-result">
      <span className="play-eyebrow">THE REVEAL</span>
      <span className="play-result-icon">
        {answer === "HUMAN" ? (
          <Fingerprint size={30} strokeWidth={1.3} />
        ) : (
          <Sparkles size={30} strokeWidth={1.3} />
        )}
      </span>
      <h2>
        {answer === "HUMAN"
          ? "刚才，是本人在和你聊。"
          : "刚才，是 AI 在和你聊。"}
      </h2>
      <p>
        {host ? "朋友" : "你"}猜的是{guess === "HUMAN" ? "本人" : "AI"}，
        {correct ? "猜对了。" : "这次猜错了。"}
      </p>
      {reason && (
        <blockquote>
          <span>{host ? "朋友的判断理由" : "你的判断理由"}</span>
          {reason}
        </blockquote>
      )}
      <p className="play-caption">
        {host
          ? "这次结果已计入统计，可以准备下一局了。"
          : "这次答案已保存。想再玩一局，可以找朋友要一条新的邀请。"}
      </p>
    </section>
  );
}

function Guess({
  room,
  onGuessed,
}: {
  room: PlayRoomDto;
  onGuessed: (room: PlayRoomDto) => void;
}) {
  const [guess, setGuess] = useState<PlayIdentity | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!guess || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await action<{ room: PlayRoomDto }>("guess", {
        roomId: room.id,
        guess,
        reason: reason.trim(),
      });
      onGuessed(result.room);
    } catch (error) {
      setError(errorText(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <form className="play-guess" onSubmit={submit}>
      <span className="play-eyebrow">TIME TO TRUST YOUR INSTINCT</span>
      <h2>五轮聊完了，你的答案是？</h2>
      <p className="play-muted">回想一下语气、小习惯，或者某个特别像的瞬间。</p>
      <fieldset className="play-guess-options" disabled={busy}>
        <legend className="play-sr-only">选择你的判断</legend>
        <label className={guess === "HUMAN" ? "is-selected" : ""}>
          <input
            type="radio"
            name="guess"
            value="HUMAN"
            checked={guess === "HUMAN"}
            onChange={() => setGuess("HUMAN")}
          />
          <Fingerprint size={25} strokeWidth={1.3} />
          <strong>是本人</strong>
          <span>这熟悉的感觉，没错了</span>
        </label>
        <label className={guess === "AI" ? "is-selected" : ""}>
          <input
            type="radio"
            name="guess"
            value="AI"
            checked={guess === "AI"}
            onChange={() => setGuess("AI")}
          />
          <Sparkles size={25} strokeWidth={1.3} />
          <strong>是 AI</strong>
          <span>总有哪里和本人不太一样</span>
        </label>
      </fieldset>
      <label className="play-guess-reason">
        是什么让你这么觉得？ <span className="play-optional">选填</span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="哪句话特别像，或是哪句话露了馅？"
          disabled={busy}
        />
      </label>
      {error && <Notice text={error} error />}
      <button
        className="play-button play-button-primary play-full"
        disabled={!guess || busy}
      >
        {busy ? (
          <LoaderCircle className="play-spin" size={17} />
        ) : (
          <ArrowRight size={17} />
        )}
        {busy ? "正在揭晓…" : "确定答案，揭晓身份"}
      </button>
    </form>
  );
}

function CancelButton({
  onCancel,
  friend = false,
}: {
  onCancel: () => Promise<void>;
  friend?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  async function cancel() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await onCancel();
      setConfirming(false);
    } catch (error) {
      setError(errorText(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="play-cancel">
      {confirming ? (
        <>
          <span>
            {friend
              ? "退出后本局将结束，不会揭晓答案。"
              : "结束本局后，朋友将无法继续聊天。"}
          </span>
          <div>
            <button
              className="play-text-link"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              继续这局
            </button>
            <button
              className="play-button play-button-subtle"
              disabled={busy}
              onClick={() => void cancel()}
            >
              {busy ? "结束中…" : "确认结束"}
            </button>
          </div>
        </>
      ) : (
        <button className="play-text-link" onClick={() => setConfirming(true)}>
          <X size={14} />
          {friend ? "退出本局" : "结束本局"}
        </button>
      )}
      {error && <Notice text={error} error />}
    </div>
  );
}

function HostRoom({
  room,
  inviteUrl,
  onChanged,
}: {
  room: PlayHostRoomDto;
  inviteUrl: string;
  onChanged: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const lastSend = useRef<{ text: string; key: string } | null>(null);
  async function reply(text: string) {
    if (!lastSend.current || lastSend.current.text !== text)
      lastSend.current = { text, key: crypto.randomUUID() };
    await action("reply", {
      roomId: room.id,
      text,
      idempotencyKey: lastSend.current.key,
    });
    lastSend.current = null;
    await onChanged();
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        new URL(inviteUrl, window.location.origin).href,
      );
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError("未能自动复制，请选中下面的邀请链接手动复制。");
    }
  }
  return (
    <section className="play-card play-host-room">
      <div className="play-section-heading">
        <div>
          <span className="play-eyebrow">02 / THE CURRENT ROUND</span>
          <h2>
            {room.status === "WAITING"
              ? "邀请已经准备好"
              : `和${room.friendName || "朋友"}的这一局`}
          </h2>
        </div>
        <span className="play-badge">
          {room.mode === "HUMAN" ? "本局由你回复" : "本局由 AI 回复"}
        </span>
      </div>
      {room.status === "WAITING" ? (
        <div className="play-invite-area">
          <span className="play-invite-icon">
            <Link2 size={30} strokeWidth={1.3} />
          </span>
          <h3>把链接发给一个熟悉的朋友</h3>
          <p className="play-muted">
            邀请只能加入一次。请保持当前页面在线，等待朋友到来。
          </p>
          {inviteUrl ? (
            <>
              <div className="play-invite-link">
                <input
                  aria-label="邀请链接"
                  readOnly
                  value={
                    typeof window === "undefined"
                      ? inviteUrl
                      : new URL(inviteUrl, window.location.origin).href
                  }
                  onFocus={(event) => event.target.select()}
                />
                <button
                  className="play-button play-button-primary"
                  onClick={() => void copy()}
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? "已复制" : "复制链接"}
                </button>
              </div>
              {copyError && <Notice text={copyError} error />}
            </>
          ) : (
            <Notice text="此邀请链接仅在创建时显示。若链接已丢失，可结束本局后重新创建。" />
          )}
        </div>
      ) : (
        <>
          <div className="play-host-room-note">
            <RoundDots completed={room.turnsCompleted} max={room.maxTurns} />
            <span>
              {room.mode === "HUMAN"
                ? "按你平常的方式回复即可。"
                : "AI 正在使用开局时的分身资料。"}
            </span>
          </div>
          <Conversation room={room} host />
          {room.status === "ACTIVE" && room.mode === "HUMAN" && (
            <Composer
              disabled={room.waitingFor !== "SOURCE"}
              hint={
                room.waitingFor === "SOURCE"
                  ? "写下你的回复…"
                  : "等待朋友发来下一句话"
              }
              onSend={reply}
            />
          )}
          {room.status === "GUESSING" && (
            <Notice text="五轮对话已完成，等待朋友提交判断。" />
          )}
          {room.status === "REVEALED" && <Result room={room} host />}
          {room.status === "CANCELLED" && (
            <Notice text="本局已结束，未完成的对话不会计入猜测结果。" />
          )}
        </>
      )}
      {room.status !== "REVEALED" && room.status !== "CANCELLED" && (
        <CancelButton
          onCancel={async () => {
            await action("cancel", { roomId: room.id });
            await onChanged();
          }}
        />
      )}
    </section>
  );
}

function Stats({
  stats,
  rooms,
}: {
  stats: PlayStats;
  rooms: PlayHostRoomDto[];
}) {
  const percent = (value: number | null) =>
    value === null ? "—" : `${Math.round(value * 100)}%`;
  return (
    <section className="play-card play-stats">
      <div className="play-section-heading">
        <div>
          <span className="play-eyebrow">03 / AFTER THE REVEAL</span>
          <h2>朋友眼里的你</h2>
        </div>
        <span className="play-caption">小样本，先看反馈</span>
      </div>
      <div className="play-stat-grid">
        <div>
          <span>AI 被猜成本人</span>
          <strong>{percent(stats.aiFooledRate)}</strong>
          <small>{stats.aiRounds} 局 AI 已揭晓</small>
        </div>
        <div>
          <span>本人被正确认出</span>
          <strong>{percent(stats.humanRecognizedRate)}</strong>
          <small>{stats.humanRounds} 局本人已揭晓</small>
        </div>
        <div>
          <span>完成 / 取消</span>
          <strong>
            {stats.completed}
            <i> / {stats.cancelled}</i>
          </strong>
          <small>只把已揭晓的局计入比率</small>
        </div>
      </div>
      {rooms.length > 0 ? (
        <details className="play-history">
          <summary>
            最近的游戏 <ChevronDown size={16} />
          </summary>
          <div>
            {rooms.map((room) => (
              <article className="play-history-row" key={room.id}>
                <div>
                  <strong>{room.friendName || "尚未加入的朋友"}</strong>
                  <span>
                    {room.status === "REVEALED"
                      ? `${room.mode === "HUMAN" ? "本人" : "AI"}局 · ${room.result?.correct ? "猜对了" : "猜错了"}`
                      : room.status === "CANCELLED"
                        ? "已取消"
                        : "进行中"}
                  </span>
                </div>
                {room.result?.reason && <p>“{room.result.reason}”</p>}
              </article>
            ))}
          </div>
        </details>
      ) : (
        <div className="play-stats-empty">
          第一局揭晓后，这里就会留下朋友的答案和理由。
        </div>
      )}
    </section>
  );
}

export function HostPlayApp() {
  const [home, setHome] = useState<PlayHomeDto | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const fetchVersion = useRef(0);
  const readPending = useRef(0);
  const heartbeatPending = useRef<Promise<unknown> | null>(null);
  const mounted = useRef(true);
  const actionLock = useRef(false);
  const refresh = useCallback(async () => {
    const version = ++fetchVersion.current;
    readPending.current += 1;
    try {
      const result = await request<PlayHomeDto>(`${API}?view=home`);
      if (mounted.current && version === fetchVersion.current) {
        setHome(result);
        setError("");
      }
    } catch (error) {
      if (mounted.current && version === fetchVersion.current)
        setError(errorText(error));
    } finally {
      readPending.current -= 1;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!actionLock.current && readPending.current === 0) void refresh();
    }, 2000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!home?.actor || !home.online) return;
    const timer = setInterval(() => {
      if (!actionLock.current && !heartbeatPending.current) {
        heartbeatPending.current = action("heartbeat", { online: true })
          .catch((error) => {
            if (mounted.current) setError(errorText(error));
          })
          .finally(() => {
            heartbeatPending.current = null;
          });
      }
    }, 10000);
    return () => clearInterval(timer);
  }, [home?.actor?.id, home?.online]);
  useEffect(() => {
    if (!home?.activeRoom) {
      setInviteUrl("");
      return;
    }
    try {
      setInviteUrl(
        sessionStorage.getItem(`self-play-invite:${home.activeRoom.id}`) || "",
      );
    } catch {
      /* Storage is optional. */
    }
  }, [home?.activeRoom?.id]);
  async function mutate(work: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    ++fetchVersion.current;
    setBusy(true);
    setActionError("");
    try {
      await heartbeatPending.current;
      await work();
      await refresh();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  if (!home)
    return error ? (
      <Frame>
        <div className="play-loading">
          <Notice text={error} error retry={() => void refresh()} />
        </div>
      </Frame>
    ) : (
      <Loading />
    );
  if (!home.actor) return <Auth onSignedIn={refresh} networkError={error} />;
  const canCreate =
    home.providerReady &&
    home.online &&
    Boolean(home.persona) &&
    !home.activeRoom;
  return (
    <Frame
      side={
        <div className="play-account">
          <span>
            <UserRound size={15} />
            {home.actor.pseudonym}
          </span>
          <button
            className="play-text-link"
            disabled={busy}
            onClick={() =>
              void mutate(async () => {
                await action("logout");
              })
            }
          >
            <LogOut size={15} />
            <span>退出</span>
          </button>
        </div>
      }
    >
      <div className="play-dashboard-heading">
        <div>
          <span className="play-eyebrow">YOUR PLAY SPACE</span>
          <h1>
            你的语气，朋友的直觉<span>。</span>
          </h1>
          <p>准备好分身，再邀请一位朋友聊五轮。</p>
        </div>
        <label className="play-online-toggle">
          <span>
            <b>{home.online ? "我已上线" : "暂时离线"}</b>
            <small>
              {home.online ? "保持页面打开，等待朋友" : "上线后可以创建邀请"}
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="主持人在线状态"
            checked={home.online}
            disabled={busy || Boolean(home.activeRoom)}
            onChange={(event) => {
              const online = event.target.checked;
              void mutate(async () => {
                await action("heartbeat", { online });
              });
            }}
          />
          <i aria-hidden="true" />
        </label>
      </div>
      {error && <Notice text={error} error retry={() => void refresh()} />}
      {actionError && <Notice text={actionError} error />}
      {(!home.providerReady || home.providerStatus?.kind === "ollama") && (
        <div className="play-config-notice">
          <div>
            <span className="play-badge">
              {home.providerStatus?.kind === "compatible"
                ? "模型接口"
                : "本地模型"}
            </span>
            <h2>
              {home.providerReady
                ? "本地运行，聊天由这台电脑处理。"
                : "启动模型，就能开始真实的盲测。"}
            </h2>
            <p>
              {home.providerStatus?.message ||
                "启动本地模型后，这里会自动连接。"}
            </p>
            {!home.providerReady && (
              <>
                <p>
                  {home.providerStatus?.kind === "compatible"
                    ? "在项目本地 .env 中完成配置后重启服务；密钥不需要填写到网页中。"
                    : "首次运行准备命令，之后启动本地模型；无需 API 密钥。就绪后即可创建邀请。"}
                </p>
                <div className="play-config-vars">
                  {home.providerStatus?.kind === "compatible" ? (
                    <>
                      <code>PLAY_MODEL_BASE_URL</code>
                      <code>PLAY_MODEL_API_KEY</code>
                      <code>PLAY_MODEL_NAME</code>
                    </>
                  ) : (
                    <>
                      <code>npm run model:setup</code>
                      <code>npm run model:start</code>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          <Sparkles size={35} strokeWidth={1.1} />
        </div>
      )}
      <div
        className={`play-dashboard-grid${home.activeRoom ? " has-room" : ""}`}
      >
        <PersonaEditor
          key={home.actor.id}
          persona={home.persona}
          name={home.actor.pseudonym}
          onSaved={refresh}
        />
        <div className="play-dashboard-right">
          {home.activeRoom ? (
            <HostRoom
              key={home.activeRoom.id}
              room={home.activeRoom}
              inviteUrl={inviteUrl}
              onChanged={refresh}
            />
          ) : (
            <section className="play-card play-start-card">
              <span className="play-eyebrow">02 / INVITE A FRIEND</span>
              <div className="play-start-symbol">
                <MessageCircle size={40} strokeWidth={1.15} />
              </div>
              <h2>
                找一个认识你的人，
                <br />
                试试看。
              </h2>
              <p>
                每局随机由你本人或 AI 回复。
                <br />
                一次一个朋友，一共五轮对话。
              </p>
              <button
                className="play-button play-button-primary play-full"
                disabled={!canCreate || busy}
                onClick={() =>
                  void mutate(async () => {
                    const result = await action<{
                      url: string;
                      room: PlayHostRoomDto;
                    }>("create_room");
                    try {
                      sessionStorage.setItem(
                        `self-play-invite:${result.room.id}`,
                        result.url,
                      );
                    } catch {
                      /* The current page can still use the invitation. */
                    }
                    setInviteUrl(result.url);
                  })
                }
              >
                {busy ? (
                  <LoaderCircle size={17} className="play-spin" />
                ) : (
                  <Plus size={17} />
                )}
                {busy ? "正在创建…" : "创建一局，生成邀请"}
              </button>
              <p className="play-start-hint">
                {!home.providerReady
                  ? "先完成模型配置，即可开局。"
                  : !home.persona
                    ? "先保存左侧分身资料，即可开局。"
                    : !home.online
                      ? "打开上方在线开关，即可开局。"
                      : "邀请创建后，请保持此页面在线。"}
              </p>
            </section>
          )}
          <Stats
            stats={home.stats}
            rooms={home.recentRooms.filter(
              (room) => room.id !== home.activeRoom?.id,
            )}
          />
        </div>
      </div>
      <div className="play-legacy-links">
        <span>原有研究流程</span>
        <a href="/research">研究端</a>
        <a href="/target">本人参与端</a>
        <a href="/friend">好友参与端</a>
      </div>
    </Frame>
  );
}

const JOIN_TOKEN_KEY = "self-play-pending-invitation";

export function JoinPlayApp() {
  const [invitation, setInvitation] = useState<PlayInvitationDto | null>(null);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [nickname, setNickname] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  useEffect(() => {
    let alive = true;
    const hash = window.location.hash.slice(1);
    const fromHash = hash.startsWith("token=")
      ? new URLSearchParams(hash).get("token") || ""
      : hash;
    let pending = fromHash;
    try {
      if (fromHash) sessionStorage.setItem(JOIN_TOKEN_KEY, fromHash);
      else pending = sessionStorage.getItem(JOIN_TOKEN_KEY) || "";
    } catch {
      /* The fragment is sufficient for this visit. */
    }
    if (hash)
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    setToken(pending);
    if (!pending) {
      setError("这里需要一条完整的游戏邀请。请向朋友要邀请链接，再打开一次。");
      setLoading(false);
      return;
    }
    void action<PlayInvitationDto>("inspect_invite", { token: pending })
      .then((result) => {
        if (alive) {
          setInvitation(result);
          setError("");
        }
      })
      .catch((error) => {
        if (alive) setError(errorText(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current || !consent || !nickname.trim()) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await action<{ room: PlayRoomDto }>("join_room", {
        token,
        nickname: nickname.trim(),
        consent: true,
      });
      try {
        sessionStorage.removeItem(JOIN_TOKEN_KEY);
      } catch {
        /* Storage is optional. */
      }
      window.location.assign(
        `/play/room/${encodeURIComponent(result.room.id)}`,
      );
    } catch (error) {
      setError(errorText(error));
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <Frame compact>
      <section className="play-card play-join-card">
        <span className="play-eyebrow">AN INVITATION TO GUESS</span>
        <div className="play-join-symbol">
          <Fingerprint size={48} strokeWidth={1.1} />
        </div>
        {loading ? (
          <div className="play-join-loading">
            <LoaderCircle className="play-spin" size={22} />
            <p>正在打开邀请…</p>
          </div>
        ) : invitation ? (
          <>
            <h1>
              {invitation.hostName}邀请你，
              <br />
              猜猜是谁在回复。
            </h1>
            <p className="play-muted">
              可能是本人，也可能是模仿本人的 AI。
              <br />
              五轮对话后，选出你的答案。
            </p>
            <div className="play-join-rules">
              <span>
                01<span>说一句，等一句回复</span>
              </span>
              <span>
                02<span>聊满五轮，凭直觉判断</span>
              </span>
              <span>
                03<span>揭晓答案，留下一点理由</span>
              </span>
            </div>
            <form className="play-form" onSubmit={join}>
              <label>
                朋友认识的昵称
                <input
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  maxLength={40}
                  required
                  disabled={busy}
                  autoComplete="nickname"
                  placeholder="让朋友认得出你"
                />
              </label>
              <label className="play-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                  required
                  disabled={busy}
                />
                <span>
                  我知道这是一场本人 / AI 猜测游戏，同意保存本局对话与判断；AI
                  局的消息会由模型服务处理。我可以随时退出。
                </span>
              </label>
              {error && <Notice text={error} error />}
              <button
                className="play-button play-button-primary play-full"
                disabled={busy || !nickname.trim() || !consent}
              >
                {busy ? (
                  <LoaderCircle className="play-spin" size={17} />
                ) : (
                  <ArrowRight size={17} />
                )}
                {busy ? "正在加入…" : "开始五轮聊天"}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1>这次邀请暂时无法打开</h1>
            <Notice
              text={error}
              error
              retry={
                token
                  ? () => {
                      setLoading(true);
                      setError("");
                      void action<PlayInvitationDto>("inspect_invite", {
                        token,
                      })
                        .then((result) => setInvitation(result))
                        .catch((error) => setError(errorText(error)))
                        .finally(() => setLoading(false));
                    }
                  : undefined
              }
            />
            <p className="play-muted">
              请朋友确认邀请仍然有效，并重新发送完整链接。
            </p>
          </>
        )}
      </section>
    </Frame>
  );
}

export function FriendPlayRoom({ roomId }: { roomId: string }) {
  const [room, setRoom] = useState<PlayRoomDto | null>(null);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const readPending = useRef(0);
  const mounted = useRef(true);
  const mutation = useRef(false);
  const lastSend = useRef<{ text: string; key: string } | null>(null);
  const refresh = useCallback(async () => {
    if (mutation.current) return;
    const version = ++requestVersion.current;
    readPending.current += 1;
    try {
      const result = await request<{ room: PlayRoomDto }>(
        `${API}?view=room&roomId=${encodeURIComponent(roomId)}`,
      );
      if (mounted.current && version === requestVersion.current) {
        setRoom(result.room);
        setError("");
      }
    } catch (error) {
      if (mounted.current && version === requestVersion.current)
        setError(errorText(error));
    } finally {
      readPending.current -= 1;
    }
  }, [roomId]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (room?.status === "REVEALED" || room?.status === "CANCELLED") return;
    const timer = setInterval(() => {
      if (readPending.current === 0) void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh, room?.status]);
  async function send(text: string) {
    if (!lastSend.current || lastSend.current.text !== text)
      lastSend.current = { text, key: crypto.randomUUID() };
    mutation.current = true;
    ++requestVersion.current;
    try {
      const result = await action<{ room: PlayRoomDto }>("send_message", {
        roomId,
        text,
        idempotencyKey: lastSend.current.key,
      });
      setRoom(result.room);
      setError("");
      lastSend.current = null;
    } finally {
      mutation.current = false;
    }
  }
  async function leave() {
    mutation.current = true;
    ++requestVersion.current;
    try {
      const result = await action<{ room: PlayRoomDto }>("leave", { roomId });
      setRoom(result.room);
      setError("");
    } finally {
      mutation.current = false;
    }
  }
  return (
    <Frame
      compact
      side={<span className="play-room-top-note">五轮之后，答案见</span>}
    >
      <section className="play-card play-friend-room">
        {room ? (
          <>
            <header className="play-chat-header">
              <div className="play-chat-person">
                <span className="play-avatar">
                  {Array.from(room.hostName)[0]}
                </span>
                <div>
                  <h1>{room.hostName}</h1>
                  <p>
                    {room.status === "REVEALED"
                      ? "这一次，答案已揭晓"
                      : room.status === "CANCELLED"
                        ? "本局已结束"
                        : "像平常一样，聊点什么"}
                  </p>
                </div>
              </div>
              <RoundDots completed={room.turnsCompleted} max={room.maxTurns} />
            </header>
            {error && (
              <Notice text={error} error retry={() => void refresh()} />
            )}
            <Conversation room={room} />
            {room.status === "ACTIVE" && (
              <Composer
                disabled={room.waitingFor !== "FRIEND"}
                hint={
                  room.waitingFor === "FRIEND"
                    ? "你想说点什么…"
                    : "等待回复后，继续下一轮"
                }
                onSend={send}
              />
            )}
            {room.status === "WAITING" && (
              <Notice text="聊天正在准备，请稍等片刻。" />
            )}
            {room.status === "GUESSING" && (
              <Guess
                room={room}
                onGuessed={(result) => {
                  ++requestVersion.current;
                  setRoom(result);
                  setError("");
                }}
              />
            )}
            {room.status === "REVEALED" && <Result room={room} />}
            {room.status === "CANCELLED" && (
              <div className="play-ended">
                <span className="play-eyebrow">THIS ROUND HAS ENDED</span>
                <h2>这一局，到这里结束。</h2>
                <p>
                  本局没有完成，因此不会揭晓身份。
                  <br />
                  想再聊一局，可以向朋友要一条新邀请。
                </p>
              </div>
            )}
            {room.status !== "REVEALED" && room.status !== "CANCELLED" && (
              <CancelButton friend onCancel={leave} />
            )}
          </>
        ) : (
          <div className="play-loading">
            {error ? (
              <Notice text={error} error retry={() => void refresh()} />
            ) : (
              <>
                <LoaderCircle className="play-spin" size={24} />
                <p>正在打开对话…</p>
              </>
            )}
          </div>
        )}
      </section>
    </Frame>
  );
}
