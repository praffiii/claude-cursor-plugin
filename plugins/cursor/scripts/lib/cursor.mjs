import { spawn } from "node:child_process";
import { readJsonFile } from "./fs.mjs";
import { binaryAvailable } from "./process.mjs";

const SERVICE_NAME = "claude_code_cursor_plugin";
const TASK_THREAD_PREFIX = "Cursor Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

const BUILTIN_MODEL_ALIASES = new Map([
  ["spark", "composer-2-fast"],
  ["fast", "composer-2-fast"]
]);

function cleanCursorStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line)
    .join("\n");
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function normalizeModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return BUILTIN_MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function mapSandboxToCursorArgs(sandbox, write) {
  const mode = sandbox ?? (write ? "danger-full-access" : "read-only");
  switch (mode) {
    case "read-only":
      return { planMode: true, force: false, sandbox: "enabled" };
    case "workspace-write":
      return { planMode: false, force: true, sandbox: "enabled" };
    case "danger-full-access":
      return { planMode: false, force: true, sandbox: "disabled" };
    default:
      return { planMode: !write, force: Boolean(write), sandbox: write ? "disabled" : "enabled" };
  }
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function parseStreamJsonLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractAssistantText(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function collectReasoningFromEvent(event, reasoningSummary) {
  if (event?.type !== "thinking") {
    return reasoningSummary;
  }
  const text = String(event.text ?? "").trim();
  if (!text) {
    return reasoningSummary;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || reasoningSummary.includes(normalized)) {
    return reasoningSummary;
  }
  return [...reasoningSummary, normalized];
}

function runCursorAgent(cwd, options = {}) {
  const args = ["-p", "--trust", "--output-format", "stream-json", "--stream-partial-output", "--workspace", cwd];

  const model = normalizeModel(options.model);
  if (model) {
    args.push("--model", model);
  }

  const sandboxArgs = mapSandboxToCursorArgs(options.sandbox, options.write);
  if (sandboxArgs.planMode) {
    args.push("--mode", "plan");
  }
  if (sandboxArgs.force) {
    args.push("--force");
  }
  if (sandboxArgs.sandbox) {
    args.push("--sandbox", sandboxArgs.sandbox);
  }

  if (options.resumeChatId) {
    args.push("--resume", options.resumeChatId);
  }

  const prompt = String(options.prompt ?? "").trim();
  if (prompt) {
    args.push(prompt);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("cursor-agent", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let sessionId = options.resumeChatId ?? null;
    let lastAssistantMessage = "";
    let reasoningSummary = [];
    let finalResult = null;
    let buffer = "";

    const handleEvent = (event) => {
      if (!event || typeof event !== "object") {
        return;
      }

      if (typeof event.session_id === "string" && event.session_id) {
        sessionId = event.session_id;
        emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", {
          threadId: sessionId
        });
      }

      reasoningSummary = collectReasoningFromEvent(event, reasoningSummary);

      if (event.type === "assistant") {
        const text = extractAssistantText(event);
        if (text) {
          lastAssistantMessage = text;
          emitProgress(options.onProgress, `Assistant: ${shorten(text, 96)}`, "finalizing");
        }
      }

      if (event.type === "result") {
        finalResult = event;
        if (typeof event.result === "string" && event.result.trim()) {
          lastAssistantMessage = event.result.trim();
        }
        emitProgress(
          options.onProgress,
          event.subtype === "success" ? "Turn completed." : `Turn failed: ${event.subtype ?? "error"}.`,
          event.subtype === "success" ? "finalizing" : "failed",
          { threadId: sessionId }
        );
      }

      if (event.type === "tool_call" || event.type === "tool_result") {
        emitProgress(options.onProgress, `Tool activity: ${event.type}.`, "running");
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        handleEvent(parseStreamJsonLine(line));
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const line = chunk.toString().trim();
      if (line) {
        emitProgress(options.onProgress, line, null, { stderrMessage: line });
      }
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (buffer.trim()) {
        handleEvent(parseStreamJsonLine(buffer));
      }

      const status = finalResult?.subtype === "success" || (code === 0 && lastAssistantMessage) ? 0 : 1;
      resolve({
        status,
        sessionId,
        threadId: sessionId,
        turnId: finalResult?.request_id ?? null,
        finalMessage: lastAssistantMessage,
        reviewText: lastAssistantMessage,
        reasoningSummary,
        stderr: cleanCursorStderr(stderr),
        stdout,
        error:
          status === 0
            ? null
            : {
                message:
                  finalResult?.result ??
                  cleanCursorStderr(stderr) ??
                  `cursor-agent exited with code ${code ?? "unknown"}`
              },
        touchedFiles: []
      });
    });
  });
}

