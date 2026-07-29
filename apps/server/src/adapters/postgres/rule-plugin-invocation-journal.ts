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
  type RulePluginChoiceResolutionDocument,
} from "@luoxia/contracts-runtime/portable";
import type { JsonDigest } from "@luoxia/contracts-runtime";
import type { Pool } from "pg";

import type {
  PacketProposalDocument,
  RulePluginInvocationProvenanceVerifier,
  RulePluginPreparationProvenanceVerifier,
  RulePluginRequestDocument,
  RulePluginResponseDocument,
  VerifiedRulePluginInvocationReceipt,
} from "../../application/rule-plugin-gateway.js";
import type {
  RulePluginInvocationJournal,
  StoredResolvedRulePluginInvocation,
  StoredRulePluginInvocation,
} from "../../application/runtime-persistence.js";
import {
  assertSafeUnsignedInteger,
  assertUuid,
  parseSafeUnsignedInteger,
  requireAtMostOne,
  requireExactlyOne,
  withPostgresClient,
  withPostgresTransaction,
} from "./persistence-support.js";

export interface PostgresRulePluginInvocationJournalDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly preparationProvenance: RulePluginPreparationProvenanceVerifier;
  readonly invocationProvenance: RulePluginInvocationProvenanceVerifier;
}

export function createPostgresRulePluginInvocationJournal(
  dependencies: PostgresRulePluginInvocationJournalDependencies,
): RulePluginInvocationJournal {
  return new PostgresRulePluginInvocationJournal(dependencies);
}

