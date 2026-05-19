#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { execFile, execFileSync } = require("node:child_process");

const START = "# >>> codex-switch";
const END = "# <<< codex-switch";

function usage() {
  return `
codex-switch

Configure a Codex custom provider profile for an OpenAI Responses-compatible relay API.

Usage:
  codex-switch setup --name <profile> --base-url <url> --model <model>
  codex-switch setup --name vayne --base-url https://api.example.com/v1 --model gpt-5.5
  codex-switch model --name <profile> --model <model>
  codex-switch thread-model --model <model> [--provider <provider>] [--thread <id>]
  codex-switch list
  codex-switch default --name <profile>
  codex-switch account
  codex-switch web
  codex-switch remove --name <profile>

Options:
  --codex-home <dir>       Defaults to ~/.codex
  --key-file <path>        Defaults to ~/.codex/<profile>_api_key
  --key-env <env-name>     Use an environment variable instead of a local key file
  --reasoning-effort <val> Defaults to medium
  --state-db <path>        Defaults to ~/.codex/state_5.sqlite
  --thread <id>            Thread id for thread-model; defaults to latest thread
  --provider <provider>    Provider for thread-model; defaults to current profile or vayne
  --delete-key             Delete the local key file when removing a profile
  --host <host>            Web server host, default 127.0.0.1
  --port <port>            Web server port, default 8787
  --no-open                Do not open the web UI in a browser
  --no-migrate-history     Do not move Codex threads to the selected provider
  --keep-account-workspace Experimental: only switch API provider, preserve thread workspace metadata
  --restart-codex          Restart the macOS Codex app after switching
  --force                  Overwrite an existing key file without prompting

Security:
  API keys are not written to config.toml. By default, the profile reads a local
  chmod 600 key file through a command-backed auth provider.
`.trim();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };

  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith("--")) {
      throw new Error(`Unexpected argument: ${item}`);
    }

    const key = item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (
      key === "force" ||
      key === "deleteKey" ||
      key === "noOpen" ||
      key === "noMigrateHistory" ||
      key === "keepAccountWorkspace" ||
      key === "restartCodex"
    ) {
      args[key] = true;
      continue;
    }

    const value = rest[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${item}`);
    }
    args[key] = value;
    i += 1;
  }

  return args;
}

function expandHome(input) {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function validateName(name) {
  if (!/^[A-Za-z0-9_-]+$/.test(name || "")) {
    throw new Error("Profile name may only contain letters, numbers, underscores, and hyphens.");
  }
}

function tomlString(value) {
  return JSON.stringify(value);
}

function providerId(name) {
  return name.replace(/-/g, "_");
}

function managedBlock(name, options) {
  const id = providerId(name);
  const lines = [
    `${START}:${name}`,
    `[profiles.${name}]`,
    `model_provider = ${tomlString(id)}`,
    `model = ${tomlString(options.model)}`,
    `model_reasoning_effort = ${tomlString(options.reasoningEffort || "medium")}`,
    `model_catalog_json = ${tomlString(options.catalogFile)}`,
    "",
    `[model_providers.${id}]`,
    `name = ${tomlString(options.displayName || name)}`,
    `base_url = ${tomlString(options.baseUrl)}`,
    `wire_api = "responses"`,
  ];

  if (options.keyEnv) {
    lines.push(`env_key = ${tomlString(options.keyEnv)}`);
  } else {
    lines.push(`auth.command = "cat"`);
    lines.push(`auth.args = [${tomlString(options.keyFile)}]`);
  }

  lines.push(`${END}:${name}`);
  return `${lines.join("\n")}\n`;
}

function removeManagedBlock(config, name) {
  const pattern = new RegExp(
    `\\n?${escapeRegExp(START)}:${escapeRegExp(name)}\\n[\\s\\S]*?${escapeRegExp(END)}:${escapeRegExp(name)}\\n?`,
    "g",
  );
  return config.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    return fs.readFileSync(0, "utf8").trim();
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function resolvePaths(args) {
  const codexHome = expandHome(args.codexHome || "~/.codex");
  const configPath = path.join(codexHome, "config.toml");
  const keyFile = expandHome(args.keyFile || path.join(codexHome, `${args.name}_api_key`));
  const catalogFile = path.join(codexHome, "codex-switch", `${args.name}_models.json`);
  return { codexHome, configPath, keyFile, catalogFile };
}

function modelCatalogEntry(model) {
  return {
    slug: model,
    display_name: model,
    description: "Relay model managed by codex-switch.",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth" },
      { effort: "high", description: "Greater reasoning depth" },
      { effort: "xhigh", description: "Extra high reasoning depth" },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: "You are Codex, a coding agent.",
    model_messages: {
      instructions_template: "You are Codex, a coding agent.\n\n{{ personality }}",
      instructions_variables: {
        personality_default: "",
        personality_friendly: null,
        personality_pragmatic: null,
      },
    },
    supports_reasoning_summaries: true,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 272000,
    max_context_window: 1000000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
  };
}

function writeModelCatalog(codexHome, name, models) {
  validateName(name);
  const uniqueModels = [...new Set(models.filter((model) => typeof model === "string" && model.trim()))];
  if (!uniqueModels.length) return "";

  const catalogFile = path.join(codexHome, "codex-switch", `${name}_models.json`);
  fs.mkdirSync(path.dirname(catalogFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    catalogFile,
    `${JSON.stringify({ models: uniqueModels.map(modelCatalogEntry) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(catalogFile, 0o600);
  return catalogFile;
}

function readModelCatalog(catalogFile) {
  if (!catalogFile || !fs.existsSync(catalogFile)) return [];
  try {
    const payload = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    return Array.isArray(payload.models)
      ? payload.models.map((model) => model && model.slug).filter((slug) => typeof slug === "string" && slug)
      : [];
  } catch {
    return [];
  }
}

function writeProfile(args, secret) {
  validateName(args.name);
  if (!args.baseUrl) throw new Error("--base-url is required.");
  if (!args.model) throw new Error("--model is required.");

  const { codexHome, configPath, keyFile, catalogFile } = resolvePaths(args);

  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  let config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  config = removeManagedBlock(config, args.name);

  if (!args.keyEnv) {
    if (secret) {
      fs.writeFileSync(keyFile, `${secret}\n`, { mode: 0o600 });
      fs.chmodSync(keyFile, 0o600);
    } else if (!fs.existsSync(keyFile)) {
      throw new Error("API key cannot be empty.");
    }
  }

  const catalogModels = args.catalogModels || readModelCatalog(catalogFile);
  writeModelCatalog(codexHome, args.name, [...catalogModels, args.model]);

  const block = managedBlock(args.name, {
    baseUrl: args.baseUrl,
    model: args.model,
    keyFile,
    keyEnv: args.keyEnv,
    reasoningEffort: args.reasoningEffort,
    catalogFile,
  });

  const nextConfig = `${config.trimEnd()}\n\n${block}`;
  fs.writeFileSync(configPath, nextConfig, { mode: 0o600 });

  return { configPath, keyFile };
}

async function setup(args) {
  let secret;
  if (!args.keyEnv) {
    const { keyFile } = resolvePaths(args);
    if (!fs.existsSync(keyFile) || args.force) {
      secret = await readSecret("API key: ");
      if (!secret) throw new Error("API key cannot be empty.");
    }
  }

  writeProfile(args, secret);
  console.log(`Configured Codex profile: ${args.name}`);
  console.log(`Run: codex --profile ${args.name}`);
}

function remove(args) {
  validateName(args.name);
  const { configPath, keyFile } = resolvePaths(args);
  if (!fs.existsSync(configPath)) return;

  const config = fs.readFileSync(configPath, "utf8");
  fs.writeFileSync(configPath, removeManagedBlock(config, args.name), { mode: 0o600 });
  console.log(`Removed managed Codex profile block: ${args.name}`);

  if (args.deleteKey && fs.existsSync(keyFile)) {
    fs.unlinkSync(keyFile);
    console.log(`Deleted local key file: ${keyFile}`);
  }
}

function defaultCommand(args) {
  const codexHome = expandHome(args.codexHome || "~/.codex");
  const profile = getManagedProfile(codexHome, args.name);
  if (!profile) {
    throw new Error(`Managed profile not found: ${args.name}`);
  }
  setDefaultProfile(args.name, codexHome);
  const migration = args.noMigrateHistory || args.keepAccountWorkspace
    ? null
    : migrateThreads(codexHome, providerId(args.name), { toModel: profile.model });
  console.log(`Set default Codex profile: ${args.name}`);
  if (args.keepAccountWorkspace) {
    console.log("Kept Codex thread workspace metadata unchanged.");
  }
  if (migration) {
    console.log(`Moved ${migration.changed} thread(s) to provider: ${providerId(args.name)}`);
    if (migration.modelChanged) console.log(`Updated ${migration.modelChanged} thread model(s) to: ${profile.model}`);
    console.log(`Updated ${migration.rolloutChanged} rollout file(s).`);
    if (migration.repairedRolloutPaths) console.log(`Repaired ${migration.repairedRolloutPaths} rollout path(s).`);
    console.log(`Backup: ${migration.backupPath}`);
  }
  if (args.restartCodex) {
    restartCodexApp();
    console.log("Restarted Codex app.");
  }
  console.log("Run: codex");
}

function accountCommand(args) {
  const codexHome = expandHome(args.codexHome || "~/.codex");
  clearDefaultProfile(codexHome);
  const migration = args.noMigrateHistory ? null : migrateThreads(codexHome, "openai");
  console.log("Set Codex to use ChatGPT account login.");
  if (migration) {
    console.log(`Moved ${migration.changed} thread(s) to provider: openai`);
    console.log(`Updated ${migration.rolloutChanged} rollout file(s).`);
    if (migration.repairedRolloutPaths) console.log(`Repaired ${migration.repairedRolloutPaths} rollout path(s).`);
    console.log(`Backup: ${migration.backupPath}`);
  }
  if (args.restartCodex) {
    restartCodexApp();
    console.log("Restarted Codex app.");
  }
  console.log("Run: codex");
}

function listCommand(args) {
  const codexHome = expandHome(args.codexHome || "~/.codex");
  const targets = switchTargets(codexHome);

  console.log(`Current: ${targets.current}`);
  console.log("");
  console.log(`${targets.account.isDefault ? "*" : " "} account`);
  console.log(`  model: ${targets.account.model}`);
  console.log(`  run: ${targets.account.command}`);

  for (const profile of targets.profiles) {
    console.log("");
    console.log(`${profile.isDefault ? "*" : " "} ${profile.name}`);
    console.log(`  model: ${profile.model || "(none)"}`);
    console.log(`  base_url: ${profile.baseUrl || "(none)"}`);
    console.log(`  run: ${profile.command}`);
  }
}

function modelCommand(args) {
  validateName(args.name);
  if (!args.model) throw new Error("--model is required.");

  const codexHome = expandHome(args.codexHome || "~/.codex");
  const profile = getManagedProfile(codexHome, args.name);
  if (!profile) {
    throw new Error(`Managed profile not found: ${args.name}`);
  }

  writeProfile({
    codexHome,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: args.model,
    keyFile: profile.keyFile,
    keyEnv: profile.keyEnv,
    reasoningEffort: profile.reasoningEffort,
    catalogModels: readModelCatalog(profile.catalogFile),
  });

  console.log(`Updated Codex profile model: ${args.name} -> ${args.model}`);
  console.log(`Run: codex --profile ${args.name}`);
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlite(dbPath, sql) {
  return execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).trim();
}

function latestThreadId(stateDb) {
  return sqlite(
    stateDb,
    "select id from threads where archived = 0 order by coalesce(updated_at_ms, updated_at * 1000, 0) desc, coalesce(created_at_ms, created_at * 1000, 0) desc limit 1;",
  );
}

function backupStateDb(stateDb) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const backupPath = `${stateDb}.codex-switch-${stamp}.bak`;
  fs.copyFileSync(stateDb, backupPath);
  return backupPath;
}

function backupFile(filePath, stamp) {
  const backupPath = `${filePath}.codex-switch-${stamp}.bak`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function readRolloutFirstLine(rolloutPath) {
  const fd = fs.openSync(rolloutPath, "r");
  const chunks = [];
  const chunkSize = 64 * 1024;
  const maxLineBytes = 1024 * 1024;
  const buffer = Buffer.allocUnsafe(chunkSize);
  let position = 0;
  let total = 0;

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, position);
      if (!bytesRead) {
        return {
          line: Buffer.concat(chunks, total).toString("utf8"),
          lineBytes: total,
          restOffset: position,
          hasNewline: false,
        };
      }

      const newlineIndex = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (newlineIndex !== -1 && newlineIndex < bytesRead) {
        chunks.push(Buffer.from(buffer.subarray(0, newlineIndex)));
        total += newlineIndex;
        return {
          line: Buffer.concat(chunks, total).toString("utf8"),
          lineBytes: total,
          restOffset: position + newlineIndex + 1,
          hasNewline: true,
        };
      }

      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
      if (total > maxLineBytes) return null;
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function rewriteRolloutFirstLine(rolloutPath, firstLine, info, stamp) {
  const firstLineBuffer = Buffer.from(firstLine, "utf8");
  if (info.hasNewline && firstLineBuffer.length <= info.lineBytes) {
    const fd = fs.openSync(rolloutPath, "r+");
    try {
      fs.writeSync(fd, firstLineBuffer, 0, firstLineBuffer.length, 0);
      if (firstLineBuffer.length < info.lineBytes) {
        fs.writeSync(fd, Buffer.alloc(info.lineBytes - firstLineBuffer.length, 0x20), 0, info.lineBytes - firstLineBuffer.length, firstLineBuffer.length);
      }
    } finally {
      fs.closeSync(fd);
    }
    return;
  }

  const tempPath = `${rolloutPath}.codex-switch-${stamp}.${process.pid}.tmp`;
  const inFd = fs.openSync(rolloutPath, "r");
  const outFd = fs.openSync(tempPath, "wx", 0o600);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = info.restOffset;

  try {
    fs.writeSync(outFd, firstLineBuffer);
    if (info.hasNewline) fs.writeSync(outFd, "\n");

    while (true) {
      const bytesRead = fs.readSync(inFd, buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      fs.writeSync(outFd, buffer, 0, bytesRead);
      position += bytesRead;
    }
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch (_) {
      // Best effort cleanup.
    }
    throw error;
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }

  fs.renameSync(tempPath, rolloutPath);
}

function updateRolloutProvider(rolloutPath, provider, stamp) {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return false;
  const info = readRolloutFirstLine(rolloutPath);
  if (!info) return false;
  const firstLine = info.line;
  if (!firstLine.trim()) return false;

  let entry;
  try {
    entry = JSON.parse(firstLine);
  } catch {
    return false;
  }

  if (entry.type !== "session_meta" || !entry.payload || entry.payload.model_provider === provider) {
    return false;
  }

  entry.payload.model_provider = provider;
  backupFile(rolloutPath, stamp);
  rewriteRolloutFirstLine(rolloutPath, JSON.stringify(entry), info, stamp);
  return true;
}

function originalRolloutPath(rolloutPath) {
  const marker = ".codex-switch-";
  const markerIndex = rolloutPath.indexOf(marker);
  if (markerIndex === -1 || !rolloutPath.endsWith(".bak")) return "";
  return rolloutPath.slice(0, markerIndex);
}

function repairRolloutPath(rolloutPath, stamp) {
  const originalPath = originalRolloutPath(rolloutPath);
  if (!originalPath || !fs.existsSync(rolloutPath) || fs.existsSync(originalPath)) return "";

  fs.mkdirSync(path.dirname(originalPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(rolloutPath, originalPath);
  fs.chmodSync(originalPath, 0o600);

  const repairBackupPath = `${rolloutPath}.codex-switch-repair-${stamp}.bak`;
  fs.copyFileSync(rolloutPath, repairBackupPath);
  return originalPath;
}

function migrateThreads(codexHome, provider, options = {}) {
  validateName(provider);
  const stateDb = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(stateDb)) return null;
  const toModel = typeof options.toModel === "string" ? options.toModel : "";
  const shouldMigrateModel = Boolean(toModel);

  const rolloutRows = sqlite(
    stateDb,
    "select id || char(9) || rollout_path from threads where coalesce(rollout_path, '') != '';",
  )
    .split("\n")
    .map((line) => {
      const tab = line.indexOf("\t");
      if (tab === -1) return null;
      return { id: line.slice(0, tab), rolloutPath: line.slice(tab + 1).trim() };
    })
    .filter((row) => row && row.rolloutPath);

  const changed = Number(
    sqlite(
      stateDb,
      `select count(*) from threads where coalesce(model_provider, '') != ${sqlString(provider)};`,
    ),
  );
  const modelChanged = shouldMigrateModel
    ? Number(
        sqlite(
          stateDb,
          [
            "select count(*) from threads",
            `where coalesce(model, '') != ${sqlString(toModel)}`,
            "and coalesce(model, '') != ''",
          ].join(" "),
        ),
      )
    : 0;

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const repairs = [];
  for (const row of rolloutRows) {
    const repairedPath = repairRolloutPath(row.rolloutPath, stamp);
    if (repairedPath) {
      repairs.push({ id: row.id, from: row.rolloutPath, to: repairedPath });
      row.rolloutPath = repairedPath;
    }
  }
  const rolloutChanged = rolloutRows.filter((row) => updateRolloutProvider(row.rolloutPath, provider, stamp)).length;

  if (!changed && !modelChanged && !rolloutChanged && repairs.length === 0) return null;

  const backupPath = `${stateDb}.codex-switch-${stamp}.bak`;
  fs.copyFileSync(stateDb, backupPath);
  for (const repair of repairs) {
    sqlite(
      stateDb,
      [
        "update threads",
        `set rollout_path = ${sqlString(repair.to)}`,
        `where id = ${sqlString(repair.id)} and rollout_path = ${sqlString(repair.from)};`,
      ].join(" "),
    );
  }
  sqlite(
    stateDb,
    [
      "update threads",
      `set model_provider = ${sqlString(provider)}`,
      `where coalesce(model_provider, '') != ${sqlString(provider)};`,
    ].join(" "),
  );
  if (shouldMigrateModel && modelChanged) {
    sqlite(
      stateDb,
      [
        "update threads",
        `set model = ${sqlString(toModel)}`,
        `where coalesce(model, '') != ${sqlString(toModel)}`,
        "and coalesce(model, '') != ''",
      ].join(" "),
    );
  }
  return { changed, modelChanged, backupPath, rolloutChanged, repairedRolloutPaths: repairs.length };
}

function threadModelCommand(args) {
  if (!args.model) throw new Error("--model is required.");

  const codexHome = expandHome(args.codexHome || "~/.codex");
  const stateDb = expandHome(args.stateDb || path.join(codexHome, "state_5.sqlite"));
  if (!fs.existsSync(stateDb)) throw new Error(`Codex state database not found: ${stateDb}`);

  const provider = args.provider || currentDefaultProfile(codexHome) || "vayne";
  validateName(provider);
  const threadId = args.thread || latestThreadId(stateDb);
  if (!threadId) throw new Error("No non-archived Codex thread found.");

  const exists = sqlite(stateDb, `select count(*) from threads where id = ${sqlString(threadId)};`);
  if (exists !== "1") throw new Error(`Thread not found: ${threadId}`);

  const backupPath = backupStateDb(stateDb);
  sqlite(
    stateDb,
    [
      "update threads",
      `set model = ${sqlString(args.model)},`,
      `model_provider = ${sqlString(provider)},`,
      "updated_at_ms = cast(strftime('%s','now') as integer) * 1000",
      `where id = ${sqlString(threadId)};`,
    ].join(" "),
  );

  console.log(`Updated thread model: ${threadId}`);
  console.log(`Model: ${args.model}`);
  console.log(`Provider: ${provider}`);
  console.log(`Backup: ${backupPath}`);
}

function setDefaultProfile(name, codexHome) {
  validateName(name);
  const configPath = path.join(codexHome, "config.toml");
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  let config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const line = `profile = ${tomlString(name)}`;

  if (/^profile\s*=.*$/m.test(config)) {
    config = config.replace(/^profile\s*=.*$/m, line);
  } else {
    config = `${line}\n${config.trimStart()}`;
  }

  fs.writeFileSync(configPath, config, { mode: 0o600 });
}

function clearDefaultProfile(codexHome) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return;
  const config = fs
    .readFileSync(configPath, "utf8")
    .replace(/^profile\s*=.*\n?/m, "")
    .replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(configPath, config, { mode: 0o600 });
}

function restartCodexApp() {
  if (process.platform !== "darwin") {
    throw new Error("Automatic Codex app restart is only supported on macOS.");
  }
  execFileSync("osascript", ["-e", 'tell application "Codex" to quit']);
  execFileSync("open", ["-a", "Codex"]);
}

function currentDefaultProfile(codexHome) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return "";
  return tomlValue(fs.readFileSync(configPath, "utf8"), "profile");
}

function tomlValue(block, key) {
  const match = block.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(.+)$`, "m"));
  if (!match) return "";
  const value = match[1].trim();
  try {
    return JSON.parse(value);
  } catch {
    return value.replace(/^"|"$/g, "");
  }
}

function tomlArrayFirst(block, key) {
  const value = tomlValue(block, key);
  if (Array.isArray(value)) return value[0] || "";
  return "";
}

function managedProfilePattern() {
  return new RegExp(
    `${escapeRegExp(START)}:([A-Za-z0-9_-]+)\\n([\\s\\S]*?)${escapeRegExp(END)}:\\1`,
    "g",
  );
}

function profileFromManagedBlock(name, block, defaultProfile = "") {
  return {
    name,
    model: tomlValue(block, "model"),
    baseUrl: tomlValue(block, "base_url"),
    keyEnv: tomlValue(block, "env_key"),
    keyFile: tomlArrayFirst(block, "auth.args"),
    catalogFile: tomlValue(block, "model_catalog_json"),
    reasoningEffort: tomlValue(block, "model_reasoning_effort"),
    isDefault: name === defaultProfile,
    command: `codex --profile ${name}`,
  };
}

function getManagedProfile(codexHome, name) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return null;

  const config = fs.readFileSync(configPath, "utf8");
  for (const match of config.matchAll(managedProfilePattern())) {
    if (match[1] === name) return profileFromManagedBlock(match[1], match[2], currentDefaultProfile(codexHome));
  }
  return null;
}

function listProfiles(codexHome) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return [];

  const config = fs.readFileSync(configPath, "utf8");
  const profiles = [];
  const defaultProfile = currentDefaultProfile(codexHome);
  for (const match of config.matchAll(managedProfilePattern())) {
    profiles.push(profileFromManagedBlock(match[1], match[2], defaultProfile));
  }
  return profiles;
}

function switchTargets(codexHome) {
  const defaultProfile = currentDefaultProfile(codexHome);
  return {
    current: defaultProfile || "account",
    account: {
      name: "account",
      label: "ChatGPT account",
      model: "Codex default",
      baseUrl: "OpenAI account login",
      isDefault: !defaultProfile,
      command: "codex",
      type: "account",
    },
    profiles: listProfiles(codexHome).map((profile) => ({ ...profile, type: "relay", label: profile.name })),
  };
}

function modelsUrl(baseUrl) {
  const url = new URL(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/models")) pathname = `${pathname}/models`;
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function modelIdsFromResponse(payload) {
  const list = Array.isArray(payload) ? payload : payload.data;
  if (!Array.isArray(list)) {
    throw new Error("Model list response must be an array or an object with a data array.");
  }
  return list
    .map((item) => (typeof item === "string" ? item : item && item.id))
    .filter((id) => typeof id === "string" && id.trim())
    .sort((a, b) => a.localeCompare(b));
}

function parseErrorMessage(text) {
  try {
    const payload = JSON.parse(text);
    const error = payload && payload.error;
    if (error && typeof error.message === "string") return error.message;
    if (typeof payload.message === "string") return payload.message;
  } catch (_) {
    // Some relays return plain text or HTML for errors.
  }
  return text.trim().replace(/\s+/g, " ").slice(0, 240);
}

function modelListHttpError(status, text) {
  const detail = parseErrorMessage(text);
  const suffix = detail ? ` Relay said: ${detail}` : "";
  if (status === 401) {
    return `Model list request failed with HTTP 401: API key is invalid, expired, or not authorized for this relay.${suffix}`;
  }
  if (status === 403) {
    return `Model list request failed with HTTP 403: this API key does not have permission to list models, or the relay blocked the request.${suffix}`;
  }
  if (status === 404) {
    return `Model list request failed with HTTP 404: the relay does not expose a /models endpoint at this base URL.${suffix}`;
  }
  if (status === 429) {
    return `Model list request failed with HTTP 429: the relay is rate limited or the account quota is exhausted.${suffix}`;
  }
  return `Model list request failed with HTTP ${status}.${suffix}`;
}

async function fetchModels(baseUrl, apiKey) {
  if (!baseUrl) throw new Error("Base URL is required.");
  if (!apiKey) throw new Error("API key is required to fetch models.");

  const response = await fetch(modelsUrl(baseUrl), {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(modelListHttpError(response.status, text));
  }
  return modelIdsFromResponse(JSON.parse(text));
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON request body."));
      }
    });
    req.on("error", reject);
  });
}

function htmlPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Switch</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #171a1f;
      --muted: #5b6575;
      --line: #d9dee7;
      --accent: #0f766e;
      --accent-strong: #0b5f59;
      --danger: #b42318;
      --code: #eef2f6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(860px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0;
    }
    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
    }
    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.1;
      letter-spacing: 0;
    }
    .subtitle {
      margin: 8px 0 0;
      color: var(--muted);
      max-width: 720px;
    }
    .top-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .language-toggle {
      display: inline-flex;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--panel);
      overflow: hidden;
    }
    .language-toggle button {
      min-height: 38px;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--muted);
      padding: 7px 10px;
    }
    .language-toggle button.active {
      background: var(--accent);
      color: #fff;
    }
    .layout {
      display: block;
    }
    section {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 18px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-weight: 600;
    }
    input, select {
      width: 100%;
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 8px 10px;
      color: var(--text);
      background: #fff;
      font: inherit;
    }
    input:focus, select:focus {
      outline: 2px solid rgba(15, 118, 110, 0.22);
      border-color: var(--accent);
    }
    .full { grid-column: 1 / -1; }
    .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 16px;
    }
    button {
      min-height: 40px;
      border: 1px solid transparent;
      border-radius: 7px;
      padding: 8px 12px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      background: var(--accent);
      color: #fff;
    }
    button:hover { background: var(--accent-strong); }
    button.secondary {
      background: #fff;
      color: var(--text);
      border-color: var(--line);
    }
    button.secondary:hover { background: #f3f5f8; }
    button.danger {
      background: #fff;
      color: var(--danger);
      border-color: #f0b8b2;
    }
    button.danger:hover { background: #fff5f3; }
    h2 {
      margin: 0 0 12px;
      font-size: 15px;
      letter-spacing: 0;
    }
    .hint {
      margin: 12px 0 0;
      color: var(--muted);
    }
    .option-row {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-top: 12px;
      color: var(--text);
      font-weight: 600;
    }
    .option-row input {
      width: 16px;
      min-height: 16px;
      height: 16px;
      margin: 0;
      accent-color: var(--accent);
    }
    .option-hint {
      margin: 6px 0 0 25px;
      color: var(--muted);
      font-size: 12px;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .section-header h2 {
      margin: 0;
    }
    .config-panel {
      display: none;
      margin-top: 14px;
    }
    .config-panel.open {
      display: block;
    }
    .profiles {
      display: grid;
      gap: 10px;
      margin-top: 10px;
    }
    .target-groups {
      display: grid;
      gap: 18px;
      margin-top: 18px;
    }
    .target-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 8px;
    }
    .target-title h3 {
      margin: 0;
      font-size: 14px;
      letter-spacing: 0;
    }
    .target-title p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      text-align: right;
    }
    .empty-state {
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 12px;
      color: var(--muted);
      background: #fbfcfd;
    }
    .promo {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      margin-top: 18px;
      border: 1px solid #b8e3dc;
      border-radius: 8px;
      padding: 12px;
      background: #f2fbf9;
    }
    .promo-title {
      margin: 0 0 3px;
      font-weight: 800;
    }
    .promo-copy {
      margin: 0;
      color: var(--muted);
    }
    .promo-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      border-radius: 7px;
      padding: 7px 12px;
      background: var(--accent);
      color: #fff;
      font-weight: 800;
      text-decoration: none;
      white-space: nowrap;
    }
    .promo-link:hover {
      background: var(--accent-strong);
    }
    .profile-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfcfd;
    }
    .profile-name {
      font-weight: 800;
      margin-bottom: 3px;
    }
    .badge {
      display: inline-block;
      margin-left: 6px;
      border: 1px solid #b8e3dc;
      border-radius: 999px;
      padding: 1px 7px;
      color: #0b5f59;
      background: #eef8f6;
      font-size: 12px;
      font-weight: 700;
    }
    .profile-meta {
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .profile-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .profile-actions button {
      min-height: 34px;
      padding: 6px 9px;
    }
    .field-with-button {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: end;
    }
    .field-with-button button {
      min-height: 40px;
      white-space: nowrap;
    }
    .model-picker {
      display: grid;
      gap: 10px;
      grid-column: 1 / -1;
      position: relative;
    }
    .model-switcher {
      display: flex;
      gap: 8px;
      align-items: end;
    }
    .model-switcher label {
      flex: 1;
    }
    .model-menu-button {
      min-width: 150px;
      max-width: 220px;
      border-color: var(--line);
      background: #fff;
      color: var(--text);
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      overflow: hidden;
    }
    .model-menu-button:hover { background: #f3f5f8; }
    .model-menu-button span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .model-list {
      display: none;
      position: absolute;
      z-index: 10;
      top: calc(100% + 6px);
      right: 0;
      width: min(360px, 100%);
      max-height: 188px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      box-shadow: 0 12px 28px rgba(23, 26, 31, 0.14);
    }
    .model-list.visible {
      display: grid;
    }
    .model-option {
      width: 100%;
      min-height: 36px;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      padding: 7px 10px;
      color: var(--text);
      background: #fff;
      font-weight: 600;
      text-align: left;
      overflow-wrap: anywhere;
    }
    .model-option:last-child {
      border-bottom: 0;
    }
    .model-option:hover,
    .model-option.selected {
      background: #eef8f6;
      color: #0b5f59;
    }
    .model-empty {
      padding: 10px;
      color: var(--muted);
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
    }
    .message {
      margin-top: 14px;
      padding: 10px 12px;
      border-radius: 7px;
      background: #eef8f6;
      color: #0b5f59;
      border: 1px solid #b8e3dc;
      display: none;
    }
    .message.error {
      background: #fff5f3;
      color: var(--danger);
      border-color: #f0b8b2;
    }
    @media (max-width: 760px) {
      header { align-items: stretch; flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
      main { width: min(100vw - 20px, 1040px); padding: 18px 0; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Codex Switch</h1>
        <p class="subtitle" data-i18n="subtitle">Configure Codex to use a Responses-compatible relay API without putting API keys in config.toml.</p>
      </div>
      <div class="top-actions">
        <div class="language-toggle" aria-label="Language">
          <button type="button" id="lang-zh">中文</button>
          <button type="button" id="lang-en">English</button>
        </div>
      </div>
    </header>

    <div class="layout">
      <section>
        <div class="section-header">
          <h2 data-i18n="profilesTitle">Profiles</h2>
          <button type="button" id="toggle-config" data-i18n="addProfile">Add Profile</button>
        </div>
        <div class="config-panel" id="config-panel">
          <form id="profile-form">
            <div class="grid">
              <label><span data-i18n="nameLabel">Name</span>
                <input id="name" name="name" value="" autocomplete="off" data-i18n-placeholder="namePlaceholder" required>
              </label>
              <label class="full"><span data-i18n="baseUrlLabel">Relay base URL</span>
                <input id="baseUrl" name="baseUrl" value="" autocomplete="off" data-i18n-placeholder="baseUrlPlaceholder" required>
              </label>
              <label class="full"><span data-i18n="apiKeyLabel">API key</span>
                <input id="apiKey" name="apiKey" type="password" autocomplete="off" placeholder="sk-...">
              </label>
              <div class="model-picker">
                <div class="model-switcher">
                  <label><span data-i18n="modelLabel">Model</span>
                    <input id="model" name="model" value="" autocomplete="off" placeholder="Load models or type one manually" data-i18n-placeholder="modelPlaceholder" required>
                  </label>
                  <button type="button" class="model-menu-button" id="model-menu-button" aria-expanded="false">
                    <span id="model-menu-label"></span>
                    <span>▾</span>
                  </button>
                </div>
                <div class="model-list" id="model-list" aria-label="Loaded models"></div>
              </div>
            </div>
            <div class="row">
              <button type="button" class="secondary" id="load-models" data-i18n="loadModels">Load Models</button>
              <button type="button" class="secondary" id="test" data-i18n="testAccess">Test Access</button>
              <button type="submit" data-i18n="save">Save</button>
              <button type="button" class="danger" id="remove" data-i18n="remove">Remove</button>
            </div>
            <p class="hint" data-i18n="hint">Edit a saved relay from the list, change fields, then Save. Leave API key blank to keep the saved local key.</p>
            <div class="message" id="message"></div>
          </form>
        </div>
        <div class="promo">
          <div>
            <p class="promo-title" data-i18n="promoTitle">Recommended relay: Vayne API</p>
            <p class="promo-copy" data-i18n="promoCopy">A relay option for using compatible API models with Codex Switch.</p>
          </div>
          <a class="promo-link" href="https://vayne.cc.cd/" target="_blank" rel="noopener noreferrer" data-i18n="promoAction">View</a>
        </div>
        <label class="option-row"><input id="restartCodex" name="restartCodex" type="checkbox"><span data-i18n="restartCodex">Restart Codex after switching</span></label>
        <p class="option-hint" data-i18n="restartCodexHint">Chat history is migrated automatically. Check this to also restart Codex.</p>
        <div class="target-groups">
          <div class="target-group">
            <div class="target-title">
              <h3 data-i18n="accountTitle">Codex account</h3>
              <p data-i18n="accountHint">Use the original logged-in Codex.</p>
            </div>
            <div class="profiles" id="account-target"></div>
          </div>
          <div class="target-group">
            <div class="target-title">
              <h3 data-i18n="relaysTitle">My relays</h3>
              <p data-i18n="relaysHint">Saved relay bases appear here.</p>
            </div>
            <div class="profiles" id="profiles"></div>
          </div>
        </div>
      </section>

    </div>
  </main>

  <script>
    const form = document.querySelector("#profile-form");
    const message = document.querySelector("#message");
    const nameInput = document.querySelector("#name");
    const accountEl = document.querySelector("#account-target");
    const profilesEl = document.querySelector("#profiles");
    const modelInput = document.querySelector("#model");
    const modelList = document.querySelector("#model-list");
    const modelMenuButton = document.querySelector("#model-menu-button");
    const modelMenuLabel = document.querySelector("#model-menu-label");
    const configPanel = document.querySelector("#config-panel");
    const toggleConfig = document.querySelector("#toggle-config");
    let loadedModels = [];
    let lang = localStorage.getItem("codex-switch-lang") || ((navigator.language || "").startsWith("zh") ? "zh" : "en");

    const i18n = {
      en: {
        subtitle: "Configure Codex to use a Responses-compatible relay API without putting API keys in config.toml.",
        profilesTitle: "Profiles",
        addProfile: "Add Profile",
        hideConfig: "Hide",
        accountTitle: "Codex account",
        accountHint: "Use the original logged-in Codex.",
        relaysTitle: "My relays",
        relaysHint: "Saved relay bases appear here.",
        emptyRelays: "No relays yet. Click Add Profile to create one.",
        promoTitle: "Recommended relay: Vayne API",
        promoCopy: "A relay option for using compatible API models with Codex Switch.",
        promoAction: "View",
        profileTitle: "Profile",
        nameLabel: "Name",
        namePlaceholder: "e.g. vayne",
        baseUrlLabel: "Relay base URL",
        baseUrlPlaceholder: "https://api.vayne.cc.cd/v1",
        apiKeyLabel: "API key",
        modelLabel: "Model",
        modelPlaceholder: "Load models or type one manually",
        selectModel: "Select model",
        loadModels: "Load Models",
        testAccess: "Test Access",
        save: "Save",
        remove: "Remove",
        hint: "Edit a saved relay from the list, change fields, then Save. Leave API key blank to keep the saved local key.",
        restartCodex: "Restart Codex after switching",
        restartCodexHint: "Chat history is migrated automatically. Check this to also restart Codex. Account-linked repo rollback may still require account login.",
        current: "current",
        edit: "Edit",
        useAccount: "Use Account",
        useRelay: "Use Relay",
        test: "Test",
        noModels: "Load models first, or type a model manually.",
        editing: "Editing '{name}'. Save will update this relay profile.",
        switching: "Switching...",
        switched: "Switched",
        saving: "Saving...",
        saved: "Saved",
        removing: "Removing...",
        removed: "Removed",
        loadingModels: "Loading models...",
        loadedModels: "Loaded {count} models.",
        modelsLoaded: "Models loaded",
        testing: "Testing with Codex...",
        tested: "Tested",
        error: "Error",
      },
      zh: {
        subtitle: "配置 Codex 使用兼容 Responses API 的中转站，API 密钥不会写入 config.toml。",
        profilesTitle: "配置列表",
        addProfile: "新增配置",
        hideConfig: "收起",
        accountTitle: "Codex 账号登录",
        accountHint: "切回最开始的账号登录。",
        relaysTitle: "我的中转站",
        relaysHint: "保存后的中转 Base 都在这里。",
        emptyRelays: "还没有中转站，点“新增配置”添加一个。",
        promoTitle: "推荐中转站：Vayne API",
        promoCopy: "适合配合 Codex Switch 使用的兼容 API 中转站。",
        promoAction: "查看",
        profileTitle: "配置",
        nameLabel: "名称",
        namePlaceholder: "例如 vayne",
        baseUrlLabel: "中转 Base URL",
        baseUrlPlaceholder: "https://api.vayne.cc.cd/v1",
        apiKeyLabel: "API 密钥",
        modelLabel: "模型",
        modelPlaceholder: "读取模型或手动输入",
        selectModel: "选择模型",
        loadModels: "读取模型",
        testAccess: "检测接入",
        save: "保存",
        remove: "删除",
        hint: "从列表点编辑后修改并保存。API 密钥留空会继续使用已保存的本地密钥。",
        restartCodex: "切换后重启 Codex",
        restartCodexHint: "聊天历史会自动迁移。勾选后会额外重启 Codex。账号绑定代码库的回退功能可能仍需账号登录。",
        current: "当前",
        edit: "编辑",
        useAccount: "使用账号",
        useRelay: "使用中转",
        test: "检测",
        noModels: "请先读取模型，或手动输入模型。",
        editing: "正在编辑「{name}」，保存后会更新这个中转配置。",
        switching: "正在切换...",
        switched: "已切换",
        saving: "正在保存...",
        saved: "已保存",
        removing: "正在删除...",
        removed: "已删除",
        loadingModels: "正在读取模型...",
        loadedModels: "已读取 {count} 个模型。",
        modelsLoaded: "模型已读取",
        testing: "正在检测 Codex...",
        tested: "已检测",
        error: "错误",
      },
    };

    function t(key, params = {}) {
      let value = (i18n[lang] && i18n[lang][key]) || i18n.en[key] || key;
      for (const [name, replacement] of Object.entries(params)) {
        value = value.replaceAll("{" + name + "}", replacement);
      }
      return value;
    }

    function applyLanguage() {
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
      document.querySelectorAll("[data-i18n]").forEach((node) => {
        node.textContent = t(node.dataset.i18n);
      });
      document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
        node.placeholder = t(node.dataset.i18nPlaceholder);
      });
      document.querySelector("#lang-zh").classList.toggle("active", lang === "zh");
      document.querySelector("#lang-en").classList.toggle("active", lang === "en");
      updateModelLabel();
      updateConfigToggle();
      loadProfiles();
    }

    function values() {
      const data = Object.fromEntries(new FormData(form).entries());
      data.useEnv = false;
      data.restartCodex = document.querySelector("#restartCodex").checked;
      return data;
    }

    function setMessage(text, isError = false) {
      message.textContent = text;
      message.className = isError ? "message error" : "message";
      message.style.display = "block";
    }

    function updateCommand() {
      return nameInput.value || "profile";
    }

    function updateModelLabel() {
      modelMenuLabel.textContent = modelInput.value || t("selectModel");
    }

    function updateConfigToggle() {
      toggleConfig.textContent = configPanel.classList.contains("open") ? t("hideConfig") : t("addProfile");
    }

    function setConfigOpen(open) {
      configPanel.classList.toggle("open", open);
      toggleConfig.setAttribute("aria-expanded", String(open));
      updateConfigToggle();
    }

    async function post(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Request failed.");
      return payload;
    }

    function escapeHtml(value) {
      return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function loadProfile(profile) {
      setConfigOpen(true);
      document.querySelector("#name").value = profile.name;
      modelInput.value = profile.model || "";
      document.querySelector("#baseUrl").value = profile.baseUrl || "";
      document.querySelector("#apiKey").value = "";
      renderModels([]);
      updateModelLabel();
      updateCommand();
      setMessage(t("editing", { name: profile.name }));
    }

    function renderModels(models) {
      loadedModels = models;
      if (!models.length) {
        modelList.innerHTML = '<div class="model-empty">' + escapeHtml(t("noModels")) + '</div>';
        modelList.classList.remove("visible");
        modelMenuButton.setAttribute("aria-expanded", "false");
        updateModelLabel();
        return;
      }

      modelList.innerHTML = models.map((model) => {
        const selected = model === modelInput.value ? " selected" : "";
        return '<button type="button" class="model-option' + selected + '" data-model="' + escapeHtml(model) + '">' +
          escapeHtml(model) +
        '</button>';
      }).join("");
      modelList.classList.add("visible");
      modelList.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", () => {
          modelInput.value = button.dataset.model;
          modelList.querySelectorAll("button").forEach((entry) => {
            entry.classList.toggle("selected", entry === button);
          });
          modelList.classList.remove("visible");
          modelMenuButton.setAttribute("aria-expanded", "false");
          updateModelLabel();
          updateCommand();
        });
      });
      updateModelLabel();
    }

    function profileHtml(profile) {
        const isAccount = profile.type === "account";
        return '<div class="profile-item" data-name="' + escapeHtml(profile.name) + '">' +
          '<div>' +
            '<div class="profile-name">' + escapeHtml(profile.label || profile.name) + (profile.isDefault ? '<span class="badge">' + escapeHtml(t("current")) + '</span>' : '') + '</div>' +
            '<div class="profile-meta">' + escapeHtml(profile.model) + ' · ' + escapeHtml(profile.baseUrl) + '</div>' +
            '<div class="profile-meta"><code>' + escapeHtml(profile.command) + '</code></div>' +
          '</div>' +
          '<div class="profile-actions">' +
            (isAccount ? '' : '<button class="secondary" data-action="load">' + escapeHtml(t("edit")) + '</button>') +
            '<button class="secondary" data-action="' + (isAccount ? 'account' : 'default') + '">' + escapeHtml(isAccount ? t("useAccount") : t("useRelay")) + '</button>' +
            (isAccount ? '' : '<button class="secondary" data-action="test">' + escapeHtml(t("test")) + '</button>') +
            (isAccount ? '' : '<button class="danger" data-action="remove">' + escapeHtml(t("remove")) + '</button>') +
          '</div>' +
        '</div>';
    }

    function bindProfileActions(container, profiles) {
      container.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", async () => {
          const item = button.closest(".profile-item");
          const profile = profiles.find((entry) => entry.name === item.dataset.name);
          if (button.dataset.action === "load") {
            loadProfile(profile);
            return;
          }
          if (button.dataset.action === "test") {
            setMessage(t("testing"));
            try {
              const payload = await post("/api/test", { name: profile.name });
              setMessage(payload.message);
            } catch (error) {
              setMessage(error.message, true);
            }
          }
          if (button.dataset.action === "default" || button.dataset.action === "account") {
            setMessage(t("switching"));
            try {
              const payload = await post(button.dataset.action === "account" ? "/api/account" : "/api/default", {
                name: profile.name,
                restartCodex: document.querySelector("#restartCodex").checked,
              });
              setMessage(payload.message);
              await loadProfiles();
            } catch (error) {
              setMessage(error.message, true);
            }
          }
          if (button.dataset.action === "remove") {
            setMessage(t("removing"));
            try {
              const payload = await post("/api/remove", { name: profile.name });
              setMessage(payload.message);
              await loadProfiles();
            } catch (error) {
              setMessage(error.message, true);
            }
          }
        });
      });
    }

    async function loadProfiles() {
      const response = await fetch("/api/targets");
      const payload = await response.json();
      const relayProfiles = payload.profiles || [];
      const profiles = [payload.account].concat(relayProfiles);

      accountEl.innerHTML = profileHtml(payload.account);
      profilesEl.innerHTML = relayProfiles.length
        ? relayProfiles.map(profileHtml).join("")
        : '<div class="empty-state">' + escapeHtml(t("emptyRelays")) + '</div>';

      bindProfileActions(accountEl, profiles);
      bindProfileActions(profilesEl, profiles);
    }

    nameInput.addEventListener("input", updateCommand);
    toggleConfig.addEventListener("click", () => {
      const nextOpen = !configPanel.classList.contains("open");
      setConfigOpen(nextOpen);
      if (nextOpen) {
        nameInput.focus();
      }
    });
    modelInput.addEventListener("input", () => {
      updateModelLabel();
      if (loadedModels.length) renderModels(loadedModels);
    });
    modelMenuButton.addEventListener("click", () => {
      if (!loadedModels.length) {
        modelList.innerHTML = '<div class="model-empty">' + escapeHtml(t("noModels")) + '</div>';
      }
      const nextVisible = !modelList.classList.contains("visible");
      modelList.classList.toggle("visible", nextVisible);
      modelMenuButton.setAttribute("aria-expanded", String(nextVisible));
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".model-picker")) {
        modelList.classList.remove("visible");
        modelMenuButton.setAttribute("aria-expanded", "false");
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setMessage(t("saving"));
      try {
        const payload = await post("/api/setup", values());
        setMessage(payload.message);
        updateCommand();
        await loadProfiles();
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    document.querySelector("#remove").addEventListener("click", async () => {
      setMessage(t("removing"));
      try {
        const payload = await post("/api/remove", values());
        setMessage(payload.message);
        await loadProfiles();
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    document.querySelector("#load-models").addEventListener("click", async () => {
      setMessage(t("loadingModels"));
      try {
        const payload = await post("/api/models", values());
        if (payload.models.length && !payload.models.includes(modelInput.value)) {
          modelInput.value = payload.models[0];
        }
        renderModels(payload.models);
        setMessage(t("loadedModels", { count: String(payload.models.length) }));
        updateCommand();
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    document.querySelector("#test").addEventListener("click", async () => {
      setMessage(t("testing"));
      try {
        const payload = await post("/api/test", values());
        setMessage(payload.message);
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    document.querySelector("#lang-zh").addEventListener("click", () => {
      lang = "zh";
      localStorage.setItem("codex-switch-lang", lang);
      applyLanguage();
    });
    document.querySelector("#lang-en").addEventListener("click", () => {
      lang = "en";
      localStorage.setItem("codex-switch-lang", lang);
      applyLanguage();
    });

    updateCommand();
    applyLanguage();
    loadProfiles().catch((error) => {
      profilesEl.innerHTML = '<div class="hint">' + error.message + '</div>';
    });
  </script>
</body>
</html>`;
}

function runCodexTest(name) {
  return new Promise((resolve, reject) => {
    execFile("codex", ["exec", "--profile", name, "Reply with exactly: ok"], { timeout: 60000 }, (error, stdout, stderr) => {
      const output = `${stdout || ""}${stderr || ""}`.trim();
      if (error) {
        reject(new Error(output || error.message));
        return;
      }
      resolve(output);
    });
  });
}

function normalizeWebPayload(body) {
  const name = String(body.name || "").trim();
  return {
    name,
    baseUrl: String(body.baseUrl || "").trim(),
    model: String(body.model || "").trim(),
    keyEnv: body.useEnv ? String(body.keyEnv || "").trim() : undefined,
    secret: body.useEnv ? undefined : String(body.apiKey || "").trim(),
    restartCodex: Boolean(body.restartCodex),
  };
}

function apiKeyForPayload(payload, codexHome) {
  if (payload.keyEnv) {
    const value = process.env[payload.keyEnv];
    if (!value) throw new Error(`Environment variable ${payload.keyEnv} is not set.`);
    return value;
  }
  if (payload.secret) return payload.secret;
  if (payload.name) {
    const keyFile = path.join(codexHome, `${payload.name}_api_key`);
    if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, "utf8").trim();
  }
  throw new Error("API key is required to fetch models.");
}

function startWeb(args) {
  const host = args.host || "127.0.0.1";
  const port = Number(args.port || 8787);
  const codexHome = expandHome(args.codexHome || "~/.codex");

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}:${port}`);
      if (req.method === "GET" && url.pathname === "/") {
        const body = htmlPage();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/profiles") {
        sendJson(res, 200, { profiles: listProfiles(codexHome) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/targets") {
        sendJson(res, 200, switchTargets(codexHome));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/setup") {
        const payload = normalizeWebPayload(await readJson(req));
        writeProfile({ ...payload, codexHome }, payload.secret);
        sendJson(res, 200, {
          message: `Saved profile '${payload.name}'.`,
          details: [`Config: ${path.join(codexHome, "config.toml")}`, `Run: codex --profile ${payload.name}`],
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/remove") {
        const payload = normalizeWebPayload(await readJson(req));
        remove({ name: payload.name, codexHome });
        sendJson(res, 200, {
          message: `Removed profile '${payload.name}'.`,
          details: [`Config: ${path.join(codexHome, "config.toml")}`],
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/default") {
        const payload = normalizeWebPayload(await readJson(req));
        const profile = getManagedProfile(codexHome, payload.name);
        if (!profile) {
          throw new Error(`Managed profile not found: ${payload.name}`);
        }
        setDefaultProfile(payload.name, codexHome);
        const migration = migrateThreads(codexHome, providerId(payload.name), {
          toModel: profile.model,
        });
        if (payload.restartCodex) restartCodexApp();
        sendJson(res, 200, {
          message: payload.restartCodex
            ? `Switched Codex to relay profile '${payload.name}' and restarted the app.`
            : `Switched Codex to relay profile '${payload.name}'.`,
          details: [
            `Config: ${path.join(codexHome, "config.toml")}`,
            migration
              ? `Moved ${migration.changed} thread(s), updated ${migration.modelChanged} thread model(s) to '${profile.model}', updated ${migration.rolloutChanged} rollout file(s), and repaired ${migration.repairedRolloutPaths} rollout path(s) to provider '${providerId(payload.name)}'. Backup: ${migration.backupPath}`
              : "Threads already use this provider.",
            "Run: codex",
          ],
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/account") {
        const payload = normalizeWebPayload(await readJson(req));
        clearDefaultProfile(codexHome);
        const migration = migrateThreads(codexHome, "openai");
        if (payload.restartCodex) restartCodexApp();
        sendJson(res, 200, {
          message: payload.restartCodex
            ? "Switched Codex to ChatGPT account login and restarted the app."
            : "Switched Codex to ChatGPT account login.",
          details: [
            `Config: ${path.join(codexHome, "config.toml")}`,
            migration
              ? `Moved ${migration.changed} thread(s), updated ${migration.rolloutChanged} rollout file(s), and repaired ${migration.repairedRolloutPaths} rollout path(s) to provider 'openai'. Backup: ${migration.backupPath}`
              : "Threads already use the account provider.",
            "Run: codex",
          ],
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/models") {
        const payload = normalizeWebPayload(await readJson(req));
        const models = await fetchModels(payload.baseUrl, apiKeyForPayload(payload, codexHome));
        writeModelCatalog(codexHome, payload.name, models);
        sendJson(res, 200, { models });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/test") {
        const payload = normalizeWebPayload(await readJson(req));
        const output = await runCodexTest(payload.name);
        sendJson(res, 200, {
          message: `Codex test completed for '${payload.name}'.`,
          output,
        });
        return;
      }

      sendJson(res, 404, { error: "Not found." });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
  });

  server.listen(port, host, () => {
    const address = server.address();
    const url = `http://${host}:${address.port}`;
    console.log(`Codex Switch web UI: ${url}`);
    if (!args.noOpen) {
      openBrowser(url);
    }
  });
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = execFile(command, args, { stdio: "ignore" }, () => {});
  child.unref();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === "help" || args.command === "--help") {
    console.log(usage());
    return;
  }

  if (args.command === "setup") {
    await setup(args);
    return;
  }

  if (args.command === "remove") {
    remove(args);
    return;
  }

  if (args.command === "list") {
    listCommand(args);
    return;
  }

  if (args.command === "default") {
    defaultCommand(args);
    return;
  }

  if (args.command === "account") {
    accountCommand(args);
    return;
  }

  if (args.command === "model") {
    modelCommand(args);
    return;
  }

  if (args.command === "thread-model") {
    threadModelCommand(args);
    return;
  }

  if (args.command === "web") {
    startWeb(args);
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  console.error("");
  console.error(usage());
  process.exit(1);
});