export function getCursorAvailability(cwd) {
  const versionStatus = binaryAvailable("cursor-agent", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; cursor-agent CLI available`
  };
}

export function getSessionRuntimeStatus(_env = process.env, _cwd = process.cwd()) {
  return {
    mode: "direct",
    label: "direct startup",
    detail: "Cursor tasks run through cursor-agent CLI on demand.",
    endpoint: null
  };
}

export async function getCursorAuthStatus(cwd) {
  const availability = getCursorAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresCursorAuth: null,
      provider: "cursor"
    };
  }

  return new Promise((resolve) => {
    const child = spawn("cursor-agent", ["status"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      const output = `${stdout}\n${stderr}`.trim();
      const loggedIn = /logged in/i.test(output) || /✓/u.test(output);
      resolve({
        available: true,
        loggedIn: code === 0 && loggedIn,
        detail: output || (code === 0 ? "authenticated" : "not authenticated"),
        source: "cursor-agent",
        authMethod: loggedIn ? "cursor-login" : null,
        verified: loggedIn,
        requiresCursorAuth: true,
        provider: "cursor"
      });
    });
    child.on("error", (error) => {
      resolve({
        available: true,
        loggedIn: false,
        detail: error.message,
        source: "cursor-agent",
        authMethod: null,
        verified: false,
        requiresCursorAuth: true,
        provider: "cursor"
      });
    });
  });
}

export async function interruptCursorTurn(_cwd, { threadId: _threadId, turnId: _turnId }) {
  return {
    attempted: false,
    interrupted: false,
    transport: "cursor-agent",
    detail: "cursor-agent runs are cancelled via process termination."
  };
}

export async function runCursorReview(cwd, options = {}) {
  const availability = getCursorAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "cursor-agent is not installed. Install it with `curl https://cursor.com/install -fsS | bash`, then rerun `/cursor:setup`."
    );
  }

  emitProgress(options.onProgress, "Starting Cursor review session.", "starting");
  const result = await runCursorAgent(cwd, {
    prompt: options.prompt,
    model: options.model,
    sandbox: "read-only",
    write: false,
    onProgress: options.onProgress
  });

  return {
    status: result.status,
    threadId: result.threadId,
    sourceThreadId: result.threadId,
    turnId: result.turnId,
    reviewText: result.reviewText,
    reasoningSummary: result.reasoningSummary,
    error: result.error,
    stderr: result.stderr
  };
}

export async function runCursorTurn(cwd, options = {}) {
  const availability = getCursorAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "cursor-agent is not installed. Install it with `curl https://cursor.com/install -fsS | bash`, then rerun `/cursor:setup`."
    );
  }

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt && !options.resumeChatId) {
    throw new Error("A prompt is required for this Cursor run.");
  }

  if (options.resumeChatId) {
    emitProgress(options.onProgress, `Resuming session ${options.resumeChatId}.`, "starting");
  } else {
    emitProgress(options.onProgress, "Starting Cursor task session.", "starting");
  }

  const result = await runCursorAgent(cwd, {
    prompt,
    model: options.model,
    sandbox: options.sandbox,
    write: options.write,
    resumeChatId: options.resumeChatId ?? null,
    onProgress: options.onProgress
  });

  return {
    status: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    finalMessage: result.finalMessage,
    reasoningSummary: result.reasoningSummary,
    error: result.error,
    stderr: result.stderr,
    fileChanges: [],
    touchedFiles: result.touchedFiles,
    commandExecutions: []
  };
}

export async function findLatestTaskThread(cwd) {
  const jobsDir = process.env.CURSOR_COMPANION_JOBS_DIR;
  if (!jobsDir) {
    return null;
  }

  void cwd;
  void jobsDir;
  return null;
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Cursor did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const trimmed = String(rawOutput).trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonCandidate = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;

  try {
    return {
      parsed: JSON.parse(jsonCandidate),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX, SERVICE_NAME };
