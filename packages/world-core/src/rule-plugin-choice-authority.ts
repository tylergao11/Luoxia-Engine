import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ChoiceSpecDocument,
  type ContractValidator,
  type JsonObject,
  type JsonValue,
  type RulePluginChoiceResolutionDocument,
} from "@luoxia/contracts-runtime/portable";

import type {
  DeterministicContextAuthority,
  DeterministicContextDigest,
  DeterministicContextDocument,
} from "./deterministic-context-authority.js";

export interface RulePluginChoiceResolutionIssueInput {
  readonly worldId: string;
  readonly parentRequestId: string;
  readonly continuationRequestId: string;
  readonly parentContext: unknown;
  readonly choiceSpec: unknown;
  readonly entropyReveal: string;
}

export interface RulePluginChoiceResolutionVerificationInput {
  readonly worldId: string;
  readonly parentRequestId: string;
  readonly continuationRequestId: string;
  readonly parentContext: unknown;
  readonly choiceSpec: unknown;
  readonly candidate: unknown;
}

export interface RulePluginChoiceAuthority {
  resolve(
    input: RulePluginChoiceResolutionIssueInput,
  ): RulePluginChoiceResolutionDocument;
  assertAuthentic(
    input: RulePluginChoiceResolutionVerificationInput,
  ): RulePluginChoiceResolutionDocument;
}

export interface RulePluginChoiceAuthorityDependencies {
  readonly contracts: ContractValidator;
  readonly digest: DeterministicContextDigest;
  readonly deterministicContexts: DeterministicContextAuthority;
}

interface WeightedOption {
  readonly optionId: string;
  readonly weight: bigint;
}

interface ChoiceFacts {
  readonly choiceId: string;
  readonly choiceSpecDigest: string;
  readonly optionId: string;
  readonly entropyCommitment: string;
}

const MAX_REJECTION_ATTEMPTS = 256;
const SHA256_SPACE = 1n << 256n;
const SELECTION_DOMAIN = "luoxia.rule_plugin.weighted_choice.v1";
const COMMITMENT_DOMAIN = "luoxia.rule_plugin.choice_entropy.v1";

export function createRulePluginChoiceAuthority(
  dependencies: RulePluginChoiceAuthorityDependencies,
): RulePluginChoiceAuthority {
  return new DefaultRulePluginChoiceAuthority(dependencies);
}

