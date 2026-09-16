import "dotenv/config";
import {
  ensureLocalModelService,
  localModelConfiguration,
  type LocalModelService,
} from "./local-model-runtime";

let service: LocalModelService | null = null;
let starting: Promise<LocalModelService | null> | null = null;
const controller = new AbortController();
let keepAlive: ReturnType<typeof setInterval> | undefined;
let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  stopping ??= (async () => {
    controller.abort();
    if (keepAlive) clearInterval(keepAlive);
    const pending = await starting?.catch(() => null);
    await (service ?? pending)?.stop();
  })();
  return stopping;
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    await stop();
    process.exit(0);
  });

async function main() {
  const config = localModelConfiguration();
  if (!config)
    throw new Error(
      "The project currently selects a compatible API. Set PLAY_MODEL_PROVIDER=ollama to start a local model.",
    );
  starting = ensureLocalModelService(config, undefined, controller.signal);
  service = await starting;
  controller.signal.throwIfAborted();
  if (!service)
    throw new Error("Ollama is not installed. Run npm run model:setup first.");
  console.log(
    service.owned
      ? "[model] Local Ollama is running. Press Ctrl+C to stop this service. Logs: .local/ollama.log."
      : "[model] Reusing the existing local Ollama service. Press Ctrl+C to leave it running.",
  );
  keepAlive = setInterval(() => undefined, 60_000);
}
main().catch(async (error: unknown) => {
  const interrupted = controller.signal.aborted;
  if (!interrupted)
    console.error(
      `[model] ${error instanceof Error ? error.message : "Local model startup failed."}`,
    );
  await stop();
  process.exitCode = interrupted ? 0 : 1;
});
