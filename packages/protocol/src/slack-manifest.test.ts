import { describe, expect, test } from "bun:test";
import { slackAppManifest, slackClientAppManifest } from "./slack-manifest.ts";

describe("Slack app manifest", () => {
  test("keeps bot presence enabled for generic and project apps", () => {
    for (const mode of ["generic", "project"] as const) {
      const manifest = slackAppManifest("Scout", mode) as {
        features: { bot_user: { always_online: boolean } };
      };
      expect(manifest.features.bot_user.always_online).toBe(true);
    }
  });
});

describe("Slack operator client manifest", () => {
  test("keeps the operator connection user-scoped and includes file access", () => {
    const manifest = slackClientAppManifest() as {
      oauth_config: { scopes: { user: string[]; bot?: string[] } };
      settings: { socket_mode_enabled: boolean; token_rotation_enabled: boolean };
    };
    expect(manifest.oauth_config.scopes.bot).toBeUndefined();
    expect(manifest.oauth_config.scopes.user).toEqual(expect.arrayContaining([
      "channels:history",
      "channels:write",
      "chat:write",
      "emoji:read",
      "files:read",
      "files:write",
      "reactions:write",
    ]));
    expect(manifest.settings.socket_mode_enabled).toBe(false);
    expect(manifest.settings.token_rotation_enabled).toBe(false);
  });
});
