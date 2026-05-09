import { describe, expect, it } from "vitest";
import { textMessage } from "./chatMessages";
import { applyTranscriptEvent } from "./chatTranscript";
import type { ChatLine } from "./components/shared";

const finalAssistant = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "plan" },
    { type: "text", text: "answer" },
  ],
  timestamp: "2026-05-09T12:00:00.000Z",
  provider: "test",
  model: "model",
};

describe("applyTranscriptEvent", () => {
  it("streams thinking and text into one assistant message", () => {
    let messages: ChatLine[] = [];
    messages = applyTranscriptEvent(messages, { type: "assistant.thinking.delta", text: "pla" }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "assistant.thinking.delta", text: "n" }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "assistant.delta", text: "answer" }) ?? messages;

    expect(messages).toEqual([
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "answer" }] },
    ]);
  });

  it("replaces the streamed assistant message with the finalized history shape", () => {
    const streamed: ChatLine[] = [
      textMessage("user", "question"),
      { role: "assistant", parts: [{ type: "thinking", text: "partial" }, { type: "text", text: "partial answer" }] },
    ];

    expect(applyTranscriptEvent(streamed, { type: "message.end", message: finalAssistant })).toEqual([
      textMessage("user", "question"),
      {
        role: "assistant",
        parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "answer" }],
        meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "test", id: "model" } },
      },
    ]);
  });
});
