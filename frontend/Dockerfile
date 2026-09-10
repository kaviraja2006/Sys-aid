# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Install deps first so this layer is cached across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite inlines VITE_* vars at build time, so they must be build args, not
# runtime env vars. Pass them via `docker compose build --build-arg` or the
# `args:` block in docker-compose.yml.
ARG VITE_API_URL=http://localhost:8000
ARG VITE_BACKEND_API_KEY=
ARG VITE_GOOGLE_CLIENT_ID=
ENV VITE_API_URL=$VITE_API_URL \
    VITE_BACKEND_API_KEY=$VITE_BACKEND_API_KEY \
    VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

RUN npm run build

# ── Serve stage ──────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:80 || exit 1

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
