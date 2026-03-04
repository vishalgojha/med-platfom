# Production Deployment Pack

This repository now includes a production Docker stack for:

- `doctor-agent` backend
- `medisuite` frontend
- `mediscribe` frontend
- `medipal` frontend
- `gluco-vital` frontend

The stack is managed from root `docker-compose.yml`.

## 1) Prepare environment files

From repo root, create deploy env files from templates:

```bash
cp deploy/env/doctor-agent.env.example deploy/env/doctor-agent.env
cp deploy/env/medisuite.env.example deploy/env/medisuite.env
cp deploy/env/mediscribe.env.example deploy/env/mediscribe.env
cp deploy/env/medipal.env.example deploy/env/medipal.env
cp deploy/env/gluco-vital.env.example deploy/env/gluco-vital.env
```

PowerShell:

```powershell
Copy-Item deploy/env/doctor-agent.env.example deploy/env/doctor-agent.env
Copy-Item deploy/env/medisuite.env.example deploy/env/medisuite.env
Copy-Item deploy/env/mediscribe.env.example deploy/env/mediscribe.env
Copy-Item deploy/env/medipal.env.example deploy/env/medipal.env
Copy-Item deploy/env/gluco-vital.env.example deploy/env/gluco-vital.env
```

Edit each `.env` file before first deployment.

For self-hosted pilots without full identity setup:

- keep `VITE_REQUIRE_AUTH=false` in each frontend env file
- keep `VITE_ENABLE_VISUAL_EDIT_AGENT=false` to disable editor scaffolding

## 2) Launch the stack

```bash
docker compose up -d --build
docker compose ps
```

## 3) Access ports

- `http://localhost:4101` -> Medisuite
- `http://localhost:4102` -> Mediscribe
- `http://localhost:4103` -> Medipal
- `http://localhost:4104` -> Gluco Vital

Backend readiness:

- `http://localhost:4101/health/ready`
- `http://localhost:4102/health/ready`
- `http://localhost:4103/health/ready`
- `http://localhost:4104/health/ready`

Each frontend Nginx listener proxies `/api/*` and `/health/*` to `doctor-agent`.

## 4) Operations

View logs:

```bash
docker compose logs -f doctor-agent
docker compose logs -f clinical-gateway
```

Restart services:

```bash
docker compose restart doctor-agent
docker compose restart clinical-gateway
```

Stop stack:

```bash
docker compose down
```

Stop and remove DB volume:

```bash
docker compose down -v
```

## 5) Hospital and clinic hardening checklist

- Set strong `API_TOKEN`/`API_TOKEN_*` in `deploy/env/doctor-agent.env`.
- Set `VITE_REQUIRE_AUTH=true` only after login/identity endpoints are fully configured.
- Keep `DRY_RUN=true` until live messaging approvals are complete.
- Configure `TWILIO_*` and set `DRY_RUN=false` only after validation.
- Put TLS termination in front of ports `4101-4104` (load balancer or ingress).
- Restrict backend access to trusted networks (VPN/private subnet where possible).
- Attach centralized logs and metrics for audit/compliance.
