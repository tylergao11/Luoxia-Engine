import {
  EngineFault,
  expectInteger,
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
  deriveProviderOutputSchema,
  parseProviderJsonObject,
  readProviderTokenCount,
  readBoundedProviderResponseText,
} from "./model-provider-http-support.js";

const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;

export type DeepSeekThinkingMode = "enabled" | "disabled";

export interface DeepSeekChatModelProviderConfig {
  /** Explicit official Chat Completions endpoint. */
  readonly endpoint: string;
  readonly apiKey: string;
  /** Explicit DeepSeek model identifier; no adapter default. */
  readonly model: string;
  /** Explicit thinking mode sent to DeepSeek. */
  readonly thinkingMode: DeepSeekThinkingMode;
  /** Explicit provider timeout; dispatched requests are never retried. */
  readonly timeoutMs: number;
  /** Explicit upper bound sent as max_tokens. */
  readonly maxOutputTokens: number;
  /** Explicit sampling temperature; no provider default is inherited. */
  readonly temperature: number;
}

export interface DeepSeekChatModelProviderDependencies {
  readonly contracts: ContractSchemaExporter;
  readonly config: DeepSeekChatModelProviderConfig;
}

/**
 * Real single-shot DeepSeek Chat Completions adapter. JSON Output narrows the
 * transport shape while ModelGateway remains the sole Schema and semantic
 * authority over the returned ModelOutput.
 */
export function createDeepSeekChatModelProvider(
  dependencies: DeepSeekChatModelProviderDependencies,
): ModelProvider {
  return new DeepSeekChatModelProvider(dependencies);
}

class DeepSeekChatModelProvider implements ModelProvider {
  readonly #contracts: ContractSchemaExporter;
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #thinkingMode: DeepSeekThinkingMode;
  readonly #timeoutMs: number;
  readonly #maxOutputTokens: number;
  readonly #temperature: number;
  readonly #outputSchemas = new Map<string, JsonObject>();

  public constructor(
    dependencies: DeepSeekChatModelProviderDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#endpoint = validateDeepSeekEndpoint(
      dependencies.config.endpoint,
    );
    this.#apiKey = requireNonemptySecret(
      dependencies.config.apiKey,
    );
    this.#model = requireNonemptyText(
      dependencies.config.model,
      "model",
      256,
    );
    this.#thinkingMode = requireThinkingMode(
      dependencies.config.thinkingMode,
    );
    this.#timeoutMs = requirePositiveSafeInteger(
      dependencies.config.timeoutMs,
      "timeout_ms",
    );
    this.#maxOutputTokens = requirePositiveSafeInteger(
      dependencies.config.maxOutputTokens,
      "max_output_tokens",
    );
    this.#temperature = requireTemperature(
      dependencies.config.temperature,
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
          messages: buildDeepSeekMessages(
            resolved,
            outputSchema,
          ),
          response_format: {
            type: "json_object",
          },
          thinking: {
            type: this.#thinkingMode,
          },
          stream: false,
          max_tokens: this.#maxOutputTokens,
          temperature: this.#temperature,
        }),
        signal: abort.signal,
      });
      responseText = await readBoundedProviderResponseText({
        response,
        maximumBytes: MAX_PROVIDER_RESPONSE_BYTES,
        providerLabel: "DeepSeek chat",
      });
    } catch (error: unknown) {
      if (abort.signal.aborted) {
        throw new EngineFault(
          "model.provider.timeout",
          "DeepSeek chat request exceeded its explicit timeout",
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
        "DeepSeek chat request failed before a verifiable response was received",
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
        "DeepSeek chat endpoint returned a non-success status",
        {
          model_profile_id: resolved.modelProfileId,
          http_status: response.status,
          provider_error: readDeepSeekErrorSummary(responseText),
        },
      );
    }
    const providerResponse = parseProviderJsonObject({
      source: responseText,
      code: "model.provider.response_not_json",
      message: "DeepSeek chat endpoint did not return a JSON object",
    });
    const output = extractDeepSeekOutput(
      providerResponse,
      this.#model,
    );
    return Object.freeze({
      output,
      usage: readDeepSeekUsage(providerResponse, this.#model),
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
      providerLabel: "DeepSeek",
    });
    this.#outputSchemas.set(requestKind, schema);
    return schema;
  }
}