class PostgresRulePluginInvocationJournal
  implements RulePluginInvocationJournal
{
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;
  readonly #digest: JsonDigest;
  readonly #preparationProvenance: RulePluginPreparationProvenanceVerifier;
  readonly #invocationProvenance: RulePluginInvocationProvenanceVerifier;

  public constructor(
    dependencies: PostgresRulePluginInvocationJournalDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
    this.#digest = dependencies.digest;
    this.#preparationProvenance = dependencies.preparationProvenance;
    this.#invocationProvenance = dependencies.invocationProvenance;
  }

  public async persistPrepared(
    invocation: Parameters<RulePluginInvocationJournal["persistPrepared"]>[0],
  ): Promise<StoredRulePluginInvocation> {
    if (!this.#preparationProvenance.isPrepared(invocation)) {
      throw new EngineFault(
        "rule_plugin.journal.prepared_invocation_required",
        "RulePlugin Journal accepts only this Gateway's prepared invocation",
      );
    }
    const request = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginRequest,
      invocation.request.value,
    );
    const identity = extractRequestIdentity(request.value);
    assertPreparedIdentity(invocation, identity);
    const requestDigest = this.#digest.sha256(request.value);

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          await client.query(
            `INSERT INTO luoxia_engine.rule_plugin_invocations (
               request_id,
               world_id,
               basis_revision,
               plugin_id,
               operation_id,
               operation_kind,
               deterministic_context_id,
               deterministic_context_digest,
               request_digest,
               invocation_status,
               request_document,
               prepared_at
             ) VALUES (
               $1::uuid,
               $2::uuid,
               $3::bigint,
               $4,
               $5,
               $6,
               $7::uuid,
               $8,
               $9,
               'prepared',
               $10::jsonb,
               clock_timestamp()
             )
             ON CONFLICT (request_id) DO NOTHING`,
            [
              identity.requestId,
              identity.worldId,
              identity.basisRevision.toString(),
              identity.pluginId,
              identity.operationId,
              identity.operationKind,
              identity.deterministicContextId,
              identity.deterministicContextDigest,
              requestDigest,
              JSON.stringify(request.value),
            ],
          );

          const query = await client.query<RulePluginInvocationRow>(
            `${INVOCATION_SELECT}
              WHERE request_id = $1::uuid
              FOR UPDATE`,
            [identity.requestId],
          );
          const row = requireExactlyOne(
            query.rows,
            "rule_plugin.journal.database_corrupt",
            "Prepared RulePlugin request lookup did not return exactly one row",
            { request_id: identity.requestId },
          );
          const stored = validateInvocationRow(
            this.#contracts,
            this.#digest,
            row,
          );
          if (
            row.request_digest !== requestDigest ||
            !jsonEquals(stored.request.value, request.value) ||
            stored.continuation !== undefined
          ) {
            throw new EngineFault(
              "rule_plugin.journal.request_id_conflict",
              "RulePlugin request_id is already bound to a different request",
              { request_id: identity.requestId },
            );
          }
          return stored;
        },
      );
    } catch (error: unknown) {
      throw normalizeJournalError(error);
    }
  }

  public async persistChoiceContinuation(
    input: Parameters<
      RulePluginInvocationJournal["persistChoiceContinuation"]
    >[0],
  ): Promise<StoredRulePluginInvocation> {
    if (!this.#invocationProvenance.isVerified(input.parent)) {
      throw new EngineFault(
        "rule_plugin.journal.verified_parent_required",
        "RulePlugin choice continuation requires this Gateway's verified parent receipt",
      );
    }
    if (!this.#preparationProvenance.isPrepared(input.invocation)) {
      throw new EngineFault(
        "rule_plugin.journal.prepared_invocation_required",
        "RulePlugin choice continuation requires this Gateway's prepared invocation",
      );
    }

    const parentRequest = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginRequest,
      input.parent.request.value,
    );
    const parentResponse = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginResponse,
      input.parent.response.value,
    );
    const request = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginRequest,
      input.invocation.request.value,
    );
    const resolution = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginChoiceResolution,
      input.resolution.value,
    );
    const parentIdentity = extractRequestIdentity(parentRequest.value);
    const identity = extractRequestIdentity(request.value);
    assertReceiptIdentity(input.parent, parentIdentity);
    assertPreparedIdentity(input.invocation, identity);
    assertResponseDocuments(
      parentRequest,
      parentResponse,
      input.parent.proposal,
    );
    assertChoiceContinuationDocuments({
      contracts: this.#contracts,
      digest: this.#digest,
      parentRequest,
      parentResponse,
      request,
      resolution,
    });
    const requestDigest = this.#digest.sha256(request.value);

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const parentQuery = await client.query<RulePluginInvocationRow>(
            `${INVOCATION_SELECT}
              WHERE request_id = $1::uuid
              FOR UPDATE`,
            [parentIdentity.requestId],
          );
          const parentRow = requireAtMostOne(
            parentQuery.rows,
            "rule_plugin.journal.database_corrupt",
            "Choice parent request lookup returned more than one row",
            { request_id: parentIdentity.requestId },
          );
          if (parentRow === undefined) {
            throw new EngineFault(
              "rule_plugin.journal.choice_parent_missing",
              "RulePlugin choice continuation cannot be prepared before its parent response is durable",
              { parent_request_id: parentIdentity.requestId },
            );
          }
          const storedParent = validateInvocationRow(
            this.#contracts,
            this.#digest,
            parentRow,
          );
          if (
            storedParent.phase !== "resolved" ||
            !jsonEquals(
              storedParent.request.value,
              parentRequest.value,
            ) ||
            !jsonEquals(
              storedParent.response.value,
              parentResponse.value,
            ) ||
            !sameOptionalProposal(
              storedParent.proposal,
              input.parent.proposal,
            )
          ) {
            throw new EngineFault(
              "rule_plugin.journal.choice_parent_conflict",
              "RulePlugin choice parent receipt differs from its durable resolved row",
              { parent_request_id: parentIdentity.requestId },
            );
          }

          await client.query(
            `INSERT INTO luoxia_engine.rule_plugin_invocations (
               request_id,
               parent_request_id,
               world_id,
               basis_revision,
               plugin_id,
               operation_id,
               operation_kind,
               deterministic_context_id,
               deterministic_context_digest,
               request_digest,
               invocation_status,
               request_document,
               choice_resolution_document,
               prepared_at
             ) VALUES (
               $1::uuid,
               $2::uuid,
               $3::uuid,
               $4::bigint,
               $5,
               $6,
               $7,
               $8::uuid,
               $9,
               $10,
               'prepared',
               $11::jsonb,
               $12::jsonb,
               clock_timestamp()
             )
             ON CONFLICT (parent_request_id) DO NOTHING`,
            [
              identity.requestId,
              parentIdentity.requestId,
              identity.worldId,
              identity.basisRevision.toString(),
              identity.pluginId,
              identity.operationId,
              identity.operationKind,
              identity.deterministicContextId,
              identity.deterministicContextDigest,
              requestDigest,
              JSON.stringify(request.value),
              JSON.stringify(resolution.value),
            ],
          );

          const query = await client.query<RulePluginInvocationRow>(
            `${INVOCATION_SELECT}
              WHERE parent_request_id = $1::uuid
              FOR UPDATE`,
            [parentIdentity.requestId],
          );
          const row = requireExactlyOne(
            query.rows,
            "rule_plugin.journal.database_corrupt",
            "Choice parent did not resolve to exactly one continuation row",
            { parent_request_id: parentIdentity.requestId },
          );
          const stored = validateInvocationRow(
            this.#contracts,
            this.#digest,
            row,
          );
          if (
            stored.continuation === undefined ||
            stored.continuation.parentRequestId !==
              parentIdentity.requestId
          ) {
            throw new EngineFault(
              "rule_plugin.journal.database_corrupt",
              "Choice continuation row lost its parent identity",
              { parent_request_id: parentIdentity.requestId },
            );
          }
          assertChoiceContinuationDocuments({
            contracts: this.#contracts,
            digest: this.#digest,
            parentRequest: storedParent.request,
            parentResponse: storedParent.response,
            request: stored.request,
            resolution: stored.continuation.resolution,
          });
          return stored;
        },
      );
    } catch (error: unknown) {
      throw normalizeJournalError(error);
    }
  }

  public async recordResolved(
    receipt: VerifiedRulePluginInvocationReceipt,
  ): Promise<StoredResolvedRulePluginInvocation> {
    if (!this.#invocationProvenance.isVerified(receipt)) {
      throw new EngineFault(
        "rule_plugin.journal.verified_receipt_required",
        "RulePlugin Journal accepts only this Gateway's verified receipt",
      );
    }
    const request = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginRequest,
      receipt.request.value,
    );
    const response = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginResponse,
      receipt.response.value,
    );
    const proposal =
      receipt.proposal === undefined
        ? undefined
        : this.#contracts.assertObject(
            CONTRACT_REF.packetProposal,
            receipt.proposal.value,
          );
    const identity = extractRequestIdentity(request.value);
    assertReceiptIdentity(receipt, identity);
    assertResponseDocuments(request, response, proposal);
    const requestDigest = this.#digest.sha256(request.value);

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const query = await client.query<RulePluginInvocationRow>(
            `${INVOCATION_SELECT}
              WHERE request_id = $1::uuid
              FOR UPDATE`,
            [identity.requestId],
          );
          const row = requireAtMostOne(
            query.rows,
            "rule_plugin.journal.database_corrupt",
            "RulePlugin request_id lookup returned more than one row",
            { request_id: identity.requestId },
          );
          if (row === undefined) {
            throw new EngineFault(
              "rule_plugin.journal.prepared_missing",
              "RulePlugin response cannot be recorded before its request is durably prepared",
              { request_id: identity.requestId },
            );
          }
          const stored = validateInvocationRow(
            this.#contracts,
            this.#digest,
            row,
          );
          if (
            row.request_digest !== requestDigest ||
            !jsonEquals(stored.request.value, request.value)
          ) {
            throw new EngineFault(
              "rule_plugin.journal.request_id_conflict",
              "RulePlugin request_id is bound to a different prepared request",
              { request_id: identity.requestId },
            );
          }
          if (stored.phase === "resolved") {
            if (
              !jsonEquals(stored.response.value, response.value) ||
              !sameOptionalProposal(stored.proposal, proposal)
            ) {
              throw new EngineFault(
                "rule_plugin.journal.nondeterministic_response",
                "Replayed deterministic RulePlugin request produced a different response",
                { request_id: identity.requestId },
              );
            }
            return stored;
          }

          const update = await client.query(
            `UPDATE luoxia_engine.rule_plugin_invocations
                SET invocation_status = 'resolved',
                    response_document = $2::jsonb,
                    proposal_id = $3::uuid,
                    proposal_document = $4::jsonb,
                    resolved_at = clock_timestamp()
              WHERE request_id = $1::uuid
                AND invocation_status = 'prepared'`,
            [
              identity.requestId,
              JSON.stringify(response.value),
              proposal === undefined
                ? null
                : expectString(
                    proposal.value,
                    "proposal_id",
                    "PacketProposal",
                  ),
              proposal === undefined
                ? null
                : JSON.stringify(proposal.value),
            ],
          );
          if (update.rowCount !== 1) {
            throw new EngineFault(
              "rule_plugin.journal.stage_conflict",
              "Prepared RulePlugin invocation changed before response recording",
              { request_id: identity.requestId },
            );
          }

          const updated = await client.query<RulePluginInvocationRow>(
            `${INVOCATION_SELECT}
              WHERE request_id = $1::uuid`,
            [identity.requestId],
          );
          const updatedRow = requireExactlyOne(
            updated.rows,
            "rule_plugin.journal.database_corrupt",
            "Resolved RulePlugin request lookup did not return exactly one row",
            { request_id: identity.requestId },
          );
          const resolved = validateInvocationRow(
            this.#contracts,
            this.#digest,
            updatedRow,
          );
          if (resolved.phase !== "resolved") {
            throw new EngineFault(
              "rule_plugin.journal.database_corrupt",
              "Resolved RulePlugin invocation remained in a non-resolved phase",
              { request_id: identity.requestId },
            );
          }
          return resolved;
        },
      );
    } catch (error: unknown) {
      throw normalizeJournalError(error);
    }
  }

  public async readByRequestId(
    requestId: string,
  ): Promise<StoredRulePluginInvocation | undefined> {
    const verifiedRequestId = assertUuid(this.#contracts, requestId);
    try {
      return await withPostgresClient(this.#pool, async (client) => {
        const query = await client.query<RulePluginInvocationRow>(
          `${INVOCATION_SELECT}
            WHERE request_id = $1::uuid`,
          [verifiedRequestId],
        );
        const row = requireAtMostOne(
          query.rows,
          "rule_plugin.journal.database_corrupt",
          "RulePlugin request_id lookup returned more than one row",
          { request_id: verifiedRequestId },
        );
        return row === undefined
          ? undefined
          : validateInvocationRow(this.#contracts, this.#digest, row);
      });
    } catch (error: unknown) {
      throw normalizeJournalError(error);
    }
  }

  public async readChoiceContinuation(
    parentRequestId: string,
  ): Promise<StoredRulePluginInvocation | undefined> {
    const verifiedParentRequestId = assertUuid(
      this.#contracts,
      parentRequestId,
    );
    try {
      return await withPostgresClient(this.#pool, async (client) => {
        const query = await client.query<RulePluginInvocationRow>(
          `${INVOCATION_SELECT}
            WHERE parent_request_id = $1::uuid`,
          [verifiedParentRequestId],
        );
        const row = requireAtMostOne(
          query.rows,
          "rule_plugin.journal.database_corrupt",
          "Choice parent request resolved to more than one continuation",
          { parent_request_id: verifiedParentRequestId },
        );
        return row === undefined
          ? undefined
          : validateInvocationRow(this.#contracts, this.#digest, row);
      });
    } catch (error: unknown) {
      throw normalizeJournalError(error);
    }
  }

  public async findByProposalId(
    proposalId: string,
  ): Promise<unknown | undefined> {
    const verifiedProposalId = assertUuid(this.#contracts, proposalId);
    try {
      return await withPostgresClient(this.#pool, async (client) => {
        const query = await client.query<RulePluginInvocationRow>(
          `${INVOCATION_SELECT}
            WHERE proposal_id = $1::uuid`,
          [verifiedProposalId],
        );
        const row = requireAtMostOne(
          query.rows,
          "rule_plugin.journal.database_corrupt",
          "RulePlugin proposal_id lookup returned more than one row",
          { proposal_id: verifiedProposalId },
        );
        if (row === undefined) {
          return undefined;
        }
        const stored = validateInvocationRow(
          this.#contracts,
          this.#digest,
          row,
        );
        if (
          stored.phase !== "resolved" ||
          stored.proposal === undefined ||
          expectString(
            stored.proposal.value,
            "proposal_id",
            "PacketProposal",
          ) !== verifiedProposalId
        ) {
          throw new EngineFault(
            "rule_plugin.journal.database_corrupt",
            "proposal_id row does not contain its resolved PacketProposal",
            { proposal_id: verifiedProposalId },
          );
        }
        return stored.proposal.value;
      });
    } catch (error: unknown) {
      throw normalizeJournalError(error);
    }
  }
}

