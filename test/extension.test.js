"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");

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
      queueMicrotask(() => extras.connect ? extras.connect(socket) : socket.emit("connect"));
      return socket;
    }
  };
  const context = {
    extensionPath: path.resolve(__dirname, ".."),
    globalStorageUri: { fsPath: extras.storageDir || path.join(os.tmpdir(), "unused-test-storage") },
    subscriptions: []
  };
  load(vscode, { "node:net": net, ...extras.modules }).activate(context);
  return {
    sockets, logs, listeners, commands, prompts, config,
    dispose() { for (const item of context.subscriptions) item.dispose(); }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function startupFixture(t, exitCode, availableAfterLaunch = 2, existsSync = () => false) {
  let launches = 0;
  let available = false;
  const f = fixture("ssh-remote", async () => ({}), {}, "unused", {
    connect(socket) {
      if (available) socket.emit("connect");
      else socket.emit("error", Object.assign(new Error("No broker"), { code: "ENOENT" }));
    },
    modules: {
      "node:fs": { mkdirSync() {}, openSync() { return 1; }, closeSync() {}, existsSync },
      "node:child_process": {
        fork() {
          launches++;
          const child = new EventEmitter();
          child.exitCode = null;
          child.signalCode = null;
          child.disconnect = () => {};
          child.unref = () => {};
          available = launches >= availableAfterLaunch;
          if (!available || launches === 1) {
            queueMicrotask(() => {
              child.exitCode = exitCode;
              child.emit("exit", exitCode, null);
            });
          }
          return child;
        }
      }
    }
  });
  t.after(() => f.dispose());
  return { ...f, launches: () => launches };
}

async function waitFor(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < end, "Timed out waiting for broker startup");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("broker lock contention retries startup instead of waiting for an exited child", async (t) => {
  const f = startupFixture(t, 75);
  await waitFor(() => f.sockets.some((socket) => socket.messages.includes("ping\n")));
  assert.equal(f.launches(), 2);
  assert.ok(!f.logs.some((message) => message.includes("Cannot start")));
});

test("a broker started by another window is reused even when this window's child loses the lock", async (t) => {
  const f = startupFixture(t, 75, 1);
  await waitFor(() => f.sockets.some((socket) => socket.messages.includes("ping\n")));
  assert.equal(f.launches(), 1);
});

test("persistent broker lock contention stops retrying after the 10-second startup window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = startupFixture(t, 75, Infinity, () => true);
  await settle();
  for (let n = 0; n < 99; n++) {
    t.mock.timers.tick(100);
    await settle();
  }
  assert.equal(f.logs.length, 0);
  t.mock.timers.tick(100);
  await settle();
  assert.ok(f.logs.some((message) => message.includes("Cannot start") && message.includes("lock conflict")));
  assert.equal(f.launches(), 1);
  assert.ok(f.sockets.every((socket) => socket.destroyed));
  t.mock.timers.tick(20000);
  await settle();
  assert.equal(f.launches(), 1, "A terminal startup failure must wait for explicit Retry");
});

test("a released shutdown lock allows startup without repeatedly spawning while it is held", async (t) => {
  let locked = true;
  const f = startupFixture(t, 75, 2, () => locked);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(f.launches(), 1);
  locked = false;
  await waitFor(() => f.sockets.some((socket) => socket.messages.includes("ping\n")));
  assert.equal(f.launches(), 2);
});

test("broker spawn errors are reported promptly and do not automatically relaunch", async (t) => {
  let launches = 0;
  const f = fixture("ssh-remote", async () => ({}), {}, "unused", {
    connect(socket) {
      socket.emit("error", Object.assign(new Error("No broker"), { code: "ENOENT" }));
    },
    modules: {
      "node:fs": { mkdirSync() {}, openSync() { return 1; }, closeSync() {} },
      "node:child_process": {
        fork() {
          launches++;
          const child = new EventEmitter();
          child.disconnect = () => {};
          child.unref = () => {};
          queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" })));
          return child;
        }
      }
    }
  });
  t.after(() => f.dispose());
  await waitFor(() => f.logs.some((message) => message.includes("spawn EACCES")));
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(launches, 1);
});

test("unexpected control channel errors are reported without spawning a broker", async (t) => {
  const f = fixture("ssh-remote", async () => ({}), {}, "unused", {
    connect(socket) {
      socket.emit("error", Object.assign(new Error("Control channel access denied"), { code: "EACCES" }));
    },
    modules: {
      "node:child_process": { fork() { assert.fail("Must not spawn on control channel access errors"); } }
    }
  });
  t.after(() => f.dispose());
  await settle();
  assert.ok(f.logs.some((message) => message.includes("Control channel access denied")));
  assert.ok(f.sockets.every((socket) => socket.destroyed));
});

