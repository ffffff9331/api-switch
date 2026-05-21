const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const bin = path.join(__dirname, "..", "bin", "api-switch.js");
const { responsesToChatPayload } = require("../lib/proxy/chat-bridge");
const { adapterForModel, capabilitiesForModel, routeModel } = require("../lib/proxy/provider-registry");

function waitForWebUrl(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for web server. Output: ${output}`)), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/API Switch web UI: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Web server exited with code ${code}. Output: ${output}`));
      }
    });
  });
}

function waitForProxyUrl(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for proxy server. Output: ${output}`)), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/API Switch proxy: (http:\/\/127\.0\.0\.1:\d+\/v1)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Proxy server exited with code ${code}. Output: ${output}`));
      }
    });
  });
}

describe("api-switch", () => {
  it("routes provider capabilities through the provider registry", () => {
    assert.equal(routeModel("gpt-5.5").family, "openai");
    assert.equal(routeModel("gpt-5.5").upstreamProtocol, "responses");
    assert.equal(routeModel("claude-opus-4-6").family, "claude");
    assert.equal(routeModel("claude-opus-4-6").upstreamProtocol, "chat-completions");
    assert.equal(routeModel("unknown-model").family, "generic");
    assert.equal(routeModel("unknown-model").upstreamProtocol, "responses");
    assert.equal(capabilitiesForModel("claude-opus-4-6").messages, true);
    assert.equal(capabilitiesForModel("gpt-5.5").messages, false);
    assert.equal(typeof adapterForModel("claude-opus-4-6").proxyResponses, "function");
    assert.equal(typeof adapterForModel("gpt-5.5").proxyResponses, "function");
  });

  it("keeps Codex built-in tool declarations when bridging to chat completions", () => {
    const payload = responsesToChatPayload({
      model: "claude-opus-4-6",
      input: "inspect files",
      tools: [{ type: "local_shell", description: "Run a local shell command." }],
    }, "claude-opus-4-6");

    assert.equal(payload.tools[0].type, "function");
    assert.equal(payload.tools[0].function.name, "local_shell");
    assert.equal(payload.tools[0].function.parameters.additionalProperties, true);
  });

  it("writes a relay profile outside Codex config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const result = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      {
        input: "sk-test\n",
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(dir, "config.toml")), false);
    const store = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "profiles.json"), "utf8"));
    assert.equal(store.profiles.vayne.baseUrl, "https://api.vayne.cc.cd/v1");
    assert.equal(store.profiles.vayne.model, "gpt-5.5");
    assert.equal(store.profiles.vayne.keyFile, path.join(dir, "vayne_api_key"));
    assert.doesNotMatch(JSON.stringify(store), /sk-test/);
    assert.equal(fs.readFileSync(path.join(dir, "vayne_api_key"), "utf8"), "sk-test\n");
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "vayne_models.json"), "utf8"));
    assert.equal(catalog.models[0].slug, "gpt-5.5");
    assert.equal(catalog.models[0].visibility, "list");
  });

  it("removes a relay profile from the API Switch profile store", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      {
        input: "sk-test\n",
        encoding: "utf8",
      },
    );

    const result = spawnSync(process.execPath, [bin, "remove", "--codex-home", dir, "--name", "vayne"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const store = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "profiles.json"), "utf8"));
    assert.equal(store.profiles.vayne, undefined);
  });

  it("can delete the local key file when removing a profile", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-test\n", encoding: "utf8" },
    );

    const result = spawnSync(
      process.execPath,
      [bin, "remove", "--codex-home", dir, "--name", "vayne", "--delete-key"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(dir, "vayne_api_key")), false);
  });

  it("does not switch Codex to proxy mode when the target API key is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);
    fs.unlinkSync(path.join(dir, "vayne_api_key"));

    const result = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /API key not found/);
    assert.equal(fs.existsSync(path.join(dir, "auth.json")), false);
    const config = fs.existsSync(path.join(dir, "config.toml")) ? fs.readFileSync(path.join(dir, "config.toml"), "utf8") : "";
    assert.doesNotMatch(config, /openai_base_url/);
  });

  it("rolls Codex config and auth back if history migration fails during proxy switch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    fs.writeFileSync(path.join(dir, "auth.json"), `${JSON.stringify({ auth_mode: "chatgpt", tokens: { id: "account" } }, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, "config.toml"), 'model = "gpt-5.5"\n');
    fs.writeFileSync(path.join(dir, "state_5.sqlite"), "not a sqlite database");
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const result = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    assert.equal(config, 'model = "gpt-5.5"\n');
    const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    assert.equal(auth.auth_mode, "chatgpt");
    assert.equal(auth.tokens.id, "account");
    assert.equal(fs.existsSync(path.join(dir, "codex-switch", "proxy-settings.json")), false);
  });

  it("can store multiple relay profiles", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const first = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    const second = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "backup",
        "--base-url",
        "https://relay.example.com/v1",
        "--model",
        "gpt-5.4",
      ],
      { input: "sk-two\n", encoding: "utf8" },
    );

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const store = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "profiles.json"), "utf8"));
    assert.equal(store.profiles.vayne.baseUrl, "https://api.vayne.cc.cd/v1");
    assert.equal(store.profiles.backup.baseUrl, "https://relay.example.com/v1");
    assert.doesNotMatch(JSON.stringify(store), /sk-one|sk-two/);
  });

  it("updates the model for an existing relay profile without replacing the key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const result = spawnSync(
      process.execPath,
      [
        bin,
        "model",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--model",
        "gpt-5.4",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const store = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "profiles.json"), "utf8"));
    assert.equal(store.profiles.vayne.model, "gpt-5.4");
    assert.equal(store.profiles.vayne.baseUrl, "https://api.vayne.cc.cd/v1");
    assert.equal(fs.readFileSync(path.join(dir, "vayne_api_key"), "utf8"), "sk-one\n");
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "vayne_models.json"), "utf8"));
    assert.deepEqual(
      catalog.models.map((model) => model.slug).sort(),
      ["gpt-5.4", "gpt-5.5"],
    );
  });

  it("sets proxy mode without writing a default Codex profile key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const configPath = path.join(dir, "config.toml");
    const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    fs.writeFileSync(configPath, `profile = "old"\n${original}`);

    const result = spawnSync(
      process.execPath,
      [
        bin,
        "default",
        "--codex-home",
        dir,
        "--name",
        "vayne",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const config = fs.readFileSync(configPath, "utf8");
    assert.doesNotMatch(config, /^profile = "vayne"$/m);
    assert.match(config, /openai_base_url = "http:\/\/127\.0\.0\.1:18600\/v1"/);
    assert.match(config, /forced_login_method = "api"/);
    const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    assert.equal(auth.OPENAI_API_KEY, "api-switch");
    const proxySettings = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "proxy-settings.json"), "utf8"));
    assert.equal(proxySettings.clients.codex.targetProfile, "vayne");
    assert.equal(proxySettings.clients["claude-code"].targetProfile, "");
  });

  it("imports a legacy Codex config profile before cleaning old blocks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    fs.mkdirSync(path.join(dir, "codex-switch"), { recursive: true });
    fs.writeFileSync(path.join(dir, "vayne_api_key"), "sk-one\n", { mode: 0o600 });
    fs.writeFileSync(
      path.join(dir, "config.toml"),
      [
        "# >>> codex-switch:vayne",
        "[profiles.vayne]",
        'model_provider = "vayne"',
        'model = "gpt-5.5"',
        `model_catalog_json = "${path.join(dir, "codex-switch", "vayne_models.json").replace(/\\/g, "\\\\")}"`,
        "",
        "[model_providers.vayne]",
        'name = "vayne"',
        'base_url = "https://api.vayne.cc.cd/v1"',
        'wire_api = "responses"',
        'auth.command = "cat"',
        `auth.args = ["${path.join(dir, "vayne_api_key").replace(/\\/g, "\\\\")}"]`,
        "# <<< codex-switch:vayne",
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    assert.doesNotMatch(config, /# >>> codex-switch:vayne/);
    assert.match(config, /openai_base_url = "http:\/\/127\.0\.0\.1:18600\/v1"/);
    const store = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "profiles.json"), "utf8"));
    assert.equal(store.profiles.vayne.baseUrl, "https://api.vayne.cc.cd/v1");
    assert.equal(store.profiles.vayne.model, "gpt-5.5");
    assert.equal(store.profiles.vayne.importedFrom, "legacy-config");
    const proxySettings = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "proxy-settings.json"), "utf8"));
    assert.equal(proxySettings.clients.codex.targetProfile, "vayne");
  });

  it("keeps threads on openai provider and updates models for the selected proxy target", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const dbPath = path.join(dir, "state_5.sqlite");
    const activeRollout = path.join(dir, "active.jsonl");
    const archivedRollout = path.join(dir, "archived.jsonl");
    fs.writeFileSync(
      activeRollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "active-account", model_provider: "openai" } })}\n`,
    );
    fs.writeFileSync(
      archivedRollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "archived-account", model_provider: "openai" } })}\n`,
    );
    spawnSync(
      "sqlite3",
      [
        dbPath,
        [
          "create table threads (id text primary key, archived integer default 0, model text, model_provider text, rollout_path text);",
          `insert into threads (id, archived, model, model_provider, rollout_path) values ('active-account', 0, 'gpt-5.4', 'openai', '${activeRollout.replace(/'/g, "''")}');`,
          "insert into threads (id, archived, model, model_provider, rollout_path) values ('active-relay', 0, 'gpt-5.5', 'vayne', '');",
          `insert into threads (id, archived, model, model_provider, rollout_path) values ('archived-account', 1, 'gpt-5.4', 'openai', '${archivedRollout.replace(/'/g, "''")}');`,
        ].join(" "),
      ],
      { encoding: "utf8" },
    );

    const result = spawnSync(
      process.execPath,
      [bin, "default", "--codex-home", dir, "--name", "vayne"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Moved 1 thread\(s\) to provider: openai/);
    assert.match(result.stdout, /Updated 2 thread model\(s\) to: gpt-5\.5/);
    assert.doesNotMatch(result.stdout, /Updated 2 rollout file\(s\)/);
    const rows = spawnSync(
      "sqlite3",
      [dbPath, "select id || '|' || model || '|' || model_provider from threads order by id;"],
      { encoding: "utf8" },
    );
    assert.equal(rows.status, 0, rows.stderr);
    assert.match(rows.stdout, /active-account\|gpt-5\.5\|openai/);
    assert.match(rows.stdout, /active-relay\|gpt-5\.5\|openai/);
    assert.match(rows.stdout, /archived-account\|gpt-5\.5\|openai/);
    assert.equal(JSON.parse(fs.readFileSync(activeRollout, "utf8").split("\n")[0]).payload.model_provider, "openai");
    assert.equal(JSON.parse(fs.readFileSync(archivedRollout, "utf8").split("\n")[0]).payload.model_provider, "openai");
    assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("active.jsonl.codex-switch-")).length, 0);
    assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("archived.jsonl.codex-switch-")).length, 0);
    assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("state_5.sqlite.codex-switch-")).length, 1);
  });

  it("preserves Codex workspace and git metadata while switching to proxy mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const dbPath = path.join(dir, "state_5.sqlite");
    spawnSync(
      "sqlite3",
      [
        dbPath,
        [
          "create table threads (id text primary key, archived integer default 0, model text, model_provider text, rollout_path text, workspace_id text, repo_id text, git_root text, branch text);",
          "insert into threads (id, archived, model, model_provider, rollout_path, workspace_id, repo_id, git_root, branch) values ('workspace-thread', 0, 'gpt-5.4', 'openai', '', 'ws-account', 'repo-account', '/Users/fan/project', 'main');",
        ].join(" "),
      ],
      { encoding: "utf8" },
    );

    const result = spawnSync(
      process.execPath,
      [bin, "default", "--codex-home", dir, "--name", "vayne"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const rows = spawnSync(
      "sqlite3",
      [dbPath, "select id || '|' || model || '|' || model_provider || '|' || workspace_id || '|' || repo_id || '|' || git_root || '|' || branch from threads;"],
      { encoding: "utf8" },
    );
    assert.equal(rows.status, 0, rows.stderr);
    assert.equal(rows.stdout.trim(), "workspace-thread|gpt-5.5|openai|ws-account|repo-account|/Users/fan/project|main");
  });

  it("repairs stale rollout metadata even when database threads already use the provider", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const dbPath = path.join(dir, "state_5.sqlite");
    const rollout = path.join(dir, "stale.jsonl");
    fs.writeFileSync(
      rollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "stale", model_provider: "openai" } })}\n`,
    );
    spawnSync(
      "sqlite3",
      [
        dbPath,
        [
          "create table threads (id text primary key, archived integer default 0, model text, model_provider text, rollout_path text);",
          `insert into threads (id, archived, model, model_provider, rollout_path) values ('stale', 0, 'gpt-5.5', 'vayne', '${rollout.replace(/'/g, "''")}');`,
        ].join(" "),
      ],
      { encoding: "utf8" },
    );

    const result = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Moved 1 thread\(s\) to provider: openai/);
    assert.match(result.stdout, /Updated 0 rollout file\(s\)/);
    assert.equal(JSON.parse(fs.readFileSync(rollout, "utf8").split("\n")[0]).payload.model_provider, "openai");
  });

  it("updates rollout metadata without reading the whole rollout into memory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const dbPath = path.join(dir, "state_5.sqlite");
    const rollout = path.join(dir, "large-rollout.jsonl");
    const firstLine = JSON.stringify({ type: "session_meta", payload: { id: "large-rollout", model_provider: "openai" } });
    const tailMarker = "\n" + JSON.stringify({ type: "response", payload: { text: "tail-marker" } }) + "\n";
    fs.writeFileSync(rollout, `${firstLine}\n`, { encoding: "utf8" });
    const fd = fs.openSync(rollout, "a");
    try {
      const chunk = Buffer.alloc(1024 * 1024, "x");
      for (let index = 0; index < 6; index += 1) {
        fs.writeSync(fd, chunk);
      }
      fs.writeSync(fd, tailMarker);
    } finally {
      fs.closeSync(fd);
    }
    const sizeBefore = fs.statSync(rollout).size;
    spawnSync(
      "sqlite3",
      [
        dbPath,
        [
          "create table threads (id text primary key, archived integer default 0, model text, model_provider text, rollout_path text);",
          `insert into threads (id, archived, model, model_provider, rollout_path) values ('large-rollout', 0, 'gpt-5.4', 'openai', '${rollout.replace(/'/g, "''")}');`,
        ].join(" "),
      ],
      { encoding: "utf8" },
    );

    const result = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated 0 rollout file\(s\)/);
    const fdRead = fs.openSync(rollout, "r");
    const buffer = Buffer.alloc(512);
    const bytesRead = fs.readSync(fdRead, buffer, 0, buffer.length, 0);
    fs.closeSync(fdRead);
    const updatedFirstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    assert.equal(JSON.parse(updatedFirstLine).payload.model_provider, "openai");
    assert.equal(fs.statSync(rollout).size, sizeBefore);
    assert.equal(fs.readFileSync(rollout, "utf8").endsWith(tailMarker), true);
  });

  it("restores rollout paths that accidentally point at codex-switch backup files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const dbPath = path.join(dir, "state_5.sqlite");
    const rollout = path.join(dir, "restored.jsonl");
    const backupRollout = `${rollout}.codex-switch-20260514012055.bak`;
    fs.writeFileSync(
      backupRollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "restored", model_provider: "openai" } })}\n`,
    );
    spawnSync(
      "sqlite3",
      [
        dbPath,
        [
          "create table threads (id text primary key, archived integer default 0, model text, model_provider text, rollout_path text);",
          `insert into threads (id, archived, model, model_provider, rollout_path) values ('restored', 0, 'gpt-5.5', 'openai', '${backupRollout.replace(/'/g, "''")}');`,
        ].join(" "),
      ],
      { encoding: "utf8" },
    );

    const result = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Moved 0 thread\(s\) to provider: openai/);
    assert.match(result.stdout, /Updated 0 rollout file\(s\)/);
    assert.match(result.stdout, /Repaired 1 rollout path\(s\)/);
    assert.equal(fs.existsSync(rollout), true);
    assert.equal(JSON.parse(fs.readFileSync(rollout, "utf8").split("\n")[0]).payload.model_provider, "openai");
    const rows = spawnSync("sqlite3", [dbPath, "select model_provider || '|' || rollout_path from threads where id = 'restored';"], {
      encoding: "utf8",
    });
    assert.equal(rows.status, 0, rows.stderr);
    assert.equal(rows.stdout.trim(), `openai|${rollout}`);
  });

  it("lists account and relay profiles", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const result = spawnSync(process.execPath, [bin, "list", "--codex-home", dir], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Current: account/);
    assert.match(result.stdout, / account/);
    assert.match(result.stdout, / vayne/);
    assert.match(result.stdout, /model: gpt-5\.5/);
    assert.match(result.stdout, /base_url: https:\/\/api\.vayne\.cc\.cd\/v1/);
  });

  it("keeps account provider metadata when using proxy mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const dbPath = path.join(dir, "state_5.sqlite");
    spawnSync(
      "sqlite3",
      [
        dbPath,
        [
          "create table threads (id text primary key, archived integer default 0, model text, model_provider text, rollout_path text);",
          "insert into threads (id, archived, model, model_provider, rollout_path) values ('account-thread', 0, 'gpt-5.4', 'openai', '');",
        ].join(" "),
      ],
      { encoding: "utf8" },
    );

    const result = spawnSync(
      process.execPath,
      [bin, "default", "--codex-home", dir, "--name", "vayne"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const rows = spawnSync("sqlite3", [dbPath, "select model_provider from threads where id = 'account-thread';"], {
      encoding: "utf8",
    });
    assert.equal(rows.status, 0, rows.stderr);
    assert.equal(rows.stdout.trim(), "openai");
  });

  it("web switching migrates chat history even when restart is not requested", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const dbPath = path.join(dir, "state_5.sqlite");
    const rollout = path.join(dir, "web-active.jsonl");
    fs.writeFileSync(
      rollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "web-active", model_provider: "openai" } })}\n`,
    );
    spawnSync(
      "sqlite3",
      [
        dbPath,
        [
          "create table threads (id text primary key, archived integer default 0, model text, model_provider text, rollout_path text);",
          `insert into threads (id, archived, model, model_provider, rollout_path) values ('web-active', 0, 'gpt-5.4', 'openai', '${rollout.replace(/'/g, "''")}');`,
        ].join(" "),
      ],
      { encoding: "utf8" },
    );

    const server = spawn(process.execPath, [bin, "web", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForWebUrl(server);
      const response = await fetch(`${baseUrl}/api/proxy/use`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "vayne", restartCodex: false }),
      });
      const payload = await response.json();

      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.match(payload.details.join("\n"), /Moved 0 thread\(s\)/);
      assert.match(payload.details.join("\n"), /updated 1 thread model\(s\) to 'gpt-5\.5'/i);
      assert.match(payload.details.join("\n"), /OpenAI base URL: http:\/\/127\.0\.0\.1:\d+\/v1/);
      const rows = spawnSync("sqlite3", [dbPath, "select model_provider from threads where id = 'web-active';"], {
        encoding: "utf8",
      });
      assert.equal(rows.status, 0, rows.stderr);
      assert.equal(rows.stdout.trim(), "openai");
      assert.equal(JSON.parse(fs.readFileSync(rollout, "utf8").split("\n")[0]).payload.model_provider, "openai");
      const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
      assert.match(config, /openai_base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
      assert.match(config, /forced_login_method = "api"/);
      assert.doesNotMatch(config, /^profile\s*=/m);
      const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
      assert.equal(auth.auth_mode, "apikey");
      assert.equal(auth.OPENAI_API_KEY, "api-switch");
      const proxySettings = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "proxy-settings.json"), "utf8"));
      assert.equal(proxySettings.clients.codex.targetProfile, "vayne");
      assert.equal(proxySettings.enabled, true);
    } finally {
      server.kill();
    }
  });

  it("switching to a Claude profile migrates all history thread models", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "claude",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "claude-opus-4-6",
      ],
      { input: "sk-claude\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const dbPath = path.join(dir, "state_5.sqlite");
    spawnSync(
      "sqlite3",
      [
        dbPath,
        [
          "create table threads (id text primary key, archived integer default 0, model text, model_provider text, rollout_path text);",
          "insert into threads (id, archived, model, model_provider, rollout_path) values ('old-gpt', 0, 'gpt-5.5', 'vayne', '');",
          "insert into threads (id, archived, model, model_provider, rollout_path) values ('old-other-model', 0, 'gpt-5.4-mini', 'vayne', '');",
          "insert into threads (id, archived, model, model_provider, rollout_path) values ('old-openai', 1, 'gpt-5.5', 'openai', '');",
        ].join(" "),
      ],
      { encoding: "utf8" },
    );

    const result = spawnSync(
      process.execPath,
      [bin, "default", "--codex-home", dir, "--name", "claude"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated 3 thread model\(s\) to: claude-opus-4-6/);
    const rows = spawnSync(
      "sqlite3",
      [dbPath, "select id || '|' || model || '|' || model_provider from threads order by id;"],
      { encoding: "utf8" },
    );
    assert.equal(rows.status, 0, rows.stderr);
    assert.match(rows.stdout, /old-gpt\|claude-opus-4-6\|openai/);
    assert.match(rows.stdout, /old-openai\|claude-opus-4-6\|openai/);
    assert.match(rows.stdout, /old-other-model\|claude-opus-4-6\|openai/);
  });

  it("web switching to a Claude profile also migrates all history thread models", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "claude",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "claude-opus-4-6",
      ],
      { input: "sk-claude\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const dbPath = path.join(dir, "state_5.sqlite");
    spawnSync(
      "sqlite3",
      [
        dbPath,
        [
          "create table threads (id text primary key, archived integer default 0, model text, model_provider text, rollout_path text);",
          "insert into threads (id, archived, model, model_provider, rollout_path) values ('web-old', 0, 'gpt-5.5', 'openai', '');",
          "insert into threads (id, archived, model, model_provider, rollout_path) values ('web-other', 0, 'gpt-5.4-mini', 'openai', '');",
        ].join(" "),
      ],
      { encoding: "utf8" },
    );

    const server = spawn(process.execPath, [bin, "web", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForWebUrl(server);
      const response = await fetch(`${baseUrl}/api/proxy/use`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "claude", restartCodex: false }),
      });
      const payload = await response.json();

      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.match(payload.details.join("\n"), /updated 2 thread model\(s\) to 'claude-opus-4-6'/i);
      const rows = spawnSync(
        "sqlite3",
        [dbPath, "select id || '|' || model || '|' || model_provider from threads order by id;"],
        { encoding: "utf8" },
      );
      assert.equal(rows.status, 0, rows.stderr);
      assert.match(rows.stdout, /web-old\|claude-opus-4-6\|openai/);
      assert.match(rows.stdout, /web-other\|claude-opus-4-6\|openai/);
      const proxySettings = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "proxy-settings.json"), "utf8"));
      assert.equal(proxySettings.clients.codex.targetProfile, "claude");
    } finally {
      server.kill();
    }
  });

  it("web account mode restores account auth after proxy mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "auth.json"), `${JSON.stringify({ auth_mode: "chatgpt", tokens: { id: "account" } }, null, 2)}\n`);
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-one\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const server = spawn(process.execPath, [bin, "web", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForWebUrl(server);
      const proxy = await fetch(`${baseUrl}/api/proxy/use`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "vayne", restartCodex: false }),
      });
      assert.equal(proxy.status, 200, await proxy.text());
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8")).OPENAI_API_KEY, "api-switch");
      assert.match(fs.readFileSync(path.join(dir, "config.toml"), "utf8"), /openai_base_url/);

      const account = await fetch(`${baseUrl}/api/account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ restartCodex: false }),
      });
      assert.equal(account.status, 200, await account.text());
      const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
      assert.equal(auth.auth_mode, "chatgpt");
      assert.equal(auth.tokens.id, "account");
      const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
      assert.doesNotMatch(config, /openai_base_url/);
      assert.doesNotMatch(config, /forced_login_method/);
      const diagnostics = await fetch(`${baseUrl}/api/diagnostics`);
      const diagnosticsPayload = await diagnostics.json();
      assert.equal(diagnosticsPayload.mode, "account");
      assert.equal(diagnosticsPayload.ready, true);
      assert.equal(diagnosticsPayload.checks.find((check) => check.id === "account-clean-config").ok, true);
      assert.equal(diagnosticsPayload.checks.find((check) => check.id === "account-clean-auth").ok, true);
      const status = await fetch(`${baseUrl}/api/proxy/status`);
      const statusPayload = await status.json();
      assert.equal(statusPayload.clients.codex.targetProfile, "");
      assert.equal(statusPayload.activeProfile, null);
    } finally {
      server.kill();
    }
  });

  it("refreshes stale account auth backup before switching to proxy mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    fs.mkdirSync(path.join(dir, "codex-switch"), { recursive: true });
    fs.writeFileSync(path.join(dir, "codex-switch", "account-auth.backup.json"), `${JSON.stringify({ auth_mode: "chatgpt", tokens: { id: "old-account" } }, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, "auth.json"), `${JSON.stringify({ auth_mode: "chatgpt", tokens: { id: "new-account" } }, null, 2)}\n`);
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "vayne", "--base-url", "https://api.vayne.cc.cd/v1", "--model", "gpt-5.5"], {
      input: "sk-one\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);

    const proxy = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], { encoding: "utf8" });
    assert.equal(proxy.status, 0, proxy.stderr);
    const account = spawnSync(process.execPath, [bin, "account", "--codex-home", dir], { encoding: "utf8" });
    assert.equal(account.status, 0, account.stderr);

    const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    assert.equal(auth.tokens.id, "new-account");
  });

  it("rewrites rollout turn context models when switching profiles", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "claude",
        "--base-url",
        "https://api.vayne.cc.cd/v1",
        "--model",
        "claude-opus-4-6",
      ],
      { input: "sk-claude\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const dbPath = path.join(dir, "state_5.sqlite");
    const rollout = path.join(dir, "current-thread.jsonl");
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "current-thread", model_provider: "claude" } }),
        JSON.stringify({
          type: "turn_context",
          payload: {
            model: "gpt-5.5",
            collaboration_mode: { settings: { model: "gpt-5.5", reasoning_effort: "medium" } },
          },
        }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_started", model: "gpt-5.5" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user" } }),
        "",
      ].join("\n"),
      "utf8",
    );
    spawnSync(
      "sqlite3",
      [
        dbPath,
        [
          "create table threads (id text primary key, archived integer default 0, model text, model_provider text, rollout_path text);",
          `insert into threads (id, archived, model, model_provider, rollout_path) values ('current-thread', 0, 'gpt-5.5', 'claude', '${rollout.replace(/'/g, "''")}');`,
        ].join(" "),
      ],
      { encoding: "utf8" },
    );

    const result = spawnSync(
      process.execPath,
      [bin, "default", "--codex-home", dir, "--name", "claude"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated 1 thread model\(s\) to: claude-opus-4-6/);
    const lines = fs.readFileSync(rollout, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[1].payload.model, "claude-opus-4-6");
    assert.equal(lines[1].payload.collaboration_mode.settings.model, "claude-opus-4-6");
    assert.equal(lines[2].payload.model, "claude-opus-4-6");
  });

  it("switches back to account login by clearing the profile key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const configPath = path.join(dir, "config.toml");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, 'profile = "vayne"\nmodel = "gpt-5.5"\n');
    const dbPath = path.join(dir, "state_5.sqlite");
    const activeRollout = path.join(dir, "active-relay.jsonl");
    fs.writeFileSync(
      activeRollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "active-relay", model_provider: "vayne" } })}\n`,
    );
    spawnSync(
      "sqlite3",
      [
        dbPath,
        [
          "create table threads (id text primary key, archived integer default 0, model text, model_provider text, rollout_path text);",
          `insert into threads (id, archived, model, model_provider, rollout_path) values ('active-relay', 0, 'gpt-5.5', 'vayne', '${activeRollout.replace(/'/g, "''")}');`,
          "insert into threads (id, archived, model, model_provider, rollout_path) values ('archived-relay', 1, 'gpt-5.5', 'vayne', '');",
        ].join(" "),
      ],
      { encoding: "utf8" },
    );

    const result = spawnSync(
      process.execPath,
      [bin, "account", "--codex-home", dir],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const config = fs.readFileSync(configPath, "utf8");
    assert.doesNotMatch(config, /^profile\s*=/m);
    assert.match(config, /^model = "gpt-5\.5"$/m);
    assert.match(result.stdout, /Moved 2 thread\(s\) to provider: openai/);
    const rows = spawnSync(
      "sqlite3",
      [dbPath, "select id || '|' || model || '|' || model_provider from threads order by id;"],
      { encoding: "utf8" },
    );
    assert.equal(rows.status, 0, rows.stderr);
    assert.match(rows.stdout, /active-relay\|gpt-5\.5\|openai/);
    assert.match(rows.stdout, /archived-relay\|gpt-5\.5\|openai/);
    assert.equal(JSON.parse(fs.readFileSync(activeRollout, "utf8").split("\n")[0]).payload.model_provider, "openai");
    const proxySettings = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "proxy-settings.json"), "utf8"));
    assert.equal(proxySettings.clients.codex.targetProfile, "");
  });

  it("updates the latest desktop thread model in the state database", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const dbPath = path.join(dir, "state_5.sqlite");
    spawnSync(
      "sqlite3",
      [
        dbPath,
        [
          "create table threads (id text primary key, archived integer default 0, model text, model_provider text, created_at integer, updated_at integer, created_at_ms integer, updated_at_ms integer);",
          "insert into threads (id, archived, model, model_provider, created_at, updated_at, created_at_ms, updated_at_ms) values ('old-thread', 0, 'gpt-5.5', 'openai', 1, 1, 1000, 1000);",
          "insert into threads (id, archived, model, model_provider, created_at, updated_at, created_at_ms, updated_at_ms) values ('new-thread', 0, 'gpt-5.5', 'openai', 2, 2, 2000, 2000);",
        ].join(" "),
      ],
      { encoding: "utf8" },
    );

    const result = spawnSync(
      process.execPath,
      [
        bin,
        "thread-model",
        "--state-db",
        dbPath,
        "--provider",
        "vayne",
        "--model",
        "claude-opus-4-7",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated thread model: new-thread/);
    assert.match(result.stdout, /Backup:/);
    const rows = spawnSync(
      "sqlite3",
      [dbPath, "select id || '|' || model || '|' || model_provider from threads order by id;"],
      { encoding: "utf8" },
    );
    assert.equal(rows.status, 0, rows.stderr);
    assert.match(rows.stdout, /new-thread\|claude-opus-4-7\|vayne/);
    assert.match(rows.stdout, /old-thread\|gpt-5\.5\|openai/);
    assert.equal(fs.readdirSync(dir).filter((name) => name.includes(".bak")).length, 1);
  });

  it("advertises the web UI command", () => {
    const result = spawnSync(process.execPath, [bin, "--help"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /api-switch web/);
    assert.match(result.stdout, /api-switch proxy/);
    assert.match(result.stdout, /api-switch list/);
    assert.match(result.stdout, /api-switch account/);
    assert.match(result.stdout, /--delete-key/);
    assert.match(result.stdout, /--no-open/);
    assert.match(result.stdout, /--port <port>/);
    assert.match(result.stdout, /--restart-codex/);
    assert.match(result.stdout, /api-switch model --name <profile> --model <model>/);
    assert.match(result.stdout, /api-switch thread-model --model <model>/);
  });

  it("reports a friendly error when the default port is already in use", async () => {
    const blocker = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("busy");
    });
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = blocker.address().port;

    try {
      const web = spawnSync(process.execPath, [bin, "web", "--host", "127.0.0.1", "--port", String(port), "--no-open"], {
        encoding: "utf8",
      });
      assert.notEqual(web.status, 0);
      assert.match(web.stderr, /Port is already in use/);
      assert.doesNotMatch(web.stderr, /Unhandled 'error' event/);

      const proxy = spawnSync(process.execPath, [bin, "proxy", "--host", "127.0.0.1", "--port", String(port)], {
        encoding: "utf8",
      });
      assert.notEqual(proxy.status, 0);
      assert.match(proxy.stderr, /API Switch proxy port is already in use/);
      assert.doesNotMatch(proxy.stderr, /Unhandled 'error' event/);
    } finally {
      blocker.close();
    }
  });

  it("reuses an already-running API Switch web server", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const server = spawn(process.execPath, [bin, "web", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const webUrl = await waitForWebUrl(server);
      const port = new URL(webUrl).port;
      const second = spawnSync(process.execPath, [bin, "web", "--codex-home", dir, "--host", "127.0.0.1", "--port", port, "--no-open"], {
        encoding: "utf8",
      });
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /API Switch web UI is already running/);
      assert.doesNotMatch(second.stderr, /Unhandled 'error' event/);
    } finally {
      server.kill();
    }
  });

  it("starts a local proxy that exposes health, models, and responses", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chat_1", object: "chat.completion", model: payload.model, choices: [{ message: { role: "assistant", content: payload.messages[0].content } }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;

    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "claude",
        "--base-url",
        `http://127.0.0.1:${upstreamPort}/v1`,
        "--model",
        "claude-opus-4-6",
      ],
      { input: "sk-claude\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);

    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "claude"], {
      encoding: "utf8",
    });
    assert.equal(activate.status, 0, activate.stderr);

    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForProxyUrl(server);

      const health = await fetch(baseUrl.replace(/\/v1$/, "/health"));
      const healthPayload = await health.json();
      assert.equal(health.status, 200);
      assert.equal(healthPayload.activeProfile, "claude");

      const models = await fetch(`${baseUrl}/models`);
      const modelsPayload = await models.json();
      assert.equal(models.status, 200);
      assert.equal(modelsPayload.data[0].id, "claude-opus-4-6");

      const responses = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-6", input: "hello" }),
      });
      const responsePayload = await responses.json();
      assert.equal(responses.status, 200);
      assert.equal(responsePayload.model, "claude-opus-4-6");
      assert.equal(responsePayload.output[0].content[0].text, "hello");
      assert.equal(responses.headers.get("x-api-switch-model-family"), "claude");
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("web UI also serves the Codex local proxy and can stop it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/responses") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        `http://127.0.0.1:${upstreamPort}/v1`,
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-test\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], {
      encoding: "utf8",
    });
    assert.equal(activate.status, 0, activate.stderr);

    const server = spawn(process.execPath, [bin, "web", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const webUrl = await waitForWebUrl(server);
      const useProxy = await fetch(`${webUrl}/api/proxy/use`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "vayne", restartCodex: false }),
      });
      assert.equal(useProxy.status, 200, await useProxy.text());
      const status = await fetch(`${webUrl}/api/proxy/status`);
      const statusPayload = await status.json();
      assert.equal(status.status, 200);
      assert.equal(statusPayload.enabled, true);
      assert.match(statusPayload.proxyUrl, /\/v1$/);

      const diagnostics = await fetch(`${webUrl}/api/diagnostics`);
      const diagnosticsPayload = await diagnostics.json();
      assert.equal(diagnostics.status, 200);
      assert.equal(diagnosticsPayload.mode, "proxy");
      assert.equal(diagnosticsPayload.ready, true);
      assert.equal(diagnosticsPayload.activeProfile, "vayne");
      assert.equal(diagnosticsPayload.activeModel, "gpt-5.5");
      assert.equal(diagnosticsPayload.checks.find((check) => check.id === "codex-base-url").ok, true);

      const models = await fetch(`${webUrl}/v1/models`);
      const modelsPayload = await models.json();
      assert.equal(models.status, 200);
      assert.equal(modelsPayload.data[0].id, "gpt-5.5");

      const stop = await fetch(`${webUrl}/api/proxy/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(stop.status, 200);
      const stoppedDiagnostics = await fetch(`${webUrl}/api/diagnostics`);
      const stoppedDiagnosticsPayload = await stoppedDiagnostics.json();
      assert.equal(stoppedDiagnosticsPayload.ready, false);
      assert.equal(stoppedDiagnosticsPayload.checks.find((check) => check.id === "proxy-service").ok, false);
      const stoppedModels = await fetch(`${webUrl}/v1/models`);
      assert.equal(stoppedModels.status, 503);

      const start = await fetch(`${webUrl}/api/proxy/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(start.status, 200);
      const health = await fetch(`${webUrl}/health`);
      assert.equal(health.status, 200);
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("web UI exposes minimal route and health controls", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const upstream = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "claude", "--base-url", `http://127.0.0.1:${upstream.address().port}/v1`, "--model", "claude-opus-4-6"], {
      input: "sk-claude\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const server = spawn(process.execPath, [bin, "web", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const webUrl = await waitForWebUrl(server);
      const page = await fetch(webUrl);
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.match(html, /Advanced: model name mapping/);
      assert.match(html, /class="advanced-panel"/);
      assert.match(html, /id="route-form"/);
      assert.match(html, /id="routes-list"/);
      assert.match(html, /id="health-list"/);
      assert.match(html, /id="health-refresh"/);
      assert.match(html, /Use for Codex/);
      assert.match(html, /Use for Claude Code/);
      assert.match(html, /restartCodex: true/);
      assert.doesNotMatch(html, /fallbackProfiles/);
      assert.doesNotMatch(html, /id="diagnostics"/);
      assert.doesNotMatch(html, /id="request-log"/);
      assert.doesNotMatch(html, /diagnostics-run/);

      const save = await fetch(`${webUrl}/api/routes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: "codex", model: "gpt-5.5", profile: "claude", upstreamModel: "claude-opus-4-6" }),
      });
      const savePayload = await save.json();
      assert.equal(save.status, 200);
      assert.equal(savePayload.routes[0].model, "gpt-5.5");

      const remove = await fetch(`${webUrl}/api/routes/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: "codex", model: "gpt-5.5" }),
      });
      const removePayload = await remove.json();
      assert.equal(remove.status, 200);
      assert.equal(removePayload.routes.length, 0);

      const claudeUse = await fetch(`${webUrl}/api/claude/use`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "claude" }),
      });
      const claudePayload = await claudeUse.json();
      assert.equal(claudeUse.status, 200, JSON.stringify(claudePayload));
      assert.match(claudePayload.message, /Claude Code/);
      const status = await fetch(`${webUrl}/api/proxy/status`);
      const statusPayload = await status.json();
      assert.equal(statusPayload.clients["claude-code"].targetProfile, "claude");
      assert.equal(statusPayload.activeClaudeProfile, "claude");
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("reports profile health through the web API", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const upstream = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chat_health", object: "chat.completion", model: "gpt-5.5", choices: [{ message: { role: "assistant", content: "ok" } }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "vayne", "--base-url", `http://127.0.0.1:${upstream.address().port}/v1`, "--model", "gpt-5.5"], {
      input: "sk-test\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const server = spawn(process.execPath, [bin, "web", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const webUrl = await waitForWebUrl(server);
      const response = await fetch(`${webUrl}/api/health/profiles`);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.profiles.length, 1);
      assert.equal(payload.profiles[0].name, "vayne");
      assert.equal(payload.profiles[0].ok, true);
      assert.equal(payload.profiles[0].family, "openai");
      assert.equal(payload.profiles[0].status, 200);
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("does not retry generation requests after an upstream 5xx", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    let attempts = 0;
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/responses") {
        attempts += 1;
        if (attempts === 1) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "temporary" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, attempts }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        `http://127.0.0.1:${upstreamPort}/v1`,
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-test\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], {
      encoding: "utf8",
    });
    assert.equal(activate.status, 0, activate.stderr);

    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello" }),
      });
      const payload = await response.json();
      assert.equal(response.status, 502);
      assert.equal(payload.error, "temporary");
      assert.equal(attempts, 1);
      assert.equal(response.headers.get("x-request-id"), null);
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("does not retry generation requests after upstream 429 and passes trace headers through", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    let attempts = 0;
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/responses") {
        attempts += 1;
        if (attempts === 1) {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "0", "x-request-id": "req_retry" });
          res.end(JSON.stringify({ error: "rate limited" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_ok" });
        res.end(JSON.stringify({ ok: true, attempts }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "vayne",
        "--base-url",
        `http://127.0.0.1:${upstream.address().port}/v1`,
        "--model",
        "gpt-5.5",
      ],
      { input: "sk-test\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);

    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello" }),
      });
      const payload = await response.json();
      assert.equal(response.status, 429);
      assert.equal(payload.error, "rate limited");
      assert.equal(attempts, 1);
      assert.equal(response.headers.get("x-request-id"), "req_retry");
      assert.equal(response.headers.get("x-api-switch-model-family"), "openai");
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("passes through safe OpenAI request headers while replacing authorization", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    let receivedHeaders = {};
    let receivedPath = "";
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/responses") {
        receivedPath = req.url;
        receivedHeaders = req.headers;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "resp_headers", object: "response", model: "gpt-5.5", output: [] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }] }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "vayne", "--base-url", `http://127.0.0.1:${upstream.address().port}/v1`, "--model", "gpt-5.5"], {
      input: "sk-upstream\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);
    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer client-key",
          "openai-organization": "org_123",
          "openai-project": "proj_123",
        },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello" }),
      });
      assert.equal(response.status, 200);
      assert.equal(receivedPath, "/v1/responses");
      assert.equal(receivedHeaders.authorization, "Bearer sk-upstream");
      assert.equal(receivedHeaders["openai-organization"], "org_123");
      assert.equal(receivedHeaders["openai-project"], "proj_123");
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("passes OpenAI-family streaming Responses through without rewriting events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    let receivedPath = "";
    let receivedBody = null;
    const upstreamBody = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_native","status":"in_progress","model":"gpt-5.5","output":[]}}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"step 1"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"step 2"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp_native","status":"completed","model":"gpt-5.5"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/responses") {
        receivedPath = req.url;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.end(upstreamBody);
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "chat bridge should not be used for gpt models" }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "vayne", "--base-url", `http://127.0.0.1:${upstream.address().port}/v1`, "--model", "gpt-5.5"], {
      input: "sk-upstream\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);
    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "long task", stream: true }),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.equal(receivedPath, "/v1/responses");
      assert.equal(receivedBody.stream, true);
      assert.equal(response.headers.get("x-api-switch-upstream-protocol"), "responses");
      assert.equal(body, upstreamBody);
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("passes generic model streaming Responses through natively", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    let receivedPath = "";
    let receivedBody = null;
    const upstreamBody = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_generic","status":"in_progress","model":"gemini-3.1-pro","output":[]}}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"generic long stream"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp_generic","status":"completed","model":"gemini-3.1-pro"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/responses") {
        receivedPath = req.url;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.end(upstreamBody);
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "generic models must not use the chat bridge" }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gemini-3.1-pro" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "vayne", "--base-url", `http://127.0.0.1:${upstream.address().port}/v1`, "--model", "gemini-3.1-pro"], {
      input: "sk-upstream\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);
    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-3.1-pro", input: "long task", stream: true }),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.equal(receivedPath, "/v1/responses");
      assert.equal(receivedBody.stream, true);
      assert.equal(response.headers.get("x-api-switch-upstream-protocol"), "responses");
      assert.equal(body, upstreamBody);
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("bridges Codex Responses streaming requests through NewAPI chat completions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.equal(payload.stream, true);
        assert.equal(payload.messages[0].content, "hello");
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.write('data: {"id":"chat_1","model":"claude-opus-4-6","choices":[{"delta":{"content":"hello"}}]}\r\n\r\n');
        res.write('data: {"id":"chat_1","model":"claude-opus-4-6","choices":[{"delta":{"content":" from claude"}}]}\r\n\r\n');
        res.end("data: [DONE]\r\n\r\n");
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "claude",
        "--base-url",
        `http://127.0.0.1:${upstreamPort}/v1`,
        "--model",
        "claude-opus-4-6",
      ],
      { input: "sk-claude\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "claude"], {
      encoding: "utf8",
    });
    assert.equal(activate.status, 0, activate.stderr);

    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-6", input: "hello", stream: true }),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      assert.equal(response.headers.get("x-api-switch-upstream-protocol"), "chat-completions-bridge");
      assert.match(body, /event: response\.created/);
      assert.match(body, /response\.created/);
      assert.match(body, /event: response\.output_item\.added/);
      assert.match(body, /event: response\.content_part\.added/);
      assert.match(body, /event: response\.output_text\.delta/);
      assert.match(body, /response\.output_text\.delta/);
      assert.match(body, /hello/);
      assert.match(body, / from claude/);
      assert.match(body, /response\.output_text\.done/);
      assert.match(body, /event: response\.content_part\.done/);
      assert.match(body, /event: response\.output_item\.done/);
      assert.match(body, /event: response\.completed/);
      assert.match(body, /response\.completed/);
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("bridges streaming chat tool calls into Codex Responses events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.write('data: {"id":"chat_tool","model":"claude-opus-4-6","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell","arguments":"{\\"cmd\\""}}]}}]}\n\n');
        res.write('data: {"id":"chat_tool","model":"claude-opus-4-6","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"pwd\\"}"}}]}}]}\n\n');
        res.end("data: [DONE]\n\n");
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "claude", "--base-url", `http://127.0.0.1:${upstream.address().port}/v1`, "--model", "claude-opus-4-6"], {
      input: "sk-claude\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "claude"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);
    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-6", input: "run pwd", stream: true, tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: { cmd: { type: "string" } } } }] }),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.match(body, /response\.output_item\.added/);
      assert.match(body, /"output_index":0/);
      assert.match(body, /"type":"function_call"/);
      assert.match(body, /response\.function_call_arguments\.delta/);
      assert.match(body, /response\.function_call_arguments\.done/);
      assert.match(body, /\\"cmd\\"/);
      assert.match(body, /pwd/);
      assert.match(body, /response\.completed/);
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("passes object image_url parts through the Codex Responses chat bridge", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    let imageUrl = "";
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        imageUrl = payload.messages[0].content[1].image_url.url;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chat_image", object: "chat.completion", model: payload.model, choices: [{ message: { role: "assistant", content: "seen" } }] }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "vayne", "--base-url", `http://127.0.0.1:${upstream.address().port}/v1`, "--model", "claude-opus-4-6"], {
      input: "sk-test\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "vayne"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);
    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-6", input: [{ role: "user", content: [{ type: "input_text", text: "describe" }, { type: "input_image", image_url: { url: "https://example.com/a.png" } }] }] }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.output[0].content[0].text, "seen");
      assert.equal(imageUrl, "https://example.com/a.png");
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("turns upstream streaming errors into Codex response.failed events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const upstream = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.end('data: {"error":{"message":"rate limited","type":"rate_limit_error","code":"rate_limit"}}\n\n');
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "claude", "--base-url", `http://127.0.0.1:${upstream.address().port}/v1`, "--model", "claude-opus-4-6"], {
      input: "sk-claude\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "claude"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);
    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-6", input: "hi", stream: true }),
      });
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.match(body, /event: response\.failed/);
      assert.match(body, /rate limited/);
      assert.doesNotMatch(body, /event: response\.completed/);
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("writes proxy debug logs when API_SWITCH_DEBUG_PROXY is enabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/responses") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "resp_456", object: "response", model: "claude-opus-4-6", output: [] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chat_456", object: "chat.completion", model: "claude-opus-4-6", choices: [{ message: { role: "assistant", content: "debug bridge" } }] }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;
    const setup = spawnSync(
      process.execPath,
      [
        bin,
        "setup",
        "--codex-home",
        dir,
        "--name",
        "claude",
        "--base-url",
        `http://127.0.0.1:${upstreamPort}/v1`,
        "--model",
        "claude-opus-4-6",
      ],
      { input: "sk-claude\n", encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "claude"], {
      encoding: "utf8",
    });
    assert.equal(activate.status, 0, activate.stderr);

    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, API_SWITCH_DEBUG_PROXY: "1" },
    });

    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-6", input: "hello", stream: true }),
      });
      assert.equal(response.status, 200);
      const logDir = path.join(dir, "codex-switch", "proxy-logs");
      const files = fs.readdirSync(logDir);
      assert.equal(files.some((name) => name.endsWith("-request.json")), true);
      assert.equal(files.some((name) => name.endsWith("-upstream-response.json")), true);
      const payload = JSON.parse(fs.readFileSync(path.join(logDir, files.find((name) => name.endsWith("-request.json"))), "utf8"));
      assert.equal(payload.model, "claude-opus-4-6");
      assert.equal(payload.route.family, "claude");
      assert.equal(typeof payload.traceId, "string");
      const upstreamPayload = JSON.parse(fs.readFileSync(path.join(logDir, files.find((name) => name.endsWith("-upstream-response.json"))), "utf8"));
      assert.equal(upstreamPayload.traceId, payload.traceId);
      assert.match(upstreamPayload.body, /chat_456/);
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("falls back to a backup profile when the active upstream returns 5xx", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const primary = http.createServer((req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "primary down" }));
    });
    const backup = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/responses") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "resp_backup", object: "response", model: "gpt-5.5", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "backup" }] }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }] }));
    });
    await new Promise((resolve) => primary.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => backup.listen(0, "127.0.0.1", resolve));

    spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "backup", "--base-url", `http://127.0.0.1:${backup.address().port}/v1`, "--model", "gpt-5.5"], {
      input: "sk-backup\n",
      encoding: "utf8",
    });
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "primary", "--base-url", `http://127.0.0.1:${primary.address().port}/v1`, "--model", "gpt-5.5", "--fallback-profiles", "backup"], {
      input: "sk-primary\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "primary"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);
    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello" }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.output[0].content[0].text, "backup");
    } finally {
      server.kill();
      primary.close();
      backup.close();
    }
  });

  it("uses the fallback profile model instead of leaking the failed requested model", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    let backupModel = "";
    const primary = http.createServer((req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "primary down" }));
    });
    const backup = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        backupModel = JSON.parse(Buffer.concat(chunks).toString("utf8")).model;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chat_backup", object: "chat.completion", model: backupModel, choices: [{ message: { role: "assistant", content: "backup" } }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }));
    });
    await new Promise((resolve) => primary.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => backup.listen(0, "127.0.0.1", resolve));

    spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "backup", "--base-url", `http://127.0.0.1:${backup.address().port}/v1`, "--model", "claude-opus-4-6"], {
      input: "sk-backup\n",
      encoding: "utf8",
    });
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "primary", "--base-url", `http://127.0.0.1:${primary.address().port}/v1`, "--model", "gpt-5.5", "--fallback-profiles", "backup"], {
      input: "sk-primary\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "primary"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);
    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello" }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.model, "claude-opus-4-6");
      assert.equal(backupModel, "claude-opus-4-6");
    } finally {
      server.kill();
      primary.close();
      backup.close();
    }
  });

  it("routes requested client models to mapped upstream profiles and models", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    let receivedModel = "";
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/responses") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        receivedModel = payload.model;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, model: payload.model }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-opus-4-6" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

    spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "gpt", "--base-url", "https://api.example.com/v1", "--model", "gpt-5.5"], {
      input: "sk-gpt\n",
      encoding: "utf8",
    });
    const setupClaude = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "claude", "--base-url", `http://127.0.0.1:${upstream.address().port}/v1`, "--model", "claude-opus-4-6"], {
      input: "sk-claude\n",
      encoding: "utf8",
    });
    assert.equal(setupClaude.status, 0, setupClaude.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "gpt"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);
    const route = spawnSync(process.execPath, [bin, "route", "--codex-home", dir, "--client", "codex", "--model", "gpt-5.5", "--profile", "claude", "--upstream-model", "claude-opus-4-6"], { encoding: "utf8" });
    assert.equal(route.status, 0, route.stderr);

    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello" }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.model, "claude-opus-4-6");
      assert.equal(receivedModel, "claude-opus-4-6");
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("uses fallback profiles for streaming requests before response headers are sent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    let primaryAttempts = 0;
    let backupAttempts = 0;
    const primary = http.createServer((req, res) => {
      primaryAttempts += 1;
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "primary stream down" }));
    });
    const backup = http.createServer((req, res) => {
      backupAttempts += 1;
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_backup","object":"response","status":"in_progress","model":"gpt-5.5","output":[]}}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"backup"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_backup","object":"response","status":"completed","model":"gpt-5.5","output":[]}}\n\ndata: [DONE]\n\n');
    });
    await new Promise((resolve) => primary.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => backup.listen(0, "127.0.0.1", resolve));

    spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "backup", "--base-url", `http://127.0.0.1:${backup.address().port}/v1`, "--model", "gpt-5.5"], {
      input: "sk-backup\n",
      encoding: "utf8",
    });
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "primary", "--base-url", `http://127.0.0.1:${primary.address().port}/v1`, "--model", "gpt-5.5", "--fallback-profiles", "backup"], {
      input: "sk-primary\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const activate = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "primary"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);
    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const baseUrl = await waitForProxyUrl(server);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true }),
      });
      const payload = await response.text();
      assert.equal(response.status, 200);
      assert.match(payload, /event: response\.created/);
      assert.match(payload, /backup/);
      assert.equal(primaryAttempts, 1);
      assert.equal(backupAttempts, 1);
    } finally {
      server.kill();
      primary.close();
      backup.close();
    }
  });

  it("configures Claude Code to use and leave the local proxy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), `${JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.example",
        ANTHROPIC_AUTH_TOKEN: "original-token",
        KEEP_ME: "yes",
      },
    }, null, 2)}\n`);
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "claude", "--base-url", "https://api.example.com/v1", "--model", "claude-opus-4-6"], {
      input: "sk-claude\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const proxy = spawnSync(process.execPath, [bin, "claude-proxy", "--codex-home", dir, "--claude-home", claudeDir, "--name", "claude"], { encoding: "utf8" });
    assert.equal(proxy.status, 0, proxy.stderr);
    let settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:18600");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "api-switch");
    let proxySettings = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "proxy-settings.json"), "utf8"));
    assert.equal(proxySettings.clients["claude-code"].targetProfile, "claude");
    const account = spawnSync(process.execPath, [bin, "claude-account", "--codex-home", dir, "--claude-home", claudeDir], { encoding: "utf8" });
    assert.equal(account.status, 0, account.stderr);
    settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.anthropic.example");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "original-token");
    assert.equal(settings.env.KEEP_ME, "yes");
    proxySettings = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "proxy-settings.json"), "utf8"));
    assert.equal(proxySettings.clients["claude-code"].targetProfile, "");
  });

  it("refreshes stale Claude Code env backup before switching to proxy mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
    fs.mkdirSync(path.join(dir, "codex-switch"), { recursive: true });
    fs.writeFileSync(path.join(dir, "codex-switch", "claude-env.backup.json"), `${JSON.stringify({
      version: 1,
      env: {
        ANTHROPIC_BASE_URL: "https://old.example",
        ANTHROPIC_AUTH_TOKEN: "old-token",
      },
    }, null, 2)}\n`);
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), `${JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://new.example",
        ANTHROPIC_AUTH_TOKEN: "new-token",
      },
    }, null, 2)}\n`);
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "claude", "--base-url", "https://api.example.com/v1", "--model", "claude-opus-4-6"], {
      input: "sk-claude\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);

    const proxy = spawnSync(process.execPath, [bin, "claude-proxy", "--codex-home", dir, "--claude-home", claudeDir, "--name", "claude"], { encoding: "utf8" });
    assert.equal(proxy.status, 0, proxy.stderr);
    const account = spawnSync(process.execPath, [bin, "claude-account", "--codex-home", dir, "--claude-home", claudeDir], { encoding: "utf8" });
    assert.equal(account.status, 0, account.stderr);

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://new.example");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "new-token");
  });

  it("does not switch Claude Code to proxy mode when the target API key is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "claude", "--base-url", "https://api.example.com/v1", "--model", "claude-opus-4-6"], {
      input: "sk-claude\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    fs.unlinkSync(path.join(dir, "claude_api_key"));

    const proxy = spawnSync(process.execPath, [bin, "claude-proxy", "--codex-home", dir, "--claude-home", claudeDir, "--name", "claude"], { encoding: "utf8" });

    assert.notEqual(proxy.status, 0);
    assert.match(proxy.stderr, /API key not found/);
    assert.equal(fs.existsSync(path.join(claudeDir, "settings.json")), false);
    assert.equal(fs.existsSync(path.join(dir, "codex-switch", "proxy-settings.json")), false);
  });

  it("keeps Codex and Claude Code proxy targets independent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
    spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "gpt", "--base-url", "https://api.example.com/v1", "--model", "gpt-5.5"], {
      input: "sk-gpt\n",
      encoding: "utf8",
    });
    spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "claude", "--base-url", "https://api.example.com/v1", "--model", "claude-opus-4-6"], {
      input: "sk-claude\n",
      encoding: "utf8",
    });

    const codex = spawnSync(process.execPath, [bin, "default", "--codex-home", dir, "--name", "gpt"], { encoding: "utf8" });
    assert.equal(codex.status, 0, codex.stderr);
    const claude = spawnSync(process.execPath, [bin, "claude-proxy", "--codex-home", dir, "--claude-home", claudeDir, "--name", "claude"], { encoding: "utf8" });
    assert.equal(claude.status, 0, claude.stderr);

    const proxySettings = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "proxy-settings.json"), "utf8"));
    assert.equal(proxySettings.clients.codex.targetProfile, "gpt");
    assert.equal(proxySettings.clients["claude-code"].targetProfile, "claude");
  });

  it("proxies Claude Code Anthropic messages requests", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    let receivedHeaders = {};
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        receivedHeaders = req.headers;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.equal(payload.messages[0].content, "hello");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chat_1", type: "chat.completion", model: payload.model, choices: [{ message: { role: "assistant", content: "hi" } }] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "claude", "--base-url", `http://127.0.0.1:${upstream.address().port}/v1`, "--model", "claude-opus-4-6"], {
      input: "sk-claude\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
    const activate = spawnSync(process.execPath, [bin, "claude-proxy", "--codex-home", dir, "--claude-home", claudeDir, "--name", "claude"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);
    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const baseUrl = await waitForProxyUrl(server);
      const rootUrl = baseUrl.replace(/\/v1$/, "");
      const response = await fetch(`${rootUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "tools-2024-04-04",
          authorization: "Bearer client-key",
        },
        body: JSON.stringify({ model: "claude-opus-4-6", max_tokens: 16, messages: [{ role: "user", content: "hello" }] }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.type, "message");
      assert.equal(payload.content[0].text, "hi");
      assert.equal(receivedHeaders.authorization, "Bearer sk-claude");
      assert.equal(receivedHeaders["x-api-key"], undefined);
      assert.equal(receivedHeaders["anthropic-beta"], undefined);
      assert.equal(response.headers.get("x-api-switch-client"), "claude-code");
    } finally {
      server.kill();
      upstream.close();
    }
  });

  it("bridges Claude Code tool_use and tool_result through chat completions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
    let upstreamMessages = [];
    const upstream = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        upstreamMessages = payload.messages;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chat_tool",
          object: "chat.completion",
          model: payload.model,
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "call_next", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
            },
          }],
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const setup = spawnSync(process.execPath, [bin, "setup", "--codex-home", dir, "--name", "claude", "--base-url", `http://127.0.0.1:${upstream.address().port}/v1`, "--model", "claude-opus-4-6"], {
      input: "sk-claude\n",
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
    const activate = spawnSync(process.execPath, [bin, "claude-proxy", "--codex-home", dir, "--claude-home", claudeDir, "--name", "claude"], { encoding: "utf8" });
    assert.equal(activate.status, 0, activate.stderr);
    const server = spawn(process.execPath, [bin, "proxy", "--codex-home", dir, "--host", "127.0.0.1", "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const baseUrl = await waitForProxyUrl(server);
      const rootUrl = baseUrl.replace(/\/v1$/, "");
      const response = await fetch(`${rootUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          max_tokens: 32,
          messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "shell", input: { cmd: "pwd" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "/tmp" }] },
          ],
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(upstreamMessages[0].role, "assistant");
      assert.equal(upstreamMessages[0].tool_calls[0].function.name, "shell");
      assert.equal(upstreamMessages[1].role, "tool");
      assert.equal(upstreamMessages[1].tool_call_id, "call_1");
      assert.equal(payload.stop_reason, "tool_use");
      assert.equal(payload.content[0].type, "tool_use");
      assert.equal(payload.content[0].name, "read_file");
      assert.equal(payload.content[0].input.path, "README.md");
    } finally {
      server.kill();
      upstream.close();
    }
  });
});
