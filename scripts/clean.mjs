/** Remove only reproducible build/test artifacts; never application data. */
import { lstat, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLEAN_TARGETS = Object.freeze([
  ".cache",
  ".next",
  ".next-build",
  ".next-portals-preview",
  ".next-portals-test",
  "tsconfig.tsbuildinfo",
  ".DS_Store",
  "coverage",
  "test-results",
  "playwright-report",
]);

/**
 * An explicit allowlist keeps .local, node_modules, source and user files safe.
 * rm removes symlinks themselves and does not follow them into their targets.
 * @param {string} root
 * @param {{ dryRun?: boolean }} options
 */
export async function cleanArtifacts(root, { dryRun = false } = {}) {
  const removed = [];
  for (const name of CLEAN_TARGETS) {
    const target = join(root, name);
    try {
      await lstat(target);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT")
        continue;
      throw error;
    }
    if (!dryRun) await rm(target, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

const scriptPath = fileURLToPath(import.meta.url);
async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--dry-run")) {
    console.error("Usage: npm run clean -- [--dry-run]");
    process.exitCode = 1;
  } else {
    const dryRun = arguments_.includes("--dry-run");
    const removed = await cleanArtifacts(resolve(dirname(scriptPath), ".."), {
      dryRun,
    });
    console.log(
      removed.length
        ? `${dryRun ? "Would remove" : "Removed"}: ${removed.join(", ")}`
        : "No build or test artifacts to clean.",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Cleanup failed");
    process.exitCode = 1;
  });
