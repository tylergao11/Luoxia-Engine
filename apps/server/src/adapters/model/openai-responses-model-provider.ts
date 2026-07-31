import {
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  isJsonObject,
  type ContractSchemaExporter,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";

import type {
  ModelProviderInvocationResult,
  ModelProvider,
  ProviderUsageObservation,
  ResolvedModelInvocation,
} from "../../application/model-gateway.js";
import {
  buildProviderOutputSchemaInstruction,
  deriveProviderOutputSchema,
  parseProviderJsonObject,
  readProviderTokenCount,
  readBoundedProviderResponseText,
} from "./model-provider-http-support.js";

const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface OpenAIResponsesModelProviderConfig {
  /** Explicit full Responses endpoint, normally ending in /v1/responses. */
  readonly endpoint: string;
  readonly apiKey: string;
  /** Explicit OpenAI model identifier; no adapter default. */
  readonly model: string;
  /** Explicit provider timeout; dispatched requests are never retried. */
  readonly timeoutMs: number;
  /** Explicit upper bound sent as max_output_tokens. */
  readonly maxOutputTokens: number;
}

export interface OpenAIResponsesModelProviderDependencies {
  readonly contracts: ContractSchemaExporter;
  readonly config: OpenAIResponsesModelProviderConfig;
}

/**
 * Real single-shot OpenAI Responses adapter. Generation Schema is placed in
 * the stable static developer instruction before dynamic input (same ownership
 * pattern as DeepSeek). `text.format` only requests one JSON object; formal
 * ModelOutput Schema, digests, and semantic authorization remain ModelGateway
 * authority over the untrusted return value.
 */
export function createOpenAIResponsesModelProvider(
  dependencies: OpenAIResponsesModelProviderDependencies,
): ModelProvider {
  return new OpenAIResponsesModelProvider(dependencies);
}

class OpenAIResponsesModelProvider implements ModelProvider {
  readonly #contracts: ContractSchemaExporter;
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxOutputTokens: number;
  readonly #outputSchemas = new Map<string, JsonObject>();

  public constructor(
    dependencies: OpenAIResponsesModelProviderDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#endpoint = validateEndpoint(dependencies.config.endpoint);
    this.#apiKey = requireNonemptySecret(dependencies.config.apiKey);
    this.#model = requireNonemptyText(
      dependencies.config.model,
      "model",
      256,
    );
    this.#timeoutMs = requirePositiveSafeInteger(
      dependencies.config.timeoutMs,
      "timeout_ms",
    );
    this.#maxOutputTokens = requirePositiveSafeInteger(
      dependencies.config.maxOutputTokens,
      "max_output_tokens",
    );
  }

  public assertCanInvoke(input: {
    readonly modelProfileId: string;
    readonly requestKind: string;
  }): void {
    this.#requireOutputSchema(input.requestKind);
  }

  public async invoke(
    resolved: ResolvedModelInvocation,
  ): Promise<ModelProviderInvocationResult> {
    this.assertCanInvoke({
      modelProfileId: resolved.modelProfileId,
      requestKind: resolved.requestKind,
    });
    const outputSchema = this.#requireOutputSchema(
      resolved.requestKind,
    );

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.#timeoutMs);
    let response: Response;
    let responseText: string;
    try {
      response = await fetch(this.#endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          model: this.#model,
          store: false,
          max_output_tokens: this.#maxOutputTokens,
          text: {
            format: {
              type: "json_object",
            },
          },
          input: buildResponsesInput(resolved, outputSchema),
        }),
        signal: abort.signal,
      });
      responseText = await readBoundedProviderResponseText({
        response,
        maximumBytes: MAX_PROVIDER_RESPONSE_BYTES,
        providerLabel: "OpenAI Responses",
      });
    } catch (error: unknown) {
      if (abort.signal.aborted) {
        throw new EngineFault(
          "model.provider.timeout",
          "OpenAI Responses request exceeded its explicit timeout",
          {
            model_profile_id: resolved.modelProfileId,
            timeout_ms: this.#timeoutMs,
          },
        );
      }
      if (error instanceof EngineFault) {
        throw error;
      }
      throw new EngineFault(
        "model.provider.transport_failed",
        "OpenAI Responses request failed before a verifiable response was received",
        {
          model_profile_id: resolved.modelProfileId,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new EngineFault(
        "model.provider.http_error",
        "OpenAI Responses endpoint returned a non-success status",
        {
          model_profile_id: resolved.modelProfileId,
          http_status: response.status,
          provider_error: readProviderErrorSummary(responseText),
        },
      );
    }
    const providerResponse = parseProviderJsonObject({
      source: responseText,
      code: "model.provider.response_not_json",
      message: "OpenAI Responses endpoint did not return a JSON object",
    });
    const outputText = extractSingleOutputText(providerResponse);
    const output = parseProviderJsonObject({
      source: outputText,
      code: "model.provider.output_not_json",
      message: "OpenAI Responses output_text is not one JSON object",
    });
    return Object.freeze({
      output,
      usage: readOpenAIUsage(providerResponse, this.#model),
    });
  }

  #requireOutputSchema(requestKind: string): JsonObject {
    const existing = this.#outputSchemas.get(requestKind);
    if (existing !== undefined) {
      return existing;
    }
    const schema = deriveProviderOutputSchema({
      contracts: this.#contracts,
      requestKind,
      providerLabel: "OpenAI Responses",
    });
    this.#outputSchemas.set(requestKind, schema);
    return schema;
  }
}

