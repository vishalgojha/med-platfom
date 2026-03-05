# doctor-agent

`doctor-agent` is a TypeScript CLI + API server for physician workflows:
- Ambient Scribe (transcript -> SOAP note)
- Prior Auth draft automation
- Patient follow-up scheduling/messaging
- Clinical decision support alerts

## Requirements
- Node.js 18+
- npm

## Install
```bash
npm install
cp .env.example .env
npm run ui:install
```

## Environment
Configure `.env`:
- `ANTHROPIC_API_KEY`, `AI_MODEL`
- `TENANT_SECRET_KEY`, `AGENTIC_WHATSAPP_DRY_RUN`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (only required for `provider=twilio`)
- `TWILIO_WEBHOOK_VALIDATE`, `TWILIO_WEBHOOK_AUTH_TOKEN`, `PUBLIC_BASE_URL`
- `TWILIO_WEBHOOK_MAX_BODY_BYTES`, `TWILIO_WEBHOOK_BODY_TIMEOUT_MS`, `TWILIO_WEBHOOK_DEDUPE_TTL_MS`
- `PORT`, `DB_PATH`, `DRY_RUN`, `API_TOKEN`
- `API_TOKEN_READ`, `API_TOKEN_WRITE`, `API_TOKEN_ADMIN`
- `API_RATE_LIMIT_WINDOW_MS`, `API_RATE_LIMIT_MAX`
- `REPLAY_RETENTION_DAYS`, `REPLAY_RETENTION_INTERVAL_MS`

Set `DRY_RUN=true` to disable outbound sends globally.
Set `API_TOKEN` to protect `/api/*` routes with a single admin token.
For scoped access, set `API_TOKEN_READ`, `API_TOKEN_WRITE`, and `API_TOKEN_ADMIN` and use matching bearer tokens.
Replay retention pruning runs automatically in server mode using the retention env vars.

## Initialize
```bash
npm run init
```
Creates SQLite DB, runs migrations, and prints health checks.

## CLI Examples
```bash
# Health
npm run start -- health
npm run start -- doctor health

# Doctor profiles
npm run start -- doctor add --name "Dr. Ellis" --specialty primary_care
npm run start -- doctor list
npm run start -- specialty-list --setting clinic --language hi
npm run start -- agent-profile --languages en,hi

# Fast local demo seed
npm run start -- seed

# Patient management
npm run start -- patient add --doctor-id d_123 --name "Jane Doe" --dob 1980-01-01 --phone +15551234567
npm run start -- patient list

# Ambient scribe
npm run start -- scribe --transcript "Patient reports fatigue..." --patient-id p_123 --doctor-id d_123

# Prior auth
npm run start -- prior-auth --patient-id p_123 --doctor-id d_123 --procedure 99213 --diagnosis Z00.00 --insurer BCBS
npm run start -- prior-auth --patient-id p_123 --doctor-id d_123 --procedure 99213 --diagnosis Z00.00 --insurer BCBS --submit --confirm
npm run start -- prior-auth-list --patient-id p_123
npm run start -- prior-auth-status --id pa_123 --status submitted --confirm

# Follow-up (dry-run)
npm run start -- follow-up --patient-id p_123 --doctor-id d_123 --trigger lab_result --dry-run

# Decision support
npm run start -- decide --patient-id p_123 --query "Is it safe to add metformin?"

# Replay log
npm run start -- replay list
npm run start -- replay prune --days 30 --confirm

# Follow-up operations
npm run start -- follow-up-list --status scheduled
npm run start -- follow-up-list --status dead_letter
npm run start -- follow-up-dead-letter-list --limit 50
npm run start -- follow-up-dead-letter-requeue --id fdl_123
npm run start -- follow-up-retry --id fu_123 --confirm --dry-run
npm run start -- follow-up-retry-bulk --confirm --dry-run --limit 25
npm run start -- follow-up-dispatch --confirm --dry-run
npm run start -- follow-up-queue-pending-list --limit 50
npm run start -- follow-up-queue-pending-show --id fu_123
npm run start -- follow-up-queue-pending-cancel --id fu_123 --dry-run
npm run start -- follow-up-queue-pending-cancel --id fu_123 --confirm
npm run start -- follow-up-queue-pending-cancel-bulk --ids fu_123,fu_456 --dry-run
npm run start -- follow-up-queue-pending-cancel-bulk --ids fu_123,fu_456 --confirm
npm run start -- follow-up-queue-failed-list --limit 50
npm run start -- follow-up-queue-failed-show --id fu_123
npm run start -- follow-up-queue-failed-requeue --id fu_123 --reset-retry-count
npm run start -- follow-up-queue-failed-retry --id fu_123 --dry-run
npm run start -- follow-up-queue-failed-retry --id fu_123 --confirm

# Ops
npm run start -- ops-metrics
```

