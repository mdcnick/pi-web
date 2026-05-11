import { describe, expect, it, vi } from "vitest";
import { activateSelectableRow, activateSelectableRowFromKeyboard } from "./selectableRow";

describe("selectable row activation", () => {
  it("activates rows from non-interactive click targets", () => {
    const action = vi.fn();
    activateSelectableRow(eventWithPath({ matches: () => false }), action);
    expect(action).toHaveBeenCalledOnce();
  });

  it("preserves contributed links and other interactive elements", () => {
    const action = vi.fn();
    activateSelectableRow(eventWithPath({ matches: (selector: string) => selector.includes("a[href]") }), action);
    expect(action).not.toHaveBeenCalled();
  });

  it("activates rows from Enter and Space", () => {
    const enterAction = vi.fn();
    const spaceAction = vi.fn();
    const enter = keyboardEventWithPath("Enter", { matches: () => false });
    const space = keyboardEventWithPath(" ", { matches: () => false });

    activateSelectableRowFromKeyboard(enter, enterAction);
    activateSelectableRowFromKeyboard(space, spaceAction);

    expect(enterAction).toHaveBeenCalledOnce();
    expect(spaceAction).toHaveBeenCalledOnce();
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(space.preventDefault).toHaveBeenCalledOnce();
  });

  it("does not activate rows from keyboard events inside interactive elements", () => {
    const action = vi.fn();
    const event = keyboardEventWithPath("Enter", { matches: (selector: string) => selector.includes("button") });

    activateSelectableRowFromKeyboard(event, action);

    expect(action).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

function eventWithPath(target: Pick<Element, "matches">): MouseEvent {
  return { composedPath: () => [target] } as unknown as MouseEvent;
}

function keyboardEventWithPath(key: string, target: Pick<Element, "matches">): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return { key, preventDefault: vi.fn(), composedPath: () => [target] } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}
