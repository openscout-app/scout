export function normalizeCliBinaryMtimeMs(value: number): number {
  return Math.floor(value);
}

export function shouldEnsureBrokerUptodateForCommand(command: string | null, args: string[] = []): boolean {
  if (!command || command === "doctor" || command === "quarantine" || args.includes("--help") || args.includes("-h")) return false;
  // Read-only roster/live inspection must not restart what it is observing.
  if (command === "who" || command === "check" || command === "recent" || command === "where" || command === "locate" || command === "route" || command === "hosts" || command === "whoami" || command === "extensions") return false;
  // scout-base supervises the mesh bridge; a bridge (re)start that restarts the
  // broker service would take down its own supervisor.
  if (command === "mesh" && args[0] === "bridge") return false;
  // Local-only knowledge search does not need broker maintenance, and the web
  // download commands only restart the web server, never the broker.
  if (command === "web") return false;
  return command !== "chat" && command !== "status" && command !== "report" && command !== "feedback" && command !== "mcp" && command !== "statusline" && command !== "search";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    const stringValue = readNonEmptyString(value);
    if (stringValue) {
      return stringValue;
    }
  }
  return null;
}

export type ScoutBuildIdentity = {
  display: string | null;
  packageName: string | null;
  version: string | null;
  commit: string | null;
  buildId: string | null;
};

function emptyBuildIdentity(): ScoutBuildIdentity {
  return {
    display: null,
    packageName: null,
    version: null,
    commit: null,
    buildId: null,
  };
}

function buildIdentityHasComparableValue(identity: ScoutBuildIdentity): boolean {
  return Boolean(identity.version || identity.commit || identity.buildId);
}

function buildIdentityHasAnyValue(identity: ScoutBuildIdentity): boolean {
  return Boolean(identity.display || buildIdentityHasComparableValue(identity));
}

function readBuildIdentityRecord(record: Record<string, unknown>): ScoutBuildIdentity {
  const packageName = firstNonEmptyString([record.packageName, record.name]);
  const version = firstNonEmptyString([
    record.version,
    record.appVersion,
    record.runtimeVersion,
    record.cliVersion,
    record.scoutVersion,
  ]);
  const commit = firstNonEmptyString([
    record.commit,
    record.gitSha,
    record.gitSHA,
    record.sha,
  ]);
  const buildId = firstNonEmptyString([
    record.buildId,
    record.buildID,
    record.id,
  ]);
  const display = firstNonEmptyString([
    record.identity,
    record.buildIdentity,
    record.runtimeBuild,
    record.scoutBuild,
    buildId,
    commit,
    version,
  ]);

  return {
    display,
    packageName,
    version,
    commit,
    buildId,
  };
}

function readBuildIdentity(value: unknown): ScoutBuildIdentity {
  const direct = readNonEmptyString(value);
  if (direct) {
    return {
      ...emptyBuildIdentity(),
      display: direct,
      version: direct,
    };
  }
  if (isRecord(value)) {
    return readBuildIdentityRecord(value);
  }
  return emptyBuildIdentity();
}

function mergeBuildIdentity(primary: ScoutBuildIdentity, fallback: ScoutBuildIdentity): ScoutBuildIdentity {
  return {
    display: primary.display ?? fallback.display,
    packageName: primary.packageName ?? fallback.packageName,
    version: primary.version ?? fallback.version,
    commit: primary.commit ?? fallback.commit,
    buildId: primary.buildId ?? fallback.buildId,
  };
}

function extractBuildIdentityFromRecord(record: Record<string, unknown>): ScoutBuildIdentity {
  const healthRecord = isRecord(record.health) ? record.health : null;
  const statusRecord = isRecord(record.status) ? record.status : null;
  const healthBuild = healthRecord && isRecord(healthRecord.build) ? readBuildIdentityRecord(healthRecord.build) : null;
  if (healthBuild && buildIdentityHasAnyValue(healthBuild)) {
    return healthBuild;
  }

  if (statusRecord) {
    const statusIdentity = extractBuildIdentityFromRecord(statusRecord);
    if (buildIdentityHasAnyValue(statusIdentity)) {
      return statusIdentity;
    }
  }

  const buildIdentity = readBuildIdentity(record.build);
  const inlineIdentity = readBuildIdentityRecord(record);
  const merged = mergeBuildIdentity(buildIdentity, inlineIdentity);
  return buildIdentityHasAnyValue(merged) ? merged : emptyBuildIdentity();
}

export function extractBuildIdentityPartsFromScoutdPayload(payload: unknown): ScoutBuildIdentity {
  if (!isRecord(payload)) {
    return emptyBuildIdentity();
  }
  return extractBuildIdentityFromRecord(payload);
}

export function extractBuildIdentityFromScoutdPayload(payload: unknown): string | null {
  return extractBuildIdentityPartsFromScoutdPayload(payload).display;
}

export function resolveCurrentCliBuildIdentity(
  env: Record<string, string | undefined>,
  fallbackVersion: string,
): string | null {
  return firstNonEmptyString([
    env.OPENSCOUT_BUILD_ID,
    env.SCOUT_BUILD_ID,
    env.SCOUT_APP_VERSION,
    fallbackVersion,
  ]);
}

export function resolveCurrentCliBuildIdentityParts(
  env: Record<string, string | undefined>,
  fallbackVersion: string,
): ScoutBuildIdentity {
  const buildId = firstNonEmptyString([env.OPENSCOUT_BUILD_ID, env.SCOUT_BUILD_ID]);
  const commit = firstNonEmptyString([
    env.OPENSCOUT_BUILD_COMMIT,
    env.OPENSCOUT_BUILD_SHA,
    env.GIT_COMMIT,
    env.GIT_SHA,
  ]);
  const version = firstNonEmptyString([
    env.SCOUT_APP_VERSION,
    env.OPENSCOUT_VERSION,
    env.npm_package_version,
    fallbackVersion,
  ]);

  return {
    display: buildId ?? commit ?? version,
    packageName: null,
    version,
    commit,
    buildId,
  };
}

function normalizeBuildIdentity(input: ScoutBuildIdentity | string | null): ScoutBuildIdentity {
  if (typeof input === "string") {
    return readBuildIdentity(input);
  }
  return input ?? emptyBuildIdentity();
}

export function canCompareBrokerBuildIdentity(
  currentIdentity: ScoutBuildIdentity | string | null,
  runningIdentity: ScoutBuildIdentity | string | null,
): boolean {
  const current = normalizeBuildIdentity(currentIdentity);
  const running = normalizeBuildIdentity(runningIdentity);
  return Boolean(
    (current.buildId && running.buildId)
      || (current.commit && running.commit)
      || (current.version && running.version),
  );
}

export function shouldRestartBrokerForBuildIdentity(
  currentIdentity: ScoutBuildIdentity | string | null,
  runningIdentity: ScoutBuildIdentity | string | null,
): boolean {
  const current = normalizeBuildIdentity(currentIdentity);
  const running = normalizeBuildIdentity(runningIdentity);
  if (current.buildId && running.buildId) {
    return current.buildId !== running.buildId;
  }
  if (current.commit && running.commit) {
    return current.commit !== running.commit;
  }
  if (current.version && running.version) {
    return current.version !== running.version;
  }
  return false;
}
