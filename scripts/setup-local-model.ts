import "dotenv/config";
import {
  ensureLocalModelService,
  installLocalModelBinary,
  localModelConfiguration,
  pullLocalModel,
  type LocalModelService,
} from "./local-model-runtime";

const controller = new AbortController();
let service: LocalModelService | null = null;
let starting: Promise<LocalModelService | null> | null = null;
let stopping: Promise<void> | undefined;
const stop = (): Promise<void> => {
  stopping ??= (async () => {
    controller.abort();
    const pending = await starting?.catch(() => null);
    await (service ?? pending)?.stop();
  })();
  return stopping;
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    await stop();
    process.exit(0);
  });

async function main() {
  const config = localModelConfiguration();
  if (!config)
    throw new Error(
      "The project currently selects a compatible API. Set PLAY_MODEL_PROVIDER=ollama to prepare a local model.",
    );
  starting = ensureLocalModelService(config, undefined, controller.signal);
  service = await starting;
  if (!service) {
    const binary = await installLocalModelBinary(
      config.root,
      controller.signal,
    );
    starting = ensureLocalModelService(config, binary, controller.signal);
    service = await starting;
  }
  if (!service) throw new Error("The local model runtime is unavailable.");
  await pullLocalModel(config, controller.signal);
  console.log(
    "[model] Start the project with npm run dev. No global installation or login startup was changed.",
  );
}
main()
  .catch((error: unknown) => {
    if (!controller.signal.aborted) {
      console.error(
        `[model] ${error instanceof Error ? error.message : "Local model setup failed."}`,
      );
      process.exitCode = 1;
    }
  })
  .finally(stop);
