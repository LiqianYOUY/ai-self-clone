import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export type PrivateModelGatewayConfig = Readonly<{
  upstream: string;
  model: string;
  token: string;
  port: number;
  modelDigest?: string;
}>;
export type PrivateModelGatewayOptions = {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  upstreamTimeoutMs?: number;
  queueTimeoutMs?: number;
  readinessTimeoutMs?: number;
};

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CONFIG_ERROR = "Invalid private model configuration.";
const configSchema = z
  .object({
    upstream: z.string().max(200),
    model: z.string().min(1).max(200),
    token: z.string().regex(/^[\x21-\x7e]{32,512}$/u),
    port: z.number().int().min(1).max(65535),
    modelDigest: z
      .string()
      .regex(/^(?:sha256:)?[a-f0-9]{64}$/iu)
      .optional(),
  })
  .strict();

export function parsePrivateModelConfig(
  value: unknown,
): PrivateModelGatewayConfig {
  try {
    const parsed = configSchema.parse(value);
    const upstream = new URL(parsed.upstream);
    if (
      upstream.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname) ||
      upstream.username ||
      upstream.password ||
      upstream.search ||
      upstream.hash ||
      !["", "/"].includes(upstream.pathname) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/u.test(
        parsed.model,
      ) ||
      parsed.model.split("/").some((part) => part === "." || part === "..") ||
      /(?:^|[:/._-])cloud(?:$|[:/._-])/iu.test(parsed.model)
    )
      throw new Error(CONFIG_ERROR);
    // Avoid depending on DNS or hosts-file resolution for a loopback-only hop.
    if (upstream.hostname === "localhost") upstream.hostname = "127.0.0.1";
    if (Number(upstream.port || 80) === parsed.port)
      throw new Error(CONFIG_ERROR);
    return Object.freeze({
      ...parsed,
      upstream: upstream.origin,
      ...(parsed.modelDigest
        ? { modelDigest: normalizeDigest(parsed.modelDigest)! }
        : {}),
    });
  } catch {
    throw new Error(CONFIG_ERROR);
  }
}

