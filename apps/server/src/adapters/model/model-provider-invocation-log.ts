import type { JsonObject, JsonValue } from "@luoxia/contracts-runtime";

import type {
  ProviderUsageObservation,
  ResolvedModelInvocation,
} from "../../application/model-gateway.js";

const MIN_DUPLICATE_STRING_LENGTH = 24;
const MAX_DUPLICATE_REPORTS = 24;
const MAX_PATH_LENGTH = 240;

export interface ModelProviderRequestObservation {
  readonly provider: string;
  readonly model: string;
  readonly modelProfileId: string;
  readonly requestKind: string;
  readonly promptBlockCount: number;
  readonly promptCharCount: number;
  readonly promptDistinctTextCount: number;
  readonly promptDuplicateBlockCount: number;
  readonly modelInputByteCount: number;
  readonly modelInputTopLevelKeys: readonly string[];
  readonly repeatedFieldNames: readonly {
    readonly field: string;
    readonly count: number;
  }[];
  readonly duplicateStringValues: readonly {
    readonly valuePreview: string;
    readonly valueLength: number;
    readonly paths: readonly string[];
  }[];
  readonly promptInputOverlapCount: number;
  readonly schemaByteCount: number;
}

export interface ModelProviderResponseObservation {
  readonly provider: string;
  readonly model: string;
  readonly modelProfileId: string;
  readonly requestKind: string;
  readonly durationMs: number;
  readonly outputTopLevelKeys: readonly string[];
  readonly outputByteCount: number;
  readonly repeatedFieldNames: readonly {
    readonly field: string;
    readonly count: number;
  }[];
  readonly duplicateStringValues: readonly {
    readonly valuePreview: string;
    readonly valueLength: number;
    readonly paths: readonly string[];
  }[];
  readonly usage: JsonObject;
}

/**
 * Structured, non-secret ModelProvider telemetry. Emits one JSON line per
 * event to stderr so operators can inspect cache hits, token counts, and
 * structural field duplication without logging raw prompts or API keys.
 */
export function logModelProviderRequest(
  observation: ModelProviderRequestObservation,
): void {
  writeLogLine({
    event: "model.provider.request",
    ...observation,
  });
}

export function logModelProviderResponse(
  observation: ModelProviderResponseObservation,
): void {
  writeLogLine({
    event: "model.provider.response",
    ...observation,
  });
}

export function logModelProviderFailure(input: {
  readonly provider: string;
  readonly model: string;
  readonly modelProfileId: string;
  readonly requestKind: string;
  readonly durationMs: number;
  readonly code: string;
  readonly message: string;
}): void {
  writeLogLine({
    event: "model.provider.failure",
    ...input,
  });
}

export function observeResolvedModelRequest(input: {
  readonly provider: string;
  readonly model: string;
  readonly resolved: ResolvedModelInvocation;
  readonly outputSchema: JsonObject;
}): ModelProviderRequestObservation {
  const { resolved, outputSchema } = input;
  const promptTexts = resolved.promptTexts;
  const distinctPromptTexts = new Set(promptTexts);
  const modelInputJson = JSON.stringify(resolved.modelInput);
  const schemaJson = JSON.stringify(outputSchema);
  const inputAnalysis = analyzeJsonStructure(resolved.modelInput);
  const promptInputOverlapCount = countPromptInputOverlaps(
    promptTexts,
    modelInputJson,
  );

  return Object.freeze({
    provider: input.provider,
    model: input.model,
    modelProfileId: resolved.modelProfileId,
    requestKind: resolved.requestKind,
    promptBlockCount: promptTexts.length,
    promptCharCount: promptTexts.reduce(
      (total, text) => total + text.length,
      0,
    ),
    promptDistinctTextCount: distinctPromptTexts.size,
    promptDuplicateBlockCount: promptTexts.length - distinctPromptTexts.size,
    modelInputByteCount: Buffer.byteLength(modelInputJson, "utf8"),
    modelInputTopLevelKeys: Object.freeze(
      Object.keys(resolved.modelInput).sort(),
    ),
    repeatedFieldNames: inputAnalysis.repeatedFieldNames,
    duplicateStringValues: inputAnalysis.duplicateStringValues,
    promptInputOverlapCount,
    schemaByteCount: Buffer.byteLength(schemaJson, "utf8"),
  });
}

