import {
  CONTRACT_REF,
  type ContractValidator,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime/portable";

export type ClientEnvelopeDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.clientEnvelope
>;

export type ServerEnvelopeDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.serverEnvelope
>;

export interface ClientEnvelopeTransport {
  send(envelope: ClientEnvelopeDocument): Promise<void>;
}

export interface ServerEnvelopeConsumer {
  consume(envelope: ServerEnvelopeDocument): Promise<void>;
}

export class GdjsBridgeHost {
  readonly #contracts: ContractValidator;
  readonly #transport: ClientEnvelopeTransport;
  readonly #consumer: ServerEnvelopeConsumer;

  public constructor(
    contracts: ContractValidator,
    transport: ClientEnvelopeTransport,
    consumer: ServerEnvelopeConsumer,
  ) {
    this.#contracts = contracts;
    this.#transport = transport;
    this.#consumer = consumer;
  }

  public async send(candidate: unknown): Promise<void> {
    const envelope = this.#contracts.assertObject(
      CONTRACT_REF.clientEnvelope,
      candidate,
    );
    await this.#transport.send(envelope);
  }

  public async receive(candidate: unknown): Promise<void> {
    const envelope = this.#contracts.assertObject(
      CONTRACT_REF.serverEnvelope,
      candidate,
    );
    await this.#consumer.consume(envelope);
  }
}