function buildDeepSeekMessages(
  resolved: ResolvedModelInvocation,
  outputSchema: JsonObject,
): readonly JsonObject[] {
  const messages: JsonObject[] = resolved.promptTexts.map((text) =>
      Object.freeze({
        role: "system",
        content: text,
      }),
  );
  messages.push(
    Object.freeze({
      role: "system",
      content:
        `Return exactly one JSON object for Luoxia operation ${resolved.requestKind}. ` +
        `Set output_kind to ${JSON.stringify(resolved.requestKind)}. ` +
        "The following user JSON is the operation input. Do not add Markdown, prose, or wrapper fields. " +
        `The following JSON Schema is the exact output contract: ${JSON.stringify(outputSchema)}`,
    }),
  );
  messages.push(
    Object.freeze({
      role: "user",
      content: JSON.stringify(resolved.modelInput),
    }),
  );
  return Object.freeze(messages);
}

function readDeepSeekUsage(
  response: JsonObject,
  providerModel: string,
): ProviderUsageObservation {
  const usageCandidate = response["usage"];
  if (usageCandidate === undefined) {
    return Object.freeze({
      providerKind: "deepseek_chat",
      providerModel,
      status: "absent",
    });
  }
  if (!isJsonObject(usageCandidate)) {
    return invalidDeepSeekUsage(providerModel);
  }
  const input = readProviderTokenCount(usageCandidate, "prompt_tokens");
  const output = readProviderTokenCount(
    usageCandidate,
    "completion_tokens",
  );
  const total = readProviderTokenCount(usageCandidate, "total_tokens");
  if (
    input.state !== "valid" ||
    output.state !== "valid" ||
    total.state === "invalid" ||
    (total.state === "valid" &&
      (!Number.isSafeInteger(input.value + output.value) ||
        total.value !== input.value + output.value))
  ) {
    return invalidDeepSeekUsage(providerModel);
  }

  const cacheHit = readProviderTokenCount(
    usageCandidate,
    "prompt_cache_hit_tokens",
  );
  const cacheMiss = readProviderTokenCount(
    usageCandidate,
    "prompt_cache_miss_tokens",
  );
  if (cacheHit.state === "absent" && cacheMiss.state === "absent") {
    return Object.freeze({
      providerKind: "deepseek_chat",
      providerModel,
      status: "partial",
      inputTokens: input.value,
      outputTokens: output.value,
    });
  }
  if (
    cacheHit.state !== "valid" ||
    cacheMiss.state !== "valid" ||
    !Number.isSafeInteger(cacheHit.value + cacheMiss.value) ||
    cacheHit.value + cacheMiss.value !== input.value
  ) {
    return invalidDeepSeekUsage(providerModel);
  }
  return Object.freeze({
    providerKind: "deepseek_chat",
    providerModel,
    status: "complete",
    inputTokens: input.value,
    cachedInputTokens: cacheHit.value,
    outputTokens: output.value,
  });
}

function invalidDeepSeekUsage(
  providerModel: string,
): ProviderUsageObservation {
  return Object.freeze({
    providerKind: "deepseek_chat",
    providerModel,
    status: "invalid",
  });
}

