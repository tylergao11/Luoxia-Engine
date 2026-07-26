import {
  CONTRACT_REF,
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
} from "@luoxia/contracts-runtime";

import type { ServerEnvelopeDocument } from "./command-finalizer.js";
import type { DialogueCommandOrchestrator } from "./dialogue-command-orchestrator.js";
import type { EventCardCommandOrchestrator } from "./event-card-command-orchestrator.js";
import type { PlayerDayCommandOrchestrator } from "./player-day-command-orchestrator.js";

export interface ClientCommandRouter {
  execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]>;
}

export interface ClientCommandRouterDependencies {
  readonly contracts: ContractValidator;
  readonly dialogues: DialogueCommandOrchestrator;
  readonly eventCards: EventCardCommandOrchestrator;
  readonly playerDays: PlayerDayCommandOrchestrator;
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
        case "dialogue.start":
        case "dialogue.continue":
          return dependencies.dialogues.execute(envelope.value);
        case "event_card.trigger":
          return dependencies.eventCards.execute(envelope.value);
        case "player_day.end":
          return dependencies.playerDays.execute(envelope.value);
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
