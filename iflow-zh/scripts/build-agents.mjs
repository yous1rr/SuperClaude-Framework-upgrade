#!/usr/bin/env node
/**
 * Generates the build outputs of the iflow-zh plugin package from `.iflow/`,
 * which stays the single source of truth. Two directories are generated and
 * must never be hand-edited:
 *
 *   agents/     <- .iflow/agents/**.md, frontmatter adapted for omp task agents
 *   framework/  <- the `@` import chain reachable from .iflow/IFLOW.md,
 *                  plus .iflow/commands/sc/*.md (command bodies)
 *
 * Frontmatter adaptation (inherited from the previous scripts/sync-omp-agents.mjs):
 *
 *   kept:    name, description, model (Role aliases only)
 *   added:   spawns: "*" for the omni coordinator agent
 *   dropped: category / tools (personas inherit all tools), when-to-use,
 *            mcp-servers, agent-type, concrete model selectors, color,
 *            allowed-tools/-mcps, capabilities, inherit-* and any other
 *            Claude-specific keys
 *
 * After writing, three assertions run. Each failure exits non-zero, because a
 * dangling agent name that only surfaces at runtime costs a user a broken
 * `task` call, while a build failure costs nobody anything:
 *
 *   1. every `@` import in the chain resolves to a real file
 *   2. every agent name referenced by templates/config.patch.yml or by
 *      TASK_ROUTES in extension/iflow.ts exists (package agent or omp builtin)
 *   3. every generated agent has a Role mapping or a routing rule
 *
 * Run from anywhere: node iflow-zh/scripts/build-agents.mjs
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(PKG, "..");
const IFLOW = path.join(ROOT, ".iflow");
const SRC_AGENTS = path.join(IFLOW, "agents");
const SRC_COMMANDS = path.join(IFLOW, "commands", "sc");
const DEST_AGENTS = path.join(PKG, "agents");
const DEST_FRAMEWORK = path.join(PKG, "framework");
const DEST_COMMANDS = path.join(DEST_FRAMEWORK, "commands", "sc");

/** omp ships these; they are legal `task` targets without a package file. */
const BUILTIN_AGENTS = ["scout", "reviewer", "security-reviewer", "task", "sonic"];

/** omp resolves at most five hops of `@` imports (omp://context-files.md:160-167). */
const MAX_IMPORT_DEPTH = 5;

const ROLE_MODEL = /^@[A-Za-z0-9_-]+(?::(?:minimal|low|medium|high|xhigh|max))?$/;

const failures = [];

function fail(headline, names) {
  failures.push({ headline, names });
}

function collectAgentFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectAgentFiles(full, acc);
    else if (entry.isFile() && entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function splitFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { fm: {}, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: normalized };
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "");
  const fm = {};
  for (const line of header.split("\n")) {
    if (/^\s*-/.test(line)) continue; // list item -> part of a dropped key
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    fm[key] = value.replace(/^['"]|['"]$/g, "").trim();
  }
  return { fm, body };
}

function convertAgent(file) {
  const { fm, body } = splitFrontmatter(readFileSync(file, "utf8"));
  if (!fm.name || !fm.description) {
    throw new Error(`${file}: agent frontmatter must define both name and description`);
  }
  const lines = ["---", `name: ${fm.name}`];
  // Always double-quote descriptions: deterministic YAML regardless of
  // colons, percent signs, emoji or other indicator characters inside.
  const escapedDescription = fm.description.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  lines.push(`description: "${escapedDescription}"`);
  if (typeof fm.model === "string" && ROLE_MODEL.test(fm.model)) {
    lines.push(`model: "${fm.model}"`);
  }
  if (fm.name === "universal-omni-agent-v8") lines.push('spawns: "*"');
  lines.push("---", "");
  return { name: fm.name, text: lines.join("\n") + body.replace(/\n*$/, "\n") };
}

function buildAgents() {
  rmSync(DEST_AGENTS, { recursive: true, force: true });
  mkdirSync(DEST_AGENTS, { recursive: true });
  const names = [];
  const writtenBy = new Map();
  for (const file of collectAgentFiles(SRC_AGENTS)) {
    const base = path.basename(file);
    // omp's agent directories are flat, so a recursive source tree with two
    // same-named files would silently drop one definition.
    const clash = writtenBy.get(base);
    if (clash) throw new Error(`${file}: flattens onto the same name as ${clash}`);
    writtenBy.set(base, file);
    const { name, text } = convertAgent(file);
    writeFileSync(path.join(DEST_AGENTS, base), text);
    names.push(name);
  }
  return names;
}

/**
 * Walks the `@` import chain from IFLOW.md the way omp does, and returns every
 * file that has to travel with the package. A missing target is a build
 * failure here; omp itself would leave the bare `@token` in the prompt.
 */
function collectChainFiles() {
  const chain = [];
  const seen = new Set();
  const walk = (file, depth) => {
    const rel = path.relative(IFLOW, file);
    if (seen.has(rel)) return;
    seen.add(rel);
    chain.push(rel);
    if (depth >= MAX_IMPORT_DEPTH) return;
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      fail("chain imports a file that does not exist:", [rel]);
      return;
    }
    for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
      const match = /^@([A-Za-z0-9._/-]+\.md)\s*$/.exec(line.trim());
      if (!match) continue;
      walk(path.resolve(path.dirname(file), match[1]), depth + 1);
    }
  };
  walk(path.join(IFLOW, "IFLOW.md"), 0);
  return chain;
}

