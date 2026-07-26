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
