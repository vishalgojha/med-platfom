import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import twilio from "twilio";
import {
  isRequestBodyLimitError,
  parseUrlEncodedFormBody,
  readRequestBodyWithLimit,
  requestBodyErrorToText
} from "./http/body-limit.js";
import { runMigrations } from "./db/migrations.js";
import { createIntent } from "./engine/intent.js";
import { executeIntent } from "./engine/executor.js";
import { appError, toStructuredError } from "./errors.js";
import { getConfig } from "./config.js";
import { createCapabilityHandlers, createRuntimeDeps, RuntimeDeps } from "./runtime.js";
import { listReplay, getReplayById, pruneReplayOlderThan } from "./engine/replay.js";
import { CapabilityName, RiskLevel } from "./types.js";
import { getPriorAuthById, listPriorAuths } from "./capabilities/prior-auth.js";
import {
  addPatient,
  getFollowUpByProviderMessageId,
  getPatientById,
  listFollowUpDeadLetters,
  listFollowUps,
  listPatients,
  updateFollowUpDeliveryByProviderMessageId
} from "./patients/store.js";
import { logger } from "./logger.js";
import {
  getPendingDeliveryById,
  getFailedDeliveryById,
  inspectPendingDeliveriesByIds,
  listPendingDeliveries,
  listFailedDeliveries,
  removePendingDeliveryById,
  removePendingDeliveriesByIds,
  recoverPendingDeliveries,
  requeueFailedDelivery,
  retryFailedDeliveryNow
} from "./messaging/delivery-queue.js";
import { createPersistentDedupe, resolveTwilioWebhookDedupePath } from "./messaging/persistent-dedupe.js";
import { getOpsMetrics } from "./ops/metrics.js";
import { getFollowUpQueueStats } from "./capabilities/follow-up.js";
import { getDb } from "./db/client.js";
import { nowIso } from "./utils.js";
import { addDoctor, getDoctorById, listDoctors } from "./doctors/store.js";
import {
  executeAgentWorkflow,
  getIndiaProfile,
  getSpecialtyValidationMessage,
  getWorkflowValidationMessage,
  listSpecialtyDirectory,
  normalizeSpecialtyId,
  parseLanguage,
  parseSetting,
  parseWorkflow,
} from "./orchestration/router.js";
import { registerWhatsAppRoutes } from "./whatsapp/routes.js";
import { registerChatRoutes } from "./chat/routes.js";

function sendJson(res: Response, status: number, payload: unknown): void {
  res.status(status).json(payload);
}

type TokenScope = "read" | "write" | "admin";

function isTokenScope(value: unknown): value is TokenScope {
  return value === "read" || value === "write" || value === "admin";
}

function requireScope(req: Request, res: Response, required: "read" | "write" | "admin"): boolean {
  const tokenScope = isTokenScope(res.locals.authScope) ? res.locals.authScope : null;
  const rank: Record<"read" | "write" | "admin", number> = {
    read: 1,
    write: 2,
    admin: 3
  };
  if (!tokenScope || rank[tokenScope] < rank[required]) {
    sendJson(res, 403, appError("FORBIDDEN", `Requires scope '${required}'`));
    return false;
  }
  return true;
}

