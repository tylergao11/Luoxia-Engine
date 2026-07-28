import {
  CONTRACT_REF,
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
} from "@luoxia/contracts-runtime";

import type { DialogueCommandOrchestrator } from "./dialogue-command-orchestrator.js";
import type { DialogueCloseCommandOrchestrator } from "./dialogue-close-command-orchestrator.js";
import type { EventCardCommandOrchestrator } from "./event-card-command-orchestrator.js";
import type { MapMoveCommandOrchestrator } from "./map-move-command-orchestrator.js";
import type { PlayerDayCommandOrchestrator } from "./player-day-command-orchestrator.js";
import type { ServerEnvelopeDocument } from "./server-envelope.js";
import type { SessionSynchronizationService } from "./session-synchronization.js";
import type { StageOutcomeCommandOrchestrator } from "./stage-outcome-command-orchestrator.js";

export interface ClientCommandRouter {
  execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]>;
}

export interface ClientCommandRouterDependencies {
  readonly contracts: ContractValidator;
  readonly dialogues: DialogueCommandOrchestrator;
  readonly dialogueCloses: DialogueCloseCommandOrchestrator;
  readonly eventCards: EventCardCommandOrchestrator;
  readonly mapMoves: MapMoveCommandOrchestrator;
  readonly playerDays: PlayerDayCommandOrchestrator;
  readonly stageOutcomes: StageOutcomeCommandOrchestrator;
  readonly sessionSynchronization: SessionSynchronizationService;
}

export function createClientCommandRouter(
  dependencies: ClientCommandRouterDependencies,
): ClientCommandRouter {
  return Object.freeze({
    execute(
      clientEnvelopeCandidate: unknown,
    ): Promise<readonly ServerEnvelopeDocument[]> {
      const envelope = dependencies.contracts.assertObject(
        CONTRACT_REF.clientEnvelope,
        clientEnvelopeCandidate,
      );
      const message = expectJsonObject(
        expectProperty(envelope.value, "message", "ClientEnvelope"),
        "ClientEnvelope.message",
      );
      const commandKind = expectString(
        message,
        "type",
        "ClientMessage",
      );
      switch (commandKind) {
        case "client.ready":
        case "session.resync_request":
          return dependencies.sessionSynchronization.execute(
            envelope.value,
          );
        case "dialogue.start":
        case "dialogue.continue":
          return dependencies.dialogues.execute(envelope.value);
        case "dialogue.close":
          return dependencies.dialogueCloses.execute(envelope.value);
        case "event_card.trigger":
          return dependencies.eventCards.execute(envelope.value);
        case "map.move":
          return dependencies.mapMoves.execute(envelope.value);
        case "player_day.end":
          return dependencies.playerDays.execute(envelope.value);
        case "stage.outcome_proposal":
          return dependencies.stageOutcomes.execute(envelope.value);
        default:
          throw new EngineFault(
            "client_command.router.unsupported",
            "Client command has no registered Server orchestrator",
            { command_kind: commandKind },
          );
      }
    },
  });
}
