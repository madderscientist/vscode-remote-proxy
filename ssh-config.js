"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { validHost } = require("./broker");

function configPath(value, home = os.homedir()) {
  if (!value) return path.join(home, ".ssh", "config");
  if (value === "~") return home;
  if (/^~[/\\]/.test(value)) return path.join(home, value.slice(2));
  if (!path.isAbsolute(value)) throw new Error("SSH config path must be absolute or start with ~/.");
  return value;
}

function words(line) {
  const result = [];
  let word = "";
  let quote = "";
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      word += ch;
      escaped = false;
    } else if (ch === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (ch === quote) quote = "";
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      break;
    } else if (/\s/.test(ch)) {
      if (word) result.push(word);
      word = "";
    } else {
      word += ch;
    }
  }
  if (quote || escaped) throw new Error("Unterminated quote or escape in SSH configuration");
  if (word) result.push(word);
  return result;
}

function patternRegex(pattern) {
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") expression += ".*";
    else if (ch === "?") expression += ".";
    else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) throw new Error(`Invalid Include pattern: ${pattern}`);
      let content = pattern.slice(i + 1, end);
      if (!content || content.includes("\\") || content.includes("[")) {
        throw new Error(`Unsupported Include character class: ${pattern}`);
      }
      if (content.startsWith("!")) content = "^" + content.slice(1);
      expression += `[${content}]`;
      i = end;
    } else expression += ch.replace(/[\\^$+.(){}|]/g, "\\$&");
  }
  return new RegExp(expression + "$");
}

async function expandPattern(pattern) {
  const parsed = path.parse(pattern);
  let candidates = [parsed.root];
  for (const part of pattern.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    const next = [];
    const regex = /[*?[]/.test(part) ? patternRegex(part) : undefined;
    for (const base of candidates) {
      if (!regex) {
        next.push(path.join(base, part));
        continue;
      }
      let entries;
      try { entries = await fs.readdir(base); }
      catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
        throw error;
      }
      for (const entry of entries.sort()) {
        if (entry.startsWith(".") && !part.startsWith(".")) continue;
        if (regex.test(entry)) next.push(path.join(base, entry));
      }
    }
    candidates = next;
  }
  return candidates;
}

async function readHosts(filename, home = os.homedir()) {
  const hosts = new Set();
  const visited = new Set();
  const includeRoot = path.join(home, ".ssh");
  async function read(file, optional, depth) {
    if (depth > 16) throw new Error("SSH Include nesting exceeds 16 levels");
    let canonical;
    try { canonical = await fs.realpath(file); }
    catch (error) {
      if (optional && error.code === "ENOENT") return;
      throw new Error(`Cannot read SSH config ${file}: ${error.message}`);
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const text = await fs.readFile(canonical, "utf8");
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      let tokens;
      try {
        tokens = words(line.replace(/^(\s*[a-zA-Z]+)\s*=\s*/, "$1 "));
      } catch (error) {
        throw new Error(`${file}:${index + 1}: ${error.message}`);
      }
      const directive = tokens.shift()?.toLowerCase();
      if (directive === "host") {
        for (const alias of tokens) {
          if (!/[!*?[\]]/.test(alias) && validHost(alias)) hosts.add(alias);
        }
      } else if (directive === "include") {
        for (const entry of tokens) {
          const expanded = /^~[/\\]/.test(entry) ? configPath(entry, home)
            : path.isAbsolute(entry) ? entry : path.join(includeRoot, entry);
          for (const included of await expandPattern(expanded)) await read(included, true, depth + 1);
        }
      }
    }
  }
  await read(configPath(filename, home), false, 0);
  return [...hosts].sort((a, b) => a.localeCompare(b));
}

module.exports = { configPath, readHosts, words };
