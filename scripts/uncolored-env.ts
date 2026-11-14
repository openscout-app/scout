/**
 * The caller's environment without color requests. Control scripts read the
 * plain `bun test` markers in a child's output, so the child must print the
 * same text whatever terminal or CI settings started the script.
 */
export function uncoloredEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && key !== "FORCE_COLOR" && key !== "CLICOLOR_FORCE") env[key] = value;
  }
  env.NO_COLOR = "1";
  return env;
}
