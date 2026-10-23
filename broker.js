"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const READY = "REMOTE_PROXY_READY";
const BROKER_BUSY_EXIT_CODE = 75;

function reportBroker(message) {
  console.error(`${new Date().toISOString()} [broker ${process.pid}] ${message}`);
}

function endpoint(stateDir) {
  const id = crypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\vscode-remote-proxy-${id}`
    : path.join(os.tmpdir(), `vscode-remote-proxy-${id}.sock`);
}

function validHost(host) {
  return typeof host === "string" && /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_.@:[\]-]*$/u.test(host);
}

function validPassword(value) {
  return typeof value === "string" && value.length <= 8192 && !/[\r\n\0]/.test(value);
}

function forwardedHeaders(headers) {
  const result = { ...headers };
  const nominated = String(headers.connection || "").split(",").map((s) => s.trim().toLowerCase());
  for (const name of [
    ...nominated, "connection", "proxy-connection", "proxy-authorization",
    "proxy-authenticate", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"
  ]) {
    delete result[name];
  }
  return result;
}

function createProxy(report = () => {}) {
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end("An absolute HTTP URL is required.\n");
      return;
    }
    if (target.protocol !== "http:" || target.username || target.password) {
      res.writeHead(400).end("Use CONNECT for HTTPS; URL credentials are not supported.\n");
      return;
    }
    const headers = forwardedHeaders(req.headers);
    headers.host = target.host;
    const upstream = http.request(target, { method: req.method, headers, agent: false }, (response) => {
      res.writeHead(response.statusCode, forwardedHeaders(response.headers));
      response.on("error", (error) => {
        report(`HTTP response failed: ${error.message}`);
        res.destroy(error);
      });
      response.pipe(res);
    });
    upstream.on("socket", track);
    upstream.on("error", (error) => {
      report(`HTTP request failed: ${error.message}`);
      if (!res.headersSent) res.writeHead(502).end("Upstream connection failed.\n");
      else res.destroy(error);
    });
    req.on("aborted", () => upstream.destroy());
    req.on("error", (error) => upstream.destroy(error));
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("connection", (socket) => {
    track(socket);
    socket.on("error", (error) => report(`Client connection failed: ${error.message}`));
  });
  server.on("connect", (req, client, head) => {
    let target;
    try {
      target = new URL(`https://${req.url}`);
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const port = Number(target.port || 443);
    const started = Date.now();
    const upstream = track(net.connect({ host, port }));
    let connected = false;
    const timer = setTimeout(() => upstream.destroy(new Error("CONNECT timed out")), 15000);
    upstream.once("connect", () => {
      connected = true;
      clearTimeout(timer);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (error) => {
      report(`CONNECT failed: ${error.message}; target=${target.hostname}:${port}; ` +
        `phase=${connected ? "tunnel" : "connect"}; elapsed=${Date.now() - started}ms; code=${error.code || "none"}`);
      if (!connected) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      else client.destroy();
    });
    upstream.once("close", () => {
      clearTimeout(timer);
      client.destroy();
    });
    client.once("close", () => upstream.destroy());
  });
  server.on("clientError", (error, socket) => {
    report(`Invalid proxy request: ${error.message}`);
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return {
    server,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

function checkLocalProxy(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setTimeout(3000, () => socket.destroy(new Error("Connection timed out")));
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", (error) => reject(new Error(
      `Local HTTP proxy 127.0.0.1:${port} is unavailable: ${error.message}`
    )));
  });
}

