import {
  ArrowRight,
  ArrowUpRight,
  Fingerprint,
  MessageCircle,
  Sparkles,
} from "lucide-react";
import { SelfBrand } from "@/components/self-brand";
import "./play/play.css";

export default function Page() {
  return (
    <main className="play-root play-landing">
      <header className="play-topbar">
        <SelfBrand />
        <a href="/play" className="play-text-link">
          我的游戏空间 <ArrowUpRight size={16} />
        </a>
      </header>
      <section className="play-hero">
        <div className="play-hero-copy">
          <span className="play-eyebrow">A LITTLE GAME OF KNOWING YOU</span>
          <h1>
            聊了这么久，
            <br />
            你还认得出<span>我吗？</span>
          </h1>
          <p>
            对面可能是我，也可能是模仿我的 AI。
            <br />
            给朋友五轮聊天的时间，看看熟悉感能不能骗过你。
          </p>
          <a
            href="/play"
            className="play-button play-button-primary play-hero-cta"
          >
            创建我的盲测 <ArrowRight size={18} />
          </a>
          <span className="play-caption">文字聊天 · 每局五轮 · 最后揭晓</span>
        </div>
        <div className="play-hero-art" aria-label="游戏流程：对话，判断，揭晓">
          <div className="play-art-orbit" />
          <div className="play-art-card play-art-card-back">
            <Fingerprint size={42} strokeWidth={1} />
            <span>熟悉的语气</span>
          </div>
          <div className="play-art-card play-art-card-front">
            <span className="play-art-label">THE CONVERSATION</span>
            <MessageCircle size={50} strokeWidth={1.1} />
            <p>
              同样的名字，
              <br />
              谁在回复？
            </p>
            <div className="play-art-pills">
              <span>本人</span>
              <span className="play-art-or">/</span>
              <span>AI</span>
            </div>
          </div>
          <div className="play-art-stamp">
            <span>05</span>
            <small>轮对话 · 一个答案</small>
          </div>
        </div>
      </section>
      <section className="play-how" aria-label="怎么玩">
        <div>
          <span>01</span>
          <h2>留下你的说话方式</h2>
          <p>几段日常对话，加上你的习惯和故事。</p>
        </div>
        <div>
          <span>02</span>
          <h2>邀请一个熟悉的朋友</h2>
          <p>上线等候，每局随机由你或 AI 来回复。</p>
        </div>
        <div>
          <span>03</span>
          <h2>五轮后，听听朋友的答案</h2>
          <p>揭晓身份，也记下露馅或以假乱真的一句话。</p>
        </div>
      </section>
      <footer className="play-landing-footer">
        <span>
          <Sparkles size={15} /> 把「像不像我」变成一场朋友之间的小游戏。
        </span>
        <nav aria-label="原有项目入口">
          <span>研究空间</span>
          <a href="/research">
            Research <ArrowUpRight size={12} />
          </a>
          <a href="/target">
            Target <ArrowUpRight size={12} />
          </a>
          <a href="/friend">
            Friend <ArrowUpRight size={12} />
          </a>
        </nav>
      </footer>
    </main>
  );
}
