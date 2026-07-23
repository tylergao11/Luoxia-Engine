import {
  CONTRACT_REF,
  EngineFault,
  type ContractValidator,
  type JsonObject,
} from "@luoxia/contracts-runtime/portable";
import type { Pool, PoolClient } from "pg";

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export async function withPostgresClient<TResult>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

export async function withPostgresTransaction<TResult>(
  pool: Pool,
  beginStatement: string,
  operation: (client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
  const client = await pool.connect();
  let began = false;
  let committed = false;
  let destroyClient = false;

  try {
    await client.query(beginStatement);
    began = true;
    const result = await operation(client);
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (error: unknown) {
    const original =
      error instanceof Error ? error : new Error(String(error));
    if (began && !committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        destroyClient = true;
      }
    }
    throw original;
  } finally {
    if (destroyClient) {
      client.release(new Error("runtime.persistence.rollback_failed"));
    } else {
      client.release();
    }
  }
}

export function assertUuid(
  contracts: ContractValidator,
  value: string,
): string {
  return contracts.assert(CONTRACT_REF.uuid, value).value as string;
}

export function assertSafeUnsignedInteger(
  value: number,
  code: string,
  label: string,
  details: JsonObject,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EngineFault(code, `${label} must be a safe unsigned integer`, details);
  }
}

export function parseSafeUnsignedInteger(
  value: string,
  code: string,
  label: string,
  details: JsonObject,
): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new EngineFault(code, `${label} is not an unsigned integer`, details);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SAFE_INTEGER) {
    throw new EngineFault(
      code,
      `${label} exceeds the JavaScript safe integer range`,
      details,
    );
  }
  return Number(parsed);
}

export function requireAtMostOne<TRow>(
  rows: readonly TRow[],
  code: string,
  message: string,
  details: JsonObject,
): TRow | undefined {
  if (rows.length > 1) {
    throw new EngineFault(code, message, details);
  }
  return rows[0];
}

export function requireExactlyOne<TRow>(
  rows: readonly TRow[],
  code: string,
  message: string,
  details: JsonObject,
): TRow {
  if (rows.length !== 1) {
    throw new EngineFault(code, message, {
      ...details,
      row_count: rows.length,
    });
  }
  return rows[0] as TRow;
}
