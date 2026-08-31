/**
 * iflow (SuperClaude V8) bridge extension for oh-my-pi (omp)
 *
 * Registers every behavioral command defined in `.iflow/commands/sc/*.md`
 * as a native omp slash command (`/sc:implement`, `/sc:task`, ...), so the
 * framework drives oh-my-pi sessions with the same UX it has in Claude Code.
 *
 * Project layout (this repo):
 *   .omp/extensions/iflow.ts    <- this file (omp discovers it at startup)
 *   .iflow/commands/sc/*.md     <- command definitions, single source of truth
 *   .omp/agents/*.md            <- specialist personas as task agents
 *                                  (regenerate via `node scripts/sync-omp-agents.mjs`)
 *
 * A command handler expands the markdown body (frontmatter stripped,
 * `$ARGUMENTS` / `$@` / `$1..$9` substituted) and submits it as the next
 * user prompt, which is exactly how Claude Code file-commands behave.
 *
 * Reload after editing this file or the command markdown with `/reload-plugins`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

interface Frontmatter {
  name?: string;
  description?: string;
}

interface CommandDef {
  name: string;
  description: string;
  body: string;
}

const NAMESPACE = "sc";
const HELP_COMMAND = "sc";
const MODEL_ROLES = ["default", "smol", "task", "slow"] as const;

const TASK_ROUTES: Array<{ agent: string; patterns: RegExp[] }> = [
  {
    agent: "security-reviewer",
    patterns: [
      /security review/, /security audit/, /security assessment/, /security analysis/,
      /vulnerability/, /threat model/, /credential leak/, /cve\b/,
      /安全审查/, /安全审核/, /安全审计/, /安全分析/, /漏洞/,
      /威胁建模/, /凭据泄露/, /密钥泄露/,
    ],
  },
  {
    agent: "system-architect",
    patterns: [
      /architecture/, /system design/, /dependency graph/, /module boundary/,
      /架构/, /系统设计/, /依赖图/, /模块边界/,
    ],
  },
  {
    agent: "root-cause-analyst",
    patterns: [
      /root cause/, /debug/, /investigate failure/, /incident analysis/,
      /regression analysis/, /根因/, /调试/, /故障分析/, /回归分析/,
    ],
  },
  {
    agent: "performance-engineer",
    patterns: [
      /performance analysis/, /benchmark/, /latency/, /throughput/,
      /complexity analysis/, /性能分析/, /基准测试/, /延迟/, /吞吐量/, /复杂度分析/,
    ],
  },
  {
    agent: "librarian",
    patterns: [
      /research/, /look up/, /lookup/, /official documentation/, /api reference/,
      /调研/, /查找文档/, /官方文档/, /接口文档/,
    ],
  },
  {
    agent: "scout",
    patterns: [
      /search the repository/, /locate files?/, /inspect files?/, /read-only/, /inventory/,
      /搜索仓库/, /定位文件/, /检查文件/, /只读/, /盘点/,
    ],
  },
  {
    agent: "reviewer",
    patterns: [/review/, /audit/, /verify/, /quality check/, /评审/, /审计/, /验证/, /质量检查/],
  },
];

function classifyTask(task: string): string {
  const normalized = task.toLowerCase();
  for (const route of TASK_ROUTES) {
    if (route.patterns.some((pattern) => pattern.test(normalized))) return route.agent;
  }
  return "task";
}

function routeTaskInput(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;

  if (Array.isArray(input.tasks)) {
    let changed = false;
    const tasks = input.tasks.map((item: unknown) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
      const taskItem = item as Record<string, unknown>;
      if (typeof taskItem.agent === "string" && taskItem.agent.trim()) return item;
      if (typeof taskItem.task !== "string" || !taskItem.task.trim()) return item;
      changed = true;
      return { ...taskItem, agent: classifyTask(taskItem.task) };
    });
    return changed ? { ...input, tasks } : undefined;
  }

  if (
    typeof input.task === "string" &&
    (!("agent" in input) || typeof input.agent !== "string" || !input.agent.trim())
  ) {
    return { ...input, agent: classifyTask(input.task) };
  }

  return undefined;
}

function describeModel(model: unknown): string {
  if (model === null || typeof model !== "object" || Array.isArray(model)) return "unresolved";
  const resolved = model as { provider?: unknown; id?: unknown; name?: unknown };
  if (typeof resolved.provider === "string" && typeof resolved.id === "string") {
    return `${resolved.provider}/${resolved.id}`;
  }
  if (typeof resolved.name === "string") return resolved.name;
  return "resolved";
}

function parseCommandFile(raw: string, fileName: string): CommandDef | undefined {
  const normalized = raw.replace(/\r\n/g, "\n");
  let fm: Frontmatter = {};
  let body = normalized;
  if (normalized.startsWith("---")) {
    const end = normalized.indexOf("\n---", 3);
    if (end !== -1) {
      const header = normalized.slice(4, end);
      body = normalized.slice(end + 4).replace(/^\n+/, "");
      for (const line of header.split("\n")) {
        const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
        if (!match) continue;
        const [, key, value] = match;
        if (key === "name" || key === "description") {
          fm[key] = value.replace(/^['"]|['"]$/g, "").trim();
        }
      }
    }
  }
  const name = fm.name || path.basename(fileName, ".md");
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return undefined;
  return { name, description: fm.description || "", body };
}

function findFrameworkRoot(): string | undefined {
  let dir = path.resolve(process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, ".iflow"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function loadCommands(): CommandDef[] {
  const root = findFrameworkRoot();
  if (!root) return [];
  const commandDir = path.join(root, ".iflow", "commands", NAMESPACE);
  let entries: string[];
  try {
    entries = fs.readdirSync(commandDir);
  } catch {
    return [];
  }
  const commands: CommandDef[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const parsed = parseCommandFile(
      fs.readFileSync(path.join(commandDir, entry), "utf8"),
      entry,
    );
    if (parsed) commands.push(parsed);
  }
  return commands;
}

function splitArgs(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function expandTemplate(body: string, args: string): string {
  const trimmedArgs = args.trim();
  const hasPlaceholder = /\$ARGUMENTS|\$@|\$\d/.test(body);
  let expanded = body
    .replace(/\$ARGUMENTS|\$@/g, trimmedArgs)
    .replace(/\$(\d)/g, (_, digit: string) => splitArgs(trimmedArgs)[Number(digit) - 1] ?? "");
  if (!hasPlaceholder && trimmedArgs) {
    expanded += `\n\n**Task arguments**: ${trimmedArgs}`;
  }
  return expanded;
}

/**
 * omp renamed/extended its message APIs across versions, so probe instead of
 * hard-coding one entry point: sendUserMessage routes through the prompt
 * pipeline (preferred), sendMessage with triggerTurn is the older fallback.
 */
