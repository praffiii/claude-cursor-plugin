# Claude Cursor Plugin

A Claude Code plugin that mirrors the official Codex plugin 1:1, but delegates execution to **Cursor** (`cursor-agent` CLI) instead of Codex.

**Claude orchestrates. Cursor executes.**

## Install

From Claude Code:

```
/plugin marketplace add praffiii/claude-cursor-plugin
/plugin install cursor@praffii
/reload-plugins
/cursor:setup
```

`praffiii/claude-cursor-plugin` is the GitHub repo. `cursor@praffii` is the plugin id from `.claude-plugin/plugin.json` — that part does not change between local and published installs.

## Local development

If you cloned the repo and want Claude Code to load your working copy instead of the GitHub release:

```
git clone https://github.com/praffiii/claude-cursor-plugin.git
cd claude-cursor-plugin
```

Then in Claude Code, use the **absolute path to your clone** (not the GitHub slug):

```
/plugin marketplace add /absolute/path/to/claude-cursor-plugin
/plugin install cursor@praffii
/reload-plugins
/cursor:setup
```

After editing plugin files, run `/reload-plugins` again.

## Requirements

- Node.js ≥ 18.18
- `cursor-agent` on your PATH — `curl https://cursor.com/install -fsS | bash`
- `cursor-agent login` completed at least once

## Commands (same surface as Codex plugin)

| Command | Purpose |
| --- | --- |
| `/cursor:rescue` | Delegate investigation or implementation to Cursor |
| `/cursor:review` | Read-only git review via Cursor |
| `/cursor:adversarial-review` | Adversarial design/implementation review |
| `/cursor:status` | List or inspect jobs |
| `/cursor:result` | Show finished job output |
| `/cursor:cancel` | Cancel a running job |
| `/cursor:setup` | Check cursor-agent readiness; toggle stop review gate |

## Subagents

- `cursor:cursor-rescue` — thin forwarder to `cursor-companion.mjs task`
- `cursor:cursor-review` — forwards to `review`
- `cursor:cursor-adversarial-review` — forwards to `adversarial-review`

## Architecture

```
Claude Code command/subagent
  → scripts/cursor-companion.mjs
    → scripts/lib/cursor.mjs
      → cursor-agent -p --trust --output-format stream-json ...
```

Job state, hooks, and command UX are copied from the Codex plugin; only the runtime backend differs.

## Repository layout

This repo is a Claude Code **marketplace** (`/.claude-plugin/marketplace.json`) with the plugin under `plugins/cursor/`.

## Differences from Codex plugin

| Codex | This plugin |
| --- | --- |
| Codex app-server + broker | `cursor-agent` CLI subprocess |
| Built-in Codex reviewer API | Git-context prompts + structured JSON |
| `codex resume <thread>` | `cursor-agent --resume <session_id>` |
| `--effort` forwarded to Codex | Accepted for CLI compat; not passed to cursor-agent |

## License

MIT (derived from OpenAI Codex plugin structure)
