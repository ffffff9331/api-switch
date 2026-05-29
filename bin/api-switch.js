#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { execFile, execFileSync } = require("node:child_process");
const { createProxyHandler, startProxyServer } = require("../lib/proxy/server");
const { capabilitiesForModel } = require("../lib/proxy/provider-registry");

const START = "# >>> api-switch";
const END = "# <<< api-switch";
const LEGACY_START = "# >>> codex-switch";
const LEGACY_END = "# <<< codex-switch";
const DATA_DIR = "api-switch";
const LEGACY_DATA_DIR = "codex-switch";
const DEFAULT_PORT = 18600;
const PROXY_API_KEY = "api-switch";

function usage() {
  return `
api-switch

Configure Codex Desktop and Claude Code to use a local proxy backed by relay profiles.

Usage:
  api-switch setup --name <profile> --base-url <url> --model <model>
  api-switch setup --name my-relay --base-url https://api.example.com/v1 --model gpt-5.5
  api-switch setup --name xiaomi --type official_subscription --base-url https://token-plan-sgp.xiaomimimo.com/v1 --anthropic-base-url https://token-plan-sgp.xiaomimimo.com/anthropic --model mimo-v2.5-pro
  api-switch model --name <profile> --model <model>
  api-switch thread-model --model <model> [--provider <provider>] [--thread <id>]
  api-switch repair-encrypted-content [--thread <id>]
  api-switch route --client <client> --model <model> --profile <profile> [--upstream-model <model>]
  api-switch route-remove --client <client> --model <model>
  api-switch routes
  api-switch list
  api-switch default --name <profile>   Use a relay profile for Codex through the local proxy
  api-switch account
  api-switch claude-proxy --name <profile>
  api-switch claude-account
  api-switch service-install
  api-switch service-uninstall
  api-switch service-status
  api-switch web
  api-switch proxy
  api-switch remove --name <profile>

Options:
  --codex-home <dir>       Defaults to ~/.codex
  --key-file <path>        Defaults to ~/.codex/<profile>_api_key
  --key-env <env-name>     Use an environment variable instead of a local key file
  --reasoning-effort <val> Defaults to medium
  --fallback-profiles <a,b> Optional backup profiles for transient 5xx failures
  --state-db <path>        Defaults to ~/.codex/state_5.sqlite
  --thread <id>            Thread id for thread-model or repair-encrypted-content; defaults to latest thread
  --provider <provider>    Provider for thread-model; defaults to openai
  --type <type>            Profile type: relay or official_subscription
  --profile-type <type>    Alias for --type
  --anthropic-base-url <url> Optional Anthropic-compatible base URL for Claude Code
  --codex-upstream-protocol <protocol> responses, chat-completions, or completions
  --claude-upstream-protocol <protocol> anthropic-messages or chat-completions
  --client <client>        Client id for routes, default codex
  --upstream-model <model> Model sent to the upstream relay for a mapped route
  --delete-key             Delete the local key file when removing a profile
  --host <host>            Web server host, default 127.0.0.1
  --port <port>            Web server port, default 18600
  --no-open                Do not open the web UI in a browser
  --no-migrate-history     Do not rewrite local Codex thread metadata
  --restart-codex          Restart the macOS Codex app after switching
  --force                  Overwrite an existing key file without prompting

Security:
  API keys are not written to Codex API settings. Relay profiles read a local
  chmod 600 key file, and proxy mode writes Codex's API key as '${PROXY_API_KEY}'.
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

function validateClientId(client) {
  if (!/^[A-Za-z0-9_-]+$/.test(client || "")) {
    throw new Error("Client id may only contain letters, numbers, underscores, and hyphens.");
  }
}

function validateChoice(label, value, allowed) {
  if (!value) return;
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  }
}

function validateProfileOptions(args) {
  validateChoice("Profile type", args.profileType || args.type || "relay", ["relay", "official_subscription"]);
  validateChoice("Codex upstream protocol", args.codexUpstreamProtocol || args.upstreamProtocol || "", ["responses", "chat-completions", "completions"]);
  validateChoice("Claude upstream protocol", args.claudeUpstreamProtocol || "", ["anthropic-messages", "chat-completions"]);
}

function tomlString(value) {
  return JSON.stringify(value);
}

function managedBlockPattern(startMarker, endMarker, name) {
  const suffix = name ? escapeRegExp(name) : "([A-Za-z0-9_-]+)";
  const endSuffix = name ? escapeRegExp(name) : "\\1";
  return new RegExp(
    "\\n?" + escapeRegExp(startMarker) + ":" + suffix + "\\n[\\s\\S]*?" + escapeRegExp(endMarker) + ":" + endSuffix + "\\n?",
    "g",
  );
}

function removeManagedBlock(config, name) {
  return config
    .replace(managedBlockPattern(START, END, name), "\n")
    .replace(managedBlockPattern(LEGACY_START, LEGACY_END, name), "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function removeAllManagedBlocks(config) {
  return config
    .replace(managedBlockPattern(START, END), "\n")
    .replace(managedBlockPattern(LEGACY_START, LEGACY_END), "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
}

function dataDir(codexHome) {
  return path.join(codexHome, DATA_DIR);
}

function legacyDataDir(codexHome) {
  return path.join(codexHome, LEGACY_DATA_DIR);
}

function migrateLegacyDataDir(codexHome) {
  const primary = dataDir(codexHome);
  const legacy = legacyDataDir(codexHome);
  if (fs.existsSync(primary) || !fs.existsSync(legacy)) return;
  fs.mkdirSync(path.dirname(primary), { recursive: true, mode: 0o700 });
  fs.cpSync(legacy, primary, { recursive: true, force: false, errorOnExist: false });
}

function apiSwitchDataPath(codexHome, ...parts) {
  migrateLegacyDataDir(codexHome);
  return path.join(dataDir(codexHome), ...parts);
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
  const catalogFile = apiSwitchDataPath(codexHome, `${args.name}_models.json`);
  return { codexHome, configPath, keyFile, catalogFile };
}

function modelCatalogEntry(model) {
  return {
    slug: model,
    display_name: model,
    description: "Relay model managed by api-switch.",
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

  const catalogFile = apiSwitchDataPath(codexHome, `${name}_models.json`);
  fs.mkdirSync(path.dirname(catalogFile), { recursive: true, mode: 0o700 });
  atomicWriteFile(
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

function profilesStorePath(codexHome) {
  return apiSwitchDataPath(codexHome, "profiles.json");
}

function routesStorePath(codexHome) {
  return apiSwitchDataPath(codexHome, "routes.json");
}

function readProfilesStore(codexHome) {
  const storePath = profilesStorePath(codexHome);
  if (!fs.existsSync(storePath)) return {};
  try {
    const payload = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return payload && payload.profiles && typeof payload.profiles === "object" ? payload.profiles : {};
  } catch {
    return {};
  }
}

function writeProfilesStore(codexHome, profiles) {
  const storePath = profilesStorePath(codexHome);
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  atomicWriteFile(storePath, `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`, { mode: 0o600 });
}

function readRoutesStore(codexHome) {
  const storePath = routesStorePath(codexHome);
  if (!fs.existsSync(storePath)) return {};
  try {
    const payload = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return payload && payload.routes && typeof payload.routes === "object" ? payload.routes : {};
  } catch {
    return {};
  }
}

function writeRoutesStore(codexHome, routes) {
  const storePath = routesStorePath(codexHome);
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  atomicWriteFile(storePath, `${JSON.stringify({ version: 1, routes }, null, 2)}\n`, { mode: 0o600 });
}

function storedProfileFromRecord(name, record) {
  if (!record || typeof record !== "object") return null;
  return {
    name,
    profileType: String(record.profileType || record.type || "relay"),
    codexUpstreamProtocol: String(record.codexUpstreamProtocol || record.upstreamProtocol || ""),
    claudeUpstreamProtocol: String(record.claudeUpstreamProtocol || ""),
    upstreamProtocol: String(record.upstreamProtocol || ""),
    model: String(record.model || ""),
    baseUrl: String(record.baseUrl || ""),
    anthropicBaseUrl: String(record.anthropicBaseUrl || ""),
    keyEnv: record.keyEnv ? String(record.keyEnv) : "",
    keyFile: record.keyFile ? String(record.keyFile) : "",
    catalogFile: record.catalogFile ? String(record.catalogFile) : "",
    reasoningEffort: record.reasoningEffort ? String(record.reasoningEffort) : "medium",
    fallbackProfiles: Array.isArray(record.fallbackProfiles) ? record.fallbackProfiles.filter(Boolean).map(String) : [],
    isDefault: false,
    command: "Use for Codex",
  };
}

function cleanupLegacyManagedBlocks(codexHome) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return false;
  const config = fs.readFileSync(configPath, "utf8");
  const nextConfig = removeAllManagedBlocks(config);
  if (nextConfig === config) return false;
  fs.writeFileSync(configPath, nextConfig, { mode: 0o600 });
  return true;
}

function ensureStoredProfile(codexHome, profile) {
  if (!profile || !profile.name) return;
  const profiles = readProfilesStore(codexHome);
  if (profiles[profile.name]) return;
  profiles[profile.name] = {
    name: profile.name,
    baseUrl: profile.baseUrl,
    anthropicBaseUrl: profile.anthropicBaseUrl || "",
    profileType: profile.profileType || "relay",
    codexUpstreamProtocol: profile.codexUpstreamProtocol || profile.upstreamProtocol || "",
    claudeUpstreamProtocol: profile.claudeUpstreamProtocol || "",
    upstreamProtocol: profile.upstreamProtocol || "",
    model: profile.model,
    keyFile: profile.keyEnv ? "" : profile.keyFile,
    keyEnv: profile.keyEnv || "",
    reasoningEffort: profile.reasoningEffort || "medium",
    fallbackProfiles: Array.isArray(profile.fallbackProfiles) ? profile.fallbackProfiles : [],
    catalogFile: profile.catalogFile || apiSwitchDataPath(codexHome, `${profile.name}_models.json`),
    importedFrom: "legacy-config",
    updatedAt: new Date().toISOString(),
  };
  writeProfilesStore(codexHome, profiles);
}

function writeProfile(args, secret) {
  validateName(args.name);
  validateProfileOptions(args);
  if (!args.baseUrl) throw new Error("--base-url is required.");
  if (!args.model) throw new Error("--model is required.");

  const { codexHome, keyFile, catalogFile } = resolvePaths(args);

  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  cleanupLegacyManagedBlocks(codexHome);

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

  const profiles = readProfilesStore(codexHome);
  profiles[args.name] = {
    name: args.name,
    profileType: args.profileType || args.type || "relay",
    codexUpstreamProtocol: args.codexUpstreamProtocol || args.upstreamProtocol || "",
    claudeUpstreamProtocol: args.claudeUpstreamProtocol || "",
    upstreamProtocol: args.upstreamProtocol || "",
    baseUrl: args.baseUrl,
    anthropicBaseUrl: args.anthropicBaseUrl || "",
    model: args.model,
    keyFile: args.keyEnv ? "" : keyFile,
    keyEnv: args.keyEnv || "",
    reasoningEffort: args.reasoningEffort || "medium",
    fallbackProfiles: Array.isArray(args.fallbackProfiles) ? args.fallbackProfiles.filter(Boolean).map(String) : (args.fallbackProfiles ? String(args.fallbackProfiles).split(",").map((name) => name.trim()).filter(Boolean) : []),
    catalogFile,
    updatedAt: new Date().toISOString(),
  };
  writeProfilesStore(codexHome, profiles);

  return { profileStore: profilesStorePath(codexHome), keyFile };
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
  console.log(`Saved profile: ${args.name}`);
  console.log("Run: api-switch web, then choose a client for this profile.");
}

function remove(args) {
  validateName(args.name);
  const { configPath, keyFile } = resolvePaths(args);
  const profiles = readProfilesStore(expandHome(args.codexHome || "~/.codex"));
  delete profiles[args.name];
  writeProfilesStore(expandHome(args.codexHome || "~/.codex"), profiles);

  if (fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(configPath, removeManagedBlock(config, args.name), { mode: 0o600 });
  }
  console.log(`Removed profile: ${args.name}`);

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
  const host = args.host || "127.0.0.1";
  const port = Number(args.port || DEFAULT_PORT);
  const result = switchCodexToProxyMode(codexHome, profile, `http://${host}:${port}/v1`, {
    noMigrateHistory: args.noMigrateHistory,
  });
  const migration = result.migration;
  console.log(`Set Codex to use local proxy target: ${args.name}`);
  console.log(`OpenAI base URL: http://${host}:${port}/v1`);
  console.log(`API key: ${PROXY_API_KEY}`);
  const service = ensureProxyService({ host, port });
  console.log(service.message);
  if (migration) {
    console.log(`Moved ${migration.changed} thread(s) to provider: openai`);
    if (migration.modelChanged) console.log(`Updated ${migration.modelChanged} thread model(s) to: ${profile.model}`);
    console.log(`Updated ${migration.rolloutChanged} rollout file(s).`);
    if (migration.rolloutModelChanged) console.log(`Updated ${migration.rolloutModelChanged} rollout model file(s) to: ${profile.model}`);
    if (migration.repairedRolloutPaths) console.log(`Repaired ${migration.repairedRolloutPaths} rollout path(s).`);
    console.log(`Backup: ${migration.backupPath}`);
  }
  if (args.restartCodex) {
    const restart = tryRestartCodexApp();
    console.log(restart.message);
  }
  console.log("Run: codex");
}

function accountCommand(args) {
  const codexHome = expandHome(args.codexHome || "~/.codex");
  const result = switchCodexToAccountMode(codexHome, {
    noMigrateHistory: args.noMigrateHistory,
  });
  const migration = result.migration;
  console.log("Set Codex to use ChatGPT account login.");
  if (migration) {
    console.log(`Moved ${migration.changed} thread(s) to provider: openai`);
    console.log(`Updated ${migration.rolloutChanged} rollout file(s).`);
    if (migration.rolloutModelChanged) console.log(`Updated ${migration.rolloutModelChanged} rollout model file(s).`);
    if (migration.repairedRolloutPaths) console.log(`Repaired ${migration.repairedRolloutPaths} rollout path(s).`);
    console.log(`Backup: ${migration.backupPath}`);
  }
  if (args.restartCodex) {
    const restart = tryRestartCodexApp();
    console.log(restart.message);
  }
  console.log("Run: codex");
}

function claudeHome(args) {
  return expandHome(args.claudeHome || "~/.claude");
}

function claudeSettingsPath(args) {
  return path.join(claudeHome(args), "settings.json");
}

function claudeEnvBackupPath(codexHome) {
  return apiSwitchDataPath(codexHome, "claude-env.backup.json");
}

