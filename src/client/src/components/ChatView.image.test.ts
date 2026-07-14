import type { TemplateResult } from "lit";
import { describe, expect, it } from "vitest";
import type { ChatLine } from "./shared";
import { ChatView } from "./ChatView";

describe("ChatView image rendering", () => {
  // Direct handler extraction keeps this node-environment test focused on the
  // late image-load scroll wiring without introducing a component-wide DOM shim.
  it("renders native image data and re-pins late loads only while already pinned", () => {
    const view = new ChatView();
    let scrollCalls = 0;
    if (!Reflect.set(view, "scrollToBottom", () => { scrollCalls += 1; })) throw new Error("Could not observe ChatView.scrollToBottom");
    const rendered = renderPart(view, { type: "image", mimeType: "image/png", data: "QUJD" });
    const onLoad = templateEventHandler(rendered, "@load=");

    expect(templateStaticMarkup(rendered)).toContain("<img");
    expect(templateStaticMarkup(rendered)).toContain('loading="lazy"');
    expect(templateValuesAfterMarker(rendered, "src=")).toEqual(["data:image/png;base64,QUJD"]);

    if (!Reflect.set(view, "pinnedToBottom", true)) throw new Error("Could not set ChatView.pinnedToBottom");
    onLoad(new Event("load"));
    if (!Reflect.set(view, "pinnedToBottom", false)) throw new Error("Could not set ChatView.pinnedToBottom");
    onLoad(new Event("load"));

    expect(scrollCalls).toBe(1);
  });
});

type RenderPart = (this: ChatView, part: ChatLine["parts"][number], message?: ChatLine) => TemplateResult;
type TemplateEventHandler = (event: Event) => void;

function renderPart(view: ChatView, part: ChatLine["parts"][number], message?: ChatLine): TemplateResult {
  const method: unknown = Reflect.get(view, "renderPart");
  if (!isRenderPart(method)) throw new Error("ChatView.renderPart is not callable");
  return method.call(view, part, message);
}

function templateEventHandler(template: TemplateResult, marker: string): TemplateEventHandler {
  const strings = templateStrings(template);
  const values = templateValues(template);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (strings[index]?.includes(marker) === true && isTemplateEventHandler(value)) return value;
  }
  throw new Error(`Expected template event handler after ${marker}`);
}

function isRenderPart(value: unknown): value is RenderPart {
  return typeof value === "function";
}

function isTemplateEventHandler(value: unknown): value is TemplateEventHandler {
  return typeof value === "function";
}

function templateStaticMarkup(template: TemplateResult): string {
  return templateStrings(template).join("");
}

function templateValuesAfterMarker(template: TemplateResult, marker: string): unknown[] {
  const strings = templateStrings(template);
  return templateValues(template).filter((_, index) => strings[index]?.includes(marker) === true);
}

function templateStrings(template: TemplateResult): readonly string[] {
  const strings = Reflect.get(template, "strings");
  if (!isStringArray(strings)) throw new Error("TemplateResult strings were unavailable");
  return strings;
}

function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values.map((value: unknown) => value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}