export function observeModelProviderOutput(input: {
  readonly provider: string;
  readonly model: string;
  readonly modelProfileId: string;
  readonly requestKind: string;
  readonly durationMs: number;
  readonly output: JsonObject;
  readonly usage: ProviderUsageObservation;
}): ModelProviderResponseObservation {
  const outputJson = JSON.stringify(input.output);
  const analysis = analyzeJsonStructure(input.output);
  return Object.freeze({
    provider: input.provider,
    model: input.model,
    modelProfileId: input.modelProfileId,
    requestKind: input.requestKind,
    durationMs: input.durationMs,
    outputTopLevelKeys: Object.freeze(Object.keys(input.output).sort()),
    outputByteCount: Buffer.byteLength(outputJson, "utf8"),
    repeatedFieldNames: analysis.repeatedFieldNames,
    duplicateStringValues: analysis.duplicateStringValues,
    usage: serializeUsage(input.usage),
  });
}

function serializeUsage(usage: ProviderUsageObservation): JsonObject {
  if (usage.status === "complete") {
    const cacheHitRatio =
      usage.inputTokens === 0
        ? 0
        : Number(
            (usage.cachedInputTokens / usage.inputTokens).toFixed(4),
          );
    return Object.freeze({
      status: usage.status,
      provider_kind: usage.providerKind,
      provider_model: usage.providerModel,
      input_tokens: usage.inputTokens,
      cached_input_tokens: usage.cachedInputTokens,
      cache_miss_tokens: usage.inputTokens - usage.cachedInputTokens,
      cache_hit_ratio: cacheHitRatio,
      output_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    });
  }
  if (usage.status === "partial") {
    return Object.freeze({
      status: usage.status,
      provider_kind: usage.providerKind,
      provider_model: usage.providerModel,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    });
  }
  return Object.freeze({
    status: usage.status,
    provider_kind: usage.providerKind,
    provider_model: usage.providerModel,
  });
}

function analyzeJsonStructure(value: JsonValue): {
  readonly repeatedFieldNames: readonly {
    readonly field: string;
    readonly count: number;
  }[];
  readonly duplicateStringValues: readonly {
    readonly valuePreview: string;
    readonly valueLength: number;
    readonly paths: readonly string[];
  }[];
} {
  const fieldCounts = new Map<string, number>();
  const stringPaths = new Map<string, string[]>();

  const visit = (candidate: JsonValue, path: string): void => {
    if (Array.isArray(candidate)) {
      for (const [index, entry] of candidate.entries()) {
        visit(entry as JsonValue, `${path}[${index}]`);
      }
      return;
    }
    if (
      typeof candidate !== "object" ||
      candidate === null
    ) {
      if (
        typeof candidate === "string" &&
        candidate.length >= MIN_DUPLICATE_STRING_LENGTH
      ) {
        const paths = stringPaths.get(candidate) ?? [];
        if (paths.length < 8) {
          paths.push(truncatePath(path.length === 0 ? "$" : path));
        }
        stringPaths.set(candidate, paths);
      }
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      fieldCounts.set(key, (fieldCounts.get(key) ?? 0) + 1);
      const childPath =
        path.length === 0 ? key : `${path}.${key}`;
      visit(child as JsonValue, childPath);
    }
  };

  visit(value, "");

  const repeatedFieldNames = Object.freeze(
    [...fieldCounts.entries()]
      .filter(([, count]) => count > 1)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_DUPLICATE_REPORTS)
      .map(([field, count]) =>
        Object.freeze({ field, count }),
      ),
  );

  const duplicateStringValues = Object.freeze(
    [...stringPaths.entries()]
      .filter(([, paths]) => paths.length > 1)
      .sort(
        (left, right) =>
          right[1].length - left[1].length ||
          right[0].length - left[0].length,
      )
      .slice(0, MAX_DUPLICATE_REPORTS)
      .map(([text, paths]) =>
        Object.freeze({
          valuePreview: previewText(text),
          valueLength: text.length,
          paths: Object.freeze([...paths]),
        }),
      ),
  );

  return Object.freeze({
    repeatedFieldNames,
    duplicateStringValues,
  });
}

function countPromptInputOverlaps(
  promptTexts: readonly string[],
  modelInputJson: string,
): number {
  let overlaps = 0;
  for (const text of promptTexts) {
    if (
      text.length >= MIN_DUPLICATE_STRING_LENGTH &&
      modelInputJson.includes(text)
    ) {
      overlaps += 1;
    }
  }
  return overlaps;
}

function previewText(value: string): string {
  if (value.length <= 80) {
    return value;
  }
  return `${value.slice(0, 77)}...`;
}

function truncatePath(path: string): string {
  if (path.length <= MAX_PATH_LENGTH) {
    return path;
  }
  return `${path.slice(0, MAX_PATH_LENGTH - 3)}...`;
}

function writeLogLine(payload: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}