function buildResponsesInput(
  resolved: ResolvedModelInvocation,
  outputSchema: JsonObject,
): readonly JsonObject[] {
  const input: JsonObject[] = resolved.promptTexts.map((text) =>
    Object.freeze({
      role: "developer",
      content: [
        Object.freeze({
          type: "input_text",
          text,
        }),
      ],
    }),
  );
  input.push(
    Object.freeze({
      role: "developer",
      content: [
        Object.freeze({
          type: "input_text",
          text: buildProviderOutputSchemaInstruction(outputSchema),
        }),
      ],
    }),
  );
  input.push(
    Object.freeze({
      role: "user",
      content: [
        Object.freeze({
          type: "input_text",
          text: JSON.stringify(resolved.modelInput),
        }),
      ],
    }),
  );
  return Object.freeze(input);
}

function readOpenAIUsage(
  response: JsonObject,
  providerModel: string,
): ProviderUsageObservation {
  const usageCandidate = response["usage"];
  if (usageCandidate === undefined) {
    return Object.freeze({
      providerKind: "openai_responses",
      providerModel,
      status: "absent",
    });
  }
  if (!isJsonObject(usageCandidate)) {
    return invalidOpenAIUsage(providerModel);
  }
  const input = readProviderTokenCount(usageCandidate, "input_tokens");
  const output = readProviderTokenCount(usageCandidate, "output_tokens");
  const total = readProviderTokenCount(usageCandidate, "total_tokens");
  if (
    input.state !== "valid" ||
    output.state !== "valid" ||
    total.state === "invalid" ||
    (total.state === "valid" &&
      (!Number.isSafeInteger(input.value + output.value) ||
        total.value !== input.value + output.value))
  ) {
    return invalidOpenAIUsage(providerModel);
  }

  const detailsCandidate = usageCandidate["input_tokens_details"];
  if (detailsCandidate === undefined) {
    return Object.freeze({
      providerKind: "openai_responses",
      providerModel,
      status: "partial",
      inputTokens: input.value,
      outputTokens: output.value,
    });
  }
  if (!isJsonObject(detailsCandidate)) {
    return invalidOpenAIUsage(providerModel);
  }
  const cached = readProviderTokenCount(detailsCandidate, "cached_tokens");
  if (cached.state === "absent") {
    return Object.freeze({
      providerKind: "openai_responses",
      providerModel,
      status: "partial",
      inputTokens: input.value,
      outputTokens: output.value,
    });
  }
  if (cached.state !== "valid" || cached.value > input.value) {
    return invalidOpenAIUsage(providerModel);
  }
  return Object.freeze({
    providerKind: "openai_responses",
    providerModel,
    status: "complete",
    inputTokens: input.value,
    cachedInputTokens: cached.value,
    outputTokens: output.value,
  });
}

