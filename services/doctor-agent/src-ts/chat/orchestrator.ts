import type { SupportedLanguage } from "@med-platform/clinical-specialties";
import { createCapabilityHandlers, RuntimeDeps } from "../runtime.js";
import {
  executeAgentWorkflow,
  normalizeSpecialtyId,
  parseWorkflow,
  type OrchestrationWorkflow,
  type WorkflowExecutionSuccess
} from "../orchestration/router.js";
import { appError } from "../errors.js";
import type { StructuredError } from "../types.js";

function hasStructuredError(value: unknown): value is StructuredError {
  if (!value || typeof value !== "object") return false;
  const obj = value as { ok?: unknown; code?: unknown; message?: unknown };
  return obj.ok === false && typeof obj.code === "string" && typeof obj.message === "string";
}

function sanitizeReply(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "I received your message. Please share more details.";
  return trimmed.length <= 1400 ? trimmed : `${trimmed.slice(0, 1397)}...`;
}

export function formatErrorReply(language: SupportedLanguage): string {
  if (language === "hi") {
    return "अभी सहायक उपलब्ध नहीं है। कृपया कुछ देर बाद दोबारा प्रयास करें या क्लिनिक से संपर्क करें।";
  }
  return "Assistant is temporarily unavailable. Please try again shortly or contact your clinic.";
}

export function formatWorkflowOutput(output: unknown, language: SupportedLanguage): string {
  const englishHeader = "Here is the initial clinical guidance:";
  const hindiHeader = "यह प्रारंभिक क्लिनिकल मार्गदर्शन है:";

  if (Array.isArray(output)) {
    const messages = output
      .map((entry) => (entry && typeof entry === "object" ? (entry as { message?: unknown }).message : null))
      .filter((message): message is string => typeof message === "string" && message.trim().length > 0)
      .slice(0, 4);
    if (messages.length > 0) {
      const lines = messages.map((message, index) => `${index + 1}. ${message.trim()}`);
      const footer =
        language === "hi"
          ? "आपात स्थिति में तुरंत नज़दीकी अस्पताल जाएं।"
          : "If this is urgent, please go to the nearest emergency department.";
      return sanitizeReply(`${language === "hi" ? hindiHeader : englishHeader}\n${lines.join("\n")}\n${footer}`);
    }
  }

  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.plan === "string" && record.plan.trim()) {
      const intro = language === "hi" ? "अगला कदम:" : "Next step:";
      return sanitizeReply(`${intro} ${record.plan.trim()}`);
    }
  }

  if (typeof output === "string" && output.trim()) {
    return sanitizeReply(output);
  }

  return language === "hi"
    ? "आपका संदेश प्राप्त हुआ। कृपया लक्षण और अवधि बताएं ताकि बेहतर सहायता दी जा सके।"
    : "Message received. Please share symptoms and duration so I can assist better.";
}

export function buildWorkflowPayload(
  workflow: OrchestrationWorkflow,
  messageText: string,
  language: SupportedLanguage,
  attachments?: Array<{ type: string; url: string; mimeType?: string }>
): Record<string, unknown> {
  const languageInstruction =
    language === "hi"
      ? "Respond in Hindi for patient-facing content."
      : "Respond in English for patient-facing content.";
  const attachmentSummary =
    attachments && attachments.length > 0
      ? `\n\nAttachments:\n${attachments
          .slice(0, 5)
          .map((attachment, index) => `${index + 1}. ${attachment.type} ${attachment.url}`)
          .join("\n")}`
      : "";
  const finalMessage = `${messageText}${attachmentSummary}`;

  if (workflow === "consultation_documentation") {
    return {
      transcript: finalMessage,
      query: languageInstruction
    };
  }
  if (workflow === "follow_up_outreach") {
    return {
      trigger: "custom",
      customMessage: finalMessage,
      channel: "whatsapp",
      sendNow: false
    };
  }
  if (workflow === "prior_authorization") {
    return {
      procedureCode: "UNSPECIFIED",
      diagnosisCodes: ["UNSPECIFIED"],
      insurerId: "UNSPECIFIED",
      submit: false
    };
  }
  return {
    query: `${finalMessage}\n\n${languageInstruction}`
  };
}

export interface ChatAttachmentInput {
  type: string;
  url: string;
  mimeType?: string;
}

export interface RunChatWorkflowTurnInput {
  workflow?: unknown;
  specialtyId?: unknown;
  doctorId: string;
  patientId?: string;
  messageText: string;
  language: SupportedLanguage;
  attachments?: ChatAttachmentInput[];
  dryRun: boolean;
  requestId: string;
  actorId: string;
  confirm?: boolean;
  runtime: RuntimeDeps;
}

export type RunChatWorkflowTurnResult =
  | {
      ok: true;
      workflow: OrchestrationWorkflow;
      specialtyId: string;
      assistantText: string;
      workflowOutput: WorkflowExecutionSuccess;
    }
  | {
      ok: false;
      workflow: OrchestrationWorkflow;
      specialtyId: string;
      assistantText: string;
      error: StructuredError;
    };

export async function runChatWorkflowTurn(input: RunChatWorkflowTurnInput): Promise<RunChatWorkflowTurnResult> {
  const workflow = parseWorkflow(input.workflow) ?? "triage_intake";
  const specialtyId = normalizeSpecialtyId(input.specialtyId) ?? "family_medicine";
  const handlers = createCapabilityHandlers(input.runtime);
  const payload = buildWorkflowPayload(workflow, input.messageText, input.language, input.attachments);

  try {
    const workflowOutput = await executeAgentWorkflow(
      {
        workflow,
        specialtyId,
        doctorId: input.doctorId,
        patientId: input.patientId,
        payload,
        dryRun: input.dryRun
      },
      handlers,
      {
        confirm: input.confirm ?? true,
        requestId: input.requestId,
        actorId: input.actorId
      }
    );

    if (hasStructuredError(workflowOutput)) {
      return {
        ok: false,
        workflow,
        specialtyId,
        assistantText: formatErrorReply(input.language),
        error: workflowOutput
      };
    }

    const stepOutput = workflowOutput.steps[workflowOutput.steps.length - 1]?.output;
    return {
      ok: true,
      workflow,
      specialtyId,
      assistantText: formatWorkflowOutput(stepOutput, input.language),
      workflowOutput
    };
  } catch (error) {
    return {
      ok: false,
      workflow,
      specialtyId,
      assistantText: formatErrorReply(input.language),
      error: appError("EXECUTION_FAILED", error instanceof Error ? error.message : String(error))
    };
  }
}
