export type JsonScalar = null | boolean | number | string;

export type JsonValue =
  | JsonScalar
  | readonly JsonValue[]
  | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export function assertJsonValue(
  candidate: unknown,
  label: string,
): asserts candidate is JsonValue {
  visitJsonValue(candidate, label, new WeakSet<object>());
}

export function deepFreezeJson<TValue extends JsonValue>(value: TValue): TValue {
  freezeJsonValue(value, new WeakSet<object>());
  return value;
}

export function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }
    return (
      left.length === right.length &&
      left.every((entry, index) => jsonEquals(entry, right[index] as JsonValue))
    );
  }

  if (!isJsonObject(left) || !isJsonObject(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    !leftKeys.every((key, index) => key === rightKeys[index])
  ) {
    return false;
  }

  return leftKeys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    return (
      leftValue !== undefined &&
      rightValue !== undefined &&
      jsonEquals(leftValue, rightValue)
    );
  });
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectJsonObject(value: JsonValue, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }

  return value;
}

export function expectProperty(
  object: JsonObject,
  property: string,
  label: string,
): JsonValue {
  const value = object[property];
  if (value === undefined) {
    throw new TypeError(`${label}.${property} is required`);
  }

  return value;
}

export function expectString(
  object: JsonObject,
  property: string,
  label: string,
): string {
  const value = object[property];
  if (typeof value !== "string") {
    throw new TypeError(`${label}.${property} must be a string`);
  }

  return value;
}

export function expectInteger(
  object: JsonObject,
  property: string,
  label: string,
): number {
  const value = object[property];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${label}.${property} must be an integer`);
  }

  return value;
}

function visitJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite JSON numbers`);
    }
    return;
  }

  if (typeof value !== "object") {
    throw new TypeError(`${path} must be a JSON value`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`${path} must not contain cyclic references`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      visitJsonValue(entry, `${path}[${index}]`, ancestors);
    });
  } else {
    const prototype: object | null = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }

    for (const [key, entry] of Object.entries(value)) {
      visitJsonValue(entry, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function freezeJsonValue(value: JsonValue, visited: WeakSet<object>): void {
  if (typeof value !== "object" || value === null || visited.has(value)) {
    return;
  }

  visited.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      freezeJsonValue(entry, visited);
    }
  } else {
    for (const entry of Object.values(value)) {
      freezeJsonValue(entry, visited);
    }
  }
  Object.freeze(value);
}
