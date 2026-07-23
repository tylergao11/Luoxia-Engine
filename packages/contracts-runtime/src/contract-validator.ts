import type { ValidatedJson, ValidatedJsonObject } from "./validated-json.js";

export interface ContractValidator {
  readonly schemaIds: readonly string[];

  assert<const TSchemaRef extends string>(
    schemaRef: TSchemaRef,
    candidate: unknown,
  ): ValidatedJson<TSchemaRef>;

  assertObject<const TSchemaRef extends string>(
    schemaRef: TSchemaRef,
    candidate: unknown,
  ): ValidatedJsonObject<TSchemaRef>;
}

