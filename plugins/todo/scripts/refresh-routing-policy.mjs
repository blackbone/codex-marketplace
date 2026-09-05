import path from "node:path";
import { refreshRepoRoutingPolicy } from "./routing-policy.mjs";

const roots = process.argv.slice(2);
if (!roots.length) {
  process.stderr.write("Usage: node refresh-routing-policy.mjs <repository-root> [...]\n");
  process.exitCode = 1;
}
for (const root of roots) {
  const repoRoot = path.resolve(root);
  const result = refreshRepoRoutingPolicy(repoRoot);
  process.stdout.write(`${JSON.stringify({ repoRoot, ...result })}\n`);
  if (result.files.some((file) => file.error)) process.exitCode = 1;
}
