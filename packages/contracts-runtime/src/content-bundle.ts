import { CONTRACT_REF } from "./references.js";
import type { ValidatedJsonObject } from "./validated-json.js";

export type ContentBundleDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.contentBundle
>;

export interface LoadedContentBundle {
  readonly document: ContentBundleDocument;
  readonly bundleDigest: string;
}

export interface ContentBundleSemanticGate {
  assertValid(bundle: ContentBundleDocument): Promise<void>;
}
