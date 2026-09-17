import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { access, mkdir, open, rename, rm } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const VERSION = "0.33.3";
const ARCHIVE_URL = `https://github.com/ollama/ollama/releases/download/v${VERSION}/ollama-darwin.tgz`;
const ARCHIVE_SHA256 =
  "342db03df80bb9db84ff64246031bd5f70c09b59ff52fa5cc9aaae3476cc4a9d";
export const DEFAULT_LOCAL_MODEL = "qwen3.5:4b";
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export type LocalModelConfiguration = {
  origin: string;
  host: string;
  model: string;
  root: string;
};
export type LocalModelService = { owned: boolean; stop(): Promise<void> };

export function localModelConfiguration(
  root = process.cwd(),
): LocalModelConfiguration | null {
  const explicitBase = process.env.PLAY_MODEL_BASE_URL?.trim();
  const provider =
    process.env.PLAY_MODEL_PROVIDER?.trim() ||
    (explicitBase ? "compatible" : "ollama");
  if (provider === "compatible") return null;
  if (provider !== "ollama")
    throw new Error("PLAY_MODEL_PROVIDER must be ollama or compatible.");
  const base = new URL(explicitBase || "http://127.0.0.1:11434");
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !["", "/"].includes(base.pathname)
  )
    throw new Error(
      "Local Ollama must use an HTTP loopback address without credentials or a path.",
    );
  const model = process.env.PLAY_MODEL_NAME?.trim() || DEFAULT_LOCAL_MODEL;
  if (
    model.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/.test(model) ||
    /(?:^|[:/-])cloud(?:$|[:/-])/i.test(model)
  )
    throw new Error(
      "Choose a local model name; cloud aliases are not supported.",
    );
  return { origin: base.origin, host: base.host, model, root: resolve(root) };
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export async function findLocalModelBinary(
  root = process.cwd(),
): Promise<string | null> {
  const candidates = [
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((path) =>
        resolve(path, process.platform === "win32" ? "ollama.exe" : "ollama"),
      ),
    "/Applications/Ollama.app/Contents/Resources/ollama",
    join(
      process.env.HOME ?? "",
      "Applications/Ollama.app/Contents/Resources/ollama",
    ),
    join(resolve(root), ".local/ollama/ollama"),
  ];
  for (const path of candidates) if (await executable(path)) return path;
  return null;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Installs only inside this project; the pinned official archive is verified before extraction. */
export async function installLocalModelBinary(
  root = process.cwd(),
  signal?: AbortSignal,
): Promise<string> {
  const existing = await findLocalModelBinary(root);
  if (existing) return existing;
  if (process.platform !== "darwin")
    throw new Error(
      "Install Ollama with your operating system's installer, then run npm run model:setup again.",
    );
  const local = join(resolve(root), ".local");
  await mkdir(local, { recursive: true, mode: 0o700 });
  const archive = join(local, "ollama-darwin.tgz");
  let present = false;
  try {
    await access(archive);
    present = true;
  } catch {
    /* First installation. */
  }
  if (!present) {
    console.log(
      `[model] Downloading the official Ollama ${VERSION} runtime into this project.`,
    );
    const temporary = `${archive}.${process.pid}.download`;
    const output = await open(temporary, "wx", 0o600);
    try {
      const response = await fetch(ARCHIVE_URL, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(600_000)])
          : AbortSignal.timeout(600_000),
      });
      if (!response.ok || !response.body)
        throw new Error("Runtime download failed; retry npm run model:setup.");
      const total = Number(response.headers.get("content-length"));
      let received = 0,
        milestone = -1;
      for await (const chunk of response.body) {
        await output.writeFile(chunk);
        received += chunk.byteLength;
        if (total > 0) {
          const next = Math.min(10, Math.floor((received * 10) / total));
          if (next > milestone) {
            milestone = next;
            console.log(`[model] Runtime download ${next * 10}%.`);
          }
        }
      }
      await output.close();
      if ((await sha256(temporary)) !== ARCHIVE_SHA256)
        throw new Error(
          "Runtime checksum did not match the pinned release; installation stopped.",
        );
      await rename(temporary, archive);
    } finally {
      await output.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  }
  if ((await sha256(archive)) !== ARCHIVE_SHA256)
    throw new Error(
      "The project Ollama archive has an unexpected checksum. Remove .local/ollama-darwin.tgz and retry setup.",
    );
  signal?.throwIfAborted();
  const destination = join(local, "ollama");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await runFile("tar", ["-xzf", archive, "-C", destination], { signal });
  const binary = join(destination, "ollama");
  if (!(await executable(binary)))
    throw new Error("The extracted Ollama executable is unavailable.");
  return binary;
}

