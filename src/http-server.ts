// http-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { EventEmitter } from "events";
import { configureHaloscanServer } from "./haloscan-core.js";

// Load environment variables
dotenv.config();

// Load configuration from environment
const PORT = process.env.PORT || 3000;
const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const NODE_ENV = process.env.NODE_ENV || "development";
const SERVER_NAME = process.env.MCP_SERVER_NAME || "Haloscan SEO Tools";
const SERVER_VERSION = process.env.MCP_SERVER_VERSION || "1.0.0";
const MAX_CONNECTIONS = parseInt(process.env.MCP_MAX_CONNECTIONS || "100");
const CONNECTION_TIMEOUT = parseInt(process.env.MCP_CONNECTION_TIMEOUT || "3600");

// Authentication middleware
const authorizeRequest = (req: Request, res: Response, next: NextFunction): void => {
  // Skip auth if disabled
  if (!AUTH_ENABLED) {
    return next();
  }
  
  // Get the authorization header
  const authHeader = req.headers.authorization;
  
  // Check if Bearer token is provided and valid
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).send({ 
      error: 'Unauthorized', 
      message: 'Authorization header with Bearer token required' 
    });
    return;
  }
  
  // Extract token
  const token = authHeader.substring(7);
  
  // Validate against environment token
  if (token !== process.env.API_TOKEN) {
    res.status(403).send({ 
      error: 'Forbidden', 
      message: 'Invalid authorization token' 
    });
    return;
  }
  
  // User is authenticated
  next();
};

// Setup Express
const app = express();

