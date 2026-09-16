import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  applicationExitStatus,
  stopOwnedChild,
  watchOwnedDatabaseExit,
} from "../scripts/start-local";

async function childReady(source: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", source], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  await once(child.stdout!, "data");
  return child;
}

test("the supervisor reports signal termination as failure for systemd", async () => {
  const child = await childReady(
    "process.stdout.write('ready'); setInterval(() => {}, 1000)",
  );
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
  assert.equal(applicationExitStatus(code), 1);
  assert.equal(applicationExitStatus(17), 17);
  assert.equal(applicationExitStatus(0), 0);
});

test("owned child shutdown allows graceful exit", async () => {
  const child = await childReady(
    "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000)",
  );
  await stopOwnedChild(child, 1000);
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
  // A repeated cleanup must finish instead of waiting for an old exit event.
  await stopOwnedChild(child, 100);
});

test("owned child shutdown escalates when SIGTERM is ignored", async () => {
  const child = await childReady(
    "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
  );
  await stopOwnedChild(child, 100);
  assert.equal(child.signalCode, "SIGKILL");
});

test("owned database exit triggers recovery once and ignores supervisor shutdown", async () => {
  let failures = 0;
  let stopping = false;
  const unexpected = await childReady(
    "process.stdout.write('ready'); setInterval(() => {}, 1000)",
  );
  watchOwnedDatabaseExit(
    unexpected,
    () => stopping,
    () => failures++,
  );
  const crashed = once(unexpected, "exit");
  unexpected.kill("SIGKILL");
  await crashed;
  assert.equal(
    failures,
    1,
    "database failure must request supervisor recovery",
  );

  const graceful = await childReady(
    "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000)",
  );
  watchOwnedDatabaseExit(
    graceful,
    () => stopping,
    () => failures++,
  );
  stopping = true;
  await stopOwnedChild(graceful);
  assert.equal(
    failures,
    1,
    "normal service shutdown must not request a restart",
  );
});

test("importing supervisor helpers does not start services or reset failure status", async () => {
  const source = `await import(${JSON.stringify(pathToFileURL(resolve("scripts/start-local.ts")).href)}); process.exitCode = 23;`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    {
      env: { ...process.env, STUDY_MODE: "must-not-start" },
      stdio: "pipe",
    },
  );
  const [code] = await once(child, "exit");
  assert.equal(code, 23);
});

test("the direct startup entry preserves configuration failure status", async () => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/start-local.ts"],
    {
      env: { ...process.env, STUDY_MODE: "must-fail" },
      stdio: "pipe",
    },
  );
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
});
