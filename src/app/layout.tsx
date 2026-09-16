import type { Metadata } from "next";
import "./globals.css";
import "./portals.css";
import "./participant.css";
import { LanguageProvider } from "@/components/language-provider";
export const metadata: Metadata = {
  description: "邀请朋友聊五轮，猜对面是你本人，还是模仿你的 AI。",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <LanguageProvider>{children}</LanguageProvider>
      </body>
    </html>
  );
}
