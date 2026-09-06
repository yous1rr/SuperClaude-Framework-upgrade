#!/usr/bin/env node
/**
 * Writes the two things an omp plugin cannot contribute by discovery: settings
 * and a context file. Shared by two callers, which is why this is `.mjs` rather
 * than `.ts` — the extension runs under Bun (TS is fine), `bin/install.mjs`
 * runs under the user's plain Node (no TS loader).
 *
 *   1. `<agentDir>/config.yml`  — key-wise merge of templates/config.patch.yml.
 *      omp's own `Settings.set` -> `setByPath` assigns the whole record, so
 *      `omp config set task.agentModelOverrides '<json>'` would drop a user's
 *      pre-existing overrides. We read, merge, write, and leave a `.bak`.
 *   2. `<agentDir>/AGENTS.md`   — a thin shell whose body is one `@` import
 *      pointing at this package's `framework/IFLOW.md`. Never inline the
 *      framework text: always-apply rule content is deduped against loaded
 *      context files, so a second copy of rules/iflow-sticky.md here would get
 *      one of the two silently dropped.
 *
 * Occupying `<agentDir>/AGENTS.md` shadows every other user-level context file
 * (native has the highest provider priority and only one user-level file
 * survives scope dedupe), so we probe the known candidates and `@`-import the
 * one that exists — referenced, not copied, so the user's later edits still
 * apply.
 *
 * Paths are resolved, never hardcoded: profiles move the agent dir to
 * `~/.omp/profiles/<name>/agent`, `PI_CODING_AGENT_DIR` overrides it outright,
 * and `PI_CONFIG_DIR` renames `.omp` itself.
 */
import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, parseDocument } from "yaml";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Marker the template uses for the resolved framework entry path. */
const ENTRY_PLACEHOLDER = "@__FRAMEWORK_ENTRY__";

/**
 * User-level context files that `<agentDir>/AGENTS.md` shadows once it exists,
 * in the provider order omp itself uses. Relative to the home directory.
 */
const SHADOWED_CANDIDATES = [
  ".claude/CLAUDE.md",
  ".codex/AGENTS.md",
  ".gemini/GEMINI.md",
  ".config/opencode/AGENTS.md",
  ".copilot/copilot-instructions.md",
  ".agent/AGENTS.md",
  ".agents/AGENTS.md",
];

/** Resolve the agent config directory the same way omp's own resolver does. */
export function resolveAgentDir(env = process.env, home = os.homedir()) {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  const profile = normalizeProfile(env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE);
  // A profile derives its own agent dir and ignores the override, matching
  // DirResolver: `agentDirOverride = profile ? undefined : options.agentDirOverride`.
  if (!profile && override) return path.resolve(override);
  const configRoot = path.join(home, env.PI_CONFIG_DIR || ".omp");
  return profile ? path.join(configRoot, "profiles", profile, "agent") : path.join(configRoot, "agent");
}

function normalizeProfile(value) {
  const normalized = value?.trim();
  if (!normalized || normalized === "default") return undefined;
  return normalized;
}

/**
 * Locate the installed copy of this package. Under `omp plugin install` this
 * file already lives inside the plugin root, so its own module path is the
 * answer; `bin/install.mjs` passes the freshly installed root explicitly.
 */
export function resolveFrameworkEntry(pkgRoot = PKG_ROOT) {
  const entry = path.join(pkgRoot, "framework", "IFLOW.md");
  if (!existsSync(entry)) {
    throw new Error(`iflow-zh: framework entry missing at ${entry} — run scripts/build-agents.mjs`);
  }
  return entry;
}

/** `@` imports accept a `~/` prefix; prefer it so the file survives a home move. */
function toImportToken(target, home = os.homedir()) {
  const relative = path.relative(home, target);
  const portable = !relative.startsWith("..") && !path.isAbsolute(relative);
  const raw = portable ? `~/${relative}` : target;
  return raw.split(path.sep).join("/");
}

function backup(file) {
  if (!existsSync(file)) return null;
  const bak = `${file}.bak`;
  copyFileSync(file, bak);
  return bak;
}

/**
 * Merge the template's settings into the user's config.yml. `parseDocument`
 * keeps the user's comments and key order intact; we only set the leaves we
 * own, so nothing else in the file is rewritten.
 */
