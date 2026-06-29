#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DEFAULT_POLICY_PATH = "~/.pi-web/workspace-access.json";
const DEFAULT_ENV_PATH = "~/.pi-web/workspace-auth.env";

const rl = readline.createInterface({ input, output });

try {
  console.log("PI WEB Workspace Auth setup");
  console.log("This writes an access policy and an optional shell env file. Better Auth secrets stay in the private env file, never in git.\n");

  const policyPathInput = await ask("Policy path", DEFAULT_POLICY_PATH);
  const policyPath = expandHome(policyPathInput);
  const envPathInput = await ask("Env file path", DEFAULT_ENV_PATH);
  const envPath = expandHome(envPathInput);
  const adminUserId = await ask("Your Better Auth user ID / admin user ID", "user_admin");
  const workspace = await ask("First allowed workspace path", process.cwd());
  const betterAuthApiUrl = await ask("Better Auth API URL (blank to skip for now)", "");
  const betterAuthKvUrl = await ask("Better Auth KV URL (blank to skip for now)", "");
  const betterAuthApiKey = await ask("Better Auth API key (blank to skip; input is visible)", "");
  const publishableKey = await ask("Legacy Clerk publishable key (blank to derive from issuer)", "");
  const issuer = await ask("Legacy Clerk issuer URL (blank to skip)", "");
  const audience = await ask("Legacy Clerk audience (blank unless configured in Clerk)", "");

  if (!existsSync(policyPath)) {
    await writeJson(policyPath, {
      admins: [adminUserId],
      users: {
        [adminUserId]: {
          label: "Admin",
          workspaces: [resolve(expandHome(workspace))],
          telegramUserIds: [],
        },
      },
    });
    console.log(`Created ${policyPath}`);
  } else {
    console.log(`Kept existing ${policyPath}`);
  }

  const lines = [
    "# Source this before starting PI WEB:",
    `#   source ${envPath}`,
    "export PI_WEB_WORKSPACE_AUTH=true",
    `export PI_WEB_WORKSPACE_ACCESS=${shellQuote(policyPath)}`,
  ];
  if (betterAuthApiUrl !== "") lines.push(`export BETTER_AUTH_API_URL=${shellQuote(betterAuthApiUrl)}`);
  if (betterAuthKvUrl !== "") lines.push(`export BETTER_AUTH_KV_URL=${shellQuote(betterAuthKvUrl)}`);
  if (betterAuthApiKey !== "") lines.push(`export BETTER_AUTH_API_KEY=${shellQuote(betterAuthApiKey)}`);
  lines.push("# Legacy Clerk fallback until PI WEB browser auth is fully migrated to Better Auth.");
  if (publishableKey !== "") lines.push(`export CLERK_PUBLISHABLE_KEY=${shellQuote(publishableKey)}`);
  if (issuer !== "") lines.push(`export CLERK_ISSUER=${shellQuote(issuer)}`);
  if (audience !== "") lines.push(`export CLERK_AUDIENCE=${shellQuote(audience)}`);
  lines.push("# Only enable behind a trusted proxy that strips spoofed client headers:");
  lines.push("# export PI_WEB_TRUST_AUTH_HEADERS=true");
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  console.log(`Wrote ${envPath}`);

  console.log("\nNext:");
  console.log(`  source ${envPath}`);
  console.log("  pi-web-server");
  console.log("\nAdd more users by editing the policy file. Better Auth user IDs are the keys under users.");
} finally {
  rl.close();
}

async function ask(label, fallback) {
  const suffix = fallback === "" ? "" : ` [${fallback}]`;
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer === "" ? fallback : answer;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
