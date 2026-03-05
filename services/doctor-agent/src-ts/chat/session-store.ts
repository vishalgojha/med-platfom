import { createHash } from "node:crypto";
import { getDb } from "../db/client.js";
import { makeId, nowIso, safeJsonParse } from "../utils.js";

export type ChatChannel = "webchat" | "whatsapp_twilio" | "whatsapp_web";
export type ChatMessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatSession {
  id: string;
  tenantId: string;
  channel: ChatChannel;
  userId?: string;
  userPhone?: string;
  userName?: string;
  language: "en" | "hi";
  workflow: string;
  specialtyId: string;
  doctorId: string;
  patientId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatMessageRole;
  text: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ChatEvent {
  id: string;
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface IdempotencyRecord {
  idempotencyKey: string;
  channel: Exclude<ChatChannel, "webchat">;
  tenantId: string;
  sessionId?: string;
  requestHash: string;
  response: Record<string, unknown>;
  createdAt: string;
}

interface ChatSessionRow {
  id: string;
  tenant_id: string;
  channel: ChatChannel;
  user_id: string | null;
  user_phone: string | null;
  user_name: string | null;
  language: "en" | "hi";
  workflow: string;
  specialty_id: string;
  doctor_id: string;
  patient_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatMessageRow {
  id: string;
  session_id: string;
  role: ChatMessageRole;
  text: string;
  message_json: string;
  created_at: string;
}

interface ChatEventRow {
  id: string;
  session_id: string;
  event_type: string;
  event_json: string;
  created_at: string;
}

interface IdempotencyRow {
  idempotency_key: string;
  channel: Exclude<ChatChannel, "webchat">;
  tenant_id: string;
  session_id: string | null;
  request_hash: string;
  response_json: string;
  created_at: string;
}

function mapSession(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    channel: row.channel,
    userId: row.user_id ?? undefined,
    userPhone: row.user_phone ?? undefined,
    userName: row.user_name ?? undefined,
    language: row.language,
    workflow: row.workflow,
    specialtyId: row.specialty_id,
    doctorId: row.doctor_id,
    patientId: row.patient_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    text: row.text,
    payload: safeJsonParse<Record<string, unknown>>(row.message_json, {}),
    createdAt: row.created_at
  };
}

function mapEvent(row: ChatEventRow): ChatEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type,
    payload: safeJsonParse<Record<string, unknown>>(row.event_json, {}),
    createdAt: row.created_at
  };
}

function mapIdempotency(row: IdempotencyRow): IdempotencyRecord {
  return {
    idempotencyKey: row.idempotency_key,
    channel: row.channel,
    tenantId: row.tenant_id,
    sessionId: row.session_id ?? undefined,
    requestHash: row.request_hash,
    response: safeJsonParse<Record<string, unknown>>(row.response_json, {}),
    createdAt: row.created_at
  };
}

export function hashRequestPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function getChatSessionById(id: string): ChatSession | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as ChatSessionRow | undefined;
  return row ? mapSession(row) : null;
}

