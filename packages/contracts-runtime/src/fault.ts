import type { JsonObject } from "./json.js";

export class EngineFault extends Error {
  public readonly code: string;
  public readonly details: JsonObject | undefined;

  public constructor(
    code: string,
    message: string,
    details?: JsonObject,
  ) {
    super(message);
    this.name = "EngineFault";
    this.code = code;
    this.details = details;
  }
}

