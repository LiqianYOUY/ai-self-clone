/** Verify the built artifact with a temporary loopback server; preserve dev. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const buildDir = process.env.NEXT_DIST_DIR ?? ".next-build";
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(join(directory, entry.name))
          : [join(directory, entry.name)],
      ),
    )
  ).flat();
}
async function main() {
  const staticFiles = await files(join(buildDir, "static"));
  assert.equal(
    staticFiles.filter((file) => file.endsWith(".map")).length,
    0,
    "Browser source maps must not be generated",
  );
  const artifacts = [
    join(buildDir, "server/app/index.html"),
    join(buildDir, "server/app/index.rsc"),
    ...staticFiles.filter((file) => /\.(js|css)$/.test(file)),
  ];
  const forbidden = [
    "demo-friend-01",
    "demo-target-01",
    "is-it-still-you-synthetic-2026-v1",
    "林知夏",
    "夏禾",
    "听起来不错呀 🌿",
  ];
  for (const file of artifacts) {
    const content = await readFile(file, "utf8");
    for (const value of forbidden)
      assert.ok(!content.includes(value), `Seeded data in ${file}`);
    if (file.endsWith(".js"))
      assert.ok(
        !content.includes("sourceMappingURL="),
        `Browser source map reference in ${file}`,
      );
  }
  console.log(
    `PASS ${artifacts.length} HTML/RSC/browser artifacts contain no checked seeded identities, messages or assignment seed; no browser source maps`,
  );
  const password = process.env.DATABASE_URL
    ? ""
    : (await readFile(".local/database-password", "utf8")).trim();
  const databaseUrl =
    process.env.DATABASE_URL ??
    `postgresql://study_local:${encodeURIComponent(password)}@127.0.0.1:55432/clone_study?schema=public`;
  const port = 3300;
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      STUDY_MODE: "synthetic",
      DATABASE_URL: databaseUrl,
      APP_HOST: "127.0.0.1",
      APP_ORIGIN: origin,
      PORT: String(port),
      NEXT_DIST_DIR: buildDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Production readiness timeout")),
        20_000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("workspace ready")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("error", () => {
        clearTimeout(timeout);
        reject(new Error("Production server could not start"));
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Production server exited ${code}`));
      });
    });
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get("cache-control") ?? "", /no-store/);
    assert.deepEqual(await health.json(), { status: "ok" });
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("cache-control") ?? "", /no-store/);
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"));
    assert.ok(!csp.includes("'unsafe-eval'"), "Production must not allow eval");
    assert.ok(
      csp.includes(`connect-src 'self' ws://127.0.0.1:${port};`),
      "WebSocket CSP must use the runtime origin, not the build-time origin",
    );
    const html = await page.text();
    for (const value of forbidden) assert.ok(!html.includes(value));
    const rsc = await fetch(`${origin}/?_rsc=artifact-audit`, {
      headers: { RSC: "1" },
    });
    assert.equal(rsc.status, 200);
    const rscText = await rsc.text();
    for (const value of forbidden) assert.ok(!rscText.includes(value));
    const script = /src="([^\"]+\.js)"/.exec(html)?.[1];
    assert.ok(script, "Expected browser chunk");
    for (const file of staticFiles.filter((file) => /\.(js|css)$/.test(file))) {
      const assetPath = "/_next/" + file.slice(buildDir.length + 1);
      const asset = await fetch(new URL(assetPath, origin), { method: "HEAD" });
      assert.equal(asset.status, 200, assetPath);
      assert.equal(
        asset.headers.get("cache-control"),
        "public, max-age=31536000, immutable",
        assetPath,
      );
    }
    assert.equal((await fetch(new URL(script + ".map", origin))).status, 404);
    for (const privatePath of [
      "/src/server/engine.ts",
      "/_next/server/app/api/study/route.js",
      "/.env",
      "/.local/database-password",
    ]) {
      assert.equal(
        (await fetch(origin + privatePath)).status,
        404,
        "Private runtime file must not be served",
      );
    }
    assert.equal(
      (await fetch(`${origin}/api/study?view=sessions`)).status,
      401,
    );
    console.log(
      "PASS production startup, DB readiness, private page/API caching, immutable JS/CSS caching, CSP, RSC content, unavailable browser source map, unauthorized API",
    );
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Production verification failed",
  );
  process.exitCode = 1;
});
