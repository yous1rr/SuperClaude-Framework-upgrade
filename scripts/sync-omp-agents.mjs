#!/usr/bin/env node
/**
 * Regenerates .omp/agents/ from .iflow/agents/ (single source of truth).
 *
 * oh-my-pi discovers task agents as flattened markdown files in .omp/agents/.
 * The .iflow agent files are Claude-Code flavored, so this script adapts the
 * frontmatter while keeping the body verbatim:
 *
 *   kept:    name, description, model (role aliases only)
 *   added:   spawns: "*" for the omni coordinator agent
 *   dropped: category / tools (personas inherit all tools), when-to-use,
 *            mcp-servers, agent-type, concrete model selectors, color,
 *            allowed-tools/-mcps, capabilities, inherit-* and any other
 *            Claude-specific keys
 *
 * Run from anywhere inside the repo: node scripts/sync-omp-agents.mjs
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, ".iflow", "agents");
const DEST = path.join(ROOT, ".omp", "agents");

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

const ROLE_MODEL = /^@[A-Za-z0-9_-]+(?::(?:minimal|low|medium|high|xhigh|max))?$/;

function convert(file) {
  const raw = readFileSync(file, "utf8");
  const { fm, body } = splitFrontmatter(raw);
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
  return lines.join("\n") + body.replace(/\n*$/, "\n");
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
const files = collectAgentFiles(SRC);
for (const file of files) {
  writeFileSync(path.join(DEST, path.basename(file)), convert(file));
}
console.log(`synced ${files.length} agents: .iflow/agents/ -> .omp/agents/`);