const INVOCATION_SELECT = `SELECT
  request_id::text AS request_id,
  parent_request_id::text AS parent_request_id,
  world_id::text AS world_id,
  basis_revision::text AS basis_revision_text,
  plugin_id,
  operation_id,
  operation_kind,
  deterministic_context_id::text AS deterministic_context_id,
  deterministic_context_digest,
  request_digest,
  invocation_status,
  request_document,
  choice_resolution_document,
  response_document,
  proposal_id::text AS proposal_id,
  proposal_document
FROM luoxia_engine.rule_plugin_invocations`;

interface RulePluginInvocationRow {
  readonly request_id: string;
  readonly parent_request_id: string | null;
  readonly world_id: string;
  readonly basis_revision_text: string;
  readonly plugin_id: string;
  readonly operation_id: string;
  readonly operation_kind: string;
  readonly deterministic_context_id: string;
  readonly deterministic_context_digest: string;
  readonly request_digest: string;
  readonly invocation_status: string;
  readonly request_document: unknown;
  readonly choice_resolution_document: unknown | null;
  readonly response_document: unknown | null;
  readonly proposal_id: string | null;
  readonly proposal_document: unknown | null;
}

interface RulePluginRequestIdentity {
  readonly requestId: string;
  readonly worldId: string;
  readonly basisRevision: number;
  readonly pluginId: string;
  readonly operationId: string;
  readonly operationKind: string;
  readonly deterministicContextId: string;
  readonly deterministicContextDigest: string;
}

