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

import type { ContractValidator } from "./contract-validator.js";
import { EngineFault } from "./fault.js";
import type { JsonObject } from "./json.js";
import { assertJsonValue, isJsonObject } from "./json.js";
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

export class SchemaRegistry implements ContractValidator {
  public readonly schemaIds: readonly string[];

  readonly #ajv: Ajv2020;

  private constructor(ajv: Ajv2020, schemaIds: readonly string[]) {
    this.#ajv = ajv;
    this.schemaIds = Object.freeze([...schemaIds]);
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
    }

    for (const schemaId of schemaIds) {
      requireValidator(ajv, schemaId);
    }

    return new SchemaRegistry(ajv, schemaIds);
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
