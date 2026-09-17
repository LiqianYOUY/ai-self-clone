/** Mac inference supervisor: no database or web application is started here. */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureLocalModelService,
  preloadLocalModel,
  type LocalModelService,
} from "./local-model-runtime";
import {
  loadPrivateModelConfig,
  checkPrivateModelReady,
} from "./private-model-gateway";

export async function stopGatewayProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise<void>((done) => {
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout>;
    let finalTimer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      clearTimeout(finalTimer);
      child.off("exit", finish);
      child.off("error", finish);
      done();
    };
    child.once("exit", finish);
    child.once("error", finish);
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        finish();
      }
    }, 5000);
    finalTimer = setTimeout(finish, 6500);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
    }
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

export async function startPrivateModelServer(): Promise<void> {
  const config = await loadPrivateModelConfig();
  const root = process.cwd();
  const abort = new AbortController();
  let service: LocalModelService | null = null;
  let starting: Promise<LocalModelService | null> | undefined;
  let gateway: ChildProcess | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  let signalReceived = false;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      abort.abort();
      if (timer) clearInterval(timer);
      if (gateway) await stopGatewayProcess(gateway);
      const pending = await starting?.catch(() => null);
      await (service ?? pending)?.stop();
    })();
    return stopping;
  };
  const onSignal = () => {
    signalReceived = true;
    void stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const local = {
      origin: config.upstream,
      host: new URL(config.upstream).host,
      model: config.model,
      root,
    };
    // This is the dedicated model process, not the user's other Ollama instance.
    process.env.OLLAMA_NUM_PARALLEL = "1";
    process.env.OLLAMA_MAX_LOADED_MODELS = "1";
    starting = ensureLocalModelService(local, undefined, abort.signal);
    service = await starting;
    if (!service) throw new Error("MODEL_RUNTIME_UNAVAILABLE");
    console.log("[private-model] Preloading the configured local model.");
    await preloadLocalModel(local, abort.signal);
    abort.signal.throwIfAborted();
    await checkPrivateModelReady(config);
    abort.signal.throwIfAborted();
    gateway = spawn(
      process.execPath,
      ["--import", "tsx", resolve(root, "scripts/private-model-gateway.ts")],
      { cwd: root, env: process.env, stdio: "inherit" },
    );
    const gatewayExit = new Promise<number>((done) => {
      gateway!.once("error", () => done(1));
      gateway!.once("exit", (code) => done(code ?? 1));
    });
    let checking = false;
    let failedChecks = 0;
    timer = setInterval(() => {
      if (checking || stopping) return;
      checking = true;
      void checkPrivateModelReady(config)
        .then(() => {
          failedChecks = 0;
        })
        .catch(() => {
          if (++failedChecks >= 3) {
            console.error(
              "[private-model] Model readiness lost; restarting the service.",
            );
            void stop();
          }
        })
        .finally(() => {
          checking = false;
        });
    }, 15_000);
    console.log(
      "[private-model] Resident model ready; starting the authenticated loopback gateway.",
    );
    await gatewayExit;
    if (!signalReceived) throw new Error("GATEWAY_EXITED");
  } finally {
    await stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startPrivateModelServer().catch(() => {
    // Provider responses, paths containing secrets and participant text are never logged.
    console.error(
      "[private-model] Service stopped; check runtime availability and private configuration.",
    );
    process.exitCode = 1;
  });
}