function validateInvocationRow(
  contracts: ContractValidator,
  digest: JsonDigest,
  row: RulePluginInvocationRow,
): StoredRulePluginInvocation {
  const request = contracts.assertObject(
    CONTRACT_REF.rulePluginRequest,
    row.request_document,
  );
  const identity = extractRequestIdentity(request.value);
  const rowRevision = parseSafeUnsignedInteger(
    row.basis_revision_text,
    "rule_plugin.journal.database_corrupt",
    "RulePlugin invocation basis_revision",
    { request_id: row.request_id, revision: row.basis_revision_text },
  );
  if (
    row.request_id !== identity.requestId ||
    row.world_id !== identity.worldId ||
    rowRevision !== identity.basisRevision ||
    row.plugin_id !== identity.pluginId ||
    row.operation_id !== identity.operationId ||
    row.operation_kind !== identity.operationKind ||
    row.deterministic_context_id !== identity.deterministicContextId ||
    row.deterministic_context_digest !==
      identity.deterministicContextDigest ||
    row.request_digest !== digest.sha256(request.value)
  ) {
    throw new EngineFault(
      "rule_plugin.journal.database_corrupt",
      "RulePlugin invocation columns do not match its request document",
      { request_id: row.request_id },
    );
  }

  const continuation = validateChoiceContinuationRow(
    contracts,
    row,
    request,
  );
  if (row.invocation_status === "prepared") {
    if (
      row.response_document !== null ||
      row.proposal_id !== null ||
      row.proposal_document !== null
    ) {
      throw new EngineFault(
        "rule_plugin.journal.database_corrupt",
        "Prepared RulePlugin invocation contains resolved documents",
        { request_id: row.request_id },
      );
    }
    return Object.freeze({ phase: "prepared", request, continuation });
  }
  if (row.invocation_status !== "resolved" || row.response_document === null) {
    throw new EngineFault(
      "rule_plugin.journal.database_corrupt",
      "RulePlugin invocation has an unknown or incomplete status",
      { request_id: row.request_id, invocation_status: row.invocation_status },
    );
  }

  const response = contracts.assertObject(
    CONTRACT_REF.rulePluginResponse,
    row.response_document,
  );
  const output = expectJsonObject(
    expectProperty(response.value, "output", "RulePluginResponse"),
    "RulePluginResponse.output",
  );
  const outputKind = expectString(
    output,
    "output_kind",
    "RulePluginResponse.output",
  );
  let proposal: PacketProposalDocument | undefined;
  if (outputKind === "packet.proposal") {
    if (row.proposal_id === null || row.proposal_document === null) {
      throw new EngineFault(
        "rule_plugin.journal.database_corrupt",
        "Resolved packet.proposal response is missing proposal columns",
        { request_id: row.request_id },
      );
    }
    proposal = contracts.assertObject(
      CONTRACT_REF.packetProposal,
      row.proposal_document,
    );
    if (
      expectString(proposal.value, "proposal_id", "PacketProposal") !==
        row.proposal_id ||
      !jsonEquals(
        expectProperty(output, "proposal", "RulePluginResponse.output"),
        proposal.value,
      )
    ) {
      throw new EngineFault(
        "rule_plugin.journal.database_corrupt",
        "Resolved PacketProposal columns do not match RulePluginResponse",
        { request_id: row.request_id },
      );
    }
  } else if (row.proposal_id !== null || row.proposal_document !== null) {
    throw new EngineFault(
      "rule_plugin.journal.database_corrupt",
      "Non-proposal RulePlugin response contains proposal columns",
      { request_id: row.request_id, output_kind: outputKind },
    );
  }
  assertResponseDocuments(request, response, proposal);
  return Object.freeze({
    phase: "resolved",
    request,
    response,
    proposal,
    continuation,
  });
}

