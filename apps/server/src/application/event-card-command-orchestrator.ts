import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
} from "@luoxia/contracts-runtime";

import type { CommandJournal } from "./command-journal.js";
import type {
  CommandFinalizer,
  ServerEnvelopeDocument,
} from "./command-finalizer.js";
import type {
  EventCardClickCommitResult,
  WorldMutationOrchestrator,
} from "./world-mutation-orchestrator.js";

const EVENT_CARD_REJECTION_FAULTS = new Set([
  "runtime.packet_builder.event_card_match",
  "runtime.packet_builder.event_card_unavailable",
  "runtime.packet_builder.event_card_control_mismatch",
]);

export interface EventCardCommandOrchestrator {
  execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]>;
}

export interface EventCardCommandOrchestratorDependencies {
  readonly contracts: ContractValidator;
  readonly commands: CommandJournal;
  readonly mutations: WorldMutationOrchestrator;
  readonly finalizer: CommandFinalizer;
}

export function createEventCardCommandOrchestrator(
  dependencies: EventCardCommandOrchestratorDependencies,
): EventCardCommandOrchestrator {
  return new DefaultEventCardCommandOrchestrator(dependencies);
}

class DefaultEventCardCommandOrchestrator
  implements EventCardCommandOrchestrator
{
  readonly #contracts: ContractValidator;
  readonly #commands: CommandJournal;
  readonly #mutations: WorldMutationOrchestrator;
  readonly #finalizer: CommandFinalizer;

  public constructor(
    dependencies: EventCardCommandOrchestratorDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#commands = dependencies.commands;
    this.#mutations = dependencies.mutations;
    this.#finalizer = dependencies.finalizer;
  }

  public async execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]> {
    const envelope = this.#contracts.assertObject(
      CONTRACT_REF.clientEnvelope,
      clientEnvelopeCandidate,
    );
    const message = expectJsonObject(
      expectProperty(envelope.value, "message", "ClientEnvelope"),
      "ClientEnvelope.message",
    );
    const candidateKind = expectString(
      message,
      "type",
      "ClientMessage",
    );
    if (candidateKind !== "event_card.trigger") {
      throw new EngineFault(
        "event_card.orchestration.command_kind_invalid",
        "EventCard orchestrator accepts only event_card.trigger",
        { command_kind: candidateKind },
      );
    }

    const stored = await this.#commands.receive(envelope.value);
    if (stored.commandKind !== "event_card.trigger") {
      throw new EngineFault(
        "event_card.orchestration.command_kind_invalid",
        "EventCard orchestrator recovered a command of another kind",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
          command_kind: stored.commandKind,
        },
      );
    }
    if (stored.phase === "completed") {
      const replay = await this.#finalizer.readCompleted(
        stored.session.sessionId,
        stored.commandId,
      );
      if (replay === undefined) {
        throw new EngineFault(
          "event_card.orchestration.completed_output_missing",
          "Completed EventCard command has no replayable ServerEnvelope outbox",
          {
            session_id: stored.session.sessionId,
            command_id: stored.commandId,
          },
        );
      }
      return replay;
    }
    if (stored.eventCardExecution === undefined) {
      throw new EngineFault(
        "event_card.orchestration.execution_identity_missing",
        "Received EventCard command has no persisted packet identity",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
        },
      );
    }

    const eventCardId = expectString(
      stored.message,
      "event_card_id",
      "EventCardTrigger",
    );
    let commit: EventCardClickCommitResult;
    try {
      commit = await this.#mutations.commitEventCardClick({
        worldId: stored.session.worldId,
        controlBindingId: stored.session.controlBindingId,
        commandId: stored.commandId,
        packetId: stored.eventCardExecution.packetId,
        eventCardId,
      });
    } catch (error: unknown) {
      if (
        !(error instanceof EngineFault) ||
        !EVENT_CARD_REJECTION_FAULTS.has(error.code)
      ) {
        throw error;
      }
      return this.#finalizer.completeRejected({
        sessionId: stored.session.sessionId,
        commandId: stored.commandId,
        code: "event_card.not_available",
      });
    }

    const expectedRevision = stored.session.worldRevision + 1;
    if (!Number.isSafeInteger(expectedRevision)) {
      throw new EngineFault(
        "event_card.orchestration.world_revision_exhausted",
        "EventCard command cannot advance the world revision safely",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
          accepted_world_revision: stored.session.worldRevision,
        },
      );
    }
    const actualRevision = expectInteger(
      commit.result.value,
      "world_revision",
      "ApplyPacketResult",
    );
    if (actualRevision !== expectedRevision) {
      throw new EngineFault(
        "event_card.orchestration.commit_revision_mismatch",
        "EventCard packet commit returned an unexpected world revision",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
          expected_world_revision: expectedRevision,
          actual_world_revision: actualRevision,
        },
      );
    }

    return this.#finalizer.completeEventCardAccepted({
      sessionId: stored.session.sessionId,
      commandId: stored.commandId,
      finalWorldRevision: actualRevision,
      eventCardId,
      branch: commit.branch,
    });
  }
}
