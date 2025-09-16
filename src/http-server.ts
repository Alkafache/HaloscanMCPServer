// src/http-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { EventEmitter } from "events";
import { configureHaloscanServer } from "./haloscan-core.js";

dotenv.config();

// ---- Env ----
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_ENABLED = process.env.AUTH_ENABLED === "true"; // laisse false en prod si pas d'auth côté ChatGPT
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const NODE_ENV = process.env.NODE_ENV || "production";
const SERVER_NAME = process.env.MCP_SERVER_NAME || "Haloscan SEO Tools";
const SERVER_VERSION = process.env.MCP_SERVER_VERSION || "1.0.0";
const MAX_CONNECTIONS = parseInt(process.env.MCP_MAX_CONNECTIONS || "100", 10);
const CONNECTION_TIMEOUT = parseInt(process.env.MCP_CONNECTION_TIMEOUT || "3600", 10);

// ---- Auth middleware (optionnel) ----
const authorizeRequest = (req: Request, res: Response, next: NextFunction): void => {
  if (!AUTH_ENABLED) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).send({ error: "Unauthorized", message: "Authorization: Bearer <token> required" });
    return;
  }
  const token = authHeader.substring(7);
  if (!process.env.API_TOKEN || token !== process.env.API_TOKEN) {
    res.status(403).send({ error: "Forbidden", message: "Invalid authorization token" });
    return;
  }
  next();
};

// ---- App ----
const app = express();
const serverEvents = new EventEmitter();

// Logs simples
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// CORS + preflight global
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
configureHaloscanServer(server);
console.log("Server configured with Haloscan tools");

// Suivi des transports/sessions
const transports: Record<string, SSEServerTransport> = {};
let activeConnections = 0;

// Auth seulement sur les routes sensibles
app.use(["/sse", "/messages"], authorizeRequest);

// Certains clients font un POST /sse au début : on renvoie 200 (no-op)
app.post("/sse", (_req, res) => {
  res.status(200).end();
});

// ---- SSE endpoint ----
app.get("/sse", (req: Request, res: Response): void => {
  if (activeConnections >= MAX_CONNECTIONS) {
    res.status(503).send({ error: "Service Unavailable", message: "Maximum number of connections reached" });
    return;
  }

  // Headers SSE + anti-buffering
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // utile derrière nginx/traefik
  (res as any).flushHeaders?.(); // flush immédiat si dispo

  // Long timeout pour connexion persistante
  req.socket.setTimeout(CONNECTION_TIMEOUT * 1000);

  // --- IMPORTANT ---
  // SDK 1.7.x : signature à 2 arguments (endpoint, res)
  const transport = new SSEServerTransport("/messages", res);

  // Si tu passes à @modelcontextprotocol/sdk >= 1.8.0,
  // utilise la nouvelle signature :
  // const transport = new SSEServerTransport({ req, res });

  transports[(transport as any).sessionId] = transport;
  activeConnections++;

  console.log(
    `[${new Date().toISOString()}] SSE connection established: ${(transport as any).sessionId} (${activeConnections}/${MAX_CONNECTIONS} active)`
  );

  res.on("close", () => {
    console.log(`[${new Date().toISOString()}] SSE connection closed: ${(transport as any).sessionId}`);
    delete transports[(transport as any).sessionId];
    activeConnections--;
  });

  // Brancher le transport MCP
  server.connect(transport as any);
});

// ---- Messages endpoint ----
app.post("/messages", (req: Request, res: Response): void => {
  const sessionId = (req.query.sessionId as string) || "";
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

  // CORS ceinture+bretelles
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  transport.handlePostMessage(req, res);
});

// ---- Debug: liste des tools exposés ----
app.get("/tools-info", (_req: Request, res: Response): void => {
  let registeredTools: any[] = [];
  try {
    const anyServer = server as any;
    if (anyServer._registeredTools && typeof anyServer._registeredTools === "object") {
      registeredTools = Object.entries(anyServer._registeredTools).map(([name, tool]: [string, any]) => {
        let properties = {};
        let required: string[] = [];
        if (tool?.parameters) {
          if (tool.parameters.shape) properties = tool.parameters.shape;
          else if (tool.parameters.properties) properties = tool.parameters.properties;
          if (Array.isArray(tool.parameters.required)) required = tool.parameters.required;
        }
        return { name, description: tool.description || "", parameters: { properties, required } };
      });
    }
  } catch (e) {
    console.error("Error extracting tools:", e);
  }

  if (!registeredTools.length) {
    registeredTools = getHardcodedTools();
  }

  res.status(200).send({
    server: SERVER_NAME,
    version: SERVER_VERSION,
    tools: registeredTools,
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

app.get("/", (_req: Request, res: Response): void => {
  re

