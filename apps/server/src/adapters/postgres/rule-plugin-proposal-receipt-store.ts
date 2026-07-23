import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonObject,
} from "@luoxia/contracts-runtime/portable";
import type { Pool } from "pg";

import type { RulePluginProposalReceiptStore } from "../../application/runtime-persistence.js";
import {
  type PacketProposalDocument,
  type RulePluginInvocationProvenanceVerifier,
  type VerifiedRulePluginInvocationReceipt,
} from "../../application/rule-plugin-gateway.js";
import {
  assertSafeUnsignedInteger,
  assertUuid,
  parseSafeUnsignedInteger,
  requireAtMostOne,
  withPostgresClient,
  withPostgresTransaction,
} from "./persistence-support.js";

export interface PostgresRulePluginProposalReceiptStoreDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
  readonly rulePluginProvenance: RulePluginInvocationProvenanceVerifier;
}

export function createPostgresRulePluginProposalReceiptStore(
  dependencies: PostgresRulePluginProposalReceiptStoreDependencies,
): RulePluginProposalReceiptStore {
  return new PostgresRulePluginProposalReceiptStore(dependencies);
}

class PostgresRulePluginProposalReceiptStore
  implements RulePluginProposalReceiptStore
{
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;
  readonly #rulePluginProvenance: RulePluginInvocationProvenanceVerifier;

  public constructor(
    dependencies: PostgresRulePluginProposalReceiptStoreDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
    this.#rulePluginProvenance = dependencies.rulePluginProvenance;
  }

  public async persistPacketProposal(
    receipt: VerifiedRulePluginInvocationReceipt,
  ): Promise<PacketProposalDocument | undefined> {
    if (!this.#rulePluginProvenance.isVerified(receipt)) {
      throw new EngineFault(
        "rule_plugin.receipt.verified_receipt_required",
        "PacketProposal persistence requires this runtime's verified RulePlugin receipt",
      );
    }
    if (receipt.proposal === undefined) {
      return undefined;
    }

    const request = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginRequest,
      receipt.request.value,
    );
    const response = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginResponse,
      receipt.response.value,
    );
    const proposal = this.#contracts.assertObject(
      CONTRACT_REF.packetProposal,
      receipt.proposal.value,
    );
    const identity = extractReceiptIdentity(request.value, proposal.value);
    assertSafeUnsignedInteger(
      identity.basisRevision,
      "rule_plugin.receipt.revision_invalid",
      "RulePlugin receipt basis revision",
      {
        proposal_id: identity.proposalId,
        basis_revision: identity.basisRevision,
      },
    );
    if (
      receipt.worldId !== identity.worldId ||
      receipt.basisRevision !== identity.basisRevision
    ) {
      throw new EngineFault(
        "rule_plugin.receipt.identity_mismatch",
        "Verified RulePlugin receipt identity does not match its documents",
        {
          proposal_id: identity.proposalId,
          world_id: receipt.worldId,
          document_world_id: identity.worldId,
        },
      );
    }

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const inserted = await client.query<{ readonly proposal_id: string }>(
            `INSERT INTO luoxia_engine.rule_plugin_proposal_receipts (
               proposal_id,
               world_id,
               basis_revision,
               plugin_id,
               operation_id,
               request_id,
               deterministic_context_id,
               deterministic_context_digest,
               request_document,
               response_document,
               proposal_document,
               authorized_at
             ) VALUES (
               $1::uuid,
               $2::uuid,
               $3::bigint,
               $4,
               $5,
               $6::uuid,
               $7::uuid,
               $8,
               $9::jsonb,
               $10::jsonb,
               $11::jsonb,
               clock_timestamp()
             )
             ON CONFLICT DO NOTHING
             RETURNING proposal_id::text AS proposal_id`,
            [
              identity.proposalId,
              identity.worldId,
              identity.basisRevision.toString(),
              identity.pluginId,
              identity.operationId,
              identity.requestId,
              identity.deterministicContextId,
              identity.deterministicContextDigest,
              JSON.stringify(request.value),
              JSON.stringify(response.value),
              JSON.stringify(proposal.value),
            ],
          );
          if (inserted.rowCount === 1) {
            return proposal;
          }

          const existing = await client.query<ProposalReceiptRow>(
            `${PROPOSAL_RECEIPT_SELECT}
              WHERE proposal_id = $1::uuid
              FOR UPDATE`,
            [identity.proposalId],
          );
          const row = requireAtMostOne(
            existing.rows,
            "rule_plugin.receipt.database_corrupt",
            "proposal_id lookup returned more than one receipt",
            { proposal_id: identity.proposalId },
          );
          if (row === undefined) {
            throw new EngineFault(
              "rule_plugin.receipt.identity_conflict",
              "RulePlugin request_id is already bound to another proposal",
              {
                proposal_id: identity.proposalId,
                request_id: identity.requestId,
              },
            );
          }
          const stored = validateProposalReceiptRow(this.#contracts, row);
          if (
            !jsonEquals(stored.request.value, request.value) ||
            !jsonEquals(stored.response.value, response.value) ||
            !jsonEquals(stored.proposal.value, proposal.value)
          ) {
            throw new EngineFault(
              "rule_plugin.receipt.identity_conflict",
              "proposal_id is already bound to different authorization documents",
              { proposal_id: identity.proposalId },
            );
          }
          return stored.proposal;
        },
      );
    } catch (error: unknown) {
      throw normalizeProposalStoreError(error);
    }
  }

  public async findByProposalId(
    proposalId: string,
  ): Promise<unknown | undefined> {
    const verifiedProposalId = assertUuid(this.#contracts, proposalId);
    try {
      return await withPostgresClient(this.#pool, async (client) => {
        const query = await client.query<ProposalReceiptRow>(
          `${PROPOSAL_RECEIPT_SELECT}
            WHERE proposal_id = $1::uuid`,
          [verifiedProposalId],
        );
        const row = requireAtMostOne(
          query.rows,
          "rule_plugin.receipt.database_corrupt",
          "proposal_id lookup returned more than one receipt",
          { proposal_id: verifiedProposalId },
        );
        if (row === undefined) {
          return undefined;
        }
        return validateProposalReceiptRow(this.#contracts, row).proposal.value;
      });
    } catch (error: unknown) {
      throw normalizeProposalStoreError(error);
    }
  }
}