function backupClaudeCodeEnv(codexHome, settings) {
  const backup = claudeEnvBackupPath(codexHome);
  const env = settings.env && typeof settings.env === "object" ? settings.env : {};
  if (env.ANTHROPIC_AUTH_TOKEN === PROXY_API_KEY) return;
  writeJsonFile(backup, {
    version: 1,
    env: {
      ANTHROPIC_BASE_URL: Object.prototype.hasOwnProperty.call(env, "ANTHROPIC_BASE_URL") ? env.ANTHROPIC_BASE_URL : null,
      ANTHROPIC_AUTH_TOKEN: Object.prototype.hasOwnProperty.call(env, "ANTHROPIC_AUTH_TOKEN") ? env.ANTHROPIC_AUTH_TOKEN : null,
    },
  });
}

function restoreClaudeCodeEnv(codexHome, settings) {
  const backup = readJsonFile(claudeEnvBackupPath(codexHome));
  const env = settings.env && typeof settings.env === "object" ? { ...settings.env } : {};
  if (backup && backup.env && typeof backup.env === "object") {
    for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
      if (backup.env[key] === null || backup.env[key] === undefined) delete env[key];
      else env[key] = backup.env[key];
    }
  } else {
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;
  return settings;
}

function switchClaudeCodeToProxyMode(args) {
  const codexHome = expandHome(args.codexHome || "~/.codex");
  const profile = getManagedProfile(codexHome, args.name);
  if (!profile) throw new Error(`Managed profile not found: ${args.name}`);
  profileApiKey(profile);
  const host = args.host || "127.0.0.1";
  const port = Number(args.port || DEFAULT_PORT);
  const settingsPath = claudeSettingsPath(args);
  const settings = readJsonFile(settingsPath) || {};
  backupConfigFile(settingsPath, "claude-account");
  backupClaudeCodeEnv(codexHome, settings);
  settings.env = {
    ...(settings.env || {}),
    ANTHROPIC_BASE_URL: `http://${host}:${port}`,
    ANTHROPIC_AUTH_TOKEN: PROXY_API_KEY,
  };
  writeJsonFile(settingsPath, settings);
  const proxyState = readProxySettings(codexHome);
  proxyState.enabled = true;
  proxyState.clients["claude-code"].targetProfile = profile.name;
  writeProxySettings(codexHome, proxyState);
  console.log(`Set Claude Code to use API Switch local proxy target: ${profile.name}`);
  console.log(`ANTHROPIC_BASE_URL: http://${host}:${port}`);
}

function switchClaudeCodeToAccountMode(args) {
  const codexHome = expandHome(args.codexHome || "~/.codex");
  const settingsPath = claudeSettingsPath(args);
  const settings = readJsonFile(settingsPath) || {};
  backupConfigFile(settingsPath, "claude-proxy");
  writeJsonFile(settingsPath, restoreClaudeCodeEnv(codexHome, settings));
  const proxyState = readProxySettings(codexHome);
  proxyState.clients["claude-code"].targetProfile = "";
  writeProxySettings(codexHome, proxyState);
  console.log("Removed Claude Code local proxy environment overrides.");
}

function launchAgentPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.api-switch.web.plist");
}

function legacyLaunchAgentPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.codex-switch.web.plist");
}

function serviceLogDir() {
  return path.join(os.homedir(), ".codex", DATA_DIR, "service-logs");
}

function windowsStartupScriptPath() {
  const startup = process.env.APPDATA
    ? path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
    : path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  return path.join(startup, "api-switch-web.cmd");
}

function linuxSystemdServicePath() {
  return path.join(os.homedir(), ".config", "systemd", "user", "api-switch-web.service");
}

function webCommandArgs(args) {
  return ["web", "--host", args.host || "127.0.0.1", "--port", String(args.port || DEFAULT_PORT), "--no-open"];
}

function servicePlist(args) {
  const nodePath = process.execPath;
  const scriptPath = path.resolve(__filename);
  const [command, , host, , port, noOpen] = webCommandArgs(args);
  const logDir = serviceLogDir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.api-switch.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>${command}</string>
    <string>--host</string><string>${host}</string>
    <string>--port</string><string>${port}</string>
    <string>${noOpen}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>API_SWITCH_SERVICE_MANAGER</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>${path.join(logDir, "out.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, "err.log")}</string>
</dict>
</plist>
`;
}

function serviceInstallMac(args) {
  const plistPath = launchAgentPath();
  const legacyPlistPath = legacyLaunchAgentPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(serviceLogDir(), { recursive: true });
  fs.writeFileSync(plistPath, servicePlist(args), { mode: 0o644 });
  const domain = `gui/${process.getuid()}`;
  if (fs.existsSync(legacyPlistPath)) {
    try {
      execFileSync("launchctl", ["bootout", domain, legacyPlistPath], { stdio: "ignore" });
    } catch (_) {
      // It is fine if the legacy LaunchAgent was not loaded.
    }
    fs.unlinkSync(legacyPlistPath);
  }
  try {
    execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
  } catch (_) {
    // It is fine if the LaunchAgent was not loaded yet.
  }
  execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "ignore" });
  execFileSync("launchctl", ["kickstart", "-k", `${domain}/com.api-switch.web`], { stdio: "ignore" });
  console.log(`Installed LaunchAgent: ${plistPath}`);
  console.log(`Started API Switch service on port ${args.port || DEFAULT_PORT}.`);
}

function serviceInstallWindows(args) {
  const scriptPath = windowsStartupScriptPath();
  const nodePath = process.execPath;
  const apiSwitchPath = path.resolve(__filename);
  const logDir = serviceLogDir();
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const command = [
    "@echo off",
    "set API_SWITCH_SERVICE_MANAGER=1",
    `start "" /min "${nodePath}" "${apiSwitchPath}" ${webCommandArgs(args).join(" ")} >> "${path.join(logDir, "out.log")}" 2>> "${path.join(logDir, "err.log")}"`,
    "",
  ].join("\r\n");
  fs.writeFileSync(scriptPath, command);
  execFile(process.execPath, [apiSwitchPath, ...webCommandArgs(args)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, API_SWITCH_SERVICE_MANAGER: "1" },
  }).unref();
  console.log(`Installed Windows startup script: ${scriptPath}`);
  console.log(`Started API Switch service on port ${args.port || DEFAULT_PORT}.`);
}

function serviceInstallLinux(args) {
  const servicePath = linuxSystemdServicePath();
  const nodePath = process.execPath;
  const apiSwitchPath = path.resolve(__filename);
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  fs.mkdirSync(serviceLogDir(), { recursive: true });
  fs.writeFileSync(servicePath, [
    "[Unit]",
    "Description=API Switch web proxy",
    "",
    "[Service]",
    "Environment=API_SWITCH_SERVICE_MANAGER=1",
    `ExecStart=${nodePath} ${apiSwitchPath} ${webCommandArgs(args).join(" ")}`,
    "Restart=always",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n"));
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  execFileSync("systemctl", ["--user", "enable", "--now", "api-switch-web.service"], { stdio: "ignore" });
  console.log(`Installed systemd user service: ${servicePath}`);
  console.log(`Started API Switch service on port ${args.port || DEFAULT_PORT}.`);
}

function serviceInstall(args) {
  if (process.platform === "darwin") return serviceInstallMac(args);
  if (process.platform === "win32") return serviceInstallWindows(args);
  if (process.platform === "linux") return serviceInstallLinux(args);
  throw new Error(`service-install is not supported on ${process.platform}. Run: api-switch web --host ${args.host || "127.0.0.1"} --port ${args.port || DEFAULT_PORT} --no-open`);
}

function ensureProxyService(args) {
  if (process.env.API_SWITCH_SKIP_SERVICE_INSTALL === "1") {
    return { ok: true, message: "API Switch service install skipped by API_SWITCH_SKIP_SERVICE_INSTALL." };
  }
  try {
    serviceInstall({ ...args, noOpen: true });
    return { ok: true, message: `API Switch service is installed and running on port ${args.port || DEFAULT_PORT}.` };
  } catch (error) {
    return {
      ok: false,
      message: `Could not start API Switch service automatically: ${error.message}. Run: api-switch service-install --host ${args.host || "127.0.0.1"} --port ${args.port || DEFAULT_PORT}`,
    };
  }
}

function serviceUninstall() {
  const plistPath = launchAgentPath();
  const legacyPlistPath = legacyLaunchAgentPath();
  if (process.platform === "darwin") {
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
    } catch (_) {
      // It is fine if the LaunchAgent is already stopped.
    }
  }
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  if (fs.existsSync(legacyPlistPath)) fs.unlinkSync(legacyPlistPath);
  if (process.platform === "win32") {
    const scriptPath = windowsStartupScriptPath();
    if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
    console.log(`Removed Windows startup script: ${scriptPath}`);
    return;
  }
  if (process.platform === "linux") {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", "api-switch-web.service"], { stdio: "ignore" });
    } catch (_) {
      // It is fine if the service is already stopped.
    }
    const servicePath = linuxSystemdServicePath();
    if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath);
    console.log(`Removed systemd user service: ${servicePath}`);
    return;
  }
  console.log(`Removed LaunchAgent: ${plistPath}`);
}

function serviceStatus() {
  const status = serviceStatusData();
  console.log(`Service: ${status.installed ? "installed" : "not installed"}`);
  console.log(`Path: ${status.path}`);
  if (status.platform === "darwin" || status.platform === "linux") {
    console.log(`Status: ${status.loaded ? `loaded${status.pid ? `, pid ${status.pid}` : ""}` : "not loaded"}`);
  }
}

function serviceStatusData() {
  const servicePath = process.platform === "win32"
    ? windowsStartupScriptPath()
    : process.platform === "linux"
      ? linuxSystemdServicePath()
      : launchAgentPath();
  const result = {
    platform: process.platform,
    installed: fs.existsSync(servicePath),
    loaded: false,
    pid: null,
    path: servicePath,
  };
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid()}`;
    try {
      const output = execFileSync("launchctl", ["print", `${domain}/com.api-switch.web`], { encoding: "utf8" });
      const pid = output.match(/\bpid = (\d+)/);
      result.loaded = true;
      result.pid = pid ? pid[1] : null;
    } catch (_) {
      result.loaded = false;
    }
  } else if (process.platform === "linux") {
    try {
      const output = execFileSync("systemctl", ["--user", "show", "api-switch-web.service", "--property=ActiveState,MainPID"], { encoding: "utf8" });
      result.loaded = /ActiveState=active/.test(output);
      const pid = output.match(/MainPID=(\d+)/);
      result.pid = pid && pid[1] !== "0" ? pid[1] : null;
    } catch (_) {
      result.loaded = false;
    }
  }
  return result;
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
    console.log(`  type: ${profile.profileType || "relay"}`);
    console.log(`  base_url: ${profile.baseUrl || "(none)"}`);
    if (profile.anthropicBaseUrl) console.log(`  anthropic_base_url: ${profile.anthropicBaseUrl}`);
    const codexProtocol = profile.codexUpstreamProtocol || profile.upstreamProtocol || "";
    if (codexProtocol) console.log(`  codex_upstream_protocol: ${codexProtocol}`);
    if (profile.claudeUpstreamProtocol) console.log(`  claude_upstream_protocol: ${profile.claudeUpstreamProtocol}`);
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
    profileType: profile.profileType || "relay",
    codexUpstreamProtocol: profile.codexUpstreamProtocol || profile.upstreamProtocol || "",
    claudeUpstreamProtocol: profile.claudeUpstreamProtocol || "",
    upstreamProtocol: profile.upstreamProtocol || "",
    baseUrl: profile.baseUrl,
    anthropicBaseUrl: profile.anthropicBaseUrl || "",
    model: args.model,
    keyFile: profile.keyFile,
    keyEnv: profile.keyEnv,
    reasoningEffort: profile.reasoningEffort,
    fallbackProfiles: profile.fallbackProfiles.join(","),
    catalogModels: readModelCatalog(profile.catalogFile),
  });

  console.log(`Updated relay profile model: ${args.name} -> ${args.model}`);
  console.log("Run: api-switch web, then choose a client for this profile.");
}

function routeKey(client, model) {
  return `${client}:${model}`;
}

function listRoutes(codexHome) {
  return Object.entries(readRoutesStore(codexHome))
    .map(([key, route]) => ({ key, ...route }))
    .sort((a, b) => `${a.client}:${a.model}`.localeCompare(`${b.client}:${b.model}`));
}

function routeCommand(args) {
  const codexHome = expandHome(args.codexHome || "~/.codex");
  const client = args.client || "codex";
  const model = String(args.model || "").trim();
  validateClientId(client);
  if (!model) throw new Error("--model is required.");
  if (!args.profile) throw new Error("--profile is required.");
  const profile = getManagedProfile(codexHome, args.profile);
  if (!profile) throw new Error(`Managed profile not found: ${args.profile}`);
  const upstreamModel = String(args.upstreamModel || profile.model || model).trim();
  if (!upstreamModel) throw new Error("--upstream-model is required when the profile has no model.");
  const routes = readRoutesStore(codexHome);
  routes[routeKey(client, model)] = {
    client,
    model,
    profile: profile.name,
    upstreamModel,
    updatedAt: new Date().toISOString(),
  };
  writeRoutesStore(codexHome, routes);
  console.log(`Saved route: ${client}/${model} -> ${profile.name}/${upstreamModel}`);
}

function routeRemoveCommand(args) {
  const codexHome = expandHome(args.codexHome || "~/.codex");
  const client = args.client || "codex";
  const model = String(args.model || "").trim();
  validateClientId(client);
  if (!model) throw new Error("--model is required.");
  const routes = readRoutesStore(codexHome);
  delete routes[routeKey(client, model)];
  writeRoutesStore(codexHome, routes);
  console.log(`Removed route: ${client}/${model}`);
}

function routesCommand(args) {
  const codexHome = expandHome(args.codexHome || "~/.codex");
  const routes = listRoutes(codexHome);
  if (!routes.length) {
    console.log("No model routes configured.");
    return;
  }
  for (const route of routes) {
    console.log(`${route.client}/${route.model} -> ${route.profile}/${route.upstreamModel}`);
  }
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
  const backupPath = `${stateDb}.api-switch-${stamp}.bak`;
  fs.copyFileSync(stateDb, backupPath);
  return backupPath;
}

