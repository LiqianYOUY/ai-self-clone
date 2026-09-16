/** Disposable Play UI fixture. Run only via npm run test:isolated -- preview:play. */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { PrismaClient } from "@prisma/client";

const port = 3307;
const origin = `http://127.0.0.1:${port}`;
const fixtureUsername = "style_preview";
const fixturePassword = "style-preview-fixture-2026";
let database: PrismaClient | undefined;
let server: ChildProcess | undefined;
let stopping = false;
let cleaning: Promise<void> | undefined;
let stage = "isolated database validation";
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function cleanup(): Promise<void> {
  if (cleaning) return cleaning;
  stopping = true;
  cleaning = (async () => {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((done) =>
        server!.once("exit", () => done()),
      );
      server.kill("SIGTERM");
      const force = setTimeout(() => {
        if (server?.exitCode === null && server.signalCode === null)
          server.kill("SIGKILL");
      }, 4000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    }
    await database?.$disconnect();
    // The isolated runner owns PostgreSQL and removes its temporary directory.
  })();
  return cleaning;
}

async function main() {
  if (
    process.env.npm_lifecycle_event !== "preview:play" ||
    process.env.STUDY_MODE !== "synthetic" ||
    !process.env.DATABASE_URL
  )
    throw new Error("The isolated npm runner is required");
  const url = new URL(process.env.DATABASE_URL);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username !== "study_test" ||
    !url.password ||
    url.pathname !== "/clone_study_test" ||
    !url.port ||
    url.hash ||
    [...url.searchParams].length !== 1 ||
    url.searchParams.get("schema") !== "public"
  )
    throw new Error("A disposable loopback test database is required");

  stage = "preview port availability";
  await new Promise<void>((done, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : done())),
    );
  });
  if (stopping) return;
  Object.assign(process.env, {
    APP_HOST: "127.0.0.1",
    PORT: String(port),
    APP_ORIGIN: origin,
    NEXT_DIST_DIR: ".cache/production",
    NODE_ENV: "production",
    STUDY_MODE: "synthetic",
    NEXT_TELEMETRY_DISABLED: "1",
  });
  database = (await import("../../src/server/db")).prisma;
  const { registerPlayHost } = await import("../../src/server/portals");
  const { savePlayPersona } = await import("../../src/server/play");
  if (stopping) return;
  stage = "synthetic host and persona creation";
  const actor = await registerPlayHost({
    username: fixtureUsername,
    password: fixturePassword,
    pseudonym: "老王（合成测试）",
  });
  if (stopping) return;
  await savePlayPersona(actor, {
    displayName: "老王",
    exampleSpeaker: "老王",
    bio: "界面检查专用虚构人物，喜欢散步和家常饭，没有真实个人资料。",
    style: "短句口语，少标点，常用空格；先接朋友的话，不用表情图标或动作描写。",
    memories: "这些参考都是合成示例，不代表本局发生过的事情。",
    examplesText: [
      "朋友：在不\n老王：在 咋啦",
      "朋友：今天吃啥\n老王：随便整点面吧",
      "朋友：明天出门不\n老王：行啊 几点",
      "朋友：你这话啥意思\n老王：我说岔了 别多想",
      "朋友：你咋跟机器人一样\n老王：笑死 有那么夸张吗",
      "朋友：今天有点烦\n老王：咋啦 说来听听",
      "朋友：你推荐的那家真不错\n老王：是吧 下次再去",
      "朋友：我刚才没听懂\n老王：就有点困 没别的意思",
    ].join("\n\n"),
  });
  if (stopping) return;
  stage = "production preview startup";
  server = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    env: { ...process.env },
    stdio: "ignore",
  });
  let serverFailed = false;
  const serverExited = new Promise<void>((done) => {
    server!.once("error", () => {
      serverFailed = true;
      done();
    });
    server!.once("exit", () => {
      serverFailed = true;
      done();
    });
  });
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline && !stopping && !serverFailed) {
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      ready = response.ok && (await response.json()).status === "ok";
    } catch {
      // Wait for this owned server; do not expose server or database diagnostics.
    }
    if (ready) break;
    await delay(250);
  }
  if (stopping) return;
  if (!ready || serverFailed) throw new Error("Preview readiness failed");
  console.log(`Disposable synthetic Play preview ready: ${origin}/play`);
  console.log(`Test-only login: ${fixtureUsername}`);
  console.log(`Test-only password: ${fixturePassword}`);
  console.log(
    "Ctrl+C stops the owned preview; the isolated runner removes its database.",
  );
  stage = "preview serving";
  await serverExited;
  if (!stopping) throw new Error("Preview server stopped unexpectedly");
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    if (!process.exitCode) process.exitCode = code;
    stopping = true;
    // Let any in-flight fixture write finish before main's finally disconnects.
    if (server)
      void cleanup().catch(() => {
        process.exitCode = 1;
      });
  });
}

main()
  .catch(() => {
    process.exitCode = 1;
    console.error(
      `Play preview failed during ${stage}; diagnostics suppressed.`,
    );
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch {
      process.exitCode = 1;
      console.error("Play preview cleanup failed.");
    }
  });
