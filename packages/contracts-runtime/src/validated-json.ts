import type { JsonObject, JsonValue } from "./json.js";
import { deepFreezeJson } from "./json.js";

const validatedJsonBrand: unique symbol = Symbol("ValidatedJson");

export interface ValidatedJson<
  TSchemaRef extends string = string,
  TValue extends JsonValue = JsonValue,
> {
  readonly schemaRef: TSchemaRef;
  readonly value: TValue;
  readonly [validatedJsonBrand]: true;
}

export function sealValidatedJson<
  const TSchemaRef extends string,
  TValue extends JsonValue,
>(schemaRef: TSchemaRef, value: TValue): ValidatedJson<TSchemaRef, TValue> {
  deepFreezeJson(value);
  return Object.freeze({
    schemaRef,
    value,
    [validatedJsonBrand]: true as const,
  });
}

export type ValidatedJsonObject<TSchemaRef extends string = string> =
  ValidatedJson<TSchemaRef, JsonObject>;
