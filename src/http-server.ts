// src/http-server.ts

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

dotenv.config();

/** ---- Config ---- */
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const NODE_ENV = process.env.NODE_ENV || "production";
const SERVER_NAME = process.env.MCP_SERVER_NAME || "Haloscan SEO Tools";
const SERVER_VERSION = process.env.MCP_SERVER_VERSION || "1.0.0";
const MAX_CONNECTIONS = parseInt(process.env.MCP_MAX_CONNECTIONS || "100", 10);
const CONNECTION_TIMEOUT = parseInt(process.env.MCP_CONNECTION_TIMEOUT || "3600", 10);
const PUBLIC_HOST = process.env.PUBLIC_HOST || "haloscan.dokify.eu";

/** ---- HTTP app ---- */
const app = express();

/** Simple logger */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/** CORS + preflight */
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

/** Auth optionnelle */
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

/** ---- MCP server ---- */
const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
// TODO: enregistrer vos outils ici

/** On mémorise les transports actifs pour /messages */
type TransportMap = Record<string, SSEServerTransport>;
const transports: TransportMap = {};
let activeConnections = 0;

/** ---- SSE endpoint ---- */
app.get("/sse", authorize, (req: Request, res: Response) => {
  if (activeConnections >= MAX_CONNECTIONS) {
    res.status(503).json({ error: "Service Unavailable" });
    return;
  }

  req.socket.setTimeout(CONNECTION_TIMEOUT * 1000);

  const Ctor: any = SSEServerTransport as any;
  const transport: SSEServerTransport =
    Ctor.length >= 2 ? new Ctor("/messages", res) : new Ctor({ req, res });

  server.connect(transport as any);

  // @ts-ignore
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

/** ---- Messages endpoint ---- */
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

  // CORS friendly
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  transport.handlePostMessage(req, res);
});

/** ---- Découverte MCP (ultra-compatible) ---- */
function discoveryPayload(baseUrl: string) {
  const sse = { url: `${baseUrl}/sse`, heartbeatIntervalMs: 15000 };
  const messages = { url: `${baseUrl}/messages` };

  return {
    // Format recommandé (endpoints sous "mcp")
    mcp: {
      version: "2024-06-01",            // date-based version utilisée par le spec
      protocol: "2.0",                  // indicatif de protocole si un validateur l'exige
      endpoints: { sse, messages },
    },
    // Champs miroirs pour d’anciens validateurs
    endpoints: { sse, messages },
    sse,
    messages,
    server: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

function sendDiscovery(res: Response) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");       // évite un cache Cloudflare résiduel
  res.setHeader("Access-Control-Allow-Origin", "*"); // certains validateurs le regardent
  res.json(discoveryPayload(`https://${PUBLIC_HOST}`));
}

// Endpoint officiel
app.get("/.well-known/mcp.json", (_req, res) => {
  sendDiscovery(res);
});

// Alias (certains clients testent ceci)
app.get("/mcp.json", (_req, res) => {
  sendDiscovery(res);
});

/** Health + root */
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
app.get("/", (_req, res) => res.redirect("/.well-known/mcp.json"));

/** Error handler */
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[${new Date().toISOString()}]`, err);
  res.status(500).json({
    error: "Internal Server Error",
    message: NODE_ENV === "development" ? err.message : "unexpected error",
  });
});

/** Start */
app.listen(PORT, () => {
  console.log(
    `[${new Date().toISOString()}] ${SERVER_NAME} v${SERVER_VERSION} on :${PORT}`
  );
});
