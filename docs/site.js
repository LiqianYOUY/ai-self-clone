// Working links live in HTML; JavaScript only enhances the language controls.
const ONLINE_GAME_URL = document.getElementById("study-link").href;
const LANGUAGE_KEY = "self-language";

const translations = {
  zh: {
    pageTitle: "Self · 人机交互实验",
    meta: "用昵称参与五轮文字实验，研究人与 AI、真人的互动。资料仅用于实验及分析，完成后删除，个人信息不公开。",
    skip: "跳到主要内容",
    home: "Self 首页",
    tagline: "人机交互实验",
    navigation: "页面导航",
    privacy: "隐私说明",
    language: "选择语言",
    eyebrow: "五轮对话 · 一次判断",
    titleOne: "是朋友，",
    titleTwo: "还是 AI？",
    description:
      "和熟悉的朋友聊五轮，判断回复来自本人还是 AI。本实验仅研究人与 AI、真人的互动。",
    start: "开始实验",
    steps: "如何参与",
    stepOne: "留下表达习惯",
    stepOneBody: "使用昵称或随机用户名，提供几段不含身份信息的对话示例。",
    stepTwo: "邀请一位朋友",
    stepTwoBody: "保持页面打开，系统随机安排你或 AI 回复。",
    stepThree: "聊天，然后判断",
    stepThreeBody: "五轮后提交猜测并揭晓。你可以随时结束参与。",
    privacyTitle: "你的资料，只用于这次研究。",
    privacyBody:
      "无需真实姓名、邮箱或手机号，请勿填写可识别身份的信息。资料仅用于本实验及相关分析，实验与分析完成后删除，个人信息不会公开。",
    privacyProcessing:
      "在线版网页和实验记录在项目树莓派。分身参考资料和当前对话经加密连接交由项目 Mac 的本机模型处理，不使用云端模型。AI 回复不会自动成为表达示例或训练资料。",
    privacyLink: "查看完整隐私说明",
    footer: "Self · AI 与真人互动实验",
    documents: "项目文档",
    features: "功能说明",
  },
  en: {
    pageTitle: "Self · Human–AI interaction study",
    meta: "Take part in a five-round interaction study using a nickname. Data is used for the study and analysis, then deleted. Personal information is not published.",
    skip: "Skip to content",
    home: "Self home",
    tagline: "Human–AI interaction study",
    navigation: "Page navigation",
    privacy: "Privacy",
    language: "Choose language",
    eyebrow: "FIVE ROUNDS. ONE GUESS.",
    titleOne: "A friend,",
    titleTwo: "or an AI?",
    description:
      "Chat with someone you know for five rounds, then guess who replied. This study explores interaction with AI and real people.",
    start: "Start the study",
    steps: "How to take part",
    stepOne: "Share your speaking style",
    stepOneBody:
      "Use a nickname or random username and a few conversation examples without identifying details.",
    stepTwo: "Invite a friend",
    stepTwoBody:
      "Keep the page open. Each session randomly assigns you or the AI to reply.",
    stepThree: "Chat, then make a guess",
    stepThreeBody:
      "After five rounds, guess and reveal the source. You can stop at any time.",
    privacyTitle: "Your data is for this study only.",
    privacyBody:
      "No real name, email address or phone number is required. Please do not enter identifying information. Data is used only for this study and its analysis, and will be deleted when both are complete. Personal information will not be published.",
    privacyProcessing:
      "The online website and experiment records are hosted on the project Raspberry Pi. Persona references and the current conversation go over an encrypted connection to a model running locally on the project Mac. No cloud model is used. AI replies do not automatically become speaking examples or training material.",
    privacyLink: "Read the full privacy notice",
    footer: "Self · Human–AI interaction study",
    documents: "Project documents",
    features: "Features",
  },
};

function setLanguage(language) {
  const text = translations[language];
  const url = new URL(location.href);
  if (url.searchParams.has("lang")) {
    url.searchParams.set("lang", language);
    history.replaceState(history.state, "", url);
  }
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title = text.pageTitle;
  document.querySelector('meta[name="description"]').content = text.meta;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = text[element.dataset.i18n];
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((element) => {
    element.setAttribute("aria-label", text[element.dataset.i18nAria]);
  });
  document.querySelectorAll("[data-language]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.language === language),
    );
  });
  const studyLink = document.getElementById("study-link");
  const game = new URL(ONLINE_GAME_URL);
  game.searchParams.set("lang", language);
  studyLink.href = game.href;
  const privacy = new URL("/privacy", game);
  privacy.searchParams.set("lang", language);
  document.querySelectorAll("[data-privacy-link]").forEach((link) => {
    link.href = privacy.href;
  });
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    /* Language still works when browser storage is unavailable. */
  }
}

let initialLanguage = new URLSearchParams(location.search).get("lang");
if (initialLanguage !== "zh" && initialLanguage !== "en") {
  try {
    initialLanguage = localStorage.getItem(LANGUAGE_KEY);
  } catch {
    /* Use the default language. */
  }
}
setLanguage(initialLanguage === "en" ? "en" : "zh");
document.querySelectorAll("[data-language]").forEach((button) => {
  button.addEventListener("click", () => setLanguage(button.dataset.language));
  button.disabled = false;
});
