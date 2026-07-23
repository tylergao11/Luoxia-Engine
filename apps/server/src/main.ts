import { resolve } from "node:path";

import { EngineFault, SchemaRegistry } from "@luoxia/contracts-runtime";

import { startHealthServer } from "./http/health-server.js";

const options = parseOptions(process.argv.slice(2));
const contracts = await SchemaRegistry.load(options.contractsDirectory);
await startHealthServer({
  host: options.host,
  port: options.port,
  contracts,
});

process.stdout.write(
  `Luoxia Engine listening on http://${options.host}:${options.port}\n`,
);

interface ServerOptions {
  readonly contractsDirectory: string;
  readonly host: string;
  readonly port: number;
}

function parseOptions(arguments_: readonly string[]): ServerOptions {
  const values = new Map<string, string>();
  for (const argument of arguments_) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) {
      throw new EngineFault(
        "server.option.invalid",
        `Invalid server option ${argument}`,
      );
    }

    values.set(argument.slice(2, separator), argument.slice(separator + 1));
  }

  const contracts = requireOption(values, "contracts");
  const host = requireOption(values, "host");
  const portText = requireOption(values, "port");
  const port = Number(portText);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new EngineFault(
      "server.option.port_invalid",
      "Server port must be an integer from 1 through 65535",
    );
  }

  return Object.freeze({
    contractsDirectory: resolve(contracts),
    host,
    port,
  });
}

function requireOption(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0) {
    throw new EngineFault(
      "server.option.missing",
      `Missing required --${name}=... option`,
    );
  }

  return value;
}

