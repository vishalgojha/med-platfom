import type { Express, Request, Response } from "express";
import { parseLanguage, parseWorkflow, normalizeSpecialtyId } from "../orchestration/router.js";
import { appError, toStructuredError } from "../errors.js";
import { addDoctor, getDoctorById } from "../doctors/store.js";
import { addPatient, getPatientById } from "../patients/store.js";
import type { RuntimeDeps } from "../runtime.js";
import { runChatWorkflowTurn } from "./orchestrator.js";
import {
  appendChatMessage,
  getChatSessionById,
  hashRequestPayload,
  isIdempotencyPendingResponse,
  listChatEvents,
  listChatMessages,
  reserveIdempotencyRecord,
  saveIdempotencyRecord,
  upsertChatSession,
  type ChatChannel
} from "./session-store.js";
import { publishChatEvent, streamChatEvents } from "./events.js";
import { executeSkill, listSkillMetadata } from "../skills/registry.js";

type RequireScope = (req: Request, res: Response, required: "read" | "write" | "admin") => boolean;
type SendJson = (res: Response, status: number, payload: unknown) => void;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseChannel(value: unknown): ChatChannel | null {
  if (value === "webchat" || value === "whatsapp_twilio" || value === "whatsapp_web") {
    return value;
  }
  return null;
}

function isStructuredError(value: unknown): value is { ok: false; code: string; message: string } {
  if (!value || typeof value !== "object") return false;
  const obj = value as { ok?: unknown; code?: unknown; message?: unknown };
  return obj.ok === false && typeof obj.code === "string" && typeof obj.message === "string";
}

function stableId(prefix: string, seed: string): string {
  const normalized = seed.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const suffix = normalized.length > 0 ? normalized.slice(0, 42) : "default";
  return `${prefix}_${suffix}`;
}

function ensureDoctor(input: {
  preferredDoctorId?: string;
  tenantId: string;
  specialtyId: string;
}): string {
  if (input.preferredDoctorId && getDoctorById(input.preferredDoctorId)) {
    return input.preferredDoctorId;
  }

  const fallbackId = input.preferredDoctorId ?? stableId("chat_doc", input.tenantId);
  if (getDoctorById(fallbackId)) {
    return fallbackId;
  }

  try {
    const created = addDoctor({
      id: fallbackId,
      name: `${input.tenantId} Virtual Care`,
      specialty: input.specialtyId
    });
    return created.id;
  } catch {
    const existing = getDoctorById(fallbackId);
    if (existing) {
      return existing.id;
    }
    throw new Error("Failed to ensure doctor context");
  }
}

function ensurePatient(input: {
  preferredPatientId?: string;
  doctorId: string;
  userName?: string;
  userPhone?: string;
}): string {
  if (input.preferredPatientId && getPatientById(input.preferredPatientId)) {
    return input.preferredPatientId;
  }

  const fallbackId = input.preferredPatientId;
  if (fallbackId && getPatientById(fallbackId)) {
    return fallbackId;
  }

  const created = addPatient({
    id: fallbackId,
    doctorId: input.doctorId,
    name: input.userName?.trim() || `Chat User ${input.userPhone ?? ""}`.trim(),
    phone: input.userPhone
  });
  return created.id;
}