## API
Start server:
```bash
npm run serve
```

Endpoints:
- `GET /api/doctors`
- `POST /api/doctors`
- `GET /api/doctors/:id`
- `GET /api/specialties`
- `GET /api/agents/deployment-profile`
- `POST /api/agent-router/execute`
- `POST /api/v1/chat/inbound`
- `GET /api/v1/chat/sessions/:id/messages`
- `GET /api/v1/chat/sessions/:id/events`
- `GET /api/v1/skills`
- `POST /api/v1/skills/execute`
- `GET /api/patients`
- `POST /api/patients`
- `GET /api/patients/:id`
- `POST /api/scribe`
- `POST /api/prior-auth`
- `GET /api/prior-auth`
- `GET /api/prior-auth/:id`
- `PATCH /api/prior-auth/:id/status`
- `POST /api/follow-up`
- `GET /api/follow-up`
- `GET /api/follow-up/dead-letter`
- `POST /api/follow-up/dead-letter/:id/requeue`
- `POST /api/follow-up/:id/retry`
- `POST /api/follow-up/retry-failed-bulk`
- `POST /api/follow-up/dispatch`
- `GET /api/follow-up/queue/pending`
- `GET /api/follow-up/queue/pending/:id`
- `DELETE /api/follow-up/queue/pending/:id`
- `POST /api/follow-up/queue/pending/cancel-bulk`
- `GET /api/follow-up/queue/failed`
- `GET /api/follow-up/queue/failed/:id`
- `POST /api/follow-up/queue/failed/:id/requeue`
- `POST /api/follow-up/queue/failed/:id/retry`
- `GET /api/ops/metrics`
- `POST /api/decide`
- `POST /webhooks/twilio/status`
- `GET /api/wa/tenants`
- `GET /api/wa/tenants/:id`
- `POST /api/wa/tenants`
- `POST /api/wa/tenants/:id/connect`
- `POST /api/wa/tenants/:id/disconnect`
- `GET /api/wa/workers`
- `GET /api/wa/tenants/:id/web-session`
- `POST /api/wa/tenants/:id/web-session/start`
- `POST /webhooks/whatsapp/twilio/inbound`
- `GET /api/replay`
- `GET /api/replay/:id`
- `POST /api/replay/prune`

Example payloads:
```json
{ "transcript": "Patient reports cough", "patientId": "p_123", "doctorId": "d_123" }
```
```json
{ "patientId": "p_123", "doctorId": "d_123", "procedureCode": "99213", "diagnosisCodes": ["Z00.00"], "insurerId": "BCBS" }
```
```json
{ "patientId": "p_123", "doctorId": "d_123", "trigger": "lab_result", "dryRun": true }
```
```json
{ "patientId": "p_123", "query": "Is it safe to add metformin given current meds?" }
```
```json
{
  "workflow": "consultation_documentation",
  "specialtyId": "family_medicine",
  "doctorId": "d_123",
  "patientId": "p_123",
  "payload": {
    "transcript": "Patient reports mild cough for two days",
    "query": "Any immediate red flags?"
  }
}
```
```json
{
  "channel": "webchat",
  "tenantId": "clinic_one",
  "user": { "id": "u_123", "name": "Rhea", "language": "en" },
  "message": { "id": "m_123", "text": "Patient has fever for two days" },
  "routing": { "workflow": "triage_intake", "specialtyId": "family_medicine" },
  "options": { "stream": true, "dryRun": false, "confirm": true }
}
```
If `API_TOKEN` is configured, include:
```http
Authorization: Bearer <API_TOKEN>
```
Optional trace headers:
```http
x-request-id: your-request-id
x-actor-id: doctor-or-service-id
```
For non-webchat channels (`whatsapp_twilio`, `whatsapp_web`) include:
```http
x-idempotency-key: your-deduplication-key
```

