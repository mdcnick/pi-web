import type { FastifyInstance } from "fastify";
import type { WorkspaceAuthProviderKind } from "./auth/workspaceAuthProvider.js";
import { WorkspaceAccessController, workspaceAccessErrorStatus, type WorkspaceAccessPolicy } from "./workspaceAccessPolicy.js";

export interface WorkspaceAccessSettingsResponse {
  enabled: boolean;
  provider: WorkspaceAuthProviderKind;
  path: string;
  exists: boolean;
  policy: WorkspaceAccessPolicy;
}

export interface WorkspaceAccessPublicResponse {
  enabled: boolean;
  provider: WorkspaceAuthProviderKind;
  internalAuth?: boolean;
}

export function registerWorkspaceAccessRoutes(app: FastifyInstance, workspaceAccess: WorkspaceAccessController): void {
  app.get("/api/workspace-access/public", () => workspaceAccessPublicSettings(workspaceAccess));

  app.get("/api/workspace-access", async (request, reply) => {
    try {
      workspaceAccess.requireAdmin(request);
      return workspaceAccessSettings(workspaceAccess);
    } catch (error) {
      return await reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Body: { policy?: WorkspaceAccessPolicy } }>("/api/workspace-access", async (request, reply) => {
    try {
      workspaceAccess.requireAdmin(request);
      const policy = request.body.policy;
      if (policy === undefined) return await reply.code(400).send({ error: "policy is required" });
      workspaceAccess.savePolicy(policy);
      return workspaceAccessSettings(workspaceAccess);
    } catch (error) {
      return await reply.code(workspaceAccessErrorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function workspaceAccessSettings(workspaceAccess: WorkspaceAccessController): WorkspaceAccessSettingsResponse {
  return {
    enabled: workspaceAccess.isEnabled(),
    provider: workspaceAccess.provider(),
    path: workspaceAccess.policyPath(),
    exists: workspaceAccess.policyExists(),
    policy: workspaceAccess.currentPolicy(),
  };
}

function workspaceAccessPublicSettings(workspaceAccess: WorkspaceAccessController): WorkspaceAccessPublicResponse {
  return workspaceAccess.publicAuthSettings();
}
