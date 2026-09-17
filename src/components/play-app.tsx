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
  PlayStyleSummary,
} from "@/domain/play";
import { SelfBrand } from "@/components/self-brand";
import { LanguageSwitch, useLanguage } from "@/components/language-provider";
import { PlayModelNotice } from "@/components/play-model-notice";
import type { PlayProcessingKind } from "@/components/play-model-copy";

const API = "/api/play";
const errorMessages: Record<string, readonly [string, string]> = {
  REQUEST_FAILED: [
    "操作没有完成，请稍后重试。",
    "The action could not be completed. Please try again.",
  ],
  REQUEST_TIMEOUT: [
    "连接超时，请重试。已发送的消息不会重复提交。",
    "The connection timed out. Please retry; sent messages will not be duplicated.",
  ],
  NETWORK_ERROR: [
    "网络连接中断，请检查网络后重试。",
    "Connection lost. Check your network and try again.",
  ],
  AUTHENTICATION_REQUIRED: [
    "请先登录，或通过邀请链接进入聊天。",
    "Please sign in, or open your invitation link to join.",
  ],
  INVALID_CREDENTIALS: [
    "账号或密码不正确。",
    "Incorrect username or password.",
  ],
  FORBIDDEN: [
    "当前账号无法执行这项操作。",
    "This account cannot perform that action.",
  ],
  NOT_FOUND: [
    "这局聊天不存在或已被删除。",
    "This game is unavailable or has been deleted.",
  ],
  INVALID_INPUT: [
    "请检查输入内容。",
    "Please check the information you entered.",
  ],
  INVALID_STATE: [
    "游戏状态已改变，请刷新后重试。",
    "The game has changed. Refresh and try again.",
  ],
  REQUEST_REJECTED: [
    "请求未完成，请检查输入和当前状态。",
    "The request could not be completed. Check your input and the game status.",
  ],
  TRY_AGAIN_LATER: [
    "操作过于频繁，请稍后再试。",
    "Too many requests. Please wait a moment and try again.",
  ],
  INVITATION_INVALID: [
    "邀请已使用、取消或过期，请朋友发来新的邀请。",
    "This invitation has been used, cancelled or expired. Ask your friend for a new one.",
  ],
  INVITATION_MISSING: [
    "请通过朋友发来的完整邀请链接加入。",
    "Open the full invitation link your friend sent you.",
  ],
  ACCOUNT_UNAVAILABLE: [
    "这个用户名不可用，请换一个。",
    "That username is unavailable. Please choose another.",
  ],
  ACCOUNT_EXISTS: [
    "这个用户名不可用，请换一个。",
    "That username is unavailable. Please choose another.",
  ],
  PROVIDER_NOT_CONFIGURED: [
    "AI 尚未就绪，请稍后再试。",
    "AI is not ready yet. Please try again shortly.",
  ],
  PROVIDER_UNAVAILABLE: [
    "AI 暂时不可用，请稍后重试。",
    "AI is temporarily unavailable. Please try again shortly.",
  ],
  PERSONA_REQUIRED: ["请先保存分身资料。", "Save your persona first."],
  PERSONA_EXAMPLES_REQUIRED: [
    "还没有识别出你的发言，请检查示例中的称呼并保存。",
    "Your messages could not be identified. Check your speaker label and save again.",
  ],
  STYLE_REPLY_FAILED: [
    "这次回复未通过表达风格检查，请重试。",
    "This reply did not pass the style checks. Please try again.",
  ],
  EXAMPLES_FULL: [
    "对话示例已接近字数上限，请先删减一些示例，再加入纠正。",
    "Your examples are near the character limit. Remove some before adding this correction.",
  ],
  HOST_OFFLINE: [
    "主持人暂时离线，请上线后再试。",
    "The host is offline. Try again when they are online.",
  ],
  ROOM_EXISTS: [
    "请先结束当前这局聊天。",
    "End your current game before creating another.",
  ],
  IDEMPOTENCY_CONFLICT: [
    "这次操作已提交，请刷新查看结果。",
    "This action has already been submitted. Refresh to see the result.",
  ],
  COPY_FAILED: [
    "自动复制失败，请选中邀请链接手动复制。",
    "Copy failed. Select the invitation link and copy it manually.",
  ],
  ACTION_BUSY: [
    "上一项操作尚未完成，请稍等。",
    "Please wait for the current action to finish.",
  ],
};

