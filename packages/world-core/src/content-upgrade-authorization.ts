import {
  CONTRACT_REF,
  EngineFault,
  expectString,
  type ContractValidator,
  type JsonObject,
  type JsonValue,
  type UpgradeAuthorizationDocument,
} from "@luoxia/contracts-runtime/portable";

export interface ContentUpgradeAuthorizationDigest {
  sha256(value: JsonValue): string;
}

export interface ContentUpgradeAuthorizationTokenCodec {
  issue(input: { readonly authorizationDigest: string }): string;
  assertAuthentic(input: {
    readonly authorizationDigest: string;
    readonly authorizationToken: string;
  }): void;
}

export interface ContentUpgradeAuthorizationIssueInput {
  readonly upgradeCommandId: string;
  readonly worldId: string;
  readonly migrationId: string;
  readonly requestedByActorId: string;
  readonly sourceWorldRevision: number;
  readonly sourceSaveDigest: string;
  readonly sourceBundleDigest: string;
  readonly targetBundleDigest: string;
  readonly consentTextDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ContentUpgradeAuthorizationAuthority {
  issue(
    input: ContentUpgradeAuthorizationIssueInput,
  ): UpgradeAuthorizationDocument;
  assertAuthentic(
    candidate: unknown,
    currentTime: string,
  ): UpgradeAuthorizationDocument;
}

export interface ContentUpgradeAuthorizationAuthorityDependencies {
  readonly contracts: ContractValidator;
  readonly digest: ContentUpgradeAuthorizationDigest;
  readonly tokenCodec: ContentUpgradeAuthorizationTokenCodec;
}

const ISSUER = "world_core";

/**
 * World Core owns the authenticated upgrade decision. The authorization
 * digest covers every validated field except the digest and token proof
 * themselves; the independent Server codec owns key material and HMAC.
 */
export function createContentUpgradeAuthorizationAuthority(
  dependencies: ContentUpgradeAuthorizationAuthorityDependencies,
): ContentUpgradeAuthorizationAuthority {
  return new DefaultContentUpgradeAuthorizationAuthority(dependencies);
}

class DefaultContentUpgradeAuthorizationAuthority
  implements ContentUpgradeAuthorizationAuthority
{
  readonly #contracts: ContractValidator;
  readonly #digest: ContentUpgradeAuthorizationDigest;
  readonly #tokenCodec: ContentUpgradeAuthorizationTokenCodec;

  public constructor(
    dependencies: ContentUpgradeAuthorizationAuthorityDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#digest = dependencies.digest;
    this.#tokenCodec = dependencies.tokenCodec;
  }

  public issue(
    input: ContentUpgradeAuthorizationIssueInput,
  ): UpgradeAuthorizationDocument {
    assertAuthorizationWindow(input.issuedAt, input.expiresAt, input.issuedAt);
    const digestBody = Object.freeze({
      issuer: ISSUER,
      upgrade_command_id: input.upgradeCommandId,
      world_id: input.worldId,
      migration_id: input.migrationId,
      requested_by_actor_id: input.requestedByActorId,
      source_world_revision: input.sourceWorldRevision,
      source_save_digest: input.sourceSaveDigest,
      source_bundle_digest: input.sourceBundleDigest,
      target_bundle_digest: input.targetBundleDigest,
      decision: "accepted",
      consent_text_digest: input.consentTextDigest,
      issued_at: input.issuedAt,
      expires_at: input.expiresAt,
    });
    const authorizationDigest = this.#digest.sha256(digestBody);
    const authorizationToken = this.#tokenCodec.issue({
      authorizationDigest,
    });
    return this.#contracts.assertObject(CONTRACT_REF.upgradeAuthorization, {
      ...digestBody,
      authorization_token: authorizationToken,
      authorization_digest: authorizationDigest,
    });
  }

  public assertAuthentic(
    candidate: unknown,
    currentTime: string,
  ): UpgradeAuthorizationDocument {
    const authorization = this.#contracts.assertObject(
      CONTRACT_REF.upgradeAuthorization,
      candidate,
    );
    const value = authorization.value;
    if (expectString(value, "issuer", "UpgradeAuthorization") !== ISSUER) {
      throw new EngineFault(
        "content_upgrade.authorization.issuer_mismatch",
        "UpgradeAuthorization.issuer must be world_core",
      );
    }

    const claimedDigest = expectString(
      value,
      "authorization_digest",
      "UpgradeAuthorization",
    );
    const expectedDigest = this.#digest.sha256(
      authorizationDigestBody(value),
    );
    if (claimedDigest !== expectedDigest) {
      throw new EngineFault(
        "content_upgrade.authorization.digest_mismatch",
        "UpgradeAuthorization.authorization_digest does not match its authenticated fields",
        {
          upgrade_command_id: expectString(
            value,
            "upgrade_command_id",
            "UpgradeAuthorization",
          ),
        },
      );
    }
    this.#tokenCodec.assertAuthentic({
      authorizationDigest: claimedDigest,
      authorizationToken: expectString(
        value,
        "authorization_token",
        "UpgradeAuthorization",
      ),
    });
    assertAuthorizationWindow(
      expectString(value, "issued_at", "UpgradeAuthorization"),
      expectString(value, "expires_at", "UpgradeAuthorization"),
      currentTime,
    );
    return authorization;
  }
}

function authorizationDigestBody(authorization: JsonObject): JsonObject {
  const body: Record<string, JsonValue> = {};
  for (const [field, value] of Object.entries(authorization)) {
    if (
      field !== "authorization_token" &&
      field !== "authorization_digest"
    ) {
      body[field] = value;
    }
  }
  return Object.freeze(body);
}

function assertAuthorizationWindow(
  issuedAt: string,
  expiresAt: string,
  currentTime: string,
): void {
  const issued = parseTimestamp(issuedAt, "issued_at");
  const expires = parseTimestamp(expiresAt, "expires_at");
  const current = parseTimestamp(currentTime, "current_time");
  if (issued >= expires) {
    throw new EngineFault(
      "content_upgrade.authorization.window_invalid",
      "UpgradeAuthorization expires_at must be later than issued_at",
      { issued_at: issuedAt, expires_at: expiresAt },
    );
  }
  if (current < issued) {
    throw new EngineFault(
      "content_upgrade.authorization.not_yet_valid",
      "UpgradeAuthorization is not valid before issued_at",
      { issued_at: issuedAt, current_time: currentTime },
    );
  }
  if (current >= expires) {
    throw new EngineFault(
      "content_upgrade.authorization.expired",
      "UpgradeAuthorization has expired",
      { expires_at: expiresAt, current_time: currentTime },
    );
  }
}

function parseTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new EngineFault(
      "content_upgrade.authorization.timestamp_invalid",
      `Content Upgrade ${field} is not a valid timestamp`,
      { [field]: value },
    );
  }
  return parsed;
}