class DefaultRulePluginChoiceAuthority
  implements RulePluginChoiceAuthority
{
  readonly #contracts: ContractValidator;
  readonly #digest: DeterministicContextDigest;
  readonly #deterministicContexts: DeterministicContextAuthority;

  public constructor(
    dependencies: RulePluginChoiceAuthorityDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#digest = dependencies.digest;
    this.#deterministicContexts = dependencies.deterministicContexts;
  }

  public resolve(
    input: RulePluginChoiceResolutionIssueInput,
  ): RulePluginChoiceResolutionDocument {
    const parentContext = this.#deterministicContexts.assertAuthentic(
      input.parentContext,
      input.worldId,
    );
    const choiceSpec = this.#contracts.assertObject(
      CONTRACT_REF.choiceSpec,
      input.choiceSpec,
    );
    const facts = this.#deriveChoiceFacts({
      parentRequestId: input.parentRequestId,
      continuationRequestId: input.continuationRequestId,
      parentContext,
      choiceSpec,
      entropyReveal: input.entropyReveal,
    });
    const randomChoices = readRandomChoices(parentContext);
    const nextContext = this.#deterministicContexts.issue({
      worldId: input.worldId,
      logicalTime: expectProperty(
        parentContext.value,
        "logical_time",
        "DeterministicContext",
      ),
      randomChoices: Object.freeze([
        ...randomChoices,
        createRandomChoice(facts),
      ]),
      externalResults: expectProperty(
        parentContext.value,
        "external_results",
        "DeterministicContext",
      ),
    });
    const candidate = Object.freeze({
      contract_version: "rule-plugin.v1",
      record_type: "rule_plugin.choice_resolution",
      algorithm: "sha256_rejection_v1",
      parent_request_id: input.parentRequestId,
      continuation_request_id: input.continuationRequestId,
      choice_spec_digest: facts.choiceSpecDigest,
      choice_id: facts.choiceId,
      option_id: facts.optionId,
      entropy_reveal: input.entropyReveal,
      entropy_commitment: facts.entropyCommitment,
      deterministic_context: nextContext.value,
    });
    return this.assertAuthentic({
      worldId: input.worldId,
      parentRequestId: input.parentRequestId,
      continuationRequestId: input.continuationRequestId,
      parentContext: parentContext.value,
      choiceSpec: choiceSpec.value,
      candidate,
    });
  }

  public assertAuthentic(
    input: RulePluginChoiceResolutionVerificationInput,
  ): RulePluginChoiceResolutionDocument {
    const parentContext = this.#deterministicContexts.assertAuthentic(
      input.parentContext,
      input.worldId,
    );
    const choiceSpec = this.#contracts.assertObject(
      CONTRACT_REF.choiceSpec,
      input.choiceSpec,
    );
    const evidence = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginChoiceResolution,
      input.candidate,
    );
    const value = evidence.value;
    const parentRequestId = expectString(
      value,
      "parent_request_id",
      "ChoiceResolutionEvidence",
    );
    const continuationRequestId = expectString(
      value,
      "continuation_request_id",
      "ChoiceResolutionEvidence",
    );
    if (
      parentRequestId !== input.parentRequestId ||
      continuationRequestId !== input.continuationRequestId ||
      parentRequestId === continuationRequestId
    ) {
      throw new EngineFault(
        "rule_plugin.choice.request_identity_mismatch",
        "Choice resolution evidence does not bind the expected parent and continuation requests",
        {
          expected_parent_request_id: input.parentRequestId,
          actual_parent_request_id: parentRequestId,
          expected_continuation_request_id: input.continuationRequestId,
          actual_continuation_request_id: continuationRequestId,
        },
      );
    }

    const entropyReveal = expectString(
      value,
      "entropy_reveal",
      "ChoiceResolutionEvidence",
    );
    const facts = this.#deriveChoiceFacts({
      parentRequestId,
      continuationRequestId,
      parentContext,
      choiceSpec,
      entropyReveal,
    });
    if (
      expectString(
        value,
        "choice_spec_digest",
        "ChoiceResolutionEvidence",
      ) !== facts.choiceSpecDigest ||
      expectString(value, "choice_id", "ChoiceResolutionEvidence") !==
        facts.choiceId ||
      expectString(value, "option_id", "ChoiceResolutionEvidence") !==
        facts.optionId ||
      expectString(
        value,
        "entropy_commitment",
        "ChoiceResolutionEvidence",
      ) !== facts.entropyCommitment
    ) {
      throw new EngineFault(
        "rule_plugin.choice.evidence_mismatch",
        "Choice resolution evidence does not match the authoritative weighted selection",
        {
          parent_request_id: parentRequestId,
          continuation_request_id: continuationRequestId,
          choice_id: facts.choiceId,
        },
      );
    }

    const nextContext = this.#deterministicContexts.assertAuthentic(
      expectProperty(
        value,
        "deterministic_context",
        "ChoiceResolutionEvidence",
      ),
      input.worldId,
    );
    assertContinuationContext(parentContext, nextContext, facts);
    return evidence;
  }

  #deriveChoiceFacts(input: {
    readonly parentRequestId: string;
    readonly continuationRequestId: string;
    readonly parentContext: DeterministicContextDocument;
    readonly choiceSpec: ChoiceSpecDocument;
    readonly entropyReveal: string;
  }): ChoiceFacts {
    if (!/^[0-9a-f]{64}$/.test(input.entropyReveal)) {
      throw new EngineFault(
        "rule_plugin.choice.entropy_invalid",
        "RulePlugin choice entropy must be exactly 256 bits encoded as lowercase hexadecimal",
        { parent_request_id: input.parentRequestId },
      );
    }
    const choiceId = expectString(
      input.choiceSpec.value,
      "choice_id",
      "ChoiceSpec",
    );
    const randomChoices = readRandomChoices(input.parentContext);
    if (
      randomChoices.some(
        (entry) =>
          expectString(
            entry,
            "choice_id",
            "DeterministicContext.random_choices[]",
          ) === choiceId,
      )
    ) {
      throw new EngineFault(
        "rule_plugin.choice.identity_reused",
        "A RulePlugin continuation cannot resolve the same choice_id twice",
        {
          parent_request_id: input.parentRequestId,
          choice_id: choiceId,
        },
      );
    }

    const choiceSpecDigest = this.#digest.sha256(
      input.choiceSpec.value,
    );
    const options = readWeightedOptions(input.choiceSpec);
    const optionId = selectOption({
      digest: this.#digest,
      parentRequestId: input.parentRequestId,
      continuationRequestId: input.continuationRequestId,
      choiceSpecDigest,
      entropyReveal: input.entropyReveal,
      options,
    });
    const entropyCommitment = this.#digest.sha256(
      Object.freeze({
        version: 1,
        domain: COMMITMENT_DOMAIN,
        parent_request_id: input.parentRequestId,
        continuation_request_id: input.continuationRequestId,
        choice_spec_digest: choiceSpecDigest,
        choice_id: choiceId,
        option_id: optionId,
        entropy_reveal: input.entropyReveal,
      }),
    );
    return Object.freeze({
      choiceId,
      choiceSpecDigest,
      optionId,
      entropyCommitment,
    });
  }
}

