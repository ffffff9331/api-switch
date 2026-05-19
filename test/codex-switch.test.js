const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bin = path.join(__dirname, "..", "bin", "codex-switch.js");

function waitForWebUrl(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for web server. Output: ${output}`)), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/Codex Switch web UI: (http:\/\/127\.0\.0\.1:\d+)/);
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

describe("codex-switch", () => {
  it("writes a managed profile without committing the key to config.toml", () => {
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
    const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    assert.match(config, /\[profiles\.vayne\]/);
    assert.match(config, /base_url = "https:\/\/api\.vayne\.cc\.cd\/v1"/);
    assert.match(config, /auth\.command = "cat"/);
    assert.match(config, /model_catalog_json = ".+vayne_models\.json"/);
    assert.doesNotMatch(config, /sk-test/);
    assert.equal(fs.readFileSync(path.join(dir, "vayne_api_key"), "utf8"), "sk-test\n");
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "vayne_models.json"), "utf8"));
    assert.equal(catalog.models[0].slug, "gpt-5.5");
    assert.equal(catalog.models[0].visibility, "list");
  });

  it("removes only the managed profile block", () => {
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
    const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    assert.doesNotMatch(config, /\[profiles\.vayne\]/);
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
    const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    assert.match(config, /\[profiles\.vayne\]/);
    assert.match(config, /\[profiles\.backup\]/);
    assert.match(config, /base_url = "https:\/\/api\.vayne\.cc\.cd\/v1"/);
    assert.match(config, /base_url = "https:\/\/relay\.example\.com\/v1"/);
    assert.doesNotMatch(config, /sk-one|sk-two/);
  });

  it("updates the model for an existing managed profile without replacing the key", () => {
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
    const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    assert.match(config, /model = "gpt-5\.4"/);
    assert.doesNotMatch(config, /model = "gpt-5\.5"/);
    assert.match(config, /base_url = "https:\/\/api\.vayne\.cc\.cd\/v1"/);
    assert.equal(fs.readFileSync(path.join(dir, "vayne_api_key"), "utf8"), "sk-one\n");
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, "codex-switch", "vayne_models.json"), "utf8"));
    assert.deepEqual(
      catalog.models.map((model) => model.slug).sort(),
      ["gpt-5.4", "gpt-5.5"],
    );
  });

  it("sets a default profile using the config key", () => {
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
    const original = fs.readFileSync(configPath, "utf8");
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
    assert.match(fs.readFileSync(configPath, "utf8"), /^profile = "vayne"$/m);
  });

  it("moves all threads to the selected relay provider", () => {
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
    assert.match(result.stdout, /Moved 2 thread\(s\) to provider: vayne/);
    assert.match(result.stdout, /Updated 2 thread model\(s\) to: gpt-5\.5/);
    assert.match(result.stdout, /Updated 2 rollout file\(s\)/);
    const rows = spawnSync(
      "sqlite3",
      [dbPath, "select id || '|' || model || '|' || model_provider from threads order by id;"],
      { encoding: "utf8" },
    );
    assert.equal(rows.status, 0, rows.stderr);
    assert.match(rows.stdout, /active-account\|gpt-5\.5\|vayne/);
    assert.match(rows.stdout, /active-relay\|gpt-5\.5\|vayne/);
    assert.match(rows.stdout, /archived-account\|gpt-5\.5\|vayne/);
    assert.equal(JSON.parse(fs.readFileSync(activeRollout, "utf8").split("\n")[0]).payload.model_provider, "vayne");
    assert.equal(JSON.parse(fs.readFileSync(archivedRollout, "utf8").split("\n")[0]).payload.model_provider, "vayne");
    assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("active.jsonl.codex-switch-")).length, 1);
    assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("archived.jsonl.codex-switch-")).length, 1);
    assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("state_5.sqlite.codex-switch-")).length, 1);
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
    assert.match(result.stdout, /Moved 0 thread\(s\) to provider: vayne/);
    assert.match(result.stdout, /Updated 1 rollout file\(s\)/);
    assert.equal(JSON.parse(fs.readFileSync(rollout, "utf8").split("\n")[0]).payload.model_provider, "vayne");
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
    assert.match(result.stdout, /Updated 1 rollout file\(s\)/);
    const fdRead = fs.openSync(rollout, "r");
    const buffer = Buffer.alloc(512);
    const bytesRead = fs.readSync(fdRead, buffer, 0, buffer.length, 0);
    fs.closeSync(fdRead);
    const updatedFirstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    assert.equal(JSON.parse(updatedFirstLine).payload.model_provider, "vayne");
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
    assert.match(result.stdout, /Moved 1 thread\(s\) to provider: vayne/);
    assert.match(result.stdout, /Updated 1 rollout file\(s\)/);
    assert.match(result.stdout, /Repaired 1 rollout path\(s\)/);
    assert.equal(fs.existsSync(rollout), true);
    assert.equal(JSON.parse(fs.readFileSync(rollout, "utf8").split("\n")[0]).payload.model_provider, "vayne");
    const rows = spawnSync("sqlite3", [dbPath, "select model_provider || '|' || rollout_path from threads where id = 'restored';"], {
      encoding: "utf8",
    });
    assert.equal(rows.status, 0, rows.stderr);
    assert.equal(rows.stdout.trim(), `vayne|${rollout}`);
  });

  it("lists account and managed relay profiles", () => {
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

  it("can switch API provider while preserving account workspace metadata", () => {
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
      [bin, "default", "--codex-home", dir, "--name", "vayne", "--keep-account-workspace"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Kept Codex thread workspace metadata unchanged/);
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
      const response = await fetch(`${baseUrl}/api/default`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "vayne", restartCodex: false }),
      });
      const payload = await response.json();

      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.match(payload.details.join("\n"), /Moved 1 thread\(s\)/);
      assert.match(payload.details.join("\n"), /updated 1 thread model\(s\) to 'gpt-5\.5'/i);
      const rows = spawnSync("sqlite3", [dbPath, "select model_provider from threads where id = 'web-active';"], {
        encoding: "utf8",
      });
      assert.equal(rows.status, 0, rows.stderr);
      assert.equal(rows.stdout.trim(), "vayne");
      assert.equal(JSON.parse(fs.readFileSync(rollout, "utf8").split("\n")[0]).payload.model_provider, "vayne");
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
    assert.match(rows.stdout, /old-gpt\|claude-opus-4-6\|claude/);
    assert.match(rows.stdout, /old-openai\|claude-opus-4-6\|claude/);
    assert.match(rows.stdout, /old-other-model\|claude-opus-4-6\|claude/);
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
      const response = await fetch(`${baseUrl}/api/default`, {
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
      assert.match(rows.stdout, /web-old\|claude-opus-4-6\|claude/);
      assert.match(rows.stdout, /web-other\|claude-opus-4-6\|claude/);
    } finally {
      server.kill();
    }
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
    assert.match(result.stdout, /codex-switch web/);
    assert.match(result.stdout, /codex-switch list/);
    assert.match(result.stdout, /codex-switch account/);
    assert.match(result.stdout, /--delete-key/);
    assert.match(result.stdout, /--no-open/);
    assert.match(result.stdout, /--port <port>/);
    assert.match(result.stdout, /--keep-account-workspace/);
    assert.match(result.stdout, /--restart-codex/);
    assert.match(result.stdout, /codex-switch model --name <profile> --model <model>/);
    assert.match(result.stdout, /codex-switch thread-model --model <model>/);
  });
});
