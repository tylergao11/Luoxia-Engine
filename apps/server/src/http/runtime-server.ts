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
      `${error.code}: ${error.message}`,
    );
    return;
  }
  writeText(
    response,
    500,
    "server.internal: Server failed before producing a verified response",
  );
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
