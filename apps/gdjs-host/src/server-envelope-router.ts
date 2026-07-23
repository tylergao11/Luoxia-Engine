import {
  EngineFault,
  expectJsonObject,
  expectProperty,
  type JsonObject,
} from "@luoxia/contracts-runtime/portable";

import type {
  ServerEnvelopeConsumer,
  ServerEnvelopeDocument,
} from "./bridge-host.js";
import type { GdjsStageModuleHost } from "./stage-module-host.js";

export interface StageRoutingServerEnvelopeConsumerDependencies {
  readonly stageModules: GdjsStageModuleHost;
  /**
   * Required composition-root consumer for every non-stage ServerMessage.
   * No default empty handler.
   */
  readonly nonStageConsumer: ServerEnvelopeConsumer;
}

/**
 * Routes Schema-validated ServerEnvelope messages:
 * stage.open / stage.update / stage.close → GdjsStageModuleHost;
 * all other ServerMessage types → explicit non-stage consumer.
 */
export function createStageRoutingServerEnvelopeConsumer(
  dependencies: StageRoutingServerEnvelopeConsumerDependencies,
): ServerEnvelopeConsumer {
  return new StageRoutingServerEnvelopeConsumer(dependencies);
}

class StageRoutingServerEnvelopeConsumer implements ServerEnvelopeConsumer {
  readonly #stageModules: GdjsStageModuleHost;
  readonly #nonStageConsumer: ServerEnvelopeConsumer;

  public constructor(
    dependencies: StageRoutingServerEnvelopeConsumerDependencies,
  ) {
    this.#stageModules = dependencies.stageModules;
    this.#nonStageConsumer = dependencies.nonStageConsumer;
  }

  public async consume(envelope: ServerEnvelopeDocument): Promise<void> {
    const message = expectJsonObject(
      expectProperty(envelope.value, "message", "ServerEnvelope"),
      "ServerEnvelope.message",
    );
    const messageType = readMessageType(message);

    switch (messageType) {
      case "stage.open": {
        await this.#stageModules.open(message);
        return;
      }
      case "stage.update": {
        await this.#stageModules.update(message);
        return;
      }
      case "stage.close": {
        await this.#stageModules.close(message);
        return;
      }
      default: {
        await this.#nonStageConsumer.consume(envelope);
      }
    }
  }
}

function readMessageType(message: JsonObject): string {
  const type = message["type"];
  if (typeof type !== "string" || type.length === 0) {
    throw new EngineFault(
      "gdjs_host.bridge.message_type_missing",
      "ServerEnvelope.message.type must be a non-empty string",
    );
  }
  return type;
}