function extractDeepSeekOutput(
  response: JsonObject,
  expectedModel: string,
): JsonObject {
  if (
    expectString(response, "object", "DeepSeek chat response") !==
    "chat.completion"
  ) {
    throw responseShapeFault(
      "DeepSeek response object must be chat.completion",
    );
  }
  const model = expectString(
    response,
    "model",
    "DeepSeek chat response",
  );
  if (model !== expectedModel) {
    throw new EngineFault(
      "model.provider.response_model_mismatch",
      "DeepSeek chat response used a different model",
      {
        expected_model: expectedModel,
        actual_model: model,
      },
    );
  }
  const choices = asObjectArray(
    expectProperty(response, "choices", "DeepSeek chat response"),
    "DeepSeek chat response.choices",
  );
  if (choices.length !== 1) {
    throw responseShapeFault(
      "DeepSeek chat response must contain exactly one choice",
      { choice_count: choices.length },
    );
  }
  const choice = choices[0] as JsonObject;
  const finishReason = expectString(
    choice,
    "finish_reason",
    "DeepSeek chat choice",
  );
  if (
    expectInteger(choice, "index", "DeepSeek chat choice") !== 0 ||
    finishReason !== "stop"
  ) {
    throw new EngineFault(
      "model.provider.response_incomplete",
      "DeepSeek chat response did not complete normally",
      { finish_reason: finishReason },
    );
  }
  const message = expectJsonObject(
    expectProperty(choice, "message", "DeepSeek chat choice"),
    "DeepSeek chat choice.message",
  );
  if (
    expectString(message, "role", "DeepSeek chat message") !==
    "assistant"
  ) {
    throw new EngineFault(
      "model.provider.response_role_invalid",
      "DeepSeek chat response message must use the assistant role",
      { model },
    );
  }
  if (
    message["tool_calls"] !== undefined &&
    (!Array.isArray(message["tool_calls"]) ||
      message["tool_calls"].length > 0)
  ) {
    throw new EngineFault(
      "model.provider.unexpected_tool_call",
      "DeepSeek chat response must not contain tool calls",
      { model },
    );
  }
  const outputText = expectString(
    message,
    "content",
    "DeepSeek chat message",
  );
  if (outputText.length === 0) {
    throw new EngineFault(
      "model.provider.output_text_count",
      "DeepSeek chat response must contain one non-empty JSON object",
      { model },
    );
  }
  return parseProviderJsonObject({
    source: outputText,
    code: "model.provider.output_not_json",
    message: "DeepSeek chat message content is not one JSON object",
  });
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw responseShapeFault(`${path} must be an array`, { path });
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

function readDeepSeekErrorSummary(source: string): string {
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

function validateDeepSeekEndpoint(candidate: string): string {
  if (
    typeof candidate !== "string" ||
    candidate !== candidate.trim()
  ) {
    throw endpointFault(candidate);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(candidate);
  } catch {
    throw endpointFault(candidate);
  }
  const normalizedPath = endpoint.pathname.replace(/\/+$/u, "");
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "api.deepseek.com" ||
    (endpoint.port.length > 0 && endpoint.port !== "443") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0 ||
    endpoint.search.length > 0 ||
    (normalizedPath !== "/chat/completions" &&
      normalizedPath !== "/v1/chat/completions")
  ) {
    throw endpointFault(candidate);
  }
  return endpoint.toString();
}

function endpointFault(candidate: string): EngineFault {
  return new EngineFault(
    "model.provider.endpoint_invalid",
    "DeepSeek endpoint must be the official HTTPS /chat/completions URL with no credentials, query, or fragment",
    { endpoint: candidate },
  );
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
      "DeepSeek API key is required explicitly without surrounding whitespace or line breaks",
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
      `DeepSeek provider ${field} must be a non-empty bounded string`,
      { field, maximum_length: maximumLength },
    );
  }
  return candidate;
}

function requireThinkingMode(
  candidate: DeepSeekThinkingMode,
): DeepSeekThinkingMode {
  if (candidate !== "enabled" && candidate !== "disabled") {
    throw new EngineFault(
      "model.provider.config_invalid",
      "DeepSeek provider thinking_mode must be enabled or disabled",
      { field: "thinking_mode" },
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
      `DeepSeek provider ${field} must be a positive safe integer`,
      { field, value: candidate },
    );
  }
  return candidate;
}

function requireTemperature(candidate: number): number {
  if (
    typeof candidate !== "number" ||
    !Number.isFinite(candidate) ||
    candidate < 0 ||
    candidate > 2
  ) {
    throw new EngineFault(
      "model.provider.config_invalid",
      "DeepSeek provider temperature must be a finite number from 0 through 2",
      { field: "temperature", value: candidate },
    );
  }
  return candidate;
}

function responseShapeFault(
  message: string,
  details: JsonObject = {},
): EngineFault {
  return new EngineFault(
    "model.provider.response_shape",
    message,
    details,
  );
}
