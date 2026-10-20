"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { configPath, readHosts, words } = require("../ssh-config");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-ssh-config-"));
  const ssh = path.join(home, ".ssh");
  fs.mkdirSync(ssh);
  t.after(() => fs.rmSync(home, { recursive: true }));
  return { home, ssh, file: path.join(ssh, "config") };
}

test("default and tilde config paths resolve using the local home, not a hardcoded user", () => {
  assert.equal(configPath("", "/users/person"), path.join("/users/person", ".ssh", "config"));
  assert.equal(configPath("~/custom/config", "/users/person"), path.join("/users/person", "custom/config"));
  assert.throws(() => configPath("relative/config"), /absolute/);
});

test("enumerates multiple aliases, quotes, equals, comments and excludes wildcard/negated hosts", async (t) => {
  const { home, file } = fixture(t);
  fs.writeFileSync(file, [
    "Host robot-one robot-two # comment",
    "  HostName 192.0.2.1",
    'host = "lab-server"',
    "Host * *.internal ?dev !excluded [ab]robot",
    "HOST robot-one 192.0.2.10",
    "Match host lab-server",
    "  User user", ""
  ].join("\n"));
  assert.deepEqual(await readHosts(file, home), ["192.0.2.10", "lab-server", "robot-one", "robot-two"]);
});

test("Include supports nesting, sorted globs, spaces, missing paths and cycles", async (t) => {
  const { home, ssh, file } = fixture(t);
  fs.mkdirSync(path.join(ssh, "conf.d"));
  fs.writeFileSync(file, 'Include conf.d/*.conf "extra file" absent/*.conf\nHost main\n');
  fs.writeFileSync(path.join(ssh, "conf.d", "a.conf"), "Host included-a\nInclude config\n");
  fs.writeFileSync(path.join(ssh, "conf.d", "b.conf"), "Host included-b\n");
  fs.writeFileSync(path.join(ssh, "conf.d", ".hidden.conf"), "Host hidden\n");
  fs.writeFileSync(path.join(ssh, "extra file"), "Host with-space-include\nInclude missing-file\n");
  assert.deepEqual(await readHosts(file, home), ["included-a", "included-b", "main", "with-space-include"]);
});

test("relative Includes are resolved from ~/.ssh even for a custom root config", async (t) => {
  const { home, ssh } = fixture(t);
  const custom = path.join(home, "custom-config");
  fs.writeFileSync(custom, "Include aliases\nInclude ~/.ssh/more\n");
  fs.writeFileSync(path.join(ssh, "aliases"), "Host custom-alias\n");
  fs.writeFileSync(path.join(ssh, "more"), "Host second-alias\n");
  assert.deepEqual(await readHosts(custom, home), ["custom-alias", "second-alias"]);
});

test("missing root and malformed quotes surface errors with file/line context", async (t) => {
  const { home, file } = fixture(t);
  await assert.rejects(readHosts(file, home), /Cannot read SSH config/);
  fs.writeFileSync(file, 'Host good\nInclude "unclosed\n');
  await assert.rejects(readHosts(file, home), /config:2: Unterminated/);
});

test("tokenization handles quoted comments and escaped spaces without executing anything", () => {
  assert.deepEqual(words('Include "file#name" file\\ with\\ spaces # rest'), ["Include", "file#name", "file with spaces"]);
});

test("character class Include patterns are expanded", async (t) => {
  const { home, ssh, file } = fixture(t);
  fs.writeFileSync(file, "Include conf[12]\n");
  fs.writeFileSync(path.join(ssh, "conf1"), "Host one\n");
  fs.writeFileSync(path.join(ssh, "conf2"), "Host two\n");
  fs.writeFileSync(path.join(ssh, "conf3"), "Host three\n");
  assert.deepEqual(await readHosts(file, home), ["one", "two"]);
});