export function createChatSession(input: {
  tenantId: string;
  channel: ChatChannel;
  userId?: string;
  userPhone?: string;
  userName?: string;
  language: "en" | "hi";
  workflow: string;
  specialtyId: string;
  doctorId: string;
  patientId?: string;
  sessionId?: string;
}): ChatSession {
  const db = getDb();
  const now = nowIso();
  const id = input.sessionId ?? makeId("cs");
  db.prepare(
    `INSERT INTO chat_sessions (
      id,
      tenant_id,
      channel,
      user_id,
      user_phone,
      user_name,
      language,
      workflow,
      specialty_id,
      doctor_id,
      patient_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.tenantId,
    input.channel,
    input.userId ?? null,
    input.userPhone ?? null,
    input.userName ?? null,
    input.language,
    input.workflow,
    input.specialtyId,
    input.doctorId,
    input.patientId ?? null,
    now,
    now
  );
  const created = getChatSessionById(id);
  if (!created) {
    throw new Error("Failed to read chat session after insert");
  }
  return created;
}

export function updateChatSession(input: {
  sessionId: string;
  userId?: string;
  userPhone?: string;
  userName?: string;
  language?: "en" | "hi";
  workflow?: string;
  specialtyId?: string;
  doctorId?: string;
  patientId?: string;
}): ChatSession | null {
  const current = getChatSessionById(input.sessionId);
  if (!current) {
    return null;
  }
  const db = getDb();
  const next = {
    userId: input.userId ?? current.userId,
    userPhone: input.userPhone ?? current.userPhone,
    userName: input.userName ?? current.userName,
    language: input.language ?? current.language,
    workflow: input.workflow ?? current.workflow,
    specialtyId: input.specialtyId ?? current.specialtyId,
    doctorId: input.doctorId ?? current.doctorId,
    patientId: input.patientId ?? current.patientId
  };
  db.prepare(
    `UPDATE chat_sessions
     SET user_id = ?,
         user_phone = ?,
         user_name = ?,
         language = ?,
         workflow = ?,
         specialty_id = ?,
         doctor_id = ?,
         patient_id = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    next.userId ?? null,
    next.userPhone ?? null,
    next.userName ?? null,
    next.language,
    next.workflow,
    next.specialtyId,
    next.doctorId,
    next.patientId ?? null,
    nowIso(),
    input.sessionId
  );
  return getChatSessionById(input.sessionId);
}

export function upsertChatSession(input: {
  sessionId?: string;
  tenantId: string;
  channel: ChatChannel;
  userId?: string;
  userPhone?: string;
  userName?: string;
  language: "en" | "hi";
  workflow: string;
  specialtyId: string;
  doctorId: string;
  patientId?: string;
}): ChatSession {
  if (input.sessionId) {
    const existing = getChatSessionById(input.sessionId);
    if (existing) {
      const updated = updateChatSession({
        sessionId: existing.id,
        userId: input.userId,
        userPhone: input.userPhone,
        userName: input.userName,
        language: input.language,
        workflow: input.workflow,
        specialtyId: input.specialtyId,
        doctorId: input.doctorId,
        patientId: input.patientId
      });
      if (!updated) {
        throw new Error("Failed to update chat session");
      }
      return updated;
    }
  }
  return createChatSession(input);
}

