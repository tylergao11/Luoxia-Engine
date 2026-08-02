import type { StoredReceivedCommand } from "./command-journal.js";

export interface PlayerDayEndRun {
  readonly sessionId: string;
  readonly commandId: string;
  readonly worldId: string;
  readonly fromDay: number;
}

/**
 * Persists the source day while the accepted Command Journal world revision is
 * still current. It owns command identity only; workflow progress remains in
 * the existing journals and committed packets.
 *
 * Active DialogueRecord closes that must precede `player → autonomous` reuse
 * `DayCycleExecutionIdentityJournal` with `execution_kind: "dialogue.close"`
 * and `subject_id = dialogue_id` — the same reservation discipline as
 * `day_cycle.advance` transitions — not additional columns on this run row.
 */
export interface PlayerDayEndRunJournal {
  prepare(command: StoredReceivedCommand): Promise<PlayerDayEndRun>;
}