/** A launchd job passes only this path; its bearer token never enters argv. */
export async function loadPrivateModelConfig(
  path = process.env.PRIVATE_MODEL_CONFIG,
): Promise<PrivateModelGatewayConfig> {
  let file;
  try {
    if (!path || !isAbsolute(path)) throw new Error(CONFIG_ERROR);
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 16 * 1024 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error(CONFIG_ERROR);
    const bytes = await file.readFile();
    if (bytes.length > 16 * 1024) throw new Error(CONFIG_ERROR);
    return parsePrivateModelConfig(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new Error(CONFIG_ERROR);
  } finally {
    await file?.close();
  }
}

class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
const unavailable = () => new GatewayError(503, "MODEL_NOT_READY");
const invalidUpstream = () =>
  new GatewayError(502, "INVALID_UPSTREAM_RESPONSE");
const canonicalModel = (model: string) =>
  model.includes(":") ? model : `${model}:latest`;
function normalizeDigest(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/iu.test(value))
    return;
  return value.replace(/^sha256:/iu, "").toLowerCase();
}
function boundedDuration(value: number | undefined, maximum: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(value, maximum)
    : maximum;
}
function deadline(
  parent: AbortSignal | undefined,
  milliseconds: number,
  status = 504,
) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new GatewayError(status, "TIMEOUT")),
    milliseconds,
  );
  timer.unref();
  return {
    controller,
    signal: parent
      ? AbortSignal.any([parent, controller.signal])
      : controller.signal,
    dispose: () => clearTimeout(timer),
  };
}
async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    // Callers such as reader.read() may already have created a rejected promise.
    void promise.catch(() => undefined);
    throw signal.reason;
  }
  let abort: () => void = () => undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function responseJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw invalidUpstream();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw invalidUpstream();
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error instanceof GatewayError ? error : invalidUpstream();
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
async function upstreamJson(
  config: PrivateModelGatewayConfig,
  path: "/api/tags" | "/api/ps" | "/api/chat",
  fetcher: typeof globalThis.fetch,
  signal: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  try {
    signal.throwIfAborted();
    const response = await withAbort(
      fetcher(`${config.upstream}${path}`, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      signal,
    );
    return await responseJson(response, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error instanceof GatewayError ? error : unavailable();
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function selectedModel(
  value: unknown,
  config: PrivateModelGatewayConfig,
): Record<string, unknown> {
  if (!object(value) || !Array.isArray(value.models) || "error" in value)
    throw unavailable();
  const wanted = canonicalModel(config.model);
  const matches = value.models.filter(
    (item) =>
      object(item) &&
      [item.name, item.model].some(
        (name) => typeof name === "string" && canonicalModel(name) === wanted,
      ),
  );
  if (matches.length !== 1) throw unavailable();
  const model = matches[0] as Record<string, unknown>;
  if (
    "remote_host" in model ||
    "remote_model" in model ||
    [model.name, model.model].some(
      (name) =>
        name !== undefined &&
        (typeof name !== "string" || canonicalModel(name) !== wanted),
    )
  )
    throw unavailable();
  const digest = normalizeDigest(model.digest);
  if (!digest || (config.modelDigest && digest !== config.modelDigest))
    throw unavailable();
  // Return only documented model metadata; no upstream credentials or custom fields.
  const selected: Record<string, unknown> = {
    name: canonicalModel(config.model),
    model: canonicalModel(config.model),
    digest,
  };
  for (const key of ["size", "size_vram", "context_length"])
    if (
      typeof model[key] === "number" &&
      Number.isFinite(model[key]) &&
      model[key] >= 0
    )
      selected[key] = model[key];
  for (const key of ["modified_at", "expires_at"])
    if (typeof model[key] === "string" && model[key].length <= 64)
      selected[key] = model[key];
  return selected;
}
async function modelState(
  config: PrivateModelGatewayConfig,
  fetcher: typeof globalThis.fetch,
  parent: AbortSignal | undefined,
  timeoutMs: number,
) {
  const timer = deadline(parent, timeoutMs);
  try {
    const [tags, ps] = await Promise.all([
      upstreamJson(config, "/api/tags", fetcher, timer.signal),
      upstreamJson(config, "/api/ps", fetcher, timer.signal),
    ]);
    const installed = selectedModel(tags, config);
    const resident = selectedModel(ps, config);
    if (
      installed.digest !== resident.digest ||
      typeof resident.expires_at !== "string" ||
      !(Date.parse(resident.expires_at) > Date.now())
    )
      throw unavailable();
    return { installed, resident };
  } catch (error) {
    if (parent?.aborted) throw parent.reason;
    throw error instanceof GatewayError && error.status === 503
      ? error
      : unavailable();
  } finally {
    timer.controller.abort();
    timer.dispose();
  }
}

export async function checkPrivateModelReady(
  input: PrivateModelGatewayConfig,
  options: {
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  await modelState(
    parsePrivateModelConfig(input),
    options.fetch ?? globalThis.fetch,
    options.signal,
    boundedDuration(options.timeoutMs, 5000),
  );
}

const chatSchema = z
  .object({
    model: z.string(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant"]),
            content: z
              .string()
              .min(1)
              .max(65_536)
              .refine((text) => text.trim().length > 0),
          })
          .strict(),
      )
      .min(1)
      .max(11),
    stream: z.literal(false).optional(),
    think: z.literal(false).optional(),
    keep_alive: z.union([z.number().finite(), z.string().max(32)]).optional(),
    options: z
      .object({
        num_ctx: z.number().int().min(512).max(32768).optional(),
        num_predict: z.number().int().min(1).max(768).optional(),
        temperature: z.number().min(0).max(2).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
async function chatBody(
  request: IncomingMessage,
  config: PrivateModelGatewayConfig,
  signal: AbortSignal,
) {
  if (
    request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
      "application/json" ||
    (request.headers["content-encoding"] &&
      request.headers["content-encoding"] !== "identity")
  )
    throw new GatewayError(415, "JSON_REQUIRED");
  if (Number(request.headers["content-length"]) > MAX_REQUEST_BYTES)
    throw new GatewayError(413, "REQUEST_TOO_LARGE");
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = deadline(signal, 10_000, 408);
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        request.off("data", data);
        request.off("end", end);
        request.off("error", fail);
        timer.signal.removeEventListener("abort", abort);
      };
      const fail = (error: unknown) => {
        cleanup();
        request.pause();
        reject(error);
      };
      const abort = () => fail(timer.signal.reason);
      const end = () => {
        cleanup();
        resolve();
      };
      const data = (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_REQUEST_BYTES) {
          fail(new GatewayError(413, "REQUEST_TOO_LARGE"));
          return;
        }
        chunks.push(bytes);
      };
      request.on("data", data);
      request.once("end", end);
      request.once("error", fail);
      timer.signal.addEventListener("abort", abort, { once: true });
      if (timer.signal.aborted) abort();
    });
    const result = chatSchema.safeParse(
      JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    );
    if (!result.success || result.data.model !== config.model)
      throw new GatewayError(400, "INVALID_REQUEST");
    const data = result.data;
    const turns =
      data.messages[0].role === "system"
        ? data.messages.slice(1)
        : data.messages;
    if (
      !turns.length ||
      turns.at(-1)?.role !== "user" ||
      turns.some(
        (message, index) =>
          message.role !== (index % 2 === 0 ? "user" : "assistant"),
      )
    )
      throw new GatewayError(400, "INVALID_REQUEST");
    return {
      model: config.model,
      messages: data.messages,
      stream: false,
      think: false,
      keep_alive: -1,
      options: {
        num_ctx: data.options?.num_ctx ?? 4096,
        num_predict: data.options?.num_predict ?? 512,
        temperature: 0,
      },
    };
  } catch (error) {
    if (timer.signal.aborted) throw timer.signal.reason;
    throw error instanceof GatewayError
      ? error
      : new GatewayError(400, "INVALID_REQUEST");
  } finally {
    timer.dispose();
  }
}
function completion(value: unknown, config: PrivateModelGatewayConfig) {
  if (
    !object(value) ||
    "error" in value ||
    value.done !== true ||
    typeof value.model !== "string" ||
    canonicalModel(value.model) !== canonicalModel(config.model) ||
    !object(value.message) ||
    value.message.role !== "assistant" ||
    typeof value.message.content !== "string" ||
    !value.message.content.trim() ||
    value.message.content.length > 20000 ||
    (value.message.tool_calls !== undefined &&
      (!Array.isArray(value.message.tool_calls) ||
        value.message.tool_calls.length > 0)) ||
    !["stop", "length"].includes(String(value.done_reason))
  )
    throw invalidUpstream();
  const output: Record<string, unknown> = {
    model: canonicalModel(config.model),
    message: { role: "assistant", content: value.message.content },
    done: true,
    done_reason: value.done_reason,
  };
  for (const key of [
    "total_duration",
    "load_duration",
    "prompt_eval_count",
    "prompt_eval_duration",
    "eval_count",
    "eval_duration",
  ])
    if (
      typeof value[key] === "number" &&
      Number.isFinite(value[key]) &&
      value[key] >= 0
    )
      output[key] = value[key];
  return output;
}

function chatQueue(timeoutMs: number) {
  let active = false;
  const waiting: { grant(): void }[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next.grant();
    else active = false;
  };
  return async (signal: AbortSignal): Promise<() => void> => {
    signal.throwIfAborted();
    if (!active) {
      active = true;
      return release;
    }
    if (waiting.length >= 2) throw new GatewayError(503, "BUSY");
    return new Promise((resolve, reject) => {
      const remove = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        const index = waiting.indexOf(entry);
        if (index !== -1) waiting.splice(index, 1);
      };
      const abort = () => {
        remove();
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        remove();
        reject(new GatewayError(503, "BUSY"));
      }, timeoutMs);
      timer.unref();
      const entry = {
        grant: () => {
          remove();
          resolve(release);
        },
      };
      waiting.push(entry);
      signal.addEventListener("abort", abort, { once: true });
    });
  };
}
function respond(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(status === 503 ? { "retry-after": "1" } : {}),
    ...(status >= 400 ? { connection: "close" } : {}),
  });
  response.end(JSON.stringify(value));
}