function readWeightedOptions(
  choiceSpec: ChoiceSpecDocument,
): readonly WeightedOption[] {
  const values = expectProperty(
    choiceSpec.value,
    "options",
    "ChoiceSpec",
  );
  if (!Array.isArray(values)) {
    throw new EngineFault(
      "rule_plugin.choice.options_invalid",
      "ChoiceSpec.options must be an array",
    );
  }
  const optionIds = new Set<string>();
  return Object.freeze(
    values.map((value, index) => {
      const option = expectJsonObject(
        value as JsonValue,
        `ChoiceSpec.options[${index}]`,
      );
      const optionId = expectString(
        option,
        "option_id",
        `ChoiceSpec.options[${index}]`,
      );
      if (optionIds.has(optionId)) {
        throw new EngineFault(
          "rule_plugin.choice.option_identity_duplicate",
          "ChoiceSpec option_id values must be unique",
          { choice_id: expectString(choiceSpec.value, "choice_id", "ChoiceSpec"), option_id: optionId },
        );
      }
      optionIds.add(optionId);
      return Object.freeze({
        optionId,
        weight: BigInt(
          expectInteger(
            option,
            "weight",
            `ChoiceSpec.options[${index}]`,
          ),
        ),
      });
    }),
  );
}

function selectOption(input: {
  readonly digest: DeterministicContextDigest;
  readonly parentRequestId: string;
  readonly continuationRequestId: string;
  readonly choiceSpecDigest: string;
  readonly entropyReveal: string;
  readonly options: readonly WeightedOption[];
}): string {
  const totalWeight = input.options.reduce(
    (total, option) => total + option.weight,
    0n,
  );
  if (totalWeight <= 0n) {
    throw new EngineFault(
      "rule_plugin.choice.weight_invalid",
      "ChoiceSpec total weight must be positive",
      { parent_request_id: input.parentRequestId },
    );
  }
  const rejectionLimit =
    SHA256_SPACE - (SHA256_SPACE % totalWeight);
  for (let counter = 0; counter < MAX_REJECTION_ATTEMPTS; counter += 1) {
    const sampleDigest = input.digest.sha256(
      Object.freeze({
        version: 1,
        domain: SELECTION_DOMAIN,
        parent_request_id: input.parentRequestId,
        continuation_request_id: input.continuationRequestId,
        choice_spec_digest: input.choiceSpecDigest,
        entropy_reveal: input.entropyReveal,
        counter,
      }),
    );
    const sample = BigInt(`0x${sampleDigest}`);
    if (sample >= rejectionLimit) {
      continue;
    }
    const target = sample % totalWeight;
    let cursor = 0n;
    for (const option of input.options) {
      cursor += option.weight;
      if (target < cursor) {
        return option.optionId;
      }
    }
  }
  throw new EngineFault(
    "rule_plugin.choice.rejection_limit_exceeded",
    "RulePlugin choice sampling did not obtain an unbiased SHA-256 sample within the fixed limit",
    {
      parent_request_id: input.parentRequestId,
      maximum_attempts: MAX_REJECTION_ATTEMPTS,
    },
  );
}

function readRandomChoices(
  context: DeterministicContextDocument,
): readonly JsonObject[] {
  const value = expectProperty(
    context.value,
    "random_choices",
    "DeterministicContext",
  );
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "rule_plugin.choice.context_invalid",
      "DeterministicContext.random_choices must be an array",
    );
  }
  return Object.freeze(
    value.map((entry, index) =>
      expectJsonObject(
        entry as JsonValue,
        `DeterministicContext.random_choices[${index}]`,
      ),
    ),
  );
}

function createRandomChoice(facts: ChoiceFacts): JsonObject {
  return Object.freeze({
    choice_id: facts.choiceId,
    option_id: facts.optionId,
    entropy_commitment: facts.entropyCommitment,
  });
}

function assertContinuationContext(
  parent: DeterministicContextDocument,
  continuation: DeterministicContextDocument,
  facts: ChoiceFacts,
): void {
  const expectedChoices = Object.freeze([
    ...readRandomChoices(parent),
    createRandomChoice(facts),
  ]);
  if (
    !jsonEquals(
      expectProperty(
        continuation.value,
        "logical_time",
        "DeterministicContext",
      ),
      expectProperty(parent.value, "logical_time", "DeterministicContext"),
    ) ||
    !jsonEquals(
      expectProperty(
        continuation.value,
        "external_results",
        "DeterministicContext",
      ),
      expectProperty(
        parent.value,
        "external_results",
        "DeterministicContext",
      ),
    ) ||
    !jsonEquals(
      expectProperty(
        continuation.value,
        "random_choices",
        "DeterministicContext",
      ),
      expectedChoices,
    )
  ) {
    throw new EngineFault(
      "rule_plugin.choice.context_mismatch",
      "Choice continuation context must preserve time and external results and append exactly one authoritative choice",
      {
        choice_id: facts.choiceId,
        option_id: facts.optionId,
      },
    );
  }
}
