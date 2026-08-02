import {
  EngineFault,
  expectString,
  type ContractValidator,
  type JsonObject,
} from "@luoxia/contracts-runtime";

import { assertUuid } from "./persistence-support.js";

/** Human packet + responder packet; EventCard publications are extra revisions. */
export const DIALOGUE_PACKET_COUNT = 2;

export interface DialogueDirectorIdentityRow {
  readonly character_model_request_id: string | null;
  readonly character_turn_id: string | null;
  readonly director_dialogue_events_model_request_id: string | null;
  readonly director_system_model_request_id: string | null;
  readonly director_system_response_turn_id: string | null;
  readonly director_goal_plan_model_request_id: string | null;
  readonly director_definition_draft_model_request_id: string | null;
}

export interface DialogueResponseIdentity {
  readonly kind: "character_mind" | "director_system" | undefined;
  readonly turnId: string | undefined;
  readonly modelRequestId: string | undefined;
  readonly dialogueEventsModelRequestId: string | undefined;
}

/**
 * Close the dialogue responder identity from command-row + director-run joins.
 * Live dialogue always funds `director.dialogue_events`; a null events request
 * id is only tolerated for historical remaining===0 skip rows. When a run was
 * prepared, the JOIN populates dialogueEventsModelRequestId; proposal coverage
 * still hard-fails incomplete verified outputs.
 */
export function readDialogueResponseIdentity(
  contracts: ContractValidator,
  row: DialogueDirectorIdentityRow,
  message: JsonObject,
  isDialogue: boolean,
  sessionId: string,
  commandId: string,
): DialogueResponseIdentity {
  const directorFields = [
    row.director_dialogue_events_model_request_id,
    row.director_system_model_request_id,
    row.director_system_response_turn_id,
    row.director_goal_plan_model_request_id,
    row.director_definition_draft_model_request_id,
  ];
  const hasDirectorRun = directorFields.some((value) => value !== null);
  if (!isDialogue) {
    if (hasDirectorRun) {
      throw new EngineFault(
        "command.finalizer.database_corrupt",
        "Non-dialogue command unexpectedly owns a Dialogue Director run",
        { session_id: sessionId, command_id: commandId },
      );
    }
    return Object.freeze({
      kind: undefined,
      turnId: undefined,
      modelRequestId: undefined,
      dialogueEventsModelRequestId: undefined,
    });
  }
  const dialogueEventsModelRequestId =
    row.director_dialogue_events_model_request_id === null
      ? undefined
      : assertUuid(
          contracts,
          row.director_dialogue_events_model_request_id,
        );
  const systemModelRequestId =
    row.director_system_model_request_id === null
      ? undefined
      : assertUuid(
          contracts,
          row.director_system_model_request_id,
        );
  const systemResponseTurnId =
    row.director_system_response_turn_id === null
      ? undefined
      : assertUuid(
          contracts,
          row.director_system_response_turn_id,
        );
  const goalPlanModelRequestId =
    row.director_goal_plan_model_request_id === null
      ? undefined
      : assertUuid(
          contracts,
          row.director_goal_plan_model_request_id,
        );
  const definitionDraftModelRequestId =
    row.director_definition_draft_model_request_id === null
      ? undefined
      : assertUuid(
          contracts,
          row.director_definition_draft_model_request_id,
        );
  const interactionKind = expectString(
    message,
    "interaction_kind",
    "Dialogue command",
  );
  if (
    (systemModelRequestId === undefined) !==
      (systemResponseTurnId === undefined) ||
    (goalPlanModelRequestId !== undefined &&
      definitionDraftModelRequestId !== undefined) ||
    ((goalPlanModelRequestId !== undefined ||
      definitionDraftModelRequestId !== undefined) &&
      systemModelRequestId === undefined)
  ) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "Dialogue Director runs do not define one closed response identity",
      {
        session_id: sessionId,
        command_id: commandId,
      },
    );
  }
  if (
    systemModelRequestId !== undefined &&
    systemResponseTurnId !== undefined
  ) {
    const planningIdentityMatches =
      (interactionKind === "dialogue" &&
        goalPlanModelRequestId === undefined &&
        definitionDraftModelRequestId === undefined) ||
      (interactionKind === "goal_plan" &&
        goalPlanModelRequestId !== undefined &&
        definitionDraftModelRequestId === undefined) ||
      (interactionKind === "definition_draft" &&
        goalPlanModelRequestId === undefined &&
        definitionDraftModelRequestId !== undefined);
    if (!planningIdentityMatches) {
      throw new EngineFault(
        "command.finalizer.database_corrupt",
        "System Director runs do not match the GUI-selected interaction kind",
        {
          session_id: sessionId,
          command_id: commandId,
          interaction_kind: interactionKind,
        },
      );
    }
    // Live path always funds dialogue_events; null id only for historical
    // rows completed under the retired remaining===0 skip policy.
    return Object.freeze({
      kind: "director_system",
      turnId: systemResponseTurnId,
      modelRequestId: systemModelRequestId,
      dialogueEventsModelRequestId,
    });
  }
  // Character Mind NPC dialogue: response identity is the pre-allocated
  // character turn/model ids. dialogue_events is required on the live path;
  // null id only for historical remaining===0 skip rows.
  if (
    interactionKind === "dialogue" &&
    goalPlanModelRequestId === undefined &&
    definitionDraftModelRequestId === undefined &&
    row.character_model_request_id !== null &&
    row.character_turn_id !== null
  ) {
    return Object.freeze({
      kind: "character_mind",
      turnId: assertUuid(contracts, row.character_turn_id),
      modelRequestId: assertUuid(
        contracts,
        row.character_model_request_id,
      ),
      dialogueEventsModelRequestId,
    });
  }
  if (!hasDirectorRun) {
    return Object.freeze({
      kind: undefined,
      turnId: undefined,
      modelRequestId: undefined,
      dialogueEventsModelRequestId: undefined,
    });
  }
  throw new EngineFault(
    "command.finalizer.database_corrupt",
    "Dialogue Director runs do not define one closed response identity",
    {
      session_id: sessionId,
      command_id: commandId,
    },
  );
}

