import {
  CONTRACT_REF,
  type ContractValidator,
  type JsonObject,
} from "@luoxia/contracts-runtime";
import type {
  SessionViewDocument,
  SessionViewProjector,
  WorldContentLockDocument,
} from "@luoxia/world-core";

import type {
  EngineSessionBasisTokenAuthority,
  EngineSessionRecord,
} from "./engine-session.js";
import type { SessionRenderNodeProjector } from "./session-render-node-projector.js";

export interface SessionViewAssemblyInput {
  readonly session: EngineSessionRecord;
  readonly worldState: JsonObject;
  readonly worldContentLock: WorldContentLockDocument;
  readonly noticeCandidates: readonly unknown[];
}

export interface SessionViewAssembler {
  assemble(input: SessionViewAssemblyInput): SessionViewDocument;
}

export interface SessionViewAssemblerDependencies {
  readonly contracts: ContractValidator;
  readonly basisTokens: EngineSessionBasisTokenAuthority;
  readonly renderNodes: SessionRenderNodeProjector;
  readonly projector: SessionViewProjector;
}

/**
 * Sole Server path for combining a persisted Engine Session with its exact
 * WorldState, basis token, and presentation candidates before World Core
 * performs the authoritative SessionView projection.
 */
export function createSessionViewAssembler(
  dependencies: SessionViewAssemblerDependencies,
): SessionViewAssembler {
  return Object.freeze({
    assemble(input: SessionViewAssemblyInput): SessionViewDocument {
      const snapshot = dependencies.contracts.assertObject(
        CONTRACT_REF.worldSnapshot,
        {
          world_id: input.session.worldId,
          world_revision: input.session.worldRevision,
          world_state: input.worldState,
          world_content_lock: input.worldContentLock.value,
        },
      );
      const renderProjection = dependencies.renderNodes.project({
        worldContentLock: input.worldContentLock,
        worldId: input.session.worldId,
        playerEntityId: input.session.playerEntityId,
        worldState: input.worldState,
      });

      return dependencies.projector.project({
        snapshot,
        sessionId: input.session.sessionId,
        viewRevision: input.session.viewRevision,
        basisToken: dependencies.basisTokens.issue(input.session),
        controlBindingId: input.session.controlBindingId,
        playerLocationEntityId: renderProjection.playerLocationEntityId,
        renderNodeCandidates: renderProjection.renderNodes,
        loreCandidates: renderProjection.lore,
        noticeCandidates: input.noticeCandidates,
      });
    },
  });
}
