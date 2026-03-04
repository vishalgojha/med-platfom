# Med Platform (Monorepo)

Unified TypeScript monorepo for India-first hospital and clinic deployment:

- `apps/medisuite`
- `apps/mediscribe`
- `apps/medipal`
- `apps/gluco-vital`
- `packages/clinical-specialties` (all-specialty catalog with multilingual labels)
- `packages/agent-orchestrator` (multi-agent routing and staffing defaults)
- `services/doctor-agent` (backend agent runtime)

## Prerequisites

- Node.js 20+
- npm 10+

## Install

```bash
npm install
```

## Run Apps

```bash
npm run dev:medisuite
npm run dev:mediscribe
npm run dev:medipal
npm run dev:gluco-vital
npm run dev:doctor-agent
```

Or run all:

```bash
npm run dev:all
```

Run full stack including backend agent:

```bash
npm run dev:stack
```

## Validation

```bash
npm run typecheck
npm run build
```

## Production Deployment (Docker)

The monorepo includes a production deployment pack:

- root `docker-compose.yml`
- `deploy/docker/doctor-agent.Dockerfile`
- `deploy/docker/frontend-gateway.Dockerfile`
- `deploy/nginx/frontend-gateway.conf`
- per-service env templates under `deploy/env/*.env.example`

Quick start:

```bash
cp deploy/env/doctor-agent.env.example deploy/env/doctor-agent.env
cp deploy/env/medisuite.env.example deploy/env/medisuite.env
cp deploy/env/mediscribe.env.example deploy/env/mediscribe.env
cp deploy/env/medipal.env.example deploy/env/medipal.env
cp deploy/env/gluco-vital.env.example deploy/env/gluco-vital.env
docker compose up -d --build
```

For initial local/hospital pilot without full SSO:

- keep `VITE_REQUIRE_AUTH=false` in frontend env files
- keep `VITE_ENABLE_VISUAL_EDIT_AGENT=false`

Frontend ports:

- `4101` -> Medisuite
- `4102` -> Mediscribe
- `4103` -> Medipal
- `4104` -> Gluco Vital

Full deployment runbook: `docs/deployment-production.md`.

## India-First Specialty Coverage

`packages/clinical-specialties` contains:

- canonical specialty IDs for OPD/IPD workflows
- multilingual labels (`en`, `hi`)
- care setting coverage (`clinic`, `hospital`)
- deployment priority for phased rollout

`packages/agent-orchestrator` provides:

- multi-agent role definitions
- specialty-to-agent capability map
- language-aware routing defaults for English and Hindi

See deployment details in `docs/india-specialty-deployment.md`.
