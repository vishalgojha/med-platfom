import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./client.js";

function tableExists(table: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

export function runMigrations(): void {
  const db = getDb();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.resolve(here, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");

  // Legacy DBs can miss follow_ups.retry_count while schema.sql tries to build
  // an index on that column. Backfill required columns before applying schema.
  if (tableExists("follow_ups")) {
    const followUpColumnsPre = db
      .prepare("PRAGMA table_info(follow_ups)")
      .all() as Array<{ name: string }>;
    const followUpNamesPre = new Set(followUpColumnsPre.map((c) => c.name));
    if (!followUpNamesPre.has("retry_count")) {
      db.exec("ALTER TABLE follow_ups ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!followUpNamesPre.has("last_error")) {
      db.exec("ALTER TABLE follow_ups ADD COLUMN last_error TEXT");
    }
    if (!followUpNamesPre.has("provider_message_id")) {
      db.exec("ALTER TABLE follow_ups ADD COLUMN provider_message_id TEXT");
    }
    if (!followUpNamesPre.has("delivery_status")) {
      db.exec("ALTER TABLE follow_ups ADD COLUMN delivery_status TEXT");
    }
    if (!followUpNamesPre.has("delivered_at")) {
      db.exec("ALTER TABLE follow_ups ADD COLUMN delivered_at TEXT");
    }
    if (!followUpNamesPre.has("failed_at")) {
      db.exec("ALTER TABLE follow_ups ADD COLUMN failed_at TEXT");
    }
    if (!followUpNamesPre.has("provider_error_code")) {
      db.exec("ALTER TABLE follow_ups ADD COLUMN provider_error_code TEXT");
    }
    if (!followUpNamesPre.has("provider_error_message")) {
      db.exec("ALTER TABLE follow_ups ADD COLUMN provider_error_message TEXT");
    }
    if (!followUpNamesPre.has("dead_lettered_at")) {
      db.exec("ALTER TABLE follow_ups ADD COLUMN dead_lettered_at TEXT");
    }
  }

  db.exec(sql);

  const replayColumns = db
    .prepare("PRAGMA table_info(replay_log)")
    .all() as Array<{ name: string }>;
  const names = new Set(replayColumns.map((c) => c.name));
  if (!names.has("request_id")) {
    db.exec("ALTER TABLE replay_log ADD COLUMN request_id TEXT");
  }
  if (!names.has("actor_id")) {
    db.exec("ALTER TABLE replay_log ADD COLUMN actor_id TEXT");
  }

  const followUpColumns = db
    .prepare("PRAGMA table_info(follow_ups)")
    .all() as Array<{ name: string }>;
  const followUpNames = new Set(followUpColumns.map((c) => c.name));
  if (!followUpNames.has("retry_count")) {
    db.exec("ALTER TABLE follow_ups ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!followUpNames.has("last_error")) {
    db.exec("ALTER TABLE follow_ups ADD COLUMN last_error TEXT");
  }
  if (!followUpNames.has("provider_message_id")) {
    db.exec("ALTER TABLE follow_ups ADD COLUMN provider_message_id TEXT");
  }
  if (!followUpNames.has("delivery_status")) {
    db.exec("ALTER TABLE follow_ups ADD COLUMN delivery_status TEXT");
  }
  if (!followUpNames.has("delivered_at")) {
    db.exec("ALTER TABLE follow_ups ADD COLUMN delivered_at TEXT");
  }
  if (!followUpNames.has("failed_at")) {
    db.exec("ALTER TABLE follow_ups ADD COLUMN failed_at TEXT");
  }
  if (!followUpNames.has("provider_error_code")) {
    db.exec("ALTER TABLE follow_ups ADD COLUMN provider_error_code TEXT");
  }
  if (!followUpNames.has("provider_error_message")) {
    db.exec("ALTER TABLE follow_ups ADD COLUMN provider_error_message TEXT");
  }
  if (!followUpNames.has("dead_lettered_at")) {
    db.exec("ALTER TABLE follow_ups ADD COLUMN dead_lettered_at TEXT");
  }

  db.exec(
    `CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      window_start_ms INTEGER NOT NULL,
      count INTEGER NOT NULL
    )`
  );

  db.exec(
    `CREATE TABLE IF NOT EXISTS follow_up_dead_letters (
      id TEXT PRIMARY KEY,
      follow_up_id TEXT NOT NULL REFERENCES follow_ups(id),
      patient_id TEXT NOT NULL REFERENCES patients(id),
      doctor_id TEXT NOT NULL REFERENCES doctors(id),
      reason TEXT NOT NULL,
      last_error TEXT,
      retry_count INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  );

  db.exec(
    `CREATE TABLE IF NOT EXISTS follow_up_provider_events (
      id TEXT PRIMARY KEY,
      follow_up_id TEXT NOT NULL REFERENCES follow_ups(id),
      provider_message_id TEXT NOT NULL,
      provider_status TEXT NOT NULL,
      error_code_norm TEXT NOT NULL DEFAULT '',
      error_message_norm TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL,
      UNIQUE (provider_message_id, provider_status, error_code_norm, error_message_norm)
    )`
  );

  db.exec(
    `CREATE TABLE IF NOT EXISTS wa_tenants (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'connected',
      provider TEXT NOT NULL DEFAULT 'whatsapp_web',
      whatsapp_number TEXT NOT NULL UNIQUE,
      twilio_account_sid TEXT NOT NULL,
      twilio_auth_token_enc TEXT NOT NULL,
      twilio_from_number TEXT NOT NULL DEFAULT '',
      anthropic_api_key_enc TEXT NOT NULL,
      ai_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
      default_specialty_id TEXT NOT NULL DEFAULT 'family_medicine',
      default_workflow TEXT NOT NULL DEFAULT 'triage_intake',
      default_language TEXT NOT NULL DEFAULT 'en',
      default_doctor_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS wa_conversations (
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
    )`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS wa_message_events (
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
    )`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS chat_sessions (
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
    )`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id),
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      message_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS chat_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id),
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS chat_idempotency_keys (
      idempotency_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      session_id TEXT REFERENCES chat_sessions(id),
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, channel, tenant_id)
    )`
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS skill_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES chat_sessions(id),
      skill_name TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      ok INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`
  );

  const waTenantColumns = db
    .prepare("PRAGMA table_info(wa_tenants)")
    .all() as Array<{ name: string }>;
  const waTenantNames = new Set(waTenantColumns.map((c) => c.name));
  if (!waTenantNames.has("twilio_from_number")) {
    db.exec("ALTER TABLE wa_tenants ADD COLUMN twilio_from_number TEXT NOT NULL DEFAULT ''");
  }
  if (!waTenantNames.has("ai_model")) {
    db.exec("ALTER TABLE wa_tenants ADD COLUMN ai_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5'");
  }
  if (!waTenantNames.has("default_specialty_id")) {
    db.exec("ALTER TABLE wa_tenants ADD COLUMN default_specialty_id TEXT NOT NULL DEFAULT 'family_medicine'");
  }
  if (!waTenantNames.has("default_workflow")) {
    db.exec("ALTER TABLE wa_tenants ADD COLUMN default_workflow TEXT NOT NULL DEFAULT 'triage_intake'");
  }
  if (!waTenantNames.has("default_language")) {
    db.exec("ALTER TABLE wa_tenants ADD COLUMN default_language TEXT NOT NULL DEFAULT 'en'");
  }
  if (!waTenantNames.has("default_doctor_id")) {
    db.exec("ALTER TABLE wa_tenants ADD COLUMN default_doctor_id TEXT");
  }
}
