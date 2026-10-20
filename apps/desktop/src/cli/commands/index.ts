import type { ScoutCommandContext } from "../context.ts";

export type ScoutCommandHandler = (context: ScoutCommandContext, args: string[]) => Promise<void>;

export type ScoutCommandName =
  | "app"
  | "status"
  | "quarantine"
  | "notify"
  | "operator"
  | "ask"
  | "alias"
  | "broadcast"
  | "card"
  | "channel"
  | "chat"
  | "config"
  | "diff"
  | "down"
  | "doctor"
  | "report"
  | "feedback"
  | "env"
  | "flight"
  | "init"
  | "instance"
  | "inbox"
  | "install"
  | "integration"
  | "label"
  | "latest"
  | "recent"
  | "check"
  | "hosts"
  | "machines"
  | "match"
  | "mcp"
  | "menu"
  | "extensions"
  | "mesh"
  | "monitor"
  | "pair"
  | "ps"
  | "providers"
  | "restart"
  | "role"
  | "runtimes"
  | "route"
  | "where"
  | "locate"
  | "search"
  | "send"
  | "session"
  | "server"
  | "setup"
  | "speak"
  | "voice"
  | "statusline"
  | "tail"
  | "tell"
  | "tui"
  | "up"
  | "update"
  | "wait"
  | "watch"
  | "web"
  | "who"
  | "whoami";

export async function loadScoutCommandHandler(name: ScoutCommandName): Promise<ScoutCommandHandler> {
  switch (name) {
    case "integration":
      return (await import("./integration.ts")).runIntegrationCommand;
    case "app":
      return (await import("./app.ts")).runAppCommand;
    case "quarantine":
      return (await import("./quarantine.ts")).runQuarantineCommand;
    case "status":
      return (await import("./status.ts")).runStatusCommand;
    case "notify":
      return (await import("./notify.ts")).runNotifyCommand;
    case "operator":
      return (await import("./operator.ts")).runOperatorCommand;
    case "ask":
      return (await import("./ask.ts")).runAskCommand;
    case "alias":
      return (await import("./alias.ts")).runAliasCommand;
    case "broadcast":
      return (await import("./broadcast.ts")).runBroadcastCommand;
    case "card":
      return (await import("./card.ts")).runCardCommand;
    case "chat":
      return (await import("./chat.ts")).runChatCommand;
    case "channel":
      return (await import("./channel.ts")).runChannelCommand;
    case "config":
      return (await import("./config.ts")).runConfigCommand;
    case "diff":
      return (await import("./diff.ts")).runDiffCommand;
    case "down":
      return (await import("./down.ts")).runDownCommand;
    case "report":
      return (await import("./report.ts")).runReportCommand;
    case "feedback":
      return (await import("./report.ts")).runFeedbackCommand;
    case "doctor":
      return (await import("./doctor.ts")).runDoctorCommand;
    case "env":
      return (await import("./env.ts")).runEnvCommand;
    case "instance":
      return (await import("./instance.ts")).runInstanceCommand;
    case "flight":
      return (await import("./flight.ts")).runFlightCommand;
    case "init":
      return (await import("./init.ts")).runInitCommand;
    case "inbox":
      return (await import("./inbox.ts")).runInboxCommand;
    case "install":
      return (await import("./install.ts")).runInstallCommand;
    case "label":
      return (await import("./label.ts")).runLabelCommand;
    case "latest":
      return (await import("./latest.ts")).runLatestCommand;
    case "machines":
      return (await import("./machines.ts")).runMachinesCommand;
    case "match":
      return (await import("./match.ts")).runMatchCommand;
    case "mcp":
      return (await import("./mcp.ts")).runMcpCommand;
    case "menu":
      return (await import("./menu.ts")).runMenuCommand;
    case "extensions":
      return (await import("./extensions.ts")).runExtensionsCommand;
    case "mesh":
      return (await import("./mesh.ts")).runMeshCommand;
    case "monitor":
      return (await import("./monitor.ts")).runMonitorCommand;
    case "pair":
      return (await import("./pair.ts")).runPairCommand;
    case "ps":
      return (await import("./ps.ts")).runPsCommand;
    case "providers":
      return (await import("./providers.ts")).runProvidersCommand;
    case "restart":
      return (await import("./restart.ts")).runRestartCommand;
    case "role":
      return (await import("./role.ts")).runRoleCommand;
    case "runtimes":
      return (await import("./runtimes.ts")).runRuntimesCommand;
    case "where":
    case "route":
      return (await import("./route.ts")).runRouteCommand;
    case "locate":
      return (await import("./locate.ts")).runLocateCommand;
    case "search":
      return (await import("./search.ts")).runSearchCommand;
    case "send":
      return (await import("./send.ts")).runSendCommand;
    case "session":
      return (await import("./session.ts")).runSessionCommand;
    case "server":
      return (await import("./server.ts")).runServerCommand;
    case "setup":
      return (await import("./setup.ts")).runSetupCommand;
    case "speak":
      return (await import("./speak.ts")).runSpeakCommand;
    case "voice":
      return (await import("./voice.ts")).runVoiceCommand;
    case "statusline":
      return (await import("./statusline.ts")).runStatuslineCommand;
    case "web":
      return (await import("./web.ts")).runWebCommand;
    case "tail":
      return (await import("./tail.ts")).runTailCommand;
    case "tell":
      return (await import("./tell.ts")).runTellCommand;
    case "tui":
      return (await import("./tui.ts")).runTuiCommand;
    case "up":
      return (await import("./up.ts")).runUpCommand;
    case "update":
      return (await import("./update.ts")).runUpdateCommand;
    case "wait":
      return (await import("./wait.ts")).runWaitCommand;
    case "watch":
      return (await import("./watch.ts")).runWatchCommand;
    case "who":
      return (await import("./who.ts")).runWhoCommand;
    case "check":
    case "recent":
      return (await import("./recent.ts")).runRecentCommand;
    case "hosts":
      return (await import("./hosts.ts")).runHostsCommand;
    case "whoami":
      return (await import("./whoami.ts")).runWhoAmICommand;
  }
}