async function serviceAvailable(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/version`, {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    if (!response.ok) return false;
    const value = await response.json();
    return typeof value.version === "string" && value.version.length > 0;
  } catch {
    return false;
  }
}

async function stopOwnedProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    return;
  const waitForExit = (ms: number) =>
    new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer);
        child.off("exit", finish);
        done();
      };
      const timer = setTimeout(finish, ms);
      child.once("exit", finish);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
  const signal = (value: NodeJS.Signals) => {
    try {
      // The group was created by this spawn; an already running service is never signalled.
      if (process.platform === "win32") child.kill(value);
      else process.kill(-child.pid!, value);
    } catch {
      /* The owned process has already exited. */
    }
  };
  signal("SIGTERM");
  await waitForExit(4000);
  if (child.exitCode === null && child.signalCode === null) {
    signal("SIGKILL");
    await waitForExit(1000);
  }
}

/** Reuses an existing service. It only stops the exact process group it starts itself. */
export async function ensureLocalModelService(
  config: LocalModelConfiguration,
  binary?: string | null,
  signal?: AbortSignal,
): Promise<LocalModelService | null> {
  signal?.throwIfAborted();
  if (await serviceAvailable(config.origin))
    return { owned: false, stop: async () => undefined };
  const program = binary ?? (await findLocalModelBinary(config.root));
  if (!program) return null;
  const local = join(config.root, ".local");
  await mkdir(join(local, "ollama-models"), { recursive: true, mode: 0o700 });
  const log = await open(join(local, "ollama.log"), "a", 0o600);
  if (signal?.aborted) {
    await log.close();
    signal.throwIfAborted();
  }
  const child = spawn(program, ["serve"], {
    cwd: config.root,
    env: {
      ...process.env,
      OLLAMA_HOST: config.host,
      OLLAMA_MODELS: join(local, "ollama-models"),
      OLLAMA_NO_CLOUD: "1",
    },
    stdio: ["ignore", log.fd, log.fd],
    detached: process.platform !== "win32",
  });
  let failed = false;
  child.once("error", () => {
    failed = true;
  });
  await log.close();
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      await stopOwnedProcess(child);
    }
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    if (signal?.aborted) {
      await stop();
      signal.throwIfAborted();
    }
    if (failed || child.exitCode !== null || child.signalCode !== null) {
      // A parallel startup may have won the port while this owned process exited.
      if (await serviceAvailable(config.origin))
        return { owned: false, stop: async () => undefined };
      break;
    }
    if (await serviceAvailable(config.origin)) {
      if (signal?.aborted) {
        await stop();
        signal.throwIfAborted();
      }
      return { owned: true, stop };
    }
    await delay(500);
  }
  await stop();
  throw new Error(
    "Local Ollama did not start. Check .local/ollama.log and the configured loopback port.",
  );
}

/** Load only the configured local model, without any participant or example text. */
export async function preloadLocalModel(
  config: LocalModelConfiguration,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(180_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const origin = new URL(config.origin);
    if (
      origin.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      !["", "/"].includes(origin.pathname) ||
      typeof config.model !== "string" ||
      config.model.length > 200 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/.test(
        config.model,
      ) ||
      /(?:^|[:/-])cloud(?:$|[:/-])/i.test(config.model)
    )
      throw new Error("INVALID_LOCAL_CONFIGURATION");
    combined.throwIfAborted();
    const response = await fetch(`${origin.origin}/api/chat`, {
      method: "POST",
      redirect: "error",
      signal: combined,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [],
        stream: false,
        think: false,
        options: { num_ctx: 4096 },
        keep_alive: -1,
      }),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("PRELOAD_UNAVAILABLE");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 16_384) {
          await reader.cancel().catch(() => undefined);
          throw new Error("PRELOAD_RESPONSE_TOO_LARGE");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    combined.throwIfAborted();
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      payload.done !== true ||
      "error" in payload
    ) {
      throw new Error("PRELOAD_NOT_COMPLETE");
    }
  } catch {
    combined.throwIfAborted();
    // Never expose local provider response bodies or transport errors.
    throw new Error("Local model preloading failed.");
  }
}

export async function pullLocalModel(
  config: LocalModelConfiguration,
  signal?: AbortSignal,
): Promise<void> {
  console.log(
    `[model] Preparing ${config.model}. Model files can take several gigabytes.`,
  );
  const response = await fetch(`${config.origin}/api/pull`, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, stream: true }),
  });
  if (!response.ok || !response.body)
    throw new Error(
      "Model download could not start. Check the local Ollama service.",
    );
  const milestones = new Map<string, number>();
  let previousStatus = "",
    finished = false,
    pending = "";
  const processLine = (line: string) => {
    if (!line.trim()) return;
    const item = JSON.parse(line) as {
      status?: string;
      error?: string;
      completed?: number;
      total?: number;
      digest?: string;
    };
    if (item.error)
      throw new Error(
        "Model download failed. Check the model name, available disk space and network connection.",
      );
    if (item.total && typeof item.completed === "number") {
      const key = item.digest ?? "download";
      const milestone = Math.min(
        10,
        Math.floor((item.completed * 10) / item.total),
      );
      if (milestone > (milestones.get(key) ?? -1)) {
        milestones.set(key, milestone);
        console.log(`[model] Model download ${milestone * 10}%.`);
      }
    } else if (item.status && item.status !== previousStatus) {
      previousStatus = item.status;
      if (item.status === "success") {
        finished = true;
        console.log("[model] Local model is ready.");
      } else console.log("[model] Checking model files…");
    }
  };
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    if (pending.length > 1_048_576)
      throw new Error("Unexpected model download response.");
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      processLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  }
  pending += decoder.decode();
  processLine(pending);
  if (!finished)
    throw new Error(
      "Model download ended before completion. Run npm run model:setup to resume it.",
    );
}