function validateChoiceContinuationRow(
  contracts: ContractValidator,
  row: RulePluginInvocationRow,
  request: RulePluginRequestDocument,
):
  | {
      readonly parentRequestId: string;
      readonly resolution: RulePluginChoiceResolutionDocument;
    }
  | undefined {
  if (
    row.parent_request_id === null &&
    row.choice_resolution_document === null
  ) {
    return undefined;
  }
  if (
    row.parent_request_id === null ||
    row.choice_resolution_document === null
  ) {
    throw new EngineFault(
      "rule_plugin.journal.database_corrupt",
      "RulePlugin choice lineage columns must occur together",
      { request_id: row.request_id },
    );
  }
  const resolution = contracts.assertObject(
    CONTRACT_REF.rulePluginChoiceResolution,
    row.choice_resolution_document,
  );
  const context = expectJsonObject(
    expectProperty(
      request.value,
      "deterministic_context",
      "RulePluginRequest",
    ),
    "RulePluginRequest.deterministic_context",
  );
  const resolutionContext = expectJsonObject(
    expectProperty(
      resolution.value,
      "deterministic_context",
      "ChoiceResolutionEvidence",
    ),
    "ChoiceResolutionEvidence.deterministic_context",
  );
  if (
    row.parent_request_id === row.request_id ||
    expectString(
      resolution.value,
      "parent_request_id",
      "ChoiceResolutionEvidence",
    ) !== row.parent_request_id ||
    expectString(
      resolution.value,
      "continuation_request_id",
      "ChoiceResolutionEvidence",
    ) !== row.request_id ||
    !jsonEquals(context, resolutionContext)
  ) {
    throw new EngineFault(
      "rule_plugin.journal.database_corrupt",
      "RulePlugin choice lineage does not match its continuation request",
      {
        request_id: row.request_id,
        parent_request_id: row.parent_request_id,
      },
    );
  }
  return Object.freeze({
    parentRequestId: row.parent_request_id,
    resolution,
  });
}

