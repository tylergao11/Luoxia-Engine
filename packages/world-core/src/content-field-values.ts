import {
  EngineFault,
  expectJsonObject,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime/portable";

/**
 * Sole lossless materialization of ContentBundle FieldValues into the
 * JsonObject slot used by runtime component and relation state.
 *
 * The original, schema-validated FieldValues array remains the fact owner.
 * The wrapper only gives that array a stable object shape; it does not infer
 * field names, coerce values, or introduce a parallel model.
 */
export function materializeContentFieldValues(
  candidate: JsonValue,
  path: string,
): JsonObject {
  if (!Array.isArray(candidate)) {
    throw new EngineFault(
      "content.runtime.field_values_shape",
      "ContentBundle FieldValues must be an array before runtime materialization",
      { path },
    );
  }
  for (const [index, field] of candidate.entries()) {
    expectJsonObject(field, `${path}[${index}]`);
  }
  return Object.freeze({
    field_values: candidate,
  });
}