export function appendChatMessage(input: {
  sessionId: string;
  role: ChatMessageRole;
  text: string;
  payload?: Record<string, unknown>;
}): ChatMessage {
  const db = getDb();
  const id = makeId("cmsg");
  const createdAt = nowIso();
  const payload = input.payload ?? {};
  db.prepare(
    `INSERT INTO chat_messages (
      id,
      session_id,
      role,
      text,
      message_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, input.sessionId, input.role, input.text, JSON.stringify(payload), createdAt);
  db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(createdAt, input.sessionId);
  return {
    id,
    sessionId: input.sessionId,
    role: input.role,
    text: input.text,
    payload,
    createdAt
  };
}

export function listChatMessages(sessionId: string, limit = 200): ChatMessage[] {
  const db = getDb();
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 1000) : 200;
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE session_id = ?
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(sessionId, safeLimit) as ChatMessageRow[];
  return rows.map(mapMessage);
}

export function appendChatEvent(input: {
  sessionId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}): ChatEvent {
  const db = getDb();
  const id = makeId("cev");
  const createdAt = nowIso();
  const payload = input.payload ?? {};
  db.prepare(
    `INSERT INTO chat_events (
      id,
      session_id,
      event_type,
      event_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(id, input.sessionId, input.eventType, JSON.stringify(payload), createdAt);
  db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(createdAt, input.sessionId);
  return {
    id,
    sessionId: input.sessionId,
    eventType: input.eventType,
    payload,
    createdAt
  };
}

export function listChatEvents(input: {
  sessionId: string;
  since?: string;
  limit?: number;
}): ChatEvent[] {
  const db = getDb();
  const safeLimit =
    Number.isFinite(input.limit) && (input.limit ?? 0) > 0 ? Math.min(Math.floor(input.limit ?? 0), 1000) : 200;
  const rows = input.since
    ? (db
        .prepare(
          `SELECT * FROM chat_events
           WHERE session_id = ? AND created_at > ?
           ORDER BY created_at ASC
           LIMIT ?`
        )
        .all(input.sessionId, input.since, safeLimit) as ChatEventRow[])
    : (db
        .prepare(
          `SELECT * FROM chat_events
           WHERE session_id = ?
           ORDER BY created_at ASC
           LIMIT ?`
        )
        .all(input.sessionId, safeLimit) as ChatEventRow[]);
  return rows.map(mapEvent);
}

export function getIdempotencyRecord(input: {
  idempotencyKey: string;
  channel: Exclude<ChatChannel, "webchat">;
  tenantId: string;
}): IdempotencyRecord | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM chat_idempotency_keys
       WHERE idempotency_key = ? AND channel = ? AND tenant_id = ?`
    )
    .get(input.idempotencyKey, input.channel, input.tenantId) as IdempotencyRow | undefined;
  return row ? mapIdempotency(row) : null;
}

export function isIdempotencyPendingResponse(response: Record<string, unknown>): boolean {
  return response._state === "pending";
}

export function reserveIdempotencyRecord(input: {
  idempotencyKey: string;
  channel: Exclude<ChatChannel, "webchat">;
  tenantId: string;
  sessionId?: string;
  requestHash: string;
}): { acquired: true } | { acquired: false; record: IdempotencyRecord } {
  const db = getDb();
  const createdAt = nowIso();
  const pendingResponse: Record<string, unknown> = { _state: "pending" };
  const inserted = db
    .prepare(
      `INSERT INTO chat_idempotency_keys (
        idempotency_key,
        channel,
        tenant_id,
        session_id,
        request_hash,
        response_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key, channel, tenant_id) DO NOTHING`
    )
    .run(
      input.idempotencyKey,
      input.channel,
      input.tenantId,
      input.sessionId ?? null,
      input.requestHash,
      JSON.stringify(pendingResponse),
      createdAt
    );
  if (inserted.changes > 0) {
    return { acquired: true };
  }
  const existing = getIdempotencyRecord({
    idempotencyKey: input.idempotencyKey,
    channel: input.channel,
    tenantId: input.tenantId
  });
  if (!existing) {
    throw new Error("Failed to read idempotency reservation");
  }
  return { acquired: false, record: existing };
}

export function saveIdempotencyRecord(input: {
  idempotencyKey: string;
  channel: Exclude<ChatChannel, "webchat">;
  tenantId: string;
  sessionId?: string;
  requestHash: string;
  response: Record<string, unknown>;
}): IdempotencyRecord {
  const db = getDb();
  const updated = db
    .prepare(
      `UPDATE chat_idempotency_keys
       SET session_id = ?,
           request_hash = ?,
           response_json = ?
       WHERE idempotency_key = ? AND channel = ? AND tenant_id = ?`
    )
    .run(
      input.sessionId ?? null,
      input.requestHash,
      JSON.stringify(input.response),
      input.idempotencyKey,
      input.channel,
      input.tenantId
    );
  if (updated.changes === 0) {
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO chat_idempotency_keys (
        idempotency_key,
        channel,
        tenant_id,
        session_id,
        request_hash,
        response_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.idempotencyKey,
      input.channel,
      input.tenantId,
      input.sessionId ?? null,
      input.requestHash,
      JSON.stringify(input.response),
      createdAt
    );
  }
  const row = getIdempotencyRecord({
    idempotencyKey: input.idempotencyKey,
    channel: input.channel,
    tenantId: input.tenantId
  });
  if (!row) {
    throw new Error("Failed to read idempotency record");
  }
  return row;
}