const PROPOSAL_RECEIPT_SELECT = `SELECT
  proposal_id::text AS proposal_id,
  world_id::text AS world_id,
  basis_revision::text AS basis_revision_text,
  plugin_id,
  operation_id,
  request_id::text AS request_id,
  deterministic_context_id::text AS deterministic_context_id,
  deterministic_context_digest,
  request_document,
  response_document,
  proposal_document
FROM luoxia_engine.rule_plugin_proposal_receipts`;

interface ProposalReceiptRow {
  readonly proposal_id: string;
  readonly world_id: string;
  readonly basis_revision_text: string;
  readonly plugin_id: string;
  readonly operation_id: string;
  readonly request_id: string;
  readonly deterministic_context_id: string;
  readonly deterministic_context_digest: string;
  readonly request_document: unknown;
  readonly response_document: unknown;
  readonly proposal_document: unknown;
}

interface ProposalReceiptIdentity {
  readonly proposalId: string;
  readonly worldId: string;
  readonly basisRevision: number;
  readonly pluginId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly deterministicContextId: string;
  readonly deterministicContextDigest: string;
}

function validateProposalReceiptRow(
  contracts: ContractValidator,
  row: ProposalReceiptRow,
): {
  readonly request: ReturnType<
    ContractValidator["assertObject"]
  >;
  readonly response: ReturnType<
    ContractValidator["assertObject"]
  >;
  readonly proposal: PacketProposalDocument;
} {
  const request = contracts.assertObject(
    CONTRACT_REF.rulePluginRequest,
    row.request_document,
  );
  const response = contracts.assertObject(
    CONTRACT_REF.rulePluginResponse,
    row.response_document,
  );
  const proposal = contracts.assertObject(
    CONTRACT_REF.packetProposal,
    row.proposal_document,
  );
  const identity = extractReceiptIdentity(request.value, proposal.value);
  const responseOutput = expectJsonObject(
    expectProperty(response.value, "output", "RulePluginResponse"),
    "RulePluginResponse.output",
  );
  const responseProposal = expectProperty(
    responseOutput,
    "proposal",
    "RulePluginResponse.output",
  );
  const rowBasisRevision = parseSafeUnsignedInteger(
    row.basis_revision_text,
    "rule_plugin.receipt.database_corrupt",
    "RulePlugin receipt basis_revision",
    { proposal_id: row.proposal_id, revision: row.basis_revision_text },
  );

  if (
    expectString(
      responseOutput,
      "output_kind",
      "RulePluginResponse.output",
    ) !== "packet.proposal" ||
    row.proposal_id !== identity.proposalId ||
    row.world_id !== identity.worldId ||
    rowBasisRevision !== identity.basisRevision ||
    row.plugin_id !== identity.pluginId ||
    row.operation_id !== identity.operationId ||
    row.request_id !== identity.requestId ||
    row.deterministic_context_id !== identity.deterministicContextId ||
    row.deterministic_context_digest !==
      identity.deterministicContextDigest ||
    !jsonEquals(responseProposal, proposal.value)
  ) {
    throw new EngineFault(
      "rule_plugin.receipt.database_corrupt",
      "RulePlugin proposal receipt columns and documents do not match",
      { proposal_id: row.proposal_id },
    );
  }
  return Object.freeze({ request, response, proposal });
}

