import { PrismaClient } from "@prisma/client";
const globalDb = globalThis as unknown as { researchDb?: PrismaClient };
export const prisma = globalDb.researchDb ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalDb.researchDb = prisma;
export default prisma;
