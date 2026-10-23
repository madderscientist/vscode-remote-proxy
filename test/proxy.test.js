"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once, EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createProxy, startBroker, endpoint, validHost, validPassword } = require("../broker");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
async function deadline(promise, ms = 4000) {
  let timer;
  try {
    return await Promise.race([
      promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out")), ms); })
    ]);
  } finally { clearTimeout(timer); }
}

test("HTTP forwards method, body and headers, but not proxy credentials", async (t) => {
  const target = http.createServer((req, res) => {
    let body = "";
    req.on("data", (data) => { body += data; });
    req.on("end", () => {
      assert.equal(req.method, "POST");
      assert.equal(req.headers["proxy-authorization"], undefined);
      assert.equal(req.headers["x-remove"], undefined);
      res.setHeader("x-upstream", "yes");
      res.end(`${req.url}:${body}`);
    });
  });
  const proxy = createProxy();
  await listen(target);
  await listen(proxy.server);
  t.after(async () => { await proxy.close(); await close(target); });
  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: proxy.server.address().port, method: "POST",
      path: `http://127.0.0.1:${target.address().port}/check?q=1`,
      headers: { "proxy-authorization": "secret", connection: "x-remove", "x-remove": "no" }
    }, (res) => {
      let body = "";
      res.on("data", (data) => { body += data; });
      res.on("end", () => resolve({ status: res.statusCode, body, header: res.headers["x-upstream"] }));
    });
    req.on("error", reject);
    req.end("hello");
  });
  assert.deepEqual(result, { status: 200, body: "/check?q=1:hello", header: "yes" });
});

test("CONNECT tunnels both directions including bytes after the request headers", async (t) => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const proxy = createProxy();
  await listen(echo);
  await listen(proxy.server);
  const client = net.connect(proxy.server.address().port, "127.0.0.1");
  t.after(async () => { client.destroy(); await proxy.close(); await close(echo); });
  client.write(`CONNECT 127.0.0.1:${echo.address().port} HTTP/1.1\r\nHost: target\r\n\r\nhello`);
  let received = "";
  await deadline(new Promise((resolve, reject) => {
    client.on("error", reject);
    client.on("data", (data) => {
      received += data.toString();
      if (received.endsWith("hello")) resolve();
    });
  }));
  assert.match(received, /^HTTP\/1.1 200 Connection Established\r\n\r\nhello$/);
});

test("an upstream CONNECT reset is diagnosed without closing other tunnels or logging credentials", async (t) => {
  const messages = [];
  const proxy = createProxy((message) => messages.push(message));
  const reset = net.createServer((socket) => socket.once("data", () => socket.resetAndDestroy()));
  const echo = net.createServer((socket) => socket.pipe(socket));
  await listen(reset);
  await listen(echo);
  await listen(proxy.server);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    await proxy.close();
    await close(reset);
    await close(echo);
  });
  async function tunnel(port) {
    const client = net.connect(proxy.server.address().port, "127.0.0.1");
    clients.push(client);
    client.on("error", () => {});
    const response = deadline(once(client, "data"));
    client.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: target\r\nProxy-Authorization: test-secret-header\r\n\r\n`);
    const [data] = await response;
    assert.equal(data.toString(), "HTTP/1.1 200 Connection Established\r\n\r\n");
    return client;
  }
  const healthy = await tunnel(echo.address().port);
  const broken = await tunnel(reset.address().port);
  const brokenClosed = deadline(once(broken, "close"));
  broken.write("test-payload-not-for-logging");
  await brokenClosed;
  assert.equal(healthy.destroyed, false);
  const received = deadline(once(healthy, "data"));
  healthy.write("still-connected");
  assert.equal((await received)[0].toString(), "still-connected");
  const diagnostic = messages.find((message) => message.startsWith("CONNECT failed:"));
  assert.match(diagnostic, /code=ECONNRESET/);
  assert.ok(diagnostic.includes(`target=127.0.0.1:${reset.address().port}`));
  assert.match(diagnostic, /phase=tunnel; elapsed=\d+ms/);
  assert.ok(!messages.join("\n").includes("test-secret-header"));
  assert.ok(!messages.join("\n").includes("test-payload-not-for-logging"));
});

test("a CONNECT failure before upstream establishment reports the connect phase and returns 502", async (t) => {
  const messages = [];
  const proxy = createProxy((message) => messages.push(message));
  const unused = net.createServer();
  await listen(unused);
  const port = unused.address().port;
  await close(unused);
  await listen(proxy.server);
  const client = net.connect(proxy.server.address().port, "127.0.0.1");
  t.after(async () => { client.destroy(); await proxy.close(); });
  const response = deadline(once(client, "data"));
  client.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: target\r\n\r\n`);
  assert.match((await response)[0].toString(), /^HTTP\/1.1 502 Bad Gateway/);
  const diagnostic = messages.find((message) => message.startsWith("CONNECT failed:"));
  assert.ok(diagnostic.includes(`target=127.0.0.1:${port}`));
  assert.match(diagnostic, /phase=connect; elapsed=\d+ms; code=ECONNREFUSED/);
});

