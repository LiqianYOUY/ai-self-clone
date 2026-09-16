import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanArtifacts } from "../scripts/clean.mjs";

test("artifact cleanup preserves application data, dependencies, source, and unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-clean-"));
  try {
    const retained = [
      ".local",
      "node_modules",
      "src",
      "tests",
      "docs",
      "unrelated",
    ];
    for (const directory of [
      ...retained,
      ".cache",
      ".next-build",
      "coverage",
    ]) {
      await mkdir(join(root, directory));
      await writeFile(join(root, directory, "keep.txt"), "fixture");
    }
    await writeFile(join(root, "tsconfig.tsbuildinfo"), "generated");
    const expected = [
      ".cache",
      ".next-build",
      "tsconfig.tsbuildinfo",
      "coverage",
    ];
    assert.deepEqual(await cleanArtifacts(root, { dryRun: true }), expected);
    assert.equal(
      await readFile(join(root, ".cache", "keep.txt"), "utf8"),
      "fixture",
    );
    assert.deepEqual(await cleanArtifacts(root), expected);
    assert.deepEqual(await cleanArtifacts(root), []);
    for (const directory of retained)
      assert.equal(
        await readFile(join(root, directory, "keep.txt"), "utf8"),
        "fixture",
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact cleanup unlinks cache symlinks without removing their target data", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-clean-link-"));
  try {
    const data = join(root, ".local");
    await mkdir(data);
    await writeFile(join(data, "database"), "preserve");
    await symlink(data, join(root, ".cache"), "dir");
    assert.deepEqual(await cleanArtifacts(root), [".cache"]);
    assert.equal(await readFile(join(data, "database"), "utf8"), "preserve");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
