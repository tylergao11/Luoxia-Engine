import type { StoredReceivedCommand } from "./command-journal.js";

export type DialogueDirectorRequestKind =
  | "director.dialogue_events"
  | "director.system_dialogue"
  | "director.goal_plan"
  | "director.definition_draft";

export type DialogueDirectorProposalKind =
  | "definition"
  | "goal_plan"
  | "event_card";

export function dialogueDirectorProposalKind(
  requestKind: DialogueDirectorRequestKind,
): DialogueDirectorProposalKind | undefined {
  switch (requestKind) {
    case "director.dialogue_events":
      return "event_card";
    case "director.goal_plan":
      return "goal_plan";
    case "director.definition_draft":
      return "definition";
    case "director.system_dialogue":
      return undefined;
  }
}

export interface DialogueDirectorRunRecord {
  readonly sessionId: string;
  readonly commandId: string;
  readonly worldId: string;
  readonly dialogueId: string;
  readonly requestKind: DialogueDirectorRequestKind;
  readonly modelRequestId: string;
  readonly responseTurnId: string | undefined;
  readonly responseRuleRequestId: string | undefined;
}

interface DialogueProposalRunBase {
  readonly proposalId: string;
  readonly ordinal: number;
  readonly ruleRequestId: string;
  readonly preparedAt: string;
}

export interface DialogueDefinitionRunRecord
  extends DialogueProposalRunBase {
  readonly proposalKind: "definition";
  readonly definitionId: string;
}

export interface DialogueGoalPlanRunRecord
  extends DialogueProposalRunBase {
  readonly proposalKind: "goal_plan";
  readonly planId: string;
}

export interface DialogueEventCardRunRecord
  extends DialogueProposalRunBase {
  readonly proposalKind: "event_card";
}

export interface DialogueDirectorProposalRuns {
  readonly definitions: readonly DialogueDefinitionRunRecord[];
  readonly goalPlans: readonly DialogueGoalPlanRunRecord[];
  readonly eventCards: readonly DialogueEventCardRunRecord[];
}

export interface DialogueDirectorRunJournal {
  prepare(input: {
    readonly command: StoredReceivedCommand;
    readonly dialogueId: string;
    readonly requestKind: DialogueDirectorRequestKind;
  }): Promise<DialogueDirectorRunRecord>;

  /**
   * Atomically binds the exact ordered proposal identity set owned by this
   * operation-specific Director response. Definition/GoalPlan records also
   * own the Server-generated WorldState identity.
   */
  prepareProposals(input: {
    readonly run: DialogueDirectorRunRecord;
  }): Promise<DialogueDirectorProposalRuns>;
}