function buildFramework() {
  rmSync(DEST_FRAMEWORK, { recursive: true, force: true });
  mkdirSync(DEST_COMMANDS, { recursive: true });
  const chain = collectChainFiles();
  for (const rel of chain) {
    const dest = path.join(DEST_FRAMEWORK, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(IFLOW, rel), dest);
  }
  const commands = readdirSync(SRC_COMMANDS).filter((entry) => entry.endsWith(".md")).sort();
  for (const entry of commands) {
    copyFileSync(path.join(SRC_COMMANDS, entry), path.join(DEST_COMMANDS, entry));
  }
  return { chain, commands };
}

/** Collects the keys of the `task.agentModelOverrides` block, indentation-scoped. */
function readOverrideKeys() {
  const file = path.join(PKG, "templates", "config.patch.yml");
  const lines = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^\s*agentModelOverrides:\s*$/.test(line));
  if (start === -1) throw new Error(`${file}: no agentModelOverrides block`);
  const outerIndent = /^(\s*)/.exec(lines[start])[1].length;
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = /^(\s*)/.exec(line)[1].length;
    if (indent <= outerIndent) break;
    const match = /^\s*([A-Za-z0-9_-]+):\s*"?(@[A-Za-z0-9_:-]+)"?\s*$/.exec(line);
    if (!match) throw new Error(`${file}: unparsable override line: ${line}`);
    keys.push(match[1]);
  }
  if (!keys.length) throw new Error(`${file}: agentModelOverrides block is empty`);
  return keys;
}

/** Collects the `agent:` values of TASK_ROUTES in the packaged extension. */
function readRoutedAgents() {
  const file = path.join(PKG, "extension", "iflow.ts");
  const source = readFileSync(file, "utf8");
  const start = source.indexOf("const TASK_ROUTES");
  if (start === -1) throw new Error(`${file}: no TASK_ROUTES declaration`);
  const end = source.indexOf("\n];", start);
  if (end === -1) throw new Error(`${file}: unterminated TASK_ROUTES declaration`);
  const agents = [...source.slice(start, end).matchAll(/agent:\s*"([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  if (!agents.length) throw new Error(`${file}: TASK_ROUTES declares no agents`);
  return agents;
}

const agentNames = buildAgents();
const { chain, commands } = buildFramework();

const referenced = new Set([...readOverrideKeys(), ...readRoutedAgents()]);
const known = new Set([...agentNames, ...BUILTIN_AGENTS]);

const dangling = [...referenced].filter((name) => !known.has(name)).sort();
if (dangling.length) {
  fail("referenced agent names that no definition provides:", dangling);
}

const unrouted = agentNames.filter((name) => !referenced.has(name)).sort();
if (unrouted.length) {
  fail("agents with neither a Role mapping nor a routing rule:", unrouted);
}

if (failures.length) {
  for (const { headline, names } of failures) {
    console.error(`build-agents: ${headline}`);
    for (const name of names) console.error(`  - ${name}`);
  }
  process.exit(1);
}

console.log(
  `build-agents: ${agentNames.length} agents, ${chain.length} chain files, ${commands.length} commands`,
);
