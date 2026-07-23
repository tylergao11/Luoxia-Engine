import {
  EngineFault,
  expectProperty,
  expectString,
  jsonEquals,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type {
  DecimalAmountComparer,
  LedgerPostArithmetic,
} from "@luoxia/world-core/composition";

import { ExactDecimal } from "./exact-decimal.js";

/**
 * Production DecimalAmountComparer — ExactDecimal only, no second parser.
 */
export function createDecimalAmountComparer(): DecimalAmountComparer {
  return Object.freeze({
    isAtLeast(balance: string, minimum: string): boolean {
      const left = ExactDecimal.fromValidatedDecimalString(
        balance,
        "LedgerBalance.amount",
      );
      const right = ExactDecimal.fromValidatedDecimalString(
        minimum,
        "minimum_amount",
      );
      return left.compare(right) >= 0;
    },
  });
}

/**
 * Production balanced ledger.post arithmetic — zero-sum ExactDecimal, no mint bypass.
 */
export function createLedgerPostArithmetic(): LedgerPostArithmetic {
  return Object.freeze({
    applyPost(input: {
      readonly ledgerId: string;
      readonly unitDefinition: JsonValue;
      readonly balances: readonly JsonObject[];
      readonly entries: readonly JsonObject[];
    }): readonly JsonObject[] {
      void input.unitDefinition;

      assertUniqueBalanceAccounts(input.balances, input.ledgerId);

      const merged = mergeEntries(input.entries);
      assertZeroSum(merged, input.ledgerId);

      const appliedKeys = new Set<string>();
      const next: JsonObject[] = [];

      for (const [index, balance] of input.balances.entries()) {
        const account = expectProperty(
          balance,
          "account",
          "LedgerBalance",
        ) as JsonValue;
        const currentAmount = ExactDecimal.fromValidatedDecimalString(
          expectString(balance, "amount", "LedgerBalance"),
          "LedgerBalance.amount",
        );
        const match = findMergedByAccount(merged, account);
        const delta = match?.delta ?? ExactDecimal.zero();
        if (match !== undefined) {
          appliedKeys.add(match.key);
        }
        next.push(
          Object.freeze({
            account: cloneJson(account),
            amount: currentAmount.add(delta).format(),
          }),
        );
        void index;
      }

      for (const key of merged.firstAppearanceOrder) {
        if (appliedKeys.has(key)) {
          continue;
        }
        const account = merged.accounts.get(key);
        const delta = merged.deltas.get(key);
        if (account === undefined || delta === undefined) {
          throw new EngineFault(
            "ledger.post_internal",
            "Merged ledger entry missing account or amount",
            { ledger_id: input.ledgerId, account_key: key },
          );
        }
        next.push(
          Object.freeze({
            account: cloneJson(account),
            amount: ExactDecimal.zero().add(delta).format(),
          }),
        );
      }

      return Object.freeze(next);
    },
  });
}

interface MergedEntries {
  readonly deltas: ReadonlyMap<string, ExactDecimal>;
  readonly accounts: ReadonlyMap<string, JsonValue>;
  readonly firstAppearanceOrder: readonly string[];
}

interface MergedMatch {
  readonly key: string;
  readonly delta: ExactDecimal;
}

function mergeEntries(entries: readonly JsonObject[]): MergedEntries {
  const deltas = new Map<string, ExactDecimal>();
  const accounts = new Map<string, JsonValue>();
  const firstAppearanceOrder: string[] = [];
  const identityList: { readonly key: string; readonly account: JsonValue }[] =
    [];

  for (const [index, entry] of entries.entries()) {
    const account = expectProperty(
      entry,
      "account",
      "LedgerPostOp.entries",
    ) as JsonValue;
    const amount = ExactDecimal.fromValidatedDecimalString(
      expectString(entry, "amount", "LedgerPostOp.entries"),
      `LedgerPostOp.entries[${index}].amount`,
    );

    let key: string | undefined;
    for (const known of identityList) {
      if (jsonEquals(known.account, account)) {
        key = known.key;
        break;
      }
    }
    if (key === undefined) {
      key = `e${String(identityList.length)}`;
      identityList.push({ key, account });
      accounts.set(key, account);
      firstAppearanceOrder.push(key);
      deltas.set(key, amount);
    } else {
      const prior = deltas.get(key) ?? ExactDecimal.zero();
      deltas.set(key, prior.add(amount));
    }
  }

  return Object.freeze({
    deltas,
    accounts,
    firstAppearanceOrder: Object.freeze(firstAppearanceOrder),
  });
}

function findMergedByAccount(
  merged: MergedEntries,
  account: JsonValue,
): MergedMatch | undefined {
  for (const key of merged.firstAppearanceOrder) {
    const known = merged.accounts.get(key);
    if (known !== undefined && jsonEquals(known, account)) {
      return Object.freeze({
        key,
        delta: merged.deltas.get(key) ?? ExactDecimal.zero(),
      });
    }
  }
  return undefined;
}

function assertUniqueBalanceAccounts(
  balances: readonly JsonObject[],
  ledgerId: string,
): void {
  const seen: JsonValue[] = [];
  for (const [index, balance] of balances.entries()) {
    const account = expectProperty(
      balance,
      "account",
      "LedgerBalance",
    ) as JsonValue;
    for (const prior of seen) {
      if (jsonEquals(prior, account)) {
        throw new EngineFault(
          "ledger.balance_account_duplicate",
          "LedgerState.balances contains a duplicate account",
          {
            ledger_id: ledgerId,
            balance_index: index,
          },
        );
      }
    }
    seen.push(account);
  }
}

function assertZeroSum(merged: MergedEntries, ledgerId: string): void {
  let total = ExactDecimal.zero();
  for (const amount of merged.deltas.values()) {
    total = total.add(amount);
  }
  if (!total.isZero()) {
    throw new EngineFault(
      "ledger.post_not_balanced",
      "ledger.post entries must sum to exactly zero",
      {
        ledger_id: ledgerId,
        residual: total.format(),
      },
    );
  }
}

function cloneJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item as JsonValue));
  }
  const object = value as JsonObject;
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(object)) {
    result[key] = cloneJson(entry as JsonValue);
  }
  return result;
}
