import type { ChatLine, ChatPart } from "./components/shared";

export type ChatGroup =
  | { kind: "message"; message: ChatLine; index: number }
  | { kind: "group"; messages: ChatLine[]; startIndex: number };

export function groupChatMessages(messages: ChatLine[], indexOffset = 0): ChatGroup[] {
  const groups: ChatGroup[] = [];
  let eventMessages: ChatLine[] = [];
  let eventStartIndex = 0;

  const pushEvent = (message: ChatLine, index: number) => {
    if (!eventMessages.length) eventStartIndex = index;
    eventMessages.push(message);
  };
  const flushEvents = () => {
    if (!eventMessages.length) return;
    groups.push({ kind: "group", messages: eventMessages, startIndex: eventStartIndex });
    eventMessages = [];
  };

  messages.forEach((message, index) => {
    const readableParts = message.parts.filter((part) => isReadablePart(message, part));
    const technicalParts = message.parts.filter((part) => !isReadablePart(message, part));

    const absoluteIndex = indexOffset + index;
    if (technicalParts.length) pushEvent({ role: message.role, parts: technicalParts }, absoluteIndex);
    if (readableParts.length) {
      flushEvents();
      groups.push({ kind: "message", message: { role: message.role, parts: readableParts }, index: absoluteIndex });
    }
  });
  flushEvents();
  return groups;
}

export function summarizeChatGroup(messages: ChatLine[]): string {
  if (messages.every((message) => message.source === "compaction")) return `${String(messages.length)} history compaction ${messages.length === 1 ? "summary" : "summaries"}`;
  if (messages.every((message) => message.source === "branch_summary")) return `${String(messages.length)} branch ${messages.length === 1 ? "summary" : "summaries"}`;
  const counts = messages.reduce<Record<string, number>>((acc, message) => {
    acc[message.role] = (acc[message.role] ?? 0) + 1;
    return acc;
  }, {});
  const details = Object.entries(counts).map(([role, count]) => `${String(count)} ${role}`).join(" · ");
  return `${String(messages.length)} ${messages.length === 1 ? "event" : "events"}${details !== "" ? ` · ${details}` : ""}`;
}

function isReadablePart(message: ChatLine, part: ChatPart): boolean {
  if (message.source === "compaction" || message.source === "branch_summary") return false;
  return part.type === "text" && (message.role === "user" || message.role === "assistant" || message.role === "system" || message.role === "bash");
}
