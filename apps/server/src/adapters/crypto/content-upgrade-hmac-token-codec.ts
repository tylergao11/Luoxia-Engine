import { createHmac, timingSafeEqual } from "node:crypto";

import { EngineFault } from "@luoxia/contracts-runtime";
import type { ContentUpgradeAuthorizationTokenCodec } from "@luoxia/world-core";

const TOKEN_VERSION = "v1";
const MIN_SECRET_BYTES = 32;
const HMAC_HEX_LENGTH = 64;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export interface ContentUpgradeHmacKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

/**
 * Independent deployment keyring. Content Upgrade authorization must not
 * reuse Session or DeterministicContext key material.
 */
export interface ContentUpgradeHmacKeyring {
  readonly activeKeyId: string;
  readonly keys: readonly ContentUpgradeHmacKey[];
}

export interface HmacContentUpgradeTokenCodecDependencies {
  readonly keyring: ContentUpgradeHmacKeyring;
}

export function createHmacContentUpgradeTokenCodec(
  dependencies: HmacContentUpgradeTokenCodecDependencies,
): ContentUpgradeAuthorizationTokenCodec {
  return new HmacContentUpgradeTokenCodec(dependencies.keyring);
}

class HmacContentUpgradeTokenCodec
  implements ContentUpgradeAuthorizationTokenCodec
{
  readonly #activeKeyId: string;
  readonly #secrets = new Map<string, Uint8Array>();

  public constructor(keyring: ContentUpgradeHmacKeyring) {
    this.#activeKeyId = keyring.activeKeyId;
    if (keyring.keys.length === 0) {
      throw new EngineFault(
        "content_upgrade.token.keyring_empty",
        "Content Upgrade HMAC keyring must contain at least one key",
      );
    }
    for (const key of keyring.keys) {
      if (!KEY_ID_PATTERN.test(key.keyId)) {
        throw new EngineFault(
          "content_upgrade.token.key_id_invalid",
          "Content Upgrade HMAC key id must match [A-Za-z0-9_-]{1,64}",
          { key_id: key.keyId },
        );
      }
      if (!(key.secret instanceof Uint8Array)) {
        throw new EngineFault(
          "content_upgrade.token.secret_invalid",
          "Content Upgrade HMAC secret must be a Uint8Array",
          { key_id: key.keyId },
        );
      }
      if (key.secret.byteLength < MIN_SECRET_BYTES) {
        throw new EngineFault(
          "content_upgrade.token.secret_too_short",
          "Content Upgrade HMAC secret must be at least 32 bytes",
          { key_id: key.keyId, minimum_bytes: MIN_SECRET_BYTES },
        );
      }
      if (this.#secrets.has(key.keyId)) {
        throw new EngineFault(
          "content_upgrade.token.duplicate_key_id",
          "Content Upgrade HMAC key id appears more than once",
          { key_id: key.keyId },
        );
      }
      this.#secrets.set(key.keyId, new Uint8Array(key.secret));
    }
    if (!this.#secrets.has(this.#activeKeyId)) {
      throw new EngineFault(
        "content_upgrade.token.active_key_missing",
        "Content Upgrade HMAC activeKeyId is not present in keys",
        { active_key_id: this.#activeKeyId },
      );
    }
  }

  public issue(input: { readonly authorizationDigest: string }): string {
    const secret = this.#secrets.get(this.#activeKeyId);
    if (secret === undefined) {
      throw new EngineFault(
        "content_upgrade.token.active_key_missing",
        "Content Upgrade HMAC active key is not configured",
      );
    }
    return `${TOKEN_VERSION}.${this.#activeKeyId}.${macHex(
      secret,
      input.authorizationDigest,
    )}`;
  }

  public assertAuthentic(input: {
    readonly authorizationDigest: string;
    readonly authorizationToken: string;
  }): void {
    const parsed = parseToken(input.authorizationToken);
    const secret = this.#secrets.get(parsed.keyId);
    if (secret === undefined) {
      throw new EngineFault(
        "content_upgrade.token.unknown_key",
        "Content Upgrade authorization token key id is not configured",
        { key_id: parsed.keyId },
      );
    }
    const expected = Buffer.from(
      macHex(secret, input.authorizationDigest),
      "hex",
    );
    const actual = Buffer.from(parsed.macHex, "hex");
    if (
      expected.byteLength !== actual.byteLength ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new EngineFault(
        "content_upgrade.token.mac_mismatch",
        "Content Upgrade authorization token MAC verification failed",
        { key_id: parsed.keyId },
      );
    }
  }
}

function macHex(secret: Uint8Array, authorizationDigest: string): string {
  return createHmac("sha256", secret)
    .update(`luoxia.content_upgrade.authorization.v1\0${authorizationDigest}`, "utf8")
    .digest("hex");
}

function parseToken(token: string): { keyId: string; macHex: string } {
  if (typeof token !== "string" || token.length < 32 || token.length > 512) {
    throw new EngineFault(
      "content_upgrade.token.format_invalid",
      "Content Upgrade authorization token format is invalid",
    );
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new EngineFault(
      "content_upgrade.token.format_invalid",
      "Content Upgrade authorization token format is invalid",
    );
  }
  const [version, keyId, candidateMac] = parts;
  if (
    version !== TOKEN_VERSION ||
    typeof keyId !== "string" ||
    !KEY_ID_PATTERN.test(keyId) ||
    typeof candidateMac !== "string" ||
    candidateMac.length !== HMAC_HEX_LENGTH ||
    !/^[0-9a-f]+$/iu.test(candidateMac)
  ) {
    throw new EngineFault(
      "content_upgrade.token.format_invalid",
      "Content Upgrade authorization token format is invalid",
    );
  }
  return { keyId, macHex: candidateMac.toLowerCase() };
}
