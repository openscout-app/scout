export function slackClientAppManifest(appName = "Scout Client"): Record<string, unknown> {
  return {
    display_information: {
      name: appName,
      description: "Read and respond to Slack conversations through Scout",
      background_color: "#171717",
    },
    oauth_config: {
      scopes: {
        user: [
          "channels:history",
          "channels:read",
          "channels:write",
          "chat:write",
          "emoji:read",
          "files:read",
          "files:write",
          "groups:history",
          "groups:read",
          "groups:write",
          "im:history",
          "im:read",
          "im:write",
          "mpim:history",
          "mpim:read",
          "mpim:write",
          "reactions:read",
          "reactions:write",
          "users:read",
        ],
      },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export function slackAppManifest(appName = "Scout", mode: "generic" | "project" = "generic"): Record<string, unknown> {
  return {
    display_information: {
      name: appName,
      description: mode === "project" ? `Reach the ${appName} project agent through Scout` : "Turn Slack requests into durable Scout coding work",
      background_color: "#171717",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: appName,
        always_online: false,
      },
      ...(mode === "generic" ? { slash_commands: [
        {
          command: "/scout",
          description: "Start Scout work, optionally routed to a target or exact session",
          usage_hint: "[@target|session:<id>] request",
          should_escape: false,
        },
        {
          command: "/scout-settings",
          description: "Set the default project, branch, and harness for this channel",
          should_escape: false,
        },
      ] } : {}),
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "channels:history",
          "chat:write",
          "files:read",
          "groups:history",
          "im:history",
          "mpim:history",
          "reactions:write",
          "users:read",
          ...(mode === "generic" ? ["commands"] : []),
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: ["app_mention", "message.im"],
      },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