function backupFile(filePath, stamp) {
  const backupPath = `${filePath}.api-switch-${stamp}.bak`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function threadRolloutPath(stateDb, threadId) {
  return sqlite(stateDb, `select coalesce(rollout_path, '') from threads where id = ${sqlString(threadId)};`);
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

  const tempPath = `${rolloutPath}.api-switch-${stamp}.${process.pid}.tmp`;
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

const ROLLOUT_REWRITE_CHUNK_BYTES = 4 * 1024 * 1024;
const ROLLOUT_MAX_TRANSFORM_LINE_BYTES = 32 * 1024 * 1024;

function rewriteRolloutJsonLines(rolloutPath, transformLine, stamp) {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return false;
  const tempPath = `${rolloutPath}.api-switch-${stamp}.${process.pid}.tmp`;
  const inFd = fs.openSync(rolloutPath, "r");
  const outFd = fs.openSync(tempPath, "wx", 0o600);
  const buffer = Buffer.allocUnsafe(ROLLOUT_REWRITE_CHUNK_BYTES);
  const lineChunks = [];
  let lineBytes = 0;
  let oversizedLine = false;
  let changed = false;

  const resetLine = () => {
    lineChunks.length = 0;
    lineBytes = 0;
    oversizedLine = false;
  };

  const writeBufferParts = () => {
    for (const chunk of lineChunks) fs.writeSync(outFd, chunk);
  };

  const appendLineSegment = (segment) => {
    if (!segment.length) return;
    if (oversizedLine) {
      fs.writeSync(outFd, segment);
      return;
    }
    if (lineBytes + segment.length > ROLLOUT_MAX_TRANSFORM_LINE_BYTES) {
      writeBufferParts();
      fs.writeSync(outFd, segment);
      lineChunks.length = 0;
      lineBytes = 0;
      oversizedLine = true;
      return;
    }
    lineChunks.push(Buffer.from(segment));
    lineBytes += segment.length;
  };

  const finishLine = (hasNewline) => {
    if (oversizedLine) {
      if (hasNewline) fs.writeSync(outFd, "\n");
      resetLine();
      return;
    }

    const line = Buffer.concat(lineChunks, lineBytes).toString("utf8");
    const updated = transformLine(line);
    if (updated !== line) changed = true;
    fs.writeSync(outFd, updated);
    if (hasNewline) fs.writeSync(outFd, "\n");
    resetLine();
  };

  try {
    while (true) {
      const bytesRead = fs.readSync(inFd, buffer, 0, buffer.length, null);
      if (!bytesRead) break;

      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        appendLineSegment(buffer.subarray(segmentStart, index));
        finishLine(true);
        segmentStart = index + 1;
      }
      appendLineSegment(buffer.subarray(segmentStart, bytesRead));
    }

    if (oversizedLine || lineBytes > 0) finishLine(false);
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

  if (!changed) {
    fs.unlinkSync(tempPath);
    return false;
  }

  backupFile(rolloutPath, stamp);
  fs.renameSync(tempPath, rolloutPath);
  fs.chmodSync(rolloutPath, 0o600);
  return true;
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

function updateRolloutModel(rolloutPath, model, stamp) {
  if (!rolloutPath || !fs.existsSync(rolloutPath) || !model) return false;
  return rewriteRolloutJsonLines(
    rolloutPath,
    (line) => {
      if (!line.trim()) return line;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return line;
      }

      let changed = false;
      if (entry.type === "turn_context" && entry.payload && entry.payload.model && entry.payload.model !== model) {
        entry.payload.model = model;
        if (entry.payload.collaboration_mode && entry.payload.collaboration_mode.settings && entry.payload.collaboration_mode.settings.model) {
          entry.payload.collaboration_mode.settings.model = model;
        }
        changed = true;
      }

      if (entry.type === "event_msg" && entry.payload && entry.payload.type === "task_started" && entry.payload.model) {
        if (entry.payload.model !== model) {
          entry.payload.model = model;
          changed = true;
        }
      }

      return changed ? JSON.stringify(entry) : line;
    },
    stamp,
  );
}

function originalRolloutPath(rolloutPath) {
  if (!rolloutPath.endsWith(".bak")) return "";
  for (const marker of [".api-switch-", ".codex-switch-"]) {
    const markerIndex = rolloutPath.indexOf(marker);
    if (markerIndex !== -1) return rolloutPath.slice(0, markerIndex);
  }
  return "";
}

function repairRolloutPath(rolloutPath, stamp) {
  const originalPath = originalRolloutPath(rolloutPath);
  if (!originalPath || !fs.existsSync(rolloutPath) || fs.existsSync(originalPath)) return "";

  fs.mkdirSync(path.dirname(originalPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(rolloutPath, originalPath);
  fs.chmodSync(originalPath, 0o600);

  const repairBackupPath = `${rolloutPath}.api-switch-repair-${stamp}.bak`;
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
  const rolloutModelChanged = shouldMigrateModel
    ? rolloutRows.filter((row) => updateRolloutModel(row.rolloutPath, toModel, stamp)).length
    : 0;

  if (!changed && !modelChanged && !rolloutChanged && !rolloutModelChanged && repairs.length === 0) return null;

  const backupPath = `${stateDb}.api-switch-${stamp}.bak`;
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
  return {
    changed,
    modelChanged,
    backupPath,
    rolloutChanged,
    rolloutModelChanged,
    repairedRolloutPaths: repairs.length,
  };
}

function threadModelCommand(args) {
  if (!args.model) throw new Error("--model is required.");

  const codexHome = expandHome(args.codexHome || "~/.codex");
  const stateDb = expandHome(args.stateDb || path.join(codexHome, "state_5.sqlite"));
  if (!fs.existsSync(stateDb)) throw new Error(`Codex state database not found: ${stateDb}`);

  const provider = args.provider || "openai";
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

function hasEncryptedContent(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasEncryptedContent);
  if (Object.prototype.hasOwnProperty.call(value, "encrypted_content")) return true;
  return Object.values(value).some(hasEncryptedContent);
}

function removeEncryptedContent(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(removeEncryptedContent);
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "encrypted_content") continue;
    next[key] = removeEncryptedContent(item);
  }
  return next;
}

function shouldDropEncryptedRolloutEntry(entry) {
  const payload = entry && entry.payload;
  if (!payload || !hasEncryptedContent(payload)) return false;

  // Hidden reasoning/compaction state is safe to drop when the ciphertext is
  // no longer valid for the active account. Visible user/assistant text is
  // preserved by falling back to field-level encrypted_content removal.
  if (entry.type === "response_item" && (payload.type === "reasoning" || payload.type === "compaction")) return true;
  if (payload.type === "reasoning" || payload.type === "compaction") return true;
  return false;
}

function repairEncryptedContentCommand(args) {
  const codexHome = expandHome(args.codexHome || "~/.codex");
  const stateDb = expandHome(args.stateDb || path.join(codexHome, "state_5.sqlite"));
  if (!fs.existsSync(stateDb)) throw new Error(`Codex state database not found: ${stateDb}`);

  const threadId = args.thread || latestThreadId(stateDb);
  if (!threadId) throw new Error("No non-archived Codex thread found.");
  const rolloutPath = threadRolloutPath(stateDb, threadId);
  if (!rolloutPath) throw new Error(`Thread has no rollout path: ${threadId}`);
  if (!fs.existsSync(rolloutPath)) throw new Error(`Rollout file not found: ${rolloutPath}`);

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  let cleanedLines = 0;
  let droppedLines = 0;
  const changed = rewriteRolloutJsonLines(
    rolloutPath,
    (line) => {
      if (!line.trim() || !line.includes("encrypted_content")) return line;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return line;
      }
      if (!hasEncryptedContent(entry)) return line;
      if (shouldDropEncryptedRolloutEntry(entry)) {
        droppedLines += 1;
        return "";
      }
      cleanedLines += 1;
      return JSON.stringify(removeEncryptedContent(entry));
    },
    stamp,
  );

  console.log(`Thread: ${threadId}`);
  console.log(`Rollout: ${rolloutPath}`);
  if (!changed) {
    console.log("No encrypted_content entries needed repair.");
    return;
  }
  console.log(`Removed encrypted_content from ${cleanedLines} line(s).`);
  console.log(`Dropped ${droppedLines} hidden reasoning/compaction line(s).`);
  console.log(`Backup: ${rolloutPath}.api-switch-${stamp}.bak`);
}

function clearDefaultProfile(codexHome) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return;
  const config = fs
    .readFileSync(configPath, "utf8")
    .replace(/^profile\s*=.*\n?/m, "")
    .replace(/\n{3,}/g, "\n\n");
  atomicWriteFile(configPath, config, { mode: 0o600 });
}

function setTopLevelConfigValue(codexHome, key, value) {
  const configPath = path.join(codexHome, "config.toml");
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  let config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const line = `${key} = ${tomlString(value)}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  if (pattern.test(config)) {
    config = config.replace(pattern, line);
  } else {
    config = `${line}\n${config.trimStart()}`;
  }
  atomicWriteFile(configPath, config, { mode: 0o600 });
}

function removeTopLevelConfigValue(codexHome, key) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return;
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=.*\\n?`, "m");
  const config = fs
    .readFileSync(configPath, "utf8")
    .replace(pattern, "")
    .replace(/\n{3,}/g, "\n\n");
  atomicWriteFile(configPath, config, { mode: 0o600 });
}

function authPath(codexHome) {
  return path.join(codexHome, "auth.json");
}

function accountAuthBackupPath(codexHome) {
  return apiSwitchDataPath(codexHome, "account-auth.backup.json");
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function atomicWriteFile(filePath, data, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const mode = options.mode || 0o600;
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, data, { mode });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, mode);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {
      // Ignore cleanup errors and surface the original write failure.
    }
    throw error;
  }
}

