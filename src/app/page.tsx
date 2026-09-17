"use client";

import { ArrowRight, ArrowUpRight, MessageCircle } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import "./home.css";

const copy = {
  zh: {
    home: "Self 首页",
    tagline: "人机交互实验",
    privacy: "隐私说明",
    navigation: "页面导航",
    language: "选择语言",
    eyebrow: "五轮对话 · 一次判断",
    title: ["是朋友，", "还是 AI？"],
    description:
      "和熟悉的朋友聊五轮，判断回复来自本人还是 AI。本实验仅研究人与 AI、真人的互动。",
    start: "开始实验",
    steps: "如何参与",
    flow: [
      [
        "留下表达习惯",
        "使用昵称或随机用户名，提供几段不含身份信息的对话示例。",
      ],
      ["邀请一位朋友", "保持页面打开，系统随机安排你或 AI 回复。"],
      ["聊天，然后判断", "五轮后提交猜测并揭晓。你可以随时结束参与。"],
    ],
    privacyTitle: "你的资料，只用于这次研究。",
    privacyBody:
      "无需真实姓名、邮箱或手机号，请勿填写可识别身份的信息。资料仅用于本实验及相关分析，实验与分析完成后删除，个人信息不会公开。",
    privacyLink: "查看完整隐私说明",
    footer: "Self · AI 与真人互动实验",
    skip: "跳到主要内容",
  },
  en: {
    home: "Self home",
    tagline: "Human–AI interaction study",
    privacy: "Privacy",
    navigation: "Page navigation",
    language: "Choose language",
    eyebrow: "FIVE ROUNDS. ONE GUESS.",
    title: ["A friend,", "or an AI?"],
    description:
      "Chat with someone you know for five rounds, then guess who replied. This study explores interaction with AI and real people.",
    start: "Start the study",
    steps: "How to take part",
    flow: [
      [
        "Share your speaking style",
        "Use a nickname or random username and a few conversation examples without identifying details.",
      ],
      [
        "Invite a friend",
        "Keep the page open. Each session randomly assigns you or the AI to reply.",
      ],
      [
        "Chat, then make a guess",
        "After five rounds, guess and reveal the source. You can stop at any time.",
      ],
    ],
    privacyTitle: "Your data is for this study only.",
    privacyBody:
      "No real name, email address or phone number is required. Please do not enter identifying information. Data is used only for this study and its analysis, and will be deleted when both are complete. Personal information will not be published.",
    privacyLink: "Read the full privacy notice",
    footer: "Self · Human–AI interaction study",
    skip: "Skip to content",
  },
};

export default function Page() {
  const { language, setLanguage } = useLanguage();
  const c = copy[language];
  const privacyUrl = `/privacy?lang=${language}`;
  return (
    <div className="self-home" lang={language === "zh" ? "zh-CN" : "en"}>
      <a className="home-skip" href="#main">
        {c.skip}
      </a>
      <div className="home-wrap">
        <header className="home-header">
          <a className="home-brand" href="/" aria-label={c.home}>
            <MessageCircle size={30} strokeWidth={1.5} aria-hidden="true" />
            <span>self</span>
            <small>{c.tagline}</small>
          </a>
          <nav className="home-nav" aria-label={c.navigation}>
            <a className="home-text-link" href={privacyUrl}>
              {c.privacy}
            </a>
            <div className="home-language" role="group" aria-label={c.language}>
              <button
                type="button"
                lang="zh-CN"
                aria-pressed={language === "zh"}
                onClick={() => setLanguage("zh")}
              >
                中文
              </button>
              <button
                type="button"
                lang="en"
                aria-pressed={language === "en"}
                onClick={() => setLanguage("en")}
              >
                EN
              </button>
            </div>
          </nav>
        </header>
        <main id="main">
          <section className="home-hero" aria-labelledby="home-title">
            <div className="home-copy">
              <p className="home-eyebrow">{c.eyebrow}</p>
              <h1 id="home-title">
                <span>{c.title[0]}</span>
                <span>{c.title[1]}</span>
              </h1>
              <p className="home-description">{c.description}</p>
              <a className="home-primary" href={`/play?lang=${language}`}>
                {c.start}
                <ArrowRight size={19} aria-hidden="true" />
              </a>
            </div>
            <ol className="home-flow" aria-label={c.steps}>
              {c.flow.map(([title, body], index) => (
                <li key={index}>
                  <span className="home-step-number" aria-hidden="true">
                    0{index + 1}
                  </span>
                  <div>
                    <h2>{title}</h2>
                    <p>{body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          <section
            className="home-privacy"
            id="privacy"
            aria-labelledby="privacy-title"
          >
            <h2 id="privacy-title">{c.privacyTitle}</h2>
            <div>
              <p>{c.privacyBody}</p>
              <a className="home-text-link" href={privacyUrl}>
                {c.privacyLink}
                <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            </div>
          </section>
        </main>
        <footer className="home-footer">
          <span>{c.footer}</span>
          <a href="https://github.com/LiqianYOUY/ai-self-clone">GitHub ↗</a>
        </footer>
      </div>
    </div>
  );
}