async function startBroker(options) {
  const {
    stateDir, host, remotePort = 1080, sshPath = "ssh",
    leaseMs = 10000, startupGraceMs = 15000, sshFactory = spawn, authentication = "password", configFile,
    localProxyPort = 0,
    report = reportBroker
  } = options;
  if (!validHost(host)) throw new Error("Invalid SSH destination");
  if (!Number.isInteger(localProxyPort) || localProxyPort < 0 || localProxyPort > 65535) {
    throw new Error("Invalid local proxy port");
  }
  if (!["password", "key"].includes(authentication)) throw new Error("Invalid authentication mode");
  if (configFile !== undefined && (typeof configFile !== "string" || !path.isAbsolute(configFile))) {
    throw new Error("SSH config path must be absolute");
  }
  if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) {
    throw new Error("Invalid remote port");
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, "broker.lock");
  const guardPath = path.join(stateDir, "broker-starting.lock");
  let guard;
  try {
    guard = fs.openSync(guardPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw Object.assign(new Error(`Another broker is starting: ${guardPath}`), { code: "EBROKERBUSY" });
  }
  try {
    if (fs.existsSync(lockPath)) {
      const pid = Number(fs.readFileSync(lockPath, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid broker lock: ${lockPath}`);
      try {
        process.kill(pid, 0);
        throw Object.assign(new Error(`Another broker is already running (PID ${pid})`), { code: "EBROKERBUSY" });
      } catch (probeError) {
        if (probeError.code !== "ESRCH") throw probeError;
      }
      fs.unlinkSync(lockPath);
    }
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
  } finally {
    fs.closeSync(guard);
    fs.unlinkSync(guardPath);
  }
  const address = endpoint(stateDir);
  let ownedSocket = false;
  let stopping = false;
  let everConnected = false;
  let ssh;
  let status = { state: "starting" };
  const clients = new Map();
  let nextLeaseId = 0;
  let pendingPassword;
  const token = crypto.randomBytes(32).toString("hex");
  const askpassPath = path.join(stateDir, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
  const authServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/password" ||
        req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end();
      return;
    }
    if (pendingPassword || stopping) {
      res.writeHead(409).end();
      return;
    }
    const pending = { id: crypto.randomUUID(), res, owner: undefined };
    pendingPassword = pending;
    pending.timer = setTimeout(() => {
      if (pendingPassword === pending) {
        pendingPassword = undefined;
        res.writeHead(408).end();
        void stop(new Error("Password input timed out; use Retry to reconnect"));
      }
    }, 120000);
    res.once("close", () => {
      clearTimeout(pending.timer);
      if (pendingPassword === pending) pendingPassword = undefined;
    });
    offerPassword();
  });
  function offerPassword() {
    if (!pendingPassword || pendingPassword.owner) return;
    const owner = [...clients.keys()].find((socket) => !socket.destroyed);
    if (owner) {
      pendingPassword.owner = owner;
      owner.write(`${JSON.stringify({ state: "password", id: pendingPassword.id, host })}\n`);
    }
  }
  const notify = (message) => {
    status = message;
    const payload = `${JSON.stringify(message)}\n`;
    for (const socket of clients.keys()) {
      if (!socket.destroyed) socket.write(payload);
    }
  };
  const proxy = localProxyPort ? undefined : createProxy(report);
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const control = net.createServer((socket) => {
    if (stopping) return socket.destroy();
    everConnected = true;
    const lease = { id: ++nextLeaseId, lastPing: Date.now(), expired: false };
    clients.set(socket, lease);
    report(`Window lease ${lease.id} connected; windows=${clients.size}`);
    socket.write(`${JSON.stringify(status)}\n`);
    offerPassword();
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      if (buffer.length > 32768) return socket.destroy(new Error("Oversized lease message"));
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const message = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (message !== "ping") {
          let reply;
          try { reply = JSON.parse(message); }
          catch { return socket.destroy(new Error("Invalid lease message")); }
          if (!pendingPassword || pendingPassword.owner !== socket || reply.id !== pendingPassword.id ||
              reply.type !== "password" || (reply.value !== null && typeof reply.value !== "string")) {
            return socket.destroy(new Error("Invalid authentication reply"));
          }
          const pending = pendingPassword;
          pendingPassword = undefined;
          clearTimeout(pending.timer);
          if (!validPassword(reply.value)) {
            pending.res.writeHead(403).end();
            void stop(new Error("Authentication cancelled; use Retry to reconnect"));
          } else {
            pending.res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end(reply.value);
          }
          continue;
        }
        lease.lastPing = Date.now();
      }
    });
    socket.on("error", (error) => report(`Lease connection failed: ${error.message}`));
    socket.once("close", () => {
      clients.delete(socket);
      report(`Window lease ${lease.id} closed; reason=${lease.expired ? "expired" : "control channel closed"}; windows=${clients.size}`);
      if (pendingPassword?.owner === socket) {
        pendingPassword.owner = undefined;
        offerPassword();
      }
      if (!clients.size) void stop(undefined, lease.expired ? "last window lease expired" : "last window disconnected");
    });
  });
  const cleanupFiles = () => {
    if (ownedSocket && process.platform !== "win32" && fs.existsSync(address)) fs.unlinkSync(address);
    if (fs.existsSync(askpassPath)) fs.unlinkSync(askpassPath);
    if (fs.existsSync(lockPath) && fs.readFileSync(lockPath, "utf8") === String(process.pid)) {
      fs.unlinkSync(lockPath);
    }
  };
  let sweep;
  let startupTimer;
  let authenticationTimer;
  async function stop(error, reason = error ? "error" : "requested") {
    if (stopping) return closed;
    stopping = true;
    report(`Stopping broker: ${reason}; windows=${clients.size}; SSH PID=${ssh?.pid ?? "none"}`);
    if (error) {
      report(error.message);
      notify({ state: "error", message: error.message });
    }
    clearInterval(sweep);
    clearTimeout(startupTimer);
    clearTimeout(authenticationTimer);
    if (pendingPassword) {
      clearTimeout(pendingPassword.timer);
      pendingPassword.res.writeHead(403).end();
      pendingPassword = undefined;
    }
    authServer.close();
    authServer.closeAllConnections();
    if (error && clients.size) {
      let timer;
      await Promise.race([
        Promise.all([...clients.keys()].map((client) => new Promise((resolve) => client.end(resolve)))),
        new Promise((resolve) => { timer = setTimeout(resolve, 250); })
      ]);
      clearTimeout(timer);
    }
    for (const client of clients.keys()) client.destroy();
    control.close();
    if (ssh?.pid && ssh.exitCode === null && ssh.signalCode === null) {
      const exited = new Promise((resolve) => ssh.once("exit", resolve));
      ssh.kill();
      const force = setTimeout(() => ssh.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(force);
    }
    if (proxy) await proxy.close();
    cleanupFiles();
    resolveClosed();
    return closed;
  }
  try {
    if (process.platform !== "win32" && fs.existsSync(address)) {
      if (!fs.lstatSync(address).isSocket()) throw new Error(`Not a socket: ${address}`);
      fs.unlinkSync(address);
    }
    await once(control.listen(address), "listening");
    ownedSocket = true;
    if (process.platform !== "win32") fs.chmodSync(address, 0o600);
    if (proxy) {
      await once(proxy.server.listen(0, "127.0.0.1"), "listening");
    } else {
      await checkLocalProxy(localProxyPort);
    }
    const port = localProxyPort || proxy.server.address().port;
    await once(authServer.listen(0, "127.0.0.1"), "listening");
    fs.writeFileSync(askpassPath, process.platform === "win32"
      ? '@echo off\r\n"%REMOTE_PROXY_NODE%" "%REMOTE_PROXY_HELPER%"\r\n'
      : '#!/bin/sh\nexec "$REMOTE_PROXY_NODE" "$REMOTE_PROXY_HELPER"\n',
    { mode: 0o700 });
    const args = [
      ...(configFile ? ["-F", configFile] : []),
      "-T", "-o", `BatchMode=${authentication === "key" ? "yes" : "no"}`,
      "-o", "StrictHostKeyChecking=yes",
      "-o", `PreferredAuthentications=${authentication === "key" ? "publickey" : "password"}`,
      "-o", "NumberOfPasswordPrompts=1", "-o", "ExitOnForwardFailure=yes",
      "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5",
      "-o", "ServerAliveCountMax=2",
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no",
      "-o", "RemoteCommand=none",
      "-R", `127.0.0.1:${remotePort}:127.0.0.1:${port}`,
      host, `printf '${READY}\\n'; cat >/dev/null`
    ];
    ssh = sshFactory(sshPath, args, {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: {
        ...process.env, SSH_ASKPASS: askpassPath, SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: process.env.DISPLAY || ":0", ELECTRON_RUN_AS_NODE: "1",
        REMOTE_PROXY_NODE: process.execPath, REMOTE_PROXY_HELPER: path.join(__dirname, "askpass.js"),
        REMOTE_PROXY_ASKPASS_PORT: String(authServer.address().port), REMOTE_PROXY_ASKPASS_TOKEN: token
      }
    });
    let output = "";
    let stderr = "";
    ssh.stdout.on("data", (data) => {
      if (status.state === "ready") return;
      output = (output + data.toString()).slice(-4096);
      if (output.split(/\r?\n/).includes(READY)) {
        clearTimeout(authenticationTimer);
        notify({ state: "ready", host, remotePort });
      }
    });
    ssh.stderr.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-4096);
    });
    ssh.stdin.on("error", (error) => { if (!stopping) void stop(error); });
    ssh.once("error", (error) => { void stop(error); });
    ssh.once("exit", (code, signal) => {
      if (!stopping) void stop(new Error(`SSH exited (${code ?? signal}): ${stderr.trim()}`));
    });
    startupTimer = setTimeout(() => {
      if (!everConnected) void stop(new Error("No VS Code window acquired the proxy"));
      else if (status.state !== "ready" && !pendingPassword) void stop(new Error(`SSH startup timed out: ${stderr.trim()}`));
    }, startupGraceMs);
    authenticationTimer = setTimeout(() => {
      void stop(new Error("SSH authentication timed out; use Retry to reconnect"));
    }, 135000);
    sweep = setInterval(() => {
      const now = Date.now();
      for (const [socket, lease] of clients) {
        if (!socket.destroyed && now - lease.lastPing > leaseMs) {
          lease.expired = true;
          report(`Window lease ${lease.id} expired; heartbeat age=${now - lease.lastPing}ms; limit=${leaseMs}ms; windows=${clients.size}`);
          socket.destroy();
        }
      }
    }, Math.min(1000, leaseMs / 2));
    control.on("error", (error) => { void stop(error); });
    proxy?.server.on("error", (error) => { void stop(error); });
    authServer.on("error", (error) => { void stop(error); });
  } catch (error) {
    await stop(error);
    throw error;
  }
  return { address, closed, stop, proxyPort: localProxyPort || proxy.server.address()?.port };
}

module.exports = { createProxy, endpoint, startBroker, validHost, validPassword, BROKER_BUSY_EXIT_CODE };

if (require.main === module) {
  let broker;
  const stop = (signal) => { if (broker) void broker.stop(undefined, signal); };
  process.on("SIGTERM", () => stop("signal SIGTERM"));
  process.on("SIGINT", () => stop("signal SIGINT"));
  reportBroker("Starting broker");
  startBroker(JSON.parse(process.argv[2])).then((value) => {
    broker = value;
    reportBroker("Control channel listening");
    void broker.closed.then(() => reportBroker("Stopped; SSH exited and broker resources released"));
  }).catch((error) => {
    reportBroker(`${error.code ? `${error.code}: ` : ""}${error.message}`);
    process.exitCode = error.code === "EBROKERBUSY" ? BROKER_BUSY_EXIT_CODE : 1;
  });
}
