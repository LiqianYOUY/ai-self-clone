"use client";

import { SelfBrand } from "./self-brand";
import { LanguageSwitch, useLanguage } from "./language-provider";
import {
  generatedReplyPolicy,
  playProcessingCopy,
  type PlayProcessingKind,
} from "./play-model-copy";

export function PrivacyNotice({
  processingKind,
}: {
  processingKind: PlayProcessingKind;
}) {
  const { t } = useLanguage();
  return (
    <main className="play-root privacy-page">
      <header className="play-topbar">
        <SelfBrand />
        <LanguageSwitch />
      </header>
      <article className="privacy-content">
        <a className="play-text-link" href="/play">
          {t("← 返回实验", "← Back to the experiment")}
        </a>
        <h1>{t("参与和隐私", "Participation & privacy")}</h1>
        <p className="privacy-intro">
          {t(
            "本实验仅用于比较 AI 与真人的人机交互体验，以及相关结果分析。全程非实名参与。",
            "This experiment compares interaction with AI and real people. Data is used only for this experiment and its analysis. Real-name identification is not required.",
          )}
        </p>
        <section>
          <h2>{t("用化名参加", "Take part with a pseudonym")}</h2>
          <p>
            {t(
              "使用昵称和自选用户名，无需真实姓名、邮箱、手机号或证件。请勿在人物资料、对话示例或聊天中填写能识别身份的信息，也不要上传未经同意的他人资料。",
              "Use a nickname and a username of your choice. No real name, email, phone number or ID is required. Keep identifying details out of your persona, examples and chat, and do not provide another person’s information without permission.",
            )}
          </p>
          <p>
            {t(
              "非实名不等于绝对匿名：熟悉你的朋友仍可能从语气或内容认出你。",
              "Pseudonymous participation is not absolute anonymity: a friend may still recognise your wording or stories.",
            )}
          </p>
        </section>
        <section>
          <h2>
            {t("记录什么、谁能看到", "What is recorded, and who can see it")}
          </h2>
          <p>
            {t(
              "系统保存账号的密码哈希、昵称、人物资料、对话示例、本局聊天、猜测及结果。朋友无需注册，只能通过专属邀请和会话访问这一局；主持人可查看自己的实验记录。项目负责人在维护服务和分析实验时可访问实验数据。个人信息不会公开。",
              "The system stores a password hash, nickname, persona, conversation examples, chat, guesses and results. Guests need no account and use a private invitation and session to access their game. Hosts can view their own records. The project operator can access experiment data for maintenance and analysis. Personal information is not made public.",
            )}
          </p>
          <p>{t(...playProcessingCopy(processingKind))}</p>
          <p>{t(...generatedReplyPolicy)}</p>
          <p>
            {t(
              "公开 GitHub 仓库仅备份代码、部署文件和文档，不包含参与者数据、数据库或密钥。",
              "The public GitHub repository contains code, deployment files and documentation, not participant data, databases or secrets.",
            )}
          </p>
        </section>
        <section>
          <h2>{t("何时删除", "When data is deleted")}</h2>
          <p>
            {t(
              "实验及结果分析完成后，项目负责人会统一删除实验系统中的账号、人物资料、聊天、猜测和相关访问标识，不继续保留或公开任何个人信息。清理需要负责人执行，不以“结束一局”作为自动删除全部资料的触发条件。",
              "Once the experiment and analysis are complete, the project operator will delete experiment accounts, personas, chats, guesses and related access identifiers. Personal information will not be retained or published. This cleanup is performed by the operator; ending one game does not automatically delete all records.",
            )}
          </p>
        </section>
        <section>
          <h2>{t("退出或申请删除", "Leaving or deleting your data")}</h2>
          <p>
            {t(
              "参与完全自愿，可随时退出。主持人登录后可删除账号及所有游戏资料；朋友可在本局会话有效期内（24 小时）删除整局数据。会话过期或清除 Cookie 后，请通过邀请人联系项目负责人申请删除。删除会同时移除双方在该局的聊天，无法撤销。仅“结束本局”或“退出登录”不会删除已保存的记录。",
              "Participation is voluntary and you can leave at any time. Signed-in hosts can delete their account and all game data. Guests can delete their game while its session remains valid (24 hours). If the session expires or cookies are cleared, ask the inviter to contact the project operator for deletion. Deleting a game removes both participants’ messages and cannot be undone. Ending a game or signing out alone does not delete saved records.",
            )}
          </p>
        </section>
        <section>
          <h2>{t("必要的连接与存储", "Essential connections and storage")}</h2>
          <p>
            {t(
              "网站使用必要的会话 Cookie 维持登录和邀请权限，并在浏览器本地保存语言偏好。网络托管及连接服务仍可能处理 IP 等连接信息；非实名承诺不表示网络层没有技术记录。",
              "Essential session cookies maintain sign-in and invitation access. Your browser stores your language preference locally. Hosting and network services may still process connection information such as IP addresses; participation without a real name does not mean the network has no technical records.",
            )}
          </p>
        </section>
        <p className="privacy-contact">
          {t(
            "如有参与或删除方面的问题，请联系邀请你参加的人或项目负责人。",
            "For questions about participation or deletion, contact the person who invited you or the project operator.",
          )}
        </p>
      </article>
    </main>
  );
}
