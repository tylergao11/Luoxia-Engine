import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type {
  AnySchemaObject,
  ErrorObject,
  ValidateFunction,
} from "ajv";
import type { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";

import type {
  ContractSchemaExporter,
  ContractValidator,
} from "./contract-validator.js";
import { EngineFault } from "./fault.js";
import type { JsonObject, JsonValue } from "./json.js";
import {
  assertJsonValue,
  deepFreezeJson,
  isJsonObject,
} from "./json.js";
import {
  sealValidatedJson,
  type ValidatedJson,
  type ValidatedJsonObject,
} from "./validated-json.js";

const require = createRequire(import.meta.url);
const Ajv2020Constructor = (
  require("ajv/dist/2020.js") as { readonly default: typeof Ajv2020 }
).default;
const addFormats = (
  require("ajv-formats") as { readonly default: FormatsPlugin }
).default;

export class SchemaRegistry
  implements ContractValidator, ContractSchemaExporter
{
  public readonly schemaIds: readonly string[];

  readonly #ajv: Ajv2020;
  readonly #schemasById: ReadonlyMap<string, JsonObject>;

  private constructor(
    ajv: Ajv2020,
    schemaIds: readonly string[],
    schemasById: ReadonlyMap<string, JsonObject>,
  ) {
    this.#ajv = ajv;
    this.schemaIds = Object.freeze([...schemaIds]);
    this.#schemasById = schemasById;
  }

  public static async load(directory: string): Promise<SchemaRegistry> {
    const absoluteDirectory = resolve(directory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    const schemaFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".schema.json"))
      .map((entry) => entry.name)
      .sort();

    if (schemaFiles.length === 0) {
      throw new EngineFault(
        "contract.registry.empty",
        `No contract schemas found in ${absoluteDirectory}`,
      );
    }

    const ajv = new Ajv2020Constructor({
      allErrors: true,
      strict: true,
      strictRequired: false,
      strictTypes: false,
      validateFormats: true,
    });
    addFormats(ajv);

    const schemaIds: string[] = [];
    const schemasById = new Map<string, JsonObject>();
    for (const fileName of schemaFiles) {
      const filePath = resolve(absoluteDirectory, fileName);
      const source = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(source);

      if (!isUnknownObject(parsed)) {
        throw new EngineFault(
          "contract.schema.root_invalid",
          `${fileName} must contain a JSON object`,
        );
      }

      const schemaId = parsed["$id"];
      if (typeof schemaId !== "string" || schemaId.length === 0) {
        throw new EngineFault(
          "contract.schema.id_missing",
          `${fileName} does not declare $id`,
        );
      }

      if (schemaIds.includes(schemaId)) {
        throw new EngineFault(
          "contract.schema.id_duplicate",
          `Duplicate contract schema id ${schemaId}`,
        );
      }

      ajv.addSchema(parsed as AnySchemaObject, schemaId);
      schemaIds.push(schemaId);
      assertJsonValue(parsed, fileName);
      if (!isJsonObject(parsed)) {
        throw new EngineFault(
          "contract.schema.root_invalid",
          `${fileName} must contain a JSON object`,
        );
      }
      schemasById.set(schemaId, deepFreezeJson(parsed));
    }

    for (const schemaId of schemaIds) {
      requireValidator(ajv, schemaId);
    }

    return new SchemaRegistry(
      ajv,
      schemaIds,
      new Map(schemasById),
    );
  }

  public assert<const TSchemaRef extends string>(
    schemaRef: TSchemaRef,
    candidate: unknown,
  ): ValidatedJson<TSchemaRef> {
    assertJsonValue(candidate, schemaRef);
    const validator = requireValidator(this.#ajv, schemaRef);
    if (!validator(candidate)) {
      throw new EngineFault(
        "contract.value.invalid",
        `Value does not satisfy ${schemaRef}`,
        {
          schema_ref: schemaRef,
          errors: normalizeErrors(validator.errors),
        },
      );
    }

    return sealValidatedJson(schemaRef, candidate);
  }

  public assertObject<const TSchemaRef extends string>(
    schemaRef: TSchemaRef,
    candidate: unknown,
  ): ValidatedJsonObject<TSchemaRef> {
    const validated = this.assert(schemaRef, candidate);
    if (!isJsonObject(validated.value)) {
      throw new EngineFault(
        "contract.value.not_object",
        `${schemaRef} must validate to a JSON object`,
      );
    }

    return sealValidatedJson(schemaRef, validated.value);
  }

  public exportStandaloneSchema(schemaRef: string): JsonObject {
    return exportStandaloneSchema(this.#schemasById, schemaRef);
  }
}

function exportStandaloneSchema(
  schemasById: ReadonlyMap<string, JsonObject>,
  schemaRef: string,
): JsonObject {
  const rootTarget = resolveSchemaTarget(schemasById, schemaRef);
  if (!isJsonObject(rootTarget.value)) {
    throw new EngineFault(
      "contract.schema.export_target_not_object",
      "Standalone schema export target must be a JSON object",
      { schema_ref: schemaRef },
    );
  }

  const definitions: Record<string, JsonValue> = {};
  const definitionKeys = new Map<string, string>();

  const ensureDefinition = (targetRef: string): string => {
    const canonicalRef = canonicalSchemaRef(targetRef);
    const existing = definitionKeys.get(canonicalRef);
    if (existing !== undefined) {
      return existing;
    }

    const key = `schema_${definitionKeys.size}`;
    definitionKeys.set(canonicalRef, key);
    definitions[key] = {};
    const target = resolveSchemaTarget(schemasById, canonicalRef);
    definitions[key] = cloneSchemaNode(
      target.value,
      target.documentId,
      ensureDefinition,
    );
    return key;
  };

  const clonedRoot = cloneSchemaNode(
    rootTarget.value,
    rootTarget.documentId,
    ensureDefinition,
  );
  if (!isJsonObject(clonedRoot)) {
    throw new EngineFault(
      "contract.schema.export_target_not_object",
      "Standalone schema export target must remain a JSON object",
      { schema_ref: schemaRef },
    );
  }

  const exported: Record<string, JsonValue> = {};
  const draft = rootTarget.document["$schema"];
  if (typeof draft === "string") {
    exported["$schema"] = draft;
  }
  for (const [key, value] of Object.entries(clonedRoot)) {
    exported[key] = value;
  }
  if (Object.keys(definitions).length > 0) {
    exported["$defs"] = definitions;
  }
  return deepFreezeJson(exported);
}

interface ResolvedSchemaTarget {
  readonly documentId: string;
  readonly document: JsonObject;
  readonly value: JsonValue;
}

function resolveSchemaTarget(
  schemasById: ReadonlyMap<string, JsonObject>,
  schemaRef: string,
): ResolvedSchemaTarget {
  const canonicalRef = canonicalSchemaRef(schemaRef);
  const url = new URL(canonicalRef);
  const fragment = url.hash;
  url.hash = "";
  const documentId = url.toString();
  const document = schemasById.get(documentId);
  if (document === undefined) {
    throw new EngineFault(
      "contract.schema.export_document_unknown",
      "Standalone schema export references an unloaded contract document",
      { schema_ref: canonicalRef, document_id: documentId },
    );
  }

  let value: JsonValue = document;
  if (fragment.length > 0 && fragment !== "#") {
    if (!fragment.startsWith("#/")) {
      throw new EngineFault(
        "contract.schema.export_fragment_unsupported",
        "Standalone schema export supports JSON Pointer fragments only",
        { schema_ref: canonicalRef, fragment },
      );
    }
    const decodedPointer = decodeURIComponent(fragment.slice(2));
    const segments = decodedPointer
      .split("/")
      .map((segment) =>
        segment.replaceAll("~1", "/").replaceAll("~0", "~"),
      );
    for (const segment of segments) {
      if (Array.isArray(value)) {
        if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) {
          throw unresolvedSchemaPointer(canonicalRef, segment);
        }
        const entry: JsonValue | undefined = (
          value as readonly JsonValue[]
        )[Number(segment)];
        if (entry === undefined) {
          throw unresolvedSchemaPointer(canonicalRef, segment);
        }
        value = entry;
        continue;
      }
      if (!isJsonObject(value)) {
        throw unresolvedSchemaPointer(canonicalRef, segment);
      }
      const entry = value[segment];
      if (entry === undefined) {
        throw unresolvedSchemaPointer(canonicalRef, segment);
      }
      value = entry;
    }
  }

  return Object.freeze({
    documentId,
    document,
    value,
  });
}

function cloneSchemaNode(
  node: JsonValue,
  baseDocumentId: string,
  ensureDefinition: (targetRef: string) => string,
): JsonValue {
  if (
    node === null ||
    typeof node === "string" ||
    typeof node === "boolean" ||
    typeof node === "number"
  ) {
    return node;
  }
  if (!isJsonObject(node)) {
    return (node as readonly JsonValue[]).map((entry) =>
      cloneSchemaNode(entry, baseDocumentId, ensureDefinition),
    );
  }

  const nestedId = node["$id"];
  const effectiveBase =
    typeof nestedId === "string"
      ? new URL(nestedId, baseDocumentId).toString()
      : baseDocumentId;
  const cloned: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema" || key === "$id" || key === "$defs") {
      continue;
    }
    if (key === "$ref") {
      if (typeof value !== "string") {
        throw new EngineFault(
          "contract.schema.export_ref_invalid",
          "JSON Schema $ref must be a string",
          { base_document_id: effectiveBase },
        );
      }
      const targetRef = new URL(value, effectiveBase).toString();
      cloned["$ref"] = `#/$defs/${ensureDefinition(targetRef)}`;
      continue;
    }
    cloned[key] = cloneSchemaNode(
      value,
      effectiveBase,
      ensureDefinition,
    );
  }
  return cloned;
}

