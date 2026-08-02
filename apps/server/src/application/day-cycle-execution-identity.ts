export type DayCycleExecutionKind =
  | "transition.autonomous_to_director"
  | "transition.director_to_player"
  | "transition.player_to_autonomous"
  | "dialogue.close"
  | "state_machine.advance"
  | "character.react"
  | "automatic_event.resolve";

export interface DayCycleExecutionIdentityFactory {
  createId(): string;
}

/**
 * Owns only stable random execution identities. Progress remains derived from
 * Model/RulePlugin journals and committed packets; no workflow status is copied.
 */
export interface DayCycleExecutionIdentityJournal {
  reserve(input: {
    readonly worldId: string;
    readonly day: number;
    readonly executionKind: DayCycleExecutionKind;
    readonly subjectId?: string;
  }): Promise<string>;
}