export function createPrivateModelGateway(
  input: PrivateModelGatewayConfig,
  options: PrivateModelGatewayOptions = {},
) {
  const config = parsePrivateModelConfig(input);
  const fetcher = options.fetch ?? globalThis.fetch;
  const expectedToken = createHash("sha256").update(config.token).digest();
  const acquire = chatQueue(boundedDuration(options.queueTimeoutMs, 10_000));
  const active = new Set<AbortController>();
  const shutdown = () => {
    for (const controller of active)
      controller.abort(new GatewayError(503, "UNAVAILABLE"));
  };
  options.signal?.addEventListener("abort", shutdown, { once: true });
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 5000,
      requestTimeout: 10_000,
      connectionsCheckingInterval: 1000,
    },
    (request, response) => {
      const header = request.headers.authorization ?? "";
      const bearer = /^Bearer ([\x21-\x7e]{32,512})$/u.exec(header);
      const presented = createHash("sha256")
        .update(bearer?.[1] ?? "")
        .digest();
      const authorizationCount = request.rawHeaders.filter(
        (_, index) =>
          index % 2 === 0 &&
          request.rawHeaders[index].toLowerCase() === "authorization",
      ).length;
      const authorized =
        timingSafeEqual(presented, expectedToken) &&
        !!bearer &&
        authorizationCount === 1;
      if (!authorized) {
        respond(response, 401, { error: "UNAUTHORIZED" });
        return;
      }
      if (
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          request.socket.remoteAddress ?? "",
        )
      ) {
        respond(response, 403, { error: "LOOPBACK_REQUIRED" });
        return;
      }
      const route = `${request.method} ${request.url}`;
      if (!["GET /api/tags", "GET /api/ps", "POST /api/chat"].includes(route)) {
        respond(response, 404, { error: "NOT_FOUND" });
        return;
      }
      const lifetime = deadline(
        options.signal,
        boundedDuration(options.requestTimeoutMs, 55_000),
      );
      const controller = lifetime.controller;
      active.add(controller);
      const cancel = () => controller.abort(new GatewayError(499, "CANCELLED"));
      const disconnected = () => {
        if (!response.writableEnded) cancel();
      };
      request.once("aborted", cancel);
      response.once("close", disconnected);
      void (async () => {
        let release: (() => void) | undefined;
        let upstreamTimer: ReturnType<typeof deadline> | undefined;
        try {
          lifetime.signal.throwIfAborted();
          if (route === "POST /api/chat") {
            const body = await chatBody(request, config, lifetime.signal);
            release = await acquire(lifetime.signal);
            upstreamTimer = deadline(
              lifetime.signal,
              boundedDuration(options.upstreamTimeoutMs, 45_000),
            );
            await modelState(
              config,
              fetcher,
              upstreamTimer.signal,
              boundedDuration(options.readinessTimeoutMs, 5000),
            );
            const result = await upstreamJson(
              config,
              "/api/chat",
              fetcher,
              upstreamTimer.signal,
              body,
            );
            respond(response, 200, completion(result, config));
          } else {
            if (
              Number(request.headers["content-length"] || 0) !== 0 ||
              request.headers["transfer-encoding"]
            )
              throw new GatewayError(400, "INVALID_REQUEST");
            const state = await modelState(
              config,
              fetcher,
              lifetime.signal,
              boundedDuration(options.readinessTimeoutMs, 5000),
            );
            respond(response, 200, {
              models: [
                route === "GET /api/tags" ? state.installed : state.resident,
              ],
            });
          }
        } catch (error) {
          const safe = error instanceof GatewayError ? error : unavailable();
          respond(response, safe.status, { error: safe.code });
        } finally {
          request.off("aborted", cancel);
          response.off("close", disconnected);
          upstreamTimer?.controller.abort();
          upstreamTimer?.dispose();
          controller.abort();
          lifetime.dispose();
          active.delete(controller);
          release?.();
        }
      })();
    },
  );
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;
  server.keepAliveTimeout = 5000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable)
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    else socket.destroy();
  });
  server.once("close", () => {
    shutdown();
    options.signal?.removeEventListener("abort", shutdown);
  });
  return server;
}

async function main() {
  const config = await loadPrivateModelConfig();
  await checkPrivateModelReady(config);
  const controller = new AbortController();
  const server = createPrivateModelGateway(config, {
    signal: controller.signal,
  });
  const stop = () => {
    controller.abort();
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () => {
    console.error("Private model gateway stopped.");
    process.exitCode = 1;
    stop();
  });
  console.log(
    `Private model gateway ready on 127.0.0.1:${config.port} (1 active, at most 2 waiting).`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    console.error("Private model gateway could not start.");
    process.exitCode = 1;
  });
}
