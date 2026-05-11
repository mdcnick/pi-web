const interactiveSelector = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[contenteditable='true']",
].join(",");

export function isFromInteractiveElement(event: Event): boolean {
  return event.composedPath().some((target) => isElementLike(target) && target.matches(interactiveSelector));
}

function isElementLike(target: EventTarget): target is Element {
  if (typeof Element !== "undefined") return target instanceof Element;
  return typeof (target as Partial<Element>).matches === "function";
}

export function activateSelectableRow(event: MouseEvent, action: () => void): void {
  if (isFromInteractiveElement(event)) return;
  action();
}

export function activateSelectableRowFromKeyboard(event: KeyboardEvent, action: () => void): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (isFromInteractiveElement(event)) return;
  event.preventDefault();
  action();
}