function riskForRequest(capability: CapabilityName, body: Record<string, unknown>): RiskLevel {
  if (capability === "prior_auth" && body.submit === true) return "HIGH";
  if (capability === "follow_up" && body.sendNow === true) return "HIGH";
  return capability === "scribe" || capability === "decision_support" ? "LOW" : "MEDIUM";
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function requireStringArray(body: Record<string, unknown>, field: string): string[] | null {
  const value = body[field];
  if (!Array.isArray(value)) return null;
  const cleaned = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return cleaned.length === value.length ? cleaned : null;
}

function twilioWebhookDedupeKey(body: Record<string, string>): string {
  return [
    body.MessageSid ?? "",
    body.MessageStatus ?? "",
    body.ErrorCode ?? "",
    body.ErrorMessage ?? ""
  ].join("|");
}

function validateCapabilityPayload(
  capability: CapabilityName,
  body: Record<string, unknown>
): { ok: true } | { ok: false; error: ReturnType<typeof appError> } {
  if (capability === "scribe") {
    if (!requireString(body, "transcript")) {
      return { ok: false, error: appError("VALIDATION_ERROR", "transcript is required") };
    }
    if (!requireString(body, "patientId")) {
      return { ok: false, error: appError("VALIDATION_ERROR", "patientId is required") };
    }
    if (!requireString(body, "doctorId")) {
      return { ok: false, error: appError("VALIDATION_ERROR", "doctorId is required") };
    }
    return { ok: true };
  }

  if (capability === "prior_auth") {
    if (!requireString(body, "patientId")) return { ok: false, error: appError("VALIDATION_ERROR", "patientId is required") };
    if (!requireString(body, "doctorId")) return { ok: false, error: appError("VALIDATION_ERROR", "doctorId is required") };
    if (!requireString(body, "procedureCode")) return { ok: false, error: appError("VALIDATION_ERROR", "procedureCode is required") };
    if (!requireString(body, "insurerId")) return { ok: false, error: appError("VALIDATION_ERROR", "insurerId is required") };
    if (!requireStringArray(body, "diagnosisCodes")) {
      return { ok: false, error: appError("VALIDATION_ERROR", "diagnosisCodes must be a string[]") };
    }
    return { ok: true };
  }

  if (capability === "follow_up") {
    if (!requireString(body, "patientId")) return { ok: false, error: appError("VALIDATION_ERROR", "patientId is required") };
    if (!requireString(body, "doctorId")) return { ok: false, error: appError("VALIDATION_ERROR", "doctorId is required") };
    const trigger = requireString(body, "trigger");
    if (!trigger) return { ok: false, error: appError("VALIDATION_ERROR", "trigger is required") };
    if (!["post_visit", "lab_result", "medication_reminder", "custom"].includes(trigger)) {
      return { ok: false, error: appError("VALIDATION_ERROR", "trigger must be one of post_visit|lab_result|medication_reminder|custom") };
    }
    const channel = body.channel;
    if (channel !== undefined && channel !== "sms" && channel !== "whatsapp") {
      return { ok: false, error: appError("VALIDATION_ERROR", "channel must be sms or whatsapp") };
    }
    return { ok: true };
  }

  if (capability === "decision_support") {
    if (!requireString(body, "query")) return { ok: false, error: appError("VALIDATION_ERROR", "query is required") };
    return { ok: true };
  }

  return { ok: true };
}

async function handleCapability(
  req: Request,
  res: Response,
  capability: CapabilityName,
  deps: RuntimeDeps
): Promise<void> {
  try {
    const body = asObject(req.body);
    if (!body) {
      sendJson(res, 400, appError("VALIDATION_ERROR", "Request body must be a JSON object"));
      return;
    }
    const validation = validateCapabilityPayload(capability, body);
    if (!validation.ok) {
      sendJson(res, 422, validation.error);
      return;
    }

    const intent = createIntent({
      capability,
      doctorId: String(body.doctorId ?? "d_api"),
      patientId: body.patientId ? String(body.patientId) : undefined,
      payload: body,
      risk: riskForRequest(capability, body),
      dryRun: Boolean(body.dryRun)
    });

    const result = await executeIntent(intent, createCapabilityHandlers(deps), {
      confirm: Boolean(body.confirm),
      requestId: String(req.headers["x-request-id"] ?? ""),
      actorId: String(req.headers["x-actor-id"] ?? "system")
    });

    if (result.ok === false) {
      sendJson(res, result.blocked ? 409 : 400, result);
      return;
    }

    sendJson(res, 200, { ok: true, data: result.output });
  } catch (error) {
    sendJson(res, 500, toStructuredError(error));
  }
}

export function createServer(deps: RuntimeDeps = createRuntimeDeps()) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const {
    apiToken,
    apiTokenRead,
    apiTokenWrite,
    apiTokenAdmin,
    twilioWebhookValidate,
    twilioWebhookAuthToken,
    twilioWebhookMaxBodyBytes,
    twilioWebhookBodyTimeoutMs,
    twilioWebhookDedupeTtlMs,
    publicBaseUrl,
    apiRateLimitWindowMs,
    apiRateLimitMax
  } = getConfig();
  const webhookDedupe = createPersistentDedupe({
    ttlMs: twilioWebhookDedupeTtlMs,
    memoryMaxSize: 5_000,
    fileMaxEntries: 50_000,
    filePath: resolveTwilioWebhookDedupePath()
  });
  const rateWindow = new Map<string, { count: number; resetAt: number }>();
  const scopeByToken = new Map<string, TokenScope>();
  if (apiTokenRead) scopeByToken.set(apiTokenRead, "read");
  if (apiTokenWrite) scopeByToken.set(apiTokenWrite, "write");
  if (apiTokenAdmin) scopeByToken.set(apiTokenAdmin, "admin");
  // Backward compatible single token support.
  if (apiToken) scopeByToken.set(apiToken, "admin");

  app.use((req, res, next) => {
    const startedAt = Date.now();
    const requestId = req.header("x-request-id") ?? randomUUID();
    const actorId = req.header("x-actor-id") ?? "system";
    req.headers["x-request-id"] = requestId;
    req.headers["x-actor-id"] = actorId;
    res.setHeader("x-request-id", requestId);
    logger.info("request.received", { requestId, actorId, method: req.method, path: req.path });
    res.on("finish", () => {
      logger.info("request.completed", {
        requestId,
        actorId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt
      });
    });
    next();
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) {
      next();
      return;
    }
    if (scopeByToken.size === 0) {
      res.locals.authScope = "admin";
      next();
      return;
    }
    const auth = req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      sendJson(res, 401, appError("UNAUTHORIZED", "Missing or invalid API token"));
      return;
    }
    const rawToken = auth.slice("Bearer ".length).trim();
    const scope = scopeByToken.get(rawToken);
    if (!scope) {
      sendJson(res, 401, appError("UNAUTHORIZED", "Missing or invalid API token"));
      return;
    }
    res.locals.authScope = scope;
    next();
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) {
      next();
      return;
    }
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const db = getDb();
    const dbBucket = db
      .prepare("SELECT key, window_start_ms, count FROM rate_limits WHERE key = ?")
      .get(key) as { key: string; window_start_ms: number; count: number } | undefined;
    const memoryBucket = rateWindow.get(key);
    const currentCount = dbBucket?.count ?? memoryBucket?.count ?? 0;
    const currentWindowStart =
      dbBucket?.window_start_ms ?? (memoryBucket ? memoryBucket.resetAt - apiRateLimitWindowMs : 0);
    const currentResetAt = currentWindowStart + apiRateLimitWindowMs;

    if (currentCount === 0 || now >= currentResetAt) {
      const resetAt = now + apiRateLimitWindowMs;
      rateWindow.set(key, { count: 1, resetAt });
      db.prepare(
        `INSERT INTO rate_limits (key, window_start_ms, count)
         VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET window_start_ms = excluded.window_start_ms, count = 1`
      ).run(key, now);
      next();
      return;
    }
    if (currentCount >= apiRateLimitMax && now < currentResetAt) {
      sendJson(res, 429, appError("RATE_LIMITED", "Too many requests"));
      return;
    }
    const nextCount = currentCount + 1;
    rateWindow.set(key, { count: nextCount, resetAt: currentResetAt });
    db.prepare("UPDATE rate_limits SET count = ? WHERE key = ?").run(nextCount, key);
    next();
  });

  registerWhatsAppRoutes({
    app,
    requireScope,
    sendJson
  });
  registerChatRoutes({
    app,
    requireScope,
    sendJson,
    deps
  });

  app.get("/health", (_req, res) => {
    sendJson(res, 200, { ok: true, data: { status: "ok" } });
  });
  app.get("/health/ready", (_req, res) => {
    try {
      const metrics = getOpsMetrics();
      sendJson(res, 200, {
        ok: true,
        data: {
          status: "ready",
          metrics,
          queue: getFollowUpQueueStats()
        }
      });
    } catch (error) {
      sendJson(res, 503, appError("NOT_READY", error instanceof Error ? error.message : "not ready"));
    }
  });

  app.post("/webhooks/twilio/status", async (req, res) => {
    try {
      const contentType = req.header("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
        sendJson(res, 415, appError("VALIDATION_ERROR", "Content-Type must be application/x-www-form-urlencoded"));
        return;
      }

      const rawBody = await readRequestBodyWithLimit(req, {
        maxBytes: twilioWebhookMaxBodyBytes,
        timeoutMs: twilioWebhookBodyTimeoutMs
      });
      const formBody = parseUrlEncodedFormBody(rawBody);

      if (twilioWebhookValidate) {
        const signature = req.header("x-twilio-signature");
        if (!signature) {
          sendJson(res, 403, appError("FORBIDDEN", "Missing Twilio signature"));
          return;
        }
        const host = req.header("host");
        const protocol = req.header("x-forwarded-proto") ?? req.protocol;
        const callbackUrl = publicBaseUrl
          ? `${publicBaseUrl.replace(/\/$/, "")}${req.originalUrl}`
          : `${protocol}://${host}${req.originalUrl}`;
        const valid = twilio.validateRequest(
          twilioWebhookAuthToken,
          signature,
          callbackUrl,
          formBody
        );
        if (!valid) {
          sendJson(res, 403, appError("FORBIDDEN", "Invalid Twilio signature"));
          return;
        }
      }

      const messageSid = requireString(formBody, "MessageSid");
      const providerStatusRaw = requireString(formBody, "MessageStatus");
      if (!messageSid || !providerStatusRaw) {
        sendJson(res, 422, appError("VALIDATION_ERROR", "MessageSid and MessageStatus are required"));
        return;
      }
      const normalizedStatus = providerStatusRaw.toLowerCase();
      const allowedStatus = ["queued", "sent", "delivered", "undelivered", "failed"];
      if (!allowedStatus.includes(normalizedStatus)) {
        sendJson(res, 422, appError("VALIDATION_ERROR", "Unsupported MessageStatus"));
        return;
      }

      const accepted = await webhookDedupe.checkAndRecord(twilioWebhookDedupeKey(formBody));
      if (!accepted) {
        const existing = getFollowUpByProviderMessageId(messageSid);
        sendJson(res, 200, {
          ok: true,
          data: existing,
          meta: {
            deduped: true,
            applied: false,
            ignoredReason: "persistent_duplicate"
          }
        });
        return;
      }

      const updated = updateFollowUpDeliveryByProviderMessageId({
        providerMessageId: messageSid,
        providerStatus: normalizedStatus as "queued" | "sent" | "delivered" | "undelivered" | "failed",
        errorCode: formBody.ErrorCode,
        errorMessage: formBody.ErrorMessage,
        payload: JSON.stringify(formBody),
        at: nowIso()
      });
      if (!updated.record) {
        sendJson(res, 404, appError("NOT_FOUND", "No follow-up found for provider message id"));
        return;
      }

      sendJson(res, 200, {
        ok: true,
        data: updated.record,
        meta: {
          deduped: updated.deduped,
          applied: updated.applied,
          ignoredReason: updated.ignoredReason
        }
      });
    } catch (error) {
      if (isRequestBodyLimitError(error)) {
        const status =
          error.code === "PAYLOAD_TOO_LARGE"
            ? 413
            : error.code === "REQUEST_BODY_TIMEOUT"
              ? 408
              : 400;
        sendJson(res, status, appError("VALIDATION_ERROR", requestBodyErrorToText(error.code)));
        return;
      }
      sendJson(res, 500, toStructuredError(error));
    }
  });

  app.post("/api/scribe", async (req, res) => {
    if (!requireScope(req, res, "write")) return;
    await handleCapability(req, res, "scribe", deps);
  });
  app.post("/api/prior-auth", async (req, res) => {
    if (!requireScope(req, res, "write")) return;
    await handleCapability(req, res, "prior_auth", deps);
  });
  app.post("/api/follow-up", async (req, res) => {
    if (!requireScope(req, res, "write")) return;
    await handleCapability(req, res, "follow_up", deps);
  });
  app.post("/api/decide", async (req, res) => {
    if (!requireScope(req, res, "read")) return;
    await handleCapability(req, res, "decision_support", deps);
  });
  app.get("/api/specialties", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    const settingRaw = typeof req.query.setting === "string" ? req.query.setting : undefined;
    const languageRaw = typeof req.query.language === "string" ? req.query.language : undefined;
    const setting = settingRaw ? parseSetting(settingRaw) : null;
    const language = languageRaw ? parseLanguage(languageRaw) : null;

    if (settingRaw && !setting) {
      sendJson(res, 422, appError("VALIDATION_ERROR", "setting must be one of clinic|hospital"));
      return;
    }
    if (languageRaw && !language) {
      sendJson(res, 422, appError("VALIDATION_ERROR", "language must be one of en|hi"));
      return;
    }

    sendJson(
      res,
      200,
      {
        ok: true,
        data: listSpecialtyDirectory({
          setting: setting ?? undefined,
          language: language ?? "en",
        }),
      },
    );
  });
  app.get("/api/agents/deployment-profile", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    const rawLanguages = typeof req.query.languages === "string" ? req.query.languages : undefined;
    const languages = rawLanguages
      ? rawLanguages
          .split(",")
          .map((value) => parseLanguage(value.trim()))
          .filter((value): value is "en" | "hi" => Boolean(value))
      : undefined;

    if (rawLanguages && (!languages || languages.length === 0)) {
      sendJson(res, 422, appError("VALIDATION_ERROR", "languages must include en and/or hi"));
      return;
    }

    sendJson(res, 200, { ok: true, data: getIndiaProfile(languages) });
  });
  app.post("/api/agent-router/execute", async (req, res) => {
    if (!requireScope(req, res, "write")) return;
    const body = asObject(req.body);
    if (!body) {
      sendJson(res, 400, appError("VALIDATION_ERROR", "Request body must be a JSON object"));
      return;
    }

    const specialtyId = normalizeSpecialtyId(body.specialtyId);
    if (!specialtyId) {
      sendJson(res, 422, appError("VALIDATION_ERROR", getSpecialtyValidationMessage()));
      return;
    }

    const workflow = parseWorkflow(body.workflow);
    if (!workflow) {
      sendJson(res, 422, appError("VALIDATION_ERROR", getWorkflowValidationMessage()));
      return;
    }

    const payload = asObject(body.payload) ?? {};
    const doctorId = requireString(body, "doctorId") ?? (typeof payload.doctorId === "string" ? payload.doctorId : null);
    const patientId = requireString(body, "patientId") ?? (typeof payload.patientId === "string" ? payload.patientId : undefined);
    if (!doctorId) {
      sendJson(res, 422, appError("VALIDATION_ERROR", "doctorId is required"));
      return;
    }

    try {
      const result = await executeAgentWorkflow(
        {
          workflow,
          specialtyId,
          doctorId,
          patientId,
          payload,
          dryRun: Boolean(body.dryRun),
        },
        createCapabilityHandlers(deps),
        {
          confirm: Boolean(body.confirm),
          requestId: String(req.headers["x-request-id"] ?? ""),
          actorId: String(req.headers["x-actor-id"] ?? "system"),
        },
      );

      if ("ok" in result && result.ok === false) {
        sendJson(res, result.blocked ? 409 : 400, result);
        return;
      }

      sendJson(res, 200, { ok: true, data: result });
    } catch (error) {
      sendJson(res, 500, toStructuredError(error));
    }
  });
  app.get("/api/doctors", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    sendJson(res, 200, { ok: true, data: listDoctors() });
  });
  app.post("/api/doctors", (req, res) => {
    if (!requireScope(req, res, "write")) return;
    const body = asObject(req.body);
    if (!body) {
      sendJson(res, 400, appError("VALIDATION_ERROR", "Request body must be a JSON object"));
      return;
    }
    const name = requireString(body, "name");
    const specialty = normalizeSpecialtyId(body.specialty);
    if (!name) {
      sendJson(res, 422, appError("VALIDATION_ERROR", "name is required"));
      return;
    }
    if (!specialty) {
      sendJson(
        res,
        422,
        appError("VALIDATION_ERROR", getSpecialtyValidationMessage())
      );
      return;
    }
    sendJson(res, 201, { ok: true, data: addDoctor({ name, specialty }) });
  });
  app.get("/api/doctors/:id", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    const doctor = getDoctorById(req.params.id);
    if (!doctor) {
      sendJson(res, 404, appError("NOT_FOUND", "Doctor not found"));
      return;
    }
    sendJson(res, 200, { ok: true, data: doctor });
  });
  app.get("/api/patients", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    const doctorId = typeof req.query.doctorId === "string" ? req.query.doctorId : undefined;
    const rows = listPatients();
    sendJson(res, 200, { ok: true, data: doctorId ? rows.filter((row) => row.doctorId === doctorId) : rows });
  });
  app.post("/api/patients", (req, res) => {
    if (!requireScope(req, res, "write")) return;
    const body = asObject(req.body);
    if (!body) {
      sendJson(res, 400, appError("VALIDATION_ERROR", "Request body must be a JSON object"));
      return;
    }
    const doctorId = requireString(body, "doctorId");
    const name = requireString(body, "name");
    if (!doctorId) {
      sendJson(res, 422, appError("VALIDATION_ERROR", "doctorId is required"));
      return;
    }
    if (!name) {
      sendJson(res, 422, appError("VALIDATION_ERROR", "name is required"));
      return;
    }
    if (!getDoctorById(doctorId)) {
      sendJson(res, 404, appError("NOT_FOUND", "Doctor not found"));
      return;
    }
    const dob = typeof body.dob === "string" ? body.dob : undefined;
    const phone = typeof body.phone === "string" ? body.phone : undefined;
    const meds = Array.isArray(body.meds) ? body.meds.filter((v): v is string => typeof v === "string") : undefined;
    const allergies = Array.isArray(body.allergies)
      ? body.allergies.filter((v): v is string => typeof v === "string")
      : undefined;
    const patient = addPatient({ doctorId, name, dob, phone, meds, allergies });
    sendJson(res, 201, { ok: true, data: patient });
  });
  app.get("/api/patients/:id", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    const patient = getPatientById(req.params.id);
    if (!patient) {
      sendJson(res, 404, appError("NOT_FOUND", "Patient not found"));
      return;
    }
    sendJson(res, 200, { ok: true, data: patient });
  });
  app.patch("/api/prior-auth/:id/status", async (req, res) => {
    if (!requireScope(req, res, "write")) return;
    const body = asObject(req.body);
    if (!body) {
      sendJson(res, 400, appError("VALIDATION_ERROR", "Request body must be a JSON object"));
      return;
    }
    const status = requireString(body, "status");
    if (!status) {
      sendJson(res, 422, appError("VALIDATION_ERROR", "status is required"));
      return;
    }
    const intent = createIntent({
      capability: "prior_auth",
      doctorId: String(body.doctorId ?? "d_api"),
      payload: {
        mode: "status_update",
        priorAuthId: req.params.id,
        status
      },
      risk: "HIGH",
      dryRun: false
    });
    const result = await executeIntent(intent, createCapabilityHandlers(deps), {
      confirm: Boolean(body.confirm),
      requestId: String(req.headers["x-request-id"] ?? ""),
      actorId: String(req.headers["x-actor-id"] ?? "system")
    });
    if (result.ok === false) {
      sendJson(res, result.blocked ? 409 : 400, result);
      return;
    }
    sendJson(res, 200, { ok: true, data: result.output });
  });

  app.get("/api/prior-auth", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    const patientId = typeof req.query.patientId === "string" ? req.query.patientId : undefined;
    sendJson(res, 200, { ok: true, data: listPriorAuths(patientId) });
  });

  app.get("/api/prior-auth/:id", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    const row = getPriorAuthById(req.params.id);
    if (!row) {
      sendJson(res, 404, appError("NOT_FOUND", "Prior auth not found"));
      return;
    }
    sendJson(res, 200, { ok: true, data: row });
  });

  app.get("/api/follow-up", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    const patientId = typeof req.query.patientId === "string" ? req.query.patientId : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const validStatus =
      status === "scheduled" || status === "sent" || status === "failed" || status === "dead_letter" ? status : undefined;
    sendJson(res, 200, { ok: true, data: listFollowUps({ patientId, status: validStatus }) });
  });
  app.get("/api/follow-up/dead-letter", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    const limit = Number(req.query.limit ?? 50);
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
    sendJson(res, 200, { ok: true, data: listFollowUpDeadLetters(safeLimit) });
  });
  app.post("/api/follow-up/dead-letter/:id/requeue", async (req, res) => {
    if (!requireScope(req, res, "write")) return;
    const body = asObject(req.body) ?? {};
    const intent = createIntent({
      capability: "follow_up",
      doctorId: String(body.doctorId ?? "d_api"),
      payload: {
        mode: "requeue_dead_letter",
        deadLetterId: req.params.id
      },
      risk: "MEDIUM",
      dryRun: Boolean(body.dryRun)
    });
    const result = await executeIntent(intent, createCapabilityHandlers(deps), {
      confirm: Boolean(body.confirm),
      requestId: String(req.headers["x-request-id"] ?? ""),
      actorId: String(req.headers["x-actor-id"] ?? "system")
    });
    if (result.ok === false) {
      sendJson(res, result.blocked ? 409 : 400, result);
      return;
    }
    sendJson(res, 200, { ok: true, data: result.output });
  });
  app.post("/api/follow-up/:id/retry", async (req, res) => {
    if (!requireScope(req, res, "write")) return;
    const body = asObject(req.body) ?? {};
    const intent = createIntent({
      capability: "follow_up",
      doctorId: String(body.doctorId ?? "d_api"),
      payload: {
        mode: "retry_failed",
        followUpId: req.params.id
      },
      risk: "HIGH",
      dryRun: Boolean(body.dryRun)
    });
    const result = await executeIntent(intent, createCapabilityHandlers(deps), {
      confirm: Boolean(body.confirm),
      requestId: String(req.headers["x-request-id"] ?? ""),
      actorId: String(req.headers["x-actor-id"] ?? "system")
    });
    if (result.ok === false) {
      sendJson(res, result.blocked ? 409 : 400, result);
      return;
    }
    sendJson(res, 200, { ok: true, data: result.output });
  });
  app.post("/api/follow-up/dispatch", async (req, res) => {
    if (!requireScope(req, res, "write")) return;
    const body = asObject(req.body) ?? {};
    const limit = Number(body.limit ?? 50);
    const intent = createIntent({
      capability: "follow_up",
      doctorId: String(body.doctorId ?? "d_api"),
      payload: { mode: "dispatch_due", limit },
      risk: "HIGH",
      dryRun: Boolean(body.dryRun)
    });
    const result = await executeIntent(intent, createCapabilityHandlers(deps), {
      confirm: Boolean(body.confirm),
      requestId: String(req.headers["x-request-id"] ?? ""),
      actorId: String(req.headers["x-actor-id"] ?? "system")
    });
    if (result.ok === false) {
      sendJson(res, result.blocked ? 409 : 400, result);
      return;
    }
    sendJson(res, 200, { ok: true, data: result.output });
  });
  app.post("/api/follow-up/retry-failed-bulk", async (req, res) => {
    if (!requireScope(req, res, "write")) return;
    const body = asObject(req.body) ?? {};
    const limit = Number(body.limit ?? 25);
    const intent = createIntent({
      capability: "follow_up",
      doctorId: String(body.doctorId ?? "d_api"),
      payload: { mode: "retry_failed_bulk", limit },
      risk: "HIGH",
      dryRun: Boolean(body.dryRun)
    });
    const result = await executeIntent(intent, createCapabilityHandlers(deps), {
      confirm: Boolean(body.confirm),
      requestId: String(req.headers["x-request-id"] ?? ""),
      actorId: String(req.headers["x-actor-id"] ?? "system")
    });
    if (result.ok === false) {
      sendJson(res, result.blocked ? 409 : 400, result);
      return;
    }
    sendJson(res, 200, { ok: true, data: result.output });
  });

  app.get("/api/follow-up/queue/pending", async (req, res) => {
    if (!requireScope(req, res, "admin")) return;
    try {
      const limit = Number(req.query.limit ?? 50);
      const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 50;
      const entries = await listPendingDeliveries(safeLimit);
      sendJson(res, 200, { ok: true, data: entries });
    } catch (error) {
      sendJson(res, 500, toStructuredError(error));
    }
  });
  app.get("/api/follow-up/queue/pending/:id", async (req, res) => {
    if (!requireScope(req, res, "admin")) return;
    try {
      const row = await getPendingDeliveryById(req.params.id);
      if (!row) {
        sendJson(res, 404, appError("NOT_FOUND", "Pending delivery not found"));
        return;
      }
      sendJson(res, 200, { ok: true, data: row });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "invalid delivery queue id") {
        sendJson(res, 422, appError("VALIDATION_ERROR", message));
        return;
      }
      sendJson(res, 500, toStructuredError(error));
    }
  });
  app.delete("/api/follow-up/queue/pending/:id", async (req, res) => {
    if (!requireScope(req, res, "admin")) return;
    try {
      const body = asObject(req.body) ?? {};
      const dryRun = Boolean(body.dryRun);
      const confirm = Boolean(body.confirm);
      const row = await getPendingDeliveryById(req.params.id);
      if (!row) {
        sendJson(res, 404, appError("NOT_FOUND", "Pending delivery not found"));
        return;
      }
      if (dryRun) {
        sendJson(res, 200, {
          ok: true,
          data: {
            status: "dry_run",
            entry: row
          }
        });
        return;
      }
      if (!confirm) {
        sendJson(
          res,
          409,
          appError("RISK_CONFIRMATION_REQUIRED", "Pending queue cancel requires confirm=true", {
            requiredConfirmation: true
          })
        );
        return;
      }
      const cancelled = await removePendingDeliveryById(req.params.id);
      sendJson(res, 200, {
        ok: true,
        data: {
          status: "cancelled",
          entry: cancelled
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Pending delivery not found") {
        sendJson(res, 404, appError("NOT_FOUND", message));
        return;
      }
      if (message === "invalid delivery queue id") {
        sendJson(res, 422, appError("VALIDATION_ERROR", message));
        return;
      }
      sendJson(res, 500, toStructuredError(error));
    }
  });
  app.post("/api/follow-up/queue/pending/cancel-bulk", async (req, res) => {
    if (!requireScope(req, res, "admin")) return;
    try {
      const body = asObject(req.body) ?? {};
      const ids = requireStringArray(body, "ids");
      if (!ids || ids.length === 0) {
        sendJson(res, 422, appError("VALIDATION_ERROR", "ids must be a non-empty string[]"));
        return;
      }
      const queueIds = Array.from(new Set(ids.map((id) => id.trim())));
      if (queueIds.length > 500) {
        sendJson(res, 422, appError("VALIDATION_ERROR", "ids must contain at most 500 queue ids"));
        return;
      }
      const dryRun = Boolean(body.dryRun);
      const confirm = Boolean(body.confirm);
      if (dryRun) {
        const preview = await inspectPendingDeliveriesByIds(queueIds);
        sendJson(res, 200, {
          ok: true,
          data: {
            status: "dry_run",
            attempted: queueIds.length,
            entries: preview.entries,
            missingIds: preview.missingIds
          }
        });
        return;
      }
      if (!confirm) {
        sendJson(
          res,
          409,
          appError("RISK_CONFIRMATION_REQUIRED", "Pending queue bulk cancel requires confirm=true", {
            requiredConfirmation: true
          })
        );
        return;
      }
      const cancelled = await removePendingDeliveriesByIds(queueIds);
      sendJson(res, 200, {
        ok: true,
        data: {
          status: "cancelled",
          attempted: queueIds.length,
          cancelled: cancelled.cancelled,
          missingIds: cancelled.missingIds
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "invalid delivery queue id") {
        sendJson(res, 422, appError("VALIDATION_ERROR", message));
        return;
      }
      sendJson(res, 500, toStructuredError(error));
    }
  });

  app.get("/api/follow-up/queue/failed", async (req, res) => {
    if (!requireScope(req, res, "admin")) return;
    try {
      const limit = Number(req.query.limit ?? 50);
      const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 50;
      const entries = await listFailedDeliveries(safeLimit);
      sendJson(res, 200, { ok: true, data: entries });
    } catch (error) {
      sendJson(res, 500, toStructuredError(error));
    }
  });
  app.get("/api/follow-up/queue/failed/:id", async (req, res) => {
    if (!requireScope(req, res, "admin")) return;
    try {
      const row = await getFailedDeliveryById(req.params.id);
      if (!row) {
        sendJson(res, 404, appError("NOT_FOUND", "Failed delivery not found"));
        return;
      }
      sendJson(res, 200, { ok: true, data: row });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "invalid delivery queue id") {
        sendJson(res, 422, appError("VALIDATION_ERROR", message));
        return;
      }
      sendJson(res, 500, toStructuredError(error));
    }
  });
  app.post("/api/follow-up/queue/failed/:id/requeue", async (req, res) => {
    if (!requireScope(req, res, "admin")) return;
    try {
      const body = asObject(req.body) ?? {};
      const resetRetryCount = Boolean(body.resetRetryCount);
      const row = await requeueFailedDelivery({
        queueId: req.params.id,
        resetRetryCount
      });
      sendJson(res, 200, { ok: true, data: row });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Failed delivery not found") {
        sendJson(res, 404, appError("NOT_FOUND", message));
        return;
      }
      if (message === "invalid delivery queue id") {
        sendJson(res, 422, appError("VALIDATION_ERROR", message));
        return;
      }
      sendJson(res, 500, toStructuredError(error));
    }
  });
  app.post("/api/follow-up/queue/failed/:id/retry", async (req, res) => {
    if (!requireScope(req, res, "admin")) return;
    try {
      const body = asObject(req.body) ?? {};
      const dryRun = Boolean(body.dryRun);
      const confirm = Boolean(body.confirm);
      const row = await getFailedDeliveryById(req.params.id);
      if (!row) {
        sendJson(res, 404, appError("NOT_FOUND", "Failed delivery not found"));
        return;
      }
      if (dryRun) {
        sendJson(res, 200, {
          ok: true,
          data: {
            status: "dry_run",
            entry: row
          }
        });
        return;
      }
      if (!confirm) {
        sendJson(
          res,
          409,
          appError("RISK_CONFIRMATION_REQUIRED", "Failed queue retry requires confirm=true", {
            requiredConfirmation: true
          })
        );
        return;
      }
      const retryResult = await retryFailedDeliveryNow({
        queueId: req.params.id,
        messaging: deps.messaging
      });
      sendJson(res, 200, { ok: true, data: retryResult });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Failed delivery not found") {
        sendJson(res, 404, appError("NOT_FOUND", message));
        return;
      }
      if (message === "invalid delivery queue id") {
        sendJson(res, 422, appError("VALIDATION_ERROR", message));
        return;
      }
      sendJson(res, 500, toStructuredError(error));
    }
  });

  app.get("/api/replay", (_req, res) => {
    if (!requireScope(_req, res, "read")) return;
    sendJson(res, 200, { ok: true, data: listReplay() });
  });
  app.post("/api/replay/prune", (req, res) => {
    if (!requireScope(req, res, "admin")) return;
    const body = asObject(req.body) ?? {};
    const days = Number(body.days ?? 30);
    if (!Number.isFinite(days) || days <= 0) {
      sendJson(res, 422, appError("VALIDATION_ERROR", "days must be a positive number"));
      return;
    }
    if (!Boolean(body.confirm)) {
      sendJson(
        res,
        409,
        appError("RISK_CONFIRMATION_REQUIRED", "Replay pruning requires confirm=true", {
          requiredConfirmation: true
        })
      );
      return;
    }
    const deleted = pruneReplayOlderThan(days);
    sendJson(res, 200, { ok: true, data: { deleted, days } });
  });

  app.get("/api/replay/:id", (req, res) => {
    if (!requireScope(req, res, "read")) return;
    const row = getReplayById(req.params.id);
    if (!row) {
      sendJson(res, 404, appError("NOT_FOUND", "Replay row not found"));
      return;
    }
    sendJson(res, 200, { ok: true, data: row });
  });
  app.get("/api/ops/metrics", (_req, res) => {
    if (!requireScope(_req, res, "admin")) return;
    sendJson(res, 200, {
      ok: true,
      data: {
        ...getOpsMetrics(),
        queue: getFollowUpQueueStats()
      }
    });
  });

  const uiDistPath = path.resolve(process.cwd(), "ui", "dist");
  if (fs.existsSync(path.join(uiDistPath, "index.html"))) {
    app.use(express.static(uiDistPath));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/webhooks") || req.path.startsWith("/health")) {
        next();
        return;
      }
      res.sendFile(path.join(uiDistPath, "index.html"));
    });
  }

  return app;
}