async function submitPrompt(pi: ExtensionAPI, prompt: string): Promise<void> {
  const api = pi as unknown as {
    sendUserMessage?: (content: string) => Promise<unknown> | unknown;
    sendMessage?: (content: string, options?: Record<string, unknown>) => Promise<unknown> | unknown;
  };
  if (typeof api.sendUserMessage === "function") {
    await api.sendUserMessage(prompt);
    return;
  }
  if (typeof api.sendMessage === "function") {
    await api.sendMessage(prompt, { triggerTurn: true });
    return;
  }
  throw new Error("iflow bridge: omp exposes no message submission API");
}

export default function iflowExtension(pi: ExtensionAPI): void {
  const commands = loadCommands();

  for (const cmd of commands) {
    pi.registerCommand(`${NAMESPACE}:${cmd.name}`, {
      description: cmd.description || `iflow V8 behavioral command (${cmd.name})`,
      handler: async (args: string) => {
        await submitPrompt(pi, expandTemplate(cmd.body, typeof args === "string" ? args : ""));
      },
    });
  }

  pi.registerCommand(HELP_COMMAND, {
    description: "List iflow V8 (/sc:*) commands, agents and modes",
    handler: async (_args, ctx) => {
      const lines = [
        "iflow (SuperClaude V8) — oh-my-pi bridge",
        "",
        "Behavioral commands (expand .iflow/commands/sc/*.md into the next prompt):",
        ...commands.map((c) => `- /sc:${c.name}${c.description ? ` — ${c.description}` : ""}`),
        "",
        "Specialist agents (task tool): .omp/agents/ — regenerate with `node scripts/sync-omp-agents.mjs`",
        "Task routing: omitted agents are classified to a project Agent; explicit agents are preserved.",
        "Model Roles: use /sc:roles to show the resolved project mappings.",
        "Rules and modes: loaded via .omp/AGENTS.md and .omp/RULES.md",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("sc:roles", {
    description: "Show iflow project Role to resolved model mappings",
    handler: async (_args, ctx) => {
      const lines = ["iflow model Roles", ""];
      for (const role of MODEL_ROLES) {
        lines.push(`@${role} → ${describeModel(ctx.models.resolve(`@${role}`))}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "task") return;
    const routedInput = routeTaskInput(event.input);
    return routedInput ? { input: routedInput } : undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(
      commands.length
        ? `iflow V8 bridge active — ${commands.length} /sc:* commands registered. Type /sc to list.`
        : `iflow V8 bridge found no .iflow/commands/sc/*.md — is the project layout intact?`,
      "info",
    );
  });
}