function canonicalSchemaRef(schemaRef: string): string {
  if (
    typeof schemaRef !== "string" ||
    schemaRef.length === 0 ||
    schemaRef !== schemaRef.trim()
  ) {
    throw new EngineFault(
      "contract.schema.export_ref_invalid",
      "Standalone schema export requires one clean absolute schema reference",
      { schema_ref: schemaRef },
    );
  }
  try {
    return new URL(schemaRef).toString();
  } catch {
    throw new EngineFault(
      "contract.schema.export_ref_invalid",
      "Standalone schema export requires one clean absolute schema reference",
      { schema_ref: schemaRef },
    );
  }
}

function unresolvedSchemaPointer(
  schemaRef: string,
  segment: string,
): EngineFault {
  return new EngineFault(
    "contract.schema.export_pointer_unresolved",
    "Standalone schema export could not resolve a JSON Pointer segment",
    { schema_ref: schemaRef, segment },
  );
}

function requireValidator(ajv: Ajv2020, schemaRef: string): ValidateFunction {
  let validator: ValidateFunction | undefined;
  try {
    validator = ajv.getSchema(schemaRef);
  } catch (error: unknown) {
    throw new EngineFault(
      "contract.reference.unresolved",
      `Cannot compile contract reference ${schemaRef}`,
      { cause: errorMessage(error) },
    );
  }

  if (validator === undefined) {
    throw new EngineFault(
      "contract.reference.unknown",
      `Unknown contract reference ${schemaRef}`,
    );
  }

  return validator;
}

function normalizeErrors(
  errors: readonly ErrorObject[] | null | undefined,
): readonly JsonObject[] {
  if (errors === null || errors === undefined) {
    return [];
  }

  return errors.map((error) => ({
    instance_path: error.instancePath,
    schema_path: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "",
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnknownObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