function invalidOpenAIUsage(
  providerModel: string,
): ProviderUsageObservation {
  return Object.freeze({
    providerKind: "openai_responses",
    providerModel,
    status: "invalid",
  });
}

function extractSingleOutputText(response: JsonObject): string {
  const status = expectString(response, "status", "OpenAI Response");
  if (status !== "completed") {
    throw new EngineFault(
      "model.provider.response_incomplete",
      "OpenAI Responses request did not complete",
      { provider_status: status },
    );
  }
  const output = asObjectArray(
    expectProperty(response, "output", "OpenAI Response"),
    "OpenAI Response.output",
  );
  const texts: string[] = [];
  let refusals = 0;
  for (const item of output) {
    if (item["type"] !== "message") {
      continue;
    }
    const content = asObjectArray(
      expectProperty(item, "content", "OpenAI output message"),
      "OpenAI output message.content",
    );
    for (const part of content) {
      const type = expectString(
        part,
        "type",
        "OpenAI output content",
      );
      if (type === "output_text") {
        texts.push(
          expectString(part, "text", "OpenAI output_text"),
        );
      } else if (type === "refusal") {
        refusals += 1;
      }
    }
  }
  if (refusals > 0) {
    throw new EngineFault(
      "model.provider.refused",
      "OpenAI model refused the requested ModelOutput",
      { refusal_count: refusals },
    );
  }
  if (texts.length !== 1 || texts[0]?.length === 0) {
    throw new EngineFault(
      "model.provider.output_text_count",
      "OpenAI Responses payload must contain exactly one non-empty output_text item",
      { output_text_count: texts.length },
    );
  }
  return texts[0] as string;
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "model.provider.response_shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

function readProviderErrorSummary(source: string): string {
  try {
    const parsed = JSON.parse(source) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const error = (parsed as Record<string, unknown>)["error"];
      if (
        typeof error === "object" &&
        error !== null &&
        !Array.isArray(error)
      ) {
        const message = (error as Record<string, unknown>)["message"];
        if (typeof message === "string") {
          return message.slice(0, 1000);
        }
      }
    }
  } catch {
    return "";
  }
  return "";
}

function validateEndpoint(candidate: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(candidate);
  } catch {
    throw new EngineFault(
      "model.provider.endpoint_invalid",
      "OpenAI Responses endpoint must be an absolute URL",
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new EngineFault(
      "model.provider.endpoint_invalid",
      "OpenAI Responses endpoint must use HTTPS and contain no credentials or fragment",
      { endpoint: candidate },
    );
  }
  return endpoint.toString();
}

function requireNonemptySecret(candidate: string): string {
  if (
    typeof candidate !== "string" ||
    candidate.trim().length < 1 ||
    candidate !== candidate.trim() ||
    /[\r\n]/u.test(candidate)
  ) {
    throw new EngineFault(
      "model.provider.api_key_missing",
      "OpenAI API key is required explicitly without surrounding whitespace or line breaks",
    );
  }
  return candidate;
}

function requireNonemptyText(
  candidate: string,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof candidate !== "string" ||
    candidate.trim().length < 1 ||
    candidate !== candidate.trim() ||
    candidate.length > maximumLength ||
    /[\r\n]/u.test(candidate)
  ) {
    throw new EngineFault(
      "model.provider.config_invalid",
      `OpenAI provider ${field} must be a non-empty bounded string`,
      { field, maximum_length: maximumLength },
    );
  }
  return candidate;
}

function requirePositiveSafeInteger(
  candidate: number,
  field: string,
): number {
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new EngineFault(
      "model.provider.config_invalid",
      `OpenAI provider ${field} must be a positive safe integer`,
      { field, value: candidate },
    );
  }
  return candidate;
}