export function mergeConfig(agentDir, { dryRun = false } = {}) {
  const patchPath = path.join(PKG_ROOT, "templates", "config.patch.yml");
  const patch = parseYaml(readFileSync(patchPath, "utf8"));
  const configPath = path.join(agentDir, "config.yml");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const doc = parseDocument(existing);
  if (doc.contents === null) doc.contents = doc.createNode({});

  const added = [];
  const kept = [];
  const alreadySet = [];

  /**
   * Fill one leaf. Never overwrite: a value the user chose outranks ours.
   * Distinguish "user picked something else" (`kept`, a real conflict worth
   * reporting) from "already equals ours" (`alreadySet`, just idempotence) —
   * reporting the latter as a conflict would be a false claim.
   */
  function fill(keyPath, value) {
    const label = keyPath.join(".");
    const current = doc.getIn(keyPath);
    if (current === undefined || current === null) {
      doc.setIn(keyPath, value);
      added.push(label);
      return;
    }
    if (current === value) alreadySet.push(label);
    else kept.push(`${label}=${current}`);
  }

  const defaultRole = patch?.modelRoles?.default;
  if (typeof defaultRole === "string") fill(["modelRoles", "default"], defaultRole);

  const overrides = patch?.task?.agentModelOverrides ?? {};
  for (const [agent, role] of Object.entries(overrides)) {
    fill(["task", "agentModelOverrides", agent], role);
  }

  const text = doc.toString();
  let backupPath = null;
  if (!dryRun && added.length) {
    mkdirSync(agentDir, { recursive: true });
    backupPath = backup(configPath);
    writeFileSync(configPath, text);
  }
  return { path: configPath, added, kept, alreadySet, backupPath, text };
}

/**
 * Write the `AGENTS.md` shell, re-importing whichever user-level context file
 * this one shadows.
 */
export function writeContextShell(agentDir, { pkgRoot = PKG_ROOT, home = os.homedir(), dryRun = false } = {}) {
  const template = readFileSync(path.join(pkgRoot, "templates", "AGENTS.md"), "utf8");
  const entryToken = toImportToken(resolveFrameworkEntry(pkgRoot), home);

  const shadowed = SHADOWED_CANDIDATES.map(rel => path.join(home, rel)).filter(file => existsSync(file));
  const shadowSection = shadowed.length
    ? [
        "",
        "## 你原有的用户级上下文（被本文件遮蔽，这里按引用接回）",
        "",
        ...shadowed.map(file => `@${toImportToken(file, home)}`),
        "",
      ].join("\n")
    : "";

  const body = template.replace(ENTRY_PLACEHOLDER, `@${entryToken}`) + shadowSection;
  const target = path.join(agentDir, "AGENTS.md");

  let backupPath = null;
  if (!dryRun) {
    mkdirSync(agentDir, { recursive: true });
    backupPath = backup(target);
    writeFileSync(target, body);
  }
  return { path: target, entry: entryToken, shadowed, backupPath, text: body };
}

/** Run both writers. Returns a report the caller renders. */
export function runSetup({ agentDir = resolveAgentDir(), pkgRoot = PKG_ROOT, home = os.homedir(), dryRun = false } = {}) {
  const config = mergeConfig(agentDir, { dryRun });
  const context = writeContextShell(agentDir, { pkgRoot, home, dryRun });
  return { agentDir, config, context, dryRun };
}

/** Render a report as the lines both the CLI and `/sc:setup` print. */
export function formatReport(report) {
  const lines = [
    report.dryRun ? "iflow-zh /sc:setup (dry run)" : "iflow-zh /sc:setup",
    "",
    `agent 目录: ${report.agentDir}`,
    `框架入口:   ${report.context.entry}`,
    "",
    `设置: ${report.config.path}`,
  ];
  lines.push(
    report.config.added.length
      ? `  新增 ${report.config.added.length} 个键: ${report.config.added.join(", ")}`
      : "  没有新增键",
  );
  if (report.config.alreadySet?.length) {
    lines.push(`  已是目标值 ${report.config.alreadySet.length} 个键，未改动`);
  }
  if (report.config.kept.length) {
    lines.push(
      `  你自己设过的 ${report.config.kept.length} 个键保持原值（未覆盖）: ${report.config.kept.join(", ")}`,
    );
  }
  if (report.config.backupPath) lines.push(`  备份: ${report.config.backupPath}`);

  lines.push("", `上下文: ${report.context.path}`);
  if (report.context.backupPath) lines.push(`  备份: ${report.context.backupPath}`);
  lines.push(
    report.context.shadowed.length
      ? `  已按引用接回被遮蔽的 ${report.context.shadowed.length} 份用户级上下文`
      : "  没有检测到被遮蔽的用户级上下文文件",
  );

  lines.push("", "改动要下一个会话才生效：请退出并重新启动 omp。");
  return lines.join("\n");
}

/** Verify whether a live session already has setup applied. */
export function checkApplied({ agentDir = resolveAgentDir(), overrideKeys, contextText } = {}) {
  const patch = parseYaml(readFileSync(path.join(PKG_ROOT, "templates", "config.patch.yml"), "utf8"));
  const expected = overrideKeys ?? Object.keys(patch?.task?.agentModelOverrides ?? {});
  const configPath = path.join(agentDir, "config.yml");
  let missingOverrides = expected;
  if (existsSync(configPath)) {
    const current = parseYaml(readFileSync(configPath, "utf8"))?.task?.agentModelOverrides ?? {};
    missingOverrides = expected.filter(key => current[key] === undefined);
  }
  const text = contextText ?? (existsSync(path.join(agentDir, "AGENTS.md"))
    ? readFileSync(path.join(agentDir, "AGENTS.md"), "utf8")
    : "");
  const entryToken = toImportToken(resolveFrameworkEntry());
  return {
    agentDir,
    missingOverrides,
    hasEntry: text.includes(`@${entryToken}`),
  };
}
