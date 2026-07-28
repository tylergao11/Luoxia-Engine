import {
  EngineFault,
  expectJsonObject,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";

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

export function copyProviderJsonObject(input: {
  readonly candidate: unknown;
  readonly field: string;
  readonly providerLabel: string;
}): JsonObject {
  if (
    typeof input.candidate !== "object" ||
    input.candidate === null ||
    Array.isArray(input.candidate)
  ) {
    throw providerJsonConfigFault(
      input,
      "must be a JSON object",
    );
  }
  const copied = copyProviderJsonValue(
    input.candidate,
    input.field,
    input.providerLabel,
  );
  if (
    typeof copied !== "object" ||
    copied === null ||
    Array.isArray(copied) ||
    Object.keys(copied).length === 0
  ) {
    throw providerJsonConfigFault(
      input,
      "must be a non-empty JSON object",
    );
  }
  return copied as JsonObject;
}

function copyProviderJsonValue(
  candidate: unknown,
  path: string,
  providerLabel: string,
): JsonValue {
  if (
    candidate === null ||
    typeof candidate === "string" ||
    typeof candidate === "boolean"
  ) {
    return candidate;
  }
  if (typeof candidate === "number") {
    if (!Number.isFinite(candidate)) {
      throw providerJsonValueFault(providerLabel, path);
    }
    return candidate;
  }
  if (Array.isArray(candidate)) {
    return Object.freeze(
      candidate.map((entry, index) =>
        copyProviderJsonValue(
          entry,
          `${path}[${index}]`,
          providerLabel,
        ),
      ),
    );
  }
  if (typeof candidate === "object") {
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw providerJsonValueFault(providerLabel, path);
    }
    const copied: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(candidate)) {
      copied[key] = copyProviderJsonValue(
        value,
        `${path}.${key}`,
        providerLabel,
      );
    }
    return Object.freeze(copied);
  }
  throw providerJsonValueFault(providerLabel, path);
}

function providerJsonConfigFault(
  input: {
    readonly field: string;
    readonly providerLabel: string;
  },
  reason: string,
): EngineFault {
  return new EngineFault(
    "model.provider.config_invalid",
    `${input.providerLabel} ${input.field} ${reason}`,
    { field: input.field },
  );
}

function providerJsonValueFault(
  providerLabel: string,
  path: string,
): EngineFault {
  return new EngineFault(
    "model.provider.config_invalid",
    `${providerLabel} output_schema must contain JSON values only`,
    { field: path },
  );
}
