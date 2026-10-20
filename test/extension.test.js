"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

function load(vscode, overrides = {}) {
  const filename = path.resolve(__dirname, "../extension.js");
  const source = fs.readFileSync(filename, "utf8");
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const requireMock = (name) => name === "vscode" ? vscode : (overrides[name] || realRequire(name));
  vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename })(
    requireMock, module, module.exports
  );
  return module.exports;
}

const uriApi = { parse: (value) => ({ authority: new URL(value).host }) };
test("recognizes direct SSH, encoded SSH and nested Dev Container authorities", () => {
  const { sshHosts } = load({ Uri: uriApi });
  assert.ok(sshHosts("ssh-remote+192.0.2.10").includes("192.0.2.10"));
  const ssh = Buffer.from(JSON.stringify({ hostName: "my-robot" })).toString("hex");
  assert.ok(sshHosts(`ssh-remote+${ssh}`).includes("my-robot"));
  const container = Buffer.from(JSON.stringify({
    hostPath: "/home/developer/project",
    configFile: { scheme: "vscode-remote", authority: "ssh-remote+192.0.2.10" }
  })).toString("hex");
  assert.ok(sshHosts(`dev-container+${container}`).includes("192.0.2.10"));
  assert.equal(sshHosts("dev-container+not-a-known-host").length, 0);
});

function fixture(remoteName, stat, settings = {}, password = "test-password", extras = {}) {
  const sockets = [];
  const logs = [];
  const config = {
    hosts: ["192.0.2.10"],
    windowBindings: {}, remotePort: 1080, sshPath: "ssh", ...settings
  };
  const listeners = {};
  const commands = {};
  const prompts = [];
  const uri = { scheme: "vscode-remote", authority: "ssh-remote+192.0.2.10", path: "/workspace" };
  if (remoteName === "dev-container") {
    uri.authority = "dev-container+" + Buffer.from(JSON.stringify({
      configFile: { authority: "ssh-remote+192.0.2.10" }
    })).toString("hex");
  }
  if (extras.authority) uri.authority = extras.authority;
  const disposable = { dispose() {} };
  const vscode = {
    Uri: uriApi, env: { remoteName },
    StatusBarAlignment: { Right: 1 },
    ConfigurationTarget: { Global: 1 },
    window: {
      createOutputChannel: () => ({ ...disposable, appendLine: (message) => logs.push(message), show() {} }),
      createStatusBarItem: () => ({ ...disposable, show() {}, hide() {} }),
      showWarningMessage: async (message) => { logs.push(message); },
      showErrorMessage: async (message) => { logs.push(message); },
      showInputBox: async (options) => { prompts.push(options); return password; },
      showQuickPick: extras.showQuickPick
    },
    commands: { registerCommand: (name, handler) => { commands[name] = handler; return disposable; } },
    workspace: {
      workspaceFolders: [{ uri }],
      fs: { stat },
      getConfiguration: () => ({
        get: (name, fallback) => config[name] ?? fallback,
        update: async (name, value) => {
          config[name] = value;
          listeners.config?.({ affectsConfiguration: () => true });
        }
      }),
      onDidChangeWorkspaceFolders: (listener) => { listeners.folders = listener; return disposable; },
      onDidChangeConfiguration: (listener) => { listeners.config = listener; return disposable; }
    }
  };
  const net = {
    connect() {
      const socket = new EventEmitter();
      socket.destroyed = false;
      socket.messages = [];
      socket.write = (message) => { socket.messages.push(message); };
      socket.destroy = () => { socket.destroyed = true; socket.emit("close"); };
      sockets.push(socket);
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    }
  };
  const context = {
    extensionPath: path.resolve(__dirname, ".."),
    globalStorageUri: { fsPath: "/unused-test-storage" },
    subscriptions: []
  };
  load(vscode, { "node:net": net, ...extras.modules }).activate(context);
  return {
    sockets, logs, listeners, commands, prompts, config,
    dispose() { for (const item of context.subscriptions) item.dispose(); }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
test("encoded Chinese SSH aliases match the enabled alias array and acquire a lease", async () => {
  const alias = "lab下server";
  const authority = "ssh-remote+" + Buffer.from(JSON.stringify({ hostName: alias })).toString("hex");
  const { sshHosts } = load({ Uri: uriApi });
  assert.ok(sshHosts(authority).includes(alias));
  const f = fixture("ssh-remote", async () => ({}), { hosts: [alias] }, "unused", { authority });
  await settle();
  assert.equal(f.sockets.length, 1);
  assert.deepEqual(f.sockets[0].messages, ["ping\n"]);
  f.dispose();
});

test("only arrays of host aliases are accepted", () => {
  const { enabledHosts } = load({ Uri: uriApi });
  assert.deepEqual(enabledHosts(["robot", "other"]), ["robot", "other"]);
  assert.throws(() => enabledHosts({ robot: "user@ip" }), /array/);
  assert.throws(() => enabledHosts("robot"), /array/);
});
test("a Dev Container-only window acquires and releases the same kind of lease as SSH", async () => {
  const f = fixture("dev-container", async () => ({}));
  await settle();
  assert.equal(f.sockets.length, 1);
  assert.deepEqual(f.sockets[0].messages, ["ping\n"]);
  f.dispose();
  assert.equal(f.sockets[0].destroyed, true);
});

test("local windows never start a proxy", async () => {
  const f = fixture(undefined, async () => ({}));
  await settle();
  assert.equal(f.sockets.length, 0);
  f.dispose();
});

test("failed or pending remote filesystem probes cannot acquire a lease", async () => {
  const failed = fixture("dev-container", async () => { throw new Error("Remote disconnected"); });
  const pending = fixture("dev-container", () => new Promise(() => {}));
  await settle();
  assert.equal(failed.sockets.length, 0);
  assert.equal(pending.sockets.length, 0);
  assert.ok(failed.logs.some((message) => message.includes("Remote disconnected")));
  failed.dispose();
  pending.dispose();
});

test("a late filesystem response after the window closes cannot start a proxy", async () => {
  let resolve;
  const f = fixture("dev-container", () => new Promise((done) => { resolve = done; }));
  f.dispose();
  resolve({});
  await settle();
  assert.equal(f.sockets.length, 0);
});

test("only explicitly enabled hosts connect, and disabled authorities override host mappings", async () => {
  const unlisted = fixture("ssh-remote", async () => ({}), { hosts: [] });
  const disabled = fixture("ssh-remote", async () => ({}), {
    windowBindings: { "ssh-remote+192.0.2.10": "" }
  });
  await settle();
  assert.equal(unlisted.sockets.length, 0);
  assert.equal(disabled.sockets.length, 0);
  unlisted.dispose();
  disabled.dispose();
});

test("password is masked and sent only to the requesting broker, never logged or saved", async () => {
  const f = fixture("dev-container", async () => ({}));
  await settle();
  f.sockets[0].emit("data", Buffer.from('{"state":"password","id":"one"}\n'));
  await settle();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].password, true);
  assert.equal(JSON.parse(f.sockets[0].messages.at(-1)).value, "test-password");
  assert.ok(!JSON.stringify(f.logs).includes("test-password"));
  assert.ok(!JSON.stringify(f.config).includes("test-password"));
  f.dispose();
});

