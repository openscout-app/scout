/** Repeatable source census, not confinement against arbitrary same-user code. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
const OWNER = "packages/runtime/src/pairing-security/trust-owner.ts";
export function pairingTrustCensus(root: string) {
  const directWriters: string[] = [], adapterInstallers: string[] = [], managedAdopters: string[] = [];
  const ownerConsumers: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      if (["node_modules", "dist", "build", ".build"].includes(entry.name)) continue;
      const path = join(directory, entry.name), rel = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) { if (entry.name !== "fixtures") visit(path); continue; }
      if (!/\.[cm]?[jt]sx?$/.test(entry.name) || /[._](test|spec)\./.test(entry.name) || /(?:test-helpers|test-harness|test-fixtures)/.test(rel)) continue;
      const source = readFileSync(path,"utf8");
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const importsOwner = source.includes("pairing-security/trust-owner") || source.includes('"./trust-owner.js"')
        || file.statements.some(statement => {
          if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== "@openscout/runtime/pairing-security") return false;
          const bindings = statement.importClause?.namedBindings;
          return bindings !== undefined && ts.isNamedImports(bindings)
            && bindings.elements.some(binding => (binding.propertyName ?? binding.name).text === "pairingTrustOwner");
        });
      if (importsOwner) ownerConsumers.push(rel);
      const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      function inspect(node: ts.Node) {
        if (ts.isCallExpression(node)) {
          const call = node.expression.getText(file), target = node.arguments[0]?.getText(file) ?? "";
          if (rel !== OWNER && /(?:writeFileSync|appendFileSync|renameSync|unlinkSync|copyFileSync|openSync|writeFile|appendFile)$/.test(call)
            && /trusted.?peers|TRUSTED_PEERS|\bPEERS\b/i.test(target)) directWriters.push(`${rel}:${line(node)}`);
          if (rel !== OWNER && (importsOwner || source.includes("trust-owner")) && /\.register$/.test(call)) adapterInstallers.push(`${rel}:${line(node)}`);
        }
        if (rel !== OWNER && ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property)
          && property.name.getText(file) === "type" && property.initializer.getText(file).replace(/["']/g,"") === "manage")) managedAdopters.push(`${rel}:${line(node)}`);
        ts.forEachChild(node, inspect);
      }
      inspect(file);
    }
  }
  visit(join(root,"packages"));
  if (existsSync(join(root,"apps"))) visit(join(root,"apps"));
  return {schema:"scout.pairing-trust-census/v1", canonicalOwner: OWNER, directWriters:directWriters.sort(),
    adapterInstallers:adapterInstallers.sort(), managedAdopters:managedAdopters.sort(), ownerConsumers:ownerConsumers.sort()};
}
if (import.meta.main) {
  const result = pairingTrustCensus(process.cwd()); console.log(JSON.stringify(result,null,2));
  if (result.directWriters.length || result.adapterInstallers.length || result.managedAdopters.length) process.exitCode = 1;
}
