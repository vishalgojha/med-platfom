import type { SupportedLanguage } from "@med-platform/clinical-specialties";
import { AnthropicClient, StubAIClient, type AIClient } from "../ai/client.js";
import { runChatWorkflowTurn } from "../chat/orchestrator.js";
import { getConfig } from "../config.js";
import { addDoctor, getDoctorById } from "../doctors/store.js";
import { logger } from "../logger.js";
import { addPatient } from "../patients/store.js";
import { normalizeSpecialtyId } from "../orchestration/router.js";
import { StubMessagingAdapter } from "../messaging/stub.js";
import { makeId } from "../utils.js";
import { decryptSecret } from "./crypto.js";
import { TenantTwilioMessagingAdapter } from "./messaging.js";
import {
  getWhatsAppConversationByTenantAndUser,
  getWhatsAppTenantWithSecretsById,
  getWhatsAppTenantWithSecretsByNumber,
  normalizeWhatsAppNumber,
  recordWhatsAppMessageEvent,
  upsertWhatsAppConversation
} from "./store.js";
import type { WhatsAppConversation, WhatsAppTenantWithSecrets } from "./types.js";
import type { TenantWorkerManager } from "./worker-manager.js";

interface TwilioInboundPayload {
  MessageSid: string;
  Body: string;
  From: string;
  To: string;
  ProfileName?: string;
}

export interface InboundWhatsAppPayload {
  messageSid: string;
  body: string;
  from: string;
  to: string;
  profileName?: string;
  tenantId?: string;
}

export interface ReplyResult {
  providerMessageId: string;
  fromNumber: string;
  status: string;
}

export type TenantReplySender = (input: {
  tenant: WhatsAppTenantWithSecrets;
  to: string;
  body: string;
  conversationId?: string;
}) => Promise<ReplyResult>;

export interface InboundProcessingResult {
  tenantId: string;
  conversationId?: string;
  deduped: boolean;
  applied: boolean;
  replyBody?: string;
  providerReplyId?: string;
  ignoredReason?: string;
}

interface ConversationContext {
  conversation: WhatsAppConversation;
  doctorId: string;
  patientId: string;
  language: SupportedLanguage;
}

const AGENT_SPECIALTY_ALIAS: Record<string, string> = {
  health_assistant: "family_medicine",
  family_medicine_assistant: "family_medicine",
  cardio_assistant: "cardiology",
  diabetes_assistant: "endocrinology",
  sugar_assistant: "endocrinology",
  ortho_assistant: "orthopedics",
  child_assistant: "pediatrics",
  women_health_assistant: "obstetrics_gynecology"
};

function detectLanguage(body: string, fallback: SupportedLanguage): SupportedLanguage {
  if (/[\u0900-\u097F]/.test(body)) {
    return "hi";
  }
  return fallback;
}

function extractConnectSpecialty(body: string): string | null {
  const match = body.trim().toLowerCase().match(/^connect me with\s+([a-z0-9_\-\s]+)$/i);
  if (!match?.[1]) return null;
  const alias = match[1].trim().replace(/\s+/g, "_");
  return normalizeSpecialtyId(alias) ?? AGENT_SPECIALTY_ALIAS[alias] ?? null;
}

function sanitizeReply(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "I received your message. Please share more details.";
  return trimmed.length <= 1400 ? trimmed : `${trimmed.slice(0, 1397)}...`;
}

function createDryRunAIClient(): AIClient {
  return new StubAIClient((systemPrompt) => {
    if (systemPrompt.includes("SOAP")) {
      return JSON.stringify({
        subjective: "Patient shared symptoms in chat.",
        objective: "Chat-based intake only.",
        assessment: "Further evaluation required.",
        plan: "Escalate to clinician review."
      });
    }
    if (systemPrompt.includes("prior authorization")) {
      return JSON.stringify({ clinicalJustification: "Clinical criteria documented from WhatsApp triage." });
    }
    if (systemPrompt.includes("follow-up")) {
      return JSON.stringify({ body: "Please follow your care plan and contact your clinic for urgent issues." });
    }
    return JSON.stringify([
      {
        type: "protocol_suggestion",
        severity: "info",
        message: "Preliminary triage complete. A clinician should confirm next actions.",
        sources: ["internal-guideline"]
      }
    ]);
  });
}

