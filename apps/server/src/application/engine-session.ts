export interface EngineSessionRecord {
  readonly sessionId: string;
  readonly worldId: string;
  readonly controlBindingId: string;
  readonly playerEntityId: string;
  readonly viewRevision: number;
  readonly worldRevision: number;
  readonly nonce: string;
}

export interface EngineSessionHandle {
  readonly session: EngineSessionRecord;
  readonly basisToken: string;
}

export interface EngineSessionBasisTokenAuthority {
  issue(session: EngineSessionRecord): string;
  assertAuthentic(session: EngineSessionRecord, candidate: string): void;
}

export interface EngineSessionIdFactory {
  createSessionId(): string;
  createNonce(): string;
}

export interface EngineSessionRepository {
  create(input: {
    readonly worldId: string;
    readonly controlBindingId: string;
  }): Promise<EngineSessionRecord>;
  readCurrent(sessionId: string): Promise<EngineSessionRecord>;
  advanceView(input: {
    readonly sessionId: string;
    readonly expectedViewRevision: number;
  }): Promise<EngineSessionRecord>;
}

export interface EngineSessionService {
  open(input: {
    readonly worldId: string;
    readonly controlBindingId: string;
  }): Promise<EngineSessionHandle>;
  readCurrent(sessionId: string): Promise<EngineSessionHandle>;
  advanceView(input: {
    readonly sessionId: string;
    readonly expectedViewRevision: number;
  }): Promise<EngineSessionHandle>;
}

export interface EngineSessionServiceDependencies {
  readonly repository: EngineSessionRepository;
  readonly basisTokens: EngineSessionBasisTokenAuthority;
}

export function createEngineSessionService(
  dependencies: EngineSessionServiceDependencies,
): EngineSessionService {
  const withToken = (session: EngineSessionRecord): EngineSessionHandle =>
    Object.freeze({
      session,
      basisToken: dependencies.basisTokens.issue(session),
    });

  return Object.freeze({
    async open(input: {
      readonly worldId: string;
      readonly controlBindingId: string;
    }): Promise<EngineSessionHandle> {
      return withToken(await dependencies.repository.create(input));
    },
    async readCurrent(sessionId: string): Promise<EngineSessionHandle> {
      return withToken(
        await dependencies.repository.readCurrent(sessionId),
      );
    },
    async advanceView(input: {
      readonly sessionId: string;
      readonly expectedViewRevision: number;
    }): Promise<EngineSessionHandle> {
      return withToken(await dependencies.repository.advanceView(input));
    },
  });
}