test("invalid HTTP requests and unreachable upstreams produce explicit errors", async (t) => {
  const messages = [];
  const proxy = createProxy((message) => messages.push(message));
  await listen(proxy.server);
  t.after(() => proxy.close());
  async function request(url) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: proxy.server.address().port, path: url }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
    });
  }
  assert.equal(await request("/relative"), 400);
  assert.equal(await request("https://example.invalid"), 400);
  const unused = net.createServer();
  await listen(unused);
  const port = unused.address().port;
  await close(unused);
  assert.equal(await request(`http://127.0.0.1:${port}/`), 502);
  assert.ok(messages.some((message) => message.includes("HTTP request failed")));
});

function fakeSsh(command, args, options) {
  assert.equal(command, "ssh");
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
  assert.match(args[args.indexOf("-R") + 1], /^127\.0\.0\.1:1080:127\.0\.0\.1:\d+$/);
  assert.equal(args.at(-2), "developer@192.0.2.10");
  return spawn(process.execPath, ["-e",
    "process.stdout.write('REMOTE_PROXY_READY\\n');process.stdin.resume();"
  ], options);
}

async function brokerFixture(t, overrides = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-proxy-test-"));
  const messages = [];
  const broker = await startBroker({
    stateDir, host: "developer@192.0.2.10", sshFactory: fakeSsh,
    leaseMs: 300, startupGraceMs: 1500, report: (message) => messages.push(message), ...overrides
  });
  t.after(async () => {
    await broker.stop();
    fs.rmSync(stateDir, { recursive: true });
  });
  return { stateDir, broker, messages };
}

async function clientFor(broker) {
  const socket = net.connect(broker.address);
  socket.on("error", () => {});
  socket.resume();
  await once(socket, "connect");
  socket.write("ping\n");
  return socket;
}

test("SSH and container windows share one broker; closing the SSH window preserves the container lease", async (t) => {
  const { broker, stateDir, messages } = await brokerFixture(t);
  const sshWindow = await clientFor(broker);
  const containerWindow = await clientFor(broker);
  t.after(() => { sshWindow.destroy(); containerWindow.destroy(); });
  sshWindow.destroy();
  await delay(100);
  assert.equal(containerWindow.destroyed, false);
  assert.ok(fs.existsSync(path.join(stateDir, "broker.lock")));
  containerWindow.write("ping\n");
  containerWindow.destroy();
  await deadline(broker.closed);
  assert.ok(messages.some((message) => message.includes("Stopping broker: last window disconnected")));
  assert.ok(!messages.some((message) => message.includes("expired")));
  assert.equal(fs.existsSync(path.join(stateDir, "broker.lock")), false);
  if (process.platform !== "win32") assert.equal(fs.existsSync(endpoint(stateDir)), false);
});

test("a disconnected or hung window loses its lease even if its control socket stays open", async (t) => {
  const { broker, messages } = await brokerFixture(t);
  const socket = await clientFor(broker);
  t.after(() => socket.destroy());
  const start = Date.now();
  await deadline(broker.closed, 2000);
  assert.ok(Date.now() - start >= 250);
  assert.ok(Date.now() - start < 1500);
  const expired = messages.find((message) => message.includes("expired; heartbeat age="));
  assert.match(expired, /Window lease 1 expired; heartbeat age=\d+ms; limit=300ms; windows=1/);
  assert.ok(Number(expired.match(/age=(\d+)ms/)[1]) > 300);
  assert.ok(messages.some((message) => message.includes("Stopping broker: last window lease expired")));
});