/**
 * Dialogue start/continue accepted-completion gate. Live path pairs dialogue
 * with dialogue_events; dialogueEventsModelRequestId may still be absent on
 * historical remaining===0 skip rows. Requires two dialogue packets and a
 * closed response turn identity.
 */
export function assertDialogueAcceptedCompletionIdentity(input: {
  readonly sessionId: string;
  readonly commandId: string;
  readonly acceptedWorldRevision: number;
  readonly finalWorldRevision: number;
  readonly responseTurnId: string | undefined;
  readonly commandResponseTurnId: string | undefined;
  readonly dialogueEventsModelRequestId: string | undefined;
  readonly eventCard: unknown | undefined;
  readonly stageInstanceId: string | undefined;
}): void {
  const minimumFinalRevision =
    input.acceptedWorldRevision + DIALOGUE_PACKET_COUNT;
  // dialogueEventsModelRequestId remains optional only for historical skip
  // rows. Live accepted dialogue always prepares dialogue_events.
  if (
    input.eventCard !== undefined ||
    input.stageInstanceId !== undefined ||
    !Number.isSafeInteger(minimumFinalRevision) ||
    input.finalWorldRevision < minimumFinalRevision ||
    input.responseTurnId === undefined ||
    input.commandResponseTurnId === undefined ||
    input.responseTurnId !== input.commandResponseTurnId
  ) {
    throw new EngineFault(
      "dialogue.finalizer.completion_identity_mismatch",
      "Accepted dialogue completion must include its two dialogue packets and only its recoverable post-dialogue publications",
      {
        session_id: input.sessionId,
        command_id: input.commandId,
        accepted_world_revision: input.acceptedWorldRevision,
        minimum_final_world_revision: minimumFinalRevision,
        actual_final_world_revision: input.finalWorldRevision,
        expected_response_turn_id: input.commandResponseTurnId ?? null,
        actual_response_turn_id: input.responseTurnId ?? null,
        dialogue_events_model_request_id:
          input.dialogueEventsModelRequestId ?? null,
      },
    );
  }
}
