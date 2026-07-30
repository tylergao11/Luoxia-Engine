import {
  CONTRACT_REF,
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
} from "@luoxia/contracts-runtime";

import type { CommandJournal } from "./command-journal.js";
import type { CommandFinalizer } from "./command-finalizer.js";
import type { DayCycleOrchestrator } from "./day-cycle-orchestrator.js";
import type { PlayerDayEndRunJournal } from "./player-day-end-run.js";
import type { ServerEnvelopeDocument } from "./server-envelope.js";

export interface PlayerDayCommandOrchestrator {
  execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]>;
}

export interface PlayerDayCommandOrchestratorDependencies {
  readonly contracts: ContractValidator;
  readonly commands: CommandJournal;
  readonly runs: PlayerDayEndRunJournal;
  readonly dayCycle: DayCycleOrchestrator;
  readonly finalizer: CommandFinalizer;
}

export function createPlayerDayCommandOrchestrator(
  dependencies: PlayerDayCommandOrchestratorDependencies,
): PlayerDayCommandOrchestrator {
  return new DefaultPlayerDayCommandOrchestrator(dependencies);
}

class DefaultPlayerDayCommandOrchestrator
  implements PlayerDayCommandOrchestrator
{
  readonly #contracts: ContractValidator;
  readonly #commands: CommandJournal;
  readonly #runs: PlayerDayEndRunJournal;
  readonly #dayCycle: DayCycleOrchestrator;
  readonly #finalizer: CommandFinalizer;

  public constructor(
    dependencies: PlayerDayCommandOrchestratorDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#commands = dependencies.commands;
    this.#runs = dependencies.runs;
    this.#dayCycle = dependencies.dayCycle;
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
    if (candidateKind !== "player_day.end") {
      throw new EngineFault(
        "player_day.orchestration.command_kind_invalid",
        "Player-day orchestrator accepts only player_day.end",
        { command_kind: candidateKind },
      );
    }

    const stored = await this.#commands.receive(envelope.value);
    if (stored.commandKind !== "player_day.end") {
      throw new EngineFault(
        "player_day.orchestration.command_kind_invalid",
        "Player-day orchestrator recovered a command of another kind",
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
          "player_day.orchestration.completed_output_missing",
          "Completed player-day command has no replayable ServerEnvelope outbox",
          {
            session_id: stored.session.sessionId,
            command_id: stored.commandId,
          },
        );
      }
      return replay;
    }

    const run = await this.#runs.prepare(stored);
    try {
      const result = await this.#dayCycle.endPlayerDay({
        worldId: run.worldId,
        controlBindingId: stored.session.controlBindingId,
        fromDay: run.fromDay,
      });
      return this.#finalizer.completeWorldAccepted({
        sessionId: stored.session.sessionId,
        commandId: stored.commandId,
        finalWorldRevision: result.worldRevision,
      });
    } catch (error: unknown) {
      if (
        !(error instanceof EngineFault) ||
        error.code !==
          "day_cycle.orchestration.required_operation_unresolved"
      ) {
        throw error;
      }
      try {
        return await this.#finalizer.completeRejected({
          sessionId: stored.session.sessionId,
          commandId: stored.commandId,
          code: "day_cycle.required_operation_unresolved",
        });
      } catch (finalizationError: unknown) {
        if (
          finalizationError instanceof EngineFault &&
          finalizationError.code ===
            "command.finalizer.rejection_after_mutation"
        ) {
          throw new EngineFault(
            "player_day.orchestration.blocked_after_mutation",
            "Player-day orchestration became unresolved after authoritative packets committed; the command remains recoverable and blocked for explicit repair",
            {
              session_id: stored.session.sessionId,
              command_id: stored.commandId,
              operation_fault: error.code,
              ...(error.details ?? {}),
            },
          );
        }
        throw finalizationError;
      }
    }
  }
}
