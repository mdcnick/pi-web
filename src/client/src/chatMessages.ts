import type { ChatLine, ChatPart } from "./components/shared";

export function normalizeMessages(messages: unknown[]): ChatLine[] {
  return messages.flatMap(normalizeMessage).filter((message) => message.parts.length > 0);
}

export function textMessage(role: ChatLine["role"], text: string): ChatLine {
  return { role, parts: [{ type: "text", text }] };
}

export function appendText(messages: ChatLine[], role: ChatLine["role"], text: string): ChatLine[] {
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role === role && lastPart?.type === "text") {
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts.slice(0, -1), { ...lastPart, text: lastPart.text + text }] },
    ];
  }
  return [...messages, textMessage(role, text)];
}

function normalizeMessage(message: unknown): ChatLine[] {
  if (getString(message, "role") === "bashExecution") return [normalizeBashExecution(message)];
  const role = normalizeRole(getString(message, "role"));
  const parts = normalizeContent(getProperty(message, "content"), message);
  const source = normalizeSource(message, parts);
  if (role === "tool") return [{ role, parts, ...(source === undefined ? {} : { source }) }];

  const visible = parts.filter((part) => part.type !== "empty");
  return visible.length > 0 ? [{ role, parts: visible, ...(source === undefined ? {} : { source }) }] : [];
}

function normalizeSource(message: unknown, _parts: ChatPart[]): ChatLine["source"] | undefined {
  const source = getString(message, "source");
  if (source === "compaction" || source === "branch_summary") return source;
  return undefined;
}

function normalizeBashExecution(message: unknown): ChatLine {
  const command = getString(message, "command") ?? "";
  const lines = getBoolean(message, "excludeFromContext") === true ? ["excluded from context", "", `$ ${command}`] : [`$ ${command}`];
  const output = getProperty(message, "output");
  if (output != null) lines.push("", stringifyPrimitive(output));
  const exitCode = getProperty(message, "exitCode");
  if (exitCode != null) lines.push("", `exit ${stringifyPrimitive(exitCode)}`);
  if (getBoolean(message, "cancelled") === true) lines.push("", "cancelled");
  if (getBoolean(message, "truncated") === true) lines.push("", "output truncated");
  const fullOutputPath = getString(message, "fullOutputPath");
  if (fullOutputPath !== undefined && fullOutputPath !== "") lines.push("", `full output: ${fullOutputPath}`);
  return { role: "bash", parts: [{ type: "text", text: lines.join("\n") }] };
}

function normalizeRole(role: unknown): ChatLine["role"] {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  if (role === "toolResult") return "tool";
  return "system";
}

function normalizeContent(content: unknown, message: unknown): ChatPart[] {
  if (typeof content === "string") return content !== "" ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return objectFallback(content);

  return content.flatMap((part): ChatPart[] => {
    const type = getString(part, "type");
    const text = getString(part, "text");
    if (type === "text") return text !== undefined && text !== "" ? [{ type: "text", text }] : [];
    if (type === "thinking") {
      const thinking = getString(part, "thinking") ?? text;
      return thinking !== undefined && thinking !== "" ? [{ type: "thinking", text: thinking }] : [];
    }
    if (type === "toolCall") return [{ type: "toolCall", toolName: getString(part, "name") ?? "tool", summary: summarizeArgs(getProperty(part, "arguments")) }];
    if (type === "image") return [{ type: "text", text: "[image]" }];
    return objectFallback(part);
  }).map((part) => part.type === "text" && getString(message, "role") === "toolResult"
    ? { type: "toolResult", toolName: getString(message, "toolName") ?? "tool", text: part.text, isError: getBoolean(message, "isError") === true }
    : part);
}

function objectFallback(value: unknown): ChatPart[] {
  if (value == null) return [];
  if (typeof value === "object") return [{ type: "text", text: summarizeArgs(value) }];
  return [{ type: "text", text: stringifyPrimitive(value) }];
}

function summarizeArgs(args: unknown): string {
  if (!isRecord(args)) return stringifyPrimitive(args);
  const command = getString(args, "command");
  if (command !== undefined) return command;
  const path = getString(args, "path");
  if (path !== undefined) return path;
  if (typeof args["oldText"] === "string" && typeof args["newText"] === "string") return "edit text replacement";
  const edits = args["edits"];
  if (Array.isArray(edits)) return `${String(edits.length)} edit${edits.length === 1 ? "" : "s"}`;
  const entries = Object.entries(args).filter(([, value]) => value != null).slice(0, 3);
  return entries.map(([key, value]) => `${key}: ${shortValue(value)}`).join(" · ");
}

function shortValue(value: unknown): string {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${String(value.length)} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object" && value !== null) return "object";
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function getBoolean(value: unknown, key: string): boolean | undefined {
  const property = getProperty(value, key);
  return typeof property === "boolean" ? property : undefined;
}

function stringifyPrimitive(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}
