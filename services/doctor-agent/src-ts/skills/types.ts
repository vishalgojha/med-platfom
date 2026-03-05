import type { RuntimeDeps } from "../runtime.js";

export type SkillRisk = "LOW" | "MEDIUM" | "HIGH";

export interface SkillMetadata {
  name: string;
  description: string;
  risk: SkillRisk;
  inputSchema: Record<string, unknown>;
}

export interface SkillExecutionContext {
  runtime: RuntimeDeps;
  requestId: string;
  actorId: string;
  confirm: boolean;
  dryRun: boolean;
}

export interface SkillDefinition {
  metadata: SkillMetadata;
  execute(input: unknown, context: SkillExecutionContext): Promise<unknown>;
}
