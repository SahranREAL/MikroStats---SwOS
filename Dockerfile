# MikroStats - MikroTik SwOS monitoring dashboard
# Node 26 (Lithium) LTS. Multi-stage so the runtime image carries no compiler
# and no dev dependencies.
FROM node:26-alpine AS deps
WORKDIR /app
# --omit=dev: only express ships to the runtime image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# Non-root: the app only ever writes to /app/data and /app/logs.
RUN addgroup -S mikrostats && adduser -S -G mikrostats mikrostats

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY config.js server.js ./
COPY lib ./lib
COPY public ./public
COPY deploy ./deploy

RUN mkdir -p data logs && chown -R mikrostats:mikrostats data logs
USER mikrostats

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
