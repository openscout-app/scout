import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

export default {
  project: {
    name: "Scout",
    tagline: "Your personal agent cloud: a local control plane and mesh network.",
    type: "monorepo",
    version: packageMetadata.version,
  },

  // AGENTS.md is written by hand; Dewey builds llms.txt and docs.json from these sections.
  agent: {
    sections: ["overview", "quickstart", "extensions"],
  },

  docs: {
    path: "./docs",
    output: "./",
    required: ["overview", "quickstart", "extensions"],
  },

  install: {
    objective: "Install Scout and verify the local runtime.",
    doneWhen: {
      command: "scout doctor",
      expectedOutput: "A Scout readiness report with no blocking setup error.",
    },
    prerequisites: [
      "Bun 1.4.4 or newer",
      "macOS or Linux",
      "At least one supported coding-agent harness for routed work",
    ],
    steps: [
      { description: "Install the Scout CLI and bundled runtime", command: "bun add -g @openscout/scout" },
      { description: "Initialize local Scout state and services", command: "scout setup" },
      { description: "Verify local readiness", command: "scout doctor" },
      { description: "Confirm the inferred sender identity", command: "scout whoami" },
      { description: "List available targets", command: "scout who" },
    ],
  },
}
