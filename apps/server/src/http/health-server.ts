import { createServer, type Server } from "node:http";

import type { ContractValidator } from "@luoxia/contracts-runtime";

export interface HealthServerOptions {
  readonly host: string;
  readonly port: number;
  readonly contracts: ContractValidator;
}

export async function startHealthServer(
  options: HealthServerOptions,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/health") {
      writeJson(response, 200, {
        status: "ok",
        contracts_loaded: options.contracts.schemaIds.length,
      });
      return;
    }

    writeJson(response, 404, {
      status: "not_found",
    });
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

function writeJson(
  response: import("node:http").ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, number | string>>,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

