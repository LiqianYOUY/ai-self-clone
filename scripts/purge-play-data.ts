/** End-of-analysis erasure for game accounts only. Defaults to a count-only preview. */
import "dotenv/config";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 && !["--dry-run", "--confirm-purge"].includes(args[0]))
  )
    throw new Error(
      "Usage: node --import tsx scripts/purge-play-data.ts [--dry-run | --confirm-purge]",
    );
  if (!process.env.DATABASE_URL) {
    if (!existsSync(".local/database-password"))
      throw new Error(
        "Set DATABASE_URL or start the local database before inspecting game data.",
      );
    const password = (
      await readFile(".local/database-password", "utf8")
    ).trim();
    process.env.DATABASE_URL = `postgresql://study_local:${encodeURIComponent(password)}@127.0.0.1:55432/clone_study?schema=public`;
  }
  const { prisma } = await import("../src/server/db");
  try {
    const { purgePlayData } = await import("../src/server/play");
    const result = await purgePlayData(args[0] === "--confirm-purge");
    console.log(
      result.dryRun
        ? "Dry run: game data is unchanged. Pass --confirm-purge only after the experiment and analysis are complete."
        : "Deleted the selected game accounts and their related personal data.",
    );
    console.log(JSON.stringify(result, null, 2));
    console.log(
      "Scope: TARGET participants with a play-target- ID; no study accounts or other participants are selected.",
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  // Report usage/setup failures, but never print database credentials or row data.
  console.error(
    error instanceof Error &&
      (error.message.startsWith("Usage:") ||
        error.message.startsWith("Set DATABASE_URL"))
      ? error.message
      : "Game data cleanup failed; no transaction was partially committed. Check database access and account relationships.",
  );
  process.exitCode = 1;
});
