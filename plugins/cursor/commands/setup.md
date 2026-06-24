---
description: Check whether the local cursor-agent CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(curl:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" setup --json $ARGUMENTS
```

If the result says cursor-agent is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install cursor-agent now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install cursor-agent (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
curl https://cursor.com/install -fsS | bash
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" setup --json $ARGUMENTS
```

If cursor-agent is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If cursor-agent is installed but not authenticated, preserve the guidance to run `cursor-agent login`.