function extractRequestIdentity(
  request: JsonObject,
): RulePluginRequestIdentity {
  const readonlyWorld = expectJsonObject(
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
  const basisRevision = expectInteger(
    request,
    "basis_revision",
    "RulePluginRequest",
  );
  assertSafeUnsignedInteger(
    basisRevision,
    "rule_plugin.journal.revision_invalid",
    "RulePlugin request basis_revision",
    { request_id: expectString(request, "request_id", "RulePluginRequest") },
  );
  if (
    expectInteger(
      readonlyWorld,
      "world_revision",
      "WorldSnapshot",
    ) !== basisRevision
  ) {
    throw new EngineFault(
      "rule_plugin.journal.request_identity_mismatch",
      "RulePlugin request basis_revision differs from readonly_world",
      { request_id: expectString(request, "request_id", "RulePluginRequest") },
    );
  }
  return Object.freeze({
    requestId: expectString(request, "request_id", "RulePluginRequest"),
    worldId: expectString(readonlyWorld, "world_id", "WorldSnapshot"),
    basisRevision,
    pluginId: expectString(pluginLock, "plugin_id", "PluginLock"),
    operationId: expectString(
      request,
      "operation_id",
      "RulePluginRequest",
    ),
    operationKind: expectString(
      request,
      "operation_kind",
      "RulePluginRequest",
    ),
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
}

function assertPreparedIdentity(
  invocation: Parameters<RulePluginInvocationJournal["persistPrepared"]>[0],
  identity: RulePluginRequestIdentity,
): void {
  if (
    invocation.worldId !== identity.worldId ||
    invocation.basisRevision !== identity.basisRevision
  ) {
    throw new EngineFault(
      "rule_plugin.journal.prepared_identity_mismatch",
      "Prepared RulePlugin invocation identity differs from its request",
      { request_id: identity.requestId },
    );
  }
}

function assertReceiptIdentity(
  receipt: VerifiedRulePluginInvocationReceipt,
  identity: RulePluginRequestIdentity,
): void {
  if (
    receipt.worldId !== identity.worldId ||
    receipt.basisRevision !== identity.basisRevision
  ) {
    throw new EngineFault(
      "rule_plugin.journal.receipt_identity_mismatch",
      "Verified RulePlugin receipt identity differs from its request",
      { request_id: identity.requestId },
    );
  }
}

function assertResponseDocuments(
  request: RulePluginRequestDocument,
  response: RulePluginResponseDocument,
  proposal: PacketProposalDocument | undefined,
): void {
  const context = expectJsonObject(
    expectProperty(
      request.value,
      "deterministic_context",
      "RulePluginRequest",
    ),
    "RulePluginRequest.deterministic_context",
  );
  const responseOutput = expectJsonObject(
    expectProperty(response.value, "output", "RulePluginResponse"),
    "RulePluginResponse.output",
  );
  const correlations: readonly (readonly [string, string | number, string | number])[] = [
    [
      "request_id",
      expectString(request.value, "request_id", "RulePluginRequest"),
      expectString(response.value, "request_id", "RulePluginResponse"),
    ],
    [
      "operation_id",
      expectString(request.value, "operation_id", "RulePluginRequest"),
      expectString(response.value, "operation_id", "RulePluginResponse"),
    ],
    [
      "operation_kind",
      expectString(request.value, "operation_kind", "RulePluginRequest"),
      expectString(response.value, "operation_kind", "RulePluginResponse"),
    ],
    [
      "basis_revision",
      expectInteger(request.value, "basis_revision", "RulePluginRequest"),
      expectInteger(response.value, "basis_revision", "RulePluginResponse"),
    ],
    [
      "deterministic_context_id",
      expectString(context, "context_id", "DeterministicContext"),
      expectString(
        response.value,
        "deterministic_context_id",
        "RulePluginResponse",
      ),
    ],
    [
      "deterministic_context_digest",
      expectString(context, "context_digest", "DeterministicContext"),
      expectString(
        response.value,
        "deterministic_context_digest",
        "RulePluginResponse",
      ),
    ],
  ];
  for (const [field, expected, actual] of correlations) {
    if (expected !== actual) {
      throw new EngineFault(
        "rule_plugin.journal.response_identity_mismatch",
        `Stored RulePluginResponse ${field} differs from its request`,
        { field, expected, actual },
      );
    }
  }
  if (
    !jsonEquals(
      expectProperty(request.value, "plugin_lock", "RulePluginRequest"),
      expectProperty(response.value, "plugin_lock", "RulePluginResponse"),
    )
  ) {
    throw new EngineFault(
      "rule_plugin.journal.response_identity_mismatch",
      "Stored RulePluginResponse plugin_lock differs from its request",
    );
  }

  const outputKind = expectString(
    responseOutput,
    "output_kind",
    "RulePluginResponse.output",
  );
  if (outputKind === "packet.proposal") {
    if (
      proposal === undefined ||
      !jsonEquals(
        expectProperty(
          responseOutput,
          "proposal",
          "RulePluginResponse.output",
        ),
        proposal.value,
      )
    ) {
      throw new EngineFault(
        "rule_plugin.journal.proposal_mismatch",
        "Stored packet.proposal response and proposal document differ",
      );
    }
  } else if (proposal !== undefined) {
    throw new EngineFault(
      "rule_plugin.journal.proposal_mismatch",
      "Stored non-proposal RulePlugin response has a proposal document",
      { output_kind: outputKind },
    );
  }
}

function assertChoiceContinuationDocuments(input: {
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly parentRequest: RulePluginRequestDocument;
  readonly parentResponse: RulePluginResponseDocument;
  readonly request: RulePluginRequestDocument;
  readonly resolution: RulePluginChoiceResolutionDocument;
}): void {
  const parentOutput = expectJsonObject(
    expectProperty(
      input.parentResponse.value,
      "output",
      "RulePluginResponse",
    ),
    "RulePluginResponse.output",
  );
  if (
    expectString(
      parentOutput,
      "output_kind",
      "RulePluginResponse.output",
    ) !== "choice.required"
  ) {
    throw new EngineFault(
      "rule_plugin.journal.choice_parent_not_required",
      "RulePlugin continuation parent must resolve to ChoiceSpec",
      {
        parent_request_id: expectString(
          input.parentRequest.value,
          "request_id",
          "RulePluginRequest",
        ),
      },
    );
  }
  const choiceSpec = input.contracts.assertObject(
    CONTRACT_REF.choiceSpec,
    parentOutput,
  );
  const parentRequestId = expectString(
    input.parentRequest.value,
    "request_id",
    "RulePluginRequest",
  );
  const requestId = expectString(
    input.request.value,
    "request_id",
    "RulePluginRequest",
  );
  const resolutionContext = expectProperty(
    input.resolution.value,
    "deterministic_context",
    "ChoiceResolutionEvidence",
  );
  const expectedRequest = Object.freeze({
    ...input.parentRequest.value,
    request_id: requestId,
    deterministic_context: resolutionContext,
  });
  if (
    expectString(
      input.resolution.value,
      "parent_request_id",
      "ChoiceResolutionEvidence",
    ) !== parentRequestId ||
    expectString(
      input.resolution.value,
      "continuation_request_id",
      "ChoiceResolutionEvidence",
    ) !== requestId ||
    expectString(
      input.resolution.value,
      "choice_spec_digest",
      "ChoiceResolutionEvidence",
    ) !== input.digest.sha256(choiceSpec.value) ||
    expectString(
      input.resolution.value,
      "choice_id",
      "ChoiceResolutionEvidence",
    ) !== expectString(choiceSpec.value, "choice_id", "ChoiceSpec") ||
    !jsonEquals(input.request.value, expectedRequest)
  ) {
    throw new EngineFault(
      "rule_plugin.journal.choice_continuation_mismatch",
      "RulePlugin continuation request does not exactly preserve its parent request and choice evidence",
      {
        parent_request_id: parentRequestId,
        continuation_request_id: requestId,
      },
    );
  }
}

function sameOptionalProposal(
  left: PacketProposalDocument | undefined,
  right: PacketProposalDocument | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return jsonEquals(left.value, right.value);
}

interface PostgresErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

function normalizeJournalError(error: unknown): Error {
  if (error instanceof EngineFault) {
    return error;
  }
  if (!isPostgresError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const constraint =
    typeof error.constraint === "string" ? error.constraint : "";
  if (
    constraint === "rule_plugin_invocations_pkey" ||
    constraint ===
      "rule_plugin_invocations_parent_request_unique" ||
    constraint === "rule_plugin_invocations_proposal_id_unique"
  ) {
    return new EngineFault(
      "rule_plugin.journal.identity_conflict",
      "PostgreSQL rejected a conflicting RulePlugin invocation identity",
      { postgres_code: error.code, constraint },
    );
  }
  return new EngineFault(
    "rule_plugin.journal.database_error",
    "PostgreSQL rejected the RulePlugin Journal operation",
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
