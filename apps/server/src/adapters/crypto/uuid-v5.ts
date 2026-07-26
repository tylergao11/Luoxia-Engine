import { createHash } from "node:crypto";

import { EngineFault } from "@luoxia/contracts-runtime";

const UUID_TEXT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 9562 UUIDv5 over an existing UUID namespace and a UTF-8 name. */
export function createUuidV5(namespaceUuid: string, name: string): string {
  const namespace = uuidBytes(namespaceUuid);
  const digest = createHash("sha1")
    .update(namespace)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x50;
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function uuidBytes(value: string): Buffer {
  if (!UUID_TEXT_PATTERN.test(value)) {
    throw new EngineFault(
      "server.uuid_v5.namespace_invalid",
      "UUIDv5 namespace must be a UUID",
      { namespace_uuid: value },
    );
  }
  const bytes = Buffer.from(value.replaceAll("-", ""), "hex");
  if (bytes.length !== 16) {
    throw new EngineFault(
      "server.uuid_v5.namespace_invalid",
      "UUIDv5 namespace must contain exactly 16 UUID bytes",
      { namespace_uuid: value },
    );
  }
  return bytes;
}

function formatUuid(bytes: Buffer): string {
  if (bytes.length !== 16) {
    throw new EngineFault(
      "server.uuid_v5.digest_invalid",
      "UUIDv5 digest prefix must contain exactly 16 bytes",
      { byte_length: bytes.length },
    );
  }
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
