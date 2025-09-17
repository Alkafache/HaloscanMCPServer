// src/http-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

// ==== Env ====
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const NODE_ENV = process.env.NODE_ENV || "production";
const SERVER_NAME = process.env.MCP_SERVER_NAME || "Haloscan SEO Tools";
const SERVER_VERSION = process.env.MCP_SERVER_VERSION || "1.0.0";
const MAX_CONNECTIONS = parseInt(process.env.MCP_MAX_CONNECTIONS || "100", 10);
const CONNECTION_TIMEOUT = parseInt(process.env.MCP_CONNECTION_TIMEOUT || "3600", 10);
const SESSION_TTL_MS = parseInt(process.env.MCP_SESSION_TTL || "30000", 10); // 30s

// ==== Auth (optionnelle) ====
function authorizeRequest(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_ENABLED) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).send({ error: "Unauthorized", message: "Authorization: Bearer <token> required" });
    return;
  }
  const token = authHeader.slice(7);
  if (!process.env.API_TOKEN || token !== process.env.API_TOKEN) {
    res.status(403).send({ error: "Forbidden", message: "Invalid authorization token" });
    return;
  }
  next();
}

// ==== App ====
const app = express();

// Logs
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// CORS + preflight
app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Type"],
  })
);
app.options("*", (_req, res) => res.sendStatus(200));

// ⚠️ Body parser global -> on EXCLUT /messages pour conserver le flux brut
app.use((req, res, next) => {
  if (req.path === "/messages") return next();
  return express.json()(req, res, next);
});

// ==== MCP server ====
const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
console.log("Server configured with Haloscan tools (minimal)");

// Suivi des transports
const transports: Record<string, SSEServerTransport> = {};
let activeConnections = 0;

app.use(["/sse", "/messages"], authorizeRequest);

// Certains clients commencent par POST /sse
app.post("/sse", (_req, res) => res.status(200).end());

// ==== SSE endpoint ====
app.get("/sse", (req: Request, res: Response): void => {
  if (activeConnections >= MAX_CONNECTIONS) {
    res.status(503).send({ error: "Service Unavailable", message: "Maximum number of connections reached" });
    return;
  }

  // Laisse le SDK gérer les en-têtes ; on ne fait PAS de setHeader ici
  req.socket.setTimeout(CONNECTION_TIMEOUT * 1000);

  // Compatibilité SDK 1.7.x (2 args) / >=1.8.x ({ req, res })
  const SSECtor: any = SSEServerTransport as any;
  const transport: any =
    SSECtor.length >= 2 ? new SSECtor("/messages", res) : new SSECtor({ req, res });

  const sessionId: string = (transport as any).sessionId;
  transports[sessionId] = transport;
  activeConnections++;

  console.log(
    `[${new Date().toISOString()}] SSE connection established: ${sessionId} (${activeConnections}/${MAX_CONNECTIONS} active)`
  );

  // Keepalive pour éviter que les proxys ferment la connexion
  const keepAlive = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch { /* ignore */ }
  }, 15000);

  res.on("close", () => {
    console.log(`[${new Date().toISOString()}] SSE connection closed: ${sessionId}`);
    clearInterval(keepAlive);
    // Nettoyage retardé pour laisser passer un POST un peu tardif
    setTimeout(() => {
      if (transports[sessionId]) {
        delete transports[sessionId];
        activeConnections--;
        console.log(`[${new Date().toISOString()}] Transport cleaned for sessionId ${sessionId}`);
      }
    }, SESSION_TTL_MS);
  });

  // Démarre le flux géré par le SDK (il enverra les en-têtes)
  server.connect(transport);

  // Envoi de l'event endpoint APRÈS connect(), quand les en-têtes sont partis
  setImmediate(() => {
    try {
      const proto =
        (req.headers["x-forwarded-proto"] as string) ||
        req.protocol ||
        "https";
      const host = req.headers.host!;
      const endpointAbs = `${proto}://${host}/messages?sessionId=${sessionId}`;
      res.write(`event: endpoint\n`);
      res.write(`data: ${endpointAbs}\n\n`);
      console.log(
        `[${new Date().toISOString()}] Sent endpoint event for session ${sessionId} -> ${endpointAbs}`
      );
    } catch (e) {
      console.error("Failed to write endpoint event:", e);
    }
  });
});

// ==== Messages (flux brut, pas de express.json ici) ====
app.post("/messages", (req: Request, res: Response): void => {
  const sessionId = String(req.query.sessionId || "");
  console.log("POST /messages", { sessionId });

  if (!sessionId) {
    res.status(400).send({ error: "Bad Request", message: "sessionId query parameter is required" });
    return;
  }

  const transport = transports[sessionId];
  if (!transport) {
    console.log("No transport for sessionId", sessionId);
    res.status(404).send({ error: "Not Found", message: "No active session found for the provided sessionId" });
    return;
  }

  // CORS minimal côté réponse
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Transfert du flux brut au transport (sinon "stream is not readable")
  transport.handlePostMessage(req, res);
});

// ==== Tools-info (debug) ====
app.get("/tools-info", (_req: Request, res: Response): void => {
  res.status(200).send({
    server: SERVER_NAME,
    version: SERVER_VERSION,
    endpoints: { sse: "/sse", messages: "/messages", health: "/health", tools: "/tools-info" },
    stats: { activeConnections, maxConnections: MAX_CONNECTIONS, uptime: process.uptime() },
  });
});

// ==== Health ====
app.get("/health", (_req: Request, res: Response): void => {
  res.status(200).send({
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    uptime: process.uptime(),
    activeConnections,
    environment: NODE_ENV,
  });
});

app.get("/", (_req: Request, res: Response): void => res.redirect("/tools-info"));

// ==== Error handler ====
app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  console.error(`[${new Date().toISOString()}] Server error:`, err);
  res
    .status(500)
    .send({ error: "Internal Server Error", message: NODE_ENV === "development" ? err.message : "An unexpected error occurred" });
});

// ==== Start ====
const httpServer = app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] ${SERVER_NAME} v${SERVER_VERSION} running on http://localhost:${PORT}`);
  console.log(`Connect to /sse for SSE transport`);
  console.log(`Authentication ${AUTH_ENABLED ? "enabled" : "disabled"}`);
  console.log(`Environment: ${NODE_ENV}`);
  console.log(`Max connections: ${MAX_CONNECTIONS}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  httpServer.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});
