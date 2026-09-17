import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { stopGatewayProcess } from "../scripts/start-private-model-server";

function fakeChild(onKill?: (signal: NodeJS.Signals) => void) {
  const signals: NodeJS.Signals[] = [];
  const process = Object.assign(new EventEmitter(), {
    pid: 12345 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      onKill?.(signal);
      return true;
    },
  });
  return { process, child: process as unknown as ChildProcess, signals };
}

test("a gateway that never acquired a PID or already exited is never signalled", async () => {
  for (const state of [
    { pid: undefined },
    { exitCode: 0 },
    { signalCode: "SIGKILL" as const },
  ]) {
    const { child, process, signals } = fakeChild();
    Object.assign(process, state);
    await stopGatewayProcess(child);
    assert.deepEqual(signals, []);
    assert.equal(process.listenerCount("exit"), 0);
    assert.equal(process.listenerCount("error"), 0);
  }
});

test("a real failed gateway spawn can be cleaned up without waiting for an exit event", async () => {
  const child = spawn("/does-not-exist-ai-self-gateway", [], {
    stdio: "ignore",
  });
  await once(child, "error");
  assert.equal(child.pid, undefined);
  await stopGatewayProcess(child);
});

test("gateway shutdown waits for graceful exit and removes only its own listeners", async () => {
  const { child, process, signals } = fakeChild();
  const existing = () => undefined;
  process.on("exit", existing);
  let complete = false;
  const stopping = stopGatewayProcess(child).then(() => {
    complete = true;
  });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(complete, false);
  process.exitCode = 0;
  process.emit("exit", 0, null);
  await stopping;
  assert.equal(complete, true);
  assert.deepEqual(process.listeners("exit"), [existing]);
  assert.equal(process.listenerCount("error"), 0);
  await stopGatewayProcess(child);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("a gateway error while stopping cannot leave shutdown pending", async () => {
  const { child, process, signals } = fakeChild();
  const stopping = stopGatewayProcess(child);
  process.emit("error", new Error("test process failure"));
  await stopping;
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(process.listenerCount("exit"), 0);
  assert.equal(process.listenerCount("error"), 0);
});

test("gateway shutdown handles synchronous exit or a thrown signal error", async () => {
  const immediate = fakeChild(() => {
    immediate.process.exitCode = 0;
    immediate.process.emit("exit", 0, null);
  });
  await stopGatewayProcess(immediate.child);
  assert.deepEqual(immediate.signals, ["SIGTERM"]);
  const failure = fakeChild(() => {
    throw new Error("test signal failure");
  });
  await stopGatewayProcess(failure.child);
  assert.deepEqual(failure.signals, ["SIGTERM"]);
});

test("an unresponsive gateway receives SIGKILL after the graceful deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, process, signals } = fakeChild((signal) => {
    if (signal === "SIGKILL") {
      process.signalCode = signal;
      process.emit("exit", null, signal);
    }
  });
  const stopping = stopGatewayProcess(child);
  t.mock.timers.tick(4999);
  assert.deepEqual(signals, ["SIGTERM"]);
  t.mock.timers.tick(1);
  await stopping;
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(process.listenerCount("exit"), 0);
  assert.equal(process.listenerCount("error"), 0);
});

test("missing exit and error events cannot bypass the final shutdown deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, process, signals } = fakeChild();
  const stopping = stopGatewayProcess(child);
  t.mock.timers.tick(6500);
  await stopping;
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(process.listenerCount("exit"), 0);
  assert.equal(process.listenerCount("error"), 0);
});

test("importing the inference supervisor does not load configuration or start services", async () => {
  const source = `await import(${JSON.stringify(pathToFileURL(resolve("scripts/start-private-model-server.ts")).href)}); process.exitCode = 23;`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    {
      env: {
        ...process.env,
        PRIVATE_MODEL_CONFIG: "/does-not-exist-ai-self-config",
      },
      stdio: "pipe",
    },
  );
  const [code] = await once(child, "exit");
  assert.equal(code, 23);
});
