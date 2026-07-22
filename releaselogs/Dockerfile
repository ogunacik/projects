# Dockerfile
# Stage 1: Build Application
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Serve compiled code
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install minimal production-only dependencies from the same lockfile used by the builder.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Bring over pre-compiled client assets and the escompiled server bundle
COPY --from=builder /app/dist ./dist

EXPOSE 3000

# Start compiled CommonJS server safely
CMD ["node", "dist/server.cjs"]