function writeJsonFile(filePath, value) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function backupPathFor(filePath, label = "backup") {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${filePath}.api-switch-${label}-${stamp}.bak`;
}

function backupConfigFile(filePath, label = "backup") {
  if (!fs.existsSync(filePath)) return "";
  const backupPath = backupPathFor(filePath, label);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function snapshotFile(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, mode: 0o600, data: null };
  const stat = fs.statSync(filePath);
  return { exists: true, mode: stat.mode & 0o777, data: fs.readFileSync(filePath) };
}

function restoreFileSnapshot(filePath, snapshot) {
  if (!snapshot || !snapshot.exists) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  atomicWriteFile(filePath, snapshot.data, { mode: snapshot.mode || 0o600 });
}

function snapshotCodexSwitchFiles(codexHome) {
  return {
    config: snapshotFile(path.join(codexHome, "config.toml")),
    auth: snapshotFile(authPath(codexHome)),
    proxySettings: snapshotFile(proxySettingsPath(codexHome)),
  };
}

function restoreCodexSwitchFiles(codexHome, snapshot) {
  restoreFileSnapshot(path.join(codexHome, "config.toml"), snapshot.config);
  restoreFileSnapshot(authPath(codexHome), snapshot.auth);
  restoreFileSnapshot(proxySettingsPath(codexHome), snapshot.proxySettings);
}

function backupAccountAuth(codexHome) {
  const source = authPath(codexHome);
  const backup = accountAuthBackupPath(codexHome);
  if (!fs.existsSync(source)) return;
  const current = readJsonFile(source);
  if (current && current.auth_mode === "apikey" && current.OPENAI_API_KEY === PROXY_API_KEY) return;
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, backup);
  fs.chmodSync(backup, 0o600);
}

function writeProxyApiAuth(codexHome) {
  backupAccountAuth(codexHome);
  writeJsonFile(authPath(codexHome), {
    auth_mode: "apikey",
    OPENAI_API_KEY: PROXY_API_KEY,
  });
}

function restoreAccountAuth(codexHome) {
  const target = authPath(codexHome);
  const backup = accountAuthBackupPath(codexHome);
  if (fs.existsSync(backup)) {
    const backupAuth = readJsonFile(backup);
    if (backupAuth && backupAuth.auth_mode !== "apikey") {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(backup, target);
      fs.chmodSync(target, 0o600);
      return true;
    }
  }
  const current = readJsonFile(target);
  if (current && current.auth_mode === "apikey" && current.OPENAI_API_KEY === PROXY_API_KEY) {
    fs.unlinkSync(target);
  }
  return false;
}

function switchCodexToProxyMode(codexHome, profile, proxyBaseUrl, options = {}) {
  if (!profile) throw new Error("Proxy target profile is required.");
  ensureStoredProfile(codexHome, profile);
  profileApiKey(profile);
  const snapshot = snapshotCodexSwitchFiles(codexHome);
  try {
    cleanupLegacyManagedBlocks(codexHome);
    clearDefaultProfile(codexHome);
    setTopLevelConfigValue(codexHome, "openai_base_url", proxyBaseUrl);
    setTopLevelConfigValue(codexHome, "forced_login_method", "api");
    writeProxyApiAuth(codexHome);
    const proxyState = readProxySettings(codexHome);
    proxyState.enabled = true;
    proxyState.clients.codex.targetProfile = profile.name;
    writeProxySettings(codexHome, proxyState);
    const migration = options.noMigrateHistory ? null : migrateThreads(codexHome, "openai", { toModel: profile.model });
    return { migration, proxyState };
  } catch (error) {
    restoreCodexSwitchFiles(codexHome, snapshot);
    throw error;
  }
}

function switchCodexToAccountMode(codexHome, options = {}) {
  const snapshot = snapshotCodexSwitchFiles(codexHome);
  try {
    const wasProxyMode = Boolean(currentOpenaiBaseUrl(codexHome));
    cleanupLegacyManagedBlocks(codexHome);
    clearDefaultProfile(codexHome);
    removeTopLevelConfigValue(codexHome, "openai_base_url");
    removeTopLevelConfigValue(codexHome, "forced_login_method");
    removeTopLevelConfigValue(codexHome, "model_catalog_json");
    removeTopLevelConfigValue(codexHome, "model_reasoning_effort");
    if (wasProxyMode) {
      removeTopLevelConfigValue(codexHome, "model");
    }
    restoreAccountAuth(codexHome);
    const proxyState = readProxySettings(codexHome);
    proxyState.clients.codex.targetProfile = "";
    writeProxySettings(codexHome, proxyState);
    const migration = options.noMigrateHistory ? null : migrateThreads(codexHome, "openai");
    return { migration, proxyState };
  } catch (error) {
    restoreCodexSwitchFiles(codexHome, snapshot);
    throw error;
  }
}

function restartCodexApp() {
  if (process.platform !== "darwin") {
    throw new Error("Automatic Codex app restart is only supported on macOS.");
  }
  execFileSync("osascript", ["-e", 'tell application "Codex" to quit'], { stdio: "ignore" });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  execFileSync("open", ["-a", "Codex"]);
}

function tryRestartCodexApp() {
  try {
    restartCodexApp();
    return { ok: true, message: "Restarted Codex app." };
  } catch (error) {
    return { ok: false, message: `Codex settings were switched, but app restart failed: ${error.message}` };
  }
}

function currentOpenaiBaseUrl(codexHome) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return "";
  return tomlValue(fs.readFileSync(configPath, "utf8"), "openai_base_url");
}

function currentConfigValue(codexHome, key) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return "";
  return tomlValue(fs.readFileSync(configPath, "utf8"), key);
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
    "(?:" + escapeRegExp(START) + "|" + escapeRegExp(LEGACY_START) + "):([A-Za-z0-9_-]+)\\n([\\s\\S]*?)(?:" + escapeRegExp(END) + "|" + escapeRegExp(LEGACY_END) + "):\\1",
    "g",
  );
}

function profileFromManagedBlock(name, block) {
  return {
    name,
    profileType: "relay",
    codexUpstreamProtocol: "",
    claudeUpstreamProtocol: "",
    upstreamProtocol: "",
    model: tomlValue(block, "model"),
    baseUrl: tomlValue(block, "base_url"),
    anthropicBaseUrl: "",
    keyEnv: tomlValue(block, "env_key"),
    keyFile: tomlArrayFirst(block, "auth.args"),
    catalogFile: tomlValue(block, "model_catalog_json"),
    reasoningEffort: tomlValue(block, "model_reasoning_effort"),
    isDefault: false,
      command: "Use for Codex",
  };
}

function getManagedProfile(codexHome, name) {
  validateName(name);
  const stored = storedProfileFromRecord(name, readProfilesStore(codexHome)[name]);
  if (stored) return stored;

  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return null;

  const config = fs.readFileSync(configPath, "utf8");
  for (const match of config.matchAll(managedProfilePattern())) {
    if (match[1] === name) return profileFromManagedBlock(match[1], match[2]);
  }
  return null;
}

function listProfiles(codexHome) {
  const profilesByName = new Map();
  const store = readProfilesStore(codexHome);
  for (const [name, record] of Object.entries(store)) {
    const profile = storedProfileFromRecord(name, record);
    if (profile) profilesByName.set(name, profile);
  }

  const configPath = path.join(codexHome, "config.toml");
  if (fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, "utf8");
    for (const match of config.matchAll(managedProfilePattern())) {
      if (!profilesByName.has(match[1])) profilesByName.set(match[1], profileFromManagedBlock(match[1], match[2]));
    }
  }
  return [...profilesByName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function switchTargets(codexHome) {
  const proxySettings = readProxySettings(codexHome);
  const codexTarget = proxySettings.clients.codex.targetProfile;
  const isProxyMode = Boolean(currentOpenaiBaseUrl(codexHome) && codexTarget);
  return {
    current: isProxyMode ? `proxy:${codexTarget}` : "account",
    account: {
      name: "account",
      label: "ChatGPT account",
      model: "Codex default",
      baseUrl: "OpenAI account login",
      isDefault: !isProxyMode,
      command: "codex",
      type: "account",
    },
    profiles: listProfiles(codexHome).map((profile) => ({
      ...profile,
      isDefault: isProxyMode ? profile.name === codexTarget : profile.isDefault,
      type: profile.profileType || "relay",
      label: profile.name,
      command: isProxyMode && profile.name === codexTarget ? "Codex via local proxy" : "Use for Codex",
    })),
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

function responsesUrl(baseUrl) {
  const url = new URL(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/responses")) pathname = `${pathname}/responses`;
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function chatCompletionsUrl(baseUrl) {
  const url = new URL(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/chat/completions")) pathname = `${pathname}/chat/completions`;
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function completionsUrl(baseUrl) {
  const url = new URL(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/completions")) pathname = `${pathname}/completions`;
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function messagesUrl(baseUrl) {
  const url = new URL(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/messages")) {
    pathname = `${pathname}${pathname.endsWith("/v1") ? "" : "/v1"}/messages`;
  }
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

function profileApiKey(profile) {
  if (!profile) throw new Error("Active relay profile not found.");
  if (profile.keyEnv) {
    const value = process.env[profile.keyEnv];
    if (!value) throw new Error(`Environment variable ${profile.keyEnv} is not set.`);
    return value.trim();
  }
  if (profile.keyFile && fs.existsSync(profile.keyFile)) {
    return fs.readFileSync(profile.keyFile, "utf8").trim();
  }
  throw new Error(`API key not found for profile '${profile.name}'.`);
}

function proxyTargetProfile(codexHome, client = "codex") {
  const settings = readProxySettings(codexHome);
  const targetProfile = settings.clients[client] && settings.clients[client].targetProfile;
  if (targetProfile) {
    const profile = getManagedProfile(codexHome, targetProfile);
    if (profile) return profile;
  }
  return null;
}

function proxyFallbackProfiles(codexHome, client = "codex") {
  const active = proxyTargetProfile(codexHome, client);
  const names = active && Array.isArray(active.fallbackProfiles) ? active.fallbackProfiles : [];
  return names.map((name) => getManagedProfile(codexHome, name)).filter(Boolean);
}

function resolveModelRoute(codexHome, client, requestedModel, activeProfile) {
  const routes = readRoutesStore(codexHome);
  const model = String(requestedModel || "").trim();
  if (!model) return { profile: activeProfile, upstreamModel: activeProfile.model, mapped: false };
  const exact = routes[routeKey(client, model)] || routes[routeKey("*", model)];
  if (!exact) return { profile: activeProfile, upstreamModel: activeProfile.model, mapped: false };
  const profile = getManagedProfile(codexHome, exact.profile);
  if (!profile) return { profile: activeProfile, upstreamModel: activeProfile.model, mapped: false };
  return {
    profile,
    upstreamModel: exact.upstreamModel || profile.model || model,
    mapped: true,
  };
}

function modelCapabilities(model) {
  return capabilitiesForModel(model);
}

function proxyDiagnostics(codexHome, proxyBaseUrl) {
  const settings = readProxySettings(codexHome);
  const codexTarget = settings.clients.codex.targetProfile;
  const claudeTarget = settings.clients["claude-code"].targetProfile;
  const profile = codexTarget ? getManagedProfile(codexHome, codexTarget) : null;
  const claudeProfile = claudeTarget ? getManagedProfile(codexHome, claudeTarget) : null;
  const auth = readJsonFile(authPath(codexHome));
  const openaiBaseUrl = currentOpenaiBaseUrl(codexHome);
  const forcedLoginMethod = currentConfigValue(codexHome, "forced_login_method");
  const legacyProfile = currentConfigValue(codexHome, "profile");
  const hasProxyAuth = Boolean(auth && auth.auth_mode === "apikey" && auth.OPENAI_API_KEY === PROXY_API_KEY);
  const proxyConfigured = Boolean(openaiBaseUrl || hasProxyAuth);
  const checks = [];

  function add(id, label, ok, detail, level = "error") {
    checks.push({ id, label, ok: Boolean(ok), detail, level });
  }

  if (!proxyConfigured) {
    add("account-clean-config", "Account mode has no local proxy Base URL override", !openaiBaseUrl, openaiBaseUrl || "No openai_base_url set.");
    add("account-clean-auth", "Account mode is not using the API Switch API key", !hasProxyAuth, hasProxyAuth ? "Proxy API key is still active." : "No proxy API key active.");
    add("legacy-profile", "No legacy Codex profile key is active", !legacyProfile, legacyProfile ? `Found profile = ${legacyProfile}` : "No profile key set.", "warning");
    return {
      mode: "account",
      ready: checks.every((check) => check.ok || check.level === "warning"),
      proxyUrl: proxyBaseUrl,
      activeProfile: null,
      activeModel: null,
      activeClaudeProfile: claudeProfile ? claudeProfile.name : claudeTarget || null,
      activeClaudeModel: claudeProfile ? claudeProfile.model : null,
      checks,
    };
  }

  add("proxy-service", "API Switch proxy service is enabled", settings.enabled !== false, settings.enabled === false ? "Proxy is stopped." : "Proxy is enabled.");
  add("target-profile", "Proxy upstream target exists", Boolean(profile), codexTarget ? `Target: ${codexTarget}` : "No target profile selected.");
  let keyOk = false;
  if (profile) {
    try {
      profileApiKey(profile);
      keyOk = true;
    } catch (_) {
      keyOk = false;
    }
  }
  add("target-key", "Proxy upstream API key is available", keyOk, keyOk ? "Key file or environment variable is available." : "Missing key file or environment variable.");
  add("codex-base-url", "Codex API Base URL points to the local proxy", openaiBaseUrl === proxyBaseUrl, openaiBaseUrl || "No openai_base_url set.");
  add("forced-api", "Codex login method is API for proxy mode", forcedLoginMethod === "api", forcedLoginMethod || "No forced_login_method set.");
  add("proxy-api-key", "Codex API key is the local proxy key", hasProxyAuth, hasProxyAuth ? "Using api-switch as local proxy key." : "auth.json is not using the local proxy key.");
  add("legacy-profile", "No legacy Codex profile key is active", !legacyProfile, legacyProfile ? `Found profile = ${legacyProfile}` : "No profile key set.", "warning");
  if (claudeTarget) {
    let claudeKeyOk = false;
    if (claudeProfile) {
      try {
        profileApiKey(claudeProfile);
        claudeKeyOk = true;
      } catch (_) {
        claudeKeyOk = false;
      }
    }
    add("claude-target-profile", "Claude Code proxy upstream target exists", Boolean(claudeProfile), `Target: ${claudeTarget}`);
    add("claude-target-key", "Claude Code upstream API key is available", claudeKeyOk, claudeKeyOk ? "Key file or environment variable is available." : "Missing key file or environment variable.");
  }

  return {
    mode: "proxy",
    ready: checks.every((check) => check.ok || check.level === "warning"),
    proxyUrl: proxyBaseUrl,
    activeProfile: profile ? profile.name : codexTarget || null,
    activeModel: profile ? profile.model : null,
    activeClaudeProfile: claudeProfile ? claudeProfile.name : claudeTarget || null,
    activeClaudeModel: claudeProfile ? claudeProfile.model : null,
    checks,
  };
}

async function profileHealth(profile) {
  const startedAt = Date.now();
  const capabilities = modelCapabilities(profile.model);
  try {
    const apiKey = profileApiKey(profile);
    const response = await fetch(modelsUrl(profile.baseUrl), {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    let relay = "";
    if (response.ok) {
      try {
        relay = await runRelayTest(profile, apiKey);
      } catch (error) {
        return {
          name: profile.name,
          ok: false,
          status: response.status,
          durationMs: Date.now() - startedAt,
          model: profile.model,
          family: capabilities.family,
          baseUrl: profile.baseUrl,
          error: error.message,
        };
      }
    }
    return {
      name: profile.name,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      model: profile.model,
      family: capabilities.family,
      baseUrl: profile.baseUrl,
      protocol: relay,
      error: response.ok ? "" : parseErrorMessage(text),
    };
  } catch (error) {
    return {
      name: profile.name,
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      model: profile.model,
      family: capabilities.family,
      baseUrl: profile.baseUrl,
      error: error.message,
    };
  }
}

async function profilesHealth(codexHome) {
  const profiles = listProfiles(codexHome);
  return Promise.all(profiles.map((profile) => profileHealth(profile)));
}

async function probeJsonEndpoint(name, url, init) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(12000),
    });
    const text = await response.text();
    return {
      name,
      url,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      error: response.ok ? "" : parseErrorMessage(text) || text.slice(0, 180),
    };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      error: error.message,
    };
  }
}

function recommendedProtocols(probes) {
  const byName = new Map((Array.isArray(probes) ? probes : []).map((probe) => [probe.name, probe]));
  const ok = (name) => Boolean(byName.get(name) && byName.get(name).ok);
  return {
    codexUpstreamProtocol: ok("responses") ? "responses" : ok("chat_completions") ? "chat-completions" : ok("completions") ? "completions" : "",
    claudeUpstreamProtocol: ok("messages") ? "anthropic-messages" : ok("chat_completions") ? "chat-completions" : "",
  };
}

async function detectProfileCapabilities(profile) {
  if (!profile) throw new Error("Relay profile is required.");
  const apiKey = profileApiKey(profile);
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  const model = profile.model;
  const probes = await Promise.all([
    probeJsonEndpoint("models", modelsUrl(profile.baseUrl), {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    }),
    probeJsonEndpoint("responses", responsesUrl(profile.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: "ok", max_output_tokens: 1, stream: false }),
    }),
    probeJsonEndpoint("chat_completions", chatCompletionsUrl(profile.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ok" }], max_tokens: 1, stream: false }),
    }),
    probeJsonEndpoint("completions", completionsUrl(profile.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt: "ok", max_tokens: 1, stream: false }),
    }),
    probeJsonEndpoint("messages", messagesUrl(profile.anthropicBaseUrl || profile.baseUrl), {
      method: "POST",
      headers: {
        ...headers,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ok" }], stream: false }),
    }),
  ]);
  return {
    name: profile.name,
    model,
    baseUrl: profile.baseUrl,
    probes,
    recommended: recommendedProtocols(probes),
    capabilities: modelCapabilities(model),
  };
}

function startProxy(args) {
  const host = args.host || "127.0.0.1";
  const port = Number(args.port || DEFAULT_PORT);
  const codexHome = expandHome(args.codexHome || "~/.codex");
  startProxyServer({
    host,
    port,
    currentProfileName: () => {
      const settings = readProxySettings(codexHome);
      return settings.clients.codex.targetProfile || "";
    },
    getActiveProfile: (client) => proxyTargetProfile(codexHome, client),
    resolveModelRoute: (client, requestedModel, activeProfile) => resolveModelRoute(codexHome, client, requestedModel, activeProfile),
    getFallbackProfiles: (client) => proxyFallbackProfiles(codexHome, client),
    getApiKey: profileApiKey,
    debugDir: apiSwitchDataPath(codexHome),
  });
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
  <title>API Switch</title>
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
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0;
    }
    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0;
      font-size: 26px;
      line-height: 1.15;
      letter-spacing: -0.01em;
      background: linear-gradient(135deg, var(--accent), #0ea5e9);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
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
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
      box-shadow: var(--shadow);
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
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(340px, 0.75fr);
      gap: 16px;
      align-items: start;
    }
    .stack {
      display: grid;
      gap: 16px;
    }
    .span-all {
      grid-column: 1 / -1;
    }
    section {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 12px;
      padding: 20px;
      box-shadow: var(--shadow);
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
      border-radius: 8px;
      padding: 8px 12px;
      color: var(--text);
      background: #fff;
      font: inherit;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.12);
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
      border-radius: 8px;
      padding: 8px 14px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      background: var(--accent);
      color: #fff;
      transition: background 0.15s, box-shadow 0.15s, transform 0.1s;
    }
    button:hover { background: var(--accent-strong); box-shadow: 0 2px 6px rgba(0,0,0,0.12); }
    button:active { transform: scale(0.98); }
    button.secondary {
      background: #fff;
      color: var(--text);
      border-color: var(--line);
    }
    button.secondary:hover { background: #f8f9fb; border-color: #c8ced6; }
    button.danger {
      background: #fff;
      color: var(--danger);
      border-color: #fecaca;
    }
    button.danger:hover { background: #fef2f2; border-color: #fca5a5; }
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
      animation: fadeIn 0.2s ease;
    }
    .config-panel.open {
      display: block;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
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
      border: 2px dashed var(--line);
      border-radius: 10px;
      padding: 20px;
      color: var(--muted);
      background: #fafbfc;
      text-align: center;
    }
    .promo {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      margin-top: 18px;
      border: 1px solid #99f6e4;
      border-radius: 10px;
      padding: 14px 16px;
      background: linear-gradient(135deg, #f0fdfa, #ecfeff);
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
    .service-panel {
      display: grid;
      gap: 12px;
      margin: 0;
    }
    .service-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .service-title {
      margin: 0 0 4px;
      font-weight: 800;
    }
    .service-copy {
      margin: 0;
      color: var(--muted);
    }
    .service-status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      white-space: nowrap;
      font-weight: 700;
    }
    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: #a3acba;
    }
    .status-dot.on { background: #10b981; box-shadow: 0 0 6px rgba(16,185,129,0.5); }
    .status-dot.off { background: #ef4444; }
    .service-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .mini-panel {
      display: grid;
      gap: 10px;
    }
    details.advanced-panel {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      padding: 0;
      box-shadow: var(--shadow);
    }
    details.advanced-panel summary {
      cursor: pointer;
      list-style: none;
      padding: 14px 16px;
      color: var(--text);
      font-weight: 800;
    }
    details.advanced-panel summary::-webkit-details-marker {
      display: none;
    }
    details.advanced-panel summary::after {
      content: "+";
      float: right;
      color: var(--muted);
    }
    details.advanced-panel[open] summary::after {
      content: "-";
    }
    .advanced-body {
      display: grid;
      gap: 10px;
      border-top: 1px solid var(--line);
      padding: 14px 16px 16px;
    }
    .mini-form {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      align-items: end;
    }
    .mini-form button {
      grid-column: 1 / -1;
    }
    .mini-list {
      display: grid;
      gap: 7px;
    }
    .mini-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      background: #fff;
      color: var(--muted);
      font-size: 12px;
      transition: background 0.1s;
    }
    .mini-row:hover { background: #f8f9fb; }
    .mini-row strong {
      display: block;
      color: var(--text);
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .mini-row button {
      min-height: 32px;
      padding: 5px 9px;
    }
    .health-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 999px;
      margin-right: 6px;
      background: #a3acba;
    }
    .health-dot.ok { background: #10b981; box-shadow: 0 0 4px rgba(16,185,129,0.4); }
    .health-dot.fail { background: #ef4444; box-shadow: 0 0 4px rgba(239,68,68,0.4); }
    .profile-item {
      display: block;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 14px 16px;
      background: #fbfcfd;
      transition: box-shadow 0.15s, border-color 0.15s;
    }
    .profile-item:hover {
      box-shadow: var(--shadow-lg);
      border-color: #c8ced6;
    }
    .profile-main {
      min-width: 0;
    }
    .profile-name {
      font-weight: 800;
      margin-bottom: 3px;
    }
    .badge {
      display: inline-block;
      margin-left: 8px;
      border: 1px solid #99f6e4;
      border-radius: 999px;
      padding: 2px 10px;
      color: #0d9488;
      background: #f0fdfa;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .profile-meta {
      color: var(--muted);
      overflow-wrap: anywhere;
      line-height: 1.45;
      margin-top: 2px;
    }
    .profile-meta code {
      white-space: normal;
      word-break: break-all;
    }
    .profile-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-start;
      margin-top: 14px;
    }
    .profile-actions button {
      min-height: 32px;
      padding: 5px 10px;
      font-size: 12px;
      border-radius: 6px;
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
      max-height: 200px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      box-shadow: var(--shadow-lg);
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
      padding: 12px 14px;
      border-radius: 8px;
      background: #f0fdfa;
      color: #0d9488;
      border: 1px solid #99f6e4;
      display: none;
      white-space: pre-line;
      font-weight: 500;
    }
    .message.error {
      background: #fff5f3;
      color: var(--danger);
      border-color: #f0b8b2;
    }
    .message.success {
      background: #eef8f6;
      color: #0b5f59;
      border-color: #b8e3dc;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1117; --panel: #1a1d27; --text: #e2e5ea; --muted: #8b919e;
        --line: #2d3139; --accent: #2dd4bf; --accent-strong: #14b8a6;
        --danger: #f87171; --shadow: 0 1px 3px rgba(0,0,0,0.3);
        --shadow-lg: 0 4px 12px rgba(0,0,0,0.4);
      }
      html, body { background: var(--bg); color: var(--text); }
      input, select { background: #141620; color: var(--text); border-color: var(--line); }
      input:focus, select:focus { box-shadow: 0 0 0 3px rgba(45,212,191,0.15); }
      .mini-row, .profile-item, .model-list, .model-option { background: #141620; color: var(--text); border-color: var(--line); }
      .mini-row:hover { background: #1e2030; }
      .profile-item:hover { border-color: #3d4150; }
      button.secondary, .model-menu-button { background: #1a1d27; color: var(--text); border-color: var(--line); }
      button.secondary:hover, .model-menu-button:hover { background: #252830; }
      button.danger { background: #1a1d27; color: #f87171; border-color: rgba(248,113,113,0.2); }
      button.danger:hover { background: #2d1518; }
      .empty-state { background: #141620; border-color: var(--line); }
      .language-toggle { background: #1a1d27; border-color: var(--line); }
      .language-toggle button.active { background: var(--accent); color: #0f1117; }
      .badge { background: rgba(45,212,191,0.1); color: #2dd4bf; border-color: rgba(45,212,191,0.3); }
      .message { background: rgba(45,212,191,0.08); color: #2dd4bf; border-color: rgba(45,212,191,0.2); }
      .message.error { background: rgba(248,113,113,0.08); color: #f87171; border-color: rgba(248,113,113,0.2); }
      .message.success { background: rgba(52,211,153,0.08); color: #34d399; border-color: rgba(52,211,153,0.2); }
      .promo { background: linear-gradient(135deg, rgba(45,212,191,0.05), rgba(56,189,248,0.05)); border-color: rgba(45,212,191,0.2); }
      section { border-color: var(--line); }
      h1 { background: linear-gradient(135deg, #2dd4bf, #38bdf8); -webkit-background-clip: text; background-clip: text; }
      .health-dot.ok { background: #34d399; box-shadow: 0 0 4px rgba(52,211,153,0.5); }
      .health-dot.fail { background: #f87171; box-shadow: 0 0 4px rgba(248,113,113,0.5); }
      .status-dot.on { background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.5); }
    }

    @media (max-width: 760px) {
      header { align-items: stretch; flex-direction: column; }
      .layout { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
      .service-head { flex-direction: column; }
      .mini-form { grid-template-columns: 1fr; }
      .mini-row { grid-template-columns: 1fr; }
      main { width: min(100vw - 20px, 1040px); padding: 18px 0; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>API Switch</h1>
        <p class="subtitle" data-i18n="subtitle">Configure Codex to use a Responses-compatible relay API without putting API keys in config.toml.</p>
      </div>
      <div class="top-actions">
            <div class="language-toggle" aria-label="Language">
              <button type="button" id="lang-zh" aria-pressed="false">中文</button>
              <button type="button" id="lang-en" aria-pressed="false">English</button>
        </div>
      </div>
    </header>

    <div class="layout">
      <section class="span-all service-panel">
          <div class="service-head">
            <div>
              <p class="service-title" data-i18n="serviceTitle">API Switch proxy</p>
              <p class="service-copy"><span data-i18n="serviceCopy">Use this Base URL in Codex API mode:</span> <code id="proxy-url">http://127.0.0.1:18600/v1</code></p>
            </div>
            <div class="service-status"><span id="proxy-dot" class="status-dot"></span><span id="proxy-status"></span></div>
          </div>
          <div class="service-actions">
            <button type="button" class="secondary" id="service-status-refresh" data-i18n="serviceStatus">Service Status</button>
            <button type="button" class="danger" id="account-mode" data-i18n="accountMode">Use account mode</button>
          </div>
          <p class="hint" id="service-status-detail"></p>
          <p class="hint"><strong data-i18n="restartCodex">Choose a client for each relay profile</strong><br><span data-i18n="restartCodexHint">Use for Codex writes Codex API settings and restarts Codex. Use for Claude Code writes Claude Code proxy settings.</span></p>
          <div class="message" id="message"></div>
      </section>

      <div class="stack">
        <section>
          <div class="section-header">
            <h2 data-i18n="profilesTitle">Profiles</h2>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button type="button" class="secondary" id="import-profiles" data-i18n="importBtn">Import</button>
              <button type="button" class="secondary" id="export-profiles" data-i18n="exportBtn">Export</button>
              <button type="button" id="toggle-config" data-i18n="addProfile">Add Profile</button>
            </div>
          </div>
          <div class="config-panel" id="config-panel">
            <form id="profile-form">
              <div class="grid">
                <label><span data-i18n="nameLabel">Name</span>
                  <input id="name" name="name" value="" autocomplete="off" data-i18n-placeholder="namePlaceholder" required>
                </label>
                <label style="display:none"><span data-i18n="profileTypeLabel">Profile type</span>
                  <select id="profileType" name="profileType">
                    <option value="relay" data-i18n="profileTypeRelay">Relay / proxy</option>
                    <option value="official_subscription" data-i18n="profileTypeOfficialSubscription">Official subscription API key</option>
                  </select>
                </label>
                <label class="full"><span data-i18n="baseUrlLabel">Relay base URL</span>
                  <input id="baseUrl" name="baseUrl" value="" autocomplete="off" data-i18n-placeholder="baseUrlPlaceholder" required>
                </label>
                <label class="full"><span data-i18n="supportedEndpointLabel">Supported endpoint</span>
                  <select id="supportedEndpoint" name="supportedEndpoint">
                    <option value="chat-completions" data-i18n="endpointChatCompletions">/v1/chat/completions · OpenAI compatible</option>
                    <option value="responses" data-i18n="endpointResponses">/v1/responses · Native OpenAI</option>
                    <option value="anthropic-messages" data-i18n="endpointAnthropicMessages">/anthropic/v1/messages · Claude compatible</option>
                  </select>
                  <span class="field-help" data-i18n="supportedEndpointHelp">Choose the endpoint your provider supports. For Xiaomi and most OpenAI-compatible relays, use /v1/chat/completions.</span>
                </label>
                <label class="full" style="display:none"><span data-i18n="anthropicBaseUrlLabel">Anthropic base URL</span>
                  <input id="anthropicBaseUrl" name="anthropicBaseUrl" value="" autocomplete="off" data-i18n-placeholder="anthropicBaseUrlPlaceholder">
                </label>
                <label style="display:none"><span data-i18n="codexProtocolLabel">Codex upstream protocol</span>
                  <select id="codexUpstreamProtocol" name="codexUpstreamProtocol">
                    <option value="" data-i18n="protocolAuto">Auto / native Responses</option>
                    <option value="responses">Responses</option>
                    <option value="chat-completions">Chat Completions</option>
                    <option value="completions">Completions</option>
                  </select>
                </label>
                <label style="display:none"><span data-i18n="claudeProtocolLabel">Claude upstream protocol</span>
                  <select id="claudeUpstreamProtocol" name="claudeUpstreamProtocol">
                    <option value="" data-i18n="protocolAuto">Auto / native Responses</option>
                    <option value="anthropic-messages">Anthropic Messages</option>
                    <option value="chat-completions">Chat Completions</option>
                  </select>
                </label>
                <label class="full"><span data-i18n="apiKeyLabel">API key</span>
                  <input id="apiKey" name="apiKey" type="password" autocomplete="off" placeholder="sk-...">
                </label>
                <div class="model-picker">
                  <div class="model-switcher">
                    <label><span data-i18n="modelLabel">Model</span>
                      <input id="model" name="model" value="" autocomplete="off" placeholder="Load models or type one manually" data-i18n-placeholder="modelPlaceholder" required>
                    </label>
                    <button type="button" class="model-menu-button" id="model-menu-button" aria-haspopup="listbox" aria-controls="model-list" aria-expanded="false">
                      <span id="model-menu-label"></span>
                      <span>▾</span>
                    </button>
                  </div>
                  <div class="model-list" id="model-list" role="listbox" aria-label="Loaded models"></div>
                </div>
              </div>
              <div class="row">
                <button type="button" class="secondary" id="load-models" data-i18n="loadModels">Load Models</button>
                <button type="button" class="secondary" id="test" data-i18n="testAccess">Test Access</button>
                <button type="submit" data-i18n="save">Save</button>
                <button type="button" class="danger" id="remove" data-i18n="remove">Remove</button>
              </div>
              <p class="hint" data-i18n="hint">Edit a saved relay from the list, change fields, then Save. Leave API key blank to keep the saved local key.</p>
            </form>
          </div>
          <div class="profiles" id="profiles"></div>
        </section>
      </div>

      <div class="stack">
        <section class="mini-panel">
            <div class="target-title">
              <h3 data-i18n="requestsTitle">Recent requests</h3>
              <p data-i18n="requestsHint">Only real proxy traffic is shown.</p>
            </div>
            <div class="service-actions">
              <button type="button" class="secondary" id="requests-refresh" data-i18n="requestsRefresh">Refresh</button>
            </div>
            <div class="mini-list" id="request-list"></div>
        </section>
      </div>
    </div>
  </main>

  <script>
    const form = document.querySelector("#profile-form");
    const message = document.querySelector("#message");
    const nameInput = document.querySelector("#name");
    const profilesEl = document.querySelector("#profiles");
    const modelInput = document.querySelector("#model");
    const modelList = document.querySelector("#model-list");
    const modelMenuButton = document.querySelector("#model-menu-button");
    const modelMenuLabel = document.querySelector("#model-menu-label");
    const configPanel = document.querySelector("#config-panel");
    const toggleConfig = document.querySelector("#toggle-config");
    const proxyStatus = document.querySelector("#proxy-status");
    const proxyDot = document.querySelector("#proxy-dot");
    const proxyUrl = document.querySelector("#proxy-url");
    const routeForm = document.querySelector("#route-form");
    const routeProfile = document.querySelector("#route-profile");
    const routesList = document.querySelector("#routes-list");
    const healthList = document.querySelector("#health-list");
    const requestList = document.querySelector("#request-list");
    const serviceStatusDetail = document.querySelector("#service-status-detail");
    let loadedModels = [];
    let lang = localStorage.getItem("api-switch-lang") || ((navigator.language || "").startsWith("zh") ? "zh" : "en");

    const i18n = {
      en: {
        subtitle: "Configure Codex and Claude Code to use relay APIs through one local proxy.",
        profilesTitle: "Profiles",
        addProfile: "Add Profile",
        hideConfig: "Hide",
        relaysTitle: "My relays",
        relaysHint: "Saved relay bases appear here.",
        emptyRelays: "No relays yet. Click Add Profile to create one.",
        promoTitle: "Recommended relay: Vayne API",
        promoCopy: "A relay option for using compatible API models with API Switch.",
        promoAction: "View",
        serviceTitle: "API Switch proxy",
        serviceCopy: "Use this Base URL in Codex API mode:",
        proxyStart: "Start",
        proxyStop: "Stop",
        proxyRestart: "Restart",
        serviceStatus: "Service Status",
        serviceInstalled: "Service installed",
        serviceNotInstalled: "Service not installed",
        serviceLoaded: "loaded",
        serviceNotLoaded: "not loaded",
        accountMode: "Use account mode",
        accountConfirm: "Switch Codex back to account mode and restart the app?",
        proxyOn: "Running",
        proxyOff: "Stopped",
        advancedTitle: "Advanced: model name mapping",
        routesHint: "Only use this when a client must keep one model name while the proxy sends another upstream model.",
        routeClient: "Client",
        routeModel: "Client model",
        routeProfile: "Profile",
        routeUpstream: "Upstream model",
        routeSave: "Save",
        noRoutes: "No model routes.",
        routeRemove: "Remove",
        healthTitle: "Saved relays",
        healthHint: "Local saved profiles. Use Test Access for a token-consuming check.",
        healthRefresh: "Refresh list",
        healthLoading: "Loading saved profiles...",
        noHealth: "No saved profiles.",
        requestsTitle: "Recent requests",
        requestsHint: "Only real proxy traffic is shown.",
        requestsRefresh: "Refresh",
        requestsEmpty: "No proxy requests yet.",
        capabilityCheck: "Detect",
        capabilityChecking: "Detecting relay capabilities...",
        capabilityDone: "Capability detection completed for {name}.",
        profileTitle: "Profile",
        nameLabel: "Name",
        namePlaceholder: "e.g. my-relay",
        profileTypeLabel: "Profile type",
        profileTypeRelay: "Relay / proxy",
        profileTypeOfficialSubscription: "Official subscription API key",
        baseUrlLabel: "OpenAI-compatible base URL",
        baseUrlPlaceholder: "https://token-plan-sgp.xiaomimimo.com/v1",
        supportedEndpointLabel: "Supported endpoint",
        endpointChatCompletions: "/v1/chat/completions · OpenAI compatible",
        endpointResponses: "/v1/responses · Native OpenAI",
        endpointAnthropicMessages: "/anthropic/v1/messages · Claude compatible",
        supportedEndpointHelp: "Choose the endpoint your provider supports. For Xiaomi and most OpenAI-compatible relays, use /v1/chat/completions.",
        anthropicBaseUrlLabel: "Anthropic-compatible base URL",
        anthropicBaseUrlPlaceholder: "Optional, e.g. https://token-plan-sgp.xiaomimimo.com/anthropic",
        codexProtocolLabel: "Codex upstream protocol",
        claudeProtocolLabel: "Claude upstream protocol",
        protocolAuto: "Auto / native Responses",
        protocolRecommendedApplied: "Recommended protocols were filled into the form. Click Save to persist them.",
        apiKeyLabel: "API key",
        modelLabel: "Model",
        modelPlaceholder: "Load models or type one manually",
        selectModel: "Select model",
        loadModels: "Load Models",
        testAccess: "Test Access",
        save: "Save",
        remove: "Remove",
        hint: "Save relay providers, official subscription API keys, or custom compatible endpoints. Leave API key blank to keep the saved local key.",
        restartCodex: "Choose a client for each relay profile",
        restartCodexHint: "Use for Codex writes Codex API settings and restarts Codex. Use for Claude Code writes Claude Code proxy settings.",
        current: "current",
        edit: "Edit",
        useCodex: "Use for Codex",
        useClaude: "Use for Claude Code",
        test: "Test",
        noModels: "Load models first, or type a model manually.",
        editing: "Editing '{name}'. Save will update this relay profile.",
        switching: "Switching...",
        switched: "Switched",
        saving: "Saving...",
        saved: "Saved",
        removing: "Removing...",
        removeConfirm: "Remove profile '{name}'?",
        clone: "Clone",
        unsavedChanges: "You have unsaved changes. Discard?",
        importBtn: "Import",
        exportBtn: "Export",
        requestsExpand: "Show more",
        imported: "Imported {count} profile(s).",
        exported: "Exported.",
        removed: "Removed",
        loadingModels: "Loading models...",
        loadedModels: "Loaded {count} models.",
        modelsLoaded: "Models loaded",
        testing: "Testing with Codex...",
        tested: "Tested",
        error: "Error",
      },
      zh: {
        subtitle: "用一个本地代理给 Codex 和 Claude Code 配置中转站 API。",
        profilesTitle: "配置列表",
        addProfile: "新增配置",
        hideConfig: "收起",
        relaysTitle: "我的中转站",
        relaysHint: "保存后的中转 Base 都在这里。",
        emptyRelays: "还没有中转站，点“新增配置”添加一个。",
        promoTitle: "推荐中转站：Vayne API",
        promoCopy: "适合配合 API Switch 使用的兼容 API 中转站。",
        promoAction: "查看",
        serviceTitle: "API Switch 代理",
        serviceCopy: "Codex API 模式里填写这个 Base URL：",
        proxyStart: "开启",
        proxyStop: "关闭",
        proxyRestart: "重启",
        serviceStatus: "常驻服务状态",
        serviceInstalled: "已安装服务",
        serviceNotInstalled: "未安装服务",
        serviceLoaded: "已加载",
        serviceNotLoaded: "未加载",
        accountMode: "切回账号模式",
        accountConfirm: "确定要切回 Codex 账号模式并重启应用吗？",
        proxyOn: "运行中",
        proxyOff: "已关闭",
        advancedTitle: "高级：模型名映射",
        routesHint: "仅在客户端必须保留一个模型名，但代理需要发送另一个上游模型时使用。",
        routeClient: "客户端",
        routeModel: "客户端模型",
        routeProfile: "配置",
        routeUpstream: "上游模型",
        routeSave: "保存",
        noRoutes: "暂无模型路由。",
        routeRemove: "删除",
        healthTitle: "已保存中转",
        healthHint: "这里只读取本地配置。需要真实请求时点“检测接入”。",
        healthRefresh: "刷新列表",
        healthLoading: "正在读取本地配置...",
        noHealth: "暂无已保存配置。",
        requestsTitle: "最近请求",
        requestsHint: "只展示真实发生过的代理流量。",
        requestsRefresh: "刷新",
        requestsEmpty: "暂无代理请求。",
        capabilityCheck: "探测能力",
        capabilityChecking: "正在探测中转能力...",
        capabilityDone: "已完成「{name}」的能力探测。",
        profileTitle: "配置",
        nameLabel: "名称",
        namePlaceholder: "例如 my-relay",
        profileTypeLabel: "配置类型",
        profileTypeRelay: "中转站 / 代理",
        profileTypeOfficialSubscription: "官方订阅 API Key",
        baseUrlLabel: "兼容 OpenAI 的 Base URL",
        baseUrlPlaceholder: "https://token-plan-sgp.xiaomimimo.com/v1",
        supportedEndpointLabel: "支持的接口",
        endpointChatCompletions: "/v1/chat/completions · OpenAI 兼容",
        endpointResponses: "/v1/responses · OpenAI 原生",
        endpointAnthropicMessages: "/anthropic/v1/messages · Claude 兼容",
        supportedEndpointHelp: "选择服务商实际支持的接口。小米和大多数 OpenAI 兼容中转站选 /v1/chat/completions。",
        anthropicBaseUrlLabel: "兼容 Anthropic 的 Base URL",
        anthropicBaseUrlPlaceholder: "可选，例如 https://token-plan-sgp.xiaomimimo.com/anthropic",
        codexProtocolLabel: "Codex 上游协议",
        claudeProtocolLabel: "Claude 上游协议",
        protocolAuto: "自动 / 原生 Responses",
        protocolRecommendedApplied: "已把推荐协议填入表单。需要写入配置时请点击“保存”。",
        apiKeyLabel: "API 密钥",
        modelLabel: "模型",
        modelPlaceholder: "读取模型或手动输入",
        selectModel: "选择模型",
        loadModels: "读取模型",
        testAccess: "检测接入",
        save: "保存",
        remove: "删除",
        hint: "可以保存中转站、官方订阅 API Key 或自定义兼容端点。API 密钥留空会继续使用已保存的本地密钥。",
        restartCodex: "为每个中转配置选择客户端",
        restartCodexHint: "用于 Codex 会写入 Codex API 设置并重启 Codex；用于 Claude Code 会写入 Claude Code 代理设置。",
        current: "当前",
        edit: "编辑",
        useCodex: "用于 Codex",
        useClaude: "用于 Claude Code",
        test: "检测",
        noModels: "请先读取模型，或手动输入模型。",
        editing: "正在编辑「{name}」，保存后会更新这个中转配置。",
        switching: "正在切换...",
        switched: "已切换",
        saving: "正在保存...",
        saved: "已保存",
        removing: "正在删除...",
        removeConfirm: "确定要删除配置 \'{name}\' 吗？",
        clone: "复制",
        unsavedChanges: "有未保存的修改，确定丢弃？",
        importBtn: "导入",
        exportBtn: "导出",
        requestsExpand: "展开更多",
        imported: "已导入 {count} 个配置。",
        exported: "已导出。",
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
      document.querySelector("#lang-zh").setAttribute("aria-pressed", String(lang === "zh"));
      document.querySelector("#lang-en").setAttribute("aria-pressed", String(lang === "en"));
      updateModelLabel();
      updateConfigToggle();
      loadProfiles();
      loadRoutes();
      loadProxyStatus();
    }

    function values() {
      const data = Object.fromEntries(new FormData(form).entries());
      if (data.supportedEndpoint === "chat-completions") {
        data.codexUpstreamProtocol = "chat-completions";
        data.claudeUpstreamProtocol = "chat-completions";
        data.anthropicBaseUrl = "";
      } else if (data.supportedEndpoint === "responses") {
        data.codexUpstreamProtocol = "responses";
        data.claudeUpstreamProtocol = "";
        data.anthropicBaseUrl = "";
      } else if (data.supportedEndpoint === "anthropic-messages") {
        data.codexUpstreamProtocol = "";
        data.claudeUpstreamProtocol = "anthropic-messages";
        data.anthropicBaseUrl = data.anthropicBaseUrl || data.baseUrl;
      }
      data.useEnv = false;
      data.restartCodex = true;
      return data;
    }

    function setMessage(text, isError = false, isSuccess = false) {
      message.textContent = text;
      message.className = isError ? "message error" : isSuccess ? "message success" : "message";
      message.style.display = "block";
    }

    function switchMessage(payload) {
      const details = Array.isArray(payload.details) ? payload.details.filter(Boolean) : [];
      return [payload.message].concat(details.slice(-2)).filter(Boolean).join("\\n");
    }

    function setProfileBusy(item, busy) {
      item.querySelectorAll("button").forEach((entry) => {
        entry.disabled = busy;
      });
      item.setAttribute("aria-busy", String(busy));
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

    function renderProxyStatus(payload) {
      proxyUrl.textContent = payload.proxyUrl || "";
      const codexLabel = payload.activeProfile ? "Codex: " + payload.activeProfile : "Codex: -";
      const claudeLabel = payload.activeClaudeProfile ? "Claude Code: " + payload.activeClaudeProfile : "Claude Code: -";
      proxyStatus.textContent = (payload.enabled ? t("proxyOn") : t("proxyOff")) + " · " + codexLabel + " · " + claudeLabel;
      proxyDot.className = "status-dot " + (payload.enabled ? "on" : "off");
      renderRequests(payload.recent || []);
    }

    let currentProxyStatus = null;
    async function loadProxyStatus() {
      try {
        const response = await fetch("/api/proxy/status");
        currentProxyStatus = await response.json();
        renderProxyStatus(currentProxyStatus);
      } catch (error) {
        proxyStatus.textContent = error.message;
        proxyDot.className = "status-dot off";
      }
    }

    function loadProfile(profile) {
      if (formDirty && !window.confirm(t("unsavedChanges"))) { return; }
      formDirty = false;
      setConfigOpen(true);
      document.querySelector("#name").value = profile.name;
      document.querySelector("#profileType").value = profile.profileType || profile.type || "relay";
      modelInput.value = profile.model || "";
      document.querySelector("#baseUrl").value = profile.baseUrl || "";
      document.querySelector("#anthropicBaseUrl").value = profile.anthropicBaseUrl || "";
      document.querySelector("#codexUpstreamProtocol").value = profile.codexUpstreamProtocol || profile.upstreamProtocol || "";
      document.querySelector("#claudeUpstreamProtocol").value = profile.claudeUpstreamProtocol || "";
      const codexProtocol = profile.codexUpstreamProtocol || profile.upstreamProtocol || "";
      const claudeProtocol = profile.claudeUpstreamProtocol || "";
      let supportedEndpoint = "responses";
      if (claudeProtocol === "anthropic-messages") supportedEndpoint = "anthropic-messages";
      else if (codexProtocol === "chat-completions" || claudeProtocol === "chat-completions") supportedEndpoint = "chat-completions";
      else if (codexProtocol === "responses") supportedEndpoint = "responses";
      document.querySelector("#supportedEndpoint").value = supportedEndpoint;
      document.querySelector("#apiKey").value = "";
      renderModels([]);
      updateModelLabel();
      updateCommand();
      setMessage(t("editing", { name: profile.name }));
    }

    function renderServiceStatus(payload) {
      const installed = payload.installed ? t("serviceInstalled") : t("serviceNotInstalled");
      const loaded = payload.loaded ? t("serviceLoaded") + (payload.pid ? " · pid " + payload.pid : "") : t("serviceNotLoaded");
      serviceStatusDetail.textContent = installed + " · " + loaded;
    }

    async function loadServiceStatus() {
      try {
        const response = await fetch("/api/service/status");
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Request failed.");
        renderServiceStatus(payload);
      } catch (error) {
        serviceStatusDetail.textContent = error.message;
      }
    }

    function renderRequests(requests) {
      requestList.innerHTML = requests.length
        ? requests.slice(0, requestLimit).map((entry) => {
          const at = entry.at ? new Date(entry.at).toLocaleTimeString() : "";
          const ok = entry.ok === false ? "fail" : "ok";
          const status = entry.status || "";
          const duration = entry.durationMs === undefined ? "" : " · " + entry.durationMs + "ms";
          const model = entry.upstreamModel || entry.model || "";
          const profile = entry.profile ? " · " + entry.profile : "";
          const protocol = entry.protocol ? " · " + entry.protocol : "";
          return '<div class="mini-row">' +
            '<div>' +
              '<strong><span class="health-dot ' + ok + '"></span>' + escapeHtml(model || "request") + '</strong>' +
              '<span>' + escapeHtml([at, entry.client || "", entry.family || ""].filter(Boolean).join(" · ") + profile + protocol) + '</span>' +
            '</div>' +
            '<span>' + escapeHtml(String(status) + duration) + '</span>' +
          '</div>';
        }).join("")
        : '<div class="hint">' + escapeHtml(t("requestsEmpty")) + '</div>';
    }

    function formatCapabilities(payload) {
      const probes = Array.isArray(payload.probes) ? payload.probes : [];
      const lines = probes.map((probe) => {
        return probe.name + ": " + (probe.ok ? "ok" : "fail") + " (" + (probe.status || 0) + ", " + probe.durationMs + "ms" + (probe.url ? ", " + probe.url : "") + (probe.error ? ", " + probe.error : "") + ")";
      });
      if (payload.recommended) {
        lines.push("recommended.codexUpstreamProtocol: " + (payload.recommended.codexUpstreamProtocol || "none"));
        lines.push("recommended.claudeUpstreamProtocol: " + (payload.recommended.claudeUpstreamProtocol || "none"));
      }
      return lines.join("\\n");
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
        return '<button type="button" role="option" aria-selected="' + String(Boolean(selected)) + '" class="model-option' + selected + '" data-model="' + escapeHtml(model) + '">' +
          escapeHtml(model) +
        '</button>';
      }).join("");
      modelList.classList.add("visible");
      modelList.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", () => {
          modelInput.value = button.dataset.model;
          modelList.querySelectorAll("button").forEach((entry) => {
            entry.classList.toggle("selected", entry === button);
            entry.setAttribute("aria-selected", String(entry === button));
          });
          modelList.classList.remove("visible");
          modelMenuButton.setAttribute("aria-expanded", "false");
          updateModelLabel();
          updateCommand();
        });
      });
      updateModelLabel();
    }

    function truncateUrl(url) {
      if (!url) return "";
      try { const u = new URL(url); let p = u.pathname; while (p.endsWith("/")) p = p.slice(0, -1); return u.hostname + p.slice(0, 30); } catch { return url.slice(0, 40); }
    }
    let formDirty = false;
    function markDirty() { formDirty = true; }
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);

    function profileHtml(profile, activeProfile, activeClaudeProfile) {

        return '<div class="profile-item" data-name="' + escapeHtml(profile.name) + '">' +
          '<div class="profile-main">' +
            '<div class="profile-name">' + escapeHtml(profile.label || profile.name) + (profile.isDefault ? '<span class="badge">' + escapeHtml(t("current")) + '</span>' : '') + '</div>' +
            (profile.model ? '<div class="profile-meta"><code>' + escapeHtml(profile.model) + '</code> · ' + escapeHtml(truncateUrl(profile.baseUrl)) + '</div>' : '') +
          '</div>' +
          '<div class="profile-actions">' +
            '<button class="secondary" data-action="load">' + escapeHtml(t("edit")) + '</button>' +
            '<button class="secondary" data-action="codex">' + escapeHtml(profile.name === activeProfile ? '✓ ' + t("useCodex") : t("useCodex")) + '</button>' +
            '<button class="secondary" data-action="claude">' + escapeHtml(profile.name === activeClaudeProfile ? '✓ ' + t("useClaude") : t("useClaude")) + '</button>' +
            '<button class="secondary" data-action="test">' + escapeHtml(t("test")) + '</button>' +
            '<button class="secondary" data-action="clone">' + escapeHtml(t("clone")) + '</button>' +
            '<button class="danger" data-action="remove">' + escapeHtml(t("remove")) + '</button>' +
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
          if (button.dataset.action === "clone") {
            loadProfile({ ...profile, name: profile.name + "-copy" });
            document.querySelector("#name").value = profile.name + "-copy";
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
          if (button.dataset.action === "capabilities") {
            setMessage(t("capabilityChecking"));
            try {
              const payload = await post("/api/profile/capabilities", { name: profile.name });
              loadProfile(profile);
              if (payload.recommended) {
                document.querySelector("#codexUpstreamProtocol").value = payload.recommended.codexUpstreamProtocol || "";
                document.querySelector("#claudeUpstreamProtocol").value = payload.recommended.claudeUpstreamProtocol || "";
              }
              setMessage(t("capabilityDone", { name: profile.name }) + "\\n" + t("protocolRecommendedApplied") + "\\n" + formatCapabilities(payload));
            } catch (error) {
              setMessage(error.message, true);
            }
          }
          if (button.dataset.action === "codex" || button.dataset.action === "claude") {
            setMessage(t("switching"));
            const originalText = button.textContent;
            setProfileBusy(item, true);
            button.textContent = t("switching");
            try {
              const payload = await post(button.dataset.action === "claude" ? "/api/claude/use" : "/api/proxy/use", {
                name: profile.name,
                restartCodex: true,
              });
              setMessage(switchMessage(payload));
              await loadProfiles();
              await loadProxyStatus();
            } catch (error) {
              setMessage(error.message, true);
            } finally {
              setProfileBusy(item, false);
              button.textContent = originalText;
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

      const _ap = currentProxyStatus?.activeProfile || "";
      const _ac = currentProxyStatus?.activeClaudeProfile || "";
      profilesEl.innerHTML = relayProfiles.length
        ? relayProfiles.map((p) => profileHtml(p, _ap, _ac)).join("")
        : '<div class="empty-state">' + escapeHtml(t("emptyRelays")) + '</div>';

      bindProfileActions(profilesEl, relayProfiles);
      if (routeProfile) {
        routeProfile.innerHTML = relayProfiles.length
          ? relayProfiles.map((profile) => '<option value="' + escapeHtml(profile.name) + '">' + escapeHtml(profile.name) + '</option>').join("")
          : '<option value=""></option>';
      }
      await loadRoutes();
    }

    function routeHtml(route) {
      return '<div class="mini-row" data-client="' + escapeHtml(route.client) + '" data-model="' + escapeHtml(route.model) + '">' +
        '<div>' +
          '<strong>' + escapeHtml(route.client + ' / ' + route.model) + '</strong>' +
          '<span>' + escapeHtml(route.profile + ' / ' + route.upstreamModel) + '</span>' +
        '</div>' +
        '<button type="button" class="danger" data-action="remove-route">' + escapeHtml(t("routeRemove")) + '</button>' +
      '</div>';
    }

    function bindRouteActions() {
      if (!routesList) return;
      routesList.querySelectorAll("button[data-action='remove-route']").forEach((button) => {
        button.addEventListener("click", async () => {
          const row = button.closest(".mini-row");
          try {
            const payload = await post("/api/routes/remove", {
              client: row.dataset.client,
              model: row.dataset.model,
            });
            setMessage(payload.message);
            renderRoutes(payload.routes || []);
          } catch (error) {
            setMessage(error.message, true);
          }
        });
      });
    }

    function renderRoutes(routes) {
      if (!routesList) return;
      routesList.innerHTML = routes.length
        ? routes.map(routeHtml).join("")
        : '<div class="hint">' + escapeHtml(t("noRoutes")) + '</div>';
      bindRouteActions();
    }

    async function loadRoutes() {
      try {
        const response = await fetch("/api/routes");
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Request failed.");
        renderRoutes(payload.routes || []);
      } catch (error) {
        routesList.innerHTML = '<div class="hint">' + escapeHtml(error.message) + '</div>';
      }
    }

    function renderHealth() {}
    async function loadHealth() {}

    async function loadRequests() {
      try {
        const response = await fetch("/api/logs");
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Request failed.");
        renderRequests(payload.recent || []);
      } catch (error) {
        requestList.innerHTML = '<div class="hint">' + escapeHtml(error.message) + '</div>';
      }
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
        setMessage(payload.message, false, true);
        formDirty = false;
        updateCommand();
        await loadProfiles();
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    document.querySelector("#remove").addEventListener("click", async () => {
      const name = document.querySelector("#name").value || "";
      if (!window.confirm(t("removeConfirm", { name }))) return;
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

    document.querySelector("#account-mode").addEventListener("click", async () => {
      if (!window.confirm(t("accountConfirm"))) return;
      setMessage(t("switching"));
      try {
        const payload = await post("/api/account", { restartCodex: true });
        setMessage(payload.message);
        await loadProfiles();
        await loadProxyStatus();
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    if (routeForm) routeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(routeForm).entries());
      try {
        const payload = await post("/api/routes", data);
        setMessage(payload.message);
        renderRoutes(payload.routes || []);
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    document.querySelector("#health-refresh")?.addEventListener("click", async () => {
      await loadHealth();
    });
    document.querySelector("#requests-refresh").addEventListener("click", async () => {
      await loadRequests();
    });
    document.querySelector("#service-status-refresh").addEventListener("click", async () => {
      await loadServiceStatus();
    });

    // Import/Export
    document.querySelector("#import-profiles").addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = ".json";
      input.addEventListener("change", async () => {
        const file = input.files[0]; if (!file) return;
        try {
          const text = await file.text();
          const payload = await post("/api/profiles/import", { json: text });
          setMessage(payload.message);
          await loadProfiles();
        } catch (error) { setMessage(error.message, true); }
      });
      input.click();
    });
    document.querySelector("#export-profiles").addEventListener("click", async () => {
      try {
        const response = await fetch("/api/profiles/export");
        const payload = await response.json();
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = "api-switch-profiles.json"; a.click();
        URL.revokeObjectURL(url);
      } catch (error) { setMessage(error.message, true); }
    });

    // Expand request log
    let requestLimit = 12;
    document.querySelector("#requests-expand")?.addEventListener("click", () => {
      requestLimit += 20;
      loadRequests();
    });

    document.querySelector("#supportedEndpoint").addEventListener("change", (event) => {
      const anthropicField = document.querySelector("#anthropicBaseUrl").closest("label");
      if (event.target.value === "anthropic-messages") {
        anthropicField.style.display = "";
        const field = document.querySelector("#anthropicBaseUrl");
        if (!field.value) field.value = document.querySelector("#baseUrl").value;
      } else {
        anthropicField.style.display = "none";
      }
    });
    document.querySelector("#lang-zh").addEventListener("click", () => {
      lang = "zh";
      localStorage.setItem("api-switch-lang", lang);
      applyLanguage();
    });
    document.querySelector("#lang-en").addEventListener("click", () => {
      lang = "en";
      localStorage.setItem("api-switch-lang", lang);
      applyLanguage();
    });

    updateCommand();
    applyLanguage();
    setInterval(loadProxyStatus, 4000);
    loadHealth();
    loadRequests();
    loadServiceStatus();
    loadProfiles().catch((error) => {
      profilesEl.innerHTML = '<div class="hint">' + error.message + '</div>';
    });
  </script>
</body>
</html>`;
}