function createTenantAIClient(apiKey: string, model: string): AIClient {
  const cfg = getConfig();
  if (cfg.dryRun || cfg.agenticWhatsappDryRun || !apiKey.trim()) {
    return createDryRunAIClient();
  }
  return new AnthropicClient(apiKey, model);
}

function ensureTenantDoctorId(tenantId: string, tenantName: string, specialtyId: string, preferredDoctorId?: string): string {
  if (preferredDoctorId && getDoctorById(preferredDoctorId)) {
    return preferredDoctorId;
  }

  const fallbackId = `wa_doc_${tenantId.replace(/[^a-zA-Z0-9_]/g, "")}`;
  if (getDoctorById(fallbackId)) {
    return fallbackId;
  }

  try {
    const created = addDoctor({
      id: fallbackId,
      name: `${tenantName} Virtual Care`,
      specialty: specialtyId
    });
    return created.id;
  } catch (error) {
    const existing = getDoctorById(fallbackId);
    if (existing) return existing.id;
    throw error;
  }
}

function ensureConversationContext(input: {
  tenantId: string;
  tenantName: string;
  tenantDoctorId?: string;
  userPhone: string;
  userDisplayName?: string;
  specialtyId: string;
  language: SupportedLanguage;
  lastInboundMessageSid: string;
}): ConversationContext {
  const doctorId = ensureTenantDoctorId(input.tenantId, input.tenantName, input.specialtyId, input.tenantDoctorId);
  const existing = getWhatsAppConversationByTenantAndUser(input.tenantId, input.userPhone);
  if (existing) {
    const next = upsertWhatsAppConversation({
      tenantId: input.tenantId,
      userPhone: input.userPhone,
      patientId: existing.patientId,
      doctorId: existing.doctorId,
      specialtyId: existing.specialtyId,
      language: input.language,
      lastInboundMessageSid: input.lastInboundMessageSid
    });
    return {
      conversation: next,
      doctorId: next.doctorId,
      patientId: next.patientId,
      language: next.language
    };
  }

  const patient = addPatient({
    doctorId,
    name: input.userDisplayName?.trim() || `WhatsApp ${input.userPhone}`,
    phone: input.userPhone
  });
  const conversation = upsertWhatsAppConversation({
    tenantId: input.tenantId,
    userPhone: input.userPhone,
    patientId: patient.id,
    doctorId,
    specialtyId: input.specialtyId,
    language: input.language,
    lastInboundMessageSid: input.lastInboundMessageSid
  });
  return {
    conversation,
    doctorId,
    patientId: patient.id,
    language: conversation.language
  };
}

function formatConnectReply(specialtyId: string, language: SupportedLanguage): string {
  if (language === "hi") {
    return `कनेक्शन सफल। अब आपको ${specialtyId.replace(/_/g, " ")} एजेंट से सहायता मिलेगी।`;
  }
  return `Connected successfully. You are now routed to ${specialtyId.replace(/_/g, " ")} support.`;
}