// Create event emitter for server events
const serverEvents = new EventEmitter();

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction): void => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Enable CORS with preflight support
app.use(cors({
  origin: CORS_ORIGIN,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Handle preflight OPTIONS requests globally
app.options("*", (req: Request, res: Response): void => {
  res.sendStatus(200);
});

// Parse JSON body
app.use(express.json());

// Create an MCP server
const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION
});

// Configure the server with Haloscan tools and prompts
configureHaloscanServer(server);

// Set up tool monitoring after configuration
console.log("Server configured with Haloscan tools");

// Create transport map to track connections
const transports: {[sessionId: string]: SSEServerTransport} = {};

// Track connection count
let activeConnections = 0;

// Apply authentication to protected routes
app.use(["/sse", "/messages"], authorizeRequest);

// Setup SSE endpoint
app.get("/sse", (req: Request, res: Response): void => {
  // Check if max connections reached
  if (activeConnections >= MAX_CONNECTIONS) {
    res.status(503).send({
      error: "Service Unavailable",
      message: "Maximum number of connections reached"
    });
    return;
  }
  
  // Set headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  // Increase timeout for long-lived connections
  req.socket.setTimeout(CONNECTION_TIMEOUT * 1000);
  
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  
  // Increment connection count
  activeConnections++;
  
  // Log connection
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] SSE connection established: ${transport.sessionId} (${activeConnections}/${MAX_CONNECTIONS} active)`);
  
  res.on("close", () => {
    const closeTimestamp = new Date().toISOString();
    console.log(`[${closeTimestamp}] SSE connection closed: ${transport.sessionId}`);
    
    // Clean up transport and decrement count
    delete transports[transport.sessionId];
    activeConnections--;
  });
  
  // Connect transport to MCP server
  server.connect(transport);
});

// Setup message endpoint
app.post("/messages", (req: Request, res: Response): void => {
  const sessionId = req.query.sessionId as string;
  
  if (!sessionId) {
    res.status(400).send({
      error: "Bad Request",
      message: "sessionId query parameter is required"
    });
    return;
  }
  
  const transport = transports[sessionId];
  
  if (transport) {
    transport.handlePostMessage(req, res);
  } else {
    res.status(404).send({
      error: "Not Found",
      message: "No active session found for the provided sessionId"
    });
  }
});

// Add an informational endpoint about available tools with debug logging
app.get("/tools-info", (req: Request, res: Response): void => {
  // Debug: Print detailed information about _registeredTools
  console.log('Debug: server keys:', Object.keys(server));
  
  if ((server as any)._registeredTools) {
    // Log the structure of _registeredTools to understand what we're working with
    console.log('Debug: _registeredTools type:', typeof (server as any)._registeredTools);
    
    if (typeof (server as any)._registeredTools === 'object') {
      // Log the keys and structure of the first entry
      const keys = Object.keys((server as any)._registeredTools);
      console.log('Debug: _registeredTools keys:', keys);
      
      if (keys.length > 0) {
        const firstKey = keys[0];
        const firstTool = (server as any)._registeredTools[firstKey];
        console.log(`Debug: First tool (${firstKey}) structure:`, JSON.stringify(firstTool, null, 2));
        
        // Log all available properties on the first tool
        console.log(`Debug: First tool properties:`, Object.keys(firstTool));
        
        // If the first tool has a 'callback' property, log that too
        if (firstTool.callback) {
          console.log('Debug: Tool has callback function');
        }
        
        // Check if the tool has parameters and log its structure
        if (firstTool.parameters) {
          console.log('Debug: Parameters structure:', Object.keys(firstTool.parameters));
          console.log('Debug: Parameters stringified:', JSON.stringify(firstTool.parameters, null, 2));
        }
      }
    }
  }
  
  // Now try to extract the actual tools using the original approach first
  let registeredTools: any[] = [];
  
  // Try to get tools directly from _registeredTools
  try {
    if ((server as any)._registeredTools) {
      const toolsObj = (server as any)._registeredTools;
      if (typeof toolsObj === 'object') {
        registeredTools = Object.entries(toolsObj).map(([name, tool]: [string, any]) => {
          console.log(`Processing tool: ${name}`);
          
          // Attempt to extract parameters from the tool's structure
          let properties = {};
          let required: string[] = [];
          
          if (tool.parameters) {
            // Log the raw parameters to see what we're working with
            console.log(`Parameters for ${name}:`, tool.parameters);
            
            // Try different possible structures
            if (tool.parameters.shape) {
              properties = tool.parameters.shape;
            } else if (tool.parameters.properties) {
              properties = tool.parameters.properties;
            }
            
            if (tool.parameters.required && Array.isArray(tool.parameters.required)) {
              required = tool.parameters.required;
            }
          }
          
          return {
            name,
            description: tool.description || '',
            parameters: {
              properties,
              required
            }
          };
        });
      }
    }
  } catch (error) {
    console.error('Error extracting tools:', error);
    registeredTools = [];
  }
  
  // If we failed to extract the tools, log that and use the hardcoded tools
  if (registeredTools.length === 0) {
    console.log('No tools extracted from _registeredTools, using hardcoded tools');
    registeredTools = getHardcodedTools();
  } else {
    console.log(`Successfully extracted ${registeredTools.length} tools from _registeredTools`);
    
    // Check if the parameters are correctly formatted
    const firstTool = registeredTools[0];
    console.log('First extracted tool:', JSON.stringify(firstTool, null, 2));
    
    // Check if the tools have proper parameters
    const hasValidData = registeredTools.every(tool => {
      const hasParameters = !!tool.parameters && typeof tool.parameters === 'object';
      const result = !!tool.name && typeof tool.name === 'string' && hasParameters;
      
      if (!result) {
        console.log(`Invalid tool data for: ${tool.name || 'unnamed tool'}`);
      }
      
      return result;
    });
    
    if (!hasValidData) {
      console.log('Some tools have invalid data, using hardcoded tools');
      registeredTools = getHardcodedTools();
    }
  }
  
  // Response with tools
  res.status(200).send({
    server: SERVER_NAME,
    version: SERVER_VERSION,
    tools: registeredTools,
    endpoints: {
      sse: "/sse",
      messages: "/messages",
      health: "/health",
      tools: "/tools-info"
    },
    stats: {
      activeConnections,
      maxConnections: MAX_CONNECTIONS,
      uptime: process.uptime()
    }
  });
});

// Function to get hardcoded tools
function getHardcodedTools(): any[] {
  return [
    {
      name: "set_api_key",
      description: "Définir la clé API.",
      parameters: {
        properties: {
          apiKey: {
            type: "string", 
            description: "Your Haloscan API key"
          }
        },
        required: ["apiKey"]
      }
    },
    {
      name: "get_user_credit",
      description: "Obtenir les informations de crédit de l'utilisateur.",
      parameters: {
        properties: {},
        required: []
      }
    },
    {
      name: "get_keywords_overview",
      description: "Obtenir un aperçu des mots-clés.",
      parameters: {
        properties: {
          keyword: {
            type: "string",
            description: "Seed keyword"
          },
          requested_data: {
            type: "array",
            items: {
              type: "string"
            },
            description: "Specific data fields to request"
          }
        },
        required: ["keyword", "requested_data"]
      }
    },
    {
      name: "get_keywords_match",
      description: "Obtenir la correspondance des mots-clés.",
      parameters: {
        properties: {
          keyword: {
            type: "string",
            description: "Seed keyword"
          }
        },
        required: ["keyword"]
      }
    }
  ];
}

// Simple health check endpoint
app.get("/health", (req: Request, res: Response): void => {
  res.status(200).send({
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    uptime: process.uptime(),
    activeConnections,
    environment: NODE_ENV
  });
});

// Root redirect to tools-info
app.get("/", (req: Request, res: Response): void => {
  res.redirect("/tools-info");
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction): void => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] Server error:`, err);
  
  res.status(500).send({
    error: "Internal Server Error",
    message: NODE_ENV === "development" ? err.message : "An unexpected error occurred"
  });
});

// Start the server
const server_instance = app.listen(PORT, () => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${SERVER_NAME} v${SERVER_VERSION} running on http://localhost:${PORT}`);
  console.log(`Connect to /sse for SSE transport`);
  console.log(`Authentication ${AUTH_ENABLED ? 'enabled' : 'disabled'}`);
  console.log(`Environment: ${NODE_ENV}`);
  console.log(`Max connections: ${MAX_CONNECTIONS}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  
  server_instance.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
