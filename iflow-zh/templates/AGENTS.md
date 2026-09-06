# iflow — SuperClaude V8 全能工作流（omp 用户级入口）

框架事实源在 iflow-zh 插件包内，由 `omp plugin install` 安装、`/sc:setup` 写入本文件。
本文件只是一层薄壳：正文靠下面的 `@` 导入指向已安装的插件根，升级插件即升级正文。

执行方的硬性约束不在这里——它们在插件的 `rules/iflow-sticky.md` 里，因为上下文文件
到不了子 Agent（构造子会话时按文件名过滤掉 `agents.md`），而规则会随 `task` 转发。

## 框架组件（旗帜 / 行为规则 / 行为模式）

@__FRAMEWORK_ENTRY__

## 会话说明

- **行为命令**：`/sc:implement`、`/sc:task` 等 21 条命令由插件内 extension 注册，
  执行时把命令正文注入为下一条用户提示。会话内输入 `/sc` 列出全部。
- **专家智能体**：15 个专家来自插件的 `agents/`，用 `task` 按名称委派
  （如 `security-engineer`、`universal-omni-agent-v8`）。
- **模型角色**：主会话用 `@slow`，子任务按 `task.agentModelOverrides` 映射到
  `@smol`/`@task`/`@slow`。具体模型由 `/model` 决定，用 `/sc:roles` 查看解析结果。
- **调度者模式**：主会话的 `edit`/`write`/`bash`/`eval`/`ast_edit` 已被收窄拿掉，
  落地动作一律经 `task` 分派。临时关闭：`/sc:dispatch off`。

## 使用流程（Task-First）

理解 → 规划 → 执行 → 验证：

1. `/sc:load --type project --analyze` — 恢复项目记忆
2. `/sc:brainstorm "想法"` 或 `/sc:task create "目标"` — 需求探索与任务分解
3. `/sc:implement feature --with-tests` — 派专家执行实现
4. `/sc:test`、`/sc:improve`、`/sc:troubleshoot` — 质量保障闭环
5. `/sc:reflect --type session` → `/sc:save` — 总结反思并沉淀经验
