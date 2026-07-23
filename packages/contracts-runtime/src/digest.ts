import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { EngineFault } from "./fault.js";
import type { JsonValue } from "./json.js";

export interface JsonDigest {
  canonicalize(value: JsonValue): string;
  sha256(value: JsonValue): string;
}

export class Rfc8785JsonDigest implements JsonDigest {
  public canonicalize(value: JsonValue): string {
    const canonical = canonicalize(value);
    if (canonical === undefined) {
      throw new EngineFault(
        "contract.digest.canonicalization_failed",
        "Value cannot be represented by RFC 8785 JSON canonicalization",
      );
    }

    return canonical;
  }

  public sha256(value: JsonValue): string {
    return createHash("sha256")
      .update(this.canonicalize(value), "utf8")
      .digest("hex");
  }
}

