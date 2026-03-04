FROM node:20-slim AS builder

WORKDIR /workspace

COPY . .
RUN npm ci

RUN npm run build -w @med-platform/clinical-specialties \
  && npm run build -w @med-platform/agent-orchestrator \
  && npm run build -w doctor-agent

FROM node:20-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/app/services/doctor-agent/data/doctor-agent.db

COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/package.json ./package.json

COPY --from=builder /workspace/services/doctor-agent/package.json ./services/doctor-agent/package.json
COPY --from=builder /workspace/services/doctor-agent/dist ./services/doctor-agent/dist
COPY --from=builder /workspace/services/doctor-agent/src-ts/ai/prompts ./services/doctor-agent/dist/ai/prompts
COPY --from=builder /workspace/services/doctor-agent/src-ts/db/schema.sql ./services/doctor-agent/dist/db/schema.sql

COPY --from=builder /workspace/packages/agent-orchestrator/package.json ./packages/agent-orchestrator/package.json
COPY --from=builder /workspace/packages/agent-orchestrator/dist ./packages/agent-orchestrator/dist
COPY --from=builder /workspace/packages/clinical-specialties/package.json ./packages/clinical-specialties/package.json
COPY --from=builder /workspace/packages/clinical-specialties/dist ./packages/clinical-specialties/dist

RUN mkdir -p /app/services/doctor-agent/data

WORKDIR /app/services/doctor-agent

EXPOSE 3001

CMD ["node", "dist/index.js", "serve"]
