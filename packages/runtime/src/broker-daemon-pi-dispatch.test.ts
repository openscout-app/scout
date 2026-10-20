import { describe, expect, test } from "bun:test";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker Pi project dispatch", () => {
  for (const setupRequired of [false, true]) {
    test(setupRequired ? "fails tracked setup with actionable guidance" : "creates a cardless Pi flight, executes and captures its final reply", async () => {
      const home = mkdtempSync(join(tmpdir(), "scout-pi-dispatch-"));
      const bin = join(home, "bin");
      const project = join(home, "project");
      mkdirSync(bin);
      mkdirSync(project);
      const argvLog = join(home, "argv.json");
      const pi = join(bin, "pi");
      writeFileSync(pi, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
const emit = x => console.log(JSON.stringify(x));
const rl = require("node:readline").createInterface({input:process.stdin});
rl.on("line", line => {
 const cmd = JSON.parse(line);
 if (cmd.type === "get_state") {
   ${setupRequired
     ? 'emit({type:"extension_ui_request",method:"select",title:"Choose provider",id:"setup"});'
     : 'emit({type:"response",command:"get_state",success:true,data:{sessionId:"native-pi-fixture",model:{id:"fixture-model",provider:"fixture"},thinkingLevel:"off"}});'}
 }
 if (cmd.type !== "prompt") return;
 emit({type:"agent_start"});
 emit({type:"turn_start"});
 emit({type:"turn_end",message:{role:"assistant",content:[{type:"text",text:"Reading the file."}],stopReason:"toolUse"}});
 setTimeout(() => {
   emit({type:"turn_start"});
   emit({type:"turn_end",message:{role:"assistant",model:"fixture-model",provider:"fixture",content:[{type:"text",text:"SCOUT_CI_DISPATCH_OK"}],stopReason:"stop"}});
   emit({type:"agent_end"});
 }, 30);
});
`);
      chmodSync(pi, 0o755);
      broker.writeRelayAgentRegistry(join(home, "support"), {});
      const harness = await broker.startBroker({
        controlHome: home,
        env: {
          HOME: home, PATH: bin + ":" + process.env.PATH,
          OPENSCOUT_HOME: join(home, "scout-home"),
          OPENSCOUT_CORE_AGENTS: "", OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0",
          OPENSCOUT_PI_SCOUT_EXTENSION: "0",
        },
      });
      expect(existsSync(project)).toBe(true);
      const receipt = await broker.postJson<any>(harness.baseUrl, "/v1/deliver", {
        id: "pi-fixture-ask", caller: { actorId: "operator", nodeId: harness.nodeId },
        target: { kind: "project_path", projectPath: project },
        body: "Read the fixture.", intent: "consult",
        execution: { harness: "pi", model: "fixture/fixture-model", reasoningEffort: "none" },
        replyMode: "notify", createdAt: Date.now(),
      });
      expect(receipt.accepted).toBe(true);
      expect(receipt.flight?.id).toBeTruthy();
      const snapshot = await broker.waitFor(
        () => broker.getJson<any>(harness.baseUrl, "/v1/snapshot"),
        value => ["completed", "failed"].includes(value.flights[receipt.flight.id]?.state),
      );
      const flight = snapshot.flights[receipt.flight.id];
      const endpoint = Object.values(snapshot.endpoints).find((e: any) => e.agentId === receipt.targetAgentId) as any;
      expect(endpoint.transport).toBe("pi_rpc");
      expect(endpoint.harness).toBe("pi");
      expect(snapshot.agents[receipt.targetAgentId]).toBeUndefined();
      if (setupRequired) {
        expect(flight.state).toBe("failed");
        expect(flight.error).toContain("Run pi in this project");
      } else {
        expect(flight.state).toBe("completed");
        expect(flight.output).toBe("SCOUT_CI_DISPATCH_OK");
        expect(endpoint.sessionId).toBe(receipt.targetAgentId);
        expect(endpoint.metadata.externalSessionId).toBe("native-pi-fixture");
        expect(flight.metadata.dispatchAck.executionResolution.model.observed).toBe("fixture/fixture-model");
        expect(flight.metadata.dispatchAck.executionResolution.reasoningEffort.observed).toBe("none");
        expect(flight.metadata.dispatchAck.executionResolution.model.drift).toBe("match");
        expect(flight.metadata.dispatchAck.executionResolution.reasoningEffort.drift).toBe("match");
        const continued = await broker.postJson<any>(harness.baseUrl, "/v1/deliver", {
          id: "pi-fixture-continue", caller: { actorId: "operator", nodeId: harness.nodeId },
          target: { kind: "session_id", sessionId: endpoint.sessionId }, body: "Continue.", intent: "consult",
          execution: { harness: "pi", model: "fixture/fixture-model", reasoningEffort: "none", targetSessionId: endpoint.sessionId },
          replyMode: "notify", createdAt: Date.now(),
        });
        expect(continued.accepted).toBe(true);
        const resumed = await broker.waitFor(() => broker.getJson<any>(harness.baseUrl, "/v1/snapshot"),
          value => ["completed", "failed"].includes(value.flights[continued.flight.id]?.state));
        expect(resumed.flights[continued.flight.id].state).toBe("completed");
        expect(continued.targetAgentId).toBe(receipt.targetAgentId);
        // The reply message can land just after its flight reads completed, so wait for it.
        const isReply = (m: any) => m.body === flight.output && m.actorId === receipt.targetAgentId;
        const replied = await broker.waitFor(() => broker.getJson<any>(harness.baseUrl, "/v1/snapshot"),
          value => (Object.values(value.messages) as any[]).some(isReply));
        expect((Object.values(replied.messages) as any[]).some(isReply)).toBe(true);
        const args = JSON.parse(readFileSync(argvLog, "utf8"));
        expect(args.slice(0, 6)).toEqual(["--mode", "rpc", "--model", "fixture/fixture-model", "--thinking", "off"]);
      }
    }, 20_000);
  }
});
