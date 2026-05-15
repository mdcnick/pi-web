const themeButtons = document.querySelectorAll("[data-theme-toggle]");
const themeStorageKey = "pi-web-theme";
const systemPrefersLight = window.matchMedia("(prefers-color-scheme: light)");

function storedTheme() {
  const theme = window.localStorage.getItem(themeStorageKey);
  return theme === "light" || theme === "dark" ? theme : undefined;
}

function activeTheme() {
  return document.documentElement.dataset.theme === "light" || document.documentElement.dataset.theme === "dark"
    ? document.documentElement.dataset.theme
    : systemPrefersLight.matches
      ? "light"
      : "dark";
}

function updateThemeButtons(theme = activeTheme()) {
  for (const button of themeButtons) {
    button.dataset.theme = theme;
    button.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    const icon = button.querySelector("[data-theme-icon]");
    const label = button.querySelector("[data-theme-label]");
    if (icon !== null) icon.textContent = theme === "light" ? "☀" : "☾";
    if (label !== null) label.textContent = theme === "light" ? "Light" : "Dark";
  }
}

updateThemeButtons();
systemPrefersLight.addEventListener("change", () => {
  if (storedTheme() === undefined) updateThemeButtons();
});

for (const button of themeButtons) {
  button.addEventListener("click", () => {
    const nextTheme = activeTheme() === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem(themeStorageKey, nextTheme);
    updateThemeButtons(nextTheme);
  });
}

const copyButtons = document.querySelectorAll("[data-copy]");

for (const button of copyButtons) {
  button.addEventListener("click", async () => {
    const targetSelector = button.getAttribute("data-copy");
    const target = targetSelector === null ? null : document.querySelector(targetSelector);
    const text = target?.textContent?.replace(/^\s*\$ /gm, "").trim();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = original;
      }, 1400);
    } catch {
      button.textContent = "Select code";
    }
  });
}