test("non-contention broker exits are reported promptly without launching another child", async (t) => {
  const f = startupFixture(t, 1);
  await waitFor(() => f.logs.some((message) => message.includes("Local broker exited (1)")));
  assert.equal(f.launches(), 1);
});

test("disposing a window during broker contention does not launch another child or warn", async (t) => {
  const f = startupFixture(t, 75);
  await waitFor(() => f.launches() === 1);
  f.dispose();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(f.launches(), 1);
  assert.equal(f.logs.length, 0);
});

test("rapid Retry cancels pending startup probes instead of acquiring obsolete leases", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = startupFixture(t, 75, Infinity, () => true);
  await settle();
  for (let i = 0; i < 8; i++) await f.commands["remoteProxy.retry"]();
  await settle();
  const probes = f.sockets.length;
  t.mock.timers.tick(100);
  await settle();
  assert.equal(f.sockets.length - probes, 1, "Only the newest generation should probe");
  assert.equal(f.logs.length, 0);
});

test("real broker processes share a Windows pipe / Unix socket and reconnect during SSH retirement", async (t) => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-proxy-windows-lifecycle-"));
  const children = [];
  const windows = [];
  let stateDir;
  const script = `
    const {startBroker,BROKER_BUSY_EXIT_CODE}=require(${JSON.stringify(require.resolve("../broker"))});
    const {spawn}=require('node:child_process');
    startBroker({...JSON.parse(process.argv[1]), startupGraceMs:3000,
      sshFactory(command,args,options) {
        const ssh=spawn(process.execPath,['-e',
          "process.stdout.write('REMOTE_PROXY_READY\\\\n');process.stdin.resume();"],options);
        console.log('TEST_SSH_PID='+ssh.pid);
        const kill=ssh.kill.bind(ssh);
        ssh.kill=(signal)=> {
          if(signal==='SIGKILL') return kill(signal);
          console.log('TEST_SSH_STOPPING');
          setTimeout(()=>kill(),650);
          return true;
        };
        return ssh;
      }
    }).catch(error=>{
      console.error(error.message);
      process.exitCode=error.code==='EBROKERBUSY'?BROKER_BUSY_EXIT_CODE:1;
    });
  `;
  const modules = {
    "node:net": net,
    "node:child_process": {
      fork(file, args, options) {
        stateDir = JSON.parse(args[0]).stateDir;
        const child = spawn(process.execPath, ["-e", script, args[0]], options);
        children.push(child);
        return child;
      }
    }
  };
  const open = (remoteName, stat = async () => ({})) => {
    const f = fixture(remoteName, stat, { authentication: "key" }, "unused", {
      storageDir, modules
    });
    windows.push(f);
    return f;
  };
  const exited = (child) => child.exitCode !== null || child.signalCode !== null;
  t.after(async () => {
    for (const f of windows) f.dispose();
    try {
      await waitFor(() => children.every(exited), 6000);
      if (stateDir) {
        assert.equal(fs.existsSync(path.join(stateDir, "broker.lock")), false);
        const log = fs.readFileSync(path.join(stateDir, "broker.log"), "utf8");
        for (const match of log.matchAll(/TEST_SSH_PID=(\d+)/g)) {
          assert.throws(() => process.kill(Number(match[1]), 0), { code: "ESRCH" });
        }
      }
    } finally {
      for (const child of children) if (!exited(child)) child.kill();
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  });
  const first = open("ssh-remote");
  const second = open("dev-container");
  await waitFor(() => windows.every((f) => f.logs.some((line) => line.includes("Proxy ready"))), 5000);
  const lockPath = path.join(stateDir, "broker.lock");
  const originalPid = fs.readFileSync(lockPath, "utf8");
  assert.equal(children.filter((child) => !exited(child)).length, 1);
  first.dispose();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.readFileSync(lockPath, "utf8"), originalPid);
  second.dispose();
  // Wait for the real control server to close, while the SSH worker still owns its resources.
  await waitFor(() => fs.readFileSync(path.join(stateDir, "broker.log"), "utf8").includes("TEST_SSH_STOPPING"));
  assert.equal(fs.readFileSync(lockPath, "utf8"), originalPid);
  let probes = 0;
  let finishProbe;
  const next = open("ssh-remote", () => {
    if (++probes !== 2) return Promise.resolve({});
    return new Promise((resolve) => { finishProbe = resolve; });
  });
  await waitFor(() => {
    assert.ok(!next.logs.some((line) => /Cannot start|Local broker exited/.test(line)), next.logs.join("\n"));
    return next.logs.some((line) => line.includes("Proxy ready"));
  }, 12000);
  assert.notEqual(fs.readFileSync(lockPath, "utf8"), originalPid);
  assert.ok(children.some((child) => child.exitCode === 75), "The retiring broker must reject a real contender");
  assert.ok(children.length <= 4, "Must not fork repeatedly while the shutdown lock is held");
  assert.ok(windows.every((f) => !f.logs.some((line) => /Cannot start|Local broker exited/.test(line))));
  const reconnectedPid = fs.readFileSync(lockPath, "utf8");
  await waitFor(() => probes === 2, 4000);
  await new Promise((resolve) => setTimeout(resolve, 11000));
  assert.equal(probes, 2, "A pending remote probe must not start duplicate probes");
  assert.equal(fs.readFileSync(lockPath, "utf8"), reconnectedPid,
    "The real broker must survive a probe stalled beyond the unchanged 10-second lease");
  assert.ok(!next.logs.some((line) => line.includes("control channel closed")));
  assert.ok(!fs.readFileSync(path.join(stateDir, "broker.log"), "utf8").includes("expired"));
  finishProbe({});
  await settle();
  for (let i = 0; i < 8; i++) await next.commands["remoteProxy.retry"]();
  await waitFor(() => next.logs.filter((line) => line.includes("Proxy ready")).length >= 2, 5000);
});

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

