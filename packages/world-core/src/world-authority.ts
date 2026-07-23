import type {
  CONTRACT_REF,
  ValidatedJsonObject,
} from "@luoxia/contracts-runtime/portable";

export type ApplyPacketResultDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.applyPacketResult
>;

export interface WorldAuthority {
  applyPacket(candidate: unknown): Promise<ApplyPacketResultDocument>;
}
