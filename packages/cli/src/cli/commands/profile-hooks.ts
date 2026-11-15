import { registerUserConfigFieldAfterSet } from "@openscout/runtime";
import { saveOpenScoutOnboardingIdentity } from "@openscout/runtime/onboarding";

// Side effects shared by `scout config` and `scout settings`: setting the name
// also records it as the onboarding identity.
registerUserConfigFieldAfterSet("name", async (context, value) => {
  if (typeof value !== "string" || !value.trim()) return;
  await saveOpenScoutOnboardingIdentity({
    currentDirectory: context.currentDirectory ?? process.cwd(),
    name: value.trim(),
  });
});