test("a healthy second window survives expiration of the disconnected first window", async (t) => {
  const { broker } = await brokerFixture(t);
  const stale = await clientFor(broker);
  const active = await clientFor(broker);
  t.after(() => { stale.destroy(); active.destroy(); });
  const timer = setInterval(() => active.write("ping\n"), 50);
  t.after(() => clearInterval(timer));
  await delay(650);
  assert.equal(stale.destroyed, true);
  assert.equal(active.destroyed, false);
  clearInterval(timer);
  active.destroy();
  await deadline(broker.closed);
});

test("SSH startup failure is sent to the window, and occupied ports are not taken over", async (t) => {
  const failingSsh = () => spawn(process.execPath, ["-e",
    "setTimeout(()=>{process.stderr.write('remote port forwarding failed');process.exit(1)},150);"
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const { broker } = await brokerFixture(t, { sshFactory: failingSsh });
  const socket = await clientFor(broker);
  let text = "";
  socket.on("data", (data) => { text += data.toString(); });
  t.after(() => socket.destroy());
  await deadline(broker.closed);
  if (!socket.destroyed) await deadline(once(socket, "close"));
  assert.match(text, /remote port forwarding failed/);
});

test("missing SSH executable fails without leaving a broker running", async (t) => {
  const { broker } = await brokerFixture(t, {
    sshPath: "/this-executable-does-not-exist", sshFactory: spawn
  });
  await deadline(broker.closed);
});

test("an unclaimed broker exits rather than remaining in the background", async (t) => {
  const { broker, messages } = await brokerFixture(t, { startupGraceMs: 200 });
  await deadline(broker.closed);
  assert.ok(messages.some((message) => message.includes("Stopping broker: error; windows=0")));
  assert.ok(messages.some((message) => message.includes("No VS Code window acquired")));
});

test("another broker cannot replace a running broker's socket or lock", async (t) => {
  const { broker, stateDir } = await brokerFixture(t);
  const socket = await clientFor(broker);
  t.after(() => socket.destroy());
  await assert.rejects(startBroker({
    stateDir, host: "developer@192.0.2.10", sshFactory: fakeSsh
  }), { code: "EBROKERBUSY", message: /already running/ });
  assert.equal(socket.destroyed, false);
});

test("an occupied Windows control pipe reports the listen error and releases only its own lock", {
  skip: process.platform !== "win32"
}, async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-proxy-pipe-test-"));
  const occupied = net.createServer((socket) => socket.end());
  t.after(async () => {
    await close(occupied);
    fs.rmSync(stateDir, { recursive: true });
  });
  await once(occupied.listen(endpoint(stateDir)), "listening");
  const messages = [];
  await assert.rejects(startBroker({
    stateDir, host: "lab", report: (message) => messages.push(message),
    sshFactory() { assert.fail("SSH must not start when the control pipe is occupied"); }
  }), { code: "EADDRINUSE" });
  assert.ok(messages.some((message) => message.includes("EADDRINUSE")));
  assert.equal(fs.existsSync(path.join(stateDir, "broker.lock")), false);
  assert.equal(fs.existsSync(path.join(stateDir, "broker-starting.lock")), false);
  const client = net.connect(endpoint(stateDir));
  t.after(() => client.destroy());
  await once(client, "connect");
  client.destroy();
});

test("a shutting-down broker keeps its lock after closing its control channel until SSH exits", async (t) => {
  const ssh = new EventEmitter();
  ssh.pid = process.pid;
  ssh.exitCode = null;
  ssh.signalCode = null;
  ssh.stdin = new PassThrough();
  ssh.stdout = new PassThrough();
  ssh.stderr = new PassThrough();
  let killed;
  const terminationRequested = new Promise((resolve) => { killed = resolve; });
  ssh.kill = () => { killed(); return true; };
  const { broker, stateDir } = await brokerFixture(t, { sshFactory: () => ssh });
  const stopping = broker.stop();
  try {
    await deadline(terminationRequested);
    const socket = net.connect(broker.address);
    t.after(() => socket.destroy());
    await assert.rejects(once(socket, "connect"),
      (error) => ["ENOENT", "ECONNREFUSED"].includes(error.code));
    assert.ok(fs.existsSync(path.join(stateDir, "broker.lock")));
    await assert.rejects(startBroker({
      stateDir, host: "developer@192.0.2.10", sshFactory: fakeSsh
    }), { code: "EBROKERBUSY" });
  } finally {
    ssh.exitCode = 0;
    ssh.emit("exit", 0, null);
    await deadline(stopping);
  }
  assert.equal(fs.existsSync(path.join(stateDir, "broker.lock")), false);
});

for (const lock of ["broker.lock", "broker-starting.lock"]) {
  test(`broker subprocess reports retryable contention for ${lock} without changing it`, async (t) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-proxy-lock-test-"));
    t.after(() => fs.rmSync(stateDir, { recursive: true }));
    const lockPath = path.join(stateDir, lock);
    const contents = String(process.pid);
    fs.writeFileSync(lockPath, contents);
    const child = spawn(process.execPath, [
      path.resolve(__dirname, "../broker.js"), JSON.stringify({ stateDir, host: "lab" })
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    const [code] = await once(child, "exit");
    assert.equal(code, 75, stderr);
    assert.match(stderr, /Another broker is/);
    assert.equal(fs.readFileSync(lockPath, "utf8"), contents);
  });
}

test("SSH destinations cannot inject command-line options", () => {
  assert.equal(validHost("developer@192.0.2.10"), true);
  assert.equal(validHost("my-ssh-alias"), true);
  assert.equal(validHost("lab下server"), true);
  assert.equal(validHost("-oProxyCommand=bad"), false);
  assert.equal(validHost("host;command"), false);
  assert.equal(validHost("host\ncommand"), false);
});

test("password validation preserves length limits and rejects non-string or multiline values", () => {
  for (const value of ["", "test-password", "x".repeat(8192)]) {
    assert.equal(validPassword(value), true);
  }
  for (const value of [null, undefined, 123, {}, "line\nbreak", "line\rbreak", "null\0byte", "x".repeat(8193)]) {
    assert.equal(validPassword(value), false);
  }
});

test("SSH output after startup does not send duplicate ready notifications", async (t) => {
  let ssh;
  const { broker } = await brokerFixture(t, {
    sshFactory: (command, args, options) => {
      ssh = spawn(process.execPath, ["-e",
        "process.stdin.on('data',()=>{process.stdout.write('REMOTE_PROXY_');" +
        "setTimeout(()=>process.stdout.write('READY\\n'),20)});"
      ], options);
      return ssh;
    },
    leaseMs: 3000
  });
  const client = await clientFor(broker);
  t.after(() => client.destroy());
  let buffer = "";
  let ready = 0;
  await deadline(new Promise((resolve) => {
    client.on("data", (data) => {
      buffer += data.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (message.state === "ready") {
          ready++;
          if (ready === 1) {
            ssh.stdin.write("again");
            setTimeout(resolve, 100);
          }
        }
      }
    });
    ssh.stdin.write("start");
  }));
  assert.equal(ready, 1);
});

test("existing-proxy mode forwards the configured port and leaves the external proxy running on shutdown", async (t) => {
  const local = http.createServer((req, res) => res.end("external-proxy"));
  await listen(local);
  t.after(() => close(local));
  const port = local.address().port;
  const { broker } = await brokerFixture(t, {
    localProxyPort: port,
    sshFactory(command, args, options) {
      assert.equal(args[args.indexOf("-R") + 1], `127.0.0.1:1080:127.0.0.1:${port}`);
      return fakeSsh(command, args, options);
    }
  });
  assert.equal(broker.proxyPort, port);
  const client = await clientFor(broker);
  t.after(() => client.destroy());
  client.destroy();
  await deadline(broker.closed);
  const body = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, agent: false }, (res) => {
      let text = "";
      res.on("data", (data) => { text += data; });
      res.on("end", () => resolve(text));
    }).on("error", reject);
  });
  assert.equal(body, "external-proxy");
});

