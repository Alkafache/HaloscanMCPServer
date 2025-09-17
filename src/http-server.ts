// src/http-server.ts
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

dotenv.config();

const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const NODE_ENV = process.env.NODE_ENV || "production";
const SERVER_NAME = process.env.MCP_SERVER_NAME || "Haloscan SEO Tools";
const SERVER_VERSION = process.env.MCP_SERVER_VERSION || "1.0.0";
const MAX_CONNECTIONS = parseInt(process.env.MCP_MAX_CONNECTIONS || "100", 10);
const CONNECTION_TIMEOUT = parseInt(process.env.MCP_CONNECTION_TIMEOUT || "3600", 10);

const app = express();

// si tu es derrière Cloudflare/NGINX, fais confiance au proxy
app.set("trust proxy", true);

// log simple
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// CORS
app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Type"],
  })
);
app.options("*", (_req, res) => res.sendStatus(200));
app.use(express.json());

// --- Auth optionnelle (pour /sse et /messages) ---
function authorize(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_ENABLED) return next();
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = h.slice(7);
  if (!process.env.API_TOKEN || token !== process.env.API_TOKEN) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

// TODO si tu as des outils/prompts : configureHaloscanServer(server);

type TransportMap = Record<string, SSEServerTransport>;
const transports: TransportMap = {};
let activeConnections = 0;

// certains clients POSTent /sse : noop 200
app.post("/sse", authorize, (_req, res) => res.status(200).end());

// ---- SSE (laisser le SDK écrire ; NE PAS faire res.write) ----
app.get("/sse", authorize, (req: Request, res: Response) => {
  if (activeConnections >= MAX_CONNECTIONS) {
    res.status(503).json({ error: "Service Unavailable" });
    return;
  }

  // socket longue durée
  req.socket.setTimeout(CONNECTION_TIMEOUT * 1000);

  // SDK >= 1.8.0 : signature { req, res }
  const transport = new SSEServerTransport({ req, res });

  // branchement au serveur MCP -> le SDK gère "endpoint" + pings
  server.connect(transport);

  // suivi de session
  // @ts-ignore: sessionId est exposé par le transport
  const sessionId: string = (transport as any).sessionId;
  transports[sessionId] = transport;
  activeConnections++;

  console.log(
    `[${new Date().toISOString()}] SSE connected: ${sessionId} (${activeConnections}/${MAX_CONNECTIONS})`
  );

  res.on("close", () => {
    delete transports[sessionId];
    activeConnections--;
    console.log(
      `[${new Date().toISOString()}] SSE closed: ${sessionId} (${activeConnections}/${MAX_CONNECTIONS})`
    );
  });
});

// ---- Messages ----
app.post("/messages", authorize, (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) {
    res.status(400).json({ error: "Bad Request", message: "sessionId required" });
    return;
  }
  const transport = transports[sessionId];
  if (!transport) {
    res.status(404).json({ error: "Not Found", message: "No active session" });
    return;
  }

  // CORS permissif pour clients stricts
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // délègue au SDK JSON-RPC
  transport.handlePostMessage(req, res);
});

// ---- Fichier de découverte MCP ----
app.get("/.well-known/mcp.json", (_req, res) => {
  const host = process.env.PUBLIC_HOST || "haloscan.dokify.eu";
  res.json({
    mcp: { version: "2024-06-01", protocol: "2.0" },
    sse: { url: `https://${host}/sse`, heartbeatIntervalMs: 15000 },
    messages: { url: `https://${host}/messages` },
    server: { name: SERVER_NAME, version: SERVER_VERSION },
  });
});

// ---- Health ----
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    uptime: process.uptime(),
    activeConnections,
    environment: NODE_ENV,
  });
});

// redirect racine vers mcp.json
app.get("/", (_req, res) => res.redirect("/.well-known/mcp.json"));

// erreurs
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[${new Date().toISOString()}]`, err);
  res.status(500).json({
    error: "Internal Server Error",
    message: NODE_ENV === "development" ? err.message : "unexpected error",
  });
});

app.listen(PORT, () => {
  console.log(
    `[${new Date().toISOString()}] ${SERVER_NAME} v${SERVER_VERSION} on :${PORT}`
  );
});
