# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# Si tu enlèves package-lock.json du repo, garde npm install :
RUN npm install

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN chmod +x node_modules/.bin/tsc || true
RUN npm run build

# ---------- runtime ----------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

COPY --from=build /app/build ./build
COPY package*.json ./
RUN npm install --omit=dev

CMD ["node", "build/http-server.js"]