Browser stream endpoint:
```http
GET /api/v1/chat/sessions/:id/events
Accept: text/event-stream
```

Twilio status callback:
```http
POST /webhooks/twilio/status
Content-Type: application/x-www-form-urlencoded
```
Expected fields include `MessageSid`, `MessageStatus`, optional `ErrorCode`, and `ErrorMessage`.
Duplicate delivery events are deduplicated; out-of-order regressions are ignored by monotonic guards.

Agentic WhatsApp inbound callback:
```http
POST /webhooks/whatsapp/twilio/inbound
Content-Type: application/x-www-form-urlencoded
```
Expected fields include `MessageSid`, `From`, `To`, `Body`, and optional `ProfileName`.
Webhook processing is tenant-aware by destination number (`To`), supports command routing like `Connect me with cardiology`,
stores conversation context, and responds with tenant-specific credentials.

Tenant onboarding payload example (Twilio transport):
```json
{
  "displayName": "Clinic One",
  "provider": "twilio",
  "whatsappNumber": "+919900001111",
  "twilioFromNumber": "+919900001111",
  "twilioAccountSid": "AC_xxx",
  "twilioAuthToken": "twilio_auth_token",
  "anthropicApiKey": "sk-ant-xxx",
  "defaultSpecialtyId": "family_medicine",
  "defaultWorkflow": "triage_intake",
  "defaultLanguage": "en"
}
```

Tenant onboarding payload example (OpenClaw-style WhatsApp Web transport, default):
```json
{
  "displayName": "Clinic Web",
  "provider": "whatsapp_web",
  "whatsappNumber": "+919900001112",
  "anthropicApiKey": "sk-ant-xxx",
  "defaultSpecialtyId": "family_medicine",
  "defaultWorkflow": "triage_intake",
  "defaultLanguage": "en"
}
```

Start WhatsApp Web session and fetch QR:
```http
POST /api/wa/tenants/:id/web-session/start
GET /api/wa/tenants/:id/web-session
```
The QR code is returned in `data.session.qrCode` until linked. Session auth is stored under `data/wa-auth/<tenantId>/`.

Readiness endpoint:
- `GET /health/ready` (includes DB/queue snapshot)

## React UI
Run backend + UI in parallel:
```bash
npm run serve
npm run ui:dev
```

Build both:
```bash
npm run build:all
```

When `ui/dist` exists, `npm run serve` also serves the React app from `/`.

## Deployment
Docker:
```bash
docker build -t doctor-agent:latest .
docker run --rm -p 3001:3001 --env-file .env -v $PWD/data:/app/data doctor-agent:latest
```

Docker Compose:
```bash
docker compose up -d --build
docker compose ps
```

## Testing
```bash
npm test
npm run typecheck
```

Tests use stub AI clients; no real model calls are made.

## Safety Notes
- Logger redacts `name`, `dob`, `phone`, and related fields.
- Decision support responses always include a disclaimer object.
- HIGH-risk actions require `--confirm` / `confirm: true`.
- Follow-up idempotency is enforced by `(patient_id, trigger, scheduled_at)`.
- Retries that exceed the max threshold are moved to dead-letter for manual triage.
- Outbound follow-up sends use a durable on-disk queue with startup recovery.
- Twilio webhook status callbacks are body-limited/time-bounded and persistently deduplicated.