function extractReceiptIdentity(
  request: JsonObject,
  proposal: JsonObject,
): ProposalReceiptIdentity {
  const world = expectJsonObject(
    expectProperty(request, "readonly_world", "RulePluginRequest"),
    "RulePluginRequest.readonly_world",
  );
  const pluginLock = expectJsonObject(
    expectProperty(request, "plugin_lock", "RulePluginRequest"),
    "RulePluginRequest.plugin_lock",
  );
  const deterministicContext = expectJsonObject(
    expectProperty(
      request,
      "deterministic_context",
      "RulePluginRequest",
    ),
    "RulePluginRequest.deterministic_context",
  );
  const proposedBy = expectJsonObject(
    expectProperty(proposal, "proposed_by", "PacketProposal"),
    "PacketProposal.proposed_by",
  );
  const identity = Object.freeze({
    proposalId: expectString(proposal, "proposal_id", "PacketProposal"),
    worldId: expectString(world, "world_id", "WorldSnapshot"),
    basisRevision: expectInteger(
      request,
      "basis_revision",
      "RulePluginRequest",
    ),
    pluginId: expectString(pluginLock, "plugin_id", "PluginLock"),
    operationId: expectString(
      request,
      "operation_id",
      "RulePluginRequest",
    ),
    requestId: expectString(request, "request_id", "RulePluginRequest"),
    deterministicContextId: expectString(
      deterministicContext,
      "context_id",
      "DeterministicContext",
    ),
    deterministicContextDigest: expectString(
      deterministicContext,
      "context_digest",
      "DeterministicContext",
    ),
  });

  if (
    expectInteger(world, "world_revision", "WorldSnapshot") !==
      identity.basisRevision ||
    expectInteger(proposal, "basis_revision", "PacketProposal") !==
      identity.basisRevision ||
    expectString(proposedBy, "plugin_id", "PacketProposal.proposed_by") !==
      identity.pluginId ||
    expectString(
      proposedBy,
      "operation_id",
      "PacketProposal.proposed_by",
    ) !== identity.operationId ||
    expectString(proposedBy, "request_id", "PacketProposal.proposed_by") !==
      identity.requestId ||
    expectString(
      proposal,
      "deterministic_context_id",
      "PacketProposal",
    ) !== identity.deterministicContextId ||
    expectString(
      proposal,
      "deterministic_context_digest",
      "PacketProposal",
    ) !== identity.deterministicContextDigest
  ) {
    throw new EngineFault(
      "rule_plugin.receipt.identity_mismatch",
      "RulePlugin request and PacketProposal authorization identity differ",
      { proposal_id: identity.proposalId },
    );
  }
  return identity;
}

interface PostgresErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

function normalizeProposalStoreError(error: unknown): Error {
  if (error instanceof EngineFault) {
    return error;
  }
  if (!isPostgresError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const constraint =
    typeof error.constraint === "string" ? error.constraint : "";
  if (
    constraint === "rule_plugin_proposal_receipts_pkey" ||
    constraint === "rule_plugin_proposal_receipts_request_id_unique"
  ) {
    return new EngineFault(
      "rule_plugin.receipt.identity_conflict",
      "PostgreSQL rejected a conflicting RulePlugin proposal receipt",
      { postgres_code: error.code, constraint },
    );
  }
  if (
    constraint === "rule_plugin_proposal_receipts_world_foreign_key"
  ) {
    return new EngineFault(
      "rule_plugin.receipt.world_missing",
      "RulePlugin proposal receipt references a missing world",
      { postgres_code: error.code, constraint },
    );
  }
  return new EngineFault(
    "rule_plugin.receipt.database_error",
    "PostgreSQL rejected the RulePlugin proposal receipt operation",
    {
      postgres_code: error.code,
      constraint,
      postgres_message:
        typeof error.message === "string" ? error.message : "",
    },
  );
}

function isPostgresError(
  error: unknown,
): error is PostgresErrorLike & { readonly code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as PostgresErrorLike).code === "string"
  );
}