test("invalid or unavailable local proxy ports fail explicitly and release broker resources", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-proxy-upstream-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  for (const localProxyPort of [-1, 65536, 1.5, "7890"]) {
    await assert.rejects(startBroker({
      stateDir: dir, host: "lab", localProxyPort
    }), /Invalid local proxy port/);
  }
  const unused = net.createServer();
  await listen(unused);
  const port = unused.address().port;
  await close(unused);
  await assert.rejects(startBroker({
    stateDir: dir, host: "lab", localProxyPort: port, report() {},
    sshFactory: () => { assert.fail("Must not connect SSH when local proxy is unavailable"); }
  }), /Local HTTP proxy .* is unavailable/);
  assert.equal(fs.existsSync(path.join(dir, "broker.lock")), false);
});

function passwordSsh(command, args, options) {
  assert.ok(args.includes("BatchMode=no"));
  assert.ok(args.includes("PreferredAuthentications=password"));
  assert.equal(options.env.SSH_ASKPASS_REQUIRE, "force");
  return spawn(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    const helper=process.platform==='win32'
      ? spawn('"'+process.env.SSH_ASKPASS+'"',[],{env:process.env,shell:process.env.ComSpec})
      : spawn(process.env.SSH_ASKPASS,[],{env:process.env});
    helper.stderr.pipe(process.stderr);
    let reply='';
    helper.stdout.on('data',d=>reply+=d);
    helper.on('exit',code=>{
      if(code!==0 || reply!=='test-only-password\\n') process.exit(1);
      process.stdout.write('REMOTE_PROXY_READY\\n');
      process.stdin.resume();
    });
  `], options);
}

test("real askpass helper transports a password without putting it in files or logs", async (t) => {
  const { broker, stateDir, messages } = await brokerFixture(t, {
    sshFactory: passwordSsh, leaseMs: 3000, startupGraceMs: 1000
  });
  const client = await clientFor(broker);
  t.after(() => client.destroy());
  let buffer = "";
  let asked = 0;
  await deadline(new Promise((resolve, reject) => {
    broker.closed.then(() => reject(new Error(messages.join("\n") || "Broker closed before authentication")));
    client.on("data", (data) => {
      buffer += data.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (message.state === "password") {
          asked++;
          client.write(JSON.stringify({ type: "password", id: message.id, value: "test-only-password" }) + "\n");
        }
        if (message.state === "ready") resolve();
      }
    });
  }));
  assert.equal(asked, 1);
  assert.ok(!messages.join("").includes("test-only-password"));
  for (const name of fs.readdirSync(stateDir)) {
    const file = path.join(stateDir, name);
    if (fs.statSync(file).isFile()) assert.ok(!fs.readFileSync(file, "utf8").includes("test-only-password"));
  }
  client.destroy();
  await deadline(broker.closed);
  assert.ok(!fs.existsSync(path.join(stateDir, process.platform === "win32" ? "askpass.cmd" : "askpass.sh")));
});

for (const [reason, value] of [
  ["cancellation", null], ["line feed", "line\nbreak"], ["carriage return", "line\rbreak"],
  ["null byte", "null\0byte"], ["oversized password", "x".repeat(8193)]
]) {
  test(`askpass ${reason} stops SSH and does not request another password`, async (t) => {
    const { broker, messages } = await brokerFixture(t, {
      sshFactory: passwordSsh, leaseMs: 3000, startupGraceMs: 1000
    });
    const client = await clientFor(broker);
    t.after(() => client.destroy());
    let buffer = "";
    client.on("data", (data) => {
      buffer += data.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (message.state === "password") {
          client.write(JSON.stringify({ type: "password", id: message.id, value }) + "\n");
        }
      }
    });
    await deadline(broker.closed);
    assert.ok(messages.some((message) => message.includes("Authentication cancelled")));
  });
}

test("askpass endpoint rejects unauthenticated clients without prompting VS Code", async (t) => {
  let env;
  const { broker } = await brokerFixture(t, {
    sshFactory: (command, args, options) => {
      env = options.env;
      return fakeSsh(command, args, options);
    }
  });
  const client = await clientFor(broker);
  t.after(() => client.destroy());
  let text = "";
  client.on("data", (data) => { text += data; });
  const code = await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: Number(env.REMOTE_PROXY_ASKPASS_PORT),
      method: "POST", path: "/password", headers: { authorization: "Bearer invalid" }
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(code, 403);
  assert.ok(!text.includes('"state":"password"'));
});

test("two windows share one password prompt and one authenticated connection", async (t) => {
  const { broker } = await brokerFixture(t, {
    sshFactory: passwordSsh, leaseMs: 3000, startupGraceMs: 1000
  });
  const one = await clientFor(broker);
  const two = await clientFor(broker);
  t.after(() => { one.destroy(); two.destroy(); });
  let asked = 0;
  let ready = 0;
  await deadline(new Promise((resolve) => {
    for (const client of [one, two]) {
      let buffer = "";
      client.on("data", (data) => {
        buffer += data.toString();
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (message.state === "password") {
            asked++;
            client.write(JSON.stringify({ type: "password", id: message.id, value: "test-only-password" }) + "\n");
          }
          if (message.state === "ready" && ++ready === 2) resolve();
        }
      });
    }
  }));
  assert.equal(asked, 1);
});
