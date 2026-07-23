import { EngineFault } from "./fault.js";
import type { JsonDigest } from "./digest.js";
import {
  expectJsonObject,
  expectProperty,
  expectString,
} from "./json.js";
import { CONTRACT_REF } from "./references.js";
import type { ContractValidator } from "./contract-validator.js";
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

export class ContentBundleLoader {
  readonly #contracts: ContractValidator;
  readonly #digest: JsonDigest;
  readonly #semanticGate: ContentBundleSemanticGate;

  public constructor(
    contracts: ContractValidator,
    digest: JsonDigest,
    semanticGate: ContentBundleSemanticGate,
  ) {
    this.#contracts = contracts;
    this.#digest = digest;
    this.#semanticGate = semanticGate;
  }

  public async load(candidate: unknown): Promise<LoadedContentBundle> {
    const document = this.#contracts.assertObject(
      CONTRACT_REF.contentBundle,
      candidate,
    );
    const release = expectJsonObject(
      expectProperty(document.value, "release", "ContentBundle"),
      "release",
    );
    const declaredDigest = expectString(
      release,
      "bundle_digest",
      "release",
    );
    const actualDigest = this.#digest.sha256(
      expectProperty(document.value, "bundle", "ContentBundle"),
    );

    if (actualDigest !== declaredDigest) {
      throw new EngineFault(
        "content_bundle.digest_mismatch",
        "ContentBundle bundle_digest does not match its canonical bundle value",
        {
          declared_digest: declaredDigest,
          actual_digest: actualDigest,
        },
      );
    }

    await this.#semanticGate.assertValid(document);
    return Object.freeze({
      document,
      bundleDigest: actualDigest,
    });
  }
}
