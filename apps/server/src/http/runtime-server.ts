import { createServer, type IncomingMessage, type Server } from "node:http";

import {
  EngineFault,
  type ContractValidator,
  type JsonValue,
} from "@luoxia/contracts-runtime";

import type { ClientCommandRouter } from "../application/client-command-router.js";

const MAX_CLIENT_ENVELOPE_BYTES = 1024 * 1024;

export interface RuntimeHttpServerOptions {
  readonly host: string;
  readonly port: number;
  readonly contracts: ContractValidator;
  readonly clientCommands: ClientCommandRouter;
}

/**
 * Headless Client Bridge transport. Request body is exactly one
 * ClientEnvelope; successful response is an ordered JSON array of already
 * validated ServerEnvelopes. World/session provisioning remains an external
 * gateway responsibility.
 */
export async function startRuntimeHttpServer(
  options: RuntimeHttpServerOptions,
): Promise<Server> {
  const server = createServer((request, response) => {
    void handleRequest(options, request, response).catch(
      (error: unknown) => {
        writeFailure(response, error);
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function handleRequest(
  options: RuntimeHttpServerOptions,
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> {
  if (request.method === "GET" && request.url === "/api/health") {
    writeJson(response, 200, {
      status: "ok",
      contracts_loaded: options.contracts.schemaIds.length,
      headless_runtime: "configured",
    });
    return;
  }
  if (
    request.method === "POST" &&
    request.url === "/api/client-envelope"
  ) {
    const contentType = request.headers["content-type"];
    if (
      typeof contentType !== "string" ||
      !/^\s*application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/iu.test(
        contentType,
      )
    ) {
      throw new EngineFault(
        "server.http.content_type_invalid",
        "POST /api/client-envelope requires application/json",
      );
    }
    const candidate = await readJsonBody(request);
    const envelopes = await options.clientCommands.execute(candidate);
    writeJson(
      response,
      200,
      envelopes.map((envelope) => envelope.value),
    );
    return;
  }
  writeJson(response, 404, { status: "not_found" });
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const candidate of request) {
    const chunk = Buffer.isBuffer(candidate)
      ? candidate
      : Buffer.from(candidate as Uint8Array);
    byteLength += chunk.byteLength;
    if (byteLength > MAX_CLIENT_ENVELOPE_BYTES) {
      throw new EngineFault(
        "server.http.body_too_large",
        "ClientEnvelope body exceeds the Server safety limit",
        { maximum_bytes: MAX_CLIENT_ENVELOPE_BYTES },
      );
    }
    chunks.push(chunk);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, byteLength),
    );
  } catch (error: unknown) {
    throw new EngineFault(
      "server.http.body_encoding_invalid",
      "ClientEnvelope body must be valid UTF-8",
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  try {
    return JSON.parse(source) as JsonValue;
  } catch (error: unknown) {
    throw new EngineFault(
      "server.http.body_not_json",
      "ClientEnvelope body must be valid UTF-8 JSON",
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function writeFailure(
  response: import("node:http").ServerResponse,
  error: unknown,
): void {
  if (response.headersSent) {
    response.destroy(
      error instanceof Error ? error : new Error(String(error)),
    );
    return;
  }
  if (error instanceof EngineFault) {
    writeText(
      response,
      statusForEngineFault(error),
      formatEngineFaultText(error),
    );
    return;
  }
  writeText(
    response,
    500,
    "server.internal: Server failed before producing a verified response",
  );
}

function formatEngineFaultText(error: EngineFault): string {
  const base = `${error.code}: ${error.message}`;
  if (error.details === undefined || typeof error.details !== "object" || error.details === null) {
    return base;
  }
  const details = error.details as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof details.failure_code === "string") {
    parts.push(details.failure_code);
  }
  const nested = details.failure_details;
  if (nested !== undefined && typeof nested === "object" && nested !== null) {
    parts.push(...summarizeFaultDetailFields(nested as Record<string, unknown>));
  }
  parts.push(...summarizeFaultDetailFields(details));
  return parts.length === 0 ? base : `${base} [${parts.join("; ")}]`;
}

function summarizeFaultDetailFields(
  details: Record<string, unknown>,
): readonly string[] {
  const parts: string[] = [];
  const outputValidation = details.output_validation;
  if (
    outputValidation !== undefined &&
    typeof outputValidation === "object" &&
    outputValidation !== null
  ) {
    parts.push("output");
    parts.push(
      ...summarizeContractDetails(outputValidation as Record<string, unknown>),
    );
  }
  const responseValidation = details.response_validation;
  if (
    responseValidation !== undefined &&
    typeof responseValidation === "object" &&
    responseValidation !== null
  ) {
    parts.push("response");
    parts.push(
      ...summarizeContractDetails(
        responseValidation as Record<string, unknown>,
      ),
    );
  }
  if (typeof details.output_kind === "string") {
    parts.push(`output_kind=${details.output_kind}`);
  }
  if (typeof details.request_kind === "string") {
    parts.push(`request_kind=${details.request_kind}`);
  }
  if (typeof details.response_request_kind === "string") {
    parts.push(`response_request_kind=${details.response_request_kind}`);
  }
  if (details.output_validated === true) {
    parts.push("output_validated=true");
  }
  parts.push(...summarizeContractDetails(details));
  return parts;
}

function summarizeContractDetails(
  details: Record<string, unknown>,
): readonly string[] {
  const parts: string[] = [];
  if (typeof details.schema_ref === "string") {
    parts.push(`schema=${details.schema_ref}`);
  }
  if (typeof details.path === "string") {
    parts.push(`path=${details.path}`);
  }
  if (typeof details.message === "string") {
    parts.push(details.message);
  }
  if (Array.isArray(details.errors)) {
    for (const item of details.errors.slice(0, 3)) {
      if (item === null || typeof item !== "object") {
        continue;
      }
      const err = item as Record<string, unknown>;
      const instancePath =
        typeof err.instance_path === "string"
          ? err.instance_path
          : typeof err.instancePath === "string"
            ? err.instancePath
            : typeof err.path === "string"
              ? err.path
              : "";
      const message =
        typeof err.message === "string" ? err.message : "invalid";
      const keyword =
        typeof err.keyword === "string" ? ` (${err.keyword})` : "";
      parts.push(
        instancePath.length > 0
          ? `${instancePath}: ${message}${keyword}`
          : `${message}${keyword}`,
      );
    }
  }
  return parts;
}

function statusForEngineFault(error: EngineFault): number {
  switch (error.code) {
    case "server.http.content_type_invalid":
      return 415;
    case "server.http.body_too_large":
      return 413;
    case "server.http.body_encoding_invalid":
    case "server.http.body_not_json":
      return 400;
    case "runtime.kernel.model_dispatch_ambiguous":
    case "command.journal.world_busy":
    case "command.journal.command_id_conflict":
    case "command.finalizer.completion_conflict":
    case "dialogue.finalizer.completion_conflict":
      return 409;
    default:
      return 422;
  }
}

function writeJson(
  response: import("node:http").ServerResponse,
  statusCode: number,
  body: JsonValue,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function writeText(
  response: import("node:http").ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(body);
}
