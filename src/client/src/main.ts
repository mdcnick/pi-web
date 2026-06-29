import { initializeWorkspaceAuth } from "./workspaceAuth";

if (await initializeWorkspaceAuth()) {
  await import("./components/PiWebApp");
}
