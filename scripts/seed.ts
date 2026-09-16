import "dotenv/config";
import { seedStudy } from "../src/server/seed";
import { prisma } from "../src/server/db";

async function main() {
  if (process.env.STUDY_MODE !== "synthetic")
    throw new Error("Seeding requires STUDY_MODE=synthetic");
  await seedStudy();
  console.log(
    "[study] Synthetic seed is ready. Existing study records are preserved.",
  );
}
main()
  .catch(() => {
    console.error(
      "[study] Seed failed; no real participant data is permitted.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
