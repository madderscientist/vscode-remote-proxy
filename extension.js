"use strict";

const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { fork } = require("node:child_process");
const { endpoint, validHost, validPassword, BROKER_BUSY_EXIT_CODE } = require("./broker");
const { configPath, readHosts } = require("./ssh-config");

function sshHosts(authority) {
  const found = new Set();
  function addHost(name, depth) {
    if (name.startsWith("ssh-remote+")) visit(name, depth + 1);
    else found.add(name);
  }
  function visit(value, depth = 0) {
    if (depth > 8 || value == null) return;
    if (typeof value === "object") {
      for (const child of Object.values(value)) visit(child, depth + 1);
    } else if (typeof value === "string") {
      if (value.startsWith("ssh-remote+")) {
        const name = value.slice("ssh-remote+".length);
        addHost(name, depth);
        if (/^(?:[a-fA-F0-9]{2})+$/.test(name)) visit(Buffer.from(name, "hex").toString(), depth + 1);
      }
      if (value.startsWith("dev-container+")) visit(value.slice("dev-container+".length), depth + 1);
      if (/^(?:[a-fA-F0-9]{2})+$/.test(value)) visit(Buffer.from(value, "hex").toString(), depth + 1);
      if (value.startsWith("{")) {
        try { return visit(JSON.parse(value), depth + 1); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      if (value.startsWith("vscode-remote://")) {
        visit(vscode.Uri.parse(value).authority, depth + 1);
      }
      if (value.includes("@") && !value.includes("://")) addHost(value.split("@").pop(), depth);
    }
    if (typeof value === "object" && typeof value.hostName === "string") addHost(value.hostName, depth);
  }
  visit(authority);
  return [...found];
}

function enabledHosts(value) {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new Error("remoteProxy.hosts must be an array of SSH Host aliases.");
}

function activate(context) {
  const output = vscode.window.createOutputChannel("Remote Proxy");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  status.command = "remoteProxy.showLog";
  let disposed = false;
  let generation = 0;
  let current;
  let timer;
  let paused = false;
  let lastError;
  const log = (message) => output.appendLine(`${new Date().toISOString()} ${message}`);
  const report = (error) => {
    if (disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    status.text = "$(warning) HTTP proxy";
    status.tooltip = message;
    if (message !== lastError) {
      lastError = message;
      log(message);
      void vscode.window.showWarningMessage(`Remote Proxy: ${message}`, "Show log").then((choice) => {
        if (choice) output.show();
      });
    }
  };
  const remoteUri = () => {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.map((folder) => folder.uri).find((uri) => uri.scheme === "vscode-remote")
      || (vscode.workspace.workspaceFile?.scheme === "vscode-remote" ? vscode.workspace.workspaceFile : undefined);
  };
  const closeCurrent = (reason) => {
    const socket = current;
    current = undefined;
    if (socket) {
      log(`Releasing broker control channel: ${reason}`);
      socket.destroy();
    }
  };
  const sshConfigFile = () => {
    const custom = vscode.workspace.getConfiguration("remoteProxy").get("sshConfigFile", "");
    const remote = vscode.workspace.getConfiguration("remote.SSH").get("configFile", "");
    return custom || remote ? configPath(custom || remote) : undefined;
  };
  async function configureHosts() {
    const file = sshConfigFile() || configPath();
    const aliases = await readHosts(file);
    if (!aliases.length) {
      return vscode.window.showWarningMessage(`No concrete Host aliases found in ${file}. Wildcard entries are not selectable.`);
    }
    const config = vscode.workspace.getConfiguration("remoteProxy");
    const hosts = enabledHosts(config.get("hosts", []));
    const items = aliases.map((alias) => ({
      label: alias, picked: hosts.includes(alias)
    }));
    const selected = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: "Select SSH hosts that should use Remote Proxy",
      placeHolder: file,
      ignoreFocusOut: true
    });
    if (!selected) return;
    const selectedNames = new Set(selected.map((item) => item.label));
    const listed = new Set(aliases);
    const next = [...new Set([...hosts.filter((alias) => !listed.has(alias)), ...selectedNames])];
    const removed = new Set(aliases.filter((alias) => !selectedNames.has(alias)));
    const bindings = { ...config.get("windowBindings", {}) };
    for (const [authority, destination] of Object.entries(bindings)) {
      const names = sshHosts(authority);
      if (names.some((name) => selectedNames.has(name))) delete bindings[authority];
      else if (names.some((name) => listed.has(name)) || removed.has(destination)) {
        bindings[authority] = "";
      }
    }
    await config.update("hosts", next, vscode.ConfigurationTarget.Global);
    await config.update("windowBindings", bindings, vscode.ConfigurationTarget.Global);
  }
  async function connect(stateDir, options, mine) {
    const address = endpoint(stateDir);
    const tryConnect = () => new Promise((resolve, reject) => {
      const socket = net.connect(address);
      const fail = (error) => {
        socket.destroy();
        if (["ENOENT", "ECONNREFUSED"].includes(error.code)) resolve();
        else reject(error);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.removeListener("error", fail);
        socket.on("error", report);
        resolve(socket);
      });
    });
    const existing = await tryConnect();
    if (existing) return existing;
    const logPath = path.join(stateDir, "broker.log");
    let child;
    let childError;
    let contended = false;
    const locked = () => ["broker.lock", "broker-starting.lock"]
      .some((name) => fs.existsSync(path.join(stateDir, name)));
    for (let n = 0; n < 100 && !disposed && mine === generation; n++) {
      if (childError) throw childError;
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        if (child.exitCode !== BROKER_BUSY_EXIT_CODE) {
          throw new Error(`Local broker exited (${child.exitCode ?? child.signalCode}). See ${logPath}`);
        }
        // A retiring broker holds its lock until its SSH process exits.
        contended = true;
        child = undefined;
      }
      if (!child && n % 5 === 0 && (!contended || !locked())) {
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const fd = fs.openSync(logPath, "a", 0o600);
        try {
          child = fork(path.join(context.extensionPath, "broker.js"), [JSON.stringify(options)], {
            execArgv: [],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            stdio: ["ignore", fd, fd, "ipc"],
            windowsHide: true
          });
        } finally {
          fs.closeSync(fd);
        }
        child.once("error", (error) => { childError = error; });
        child.disconnect();
        child.unref();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (disposed || mine !== generation) break;
      const socket = await tryConnect();
      if (socket) return socket;
    }
    const detail = contended ? " Broker startup encountered a lock conflict." : "";
    throw new Error(`Cannot start the local broker.${detail} See ${logPath}`);
  }
  async function restart(reason = "activation") {
    const mine = ++generation;
    paused = false;
    clearTimeout(timer);
    closeCurrent(`restart (${reason})`);
    status.hide();
    if (!["ssh-remote", "dev-container"].includes(vscode.env.remoteName)) return;
    const uri = remoteUri();
    if (!uri) {
      log("No remote workspace URI yet; open a remote folder to enable the proxy.");
      return;
    }
    const config = vscode.workspace.getConfiguration("remoteProxy");
    const hosts = enabledHosts(config.get("hosts", []));
    const bindings = config.get("windowBindings", {});
    const names = sshHosts(uri.authority);
    const host = Object.hasOwn(bindings, uri.authority)
      ? bindings[uri.authority]
      : names.find((name) => hosts.includes(name));
    if (!host) {
      status.text = "$(plug) Select proxy hosts";
      status.tooltip = "Click to select enabled hosts from your local SSH configuration.";
      status.command = "remoteProxy.configure";
      status.show();
      log(`Host not enabled. Decoded aliases: ${JSON.stringify(names)}. Enabled hosts: ${JSON.stringify(hosts)}. Run Configure enabled hosts.`);
      return;
    }
    status.command = "remoteProxy.showLog";
    status.show();
    if (!validHost(host)) return report(new Error("Invalid configured SSH destination"));
    const remotePort = config.get("remotePort", 1080);
    const sshPath = config.get("sshPath", "ssh");
    const authentication = config.get("authentication", "password");
    const configFile = sshConfigFile();
    const localProxyPort = config.get("localProxyPort", 0);
    const connection = { host, remotePort, sshPath, authentication, configFile, localProxyPort };
    const key = crypto.createHash("sha256").update(JSON.stringify(connection)).digest("hex").slice(0, 24);
    const stateDir = path.join(context.globalStorageUri.fsPath, key);
    const options = { stateDir, ...connection };
    let lastHeartbeat;
    let probing = false;
    const active = () => !disposed && mine === generation && !paused;
    const heartbeatAge = () => lastHeartbeat === undefined ? "not sent" : `${Date.now() - lastHeartbeat}ms`;
    async function answerPassword(message, socket) {
      try {
        const value = await vscode.window.showInputBox({
          title: `SSH authentication: ${host}`,
          prompt: "Password for this proxy SSH connection (not saved). Cancel to stop; use Retry to try again.",
          password: true,
          ignoreFocusOut: true,
          validateInput: (text) => validPassword(text)
            ? undefined : "Password contains unsupported characters or is too long."
        });
        if (disposed || mine !== generation || socket.destroyed) return;
        if (value === undefined) paused = true;
        socket.write(`${JSON.stringify({ type: "password", id: message.id, value: value ?? null })}\n`);
      } catch (error) {
        paused = true;
        socket.destroy();
        report(error);
      }
    }
    async function checkRemote() {
      probing = true;
      const started = Date.now();
      const warning = setTimeout(() => {
        if (active()) {
          log(`Remote filesystem probe pending for ${Date.now() - started}ms; last heartbeat age=${heartbeatAge()}`);
        }
      }, 5000);
      warning.unref();
      try {
        await vscode.workspace.fs.stat(uri);
      } finally {
        probing = false;
        clearTimeout(warning);
        if (active() && Date.now() - started >= 2000) {
          log(`Remote filesystem probe finished after ${Date.now() - started}ms; last heartbeat age=${heartbeatAge()}`);
        }
      }
    }
    function failLease(error) {
      if (disposed || mine !== generation) return;
      log(`Lease check failed; last heartbeat age=${heartbeatAge()}`);
      if (current) {
        paused = true;
        clearTimeout(timer);
        status.command = "remoteProxy.retry";
      }
      closeCurrent("lease check failed");
      report(error);
    }
    async function tick() {
      if (!active()) return;
      try {
        if (!current || current.destroyed) {
          await checkRemote();
          if (!active()) return;
          status.text = "$(sync~spin) HTTP proxy";
          let socket;
          try {
            socket = await connect(stateDir, options, mine);
          } catch (error) {
            if (disposed || mine !== generation) return;
            paused = true;
            status.command = "remoteProxy.retry";
            throw error;
          }
          if (!active()) {
            socket.destroy();
            return;
          }
          current = socket;
          log(`Broker control channel connected; generation=${mine}`);
          let buffer = "";
          socket.on("data", (data) => {
            buffer += data.toString();
            if (buffer.length > 16384) {
              report(new Error("Oversized broker response"));
              socket.destroy();
              return;
            }
            let index;
            while ((index = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, index);
              buffer = buffer.slice(index + 1);
              let message;
              try { message = JSON.parse(line); }
              catch (error) { report(error); socket.destroy(); return; }
              if (message.state === "error") {
                paused = true;
                report(new Error(message.message));
              } else if (message.state === "password") {
                void answerPassword(message, socket);
              } else if (message.state === "ready") {
                lastError = undefined;
                status.text = `$(globe) HTTP :${remotePort}`;
                status.tooltip = `${host} → ${localProxyPort ? `local HTTP proxy :${localProxyPort}` : "built-in direct HTTP proxy"}. Shared with other connected windows.`;
                log(`Proxy ready at ${host}:127.0.0.1:${remotePort}`);
              }
            }
          });
          socket.once("close", () => {
            if (current === socket) {
              log(`Broker control channel closed; last heartbeat age=${heartbeatAge()}`);
              current = undefined;
              if (!disposed) {
                paused = true;
                status.text = "$(debug-disconnect) HTTP proxy";
                status.tooltip = "Proxy stopped. Click to retry.";
                status.command = "remoteProxy.retry";
              }
            }
          });
        } else if (!probing) {
          const socket = current;
          // A slow remote filesystem is not evidence that the local window or proxy SSH disconnected.
          void checkRemote().catch((error) => {
            if (active() && current === socket) failLease(error);
          });
        }
        current.write("ping\n");
        lastHeartbeat = Date.now();
      } catch (error) {
        failLease(error);
      }
      if (active()) timer = setTimeout(tick, 2000);
    }
    void tick();
  }
  const command = (name, handler) => vscode.commands.registerCommand(
    `remoteProxy.${name}`, (...args) => Promise.resolve().then(() => handler(...args)).catch(report)
  );
  context.subscriptions.push(
    output, status,
    command("retry", () => restart("Retry command")),
    command("configure", configureHosts),
    command("disable", async () => {
      const uri = remoteUri();
      if (!uri) return vscode.window.showErrorMessage("Open a remote folder first.");
      const config = vscode.workspace.getConfiguration("remoteProxy");
      const hosts = enabledHosts(config.get("hosts", []));
      const bindings = { ...config.get("windowBindings", {}) };
      const names = sshHosts(uri.authority);
      const target = bindings[uri.authority] ||
        names.find((name) => hosts.includes(name));
      const next = hosts.filter((name) => name !== target && !names.includes(name));
      if (target) {
        for (const [authority, destination] of Object.entries(bindings)) {
          if (destination === target) bindings[authority] = "";
        }
      }
      bindings[uri.authority] = "";
      await config.update("hosts", next, vscode.ConfigurationTarget.Global);
      await config.update("windowBindings", bindings, vscode.ConfigurationTarget.Global);
    }),
    command("showLog", () => output.show()),
    command("attach", async () => {
      const uri = remoteUri();
      if (!uri) return vscode.window.showErrorMessage("Open a remote folder first.");
      const host = await vscode.window.showInputBox({
        title: "SSH destination on your LOCAL computer",
        value: sshHosts(uri.authority).find(validHost) || "",
        prompt: "Local SSH alias or user@host. Password is requested separately. Container must use host networking.",
        validateInput: (value) => validHost(value) ? undefined : "Enter an SSH config alias or user@host."
      });
      if (!host) return;
      const config = vscode.workspace.getConfiguration("remoteProxy");
      await config.update("hosts", [...new Set([...enabledHosts(config.get("hosts", [])), host])],
        vscode.ConfigurationTarget.Global);
      await config.update("windowBindings", {
        ...config.get("windowBindings", {}), [uri.authority]: host
      }, vscode.ConfigurationTarget.Global);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void restart("workspace folders changed").catch(report); }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("remoteProxy") || event.affectsConfiguration("remote.SSH.configFile")) {
        void restart("configuration changed").catch(report);
      }
    }),
    { dispose() { disposed = true; generation++; clearTimeout(timer); closeCurrent("window disposed"); } }
  );
  void restart().catch(report);
}

module.exports = { activate, sshHosts, enabledHosts };
