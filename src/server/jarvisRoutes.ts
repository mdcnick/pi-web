import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ProjectService } from "./projects/projectService.js";
import type { WorkspaceService } from "./workspaces/workspaceService.js";
import type { SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";
import { WorkspaceAccessController, workspaceAccessErrorStatus } from "./workspaceAccessPolicy.js";
import { normalizeRequestCwd } from "./workingDirectory.js";

export interface JarvisCommandResponse {
  text: string;
  mode: "brief" | "help" | "sessions" | "blocked" | "echo" | "task";
  speak: boolean;
  needsApproval?: boolean;
  details?: Record<string, unknown>;
}

interface JarvisCommandBody {
  text?: unknown;
  cwd?: unknown;
}

interface JarvisTaskBody {
  title?: unknown;
  prompt?: unknown;
  cwd?: unknown;
}

interface JarvisTranscribeBody {
  audioBase64?: unknown;
  mimeType?: unknown;
}

interface JarvisRoutesDeps {
  projects: ProjectService;
  workspaces: WorkspaceService;
  sessionDaemon: SessionProxyDaemon;
  workspaceAccess?: WorkspaceAccessController;
}

interface JarvisTask {
  id: string;
  title: string;
  prompt: string;
  cwd?: string;
  status: "draft" | "ready" | "dispatched" | "blocked" | "done";
  assignedTo?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  messages: JarvisTaskMessage[];
}

interface JarvisTaskMessage {
  id: string;
  from: "nick" | "jarvis" | "agent" | "system";
  text: string;
  createdAt: string;
}

const execFileAsync = promisify(execFile);
const MAX_TRANSCRIPTION_AUDIO_BYTES = 15 * 1024 * 1024;

export function registerJarvisRoutes(app: FastifyInstance, deps: JarvisRoutesDeps): void {
  const workspaceAccess = deps.workspaceAccess ?? new WorkspaceAccessController({ enabled: false });
  const tasks = new Map<string, JarvisTask>();

  app.get("/jarvis", (_request, reply) => reply.type("text/html; charset=utf-8").send(jarvisHtml()));

  app.get("/api/jarvis/status", async (request, reply) => {
    try {
      workspaceAccess.requireUser(request);
      return {
        ok: true,
        surface: "/jarvis",
        commands: ["help", "brief", "sessions", "create task"],
        note: "Jarvis is running as a first-class assistant surface. Risky actions stay blocked until approval gates are implemented.",
      };
    } catch (error) {
      return sendAccessError(reply, error);
    }
  });

  app.post<{ Body: JarvisTranscribeBody | undefined }>("/api/jarvis/transcribe", async (request, reply) => {
    try {
      workspaceAccess.requireUser(request);
      const body = optionalRecord(request.body);
      const transcript = await transcribeAudio(requireString(body["audioBase64"], "audioBase64"), optionalMimeType(body["mimeType"]));
      return { text: transcript };
    } catch (error) {
      const status = error instanceof JarvisTranscriptionNotConfiguredError ? 501 : workspaceAccessErrorStatus(error);
      return reply.code(status).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/jarvis/tasks", async (request, reply) => {
    try {
      workspaceAccess.requireUser(request);
      return { tasks: [...tasks.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) };
    } catch (error) {
      return sendAccessError(reply, error);
    }
  });

  app.post<{ Body: JarvisTaskBody | undefined }>("/api/jarvis/tasks", async (request, reply) => {
    try {
      workspaceAccess.requireUser(request);
      const body = optionalRecord(request.body);
      const cwd = parseOptionalCwd(body["cwd"]);
      if (cwd !== undefined) workspaceAccess.requireWorkspace(request, cwd);
      const task = createTask({
        title: requireString(body["title"], "title"),
        prompt: requireString(body["prompt"], "prompt"),
        ...(cwd === undefined ? {} : { cwd }),
        from: "nick",
      }, tasks);
      return { task };
    } catch (error) {
      return reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { taskId: string }; Body: { text?: unknown; from?: unknown } | undefined }>("/api/jarvis/tasks/:taskId/messages", async (request, reply) => {
    try {
      workspaceAccess.requireUser(request);
      const task = requireTask(request.params.taskId, tasks);
      if (task.cwd !== undefined) workspaceAccess.requireWorkspace(request, task.cwd);
      const body = optionalRecord(request.body);
      const from = parseTaskMessageFrom(body["from"]);
      const message = appendTaskMessage(task, from, requireString(body["text"], "text"));
      return { task, message };
    } catch (error) {
      return reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: JarvisCommandBody | undefined }>("/api/jarvis/command", async (request, reply) => {
    try {
      workspaceAccess.requireUser(request);
      const body = optionalRecord(request.body);
      const text = requireCommandText(body["text"]);
      const cwd = parseOptionalCwd(body["cwd"]);
      if (cwd !== undefined) workspaceAccess.requireWorkspace(request, cwd);
      return await handleJarvisCommand(text, cwd, deps, request, tasks);
    } catch (error) {
      return reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function handleJarvisCommand(text: string, cwd: string | undefined, deps: JarvisRoutesDeps, request: FastifyRequest, tasks: Map<string, JarvisTask>): Promise<JarvisCommandResponse> {
  const normalized = text.toLowerCase();
  if (matches(normalized, ["help", "what can you do", "commands"])) return helpResponse();
  if (matches(normalized, ["install", "deploy", "delete", "secret", "restart", "publish", "spend", "credit"])) return blockedResponse();
  if (matches(normalized, ["create task", "make task", "new task", "mission", "sub agency", "subagency", "delegate", "worker", "agent"])) return taskResponse(text, cwd, tasks);
  if (matches(normalized, ["session", "sessions", "active"])) return await sessionsResponse(cwd, deps);
  if (matches(normalized, ["brief", "summary", "summarize", "status", "today", "workspace", "what are we working on"])) return await briefResponse(cwd, deps, request, tasks);
  return {
    mode: "echo",
    speak: true,
    text: `I heard: ${text}. I can brief the workspace, count sessions, and create Jarvis tasks for the sub-agency.`,
  };
}

function taskResponse(text: string, cwd: string | undefined, tasks: Map<string, JarvisTask>): JarvisCommandResponse {
  const cleaned = text.replace(/^jarvis[, ]*/iu, "").trim();
  const title = taskTitleFromText(cleaned);
  const task = createTask({
    title,
    prompt: cleaned,
    ...(cwd === undefined ? {} : { cwd }),
    from: "nick",
  }, tasks);
  appendTaskMessage(task, "jarvis", "Task created. I am holding it in the mission queue until dispatch and approval gates are wired to live sub-agent sessions.");
  return {
    mode: "task",
    speak: true,
    text: `Task created: ${task.title}. I added it to the mission queue. Next I need dispatch controls so I can send it to a sub-agent and track the result.`,
    details: { taskId: task.id, status: task.status },
  };
}

function helpResponse(): JarvisCommandResponse {
  return {
    mode: "help",
    speak: true,
    text: "I am Jarvis. I can brief your workspace, speak session status, and create mission tasks for the sub-agency. Risky actions like installs, deploys, restarts, deletes, secrets, and spending credits stay blocked until approval gates are in place.",
  };
}

function blockedResponse(): JarvisCommandResponse {
  return {
    mode: "blocked",
    speak: true,
    needsApproval: true,
    text: "That is a protected action. I am not running installs, deployments, restarts, deletes, secret changes, or credit-spending calls from voice until the approval queue is implemented.",
  };
}

async function sessionsResponse(cwd: string | undefined, deps: JarvisRoutesDeps): Promise<JarvisCommandResponse> {
  if (cwd === undefined) {
    return {
      mode: "sessions",
      speak: true,
      text: "Select or enter a workspace path first, then ask me about sessions again.",
    };
  }
  const sessions = await daemonJson(deps.sessionDaemon, "GET", `/sessions?cwd=${encodeURIComponent(cwd)}`);
  const count = Array.isArray(sessions) ? sessions.length : 0;
  return {
    mode: "sessions",
    speak: true,
    text: count === 1 ? "There is one session in this workspace." : `There are ${String(count)} sessions in this workspace.`,
    details: { sessionCount: count },
  };
}

async function briefResponse(cwd: string | undefined, deps: JarvisRoutesDeps, request: FastifyRequest, tasks: Map<string, JarvisTask>): Promise<JarvisCommandResponse> {
  const projects = await deps.projects.list();
  let visibleProjects = 0;
  let visibleWorkspaces = 0;
  const user = deps.workspaceAccess?.requireUser(request);
  for (const project of projects) {
    const workspaces = await deps.workspaces.list(project);
    const visible = workspaces.filter((workspace) => user === undefined || deps.workspaceAccess?.canAccessWorkspace(user, workspace.path) === true);
    if (visible.length > 0) visibleProjects += 1;
    visibleWorkspaces += visible.length;
  }

  const health = parseHealth(await daemonJson(deps.sessionDaemon, "GET", "/health").catch(() => undefined));
  const sessionText = typeof health.activeSessions === "number"
    ? `The session daemon reports ${String(health.activeSessions)} active ${health.activeSessions === 1 ? "session" : "sessions"}.`
    : "The session daemon status is not available right now.";
  const workspaceText = cwd === undefined ? "No workspace path is selected." : `Selected workspace: ${cwd}.`;
  return {
    mode: "brief",
    speak: true,
    text: `${workspaceText} I can see ${String(visibleProjects)} projects and ${String(visibleWorkspaces)} workspaces. ${sessionText} There are ${String(tasks.size)} Jarvis tasks in the mission queue.`,
    details: { projectCount: visibleProjects, workspaceCount: visibleWorkspaces, selectedCwd: cwd, activeSessions: health.activeSessions, taskCount: tasks.size },
  };
}

function createTask(input: { title: string; prompt: string; cwd?: string; from: JarvisTaskMessage["from"] }, tasks: Map<string, JarvisTask>): JarvisTask {
  const now = new Date().toISOString();
  const task: JarvisTask = {
    id: `jtask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: input.title,
    prompt: input.prompt,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    status: "ready",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  appendTaskMessage(task, input.from, input.prompt);
  tasks.set(task.id, task);
  return task;
}

function requireTask(taskId: string, tasks: Map<string, JarvisTask>): JarvisTask {
  const task = tasks.get(taskId);
  if (task === undefined) throw new Error(`Jarvis task not found: ${taskId}`);
  return task;
}

function appendTaskMessage(task: JarvisTask, from: JarvisTaskMessage["from"], text: string): JarvisTaskMessage {
  const now = new Date().toISOString();
  const message = { id: `jmsg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, from, text, createdAt: now };
  task.messages.push(message);
  task.updatedAt = now;
  return message;
}

class JarvisTranscriptionNotConfiguredError extends Error {}

async function transcribeAudio(audioBase64: string, mimeType: string | undefined): Promise<string> {
  const buffer = Buffer.from(audioBase64, "base64");
  if (buffer.length === 0) throw new Error("audioBase64 is empty");
  if (buffer.length > MAX_TRANSCRIPTION_AUDIO_BYTES) throw new Error("Jarvis audio is too large to transcribe. Keep recordings under 15 MB.");

  const provider = process.env["PI_WEB_JARVIS_TRANSCRIBE_PROVIDER"];
  if (provider === "assemblyai") return await transcribeWithAssemblyAi(buffer, mimeType);
  if (provider === "openai") return await transcribeWithOpenAi(buffer, mimeType);

  const command = process.env["PI_WEB_JARVIS_TRANSCRIBE_COMMAND"];
  if (command === undefined || command.trim() === "") {
    throw new JarvisTranscriptionNotConfiguredError("Jarvis audio recording is working, but transcription is not configured. Set PI_WEB_JARVIS_TRANSCRIBE_COMMAND for a local transcriber, set PI_WEB_JARVIS_TRANSCRIBE_PROVIDER=assemblyai with ASSEMBLYAI_API_KEY after approving AssemblyAI calls, or set PI_WEB_JARVIS_TRANSCRIBE_PROVIDER=openai with OPENAI_API_KEY after approving paid transcription calls.");
  }

  const dir = await mkdtemp(join(tmpdir(), "pi-web-jarvis-"));
  const audioPath = join(dir, `input${extensionForMimeType(mimeType)}`);
  try {
    await writeFile(audioPath, buffer, { mode: 0o600 });
    const { stdout } = await execFileAsync("bash", ["-lc", command], {
      env: { ...process.env, JARVIS_AUDIO_PATH: audioPath, JARVIS_AUDIO_MIME_TYPE: mimeType ?? "" },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const text = stdout.trim();
    if (text === "") throw new Error("Transcription command returned no text");
    return text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function transcribeWithAssemblyAi(buffer: Buffer, mimeType: string | undefined): Promise<string> {
  const apiKey = process.env["ASSEMBLYAI_API_KEY"];
  if (apiKey === undefined || apiKey === "") throw new JarvisTranscriptionNotConfiguredError("ASSEMBLYAI_API_KEY is required for PI_WEB_JARVIS_TRANSCRIBE_PROVIDER=assemblyai.");
  const baseUrl = (process.env["PI_WEB_JARVIS_ASSEMBLYAI_BASE_URL"] ?? "https://api.assemblyai.com").replace(/\/$/u, "");
  const uploadResponse = await fetch(`${baseUrl}/v2/upload`, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": mimeType ?? "application/octet-stream" },
    body: new Uint8Array(buffer),
  });
  const uploadBody = await parseResponseBody(uploadResponse);
  if (!uploadResponse.ok) throw new Error(assemblyAiErrorMessage(uploadBody) ?? uploadResponse.statusText);
  if (!isRecord(uploadBody) || typeof uploadBody["upload_url"] !== "string" || uploadBody["upload_url"] === "") throw new Error("AssemblyAI upload returned no upload_url");

  const submitResponse = await fetch(`${baseUrl}/v2/transcript`, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({ audio_url: uploadBody["upload_url"], speech_models: assemblyAiSpeechModels() }),
  });
  const submitBody = await parseResponseBody(submitResponse);
  if (!submitResponse.ok) throw new Error(assemblyAiErrorMessage(submitBody) ?? submitResponse.statusText);
  if (!isRecord(submitBody) || typeof submitBody["id"] !== "string" || submitBody["id"] === "") throw new Error("AssemblyAI transcript submission returned no id");

  const deadline = Date.now() + assemblyAiPollTimeoutMs();
  while (Date.now() < deadline) {
    const transcriptResponse = await fetch(`${baseUrl}/v2/transcript/${encodeURIComponent(submitBody["id"])}`, { headers: { authorization: apiKey } });
    const transcriptBody = await parseResponseBody(transcriptResponse);
    if (!transcriptResponse.ok) throw new Error(assemblyAiErrorMessage(transcriptBody) ?? transcriptResponse.statusText);
    if (isRecord(transcriptBody) && transcriptBody["status"] === "completed") {
      if (typeof transcriptBody["text"] !== "string" || transcriptBody["text"].trim() === "") throw new Error("AssemblyAI transcription returned no text");
      return transcriptBody["text"].trim();
    }
    if (isRecord(transcriptBody) && transcriptBody["status"] === "error") throw new Error(assemblyAiErrorMessage(transcriptBody) ?? "AssemblyAI transcription failed");
    await sleep(assemblyAiPollIntervalMs());
  }
  throw new Error("AssemblyAI transcription timed out");
}

async function transcribeWithOpenAi(buffer: Buffer, mimeType: string | undefined): Promise<string> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (apiKey === undefined || apiKey === "") throw new JarvisTranscriptionNotConfiguredError("OPENAI_API_KEY is required for PI_WEB_JARVIS_TRANSCRIBE_PROVIDER=openai.");
  const form = new FormData();
  form.set("model", process.env["PI_WEB_JARVIS_TRANSCRIBE_MODEL"] ?? "whisper-1");
  const audioBytes = new Uint8Array(buffer.length);
  audioBytes.set(buffer);
  form.set("file", new Blob([audioBytes], { type: mimeType ?? "audio/webm" }), `jarvis${extensionForMimeType(mimeType)}`);
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(openAiErrorMessage(body) ?? response.statusText);
  if (!isRecord(body) || typeof body["text"] !== "string" || body["text"].trim() === "") throw new Error("OpenAI transcription returned no text");
  return body["text"].trim();
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assemblyAiSpeechModels(): string[] {
  const configured = process.env["PI_WEB_JARVIS_ASSEMBLYAI_SPEECH_MODELS"];
  if (configured === undefined || configured.trim() === "") return ["universal-3-pro", "universal-2"];
  return configured.split(",").map((model) => model.trim()).filter((model) => model !== "");
}

function assemblyAiPollTimeoutMs(): number {
  return positiveIntegerEnv("PI_WEB_JARVIS_ASSEMBLYAI_TIMEOUT_MS", 60_000);
}

function assemblyAiPollIntervalMs(): number {
  return positiveIntegerEnv("PI_WEB_JARVIS_ASSEMBLYAI_POLL_MS", 1_000);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  const parsed = value === undefined || value === "" ? NaN : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assemblyAiErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (!isRecord(value)) return undefined;
  if (typeof value["error"] === "string") return value["error"];
  return undefined;
}

function openAiErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = value["error"];
  if (isRecord(error) && typeof error["message"] === "string") return error["message"];
  return undefined;
}

function extensionForMimeType(mimeType: string | undefined): string {
  if (mimeType?.includes("webm") === true) return ".webm";
  if (mimeType?.includes("ogg") === true) return ".ogg";
  if (mimeType?.includes("wav") === true) return ".wav";
  if (mimeType?.includes("mpeg") === true || mimeType?.includes("mp3") === true) return ".mp3";
  return ".audio";
}

async function daemonJson(daemon: SessionProxyDaemon, method: string, path: string): Promise<unknown> {
  const response = await daemon.request(method, path);
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Session daemon returned ${String(response.statusCode)}`);
  return response.body === "" ? undefined : JSON.parse(response.body);
}

function parseHealth(value: unknown): { activeSessions?: number } {
  if (!isRecord(value)) return {};
  return typeof value["activeSessions"] === "number" ? { activeSessions: value["activeSessions"] } : {};
}

function taskTitleFromText(text: string): string {
  const cleaned = text
    .replace(/^(create|make|new|delegate|send|build|start)\s+(a\s+)?(task|mission|worker|agent)?\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned === "") return "Jarvis task";
  return cleaned.length > 72 ? `${cleaned.slice(0, 69)}...` : cleaned;
}

function matches(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function optionalRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Request body must be an object");
  return value;
}

function requireCommandText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("text is required");
  return value.trim();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function parseOptionalCwd(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("cwd must be a string");
  return normalizeRequestCwd(value);
}

function optionalMimeType(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("mimeType must be a string");
  return value;
}

function parseTaskMessageFrom(value: unknown): JarvisTaskMessage["from"] {
  if (value === undefined) return "nick";
  if (value === "nick" || value === "jarvis" || value === "agent" || value === "system") return value;
  throw new Error("from must be nick, jarvis, agent, or system");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendAccessError(reply: FastifyReply, error: unknown): FastifyReply {
  return reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
}

function jarvisHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Jarvis</title>
  <style>
    :root { color-scheme: dark; --bg:#05070d; --panel:#0d1322; --panel2:#101a2f; --line:#22314f; --text:#e8f1ff; --muted:#8fa5c7; --accent:#60d8ff; --green:#6dffb5; --red:#ff6d8a; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100dvh; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--text); background: radial-gradient(circle at 50% 15%, rgba(38, 171, 255, .2), transparent 32rem), linear-gradient(180deg, #060812, #02030a 60%); }
    .app { min-height:100dvh; display:grid; grid-template-columns: minmax(280px, 380px) 1fr minmax(280px, 420px); gap:18px; padding:22px; }
    .panel { border:1px solid var(--line); border-radius:24px; background:rgba(9, 14, 26, .76); box-shadow: 0 20px 80px rgba(0,0,0,.38); backdrop-filter: blur(14px); overflow:hidden; }
    .panel header { padding:16px 18px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .panel h2 { margin:0; font-size:14px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
    .content { padding:18px; }
    .center { display:grid; place-items:center; text-align:center; position:relative; }
    .orb { width:min(42vw, 360px); aspect-ratio:1; border-radius:50%; border:1px solid rgba(96,216,255,.7); background: radial-gradient(circle at 50% 45%, rgba(130,240,255,.95), rgba(49,144,255,.32) 34%, rgba(28,47,96,.18) 60%, rgba(5,7,13,.1) 70%); box-shadow: 0 0 45px rgba(96,216,255,.32), inset 0 0 60px rgba(255,255,255,.12); cursor:pointer; transition: transform .18s ease, box-shadow .18s ease; }
    .orb:hover { transform: scale(1.025); box-shadow: 0 0 70px rgba(96,216,255,.45), inset 0 0 70px rgba(255,255,255,.16); }
    .orb.listening { animation: pulse 1.2s infinite; border-color:var(--green); }
    @keyframes pulse { 0%,100% { box-shadow:0 0 45px rgba(109,255,181,.25); } 50% { box-shadow:0 0 110px rgba(109,255,181,.55); } }
    .status { margin-top:22px; font-size:18px; color:var(--accent); }
    .subtitle { margin-top:8px; color:var(--muted); max-width:620px; line-height:1.55; }
    .context { width:min(760px, 90%); margin:24px auto 0; }
    input, textarea { width:100%; border:1px solid var(--line); background:rgba(4,8,17,.9); color:var(--text); border-radius:14px; padding:12px 14px; outline:none; }
    button { border:1px solid var(--line); border-radius:14px; background:linear-gradient(180deg, #14233e, #0b1427); color:var(--text); padding:11px 14px; cursor:pointer; font-weight:650; }
    button:hover { border-color:var(--accent); }
    button.primary { background:linear-gradient(180deg, #22a9ff, #1765c5); border-color:#4fc8ff; color:white; }
    .task { border:1px solid var(--line); border-radius:16px; padding:12px; margin-bottom:10px; background:rgba(16,26,47,.7); }
    .task strong { display:block; margin-bottom:6px; }
    .badge { color:var(--green); font-size:12px; text-transform:uppercase; letter-spacing:.12em; }
    .muted { color:var(--muted); }
    .log { display:flex; flex-direction:column; gap:10px; max-height:58dvh; overflow:auto; }
    .line { border-left:2px solid var(--accent); padding:8px 10px; background:rgba(96,216,255,.06); border-radius:10px; line-height:1.4; }
    .topbar { position:fixed; left:22px; right:22px; top:14px; display:flex; justify-content:center; pointer-events:none; }
    .brand { pointer-events:auto; border:1px solid var(--line); background:rgba(4,8,17,.72); border-radius:999px; padding:8px 14px; color:var(--muted); font-size:13px; }
    body.embedded { background: transparent; }
    body.embedded .topbar { display:none; }
    body.embedded .app { min-height:100dvh; padding:0; gap:14px; }
    body.embedded .panel { border-radius:18px; }
    @media (max-width: 980px) { .app { grid-template-columns:1fr; padding-top:58px; } .orb { width:min(70vw, 310px); } body.embedded .app { padding-top:0; } }
  </style>
</head>
<body>
  <div class="topbar"><div class="brand">JARVIS // central command</div></div>
  <main class="app">
    <aside class="panel">
      <header><h2>Mission Queue</h2><button id="refreshTasks">Refresh</button></header>
      <div class="content"><div id="tasks"></div></div>
    </aside>
    <section class="center panel">
      <div class="content">
        <button id="orb" class="orb" aria-label="Talk to Jarvis"></button>
        <div id="status" class="status">Jarvis online.</div>
        <div id="spoken" class="subtitle">Hold the orb, speak, then release to send. I will talk back.</div>
        <div class="context">
          <input id="cwd" placeholder="Workspace context, e.g. /home/nick/storagebox-sync/central-workspace" />
        </div>
      </div>
    </section>
    <aside class="panel">
      <header><h2>Comms</h2><span id="agentCount" class="badge">standby</span></header>
      <div class="content"><div id="log" class="log"></div></div>
    </aside>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    if (params.get('embedded') === '1') document.body.classList.add('embedded');
    const maxRecordingMs = 30_000;
    const state = { last: 'Jarvis online.', listening: false, starting: false, stopAfterStart: false, recorder: null, chunks: [], recordingTimer: 0 };
    const $ = (id) => document.getElementById(id);
    const log = (text) => {
      const node = document.createElement('div');
      node.className = 'line';
      node.textContent = text;
      $('log').prepend(node);
    };
    const speak = (text) => {
      state.last = text;
      $('spoken').textContent = text;
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
    };
    const sendCommand = async (text) => {
      const command = text.trim();
      if (!command) return;
      $('status').textContent = 'Thinking...';
      log('Nick → Jarvis: ' + command);
      try {
        const cwd = $('cwd').value.trim();
        const response = await fetch('/api/jarvis/command', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: command, ...(cwd ? { cwd } : {}) }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || response.statusText);
        $('status').textContent = body.mode === 'blocked' ? 'Approval needed.' : 'Ready.';
        speak(body.text || 'Done.');
        log('Jarvis → Nick: ' + (body.text || 'Done.'));
        await loadTasks();
      } catch (error) {
        const message = 'Jarvis error: ' + (error instanceof Error ? error.message : String(error));
        $('status').textContent = 'Error.';
        speak(message);
        log(message);
      }
    };
    const startRecording = async () => {
      if (state.listening || state.starting) return;
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        speak('Audio recording is not available in this browser.');
        return;
      }
      state.starting = true;
      state.stopAfterStart = false;
      $('status').textContent = 'Opening microphone...';
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.chunks = [];
        const recorder = new MediaRecorder(stream);
        state.recorder = recorder;
        state.listening = true;
        state.starting = false;
        $('orb').classList.add('listening');
        $('status').textContent = 'Recording... release to send.';
        state.recordingTimer = window.setTimeout(() => { if (state.recorder?.state === 'recording') state.recorder.stop(); }, maxRecordingMs);
        recorder.ondataavailable = (event) => { if (event.data.size > 0) state.chunks.push(event.data); };
        recorder.onerror = () => speak('Recording error. Check microphone permissions and try again.');
        recorder.onstop = async () => {
          window.clearTimeout(state.recordingTimer);
          state.listening = false;
          state.recorder = null;
          $('orb').classList.remove('listening');
          for (const track of stream.getTracks()) track.stop();
          await transcribeAndSend(new Blob(state.chunks, { type: recorder.mimeType || 'audio/webm' }));
        };
        recorder.start();
        if (state.stopAfterStart) window.setTimeout(stopRecording, 0);
      } catch (error) {
        window.clearTimeout(state.recordingTimer);
        state.listening = false;
        state.starting = false;
        state.stopAfterStart = false;
        $('orb').classList.remove('listening');
        speak('Microphone error: ' + (error instanceof Error ? error.message : String(error)));
      }
    };
    const stopRecording = () => {
      if (state.starting) {
        state.stopAfterStart = true;
        $('status').textContent = 'Sending...';
        return;
      }
      if (state.recorder?.state === 'recording') {
        $('status').textContent = 'Sending...';
        state.recorder.stop();
      }
    };
    const transcribeAndSend = async (blob) => {
      if (blob.size === 0) { speak('I did not hear any audio.'); return; }
      $('status').textContent = 'Transcribing...';
      try {
        const audioBase64 = await blobToBase64(blob);
        const response = await fetch('/api/jarvis/transcribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ audioBase64, mimeType: blob.type }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || response.statusText);
        const transcript = String(body.text || '').trim();
        if (!transcript) throw new Error('No transcript returned');
        await sendCommand(transcript);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        $('status').textContent = 'Transcription unavailable.';
        speak(message);
        log('Jarvis transcription: ' + message);
      }
    };
    const blobToBase64 = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    const loadTasks = async () => {
      const response = await fetch('/api/jarvis/tasks');
      if (!response.ok) return;
      const body = await response.json();
      const tasks = Array.isArray(body.tasks) ? body.tasks : [];
      $('agentCount').textContent = tasks.length + ' tasks';
      $('tasks').innerHTML = tasks.length === 0 ? '<p class="muted">No Jarvis tasks yet.</p>' : '';
      for (const task of tasks) {
        const node = document.createElement('div');
        node.className = 'task';
        node.innerHTML = '<strong></strong><div class="muted"></div><div class="badge"></div>';
        node.querySelector('strong').textContent = task.title || task.id;
        node.querySelector('.muted').textContent = task.cwd || 'No workspace selected';
        node.querySelector('.badge').textContent = task.status || 'ready';
        $('tasks').append(node);
      }
    };
    $('orb').addEventListener('pointerdown', (event) => {
      event.preventDefault();
      $('orb').setPointerCapture?.(event.pointerId);
      void startRecording();
    });
    $('orb').addEventListener('pointerup', stopRecording);
    $('orb').addEventListener('pointercancel', stopRecording);
    $('orb').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (state.listening || state.starting) stopRecording();
      else void startRecording();
    });
    $('refreshTasks').addEventListener('click', loadTasks);
    const initialCwd = params.get('cwd');
    if (initialCwd) $('cwd').value = initialCwd;
    log('System: Jarvis command center loaded.');
    void loadTasks();
  </script>
</body>
</html>`;
}
