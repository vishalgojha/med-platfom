CREATE TABLE IF NOT EXISTS doctors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  specialty TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  name TEXT NOT NULL,
  dob TEXT,
  phone TEXT,
  meds TEXT,
  allergies TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  transcript_hash TEXT NOT NULL UNIQUE,
  subjective TEXT,
  objective TEXT,
  assessment TEXT,
  plan TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prior_auths (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  procedure_code TEXT NOT NULL,
  diagnosis_codes TEXT NOT NULL,
  insurer_id TEXT NOT NULL,
  clinical_justification TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  trigger TEXT NOT NULL,
  body TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'sms',
  scheduled_at TEXT NOT NULL,
  sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  delivery_status TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  provider_message_id TEXT,
  delivered_at TEXT,
  failed_at TEXT,
  provider_error_code TEXT,
  provider_error_message TEXT,
  dead_lettered_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (patient_id, trigger, scheduled_at)
);

CREATE TABLE IF NOT EXISTS follow_up_dead_letters (
  id TEXT PRIMARY KEY,
  follow_up_id TEXT NOT NULL REFERENCES follow_ups(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  reason TEXT NOT NULL,
  last_error TEXT,
  retry_count INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_up_provider_events (
  id TEXT PRIMARY KEY,
  follow_up_id TEXT NOT NULL REFERENCES follow_ups(id),
  provider_message_id TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  error_code_norm TEXT NOT NULL DEFAULT '',
  error_message_norm TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (provider_message_id, provider_status, error_code_norm, error_message_norm)
);

CREATE TABLE IF NOT EXISTS replay_log (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  risk TEXT NOT NULL,
  ok INTEGER NOT NULL,
  output TEXT,
  request_id TEXT,
  actor_id TEXT,
  executed_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_tenants (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  provider TEXT NOT NULL DEFAULT 'whatsapp_web',
  whatsapp_number TEXT NOT NULL UNIQUE,
  twilio_account_sid TEXT NOT NULL,
  twilio_auth_token_enc TEXT NOT NULL,
  twilio_from_number TEXT NOT NULL,
  anthropic_api_key_enc TEXT NOT NULL,
  ai_model TEXT NOT NULL,
  default_specialty_id TEXT NOT NULL DEFAULT 'family_medicine',
  default_workflow TEXT NOT NULL DEFAULT 'triage_intake',
  default_language TEXT NOT NULL DEFAULT 'en',
  default_doctor_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES wa_tenants(id),
  user_phone TEXT NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  specialty_id TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  last_inbound_message_sid TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_phone)
);

CREATE TABLE IF NOT EXISTS wa_message_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES wa_tenants(id),
  conversation_id TEXT REFERENCES wa_conversations(id),
  direction TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, direction, provider_message_id)
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  user_id TEXT,
  user_phone TEXT,
  user_name TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  workflow TEXT NOT NULL DEFAULT 'triage_intake',
  specialty_id TEXT NOT NULL DEFAULT 'family_medicine',
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  patient_id TEXT REFERENCES patients(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id),
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  message_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id),
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_idempotency_keys (
  idempotency_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  session_id TEXT REFERENCES chat_sessions(id),
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (idempotency_key, channel, tenant_id)
);

CREATE TABLE IF NOT EXISTS skill_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES chat_sessions(id),
  skill_name TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  ok INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_patient_created ON notes(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prior_auths_patient_status ON prior_auths(patient_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_follow_ups_status_schedule ON follow_ups(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_follow_ups_retry_count ON follow_ups(status, retry_count, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_follow_ups_provider_message_id ON follow_ups(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_delivery_status ON follow_ups(delivery_status);
CREATE INDEX IF NOT EXISTS idx_follow_up_dead_letters_created ON follow_up_dead_letters(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follow_up_provider_events_received ON follow_up_provider_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_replay_executed ON replay_log(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_tenants_status ON wa_tenants(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_tenant_updated ON wa_conversations(tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_message_events_tenant_created ON wa_message_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_tenant_updated ON chat_sessions(tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_events_session_created ON chat_events(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_idempotency_created ON chat_idempotency_keys(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_runs_created ON skill_runs(created_at DESC);
