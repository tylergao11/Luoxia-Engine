import {
  EngineFault,
  MODEL_OUTPUT_SCHEMA_REF_BY_REQUEST_KIND,
  expectJsonObject,
  type ContractSchemaExporter,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";

export type ProviderTokenCountRead =
  | { readonly state: "absent" }
  | { readonly state: "invalid" }
  | { readonly state: "valid"; readonly value: number };

export async function readBoundedProviderResponseText(input: {
  readonly response: Response;
  readonly maximumBytes: number;
  readonly providerLabel: string;
}): Promise<string> {
  const declaredLength = input.response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^(0|[1-9][0-9]*)$/u.test(declaredLength) &&
    BigInt(declaredLength) > BigInt(input.maximumBytes)
  ) {
    throw new EngineFault(
      "model.provider.response_too_large",
      `${input.providerLabel} payload exceeds the provider safety limit`,
      {
        provider: input.providerLabel,
        maximum_bytes: input.maximumBytes,
        content_length: declaredLength,
      },
    );
  }
  if (input.response.body === null) {
    return "";
  }

  const reader = input.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      byteLength += part.value.byteLength;
      if (byteLength > input.maximumBytes) {
        try {
          await reader.cancel(
            `${input.providerLabel} payload exceeds the provider safety limit`,
          );
        } catch {
          // The size violation remains the authoritative failure.
        }
        throw new EngineFault(
          "model.provider.response_too_large",
          `${input.providerLabel} payload exceeds the provider safety limit`,
          {
            provider: input.providerLabel,
            maximum_bytes: input.maximumBytes,
            actual_bytes: byteLength,
          },
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new EngineFault(
      "model.provider.response_encoding_invalid",
      `${input.providerLabel} payload must be valid UTF-8`,
      {
        provider: input.providerLabel,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export function parseProviderJsonObject(input: {
  readonly source: string;
  readonly code: string;
  readonly message: string;
}): JsonObject {
  let candidate: unknown;
  try {
    candidate = JSON.parse(input.source);
  } catch (error: unknown) {
    throw new EngineFault(input.code, input.message, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return expectJsonObject(candidate as JsonValue, input.message);
}

/**
 * Usage telemetry must never invent zero for a missing or malformed provider
 * field. Callers convert invalid observations into an operational status while
 * preserving an otherwise valid model output.
 */
export function readProviderTokenCount(
  object: JsonObject,
  field: string,
): ProviderTokenCountRead {
  const candidate = object[field];
  if (candidate === undefined) {
    return Object.freeze({ state: "absent" });
  }
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    return Object.freeze({ state: "invalid" });
  }
  return Object.freeze({
    state: "valid",
    value: candidate as number,
  });
}

export function deriveProviderOutputSchema(input: {
  readonly contracts: ContractSchemaExporter;
  readonly requestKind: string;
  readonly providerLabel: string;
}): JsonObject {
  if (
    !Object.prototype.hasOwnProperty.call(
      MODEL_OUTPUT_SCHEMA_REF_BY_REQUEST_KIND,
      input.requestKind,
    )
  ) {
    throw new EngineFault(
      "model.provider.request_kind_not_configured",
      `${input.providerLabel} has no formal output contract for the configured request kind`,
      {
        provider: input.providerLabel,
        request_kind: input.requestKind,
      },
    );
  }
  const requestKind =
    input.requestKind as keyof typeof MODEL_OUTPUT_SCHEMA_REF_BY_REQUEST_KIND;
  return stripGenerationSchemaMeta(
    input.contracts.exportStandaloneSchema(
      MODEL_OUTPUT_SCHEMA_REF_BY_REQUEST_KIND[requestKind],
    ),
  );
}

/**
 * Generation Schema is a derived view of formal ModelOutput. Drop meta the
 * model cannot use ($schema draft URI) so the cacheable static instruction
 * carries only validation shape.
 */
function stripGenerationSchemaMeta(schema: JsonObject): JsonObject {
  if (!Object.prototype.hasOwnProperty.call(schema, "$schema")) {
    return schema;
  }
  const next: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema") {
      continue;
    }
    next[key] = value as JsonValue;
  }
  return Object.freeze(next);
}

/**
 * Static trailing developer/system instruction before dynamic user JSON.
 * output_kind is already constrained by the schema; keep wording minimal and
 * stable for provider prefix caching.
 */
export function buildProviderOutputSchemaInstruction(
  outputSchema: JsonObject,
): string {
  return `JSON object only. Match schema: ${JSON.stringify(outputSchema)}`;
}

/**
 * Ollama uses a native structured-output grammar instead of inlining the full
 * schema; keep the static instruction short and free of dynamic content.
 */
export function buildProviderStructuredOutputInstruction(): string {
  return "JSON object only. Native format grammar is authoritative.";
}
