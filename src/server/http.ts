import { createHash, createHmac, randomBytes } from "node:crypto";

/** Only these neutral errors may cross the authentication gateway. */
export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "GatewayError";
  }
}

export function allowedOrigin(): string {
  const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
  const parsed = new URL(origin);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.origin !== origin
  ) {
    throw new Error("APP_ORIGIN must be one exact HTTP(S) origin");
  }
  return origin;
}

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === origin && origin === allowedOrigin();
  } catch {
    return false;
  }
}

export function assertMutationRequest(request: Request): void {
  enforceRateLimit(`mutation:${requestRateKey(request)}`, 120);
  if (!isAllowedOrigin(request.headers.get("origin")))
    throw new GatewayError(403, "REQUEST_REJECTED");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none")
    throw new GatewayError(403, "REQUEST_REJECTED");
  if (
    request.method !== "DELETE" &&
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new GatewayError(415, "REQUEST_REJECTED");
  }
}

/** Check the actual stream, not just the caller-controlled Content-Length. */
export async function readJson(
  request: Request,
  maximumBytes = 32_768,
): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maximumBytes) throw new GatewayError(413, "REQUEST_REJECTED");
  if (!request.body) throw new GatewayError(400, "REQUEST_REJECTED");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new GatewayError(413, "REQUEST_REJECTED");
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(400, "REQUEST_REJECTED");
  } finally {
    reader.releaseLock();
  }
}

type RateBucket = { count: number; until: number };
const buckets = new Map<string, RateBucket>();
const maximumBuckets = 10_000;
// Keep active exact counters: LRU eviction would let cookie churn reset limits.
// Overflow keys share a bounded set of counters instead of all being rejected.
const overflowBuckets = new Array<
  (RateBucket & { since: number; maximum: number }) | undefined
>(1_024);
const overflowSalt = randomBytes(32);
let nextBucketSweep = 0;

export function enforceRateLimit(
  key: string,
  maximum = 90,
  intervalMs = 60_000,
): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (bucket && bucket.until > now) {
    if (++bucket.count > maximum)
      throw new GatewayError(429, "TRY_AGAIN_LATER");
    return;
  }
  // Replacing an expired exact counter does not increase the table size.
  if (bucket) {
    buckets.set(key, { count: 1, until: now + intervalMs });
    return;
  }
  if (buckets.size >= maximumBuckets && now >= nextBucketSweep) {
    nextBucketSweep = now + 1_000;
    for (const [id, item] of buckets) if (item.until <= now) buckets.delete(id);
  }

  const index =
    createHmac("sha256", overflowSalt).update(key).digest().readUInt32BE(0) %
    overflowBuckets.length;
  let overflow = overflowBuckets[index];
  if (overflow && overflow.until > now) {
    // Collisions share the stricter quota and longer window. The window is
    // anchored to its start so continued traffic cannot extend it forever.
    overflow.maximum = Math.min(overflow.maximum, maximum);
    overflow.until = Math.max(overflow.until, overflow.since + intervalMs);
    if (++overflow.count > overflow.maximum)
      throw new GatewayError(429, "TRY_AGAIN_LATER");
  } else if (buckets.size >= maximumBuckets) {
    overflow = { count: 1, since: now, until: now + intervalMs, maximum };
    overflowBuckets[index] = overflow;
  } else {
    overflow = undefined;
  }
  if (buckets.size < maximumBuckets) {
    // Preserve a spilled key's consumed budget when exact capacity returns.
    buckets.set(
      key,
      overflow
        ? { count: overflow.count, until: overflow.until }
        : { count: 1, until: now + intervalMs },
    );
  }
}

export function requestRateKey(request: Request): string {
  // Forwarded IP headers are intentionally not trusted.
  return createHash("sha256")
    .update((request.headers.get("cookie") ?? "anonymous").slice(0, 4096))
    .digest("hex");
}

export function jsonResponse(
  value: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const result = new Headers(headers);
  result.set("Content-Type", "application/json; charset=utf-8");
  result.set("Cache-Control", "no-store");
  result.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(value), { status, headers: result });
}

export function gatewayErrorResponse(error: unknown): Response {
  const status = error instanceof GatewayError ? error.status : 500;
  return jsonResponse(
    { error: error instanceof GatewayError ? error.code : "REQUEST_FAILED" },
    status,
  );
}
