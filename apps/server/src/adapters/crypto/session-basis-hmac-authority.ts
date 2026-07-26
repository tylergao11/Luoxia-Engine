import { createHmac, timingSafeEqual } from "node:crypto";

import {
  CONTRACT_REF,
  EngineFault,
  type ContractValidator,
  type JsonDigest,
  type JsonObject,
} from "@luoxia/contracts-runtime";

import type {
  EngineSessionBasisTokenAuthority,
  EngineSessionRecord,
} from "../../application/engine-session.js";

const TOKEN_VERSION = "v1";
const MIN_SECRET_BYTES = 32;
const HMAC_HEX_LENGTH = 64;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export interface SessionBasisHmacKey {
  readonly keyId: string;
  /** At least 32 bytes. Copied into authority ownership. */
  readonly secret: Uint8Array;
}

/**
 * Independent from DeterministicContext keys. Deployment must provide both
 * keyrings explicitly; neither authority reads environment variables.
 */
export interface SessionBasisHmacKeyring {
  readonly activeKeyId: string;
  readonly keys: readonly SessionBasisHmacKey[];
}

export interface HmacSessionBasisTokenAuthorityDependencies {
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly keyring: SessionBasisHmacKeyring;
}

export function createHmacSessionBasisTokenAuthority(
  dependencies: HmacSessionBasisTokenAuthorityDependencies,
): EngineSessionBasisTokenAuthority {
  return new HmacSessionBasisTokenAuthority(dependencies);
}

class HmacSessionBasisTokenAuthority
  implements EngineSessionBasisTokenAuthority
{
  readonly #contracts: ContractValidator;
  readonly #digest: JsonDigest;
  readonly #activeKeyId: string;
  readonly #secrets = new Map<string, Uint8Array>();

  public constructor(
    dependencies: HmacSessionBasisTokenAuthorityDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#digest = dependencies.digest;
    this.#activeKeyId = dependencies.keyring.activeKeyId;
    if (dependencies.keyring.keys.length === 0) {
      throw new EngineFault(
        "session.basis_token.keyring_empty",
        "Session basis_token HMAC keyring must contain at least one key",
      );
    }
    for (const key of dependencies.keyring.keys) {
      if (!KEY_ID_PATTERN.test(key.keyId)) {
        throw new EngineFault(
          "session.basis_token.key_id_invalid",
          "Session basis_token key id must match [A-Za-z0-9_-]{1,64}",
          { key_id: key.keyId },
        );
      }
      if (!(key.secret instanceof Uint8Array)) {
        throw new EngineFault(
          "session.basis_token.secret_invalid",
          "Session basis_token HMAC secret must be a Uint8Array",
          { key_id: key.keyId },
        );
      }
      if (key.secret.byteLength < MIN_SECRET_BYTES) {
        throw new EngineFault(
          "session.basis_token.secret_too_short",
          "Session basis_token HMAC secret must be at least 32 bytes",
          { key_id: key.keyId, minimum_bytes: MIN_SECRET_BYTES },
        );
      }
      if (this.#secrets.has(key.keyId)) {
        throw new EngineFault(
          "session.basis_token.duplicate_key_id",
          "Session basis_token key id appears more than once",
          { key_id: key.keyId },
        );
      }
      this.#secrets.set(key.keyId, new Uint8Array(key.secret));
    }
    if (!this.#secrets.has(this.#activeKeyId)) {
      throw new EngineFault(
        "session.basis_token.active_key_missing",
        "Session basis_token activeKeyId is not present in keys",
        { active_key_id: this.#activeKeyId },
      );
    }
  }

  public issue(session: EngineSessionRecord): string {
    const secret = this.#secrets.get(this.#activeKeyId);
    if (secret === undefined) {
      throw new EngineFault(
        "session.basis_token.active_key_missing",
        "Session basis_token active key is not configured",
      );
    }
    const macHex = this.#macHex(secret, session);
    return `${TOKEN_VERSION}.${this.#activeKeyId}.${macHex}`;
  }

  public assertAuthentic(
    session: EngineSessionRecord,
    candidate: string,
  ): void {
    const parsed = parseToken(candidate);
    const secret = this.#secrets.get(parsed.keyId);
    if (secret === undefined) {
      throw new EngineFault(
        "session.basis_token.unknown_key",
        "Session basis_token key id is not configured",
        { key_id: parsed.keyId },
      );
    }
    const expected = Buffer.from(this.#macHex(secret, session), "hex");
    const actual = Buffer.from(parsed.macHex, "hex");
    if (
      expected.byteLength !== actual.byteLength ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new EngineFault(
        "session.basis_token.mac_mismatch",
        "Session basis_token does not match current Session state",
        { session_id: session.sessionId },
      );
    }
  }

  #macHex(secret: Uint8Array, session: EngineSessionRecord): string {
    const body = sessionDigestBody(this.#contracts, session);
    const stateDigest = this.#digest.sha256(body);
    return createHmac("sha256", secret)
      .update(stateDigest, "utf8")
      .digest("hex");
  }
}

function sessionDigestBody(
  contracts: ContractValidator,
  session: EngineSessionRecord,
): JsonObject {
  for (const [label, value] of [
    ["session_id", session.sessionId],
    ["world_id", session.worldId],
    ["control_binding_id", session.controlBindingId],
    ["player_entity_id", session.playerEntityId],
    ["nonce", session.nonce],
  ] as const) {
    contracts.assert(CONTRACT_REF.uuid, value);
    void label;
  }
  assertSafeRevision(session.viewRevision, "view_revision");
  assertSafeRevision(session.worldRevision, "world_revision");
  return Object.freeze({
    session_id: session.sessionId,
    world_id: session.worldId,
    control_binding_id: session.controlBindingId,
    player_entity_id: session.playerEntityId,
    view_revision: session.viewRevision,
    world_revision: session.worldRevision,
    nonce: session.nonce,
  });
}

function assertSafeRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EngineFault(
      "session.basis_token.state_invalid",
      `Session ${label} must be a safe unsigned integer`,
      { [label]: value },
    );
  }
}

function parseToken(token: string): { keyId: string; macHex: string } {
  if (typeof token !== "string" || token.length < 32 || token.length > 512) {
    throw new EngineFault(
      "session.basis_token.format_invalid",
      "Session basis_token format is invalid",
    );
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new EngineFault(
      "session.basis_token.format_invalid",
      "Session basis_token format is invalid",
    );
  }
  const [version, keyId, macHex] = parts;
  if (
    version !== TOKEN_VERSION ||
    typeof keyId !== "string" ||
    !KEY_ID_PATTERN.test(keyId) ||
    typeof macHex !== "string" ||
    macHex.length !== HMAC_HEX_LENGTH ||
    !/^[0-9a-f]+$/iu.test(macHex)
  ) {
    throw new EngineFault(
      "session.basis_token.format_invalid",
      "Session basis_token format is invalid",
    );
  }
  return { keyId, macHex: macHex.toLowerCase() };
}
