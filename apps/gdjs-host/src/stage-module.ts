import {
  CONTRACT_REF,
  type StageModuleManifestDocument,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime/portable";

export type { StageModuleManifestDocument } from "@luoxia/contracts-runtime/portable";

export type StageOpenDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.stageOpen
>;

export type StageUpdateDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.stageUpdate
>;

export type StageCloseDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.stageClose
>;

export interface StageModuleRuntime {
  readonly manifest: StageModuleManifestDocument;
  open(message: StageOpenDocument): Promise<void>;
  update(message: StageUpdateDocument): Promise<void>;
  close(message: StageCloseDocument): Promise<void>;
}
