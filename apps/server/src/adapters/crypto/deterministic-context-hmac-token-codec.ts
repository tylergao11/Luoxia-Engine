import { createHmac, timingSafeEqual } from "node:crypto";

import { EngineFault, type JsonDigest } from "@luoxia/contracts-runtime";
import type { DeterministicContextTokenCodec } from "@luoxia/world-core/composition";

const TOKEN_VERSION = "v1";
const MIN_SECRET_BYTES = 32;
const HMAC_HEX_LENGTH = 64;

export interface DeterministicContextHmacKey {
  readonly keyId: string;
  /** At least 32 bytes. Copied into codec ownership. */
  readonly secret: Uint8Array;
}

/**
 * Explicit composition-root keyring. No env reads, defaults, or auto-generation.
 */
export interface DeterministicContextHmacKeyring {
  readonly activeKeyId: string;
  readonly keys: readonly DeterministicContextHmacKey[];
}

export interface HmacDeterministicContextTokenCodecDependencies {
  readonly digest: JsonDigest;
  readonly keyring: DeterministicContextHmacKeyring;
}

/**
 * Sole HMAC-SHA256 TokenCodec for DeterministicContext.issuer_token.
 * MAC input is RFC 8785 JCS of a fixed envelope { v, world_id, context_digest }.
 */
export function createHmacDeterministicContextTokenCodec(
  dependencies: HmacDeterministicContextTokenCodecDependencies,
): DeterministicContextTokenCodec {
  return new HmacDeterministicContextTokenCodec(dependencies);
}

class HmacDeterministicContextTokenCodec
  implements DeterministicContextTokenCodec
{
  readonly #digest: JsonDigest;
  readonly #activeKeyId: string;
  readonly #secrets = new Map<string, Uint8Array>();

  public constructor(
    dependencies: HmacDeterministicContextTokenCodecDependencies,
  ) {
    this.#digest = dependencies.digest;
    this.#activeKeyId = dependencies.keyring.activeKeyId;

    if (dependencies.keyring.keys.length === 0) {
      throw new EngineFault(
        "deterministic_context.token.keyring_empty",
        "DeterministicContext HMAC keyring must contain at least one key",
      );
    }

    for (const key of dependencies.keyring.keys) {
      if (typeof key.keyId !== "string" || key.keyId.length === 0) {
        throw new EngineFault(
          "deterministic_context.token.key_id_invalid",
          "DeterministicContext HMAC key id must be a non-empty string",
        );
      }
      if (key.keyId.includes(".")) {
        throw new EngineFault(
          "deterministic_context.token.key_id_invalid",
          "DeterministicContext HMAC key id must not contain '.'",
          { key_id: key.keyId },
        );
      }
      if (!(key.secret instanceof Uint8Array)) {
        throw new EngineFault(
          "deterministic_context.token.secret_invalid",
          "DeterministicContext HMAC secret must be a Uint8Array",
          { key_id: key.keyId },
        );
      }
      if (key.secret.byteLength < MIN_SECRET_BYTES) {
        throw new EngineFault(
          "deterministic_context.token.secret_too_short",
          "DeterministicContext HMAC secret must be at least 32 bytes",
          { key_id: key.keyId, minimum_bytes: MIN_SECRET_BYTES },
        );
      }
      if (this.#secrets.has(key.keyId)) {
        throw new EngineFault(
          "deterministic_context.token.duplicate_key_id",
          "DeterministicContext HMAC key id appears more than once",
          { key_id: key.keyId },
        );
      }
      this.#secrets.set(key.keyId, new Uint8Array(key.secret));
    }

    if (!this.#secrets.has(this.#activeKeyId)) {
      throw new EngineFault(
        "deterministic_context.token.active_key_missing",
        "DeterministicContext HMAC activeKeyId is not present in keys",
        { active_key_id: this.#activeKeyId },
      );
    }
  }

  public issue(input: {
    readonly worldId: string;
    readonly contextDigest: string;
  }): string {
    const secret = this.#secrets.get(this.#activeKeyId);
    if (secret === undefined) {
      throw new EngineFault(
        "deterministic_context.token.active_key_missing",
        "DeterministicContext HMAC active key is not configured",
      );
    }
    const macHex = this.#macHex(secret, input.worldId, input.contextDigest);
    return `${TOKEN_VERSION}.${this.#activeKeyId}.${macHex}`;
  }

  public assertAuthentic(input: {
    readonly worldId: string;
    readonly contextDigest: string;
    readonly issuerToken: string;
  }): void {
    const parsed = parseToken(input.issuerToken);
    const secret = this.#secrets.get(parsed.keyId);
    if (secret === undefined) {
      throw new EngineFault(
        "deterministic_context.token.unknown_key",
        "DeterministicContext issuer_token key id is not configured",
        { key_id: parsed.keyId },
      );
    }

    const expectedHex = this.#macHex(
      secret,
      input.worldId,
      input.contextDigest,
    );
    const expected = Buffer.from(expectedHex, "hex");
    const actual = Buffer.from(parsed.macHex, "hex");
    if (
      expected.byteLength !== actual.byteLength ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new EngineFault(
        "deterministic_context.token.mac_mismatch",
        "DeterministicContext issuer_token MAC verification failed",
        { key_id: parsed.keyId },
      );
    }
  }

  #macHex(
    secret: Uint8Array,
    worldId: string,
    contextDigest: string,
  ): string {
    const envelope = Object.freeze({
      v: 1,
      world_id: worldId,
      context_digest: contextDigest,
    });
    const canonical = this.#digest.canonicalize(envelope);
    return createHmac("sha256", secret)
      .update(canonical, "utf8")
      .digest("hex");
  }
}

function parseToken(token: string): { keyId: string; macHex: string } {
  if (typeof token !== "string" || token.length < 32) {
    throw new EngineFault(
      "deterministic_context.token.format_invalid",
      "DeterministicContext issuer_token format is invalid",
    );
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new EngineFault(
      "deterministic_context.token.format_invalid",
      "DeterministicContext issuer_token format is invalid",
    );
  }

  const [version, keyId, macHex] = parts;
  if (version !== TOKEN_VERSION) {
    throw new EngineFault(
      "deterministic_context.token.version_unsupported",
      "DeterministicContext issuer_token version is unsupported",
    );
  }
  if (typeof keyId !== "string" || keyId.length === 0) {
    throw new EngineFault(
      "deterministic_context.token.format_invalid",
      "DeterministicContext issuer_token format is invalid",
    );
  }
  if (
    typeof macHex !== "string" ||
    macHex.length !== HMAC_HEX_LENGTH ||
    !/^[0-9a-f]+$/i.test(macHex)
  ) {
    throw new EngineFault(
      "deterministic_context.token.format_invalid",
      "DeterministicContext issuer_token format is invalid",
    );
  }

  return { keyId, macHex: macHex.toLowerCase() };
}
