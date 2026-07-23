import { EngineFault } from "@luoxia/contracts-runtime";

/**
 * Internal exact decimal: coefficient × 10^(-scale).
 * Sole arithmetic implementation for comparer and ledger.
 * Amount strings must already have passed WorldRuntime DecimalString Schema;
 * this type does not re-declare legal formats.
 */
export class ExactDecimal {
  readonly #coefficient: bigint;
  readonly #scale: number;

  private constructor(coefficient: bigint, scale: number) {
    if (scale < 0) {
      throw new EngineFault(
        "decimal.internal_scale",
        "ExactDecimal scale must be non-negative",
        { scale },
      );
    }
    if (coefficient === 0n) {
      this.#coefficient = 0n;
      this.#scale = 0;
      return;
    }
    let c = coefficient;
    let s = scale;
    while (s > 0 && c % 10n === 0n) {
      c /= 10n;
      s -= 1;
    }
    this.#coefficient = c;
    this.#scale = s;
  }

  public static zero(): ExactDecimal {
    return new ExactDecimal(0n, 0);
  }

  /**
   * Consume a DecimalString already validated by WorldRuntime Schema.
   * Structural failure means an internal invariant was broken (unvalidated input),
   * not a second public format contract.
   */
  public static fromValidatedDecimalString(
    text: string,
    path: string = "DecimalString",
  ): ExactDecimal {
    if (typeof text !== "string" || text.length === 0) {
      throw invariant(path, text, "empty or non-string amount");
    }

    let index = 0;
    let sign = 1n;
    if (text.charCodeAt(0) === 45 /* - */) {
      sign = -1n;
      index = 1;
      if (index >= text.length) {
        throw invariant(path, text, "sign without digits");
      }
    }

    const integerStart = index;
    while (index < text.length && isDigit(text.charCodeAt(index))) {
      index += 1;
    }
    if (index === integerStart) {
      throw invariant(path, text, "missing integer digits");
    }
    const integerPart = text.slice(integerStart, index);

    let fractionPart = "";
    if (index < text.length) {
      if (text.charCodeAt(index) !== 46 /* . */) {
        throw invariant(path, text, "unexpected character");
      }
      index += 1;
      const fractionStart = index;
      while (index < text.length && isDigit(text.charCodeAt(index))) {
        index += 1;
      }
      if (index === fractionStart) {
        throw invariant(path, text, "decimal point without fractional digits");
      }
      fractionPart = text.slice(fractionStart, index);
    }

    if (index !== text.length) {
      throw invariant(path, text, "trailing characters after amount");
    }

    const digits = `${integerPart}${fractionPart}`;
    let magnitude: bigint;
    try {
      magnitude = BigInt(digits);
    } catch {
      throw invariant(path, text, "coefficient is not a BigInt digit string");
    }

    if (magnitude === 0n) {
      return ExactDecimal.zero();
    }
    return new ExactDecimal(sign * magnitude, fractionPart.length);
  }

  public add(other: ExactDecimal): ExactDecimal {
    const scale = Math.max(this.#scale, other.#scale);
    const left = this.#align(scale);
    const right = other.#align(scale);
    return new ExactDecimal(left + right, scale);
  }

  public compare(other: ExactDecimal): -1 | 0 | 1 {
    const scale = Math.max(this.#scale, other.#scale);
    const left = this.#align(scale);
    const right = other.#align(scale);
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  }

  public isZero(): boolean {
    return this.#coefficient === 0n;
  }

  /**
   * Canonical DecimalString: no leading zeros (except 0), no trailing fractional zeros, -0 → "0".
   */
  public format(): string {
    if (this.#coefficient === 0n) {
      return "0";
    }

    const negative = this.#coefficient < 0n;
    let digits = (negative ? -this.#coefficient : this.#coefficient).toString();
    const scale = this.#scale;

    if (scale === 0) {
      return negative ? `-${digits}` : digits;
    }

    if (digits.length <= scale) {
      digits = `${"0".repeat(scale - digits.length + 1)}${digits}`;
    }
    const split = digits.length - scale;
    let integerPart = digits.slice(0, split);
    let fractionPart = digits.slice(split);
    fractionPart = fractionPart.replace(/0+$/, "");
    integerPart = integerPart.replace(/^0+/, "") || "0";

    if (fractionPart.length === 0) {
      return negative ? `-${integerPart}` : integerPart;
    }
    const body = `${integerPart}.${fractionPart}`;
    return negative ? `-${body}` : body;
  }

  #align(targetScale: number): bigint {
    if (targetScale < this.#scale) {
      throw new EngineFault(
        "decimal.internal_align",
        "Cannot align ExactDecimal to a smaller scale without rounding",
        { scale: this.#scale, target_scale: targetScale },
      );
    }
    const delta = targetScale - this.#scale;
    return this.#coefficient * pow10(delta);
  }
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function invariant(
  path: string,
  value: string,
  reason: string,
): EngineFault {
  return new EngineFault(
    "decimal.internal_invariant",
    "ExactDecimal received a value that violates internal invariants; amount must already pass WorldRuntime DecimalString Schema",
    { path, value, reason },
  );
}

function pow10(exponent: number): bigint {
  if (exponent < 0) {
    throw new EngineFault(
      "decimal.internal_pow10",
      "pow10 exponent must be non-negative",
      { exponent },
    );
  }
  if (exponent === 0) {
    return 1n;
  }
  return BigInt(`1${"0".repeat(exponent)}`);
}
