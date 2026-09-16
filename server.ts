import "dotenv/config";
import { createServer, type IncomingMessage } from "node:http";
import next from "next";
import { Server } from "socket.io";
import { getActor } from "./src/server/auth";
import {
  allowedOrigin,
  enforceRateLimit,
  isAllowedOrigin,
} from "./src/server/http";
import { getSession, processDeliveries } from "./src/server/engine";
import { prisma } from "./src/server/db";

process.env.NEXT_TELEMETRY_DISABLED = "1";

async function main() {
  const host = process.env.APP_HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL required; use npm run dev for local synthetic data",
    );
  // No environment switch can turn demo role selection into institutional identity.
  if (process.env.STUDY_MODE !== "synthetic") {
    throw new Error(
      "Live deployment blocked: approved governance, identity and operational adapters are required.",
    );
  }
  const origin = allowedOrigin();
  // Next's configured headers are frozen at build time. Derive CSP here so
  // deploying the same build at a different APP_ORIGIN keeps sockets working.
  const socketOrigin = new URL(origin);
  socketOrigin.protocol = socketOrigin.protocol === "https:" ? "wss:" : "ws:";
  const scriptPolicy =
    process.env.NODE_ENV === "production"
      ? "'self' 'unsafe-inline'"
      : "'self' 'unsafe-inline' 'unsafe-eval'";
  const contentSecurityPolicy = `default-src 'self'; script-src ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${socketOrigin.origin}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;
  const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (
    !isLoopback &&
    (!process.env.DEMO_ACCESS_TOKEN ||
      process.env.DEMO_ACCESS_TOKEN.length < 24)
  ) {
    throw new Error(
      "Non-loopback synthetic hosting requires a DEMO_ACCESS_TOKEN of at least 24 characters.",
    );
  }
  const app = next({
    dev: process.env.NODE_ENV !== "production",
    hostname: host,
    port,
  });
  await app.prepare();
  const handler = app.getRequestHandler();
  const server = createServer((request, response) => {
    // Host binding is explicit; never trust forwarded origin or identity headers.
    response.setHeader("Content-Security-Policy", contentSecurityPolicy);
    // Let Next apply its versioned-asset cache policy (and its dev policy).
    if (!request.url?.startsWith("/_next/static/"))
      response.setHeader("Cache-Control", "no-store");
    handler(request, response).catch(() => {
      if (!response.headersSent)
        response.writeHead(500, { "Content-Type": "application/json" });
      response.end('{"error":"REQUEST_FAILED"}');
    });
  });
  const io = new Server(server, {
    path: "/socket.io",
    maxHttpBufferSize: 4096,
    transports: ["websocket", "polling"],
    cors: { origin, credentials: true },
    allowRequest(request, callback) {
      callback(null, isAllowedOrigin(request.headers.origin));
    },
    serveClient: false,
  });
  const toRequest = (request: IncomingMessage) =>
    new Request(origin + "/api/study", {
      headers: {
        cookie: request.headers.cookie ?? "",
        origin: request.headers.origin ?? "",
      },
    });
  io.use(async (socket, nextMiddleware) => {
    try {
      const actor = await getActor(toRequest(socket.request));
      if (!actor) return nextMiddleware(new Error("AUTHENTICATION_REQUIRED"));
      nextMiddleware();
    } catch {
      nextMiddleware(new Error("REQUEST_REJECTED"));
    }
  });
  io.on("connection", (socket) => {
    let sessionId: string | null = null;
    let sending = false;
    let lastProjection = "";
    const sendProjection = async () => {
      if (sending || !sessionId || !socket.connected) return;
      sending = true;
      try {
        // Every refresh revalidates the persisted login and domain ownership.
        const actor = await getActor(toRequest(socket.request));
        if (!actor) {
          socket.emit("session:error", { error: "AUTHENTICATION_REQUIRED" });
          socket.disconnect(true);
          return;
        }
        const projection = await getSession(actor, sessionId);
        const serialized = JSON.stringify(projection);
        if (serialized !== lastProjection) {
          lastProjection = serialized;
          socket.emit("session:update", projection);
        }
      } catch {
        sessionId = null;
        lastProjection = "";
        socket.emit("session:error", { error: "REQUEST_REJECTED" });
      } finally {
        sending = false;
      }
    };
    socket.on(
      "session:watch",
      async (payload: unknown, ack?: (result: unknown) => void) => {
        try {
          const actor = await getActor(toRequest(socket.request));
          if (!actor) throw new Error("Rejected");
          enforceRateLimit(`actor:${actor.id}`, 180);
          enforceRateLimit(`socket-watch:${actor.id}`, 30);
          if (!payload || typeof payload !== "object" || Array.isArray(payload))
            throw new Error("Rejected");
          const data = payload as Record<string, unknown>;
          if (
            Object.keys(data).length !== 1 ||
            typeof data.sessionId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,100}$/.test(data.sessionId)
          )
            throw new Error("Rejected");
          // Domain authorization happens before storing a watched identifier.
          await getSession(actor, data.sessionId);
          sessionId = data.sessionId;
          lastProjection = "";
          await sendProjection();
          if (typeof ack === "function") ack({ ok: true });
        } catch {
          sessionId = null;
          if (typeof ack === "function")
            ack({ ok: false, error: "REQUEST_REJECTED" });
        }
      },
    );
    socket.on(
      "session:unwatch",
      async (_payload: unknown, ack?: (result: unknown) => void) => {
        const actor = await getActor(toRequest(socket.request)).catch(
          () => null,
        );
        sessionId = null;
        lastProjection = "";
        if (typeof ack === "function") ack({ ok: Boolean(actor) });
        if (!actor) socket.disconnect(true);
      },
    );
    const refresh = setInterval(() => {
      void sendProjection();
    }, 1000);
    socket.on("disconnect", () => clearInterval(refresh));
  });
  let working = false;
  const worker = setInterval(async () => {
    if (working) return;
    working = true;
    try {
      await processDeliveries();
    } catch {
      console.warn(
        "[study] delivery worker unavailable; pending messages remain gated",
      );
    } finally {
      working = false;
    }
  }, 500);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(
    `[study] Research portals and synthetic workspace ready at ${origin}`,
  );
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(worker);
    io.disconnectSockets(true);
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error) => {
  // Startup errors are configuration-only; request bodies and DB details are never logged.
  const known =
    error instanceof Error &&
    /^(Invalid PORT|DATABASE_URL required|Live deployment blocked|Non-loopback synthetic hosting|APP_ORIGIN)/.test(
      error.message,
    );
  console.error(
    known
      ? error.message
      : "[study] Unable to start. Verify local database, migrations and port availability.",
  );
  process.exit(1);
});