async function request<T>(
  url: string,
  body?: unknown,
  timeoutMs = 15000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
    if (!response.ok) throw new Error(result?.code || "REQUEST_FAILED");
    return result as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("REQUEST_TIMEOUT");
    if (error instanceof TypeError) throw new Error("NETWORK_ERROR");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function action<T>(name: string, payload: object = {}): Promise<T> {
  return request<T>(
    API,
    { action: name, payload },
    name === "preview_persona" ? 90000 : 15000,
  );
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "REQUEST_FAILED";
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
  const { t } = useLanguage();
  return (
    <main
      className={`play-root play-shell${compact ? " play-shell-compact" : ""}`}
    >
      <header className="play-topbar">
        <SelfBrand />
        <div className="play-topbar-actions">
          {side}
          <LanguageSwitch />
        </div>
      </header>
      {children}
      <footer className="play-shell-footer">
        <span>
          {t(
            "AI 与人类互动的小实验",
            "An experiment in AI and human interaction",
          )}
        </span>
        <a href="/privacy">{t("隐私与数据删除", "Privacy & deletion")}</a>
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
  const { t } = useLanguage();
  const message = error
    ? t(...(errorMessages[text] || errorMessages.REQUEST_FAILED))
    : text;
  return (
    <div
      className={`play-notice${error ? " play-notice-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      <span>{message}</span>
      {retry && (
        <button onClick={retry} className="play-text-link">
          <RefreshCw size={14} />
          {t("重试", "Retry")}
        </button>
      )}
    </div>
  );
}

function Loading() {
  const { t } = useLanguage();
  return (
    <Frame>
      <div className="play-loading">
        <LoaderCircle size={25} className="play-spin" />
        <p>{t("正在打开你的空间…", "Opening your space…")}</p>
      </div>
    </Frame>
  );
}

function Auth({
  onSignedIn,
  networkError,
  processingKind,
}: {
  onSignedIn: () => Promise<void>;
  networkError: string;
  processingKind: PlayProcessingKind;
}) {
  const { t } = useLanguage();
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
          {t("返回首页", "Home")}
        </a>
      }
    >
      <section className="play-auth-grid">
        <div className="play-auth-copy">
          <span className="play-eyebrow">THE PERSON BEHIND THE WORDS</span>
          <h1>
            {t("把你的语气，", "Your voice.")}
            <br />
            {t("交给朋友来", "A friend's ")}
            <span>{t("辨认。", "intuition.")}</span>
          </h1>
          <p>
            {t(
              "准备分身，邀请朋友。五轮对话后，看看对方能否认出你。",
              "Build your AI persona and invite a friend. After five rounds, can they tell who replied?",
            )}
          </p>
          <div className="play-auth-flow">
            <span>
              <Fingerprint size={24} />
              {t("写下你的样子", "Describe your style")}
            </span>
            <ArrowRight size={17} />
            <span>
              <MessageCircle size={24} />
              {t("一起聊五轮", "Chat for five rounds")}
            </span>
            <ArrowRight size={17} />
            <span>
              <Sparkles size={24} />
              {t("揭晓答案", "Reveal the answer")}
            </span>
          </div>
          <p className="play-fine-print">
            <ShieldCheck size={17} />
            {t(
              "参与者事先知情，随时可以结束游戏。",
              "Everyone knows AI may be involved. Either person can end the game.",
            )}
          </p>
        </div>
        <div className="play-card play-auth-card">
          <span className="play-eyebrow">YOUR PLAY SPACE</span>
          <h2>
            {mode === "register"
              ? t("创建我的游戏空间", "Create your play space")
              : t("欢迎回来", "Welcome back")}
          </h2>
          <p className="play-muted">
            {mode === "register"
              ? t(
                  "账号用于保存分身资料和查看每次揭晓。",
                  "Save your persona and see your game results.",
                )
              : t(
                  "登录后继续准备分身或查看结果。",
                  "Sign in to continue with your persona or results.",
                )}
          </p>
          <div
            className="play-tabs"
            aria-label={t("账号操作", "Account options")}
          >
            <button
              type="button"
              className={mode === "register" ? "is-active" : ""}
              onClick={() => {
                setMode("register");
                setError("");
              }}
              disabled={busy}
            >
              {t("注册", "Sign up")}
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
              {t("登录", "Sign in")}
            </button>
          </div>
          <form className="play-form" onSubmit={submit}>
            {mode === "register" && <PlayModelNotice kind={processingKind} />}
            {mode === "register" && (
              <label>
                {t("游戏化名（非实名）", "Game alias (not your real name)")}
                <input
                  name="pseudonym"
                  placeholder={t(
                    "请勿使用真实姓名或可识别身份的昵称",
                    "Choose an alias that does not identify you",
                  )}
                  autoComplete="nickname"
                  required
                  maxLength={40}
                  disabled={busy}
                />
              </label>
            )}
            <label>
              {t("用户名", "Username")}
              <input
                name="username"
                placeholder={t(
                  "3–40 位字母或数字，可含 . _ -",
                  "3–40 letters or numbers; . _ - allowed",
                )}
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
              {t("密码", "Password")}
              <input
                name="password"
                type="password"
                placeholder={t("至少 12 位", "At least 12 characters")}
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                required
                minLength={12}
                maxLength={128}
                disabled={busy}
              />
            </label>
            {mode === "register" && (
              <label className="play-consent">
                <input type="checkbox" required disabled={busy} />
                <span>
                  {t(
                    "我同意将资料与聊天用于人机交互（HCI）实验和分析。个人信息不公开，分析完成后清理；有效登录期间也可自行删除。",
                    "I agree to my profile and chats being used for this human–computer interaction (HCI) experiment and analysis. Personal information is not public. Data is cleared after analysis; I can delete it earlier while signed in.",
                  )}
                  <a href="/privacy">
                    {t("阅读隐私说明", "Read the privacy notice")}
                  </a>
                </span>
              </label>
            )}
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
                ? t("正在进入…", "Opening…")
                : mode === "register"
                  ? t("创建空间", "Create space")
                  : t("进入我的空间", "Enter my space")}
            </button>
          </form>
          <p className="play-caption">
            {t(
              "朋友使用邀请链接和化名加入，无需注册。",
              "Friends join with an invite link and an alias. No account needed.",
            )}
          </p>
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
  exampleSpeaker: "",
};

const styleWarningMessages: Record<string, readonly [string, string]> = {
  unlabeled_self: [
    "没有称呼的独立文本按你的发言处理；补上“朋友：／我：”能保留接话关系。",
    "Unlabeled text was treated as yours. Add Friend: / Me: labels to preserve the conversation context.",
  ],
  unrecognized_speakers: [
    "部分称呼未能匹配到你，请核对“示例中你的称呼”。",
    "Some speaker labels could not be matched to you. Check your speaker label below.",
  ],
  limited_examples: [
    "样本还少，建议补充至少 8 条本人发言和 3 组接话示例，包含追问、玩笑和日常闲聊。",
    "Examples are limited. Aim for at least 8 of your messages and 3 conversation pairs, including follow-up questions, jokes and everyday chat.",
  ],
  ignored_lines: [
    "部分内容未能识别为聊天发言，已跳过；请使用“称呼：内容”的格式。",
    "Some content could not be recognized as messages and was skipped. Use the format Speaker: message.",
  ],
};

function personaSignature(persona: PlayPersonaInput | null) {
  return JSON.stringify([
    persona?.displayName || "",
    persona?.bio || "",
    persona?.style || "",
    persona?.memories || "",
    persona?.examplesText || "",
    persona?.exampleSpeaker || "",
  ]);
}

function StyleEvidence({
  summary,
  dirty,
}: {
  summary: PlayStyleSummary;
  dirty: boolean;
}) {
  const { t } = useLanguage();
  return (
    <section
      className="play-style-evidence"
      aria-label={t("已保存的表达习惯", "Saved speaking style")}
    >
      <div className="play-style-heading">
        <h3>{t("从你的发言中提取", "Learned from your messages")}</h3>
        <span className="play-badge">
          {summary.status === "ready"
            ? t("示例较充足", "More evidence")
            : summary.status === "limited"
              ? t("样本仍少", "Limited examples")
              : t("需要本人示例", "Your examples needed")}
        </span>
      </div>
      <p className="play-caption">
        {t(
          `识别对象：${summary.targetSpeaker || "尚未识别"}`,
          `Speaker: ${summary.targetSpeaker || "not identified"}`,
        )}
        {" · "}
        {t("资料版本", "Profile version")} {summary.sourceHash.slice(0, 8)}
      </p>
      {dirty && (
        <p className="play-style-unsaved" role="status">
          {t(
            "你有未保存的修改。下方习惯仍属于上次保存的资料，保存后才会重新提取。",
            "You have unsaved changes. These findings describe your previously saved profile and will be updated when you save.",
          )}
        </p>
      )}
      <dl className="play-style-metrics">
        <div>
          <dt>{t("本人发言", "Your messages")}</dt>
          <dd>{summary.sampleCount}</dd>
        </div>
        <div>
          <dt>{t("接话示例", "Conversation pairs")}</dt>
          <dd>{summary.pairedExampleCount}</dd>
        </div>
        <div>
          <dt>{t("典型长度", "Median length")}</dt>
          <dd>
            {summary.medianLength}
            <small>{t(" 字符", " chars")}</small>
          </dd>
        </div>
        <div>
          <dt>{t("使用表情", "Emoji use")}</dt>
          <dd>
            {Math.round(summary.emojiRate * 100)}
            <small>%</small>
          </dd>
        </div>
        <div>
          <dt>{t("使用问号", "Question marks")}</dt>
          <dd>
            {Math.round(summary.questionRate * 100)}
            <small>%</small>
          </dd>
        </div>
      </dl>
      {summary.commonPhrases.length > 0 && (
        <p className="play-style-phrases">
          <span>{t("常见表达", "Recurring phrases")}</span>
          {summary.commonPhrases.slice(0, 8).map((phrase) => (
            <b key={phrase}>{phrase}</b>
          ))}
        </p>
      )}
      {summary.warnings.length > 0 && (
        <ul className="play-style-warnings">
          {summary.warnings.map((warning) => (
            <li key={warning}>
              {t(
                ...(styleWarningMessages[warning] || [
                  "部分示例需要检查，请核对称呼与格式。",
                  "Some examples need review. Check speaker labels and formatting.",
                ]),
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="play-caption">
        {t(
          "这些习惯和你的原话会用于回复。示例数量不代表模仿已准确，请通过试聊校准。",
          "Replies use these patterns and your original examples. Evidence quantity does not guarantee an accurate imitation; try it and correct it.",
        )}
      </p>
    </section>
  );
}

type PreviewMessage = { speaker: "FRIEND" | "SOURCE"; text: string };

function PersonaPreview({
  enabled,
  dirty,
  hasExamples,
  onCorrection,
}: {
  enabled: boolean;
  dirty: boolean;
  hasExamples: boolean;
  onCorrection: (friend: string, reply: string) => void;
}) {
  const { t } = useLanguage();
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [text, setText] = useState("");
  const [correction, setCorrection] = useState("");
  const [addedCorrection, setAddedCorrection] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const locked = useRef(false);
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current || !enabled || !text.trim() || messages.length >= 10)
      return;
    locked.current = true;
    setBusy(true);
    setError("");
    const next: PreviewMessage[] = [
      ...messages,
      { speaker: "FRIEND", text: text.trim() },
    ];
    setPending(text.trim());
    try {
      const result = await action<{
        reply: string;
        styleSummary: PlayStyleSummary;
      }>("preview_persona", { messages: next });
      setMessages([...next, { speaker: "SOURCE", text: result.reply }]);
      setText("");
      setCorrection("");
      setAddedCorrection(false);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending("");
      setBusy(false);
      locked.current = false;
    }
  }
  return (
    <section
      className="play-persona-preview"
      aria-label={t("分身试聊", "Persona tryout")}
    >
      <div className="play-style-heading">
        <h3>{t("先和分身聊聊", "Try your persona")}</h3>
        {messages.length > 0 && (
          <button
            type="button"
            className="play-text-link"
            disabled={busy}
            onClick={() => {
              setMessages([]);
              setText("");
              setCorrection("");
              setAddedCorrection(false);
              setError("");
            }}
          >
            {t("重新试聊", "Start again")}
          </button>
        )}
      </div>
      <p className="play-caption">
        {t(
          "用朋友的口吻发一句话，看看分身怎么接。每次最多 5 轮，不计入实验，试聊记录不会保存到账号。",
          "Send a message as a friend and see how your persona responds. Up to 5 turns per tryout. This is separate from the experiment and the chat is not saved to your account.",
        )}
      </p>
      {!enabled && (
        <p className="play-style-unsaved">
          {dirty
            ? t(
                "先保存修改，再用更新后的资料试聊。",
                "Save your changes before trying the updated profile.",
              )
            : !hasExamples
              ? t(
                  "先保存能识别出本人发言的示例，再开始试聊。",
                  "Save examples that identify your own messages before starting.",
                )
              : t(
                  "保存完成后即可试聊。",
                  "You can try it once saving finishes.",
                )}
        </p>
      )}
      {(messages.length > 0 || pending) && (
        <div
          className="play-preview-messages"
          role="log"
          aria-live="polite"
          aria-label={t("试聊记录", "Tryout conversation")}
        >
          {[
            ...messages,
            ...(pending ? [{ speaker: "FRIEND" as const, text: pending }] : []),
          ].map((message, index) => (
            <div
              key={index}
              className={`play-message${message.speaker === "SOURCE" ? " is-mine" : ""}`}
            >
              <span className="play-message-name">
                {message.speaker === "FRIEND"
                  ? t("模拟朋友", "As a friend")
                  : t("你的分身", "Your persona")}
              </span>
              <div className="play-bubble">{message.text}</div>
            </div>
          ))}
        </div>
      )}
      <form className="play-preview-form" onSubmit={send}>
        <label>
          {t("朋友会怎么说", "What would a friend say?")}
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={2000}
            rows={2}
            disabled={!enabled || busy || messages.length >= 10}
            placeholder={t(
              "比如：听多了？啥",
              "For example: What do you mean?",
            )}
          />
        </label>
        <div className="play-preview-footer">
          <span className="play-caption">
            {busy
              ? t(
                  "正在生成，可能需要约一分钟…",
                  "Generating; this may take about a minute…",
                )
              : t(
                  `${messages.length / 2} / 5 轮`,
                  `${messages.length / 2} / 5 turns`,
                )}
          </span>
          <button
            type="submit"
            className="play-button play-button-subtle"
            disabled={!enabled || busy || !text.trim() || messages.length >= 10}
          >
            {busy ? (
              <LoaderCircle size={15} className="play-spin" />
            ) : (
              <Send size={15} />
            )}
            {t("试试回复", "Try a reply")}
          </button>
        </div>
      </form>
      {messages.length >= 10 && (
        <p className="play-caption">
          {t(
            "已完成 5 轮，可以纠正最后一句，或重新试聊。",
            "Five turns complete. Correct the last reply or start another tryout.",
          )}
        </p>
      )}
      {messages.length > 0 && (
        <div className="play-preview-correction">
          <label>
            {t("最后一句，我会这样回", "How I would answer the last message")}
            <input
              value={correction}
              onChange={(event) => setCorrection(event.target.value)}
              maxLength={2000}
              disabled={!enabled || busy || addedCorrection}
              placeholder={t(
                "写下你自己真实会说的话",
                "Write what you would actually say",
              )}
            />
          </label>
          <button
            type="button"
            className="play-text-link"
            disabled={!enabled || busy || !correction.trim() || addedCorrection}
            onClick={() => {
              try {
                onCorrection(
                  messages[messages.length - 2].text,
                  correction.trim(),
                );
                setCorrection("");
                setAddedCorrection(true);
                setError("");
              } catch (error) {
                setError(errorText(error));
              }
            }}
          >
            <Plus size={14} />
            {t("将我的纠正加入示例", "Add my correction to examples")}
          </button>
          <p className="play-caption">
            {addedCorrection
              ? t(
                  "纠正已加入上方草稿，请点击“保存分身资料”使它生效。",
                  "Your correction is in the draft above. Select Save persona to use it.",
                )
              : t(
                  "仅你亲自填写的纠正会加入草稿；试聊中生成的回复不会自动加入示例。",
                  "Only your written correction is added to the draft. Generated replies are never added to your examples automatically.",
                )}
          </p>
        </div>
      )}
      {error && <Notice text={error} error />}
    </section>
  );
}

function PersonaEditor({
  persona,
  styleSummary,
  name,
  onSaved,
  processingKind,
}: {
  persona: PlayPersonaInput | null;
  styleSummary: PlayStyleSummary | null;
  name: string;
  onSaved: () => Promise<void>;
  processingKind: PlayProcessingKind;
}) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState<PlayPersonaInput>(
    persona || { ...emptyPersona, displayName: name },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [savedProfile, setSavedProfile] = useState(persona);
  const [summary, setSummary] = useState(styleSummary);
  const locked = useRef(false);
  useEffect(() => {
    setSavedProfile(persona);
    setSummary(styleSummary);
  }, [persona, styleSummary]);
  const dirty = personaSignature(draft) !== personaSignature(savedProfile);
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
      const result = await action<{
        persona: PlayPersonaInput;
        styleSummary: PlayStyleSummary;
      }>("save_persona", draft);
      setDraft(result.persona);
      setSavedProfile(result.persona);
      setSummary(result.styleSummary);
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
          <h2>{t("让它慢慢像你", "Give it your voice")}</h2>
        </div>
        <Fingerprint size={27} strokeWidth={1.3} />
      </div>
      <p className="play-muted">
        {t(
          "保存后会从你的真实发言中提取表达习惯，并保留接话示例。请勿填写真实姓名、联系方式或敏感信息。",
          "Saving extracts speaking patterns from your own messages and keeps examples of how you reply. Leave out real names, contact details and sensitive information.",
        )}
      </p>
      <PlayModelNotice kind={processingKind} />
      <form className="play-form" onSubmit={submit}>
        <label>
          {t("游戏化名（非实名）", "Game alias (not your real name)")}
          <input
            value={draft.displayName}
            onChange={(event) => update("displayName", event.target.value)}
            maxLength={40}
            required
            disabled={busy}
          />
        </label>
        <label>
          {t("关于你", "About you")}
          <textarea
            value={draft.bio}
            onChange={(event) => update("bio", event.target.value)}
            rows={3}
            maxLength={2000}
            required
            disabled={busy}
            placeholder={t(
              "兴趣、爱好或日常话题，不含可识别身份的细节",
              "Interests, hobbies or everyday topics, without identifying details",
            )}
          />
        </label>
        <label>
          {t("你怎么说话", "Your conversation style")}
          <textarea
            value={draft.style}
            onChange={(event) => update("style", event.target.value)}
            rows={3}
            maxLength={2000}
            required
            disabled={busy}
            placeholder={t(
              "比如：句子很短，少用标点，笑的时候说哈哈哈哈，通常先吐槽再认真回答。",
              "For example: short sentences, little punctuation, lots of 'haha', and a joke before a serious answer.",
            )}
          />
        </label>
        <label>
          {t("可以聊起的小事", "Things you might talk about")}
          <span className="play-optional">{t("选填", "optional")}</span>
          <textarea
            value={draft.memories}
            onChange={(event) => update("memories", event.target.value)}
            rows={3}
            maxLength={4000}
            disabled={busy}
            placeholder={t(
              "只写愿意分享的内容，避免第三人的隐私；不知道的事情，让分身说不记得。",
              "Only include things you can share. Protect other people's privacy; tell your persona to admit when it doesn't remember.",
            )}
          />
        </label>
        <label>
          {t("示例中你的称呼", "Your speaker label in the examples")}
          <span className="play-optional">{t("选填", "optional")}</span>
          <input
            value={draft.exampleSpeaker || ""}
            onChange={(event) => update("exampleSpeaker", event.target.value)}
            maxLength={40}
            disabled={busy}
            placeholder={t(
              "例如：老王；留空自动识别我 / Me / 游戏化名",
              "E.g. Alex; leave blank for Me / 我 / your game alias",
            )}
          />
          <small className="play-muted">
            {t(
              "填写聊天示例里标记你自己的称呼，系统只从你的发言提取习惯。",
              "Use the label that identifies you in the examples. Only your messages are used to derive your style.",
            )}
          </small>
        </label>
        <label>
          {t("你的对话示例", "Example conversations")}
          <textarea
            className="play-example-input"
            value={draft.examplesText}
            onChange={(event) => update("examplesText", event.target.value)}
            rows={6}
            maxLength={16000}
            required
            disabled={busy}
            placeholder={t(
              "朋友：今晚吃什么？\n我：你别问我 我已经纠结半小时了\n\n朋友：周末出门吗？\n我：先让我睡个懒觉再说哈哈",
              "Friend: What should we eat tonight?\nMe: don't ask me i've been deciding for half an hour\n\nFriend: Going out this weekend?\nMe: let me sleep in first haha",
            )}
          />
          <small className="play-muted">
            {t(
              "每行使用“称呼：内容”，保留朋友的上句和你的原话。建议至少 8 条本人发言、3 组接话；只使用你有权分享的内容。",
              "Use one Speaker: message per line. Keep a friend's message and your original reply. Aim for 8 of your messages and 3 pairs; only share content you have permission to use.",
            )}
          </small>
        </label>
        {error && <Notice text={error} error />}
        {saved && (
          <Notice
            text={t(
              "资料已保存，将用于下一局。",
              "Saved. Your next game will use this profile.",
            )}
          />
        )}
        <div className="play-form-footer">
          <span className="play-caption">
            {t(
              "已创建的房间保留开局时的资料。",
              "Existing games keep the profile they started with.",
            )}
          </span>
          <button className="play-button play-button-primary" disabled={busy}>
            {busy ? (
              <LoaderCircle size={16} className="play-spin" />
            ) : (
              <Check size={16} />
            )}
            {busy ? t("保存中…", "Saving…") : t("保存分身资料", "Save persona")}
          </button>
        </div>
      </form>
      {summary && <StyleEvidence summary={summary} dirty={dirty} />}
      <PersonaPreview
        key={summary?.sourceHash || "unsaved"}
        enabled={
          !busy &&
          !dirty &&
          Boolean(summary && summary.status !== "needs_examples")
        }
        dirty={dirty}
        hasExamples={Boolean(summary && summary.status !== "needs_examples")}
        onCorrection={(friend, reply) => {
          const speaker =
            draft.exampleSpeaker?.trim() || summary?.targetSpeaker || "我";
          const friendSpeaker = speaker === "朋友" ? "对方" : "朋友";
          const pair = `${friendSpeaker}：${friend.replace(/\s*\r?\n\s*/g, " ")}\n${speaker}：${reply}`;
          const examples = `${draft.examplesText.trim()}\n\n${pair}`.trim();
          if (examples.length > 16000) throw new Error("EXAMPLES_FULL");
          update("examplesText", examples);
        }}
      />
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
  const { t } = useLanguage();
  return (
    <div
      className="play-rounds"
      aria-label={t(
        `已完成 ${completed} / ${max} 轮`,
        `${completed} of ${max} rounds completed`,
      )}
    >
      <div className="play-round-dots">
        {Array.from({ length: max }, (_, index) => (
          <span key={index} className={index < completed ? "is-done" : ""} />
        ))}
      </div>
      <span>
        {t(`${completed} / ${max} 轮`, `${completed} / ${max} rounds`)}
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
  const { t } = useLanguage();
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
      aria-label={t("聊天记录", "Conversation")}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {room.messages.length === 0 ? (
        <div className="play-chat-empty">
          <MessageCircle size={35} strokeWidth={1.1} />
          <h3>
            {host
              ? t("等朋友说第一句话", "Waiting for your friend's first message")
              : t(
                  `和${room.hostName}聊点什么吧`,
                  `Start a conversation with ${room.hostName}`,
                )}
          </h3>
          <p>
            {host
              ? t(
                  "朋友加入后就可以开始五轮对话。",
                  "The five rounds begin when your friend joins.",
                )
              : t(
                  "问问熟悉的小事，或者照常闲聊。",
                  "Ask about something familiar, or just chat as usual.",
                )}
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
                  ? room.friendName || t("朋友", "Friend")
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
          {host
            ? t("等待本轮回复", "Waiting for this round's reply")
            : t("等待回复中", "Waiting for a reply")}
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
  const { t } = useLanguage();
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
          aria-label={t("聊天消息", "Chat message")}
          maxLength={2000}
          rows={2}
          disabled={disabled || busy}
        />
        <button
          type="submit"
          className="play-button play-button-primary play-send"
          disabled={disabled || busy || !draft.trim()}
          aria-label={
            busy ? t("发送中", "Sending") : t("发送消息", "Send message")
          }
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
            ? t("发送中…", "Sending…")
            : disabled
              ? hint
              : t(
                  "Enter 发送 · Shift + Enter 换行",
                  "Enter to send · Shift + Enter for a new line",
                )}
        </span>
        <span>{draft.length}/2000</span>
      </div>
    </div>
  );
}

function Result({ room, host = false }: { room: PlayRoomDto; host?: boolean }) {
  const { t } = useLanguage();
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
          ? t("刚才，是本人在和你聊。", "That was the human.")
          : t("刚才，是 AI 在和你聊。", "That was the AI.")}
      </h2>
      <p>
        {t(
          `${host ? "朋友" : "你"}猜的是${guess === "HUMAN" ? "本人" : "AI"}，${correct ? "猜对了。" : "这次猜错了。"}`,
          `${host ? "Your friend guessed" : "You guessed"} ${guess === "HUMAN" ? "human" : "AI"}. ${correct ? "That was correct." : "Not this time."}`,
        )}
      </p>
      {reason && (
        <blockquote>
          <span>
            {host
              ? t("朋友的判断理由", "Your friend's reasoning")
              : t("你的判断理由", "Your reasoning")}
          </span>
          {reason}
        </blockquote>
      )}
      <p className="play-caption">
        {host
          ? t(
              "这次结果已计入统计，可以准备下一局了。",
              "The result is included in your stats. You can start another game.",
            )
          : t(
              "这次答案已保存。想再玩一局，可以找朋友要一条新的邀请。",
              "Your answer is saved. Ask your friend for a new invite to play again.",
            )}
      </p>
    </section>
  );
}

function Guess({
  onGuess,
  disabled = false,
}: {
  onGuess: (guess: PlayIdentity, reason: string) => Promise<void>;
  disabled?: boolean;
}) {
  const { t } = useLanguage();
  const [guess, setGuess] = useState<PlayIdentity | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!guess || locked.current || disabled) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await onGuess(guess, reason.trim());
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
      <h2>{t("五轮聊完了，你的答案是？", "Five rounds. Who was replying?")}</h2>
      <p className="play-muted">
        {t(
          "回想一下语气、小习惯，或者某个特别像的瞬间。",
          "Think about the tone, little habits and moments that felt familiar.",
        )}
      </p>
      <fieldset className="play-guess-options" disabled={busy || disabled}>
        <legend className="play-sr-only">
          {t("选择你的判断", "Choose your answer")}
        </legend>
        <label className={guess === "HUMAN" ? "is-selected" : ""}>
          <input
            type="radio"
            name="guess"
            value="HUMAN"
            checked={guess === "HUMAN"}
            onChange={() => setGuess("HUMAN")}
          />
          <Fingerprint size={25} strokeWidth={1.3} />
          <strong>{t("是本人", "Human")}</strong>
          <span>{t("由朋友本人回复", "Your friend replied")}</span>
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
          <strong>{t("是 AI", "AI")}</strong>
          <span>
            {t(
              "由模仿朋友的 AI 回复",
              "An AI using your friend's persona replied",
            )}
          </span>
        </label>
      </fieldset>
      <label className="play-guess-reason">
        {t("是什么让你这么觉得？", "What made you think so?")}
        <span className="play-optional">{t("选填", "optional")}</span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={2000}
          placeholder={t(
            "哪句话特别像，或是哪句话露了馅？",
            "Was there a phrase or a moment that helped you decide?",
          )}
          disabled={busy || disabled}
        />
      </label>
      {error && <Notice text={error} error />}
      <button
        className="play-button play-button-primary play-full"
        disabled={!guess || busy || disabled}
      >
        {busy ? (
          <LoaderCircle className="play-spin" size={17} />
        ) : (
          <ArrowRight size={17} />
        )}
        {busy
          ? t("正在揭晓…", "Revealing…")
          : t("确定答案，揭晓身份", "Submit & reveal")}
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
  const { t } = useLanguage();
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
              ? t(
                  "退出后本局将结束，不会揭晓答案。",
                  "Leaving ends this game without revealing the answer.",
                )
              : t(
                  "结束本局后，朋友将无法继续聊天。",
                  "Ending the game stops the conversation for both of you.",
                )}
          </span>
          <div>
            <button
              className="play-text-link"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t("继续这局", "Keep playing")}
            </button>
            <button
              className="play-button play-button-subtle"
              disabled={busy}
              onClick={() => void cancel()}
            >
              {busy ? t("结束中…", "Ending…") : t("确认结束", "End game")}
            </button>
          </div>
        </>
      ) : (
        <button className="play-text-link" onClick={() => setConfirming(true)}>
          <X size={14} />
          {friend ? t("退出本局", "Leave game") : t("结束本局", "End game")}
        </button>
      )}
      {error && <Notice text={error} error />}
    </div>
  );
}

function DeleteControl({
  account = false,
  disabled = false,
  onDelete,
}: {
  account?: boolean;
  disabled?: boolean;
  onDelete: () => Promise<void>;
}) {
  const { t } = useLanguage();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  async function remove() {
    if (locked.current || disabled) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await onDelete();
    } catch (error) {
      setError(errorText(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="play-delete-control">
      {confirming ? (
        <section
          className="play-delete-confirm"
          aria-label={t("确认永久删除", "Confirm permanent deletion")}
        >
          <strong>
            {account
              ? t(
                  "删除账号与全部游戏数据？",
                  "Delete your account and all game data?",
                )
              : t("删除本局数据？", "Delete this game's data?")}
          </strong>
          <p>
            {account
              ? t(
                  "账号、分身资料、所有游戏对话和结果将永久删除，邀请也会失效。此操作无法恢复。",
                  "Your account, persona, all game conversations and results will be permanently deleted. Invitations will stop working. This cannot be undone.",
                )
              : t(
                  "本局双方的聊天和判断结果将永久删除，房间将关闭。此操作无法恢复，但不会删除主持人账号。",
                  "Both participants' messages and the guess in this game will be permanently deleted, and the room will close. This cannot be undone. The host's account will remain.",
                )}
          </p>
          <div className="play-delete-actions">
            <button
              type="button"
              className="play-button play-button-subtle"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setError("");
              }}
            >
              {t("保留数据", "Keep data")}
            </button>
            <button
              type="button"
              className="play-button play-button-danger"
              disabled={busy || disabled}
              onClick={() => void remove()}
            >
              {busy
                ? t("删除中…", "Deleting…")
                : t("确认永久删除", "Permanently delete")}
            </button>
          </div>
          {error && <Notice text={error} error />}
        </section>
      ) : (
        <button
          type="button"
          className="play-text-link"
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          {account
            ? t("删除账号与全部游戏数据", "Delete account & all game data")
            : t("删除本局数据", "Delete this game's data")}
        </button>
      )}
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
  const { t, language } = useLanguage();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const lastSend = useRef<{ text: string; key: string } | null>(null);
  const invitation =
    inviteUrl && typeof window !== "undefined"
      ? new URL(inviteUrl, window.location.origin)
      : null;
  invitation?.searchParams.set("lang", language);
  const shareUrl = invitation?.href || inviteUrl;
  useEffect(() => {
    setCopied(false);
  }, [shareUrl]);
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
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError("COPY_FAILED");
    }
  }
  return (
    <section className="play-card play-host-room">
      <div className="play-section-heading">
        <div>
          <span className="play-eyebrow">02 / THE CURRENT ROUND</span>
          <h2>
            {room.status === "WAITING"
              ? t("邀请已经准备好", "Your invitation is ready")
              : t(
                  `和${room.friendName || "朋友"}的这一局`,
                  `Round with ${room.friendName || "your friend"}`,
                )}
          </h2>
        </div>
        <span className="play-badge">
          {room.mode === "HUMAN"
            ? t("本局由你回复", "You reply this round")
            : t("本局由 AI 回复", "AI replies this round")}
        </span>
      </div>
      {room.status === "WAITING" ? (
        <div className="play-invite-area">
          <span className="play-invite-icon">
            <Link2 size={30} strokeWidth={1.3} />
          </span>
          <h3>
            {t("把链接发给一个熟悉的朋友", "Share the link with a friend")}
          </h3>
          <p className="play-muted">
            {t(
              "邀请只能加入一次。请保持当前页面在线，等待朋友到来。",
              "This invite can be used once. Keep this page open while waiting.",
            )}
          </p>
          {inviteUrl ? (
            <>
              <div className="play-invite-link">
                <input
                  aria-label={t("邀请链接", "Invitation link")}
                  readOnly
                  value={shareUrl}
                  onFocus={(event) => event.target.select()}
                />
                <button
                  className="play-button play-button-primary"
                  onClick={() => void copy()}
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? t("已复制", "Copied") : t("复制链接", "Copy link")}
                </button>
              </div>
              {copyError && <Notice text={copyError} error />}
            </>
          ) : (
            <Notice
              text={t(
                "此邀请链接仅在创建时显示。若链接已丢失，可结束本局后重新创建。",
                "The link is only available when created. If it is lost, end this game and create a new invitation.",
              )}
            />
          )}
        </div>
      ) : (
        <>
          <div className="play-host-room-note">
            <RoundDots completed={room.turnsCompleted} max={room.maxTurns} />
            <span>
              {room.mode === "HUMAN"
                ? t("按你平常的方式回复即可。", "Reply as you normally would.")
                : t(
                    "AI 正在使用开局时的分身资料。",
                    "AI is using the profile saved when this game began.",
                  )}
            </span>
          </div>
          <Conversation room={room} host />
          {room.status === "ACTIVE" && room.mode === "HUMAN" && (
            <Composer
              disabled={room.waitingFor !== "SOURCE"}
              hint={
                room.waitingFor === "SOURCE"
                  ? t("写下你的回复…", "Write your reply…")
                  : t(
                      "等待朋友发来下一句话",
                      "Waiting for your friend's next message",
                    )
              }
              onSend={reply}
            />
          )}
          {room.status === "GUESSING" && (
            <Notice
              text={t(
                "五轮对话已完成，等待朋友提交判断。",
                "Five rounds complete. Waiting for your friend's guess.",
              )}
            />
          )}
          {room.status === "REVEALED" && <Result room={room} host />}
          {room.status === "CANCELLED" && (
            <Notice
              text={t(
                "本局已结束，未完成的对话不会计入猜测结果。",
                "This game ended. Unfinished games do not count toward guess rates.",
              )}
            />
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
  const { t } = useLanguage();
  const percent = (value: number | null) =>
    value === null ? "—" : `${Math.round(value * 100)}%`;
  return (
    <section className="play-card play-stats">
      <div className="play-section-heading">
        <div>
          <span className="play-eyebrow">03 / AFTER THE REVEAL</span>
          <h2>{t("朋友眼里的你", "How friends read you")}</h2>
        </div>
        <span className="play-caption">
          {t("小样本，先看反馈", "A small sample, for reflection")}
        </span>
      </div>
      <div className="play-stat-grid">
        <div>
          <span>{t("AI 被猜成本人", "AI guessed as human")}</span>
          <strong>{percent(stats.aiFooledRate)}</strong>
          <small>
            {t(
              `${stats.aiRounds} 局 AI 已揭晓`,
              `${stats.aiRounds} AI rounds revealed`,
            )}
          </small>
        </div>
        <div>
          <span>{t("本人被正确认出", "Human recognized")}</span>
          <strong>{percent(stats.humanRecognizedRate)}</strong>
          <small>
            {t(
              `${stats.humanRounds} 局本人已揭晓`,
              `${stats.humanRounds} human rounds revealed`,
            )}
          </small>
        </div>
        <div>
          <span>{t("完成 / 取消", "Completed / ended")}</span>
          <strong>
            {stats.completed}
            <i> / {stats.cancelled}</i>
          </strong>
          <small>
            {t("只把已揭晓的局计入比率", "Rates include revealed games only")}
          </small>
        </div>
      </div>
      {rooms.length > 0 ? (
        <details className="play-history">
          <summary>
            {t("最近的游戏", "Recent games")}
            <ChevronDown size={16} />
          </summary>
          <div>
            {rooms.map((room) => (
              <article className="play-history-row" key={room.id}>
                <div>
                  <strong>
                    {room.friendName ||
                      t("尚未加入的朋友", "Waiting for a friend")}
                  </strong>
                  <span>
                    {room.status === "REVEALED"
                      ? t(
                          `${room.mode === "HUMAN" ? "本人" : "AI"}局 · ${room.result?.correct ? "猜对了" : "猜错了"}`,
                          `${room.mode === "HUMAN" ? "Human" : "AI"} · ${room.result?.correct ? "Correct guess" : "Incorrect guess"}`,
                        )
                      : room.status === "CANCELLED"
                        ? t("已取消", "Ended")
                        : t("进行中", "In progress")}
                  </span>
                </div>
                {room.result?.reason && <p>“{room.result.reason}”</p>}
              </article>
            ))}
          </div>
        </details>
      ) : (
        <div className="play-stats-empty">
          {t(
            "第一局揭晓后，这里就会留下朋友的答案和理由。",
            "Your friends' answers and reasoning will appear after the first reveal.",
          )}
        </div>
      )}
    </section>
  );
}

export function HostPlayApp({
  processingKind,
}: {
  processingKind: PlayProcessingKind;
}) {
  const { t } = useLanguage();
  const [home, setHome] = useState<PlayHomeDto | null>(null);
  const [deleted, setDeleted] = useState(false);
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
    if (deleted) return;
    void refresh();
    const timer = setInterval(() => {
      if (!actionLock.current && readPending.current === 0) void refresh();
    }, 2000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh, deleted]);
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
  async function deleteAccount() {
    if (actionLock.current) throw new Error("ACTION_BUSY");
    actionLock.current = true;
    ++fetchVersion.current;
    setBusy(true);
    try {
      await heartbeatPending.current;
      await action("delete_account");
      try {
        for (const room of [
          ...(home?.recentRooms || []),
          ...(home?.activeRoom ? [home.activeRoom] : []),
        ]) {
          sessionStorage.removeItem(`self-play-invite:${room.id}`);
        }
      } catch {
        /* Optional local invitation cache. */
      }
      setHome(null);
      setInviteUrl("");
      setDeleted(true);
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  if (deleted)
    return (
      <Frame compact>
        <section className="play-card play-deleted">
          <Check size={32} />
          <h1>{t("账号与游戏数据已删除", "Account and game data deleted")}</h1>
          <p>
            {t(
              "你已退出登录，之前的邀请已失效。",
              "You have been signed out and previous invitations no longer work.",
            )}
          </p>
          <a className="play-button play-button-primary" href="/">
            {t("返回首页", "Back to home")}
          </a>
        </section>
      </Frame>
    );
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
  if (!home.actor)
    return (
      <Auth
        onSignedIn={refresh}
        networkError={error}
        processingKind={processingKind}
      />
    );
  const canCreate =
    home.providerReady &&
    home.online &&
    Boolean(home.persona) &&
    home.styleSummary?.status !== "needs_examples" &&
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
            <LogOut size={15} aria-hidden="true" />
            <span className="play-signout-label">{t("退出", "Sign out")}</span>
          </button>
        </div>
      }
    >
      <div className="play-dashboard-heading">
        <div>
          <span className="play-eyebrow">YOUR PLAY SPACE</span>
          <h1>
            {t("你的语气，朋友的直觉", "Your voice. A friend's intuition.")}
          </h1>
          <p>
            {t(
              "准备好分身，再邀请一位朋友聊五轮。",
              "Prepare your persona, then invite a friend for five rounds.",
            )}
          </p>
        </div>
        <label className="play-online-toggle">
          <span>
            <b>
              {home.online
                ? t("我已上线", "I'm online")
                : t("暂时离线", "Offline")}
            </b>
            <small>
              {home.online
                ? t("保持页面打开，等待朋友", "Keep this page open")
                : t("上线后可以创建邀请", "Go online to create an invite")}
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label={t("主持人在线状态", "Host online status")}
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
      {!home.providerReady && (
        <Notice
          text={t(
            "AI 暂时不可用，恢复后即可创建邀请。请稍后重试。",
            "AI is temporarily unavailable. You can create an invitation once it recovers. Please try again shortly.",
          )}
        />
      )}
      <div
        className={`play-dashboard-grid${home.activeRoom ? " has-room" : ""}`}
      >
        <PersonaEditor
          key={home.actor.id}
          persona={home.persona}
          styleSummary={home.styleSummary || null}
          name={home.actor.pseudonym}
          onSaved={refresh}
          processingKind={home.providerStatus?.kind || processingKind}
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
                {t("找一个认识你的人，", "Invite someone who knows you.")}
                <br />
                {t("试试看。", "See what happens.")}
              </h2>
              <p>
                {t(
                  "每 5 局完整对话中，1–2 局由你回复，其余由 AI 回复，顺序随机。",
                  "Each group of 5 completed conversations includes 1–2 games you answer and the rest answered by AI, in random order.",
                )}
                <br />
                {t(
                  "一次一个朋友，每局五轮。请保持页面在线，轮到本人局时亲自回复。",
                  "One friend and five exchanges per game. Keep this page open and reply yourself in human games.",
                )}
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
                {busy
                  ? t("正在创建…", "Creating…")
                  : t("创建一局，生成邀请", "Create invitation")}
              </button>
              <p className="play-start-hint">
                {!home.providerReady
                  ? t(
                      "等待 AI 就绪后即可开局。",
                      "Waiting for AI to become available.",
                    )
                  : !home.persona
                    ? t("先保存分身资料。", "Save your persona first.")
                    : home.styleSummary?.status === "needs_examples"
                      ? t(
                          "先补充能识别出本人发言的示例。",
                          "Add examples that identify your own messages first.",
                        )
                      : !home.online
                        ? t(
                            "打开上方在线开关。",
                            "Switch your status to online above.",
                          )
                        : t(
                            "邀请创建后，请保持此页面在线。",
                            "Keep this page open after creating an invitation.",
                          )}
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
      <DeleteControl account disabled={busy} onDelete={deleteAccount} />
    </Frame>
  );
}

const JOIN_TOKEN_KEY = "self-play-pending-invitation";

export function JoinPlayApp({
  processingKind,
}: {
  processingKind: PlayProcessingKind;
}) {
  const { t } = useLanguage();
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
      setError("INVITATION_MISSING");
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
            <p>{t("正在打开邀请…", "Opening invitation…")}</p>
          </div>
        ) : invitation ? (
          <>
            <h1>
              {t(
                `${invitation.hostName} 邀请你，猜猜是谁在回复。`,
                `${invitation.hostName} invites you to guess: human or AI?`,
              )}
            </h1>
            <p className="play-muted">
              {t(
                "可能是本人，也可能是模仿本人的 AI。",
                "You may be talking to your friend, or an AI imitating them.",
              )}
              <br />
              {t(
                "五轮对话后，选出你的答案。",
                "After five rounds, make your guess.",
              )}
            </p>
            <div className="play-join-rules">
              <span>
                01
                <span>
                  {t("说一句，等一句回复", "Send a message, wait for a reply")}
                </span>
              </span>
              <span>
                02
                <span>
                  {t(
                    "聊满五轮，凭直觉判断",
                    "Chat for five rounds, then guess",
                  )}
                </span>
              </span>
              <span>
                03
                <span>
                  {t("揭晓答案，留下一点理由", "Reveal the answer and reflect")}
                </span>
              </span>
            </div>
            <PlayModelNotice kind={processingKind} />
            <form className="play-form" onSubmit={join}>
              <label>
                {t("游戏化名（非实名）", "Game alias (not your real name)")}
                <input
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  maxLength={40}
                  required
                  disabled={busy}
                  autoComplete="nickname"
                  placeholder={t(
                    "请勿使用真实姓名或可识别身份的昵称",
                    "Choose an alias that does not identify you",
                  )}
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
                  {t(
                    "我同意将对话与判断用于人机交互（HCI）实验和分析，AI 局消息由模型处理。个人信息不公开，分析后清理；可随时退出，有效会话内可自行删除本局。",
                    "I agree to my chat and guess being used for this HCI experiment and analysis. AI-game messages are processed by a model. Personal information is not public; data is cleared after analysis. I can leave at any time and delete the game while my session is valid.",
                  )}
                  <a href="/privacy">
                    {t("阅读隐私说明", "Read the privacy notice")}
                  </a>
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
                {busy
                  ? t("正在加入…", "Joining…")
                  : t("开始五轮聊天", "Start chatting")}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1>
              {t("这次邀请暂时无法打开", "This invitation could not be opened")}
            </h1>
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
              {t(
                "请朋友确认邀请仍然有效，并重新发送完整链接。",
                "Ask your friend to check the invitation and send the full link again.",
              )}
            </p>
          </>
        )}
      </section>
    </Frame>
  );
}

export function FriendPlayRoom({ roomId }: { roomId: string }) {
  const { t } = useLanguage();
  const [room, setRoom] = useState<PlayRoomDto | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const readPending = useRef(0);
  const mounted = useRef(true);
  const mutation = useRef(false);
  const deletedRef = useRef(false);
  const lastSend = useRef<{ text: string; key: string } | null>(null);
  const refresh = useCallback(async () => {
    if (mutation.current || deletedRef.current) return;
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
    if (deleted || room?.status === "REVEALED" || room?.status === "CANCELLED")
      return;
    const timer = setInterval(() => {
      if (readPending.current === 0) void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh, room?.status, deleted]);
  async function send(text: string) {
    if (mutation.current) throw new Error("ACTION_BUSY");
    if (!lastSend.current || lastSend.current.text !== text)
      lastSend.current = { text, key: crypto.randomUUID() };
    mutation.current = true;
    setIsMutating(true);
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
      setIsMutating(false);
    }
  }
  async function leave() {
    if (mutation.current) throw new Error("ACTION_BUSY");
    mutation.current = true;
    setIsMutating(true);
    ++requestVersion.current;
    try {
      const result = await action<{ room: PlayRoomDto }>("leave", { roomId });
      setRoom(result.room);
      setError("");
    } finally {
      mutation.current = false;
      setIsMutating(false);
    }
  }
  async function deleteData() {
    if (mutation.current) throw new Error("ACTION_BUSY");
    mutation.current = true;
    setIsMutating(true);
    ++requestVersion.current;
    try {
      await action("delete_data", { roomId });
      deletedRef.current = true;
      setDeleted(true);
      setRoom(null);
      setError("");
    } finally {
      mutation.current = false;
      setIsMutating(false);
    }
  }
  async function makeGuess(guess: PlayIdentity, reason: string) {
    if (mutation.current) throw new Error("ACTION_BUSY");
    mutation.current = true;
    setIsMutating(true);
    ++requestVersion.current;
    try {
      const result = await action<{ room: PlayRoomDto }>("guess", {
        roomId,
        guess,
        reason,
      });
      setRoom(result.room);
      setError("");
    } finally {
      mutation.current = false;
      setIsMutating(false);
    }
  }
  if (deleted)
    return (
      <Frame compact>
        <section className="play-card play-deleted">
          <Check size={32} />
          <h1>{t("本局数据已删除", "Game data deleted")}</h1>
          <p>
            {t(
              "本局双方的聊天和判断结果已删除，房间已关闭。",
              "Both participants' messages and the guess have been deleted. This room is now closed.",
            )}
          </p>
          <a className="play-button play-button-primary" href="/">
            {t("返回首页", "Back to home")}
          </a>
        </section>
      </Frame>
    );
  return (
    <Frame
      compact
      side={
        <span className="play-room-top-note">
          {t("五轮之后，答案见", "Five rounds, then the reveal")}
        </span>
      }
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
                      ? t("这一次，答案已揭晓", "The answer is revealed")
                      : room.status === "CANCELLED"
                        ? t("本局已结束", "This game has ended")
                        : t(
                            "像平常一样，聊点什么",
                            "Chat as you normally would",
                          )}
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
                disabled={isMutating || room.waitingFor !== "FRIEND"}
                hint={
                  room.waitingFor === "FRIEND"
                    ? t("你想说点什么…", "What would you like to say…")
                    : t(
                        "等待回复后，继续下一轮",
                        "Wait for a reply before the next round",
                      )
                }
                onSend={send}
              />
            )}
            {room.status === "WAITING" && (
              <Notice
                text={t(
                  "聊天正在准备，请稍等片刻。",
                  "Getting your conversation ready. Please wait.",
                )}
              />
            )}
            {room.status === "GUESSING" && (
              <Guess disabled={isMutating} onGuess={makeGuess} />
            )}
            {room.status === "REVEALED" && <Result room={room} />}
            {room.status === "CANCELLED" && (
              <div className="play-ended">
                <span className="play-eyebrow">THIS ROUND HAS ENDED</span>
                <h2>{t("这一局，到这里结束。", "This game has ended.")}</h2>
                <p>
                  {t(
                    "本局没有完成，因此不会揭晓身份。",
                    "The game was not completed, so the identity stays hidden.",
                  )}
                  <br />
                  {t(
                    "想再聊一局，可以向朋友要一条新邀请。",
                    "Ask your friend for a new invitation to play again.",
                  )}
                </p>
              </div>
            )}
            {room.status !== "REVEALED" && room.status !== "CANCELLED" && (
              <CancelButton friend onCancel={leave} />
            )}
            <DeleteControl disabled={isMutating} onDelete={deleteData} />
          </>
        ) : (
          <div className="play-loading">
            {error ? (
              <Notice text={error} error retry={() => void refresh()} />
            ) : (
              <>
                <LoaderCircle className="play-spin" size={24} />
                <p>{t("正在打开对话…", "Opening the conversation…")}</p>
              </>
            )}
          </div>
        )}
      </section>
    </Frame>
  );
}
