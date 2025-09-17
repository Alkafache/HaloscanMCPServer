// src/http-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";

// --- ENV ---
dotenv.config();
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";         // laisse "false" pour ChatGPT
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const NODE_ENV = process.env.NODE_ENV || "production";
const SERVER_NAME = process.env.MCP_SERVER_NAME || "Haloscan SEO Tools";
const SERVER_VERSION = process.env.MCP_SERVER_VERSION || "1.0.0";
const MAX_CONNECTIONS = parseInt(process.env.MCP_MAX_CONNECTIONS || "100", 10);
const CONNECTION_TIMEOUT = parseInt(process.env.MCP_CONNECTION_TIMEOUT || "3600", 10);

// --- APP ---
const app = express();

// log minimal
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// CORS global + preflight
app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS", "HEAD"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Type"],
  })
);
app.options("*", (_req, res) => res.sendStatus(204));
app.use(express.json());

// --- AUTH facultative ---
function authorizeRequest(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_ENABLED) return next();
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized", message: "Authorization: Bearer <token> required" });
    return;
  }
  const token = h.slice(7);
  if (!process.env.API_TOKEN || token !== process.env.API_TOKEN) {
    res.status(403).json({ error: "Forbidden", message: "Invalid authorization token" });
    return;
  }
  next();
}

// --- MCP server minimal ---
const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

// Transports SSE actifs
const transports: Record<string, SSEServerTransport> = {};
let activeConnections = 0;

// Protéger SSE/messages seulement si AUTH_ENABLED=true
app.use(["/sse", "/messages"], authorizeRequest);

// —— Discovery MCP (OBLIGATOIRE pour ChatGPT) ——
// GET et HEAD doivent répondre 200 + JSON strict
app.get("/.well-known/mcp.json", (req, res) => {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = req.headers.host || "localhost";
  const base = `${proto}://${host}`;

  const discovery = {
    mcp: {
      version: "2024-06-01",
      protocol: "2.0",
    },
    sse: {
      url: `${base}/sse`,
      heartbeatIntervalMs: 15000,
    },
    messages: {
      url: `${base}/messages`,
    },
    server: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
  };

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify(discovery));
});

app.head("/.well-known/mcp.json", (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).end();
});

// —— SSE endpoint ——
// Remarque: si tu passes le SDK en >=1.8.0, tu peux passer { req, res } au constructeur
app.get("/sse", (req: Request, res: Response) => {
  if (activeConnections >= MAX_CONNECTIONS) {
    res.status(503).json({ error: "Service Unavailable", message: "Maximum number of connections reached" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as any).flushHeaders?.();

  req.socket.setTimeout(CONNECTION_TIMEOUT * 1000);

  // Compat <1.8.0
  const Ctor: any = SSEServerTransport as any;
  const transport: any =
    Ctor.length >= 2 ? new Ctor("/messages", res) : new Ctor({ req, res });

  const sessionId: string = (transport as any).sessionId;

  // annonce endpoint (certains proxys/clients l’exigent)
  res.write(`event: endpoint\n`);
  res.write(`data: /messages?sessionId=${sessionId}\n\n`);

  transports[sessionId] = transport;
  activeConnections++;
  console.log(`[SSE] connected ${sessionId} (${activeConnections}/${MAX_CONNECTIONS})`);

  // ping heartbeat (optionnel)
  const ping = setInterval(() => res.write(`: ping\n\n`), 15000);

  res.on("close", () => {
    clearInterval(ping);
    delete transports[sessionId];
    activeConnections--;
    console.log(`[SSE] closed ${sessionId}`);
  });

  // branchement MCP
  // @ts-ignore
  server.connect(transport);
});

// —— Messages ——
// ChatGPT va POSTer ici: initialize -> tools/list -> tools/call, etc.
app.post("/messages", (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) {
    res.status(400).json({ error: "Bad Request", message: "sessionId query parameter is required" });
    return;
  }
  const transport = transports[sessionId];
  if (!transport) {
    console.log(`[messages] no transport for session ${sessionId}`);
    res.status(404).json({ error: "Not Found", message: "No active session found for the provided sessionId" });
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // délègue au transport MCP
  transport.handlePostMessage(req, res);
});

// —— Endpoints de debug/health —— 
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    uptime: process.uptime(),
    activeConnections,
    environment: NODE_ENV,
  });
});

app.get("/", (_req, res) => {
  res.redirect("/.well-known/mcp.json");
});

// —— Error handler global ——
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[ERROR] ${err.stack || err.message}`);
  res.status(500).json({ error: "Internal Server Error" });
});

// —— Start ——
app.listen(PORT, () => {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} on :${PORT}`);
});
