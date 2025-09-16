// src/http-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
// Si tu as une config Haloscan, importe-la ici. Sinon, commente la ligne suivante.
// import { configureHaloscanServer } from "./haloscan-core.js";

dotenv.config();

// ---- Env ----
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_ENABLED = process.env.AUTH_ENABLED === "true"; // laisse false si pas d'auth côté ChatGPT
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const NODE_ENV = process.env.NODE_ENV || "production";
const SERVER_NAME = process.env.MCP_SERVER_NAME || "Haloscan SEO Tools";
const SERVER_VERSION = process.env.MCP_SERVER_VERSION || "1.0.0";
const MAX_CONNECTIONS = parseInt(process.env.MCP_MAX_CONNECTIONS || "100", 10);
const CONNECTION_TIMEOUT = parseInt(process.env.MCP_CONNECTION_TIMEOUT || "3600", 10);

// ---- Auth (optionnelle) ----
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

// ---- App ----
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

// Body parser
app.use(express.json());

// ---- MCP server ----
const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
// Si tu as un module qui enregistre tes outils, dé-commente :
// configureHaloscanServer(server);
console.log("Server configured with Haloscan tools (minimal)");

// Suivi des transports
const transports: Record<string, SSEServerTransport> = {};
let activeConnections = 0;

// Protéger SSE/messages si auth activée
app.use(["/sse", "/messages"], authorizeRequest);

// Certains clients commencent par POST /sse : réponds 200
app.post("/sse", (_req, res) => res.status(200).end());

// ---- SSE endpoint ----
app.get("/sse", (req: Request, res: Response): void => {
  if (activeConnections >= MAX_CONNECTIONS) {
    res.status(503).send({ error: "Service Unavailable", message: "Maximum number of connections reached" });
    return;
  }

  // En-têtes SSE (anti-buffering + no-transform)
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Flush immédiat des headers (si dispo)
  (res as any).flushHeaders?.();

  // Timeout long
  req.socket.setTimeout(CONNECTION_TIMEOUT * 1000);

  // SDK 1.7.x -> signature 2 arguments. Si tu passes le SDK en ^1.8.0, remplace par { req, res }.
  const transport = new SSEServerTransport("/messages", res);
  // const transport = new SSEServerTransport({ req, res }); // <- si SDK >= 1.8.0

  // @ts-ignore
  const sessionId: string = (transport as any).sessionId;

  // 🔸 Envoi MANUEL de l’événement initial (certaines versions/proxys le requièrent)
  res.write(`event: endpoint\n`);
  res.write(`data: /messages?sessionId=${sessionId}\n\n`);

  transports[sessionId] = transport;
  activeConnections++;

  console.log(
    `[${new Date().toISOString()}] SSE connection established: ${sessionId} (${activeConnections}/${MAX_CONNECTIONS} active)`
  );

  res.on("close", () => {
    console.log(`[${new Date().toISOString()}] SSE connection closed: ${sessionId}`);
    delete transports[sessionId];
    activeConnections--;
  });

  // Branche MCP
  // @ts-ignore
  server.connect(transport);
});


// ---- Messages ----
app.post("/messages", (req: Request, res: Response): void => {
  const sessionId = String(req.query.sessionId || "");
  console.log("POST /messages", { sessionId, hasBody: !!req.body });

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

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  transport.handlePostMessage(req, res);
});

// ---- Tools-info (hardcodé pour debug) ----
app.get("/tools-info", (_req: Request, res: Response): void => {
  const tools = getHardcodedTools();
  res.status(200).send({
    server: SERVER_NAME,
    version: SERVER_VERSION,
    tools,
    endpoints: { sse: "/sse", messages: "/messages", health: "/health", tools: "/tools-info" },
    stats: { activeConnections, maxConnections: MAX_CONNECTIONS, uptime: process.uptime() },
  });
});

function getHardcodedTools(): any[] {
  return [
    {
      name: "set_api_key",
      description: "Définir la clé API.",
      parameters: { properties: { apiKey: { type: "string", description: "Your Haloscan API key" } }, required: ["apiKey"] },
    },
    {
      name: "get_user_credit",
      description: "Obtenir les informations de crédit de l'utilisateur.",
      parameters: { properties: {}, required: [] },
    },
    {
      name: "get_keywords_overview",
      description: "Obtenir un aperçu des mots-clés.",
      parameters: {
        properties: {
          keyword: { type: "string", description: "Seed keyword" },
          requested_data: { type: "array", items: { type: "string" }, description: "Specific data fields to request" },
        },
        required: ["keyword", "requested_data"],
      },
    },
    {
      name: "get_keywords_match",
      description: "Obtenir la correspondance des mots-clés.",
      parameters: { properties: { keyword: { type: "string", description: "Seed keyword" } }, required: ["keyword"] },
    },
  ];
}

// ---- Health & root ----
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

// ---- Error handler ----
app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  console.error(`[${new Date().toISOString()}] Server error:`, err);
  res.status(500).send({ error: "Internal Server Error", message: NODE_ENV === "development" ? err.message : "An unexpected error occurred" });
});

// ---- Start ----
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
