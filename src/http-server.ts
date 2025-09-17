// src/http-server.ts
// ------------------------------------------------------------
// Haloscan MCP Server (HTTP + SSE) - prêt pour ChatGPT
// ------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
// Si tu as une config Haloscan de tes tools, dé-commente et utilise-la.
// import { configureHaloscanServer } from "./haloscan-core.js";

dotenv.config();

// -------------------------
// Environnement
// -------------------------
const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "production";
const SERVER_NAME = process.env.MCP_SERVER_NAME || "Haloscan SEO Tools";
const SERVER_VERSION = process.env.MCP_SERVER_VERSION || "1.0.0";

const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";
const API_TOKEN = process.env.API_TOKEN || "";

const MAX_CONNECTIONS = parseInt(process.env.MCP_MAX_CONNECTIONS || "100", 10);
const CONNECTION_TIMEOUT = parseInt(process.env.MCP_CONNECTION_TIMEOUT || "3600", 10);

// Origines autorisées (inclut explicitement ChatGPT)
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";
const ALLOWED_ORIGINS = [
  "https://chat.openai.com",
  "https://staging.chat.openai.com",
  CORS_ORIGIN || undefined,
  "*" // garde le wildcard pour nos tests, on filtrera intelligemment ci-dessous
].filter(Boolean) as string[];

// -------------------------
// Auth (optionnelle)
// -------------------------
function authorizeRequest(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_ENABLED) return next();

  const hdr = req.headers.authorization || "";
  if (!hdr.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized", message: "Authorization: Bearer <token> required" });
    return;
  }
  const token = hdr.slice(7);
  if (!API_TOKEN || token !== API_TOKEN) {
    res.status(403).json({ error: "Forbidden", message: "Invalid authorization token" });
    return;
  }
  next();
}

// -------------------------
// Express
// -------------------------
const app = express();

// Logs simples
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// CORS — permet origin explicites + wildcard pour test
app.use(
  cors({
    origin: (origin, cb) => {
      // Requêtes internes (curl, same-origin) -> OK
      if (!origin) return cb(null, true);
      // Wildcard ? on accepte tout (utile en diagnose)
      if (ALLOWED_ORIGINS.includes("*")) return cb(null, true);
      // Sinon, doit faire partie de la liste
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Type"],
  })
);
// Répond aux pré-vols
app.options("*", (_req, res) => res.sendStatus(200));

// JSON body
app.use(express.json());

// -------------------------
// MCP Server
// -------------------------
const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
// configureHaloscanServer(server); // si tu as tes tools maison
console.log("Server configured with Haloscan tools (minimal)");

const transports: Record<string, SSEServerTransport> = {};
let activeConnections = 0;

// Protéger SSE/messages si auth activée
app.use(["/sse", "/messages"], authorizeRequest);

// -------------------------
// Well-known MCP discovery
// -------------------------
// Permet à ChatGPT de découvrir automatiquement où se connecter.
app.get("/.well-known/mcp.json", (_req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.status(200).send({
    mcp: { version: "2024-06-01", protocol: "2.0" },
    sse: { url: "https://haloscan.dokify.eu/sse", heartbeatIntervalMs: 15000 },
    messages: { url: "https://haloscan.dokify.eu/messages" },
    server: { name: SERVER_NAME, version: SERVER_VERSION }
  });
});

// -------------------------
// SSE Endpoint
// -------------------------
app.get("/sse", (req: Request, res: Response): void => {
  if (activeConnections >= MAX_CONNECTIONS) {
    res.status(503).json({ error: "Service Unavailable", message: "Maximum number of connections reached" });
    return;
  }

  // Laisser le SDK gérer l’ouverture; on ne pousse pas de données avant connect()
  // mais on indique des headers utiles (pas writeHead!)
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Long timeout
  req.socket.setTimeout(CONNECTION_TIMEOUT * 1000);

  // Compat SDK: 1.7.x (2 args) ou >=1.8.0 ({req,res})
  let transport: SSEServerTransport;
  const Ctor: any = SSEServerTransport as any;
  try {
    transport =
      Ctor.length >= 2
        ? new Ctor("/messages", res)   // signature ancienne
        : new Ctor({ req, res });      // signature moderne
  } catch (e) {
    console.error("Failed to construct SSEServerTransport:", e);
    res.status(500).end();
    return;
  }

  const sessionId: string = (transport as any).sessionId;
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

  // Branche le transport au serveur MCP (ne rien écrire AVANT ceci)
  server.connect(transport);
});

// Certaines implémentations testent POST /sse -> répondons 200 pour ne pas échouer
app.post("/sse", (_req, res) => res.status(200).end());

// -------------------------
// Messages Endpoint
// -------------------------
app.post("/messages", (req: Request, res: Response): void => {
  const sessionId = String(req.query.sessionId || "");
  console.log("POST /messages", { sessionId, hasBody: !!req.body });

  if (!sessionId) {
    res.status(400).json({ error: "Bad Request", message: "sessionId query parameter is required" });
    return;
  }

  const transport = transports[sessionId];
  if (!transport) {
    res.status(404).json({ error: "Not Found", message: "No active session found for the provided sessionId" });
    return;
  }

  // Headers CORS basiques pour clients navigateur
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Laisse le SDK parser et router le message JSON-RPC
  transport.handlePostMessage(req, res);
});

// -------------------------
// Tools info (debug simple)
// -------------------------
app.get("/tools-info", (_req: Request, res: Response) => {
  res.status(200).json({
    server: SERVER_NAME,
    version: SERVER_VERSION,
    tools: getHardcodedTools(),
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

// -------------------------
// Health & racine
// -------------------------
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    uptime: process.uptime(),
    activeConnections,
    environment: NODE_ENV,
  });
});

app.get("/", (_req, res) => res.redirect("/tools-info"));

// -------------------------
// Error handler global
// -------------------------
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[${new Date().toISOString()}] Server error:`, err);
  res.status(500).json({
    error: "Internal Server Error",
    message: NODE_ENV === "development" ? err.message : "An unexpected error occurred",
  });
});

// -------------------------
// Start
// -------------------------
const httpServer = app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] ${SERVER_NAME} v${SERVER_VERSION} running on http://localhost:${PORT}`);
  console.log(`CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  httpServer.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});
