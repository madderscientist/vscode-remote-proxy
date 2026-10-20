"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { createProxy, startBroker } = require("../broker");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function unusedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(check, description) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}
async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  await exited;
  clearTimeout(timer);
}

for (const useLocalProxy of [false, true]) {
test(`real OpenSSH forwarding (${useLocalProxy ? "existing local proxy" : "built-in proxy"}): HTTP, occupied port and shutdown`, {
  skip: process.platform !== "linux" || !fs.existsSync("/usr/sbin/sshd")
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-proxy-ssh-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  for (const name of ["host", "client"]) {
    const result = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, name)]);
    assert.equal(result.status, 0, result.stderr?.toString());
  }
  const sshPort = await unusedPort();
  const remotePort = await unusedPort();
  const config = path.join(dir, "sshd_config");
  fs.writeFileSync(config, [
    `Port ${sshPort}`, "ListenAddress 127.0.0.1",
    `HostKey ${path.join(dir, "host")}`,
    `PidFile ${path.join(dir, "sshd.pid")}`,
    `AuthorizedKeysFile ${path.join(dir, "client.pub")}`,
    "StrictModes no", "UsePAM no", "PasswordAuthentication no",
    "KbdInteractiveAuthentication no", "AllowTcpForwarding yes",
    `AllowUsers ${os.userInfo().username}`, ""
  ].join("\n"));
  const clientConfig = path.join(dir, "ssh_config");
  fs.writeFileSync(clientConfig, [
    "Host integration-host", " HostName 127.0.0.1", ` Port ${sshPort}`,
    ` User ${os.userInfo().username}`, ` IdentityFile ${path.join(dir, "client")}`,
    " IdentitiesOnly yes", " StrictHostKeyChecking yes",
    ` UserKnownHostsFile ${path.join(dir, "known_hosts")}`, ""
  ].join("\n"));
  const pub = fs.readFileSync(path.join(dir, "host.pub"), "utf8").trim().split(" ");
  fs.writeFileSync(path.join(dir, "known_hosts"), `[127.0.0.1]:${sshPort} ${pub[0]} ${pub[1]}\n`);
  const daemon = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
  let sshdLog = "";
  daemon.stderr.on("data", (data) => { sshdLog += data; });
  t.after(() => terminate(daemon));
  await waitFor(async () => {
    if (daemon.exitCode !== null) throw new Error(sshdLog);
    return new Promise((resolve) => {
      const socket = net.connect(sshPort, "127.0.0.1");
      socket.on("connect", () => { socket.destroy(); resolve(true); });
      socket.on("error", () => resolve(false));
    });
  }, "isolated sshd listening");
  const messages = [];
  let localProxyPort = 0;
  if (useLocalProxy) {
    const local = createProxy();
    local.server.listen(0, "127.0.0.1");
    await once(local.server, "listening");
    localProxyPort = local.server.address().port;
    t.after(() => local.close());
  }
  const broker = await startBroker({
    stateDir: path.join(dir, "broker"), host: "integration-host", remotePort,
    authentication: "key", configFile: clientConfig, localProxyPort,
    report: (message) => messages.push(message)
  });
  t.after(() => broker.stop());
  const lease = net.connect(broker.address);
  const states = [];
  lease.on("data", (data) => states.push(data.toString()));
  lease.on("error", () => {});
  t.after(() => lease.destroy());
  await once(lease, "connect");
  lease.write("ping\n");
  await waitFor(() => {
    if (states.join("").includes('"state":"error"')) throw new Error(states.join("") + sshdLog);
    return states.join("").includes('"state":"ready"');
  }, "SSH remote forward ready");
  const target = http.createServer((req, res) => res.end("through-real-ssh"));
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  t.after(() => new Promise((resolve) => target.close(resolve)));
  const body = await new Promise((resolve, reject) => {
    http.get({
      host: "127.0.0.1", port: remotePort,
      path: `http://127.0.0.1:${target.address().port}/`
    }, (res) => {
      let text = "";
      res.on("data", (data) => { text += data; });
      res.on("end", () => resolve(text));
    }).on("error", reject);
  });
  assert.equal(body, "through-real-ssh");
  await new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1", port: remotePort, method: "CONNECT",
      path: `127.0.0.1:${target.address().port}`
    });
    request.on("error", reject);
    request.on("connect", (response, socket, head) => {
      assert.equal(response.statusCode, 200);
      let received = head.toString();
      socket.on("error", reject);
      socket.on("data", (data) => { received += data; });
      socket.on("end", () => {
        try {
          assert.match(received, /through-real-ssh/);
          resolve();
        } catch (error) { reject(error); }
      });
      socket.end("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    });
    request.end();
  });
  const conflict = spawn("ssh", [
    "-F", clientConfig, "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
    "-R", `127.0.0.1:${remotePort}:127.0.0.1:9`, "integration-host", "true"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let conflictError = "";
  conflict.stderr.on("data", (data) => { conflictError += data; });
  t.after(() => terminate(conflict));
  const [code] = await once(conflict, "exit");
  assert.notEqual(code, 0);
  assert.match(conflictError, /remote port forwarding failed/);
  lease.destroy();
  await broker.closed;
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect(remotePort, "127.0.0.1");
    socket.on("connect", () => { socket.destroy(); resolve(); });
    socket.on("error", reject);
  }), /ECONNREFUSED/);
  assert.equal(messages.length, 0);
});
}