export async function processInboundWhatsAppMessage(
  payload: InboundWhatsAppPayload,
  workers: TenantWorkerManager,
  replySender: TenantReplySender
): Promise<InboundProcessingResult> {
  const inboundSid = payload.messageSid?.trim() || makeId("wa_inbound");
  const from = normalizeWhatsAppNumber(payload.from);
  const to = normalizeWhatsAppNumber(payload.to);
  const body = (payload.body ?? "").trim();
  if (!from || !to || !body) {
    return {
      tenantId: "",
      deduped: false,
      applied: false,
      ignoredReason: "invalid_inbound_payload"
    };
  }

  const tenant =
    (payload.tenantId ? getWhatsAppTenantWithSecretsById(payload.tenantId) : null) ??
    getWhatsAppTenantWithSecretsByNumber(to);
  if (!tenant) {
    return {
      tenantId: "",
      deduped: false,
      applied: false,
      ignoredReason: "tenant_not_found"
    };
  }
  if (tenant.status === "connected") {
    workers.connect(tenant);
  } else {
    workers.disconnect(tenant);
  }

  const inboundRecord = recordWhatsAppMessageEvent({
    tenantId: tenant.id,
    direction: "inbound",
    providerMessageId: inboundSid,
    fromPhone: from,
    toPhone: to,
    body,
    status: "received",
    metadata: JSON.stringify({
      profileName: payload.profileName ?? null
    })
  });
  if (!inboundRecord.accepted) {
    return {
      tenantId: tenant.id,
      conversationId: inboundRecord.event.conversationId,
      deduped: true,
      applied: false,
      ignoredReason: "duplicate_inbound_event"
    };
  }

  if (tenant.status !== "connected") {
    return {
      tenantId: tenant.id,
      deduped: false,
      applied: false,
      ignoredReason: "tenant_disconnected"
    };
  }

  const language = detectLanguage(body, tenant.defaultLanguage);
  const context = ensureConversationContext({
    tenantId: tenant.id,
    tenantName: tenant.displayName,
    tenantDoctorId: tenant.defaultDoctorId,
    userPhone: from,
    userDisplayName: payload.profileName,
    specialtyId: tenant.defaultSpecialtyId,
    language,
    lastInboundMessageSid: inboundSid
  });
  workers.noteInbound(tenant.id);

  const connectSpecialtyId = extractConnectSpecialty(body);
  if (connectSpecialtyId) {
    const routedConversation = upsertWhatsAppConversation({
      tenantId: tenant.id,
      userPhone: from,
      patientId: context.patientId,
      doctorId: context.doctorId,
      specialtyId: connectSpecialtyId,
      language,
      lastInboundMessageSid: inboundSid
    });
    const connectReply = formatConnectReply(connectSpecialtyId, language);
    const outbound = await replySender({
      tenant,
      to: from,
      body: connectReply,
      conversationId: routedConversation.id
    });
    workers.noteOutbound(tenant.id);
    return {
      tenantId: tenant.id,
      conversationId: routedConversation.id,
      deduped: false,
      applied: true,
      replyBody: connectReply,
      providerReplyId: outbound.providerMessageId
    };
  }

  const aiModel = tenant.aiModel || getConfig().aiModel;
  const aiClient = createTenantAIClient(decryptSecret(tenant.anthropicApiKey), aiModel);
  const messaging =
    tenant.provider === "twilio" &&
    tenant.twilioAccountSid &&
    tenant.twilioAuthToken &&
    tenant.twilioFromNumber
      ? new TenantTwilioMessagingAdapter({
          accountSid: tenant.twilioAccountSid,
          authToken: decryptSecret(tenant.twilioAuthToken),
          fromNumber: tenant.twilioFromNumber
        })
      : new StubMessagingAdapter();
  const workflow = tenant.defaultWorkflow;
  const requestId = `wa-${inboundSid}`;
  const actorId = `whatsapp:${from}`;

  let replyBody = "";
  try {
    const turn = await runChatWorkflowTurn({
      runtime: { aiClient, messaging },
      workflow,
      specialtyId: context.conversation.specialtyId || tenant.defaultSpecialtyId,
      doctorId: context.doctorId,
      patientId: context.patientId,
      messageText: body,
      language,
      dryRun: getConfig().dryRun,
      requestId,
      actorId,
      confirm: true
    });

    replyBody = turn.assistantText;
    if (!turn.ok) {
      logger.warn("whatsapp.workflow.failed", {
        tenantId: tenant.id,
        workflow,
        message: turn.error.message
      });
      workers.noteError(tenant.id, turn.error.message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    workers.noteError(tenant.id, message);
    logger.error("whatsapp.workflow.exception", {
      tenantId: tenant.id,
      workflow,
      message
    });
    replyBody = language === "hi"
      ? "अभी सहायक उपलब्ध नहीं है। कृपया कुछ देर बाद दोबारा प्रयास करें या क्लिनिक से संपर्क करें।"
      : "Assistant is temporarily unavailable. Please try again shortly or contact your clinic.";
  }

  const outbound = await replySender({
    tenant,
    to: from,
    body: replyBody,
    conversationId: context.conversation.id
  });
  workers.noteOutbound(tenant.id);

  return {
    tenantId: tenant.id,
    conversationId: context.conversation.id,
    deduped: false,
    applied: true,
    replyBody,
    providerReplyId: outbound.providerMessageId
  };
}

async function sendTenantTwilioReply(input: {
  tenant: WhatsAppTenantWithSecrets;
  to: string;
  body: string;
  conversationId?: string;
}): Promise<ReplyResult> {
  const cfg = getConfig();
  const replyText = sanitizeReply(input.body);
  let providerMessageId = makeId("wa_out");
  const fromNumber = input.tenant.twilioFromNumber || input.tenant.whatsappNumber;
  const twilioAuthToken = input.tenant.twilioAuthToken ? decryptSecret(input.tenant.twilioAuthToken) : "";

  if (input.tenant.provider !== "twilio") {
    throw new Error("Tenant is not configured for Twilio transport");
  }
  if (!input.tenant.twilioAccountSid || !twilioAuthToken || !fromNumber) {
    throw new Error("Twilio credentials are incomplete for tenant");
  }

  if (!(cfg.dryRun || cfg.agenticWhatsappDryRun)) {
    const messaging = new TenantTwilioMessagingAdapter({
      accountSid: input.tenant.twilioAccountSid,
      authToken: twilioAuthToken,
      fromNumber
    });
    const sent = await messaging.send({
      to: input.to,
      body: replyText,
      channel: "whatsapp"
    });
    providerMessageId = sent.id;
  }

  recordWhatsAppMessageEvent({
    tenantId: input.tenant.id,
    conversationId: input.conversationId,
    direction: "outbound",
    providerMessageId,
    fromPhone: fromNumber,
    toPhone: input.to,
    body: replyText,
    status: cfg.dryRun || cfg.agenticWhatsappDryRun ? "dry_run_sent" : "sent",
    metadata: "{}"
  });

  return {
    providerMessageId,
    fromNumber,
    status: cfg.dryRun || cfg.agenticWhatsappDryRun ? "dry_run_sent" : "sent"
  };
}

export async function processTwilioInboundWhatsApp(
  payload: TwilioInboundPayload,
  workers: TenantWorkerManager
): Promise<InboundProcessingResult> {
  return processInboundWhatsAppMessage(
    {
      messageSid: payload.MessageSid,
      body: payload.Body,
      from: payload.From,
      to: payload.To,
      profileName: payload.ProfileName
    },
    workers,
    async ({ tenant, to, body, conversationId }) => sendTenantTwilioReply({ tenant, to, body, conversationId })
  );
}

export function validateWebhookPayload(body: Record<string, string>): TwilioInboundPayload | null {
  const messageSid = body.MessageSid?.trim();
  const from = body.From?.trim();
  const to = body.To?.trim();
  const text = body.Body?.trim();
  if (!messageSid || !from || !to || !text) {
    return null;
  }
  return {
    MessageSid: messageSid,
    Body: text,
    From: from,
    To: to,
    ProfileName: body.ProfileName?.trim() || undefined
  };
}
