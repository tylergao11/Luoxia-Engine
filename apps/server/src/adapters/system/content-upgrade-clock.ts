import { EngineFault } from "@luoxia/contracts-runtime";

import type {
  ContentUpgradeClock,
  ContentUpgradeWindow,
} from "../../application/content-upgrade-orchestrator.js";

export function createSystemContentUpgradeClock(
  authorizationLifetimeSeconds: number,
): ContentUpgradeClock {
  if (
    !Number.isSafeInteger(authorizationLifetimeSeconds) ||
    authorizationLifetimeSeconds <= 0
  ) {
    throw new EngineFault(
      "content_upgrade.clock.lifetime_invalid",
      "Content Upgrade authorization lifetime must be a positive safe integer number of seconds",
      { authorization_lifetime_seconds: authorizationLifetimeSeconds },
    );
  }
  const lifetimeMilliseconds = authorizationLifetimeSeconds * 1000;
  if (!Number.isSafeInteger(lifetimeMilliseconds)) {
    throw new EngineFault(
      "content_upgrade.clock.lifetime_invalid",
      "Content Upgrade authorization lifetime exceeds the safe millisecond range",
      { authorization_lifetime_seconds: authorizationLifetimeSeconds },
    );
  }

  return Object.freeze({
    issueWindow(): ContentUpgradeWindow {
      const issued = new Date();
      const expires = new Date(issued.getTime() + lifetimeMilliseconds);
      if (Number.isNaN(expires.getTime())) {
        throw new EngineFault(
          "content_upgrade.clock.lifetime_invalid",
          "Content Upgrade authorization expiry cannot be represented",
        );
      }
      return Object.freeze({
        issuedAt: issued.toISOString(),
        expiresAt: expires.toISOString(),
      });
    },
    now(): string {
      return new Date().toISOString();
    },
  });
}
