import { initializeWorkspaceAuth } from "./clerkAuth";

if (await initializeWorkspaceAuth()) {
  await import("./components/PiWebApp");
}