async function runRelayTest(profile, apiKey) {
  if (!profile) throw new Error("Relay profile is required.");
  const protocol = profile.codexUpstreamProtocol || profile.upstreamProtocol || "";
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" };

  let url, body;
  if (protocol === "chat-completions") {
    url = chatCompletionsUrl(profile.baseUrl);
    body = JSON.stringify({ model: profile.model, messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 8, stream: false });
  } else if (protocol === "completions") {
    url = completionsUrl(profile.baseUrl);
    body = JSON.stringify({ model: profile.model, prompt: "Reply with exactly: ok", max_tokens: 8, stream: false });
  } else {
    url = responsesUrl(profile.baseUrl);
    body = JSON.stringify({ model: profile.model, input: "Reply with exactly: ok", max_output_tokens: 8, stream: false });
  }

  const response = await fetch(url, { method: "POST", headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Relay test failed with HTTP ${response.status}: ${parseErrorMessage(text) || text.slice(0, 240)}`);
  }
  return `${protocol || "responses"} ok (${response.status}).`;
}

function normalizeWebPayload(body) {
  const name = String(body.name || "").trim();
  const supportedEndpoint = String(body.supportedEndpoint || "").trim();
  let anthropicBaseUrl = String(body.anthropicBaseUrl || "").trim();
  let codexUpstreamProtocol = String(body.codexUpstreamProtocol || body.upstreamProtocol || "").trim();
  let claudeUpstreamProtocol = String(body.claudeUpstreamProtocol || "").trim();
  if (supportedEndpoint === "chat-completions") {
    codexUpstreamProtocol = "chat-completions";
    claudeUpstreamProtocol = "chat-completions";
    anthropicBaseUrl = "";
  } else if (supportedEndpoint === "responses") {
    codexUpstreamProtocol = "responses";
    claudeUpstreamProtocol = "";
    anthropicBaseUrl = "";
  } else if (supportedEndpoint === "anthropic-messages") {
    codexUpstreamProtocol = "";
    claudeUpstreamProtocol = "anthropic-messages";
    anthropicBaseUrl = anthropicBaseUrl || String(body.baseUrl || "").trim();
  }
  return {
    name,
    profileType: String(body.profileType || body.type || "relay").trim() || "relay",
    baseUrl: String(body.baseUrl || "").trim(),
    anthropicBaseUrl,
    codexUpstreamProtocol,
    claudeUpstreamProtocol,
    model: String(body.model || "").trim(),
    keyEnv: body.useEnv ? String(body.keyEnv || "").trim() : undefined,
    secret: body.useEnv ? undefined : String(body.apiKey || "").trim(),
    fallbackProfiles: String(body.fallbackProfiles || "").split(",").map((name) => name.trim()).filter(Boolean),
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

function proxySettingsPath(codexHome) {
  return apiSwitchDataPath(codexHome, "proxy-settings.json");
}

function readProxySettings(codexHome) {
  const settingsPath = proxySettingsPath(codexHome);
  const defaults = {
    enabled: true,
    clients: {
      codex: { targetProfile: "" },
      "claude-code": { targetProfile: "" },
    },
  };
  if (!fs.existsSync(settingsPath)) return defaults;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const clients = settings.clients && typeof settings.clients === "object" ? settings.clients : {};
    const legacyTarget = typeof settings.targetProfile === "string" ? settings.targetProfile : "";
    return {
      enabled: settings.enabled !== false,
      clients: {
        codex: {
          targetProfile: typeof clients.codex?.targetProfile === "string" ? clients.codex.targetProfile : legacyTarget,
        },
        "claude-code": {
          targetProfile: typeof clients["claude-code"]?.targetProfile === "string" ? clients["claude-code"].targetProfile : "",
        },
      },
    };
  } catch {
    return defaults;
  }
}

function writeProxySettings(codexHome, settings) {
  const settingsPath = proxySettingsPath(codexHome);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  atomicWriteFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

function proxyRequestsPath(codexHome) {
  return apiSwitchDataPath(codexHome, "proxy-requests.jsonl");
}

function appendProxyRequest(codexHome, entry) {
  const logPath = proxyRequestsPath(codexHome);
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function readRecentProxyRequests(codexHome, limit = 50) {
  const logPath = proxyRequestsPath(codexHome);
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function startWeb(args) {
  const host = args.host || "127.0.0.1";
  const port = Number(args.port || DEFAULT_PORT);
  const codexHome = expandHome(args.codexHome || "~/.codex");
  const proxyState = readProxySettings(codexHome);
  const recentProxyRequests = readRecentProxyRequests(codexHome, 50);
  let server;
  const proxyUrl = () => {
    const address = server && server.address();
    const actualPort = address && typeof address === "object" ? address.port : port;
    return `http://${host}:${actualPort}/v1`;
  };
  const recordProxyRequest = (entry) => {
    const target = entry.profile || proxyState.clients[entry.client || "codex"]?.targetProfile || "";
    const managed = target ? getManagedProfile(codexHome, target) : null;
    const protocol = managed ? (managed.codexUpstreamProtocol || managed.upstreamProtocol || "responses") : "";
    const record = { ...entry, protocol, at: new Date().toISOString() };
    recentProxyRequests.unshift(record);
    recentProxyRequests.splice(50);
    appendProxyRequest(codexHome, record);
  };
  const proxyHandler = createProxyHandler({
    host,
    port,
    currentProfileName: () => proxyState.clients.codex.targetProfile || "",
    getActiveProfile: (client = "codex") => {
      const targetProfile = proxyState.clients[client] && proxyState.clients[client].targetProfile;
      if (targetProfile) {
        const profile = getManagedProfile(codexHome, targetProfile);
        if (profile) return profile;
      }
      return null;
    },
    getFallbackProfiles: (client) => proxyFallbackProfiles(codexHome, client),
    resolveModelRoute: (client, requestedModel, activeProfile) => resolveModelRoute(codexHome, client, requestedModel, activeProfile),
    getApiKey: profileApiKey,
    debugDir: apiSwitchDataPath(codexHome),
    recordRequest: recordProxyRequest,
  });

  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}:${port}`);
      if (url.pathname === "/health" || url.pathname.startsWith("/v1/")) {
        if (!proxyState.enabled) {
          sendJson(res, 503, { ok: false, error: "API Switch proxy is stopped." });
          return;
        }
        await proxyHandler(req, res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        const body = htmlPage();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/proxy/status") {
        const codexTarget = proxyState.clients.codex.targetProfile;
        const claudeTarget = proxyState.clients["claude-code"].targetProfile;
        const profile = codexTarget
          ? getManagedProfile(codexHome, codexTarget)
          : null;
        const claudeProfile = claudeTarget
          ? getManagedProfile(codexHome, claudeTarget)
          : null;
        sendJson(res, 200, {
          enabled: proxyState.enabled,
          proxyUrl: proxyUrl(),
          activeProfile: codexTarget || null,
          activeModel: profile ? profile.model : null,
          activeClaudeProfile: claudeTarget || null,
          activeClaudeModel: claudeProfile ? claudeProfile.model : null,
          clients: proxyState.clients,
          recent: recentProxyRequests,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/proxy/start") {
        proxyState.enabled = true;
        writeProxySettings(codexHome, proxyState);
        sendJson(res, 200, { message: "API Switch proxy started.", enabled: true, proxyUrl: proxyUrl(), diagnostics: proxyDiagnostics(codexHome, proxyUrl()) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/proxy/stop") {
        proxyState.enabled = false;
        writeProxySettings(codexHome, proxyState);
        sendJson(res, 200, { message: "API Switch proxy stopped.", enabled: false, proxyUrl: proxyUrl(), diagnostics: proxyDiagnostics(codexHome, proxyUrl()) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/proxy/restart") {
        proxyState.enabled = true;
        writeProxySettings(codexHome, proxyState);
        sendJson(res, 200, { message: "API Switch proxy restarted.", enabled: true, proxyUrl: proxyUrl(), diagnostics: proxyDiagnostics(codexHome, proxyUrl()) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/profiles") {
        sendJson(res, 200, { profiles: listProfiles(codexHome) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/routes") {
        sendJson(res, 200, { routes: listRoutes(codexHome) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/targets") {
        sendJson(res, 200, switchTargets(codexHome));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/diagnostics") {
        sendJson(res, 200, proxyDiagnostics(codexHome, proxyUrl()));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/logs") {
        sendJson(res, 200, { recent: readRecentProxyRequests(codexHome, 100) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/profiles/export") {
        const profiles = listProfiles(codexHome);
        sendJson(res, 200, { version: 1, profiles });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/profiles/import") {
        const payload = await readJson(req);
        const data = JSON.parse(String(payload.json || "{}"));
        const imported = data.profiles || {};
        const store = readProfilesStore(codexHome);
        let count = 0;
        for (const [name, profile] of Object.entries(imported)) {
          if (!profile || typeof profile !== "object") continue;
          store[name] = { ...store[name], ...profile, name, updatedAt: new Date().toISOString() };
          count += 1;
        }
        writeProfilesStore(codexHome, store);
        sendJson(res, 200, { message: `Imported ${count} profile(s).`, count });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/capabilities") {
        const profiles = listProfiles(codexHome);
        sendJson(res, 200, { profiles: profiles.map((profile) => ({ name: profile.name, capabilities: modelCapabilities(profile.model) })) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/health/profiles") {
        sendJson(res, 200, { profiles: await profilesHealth(codexHome) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/service/status") {
        sendJson(res, 200, serviceStatusData());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/profile/capabilities") {
        const payload = await readJson(req);
        const profile = getManagedProfile(codexHome, String(payload.name || ""));
        if (!profile) {
          sendJson(res, 404, { error: "Profile not found." });
          return;
        }
        sendJson(res, 200, await detectProfileCapabilities(profile));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/setup") {
        const payload = normalizeWebPayload(await readJson(req));
        writeProfile({ ...payload, codexHome }, payload.secret);
        sendJson(res, 200, {
          message: `Saved profile '${payload.name}'.`,
          details: [`Profiles: ${profilesStorePath(codexHome)}`, "Choose Codex or Claude Code for this profile."],
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/remove") {
        const payload = normalizeWebPayload(await readJson(req));
        remove({ name: payload.name, codexHome });
        sendJson(res, 200, {
          message: `Removed profile '${payload.name}'.`,
          details: [`Profiles: ${profilesStorePath(codexHome)}`],
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/routes") {
        const payload = await readJson(req);
        routeCommand({
          codexHome,
          client: payload.client || "codex",
          model: payload.model,
          profile: payload.profile,
          upstreamModel: payload.upstreamModel,
        });
        sendJson(res, 200, { message: "Saved model route.", routes: listRoutes(codexHome) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/routes/remove") {
        const payload = await readJson(req);
        routeRemoveCommand({
          codexHome,
          client: payload.client || "codex",
          model: payload.model,
        });
        sendJson(res, 200, { message: "Removed model route.", routes: listRoutes(codexHome) });
        return;
      }

      if (req.method === "POST" && (url.pathname === "/api/proxy/use" || url.pathname === "/api/default")) {
        const payload = normalizeWebPayload(await readJson(req));
        const profile = getManagedProfile(codexHome, payload.name);
        if (!profile) {
          throw new Error(`Managed profile not found: ${payload.name}`);
        }
        const result = switchCodexToProxyMode(codexHome, profile, proxyUrl(), {
          noMigrateHistory: payload.noMigrateHistory,
        });
        Object.assign(proxyState, result.proxyState);
        proxyState.clients = result.proxyState.clients;
        const migration = result.migration;
        Object.assign(proxyState, result.proxyState || readProxySettings(codexHome));
        const restart = payload.restartCodex ? tryRestartCodexApp() : null;
        const diagnostics = proxyDiagnostics(codexHome, proxyUrl());
        const details = [
          `Config: ${path.join(codexHome, "config.toml")}`,
          `OpenAI base URL: ${proxyUrl()}`,
          `API key: ${PROXY_API_KEY}`,
          migration
            ? `Moved ${migration.changed} thread(s), updated ${migration.modelChanged} thread model(s) to '${profile.model}', updated ${migration.rolloutChanged} rollout provider file(s), updated ${migration.rolloutModelChanged} rollout model file(s), and repaired ${migration.repairedRolloutPaths} rollout path(s) to provider 'openai'. Backup: ${migration.backupPath}`
            : "Threads already use the OpenAI API provider.",
          "Run: codex",
        ];
        if (restart && !restart.ok) details.push(restart.message);
        if (!diagnostics.ready) {
          const failed = diagnostics.checks.filter((check) => !check.ok && check.level !== "warning").map((check) => check.label).join("; ");
          details.push(`Check needs attention: ${failed || "Unknown diagnostic failure."}`);
        }
        sendJson(res, 200, {
          message: restart && !restart.ok
            ? `Switched Codex to local proxy for '${payload.name}', but Codex restart needs manual action.`
            : payload.restartCodex
              ? `Switched Codex to local proxy for '${payload.name}' and restarted the app.`
              : `Switched Codex to local proxy for '${payload.name}'.`,
          details,
          diagnostics,
          restart,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/account") {
        const payload = normalizeWebPayload(await readJson(req));
        const result = switchCodexToAccountMode(codexHome, {
          noMigrateHistory: payload.noMigrateHistory,
        });
        Object.assign(proxyState, result.proxyState || readProxySettings(codexHome));
        proxyState.clients = (result.proxyState || readProxySettings(codexHome)).clients;
        const migration = result.migration;
        const restart = payload.restartCodex ? tryRestartCodexApp() : null;
        const diagnostics = proxyDiagnostics(codexHome, proxyUrl());
        const details = [
          `Config: ${path.join(codexHome, "config.toml")}`,
          migration
            ? `Moved ${migration.changed} thread(s), updated ${migration.rolloutChanged} rollout file(s), and repaired ${migration.repairedRolloutPaths} rollout path(s) to provider 'openai'. Backup: ${migration.backupPath}`
            : "Threads already use the account provider.",
          "Run: codex",
        ];
        if (restart && !restart.ok) details.push(restart.message);
        if (!diagnostics.ready) {
          const failed = diagnostics.checks.filter((check) => !check.ok && check.level !== "warning").map((check) => check.label).join("; ");
          details.push(`Check needs attention: ${failed || "Unknown diagnostic failure."}`);
        }
        sendJson(res, 200, {
          message: restart && !restart.ok
            ? "Switched Codex to ChatGPT account login, but Codex restart needs manual action."
            : payload.restartCodex
              ? "Switched Codex to ChatGPT account login and restarted the app."
              : "Switched Codex to ChatGPT account login.",
          details,
          diagnostics,
          restart,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/claude/use") {
        const payload = normalizeWebPayload(await readJson(req));
        switchClaudeCodeToProxyMode({ ...args, codexHome, name: payload.name, host, port });
        Object.assign(proxyState, readProxySettings(codexHome));
        sendJson(res, 200, {
          message: `Switched Claude Code to local proxy for '${payload.name}'.`,
          details: [
            `Settings: ${claudeSettingsPath(args)}`,
            `ANTHROPIC_BASE_URL: http://${host}:${port}`,
            `ANTHROPIC_AUTH_TOKEN: ${PROXY_API_KEY}`,
          ],
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/claude/account") {
        switchClaudeCodeToAccountMode({ ...args, codexHome });
        Object.assign(proxyState, readProxySettings(codexHome));
        sendJson(res, 200, {
          message: "Switched Claude Code back to its original settings.",
          details: [`Settings: ${claudeSettingsPath(args)}`],
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
        const profile = getManagedProfile(codexHome, payload.name);
        if (!profile) {
          throw new Error(`Managed profile not found: ${payload.name}`);
        }
        const output = await runRelayTest(profile, profileApiKey(profile));
        sendJson(res, 200, {
          message: `Relay test completed for '${payload.name}'.`,
          output,
        });
        return;
      }

      sendJson(res, 404, { error: "Not found." });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
  });

  server.on("error", async (error) => {
    if (error && error.code === "EADDRINUSE") {
      const url = `http://${host}:${port}`;
      if (await isApiSwitchRunning(url)) {
        console.log(`API Switch web UI is already running: ${url}`);
        if (!args.noOpen) openBrowser(url);
        // In foreground CLI mode this is just a friendly success.  Under a
        // service manager (LaunchAgent/systemd/Startup wrapper), exiting here
        // can create a restart loop when a stale foreground instance already
        // owns the port.  Keep the service process alive so KeepAlive does not
        // spin, and so a later stop of the stale owner lets the service bind.
        if (process.env.API_SWITCH_SERVICE_MANAGER === "1") {
          setInterval(() => {}, 60 * 60 * 1000);
          return;
        }
        process.exit(0);
      }
      console.error(`Port is already in use: ${url}`);
      console.error("Stop the process using that port or start API Switch with --port <port>.");
      process.exit(1);
    }
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
  server.listen(port, host, () => {
    const address = server.address();
    const url = `http://${host}:${address.port}`;
    console.log(`API Switch web UI: ${url}`);
    if (!args.noOpen) {
      openBrowser(url);
    }
  });
}

async function isApiSwitchRunning(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return false;
    const payload = await response.json();
    return Boolean(payload && payload.ok === true && payload.client === "codex");
  } catch {
    return false;
  }
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

  if (args.command === "claude-proxy") {
    switchClaudeCodeToProxyMode(args);
    return;
  }

  if (args.command === "claude-account") {
    switchClaudeCodeToAccountMode(args);
    return;
  }

  if (args.command === "service-install") {
    serviceInstall(args);
    return;
  }

  if (args.command === "service-uninstall") {
    serviceUninstall(args);
    return;
  }

  if (args.command === "service-status") {
    serviceStatus(args);
    return;
  }

  if (args.command === "model") {
    modelCommand(args);
    return;
  }

  if (args.command === "route") {
    routeCommand(args);
    return;
  }

  if (args.command === "route-remove") {
    routeRemoveCommand(args);
    return;
  }

  if (args.command === "routes") {
    routesCommand(args);
    return;
  }

  if (args.command === "thread-model") {
    threadModelCommand(args);
    return;
  }

  if (args.command === "repair-encrypted-content") {
    repairEncryptedContentCommand(args);
    return;
  }

  if (args.command === "web") {
    startWeb(args);
    return;
  }

  if (args.command === "proxy") {
    startProxy(args);
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