for (const wrapper of ["repeated-prefix", "user-prefix", "host-name"]) {
  test(`Dev Container ${wrapper} normalizes encoded SSH aliases before acquiring a lease`, async (t) => {
    const alias = "wifi下Unitree-G1";
    const ssh = "ssh-remote+" + Buffer.from(JSON.stringify({ hostName: alias })).toString("hex");
    const metadata = wrapper === "repeated-prefix"
      ? { configFile: { authority: `ssh-remote+${ssh}` } }
      : wrapper === "user-prefix" ? { host: `unitree@${ssh}` } : { hostName: ssh };
    const authority = "dev-container+" + Buffer.from(JSON.stringify(metadata)).toString("hex");
    const { sshHosts } = load({ Uri: uriApi });
    const names = sshHosts(authority);
    assert.ok(names.includes(alias), JSON.stringify(names));
    assert.ok(names.every((name) => !name.startsWith("ssh-remote+")), JSON.stringify(names));
    const f = fixture("dev-container", async () => ({}), { hosts: [alias] }, "unused", { authority });
    t.after(() => f.dispose());
    await settle();
    assert.equal(f.sockets.length, 1);
    assert.deepEqual(f.sockets[0].messages, ["ping\n"]);
  });
}

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

test("a hung remote probe does not block heartbeats or start duplicate probes beyond the lease timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  let finish;
  const f = fixture("ssh-remote", () => {
    if (++calls === 1) return Promise.resolve({});
    return new Promise((resolve) => { finish = resolve; });
  });
  t.after(() => f.dispose());
  await settle();
  assert.deepEqual(f.sockets[0].messages, ["ping\n"]);
  t.mock.timers.tick(2000);
  await settle();
  for (let n = 0; n < 6; n++) {
    t.mock.timers.tick(2000);
    await settle();
  }
  assert.ok(f.logs.some((line) => line.includes("probe pending")));
  assert.equal(calls, 2);
  assert.equal(f.sockets[0].messages.length, 8, "Window heartbeats must continue while the probe is pending");
  assert.ok(f.sockets[0].messages.every((message) => message === "ping\n"));
  assert.equal(f.sockets[0].destroyed, false);
  finish({});
  await settle();
  assert.ok(f.logs.some((line) => line.includes("probe finished after 12000ms; last heartbeat age=0ms")));
  assert.equal(f.sockets[0].messages.length, 8, "Probe completion must not send an extra heartbeat");
  f.sockets[0].destroy();
  assert.ok(f.logs.some((line) => line.includes("control channel closed; last heartbeat age=0ms")));
});