export function startServer(port?: number): void {
  runMigrations();
  const cfg = getConfig();
  const deps = createRuntimeDeps();
  const app = createServer(deps);
  const listenPort = port ?? cfg.port;

  app.listen(listenPort, () => {
    console.log(JSON.stringify({ ok: true, message: `doctor-agent listening on ${listenPort}` }));
  });

  void recoverPendingDeliveries({
    messaging: deps.messaging,
    dryRun: cfg.dryRun
  })
    .then((summary) => {
      if (summary.recovered > 0 || summary.failed > 0 || summary.skipped > 0) {
        logger.info("follow-up.delivery_queue.recovered", summary);
      }
    })
    .catch((error: unknown) => {
      logger.error("follow-up.delivery_queue.recovery_failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    });

  setInterval(() => {
    const dispatchIntent = createIntent({
      capability: "follow_up",
      doctorId: "system",
      payload: { mode: "dispatch_due", limit: 50 },
      risk: "MEDIUM",
      dryRun: cfg.dryRun
    });
    void executeIntent(dispatchIntent, createCapabilityHandlers(deps), {
      confirm: true,
      requestId: `system-dispatch-${Date.now()}`,
      actorId: "system-dispatcher"
    }).catch((error: unknown) => {
      logger.error("follow-up.dispatch.tick_failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }, 60_000);

  setInterval(() => {
    try {
      const deleted = pruneReplayOlderThan(cfg.replayRetentionDays);
      if (deleted > 0) {
        logger.info("replay.retention.pruned", {
          deleted,
          retentionDays: cfg.replayRetentionDays
        });
      }
    } catch (error) {
      logger.error("replay.retention.failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }, cfg.replayRetentionIntervalMs);
}
