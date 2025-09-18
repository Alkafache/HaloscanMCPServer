# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# Utiliser install (pas ci) pour ne pas figer l'ancien lock
RUN npm install --no-audit --no-fund

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Parano: au cas où tsc n'ait pas le bit exécutable sur Alpine
RUN chmod +x node_modules/.bin/tsc || true
# Compile TypeScript
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

# Installer uniquement les deps de prod (sans figer le vieux lock)
RUN npm install --omit=dev --no-audit --no-fund

# Démarrage du serveur HTTP/SSE MCP
CMD ["node", "build/http-server.js"]