test("cancelling authentication sends cancellation and waits for explicit Retry", async () => {
  const f = fixture("ssh-remote", async () => ({}), {}, null);
  await settle();
  f.sockets[0].emit("data", Buffer.from('{"state":"password","id":"one"}\n'));
  await settle();
  assert.equal(JSON.parse(f.sockets[0].messages.at(-1)).value, null);
  f.sockets[0].destroy();
  await f.commands["remoteProxy.retry"]();
  await settle();
  assert.equal(f.sockets.length, 2);
  f.dispose();
});

test("Disable removes host mappings and bindings, releasing the current lease", async () => {
  const f = fixture("ssh-remote", async () => ({}), {
    windowBindings: { "ssh-remote+192.0.2.10": "developer@192.0.2.10" }
  });
  await settle();
  await f.commands["remoteProxy.disable"]();
  await settle();
  assert.equal(f.sockets[0].destroyed, true);
  assert.deepEqual(f.config.hosts, []);
  assert.equal(f.config.windowBindings["ssh-remote+192.0.2.10"], "");
  f.dispose();
});

test("SSH host picker saves multiple selections and passes custom config to enumeration", async () => {
  let enumerated;
  const f = fixture(undefined, async () => ({}), {
    hosts: ["old", "manual"],
    sshConfigFile: "/local/ssh-config",
    windowBindings: { "ssh-remote+old": "old", "ssh-remote+robot-a": "" }
  }, "unused", {
    modules: {
      "./ssh-config": {
        configPath: (value) => value || "/default/ssh/config",
        readHosts: async (file) => { enumerated = file; return ["old", "robot-a", "robot-b"]; }
      }
    },
    showQuickPick: async (items, options) => {
      assert.equal(options.canPickMany, true);
      assert.equal(items.find((item) => item.label === "old").picked, true);
      return items.filter((item) => item.label !== "old");
    }
  });
  await f.commands["remoteProxy.configure"]();
  assert.equal(enumerated, "/local/ssh-config");
  assert.deepEqual(f.config.hosts, ["manual", "robot-a", "robot-b"]);
  assert.equal(f.config.windowBindings["ssh-remote+old"], "");
  assert.equal(Object.hasOwn(f.config.windowBindings, "ssh-remote+robot-a"), false);
  f.dispose();
});

test("cancelling host selection preserves all settings", async () => {
  const f = fixture(undefined, async () => ({}), {}, "unused", {
    modules: { "./ssh-config": { configPath: () => "/config", readHosts: async () => ["robot"] } },
    showQuickPick: async () => undefined
  });
  const before = JSON.stringify(f.config);
  await f.commands["remoteProxy.configure"]();
  assert.equal(JSON.stringify(f.config), before);
  f.dispose();
});
