import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type JsonDigest,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";

import type {
  ModelProvider,
  ResolvedModelInvocation,
} from "../../application/model-gateway.js";
import {
  parseProviderJsonObject,
  readBoundedProviderResponseText,
} from "./model-provider-http-support.js";

const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface OpenAIResponsesModelProviderConfig {
  /** Explicit full Responses endpoint, normally ending in /v1/responses. */
  readonly endpoint: string;
  readonly apiKey: string;
  /** Deployment ModelProfile identity accepted by this adapter instance. */
  readonly modelProfileId: string;
  /** Explicit OpenAI model identifier; no adapter default. */
  readonly model: string;
  /** Explicit provider timeout; dispatched requests are never retried. */
  readonly timeoutMs: number;
  /** Explicit upper bound sent as max_output_tokens. */
  readonly maxOutputTokens: number;
}

export interface OpenAIResponsesModelProviderDependencies {
  readonly digest: JsonDigest;
  readonly config: OpenAIResponsesModelProviderConfig;
}

/**
 * Real single-shot OpenAI Responses adapter. It asks for one JSON object,
 * wraps that untrusted ModelOutput with the exact request correlations, and
 * leaves all Schema/digest/semantic authorization to ModelGateway.
 */
export function createOpenAIResponsesModelProvider(
  dependencies: OpenAIResponsesModelProviderDependencies,
): ModelProvider {
  return new OpenAIResponsesModelProvider(dependencies);
}

class OpenAIResponsesModelProvider implements ModelProvider {
  readonly #digest: JsonDigest;
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #modelProfileId: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxOutputTokens: number;

  public constructor(
    dependencies: OpenAIResponsesModelProviderDependencies,
  ) {
    this.#digest = dependencies.digest;
    this.#endpoint = validateEndpoint(dependencies.config.endpoint);
    this.#apiKey = requireNonemptySecret(dependencies.config.apiKey);
    this.#modelProfileId = requireNonemptyText(
      dependencies.config.modelProfileId,
      "model_profile_id",
      128,
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
  }

  public assertCanInvoke(input: {
    readonly modelProfileId: string;
    readonly requestKind: string;
  }): void {
    if (input.modelProfileId !== this.#modelProfileId) {
      throw new EngineFault(
        "model.provider.profile_not_configured",
        "OpenAI Responses adapter is not configured for the requested ModelProfile",
        {
          requested_model_profile_id: input.modelProfileId,
          configured_model_profile_id: this.#modelProfileId,
          request_kind: input.requestKind,
        },
      );
    }
  }

  public async invoke(
    resolved: ResolvedModelInvocation,
  ): Promise<unknown> {
    const request = resolved.request.value;
    const requestedProfile = expectString(
      request,
      "model_profile_id",
      "ModelRequest",
    );
    this.assertCanInvoke({
      modelProfileId: requestedProfile,
      requestKind: expectString(
        request,
        "request_kind",
        "ModelRequest",
      ),
    });

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
          input: buildResponsesInput(resolved),
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
            model_profile_id: this.#modelProfileId,
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
          model_profile_id: this.#modelProfileId,
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
          model_profile_id: this.#modelProfileId,
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
    const residentContext = expectJsonObject(
      expectProperty(request, "resident_context", "ModelRequest"),
      "ModelRequest.resident_context",
    );

    return Object.freeze({
      contract_version: "model-protocol.v1",
      record_type: "model.response",
      request_id: expectString(request, "request_id", "ModelRequest"),
      request_kind: expectString(
        request,
        "request_kind",
        "ModelRequest",
      ),
      basis_revision: expectInteger(
        request,
        "basis_revision",
        "ModelRequest",
      ),
      resident_context_digest: expectString(
        residentContext,
        "resident_digest",
        "ResidentContextRef",
      ),
      dynamic_input_digest: expectString(
        request,
        "dynamic_input_digest",
        "ModelRequest",
      ),
      output_digest: this.#digest.sha256(output),
      output,
    });
  }
}

function buildResponsesInput(
  resolved: ResolvedModelInvocation,
): readonly JsonObject[] {
  const input: JsonObject[] = resolved.prompt_blocks.map((block) =>
    Object.freeze({
      role: "developer",
      content: [
        Object.freeze({
          type: "input_text",
          text: block.text,
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
          text:
            "Return exactly one JSON object for the requested Luoxia ModelOutput. " +
            "Set output_kind to the ModelRequest request_kind. Do not add Markdown, prose, or wrapper fields.",
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
          text: JSON.stringify({
            model_request: resolved.request.value,
            ...(resolved.event_context === undefined
              ? {}
              : { event_context: resolved.event_context }),
          }),
        }),
      ],
    }),
  );
  return Object.freeze(input);
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
