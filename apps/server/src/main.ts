import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  EngineFault,
  Rfc8785JsonDigest,
  SchemaRegistry,
} from "@luoxia/contracts-runtime";

import { createRuntimeContentActivation } from "./application/runtime-content-activation.js";
import type {
  LuoxiaRuntimeDeploymentFactory,
  RuntimeDeploymentResources,
} from "./deployment/runtime-deployment.js";
import { startHealthServer } from "./http/health-server.js";
import { startRuntimeHttpServer } from "./http/runtime-server.js";

const options = parseOptions(process.argv.slice(2));
const contracts = await SchemaRegistry.load(options.contractsDirectory);
if (options.mode === "health") {
  await startHealthServer({
    host: options.host,
    port: options.port,
    contracts,
  });
} else {
  const digest = new Rfc8785JsonDigest();
  const deployment = await loadRuntimeDeployment(
    options.deploymentModulePath,
    { contracts, digest },
  );
  try {
    const activation = await createRuntimeContentActivation({
      ...deployment.activation,
      contracts,
      digest,
    });
    const server = await startRuntimeHttpServer({
      host: options.host,
      port: options.port,
      contracts,
      clientCommands: activation.kernel.clientCommands,
    });
    installShutdownHandlers(server, deployment);
  } catch (error: unknown) {
    try {
      await deployment.close();
    } catch (closeError: unknown) {
      throw new AggregateError(
        [error, closeError],
        "Runtime activation failed and deployment resources also failed to close",
      );
    }
    throw error;
  }
}

process.stdout.write(
  `Luoxia Engine ${options.mode} mode listening on http://${options.host}:${options.port}\n`,
);

interface CommonServerOptions {
  readonly contractsDirectory: string;
  readonly host: string;
  readonly port: number;
}

interface HealthServerOptions extends CommonServerOptions {
  readonly mode: "health";
}

interface RuntimeServerOptions extends CommonServerOptions {
  readonly mode: "runtime";
  readonly deploymentModulePath: string;
}

type ServerOptions = HealthServerOptions | RuntimeServerOptions;

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

    const name = argument.slice(2, separator);
    if (values.has(name)) {
      throw new EngineFault(
        "server.option.duplicate",
        `Server option --${name} was provided more than once`,
      );
    }
    values.set(name, argument.slice(separator + 1));
  }

  const contracts = requireOption(values, "contracts");
  const host = requireOption(values, "host");
  const portText = requireOption(values, "port");
  const mode = requireOption(values, "mode");
  const port = Number(portText);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new EngineFault(
      "server.option.port_invalid",
      "Server port must be an integer from 1 through 65535",
    );
  }

  const common = Object.freeze({
    contractsDirectory: resolve(contracts),
    host,
    port,
  });
  if (mode === "health") {
    assertOnlyOptions(values, [
      "contracts",
      "host",
      "port",
      "mode",
    ]);
    return Object.freeze({ ...common, mode });
  }
  if (mode === "runtime") {
    assertOnlyOptions(values, [
      "contracts",
      "host",
      "port",
      "mode",
      "deployment-module",
    ]);
    const deploymentModulePath = requireOption(
      values,
      "deployment-module",
    );
    if (!isAbsolute(deploymentModulePath)) {
      throw new EngineFault(
        "server.option.deployment_module_not_absolute",
        "Runtime --deployment-module must be an absolute filesystem path",
        { deployment_module: deploymentModulePath },
      );
    }
    return Object.freeze({
      ...common,
      mode,
      deploymentModulePath: resolve(deploymentModulePath),
    });
  }
  throw new EngineFault(
    "server.option.mode_invalid",
    "Server --mode must be health or runtime",
    { mode },
  );
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

function assertOnlyOptions(
  values: ReadonlyMap<string, string>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = [...values.keys()].filter(
    (name) => !allowedSet.has(name),
  );
  if (unknown.length > 0) {
    throw new EngineFault(
      "server.option.unknown",
      "Server received unsupported options for the selected mode",
      { unknown_options: unknown },
    );
  }
}

async function loadRuntimeDeployment(
  modulePath: string,
  input: Parameters<LuoxiaRuntimeDeploymentFactory>[0],
): Promise<RuntimeDeploymentResources> {
  const loaded = (await import(pathToFileURL(modulePath).href)) as {
    readonly createLuoxiaRuntimeDeployment?: unknown;
  };
  const factory = loaded.createLuoxiaRuntimeDeployment;
  if (typeof factory !== "function") {
    throw new EngineFault(
      "server.deployment.factory_missing",
      "Runtime deployment module must export createLuoxiaRuntimeDeployment",
      { deployment_module: modulePath },
    );
  }
  const resources = await (
    factory as LuoxiaRuntimeDeploymentFactory
  )(input);
  if (
    typeof resources !== "object" ||
    resources === null ||
    typeof resources.close !== "function" ||
    typeof resources.activation !== "object" ||
    resources.activation === null
  ) {
    throw new EngineFault(
      "server.deployment.resources_invalid",
      "Runtime deployment factory returned an invalid resources object",
      { deployment_module: modulePath },
    );
  }
  return resources;
}

function installShutdownHandlers(
  server: import("node:http").Server,
  deployment: RuntimeDeploymentResources,
): void {
  let closing = false;
  const close = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    server.close((serverError) => {
      void deployment
        .close()
        .then(() => {
          if (serverError !== undefined) {
            throw serverError;
          }
        })
        .catch((error: unknown) => {
          process.stderr.write(
            `Luoxia Engine shutdown failed: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
          process.exitCode = 1;
        });
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

