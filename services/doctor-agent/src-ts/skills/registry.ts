import { listSpecialtyDirectory, parseLanguage, parseSetting } from "../orchestration/router.js";
import { runChatWorkflowTurn } from "../chat/orchestrator.js";
import { appError } from "../errors.js";
import type { SkillDefinition, SkillExecutionContext, SkillMetadata } from "./types.js";

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const SKILLS: SkillDefinition[] = [
  {
    metadata: {
      name: "workflow.execute",
      description: "Execute a clinical workflow turn and return assistant response plus workflow outputs.",
      risk: "MEDIUM",
      inputSchema: {
        type: "object",
        required: ["messageText"],
        properties: {
          workflow: { type: "string" },
          specialtyId: { type: "string" },
          doctorId: { type: "string" },
          patientId: { type: "string" },
          messageText: { type: "string" },
          language: { type: "string", enum: ["en", "hi"] },
          attachments: {
            type: "array",
            items: {
              type: "object",
              required: ["type", "url"],
              properties: {
                type: { type: "string" },
                url: { type: "string" },
                mimeType: { type: "string" }
              }
            }
          }
        }
      }
    },
    execute: async (input: unknown, context: SkillExecutionContext): Promise<unknown> => {
      const body = asObject(input);
      if (!body) {
        return appError("VALIDATION_ERROR", "Skill input must be a JSON object");
      }
      const messageText = requireString(body, "messageText");
      const doctorId = requireString(body, "doctorId");
      if (!messageText) {
        return appError("VALIDATION_ERROR", "messageText is required");
      }
      if (!doctorId) {
        return appError("VALIDATION_ERROR", "doctorId is required");
      }
      const parsedLanguage = parseLanguage(body.language);
      const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
      const attachments = rawAttachments
        .map((attachment) => asObject(attachment))
        .filter((attachment): attachment is Record<string, unknown> => Boolean(attachment))
        .map((attachment) => ({
          type: typeof attachment.type === "string" ? attachment.type : "document",
          url: typeof attachment.url === "string" ? attachment.url : "",
          mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : undefined
        }))
        .filter((attachment) => attachment.url.length > 0);

      return runChatWorkflowTurn({
        runtime: context.runtime,
        workflow: body.workflow,
        specialtyId: body.specialtyId,
        doctorId,
        patientId: typeof body.patientId === "string" ? body.patientId : undefined,
        messageText,
        language: parsedLanguage ?? "en",
        attachments,
        dryRun: context.dryRun,
        requestId: context.requestId,
        actorId: context.actorId,
        confirm: context.confirm
      });
    }
  },
  {
    metadata: {
      name: "specialties.list",
      description: "Return available specialty directory for optional care setting/language filters.",
      risk: "LOW",
      inputSchema: {
        type: "object",
        properties: {
          setting: { type: "string", enum: ["clinic", "hospital"] },
          language: { type: "string", enum: ["en", "hi"] }
        }
      }
    },
    execute: async (input: unknown): Promise<unknown> => {
      const body = asObject(input) ?? {};
      const setting = parseSetting(body.setting);
      const language = parseLanguage(body.language) ?? "en";
      if (body.setting !== undefined && !setting) {
        return appError("VALIDATION_ERROR", "setting must be clinic or hospital");
      }
      return listSpecialtyDirectory({
        setting: setting ?? undefined,
        language
      });
    }
  }
];

export function listSkillMetadata(): SkillMetadata[] {
  return SKILLS.map((skill) => skill.metadata);
}

export function getSkill(name: string): SkillDefinition | undefined {
  return SKILLS.find((skill) => skill.metadata.name === name);
}

export async function executeSkill(
  name: string,
  input: unknown,
  context: SkillExecutionContext
): Promise<unknown> {
  const skill = getSkill(name);
  if (!skill) {
    return appError("NOT_FOUND", `Skill not found: ${name}`);
  }
  return skill.execute(input, context);
}
