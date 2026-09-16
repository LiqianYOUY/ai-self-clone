import type { Metadata } from "next";
import "./globals.css";
import "./portals.css";
import "./participant.css";
export const metadata: Metadata = {
  title: "Self · 猜猜我是谁",
  description: "邀请朋友聊五轮，猜对面是你本人，还是模仿你的 AI。",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
