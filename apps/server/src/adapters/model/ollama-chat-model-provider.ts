import {
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractSchemaExporter,
  type JsonObject,
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

export interface OllamaChatModelProviderConfig {
  /** Explicit full native chat endpoint, ending in /api/chat. */
  readonly endpoint: string;
  /** Explicit locally installed Ollama model name. */
  readonly model: string;
  /** Explicit provider timeout; dispatched requests are never retried. */
  readonly timeoutMs: number;
  /** Explicit upper bound sent as options.num_predict. */
  readonly maxOutputTokens: number;
  /** Explicit sampling temperature; no Ollama default is inherited. */
  readonly temperature: number;
}

export interface OllamaChatModelProviderDependencies {
  readonly contracts: ContractSchemaExporter;
  readonly config: OllamaChatModelProviderConfig;
}

/**
 * Real single-shot local Ollama native chat adapter. Only loopback endpoints
 * are accepted, matching Ollama's unauthenticated local API boundary. The
 * model emits one JSON object and ModelGateway remains the sole authority.
 */
export function createOllamaChatModelProvider(
  dependencies: OllamaChatModelProviderDependencies,
): ModelProvider {
  return new OllamaChatModelProvider(dependencies);
}

class OllamaChatModelProvider implements ModelProvider {
  readonly #contracts: ContractSchemaExporter;
  readonly #endpoint: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxOutputTokens: number;
  readonly #temperature: number;
  readonly #outputSchemas = new Map<string, JsonObject>();

  public constructor(
    dependencies: OllamaChatModelProviderDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#endpoint = validateOllamaEndpoint(
      dependencies.config.endpoint,
    );
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
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          model: this.#model,
          messages: buildOllamaMessages(resolved),
          stream: false,
          think: false,
          format: outputSchema,
          options: {
            num_predict: this.#maxOutputTokens,
            temperature: this.#temperature,
          },
        }),
        signal: abort.signal,
      });
      responseText = await readBoundedProviderResponseText({
        response,
        maximumBytes: MAX_PROVIDER_RESPONSE_BYTES,
        providerLabel: "Ollama chat",
      });
    } catch (error: unknown) {
      if (abort.signal.aborted) {
        throw new EngineFault(
          "model.provider.timeout",
          "Ollama chat request exceeded its explicit timeout",
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
        "Ollama chat request failed before a verifiable response was received",
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
        "Ollama chat endpoint returned a non-success status",
        {
          model_profile_id: resolved.modelProfileId,
          http_status: response.status,
          provider_error: readOllamaErrorSummary(responseText),
        },
      );
    }
    const providerResponse = parseProviderJsonObject({
      source: responseText,
      code: "model.provider.response_not_json",
      message: "Ollama chat endpoint did not return a JSON object",
    });
    const output = extractOllamaOutput(
      providerResponse,
      this.#model,
    );
    return Object.freeze({
      output,
      usage: readOllamaUsage(providerResponse, this.#model),
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
      providerLabel: "Ollama",
    });
    this.#outputSchemas.set(requestKind, schema);
    return schema;
  }
}

function buildOllamaMessages(
  resolved: ResolvedModelInvocation,
): readonly JsonObject[] {
  const messages: JsonObject[] = resolved.promptTexts.map(
    (text) =>
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
        "The native structured-output grammar supplied with this request is authoritative.",
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

function readOllamaUsage(
  response: JsonObject,
  providerModel: string,
): ProviderUsageObservation {
  const input = readProviderTokenCount(response, "prompt_eval_count");
  const output = readProviderTokenCount(response, "eval_count");
  if (input.state === "absent" && output.state === "absent") {
    return Object.freeze({
      providerKind: "ollama_chat",
      providerModel,
      status: "absent",
    });
  }
  if (input.state !== "valid" || output.state !== "valid") {
    return Object.freeze({
      providerKind: "ollama_chat",
      providerModel,
      status: "invalid",
    });
  }
  return Object.freeze({
    providerKind: "ollama_chat",
    providerModel,
    status: "partial",
    inputTokens: input.value,
    outputTokens: output.value,
  });
}

function extractOllamaOutput(
  response: JsonObject,
  expectedModel: string,
): JsonObject {
  const model = expectString(response, "model", "Ollama chat response");
  const done = response["done"];
  const doneReason = expectString(
    response,
    "done_reason",
    "Ollama chat response",
  );
  if (model !== expectedModel || done !== true || doneReason !== "stop") {
    throw new EngineFault(
      "model.provider.response_incomplete",
      "Ollama chat response did not complete with the configured model",
      {
        expected_model: expectedModel,
        actual_model: model,
        done: typeof done === "boolean" ? done : false,
        done_reason: doneReason,
      },
    );
  }
  const message = expectJsonObject(
    expectProperty(response, "message", "Ollama chat response"),
    "Ollama chat response.message",
  );
  if (expectString(message, "role", "Ollama chat message") !== "assistant") {
    throw new EngineFault(
      "model.provider.response_role_invalid",
      "Ollama chat response message must use the assistant role",
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
      "Ollama chat response must not contain tool calls",
      { model },
    );
  }
  const outputText = expectString(
    message,
    "content",
    "Ollama chat message",
  );
  if (outputText.length === 0) {
    throw new EngineFault(
      "model.provider.output_text_count",
      "Ollama chat response must contain one non-empty JSON object",
      { model },
    );
  }
  return parseProviderJsonObject({
    source: outputText,
    code: "model.provider.output_not_json",
    message: "Ollama chat message content is not one JSON object",
  });
}

function readOllamaErrorSummary(source: string): string {
  try {
    const parsed = JSON.parse(source) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const error = (parsed as Record<string, unknown>)["error"];
      if (typeof error === "string") {
        return error.slice(0, 1000);
      }
    }
  } catch {
    return "";
  }
  return "";
}

function validateOllamaEndpoint(candidate: string): string {
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
  const isLoopback =
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "[::1]" ||
    endpoint.hostname === "::1";
  const normalizedPath = endpoint.pathname.replace(/\/+$/u, "");
  if (
    !isLoopback ||
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0 ||
    endpoint.search.length > 0 ||
    !normalizedPath.endsWith("/api/chat")
  ) {
    throw endpointFault(candidate);
  }
  return endpoint.toString();
}

function endpointFault(candidate: string): EngineFault {
  return new EngineFault(
    "model.provider.endpoint_invalid",
    "Ollama endpoint must be an absolute loopback /api/chat URL with no credentials, query, or fragment",
    { endpoint: candidate },
  );
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
      `Ollama provider ${field} must be a non-empty bounded string`,
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
      `Ollama provider ${field} must be a positive safe integer`,
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
      "Ollama provider temperature must be a finite number from 0 through 2",
      { field: "temperature", value: candidate },
    );
  }
  return candidate;
}
