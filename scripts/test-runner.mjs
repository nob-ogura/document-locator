import "dotenv/config";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const vitestBin = resolve("node_modules/.bin/vitest");

// Translate `--filter pattern` to Vitest positional filters (glob/test name)
const rawArgs = process.argv.slice(2);
const vitestArgs = ["run"];

for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];

  if (arg === "--filter") {
    const pattern = rawArgs[i + 1];
    if (pattern) {
      vitestArgs.push(pattern);
      i += 1;
      continue;
    }
  }

  if (arg.startsWith("--filter=")) {
    const pattern = arg.split("=", 2)[1];
    vitestArgs.push(pattern);
    continue;
  }

  vitestArgs.push(arg);
}

const result = spawnSync(vitestBin, vitestArgs, { stdio: "inherit" });

if (result.error) {
  console.error(result.error);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 0;
}