export function registerChatRoutes(input: {
  app: Express;
  requireScope: RequireScope;
  sendJson: SendJson;
  deps: RuntimeDeps;
}): void {
  const { app, requireScope, sendJson, deps } = input;

  app.post("/api/v1/chat/inbound", async (req, res) => {
    if (!requireScope(req, res, "write")) return;
    try {
      const body = asObject(req.body);
      if (!body) {
        sendJson(res, 400, appError("VALIDATION_ERROR", "Request body must be a JSON object"));
        return;
      }

      const channel = parseChannel(body.channel ?? "webchat");
      if (!channel) {
        sendJson(
          res,
          422,
          appError("VALIDATION_ERROR", "channel must be one of webchat|whatsapp_twilio|whatsapp_web")
        );
        return;
      }

      const tenantId = requireString(body, "tenantId") ?? "default";
      const message = asObject(body.message);
      if (!message) {
        sendJson(res, 422, appError("VALIDATION_ERROR", "message object is required"));
        return;
      }
      const text = requireString(message, "text");
      if (!text) {
        sendJson(res, 422, appError("VALIDATION_ERROR", "message.text is required"));
        return;
      }

      const user = asObject(body.user) ?? {};
      const routing = asObject(body.routing) ?? {};
      const options = asObject(body.options) ?? {};
      const preferredLanguage = parseLanguage(user.language);

      const requestedSessionId = requireString(body, "sessionId") ?? undefined;
      const existingSession = requestedSessionId ? getChatSessionById(requestedSessionId) : null;
      if (existingSession && existingSession.tenantId !== tenantId) {
        sendJson(res, 409, appError("CONFLICT", "sessionId does not belong to tenantId"));
        return;
      }
      if (existingSession && existingSession.channel !== channel) {
        sendJson(res, 409, appError("CONFLICT", "sessionId cannot be reused across channels"));
        return;
      }

      const idempotencyKeyRaw = req.header("x-idempotency-key")?.trim() ?? "";
      const idempotencyChannel = channel === "webchat" ? null : channel;
      const requestHash = hashRequestPayload(body);
      if (idempotencyChannel && !idempotencyKeyRaw) {
        sendJson(
          res,
          422,
          appError("VALIDATION_ERROR", "x-idempotency-key header is required for non-webchat channels")
        );
        return;
      }
      if (idempotencyChannel && idempotencyKeyRaw) {
        const reservation = reserveIdempotencyRecord({
          idempotencyKey: idempotencyKeyRaw,
          channel: idempotencyChannel,
          tenantId,
          sessionId: requestedSessionId,
          requestHash
        });
        if (!reservation.acquired) {
          if (reservation.record.requestHash !== requestHash) {
            sendJson(
              res,
              409,
              appError("CONFLICT", "Idempotency key reuse with different payload is not allowed")
            );
            return;
          }
          if (isIdempotencyPendingResponse(reservation.record.response)) {
            sendJson(res, 409, appError("CONFLICT", "Idempotent request is already in progress"));
            return;
          }
          sendJson(res, 200, reservation.record.response);
          return;
        }
      }

      const workflowRaw = routing.workflow ?? existingSession?.workflow ?? "triage_intake";
      const workflow = parseWorkflow(workflowRaw) ?? "triage_intake";
      const specialtyId =
        normalizeSpecialtyId(routing.specialtyId ?? existingSession?.specialtyId ?? "family_medicine") ??
        "family_medicine";
      const language = preferredLanguage ?? existingSession?.language ?? "en";

      const doctorId = ensureDoctor({
        preferredDoctorId:
          requireString(routing, "doctorId") ?? existingSession?.doctorId ?? undefined,
        tenantId,
        specialtyId
      });

      const patientId = ensurePatient({
        preferredPatientId:
          requireString(routing, "patientId") ?? existingSession?.patientId ?? undefined,
        doctorId,
        userName: requireString(user, "name") ?? existingSession?.userName,
        userPhone: requireString(user, "phone") ?? existingSession?.userPhone
      });

      const session = upsertChatSession({
        sessionId: requestedSessionId,
        tenantId,
        channel,
        userId: requireString(user, "id") ?? existingSession?.userId,
        userPhone: requireString(user, "phone") ?? existingSession?.userPhone,
        userName: requireString(user, "name") ?? existingSession?.userName,
        language,
        workflow,
        specialtyId,
        doctorId,
        patientId
      });

      const rawAttachments = Array.isArray(message.attachments) ? message.attachments : [];
      const attachments = rawAttachments
        .map((entry) => asObject(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .map((entry) => ({
          type: typeof entry.type === "string" ? entry.type : "document",
          url: typeof entry.url === "string" ? entry.url : "",
          mimeType: typeof entry.mimeType === "string" ? entry.mimeType : undefined
        }))
        .filter((entry) => entry.url.length > 0);

      const userMessage = appendChatMessage({
        sessionId: session.id,
        role: "user",
        text,
        payload: {
          channel,
          messageId: requireString(message, "id"),
          attachments
        }
      });

      const requestId = String(req.headers["x-request-id"] ?? "");
      const actorId = String(req.headers["x-actor-id"] ?? "system");
      publishChatEvent({
        sessionId: session.id,
        eventType: "chat.ack",
        payload: {
          requestId,
          userMessageId: userMessage.id
        }
      });
      publishChatEvent({
        sessionId: session.id,
        eventType: "chat.tool_call",
        payload: {
          skill: "workflow.execute",
          workflow,
          specialtyId
        }
      });

      const turn = await runChatWorkflowTurn({
        runtime: deps,
        workflow,
        specialtyId,
        doctorId: session.doctorId,
        patientId: session.patientId,
        messageText: text,
        attachments,
        language: session.language,
        dryRun: parseBoolean(options.dryRun, false),
        confirm: parseBoolean(options.confirm, true),
        requestId,
        actorId
      });

      publishChatEvent({
        sessionId: session.id,
        eventType: "chat.tool_result",
        payload: {
          skill: "workflow.execute",
          ok: turn.ok,
          workflow: turn.workflow,
          specialtyId: turn.specialtyId
        }
      });

      const assistantMessage = appendChatMessage({
        sessionId: session.id,
        role: "assistant",
        text: turn.assistantText,
        payload: {
          workflow: turn.workflow,
          specialtyId: turn.specialtyId
        }
      });

      if (!turn.ok) {
        publishChatEvent({
          sessionId: session.id,
          eventType: "chat.error",
          payload: {
            code: turn.error.code,
            message: turn.error.message
          }
        });
      }

      publishChatEvent({
        sessionId: session.id,
        eventType: "chat.assistant_final",
        payload: {
          assistantMessageId: assistantMessage.id,
          text: assistantMessage.text
        }
      });
      publishChatEvent({
        sessionId: session.id,
        eventType: "chat.completed",
        payload: {
          requestId
        }
      });

      const responsePayload: Record<string, unknown> = {
        ok: true,
        data: {
          sessionId: session.id,
          requestId,
          streamUrl: `/api/v1/chat/sessions/${session.id}/events`,
          assistantMessage: {
            id: assistantMessage.id,
            text: assistantMessage.text
          },
          workflow: turn.workflow,
          specialtyId: turn.specialtyId,
          execution: turn.ok ? turn.workflowOutput : turn.error
        }
      };

      if (idempotencyChannel && idempotencyKeyRaw) {
        saveIdempotencyRecord({
          idempotencyKey: idempotencyKeyRaw,
          channel: idempotencyChannel,
          tenantId,
          sessionId: session.id,
          requestHash,
          response: responsePayload
        });
      }

      sendJson(res, 200, responsePayload);
    } catch (error) {
      const structured = toStructuredError(error);
      const structuredResponse: Record<string, unknown> = { ...structured };
      const body = asObject(req.body);
      const parsedChannel = parseChannel(body?.channel ?? "webchat");
      const tenantId = body ? requireString(body, "tenantId") ?? "default" : "default";
      const idempotencyKeyRaw = req.header("x-idempotency-key")?.trim() ?? "";
      const idempotencyChannel = parsedChannel && parsedChannel !== "webchat" ? parsedChannel : null;
      if (body && idempotencyChannel && idempotencyKeyRaw) {
        try {
          saveIdempotencyRecord({
            idempotencyKey: idempotencyKeyRaw,
            channel: idempotencyChannel,
            tenantId,
            sessionId: requireString(body, "sessionId") ?? undefined,
            requestHash: hashRequestPayload(body),
            response: structuredResponse
          });
        } catch {
          // Keep primary request error as source of truth.
        }
      }
      sendJson(res, 500, structured);
    }
  });

  app.get("/api/v1/chat/sessions/:id/messages", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    const session = getChatSessionById(req.params.id);
    if (!session) {
      sendJson(res, 404, appError("NOT_FOUND", "Chat session not found"));
      return;
    }
    const limit = Number(req.query.limit ?? 200);
    const messages = listChatMessages(session.id, limit);
    sendJson(res, 200, { ok: true, data: { session, messages } });
  });

  app.get("/api/v1/chat/sessions/:id/events", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    const session = getChatSessionById(req.params.id);
    if (!session) {
      sendJson(res, 404, appError("NOT_FOUND", "Chat session not found"));
      return;
    }

    const since = typeof req.query.since === "string" && req.query.since.trim() ? req.query.since.trim() : undefined;
    const streamQuery = typeof req.query.stream === "string" ? req.query.stream.trim().toLowerCase() : "";
    const accept = req.header("accept") ?? "";
    const wantsStream = streamQuery === "true" || accept.includes("text/event-stream");
    if (!wantsStream) {
      const events = listChatEvents({
        sessionId: session.id,
        since,
        limit: Number(req.query.limit ?? 200)
      });
      sendJson(res, 200, { ok: true, data: { sessionId: session.id, events } });
      return;
    }

    streamChatEvents({
      req,
      res,
      sessionId: session.id,
      since
    });
  });

  app.get("/api/v1/skills", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    sendJson(res, 200, { ok: true, data: listSkillMetadata() });
  });

  app.post("/api/v1/skills/execute", async (req, res) => {
    if (!requireScope(req, res, "admin")) return;
    try {
      const body = asObject(req.body);
      if (!body) {
        sendJson(res, 400, appError("VALIDATION_ERROR", "Request body must be a JSON object"));
        return;
      }
      const name = requireString(body, "skill");
      if (!name) {
        sendJson(res, 422, appError("VALIDATION_ERROR", "skill is required"));
        return;
      }
      const result = await executeSkill(name, body.input, {
        runtime: deps,
        requestId: String(req.headers["x-request-id"] ?? ""),
        actorId: String(req.headers["x-actor-id"] ?? "system"),
        confirm: parseBoolean(body.confirm, true),
        dryRun: parseBoolean(body.dryRun, false)
      });
      if (isStructuredError(result)) {
        const status = result.code === "NOT_FOUND" ? 404 : 422;
        sendJson(res, status, result);
        return;
      }
      sendJson(res, 200, { ok: true, data: result });
    } catch (error) {
      sendJson(res, 500, toStructuredError(error));
    }
  });
}
