# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Parano: au cas où tsc n'ait pas le bit exécutable sur Alpine
RUN chmod +x node_modules/.bin/tsc || true
# Compile TypeScript (ton package.json appelle npx tsc)
RUN npm run build

# ---------- runtime ----------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# On ne copie que le build et package.json pour une image plus légère
COPY --from=build /app/build ./build
COPY package*.json ./
# Installe uniquement les deps de prod
RUN npm ci --omit=dev

# (Optionnel) Healthcheck si tu as un /health dans http-server
# HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- 127.0.0.1:3000/health || exit 1

# Démarrage du serveur HTTP/SSE MCP
CMD ["node", "build/http-server.js"]