test("a resumed probe after control channel closure cannot reconnect without explicit Retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  let finish;
  const f = fixture("ssh-remote", () => {
    if (++calls !== 2) return Promise.resolve({});
    return new Promise((resolve) => { finish = resolve; });
  });
  t.after(() => f.dispose());
  await settle();
  t.mock.timers.tick(2000);
  await settle();
  f.sockets[0].destroy();
  finish({});
  await settle();
  for (let n = 0; n < 7; n++) {
    t.mock.timers.tick(2000);
    await settle();
  }
  assert.equal(f.sockets.length, 1, "A stale probe must not acquire an unrenewed replacement lease");
  assert.equal(calls, 2);
  await f.commands["remoteProxy.retry"]();
  await settle();
  assert.equal(f.sockets.length, 2);
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(f.sockets[1].messages.length, 2);
});

test("an explicit remote probe failure releases the lease and stops heartbeats", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  let fail;
  const f = fixture("ssh-remote", () => {
    if (++calls === 1) return Promise.resolve({});
    return new Promise((resolve, reject) => { fail = reject; });
  });
  t.after(() => f.dispose());
  await settle();
  t.mock.timers.tick(2000);
  await settle();
  fail(new Error("Remote disconnected"));
  await settle();
  assert.equal(f.sockets[0].destroyed, true);
  assert.ok(f.logs.some((line) => line.includes("Remote disconnected")));
  const heartbeats = f.sockets[0].messages.length;
  t.mock.timers.tick(12000);
  await settle();
  assert.equal(f.sockets[0].messages.length, heartbeats);
  assert.equal(f.sockets.length, 1);
});

test("disposing a window during a pending live probe stops heartbeats and ignores its late failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  let fail;
  const f = fixture("ssh-remote", () => {
    if (++calls === 1) return Promise.resolve({});
    return new Promise((resolve, reject) => { fail = reject; });
  });
  t.after(() => f.dispose());
  await settle();
  t.mock.timers.tick(2000);
  await settle();
  f.dispose();
  const heartbeats = f.sockets[0].messages.length;
  fail(new Error("Probe completed after disposal"));
  await settle();
  t.mock.timers.tick(12000);
  await settle();
  assert.equal(f.sockets[0].destroyed, true);
  assert.equal(f.sockets[0].messages.length, heartbeats);
  assert.equal(f.sockets.length, 1);
  assert.ok(!f.logs.some((line) => /Probe completed after disposal|probe pending/.test(line)));
});

for (const outcome of ["resolved", "rejected"]) {
  test(`an obsolete ${outcome} probe cannot affect a new Retry generation`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let calls = 0;
    let finish;
    const f = fixture("ssh-remote", () => {
      if (++calls !== 2) return Promise.resolve({});
      return new Promise((resolve, reject) => {
        finish = () => outcome === "resolved" ? resolve({}) : reject(new Error("Obsolete probe failure"));
      });
    });
    t.after(() => f.dispose());
    await settle();
    t.mock.timers.tick(2000);
    await settle();
    await f.commands["remoteProxy.retry"]();
    await settle();
    finish();
    await settle();
    t.mock.timers.tick(2000);
    await settle();
    assert.equal(f.sockets.length, 2);
    assert.equal(f.sockets[1].destroyed, false);
    assert.equal(f.sockets[1].messages.length, 2);
    assert.ok(!f.logs.some((line) => line.includes("Obsolete probe failure")));
  });
}

test("fast probes do not log per-heartbeat diagnostics and cancelled probes do not log stale warnings", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fast = fixture("ssh-remote", async () => ({}));
  const cancelled = fixture("ssh-remote", () => new Promise(() => {}));
  t.after(() => { fast.dispose(); cancelled.dispose(); });
  await settle();
  cancelled.dispose();
  for (let n = 0; n < 4; n++) {
    t.mock.timers.tick(2000);
    await settle();
  }
  assert.ok(!fast.logs.some((line) => line.includes("filesystem probe")));
  assert.equal(cancelled.logs.length, 0);
  assert.equal(fast.sockets[0].messages.length, 5);
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

test("password input preserves empty and maximum-length passwords and rejects unsupported values", async (t) => {
  const f = fixture("ssh-remote", async () => ({}));
  t.after(() => f.dispose());
  await settle();
  f.sockets[0].emit("data", Buffer.from('{"state":"password","id":"validation"}\n'));
  await settle();
  const { validateInput } = f.prompts[0];
  for (const value of ["", "test-password", "x".repeat(8192)]) {
    assert.equal(validateInput(value), undefined);
  }
  for (const value of ["line\nbreak", "line\rbreak", "null\0byte", "x".repeat(8193)]) {
    assert.match(validateInput(value), /unsupported characters or is too long/);
  }
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
