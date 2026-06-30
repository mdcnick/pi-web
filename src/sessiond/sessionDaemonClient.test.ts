import { describe, expect, it } from "vitest";
import { PerUserSessionDaemonClient, type WorkspaceOwnerLookup } from "./sessionDaemonClient";

class FakeDaemon {
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  constructor(readonly label: string) {}

  request(method: string, path: string, body?: unknown): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    this.requests.push({ method, path, body });
    return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ daemon: this.label }) });
  }

  connectWebSocket(): never {
    throw new Error("not used");
  }
}

describe("PerUserSessionDaemonClient", () => {
  it("uses the fallback daemon for the current user's workspace", async () => {
    const fallback = new FakeDaemon("nick");
    const client = new PerUserSessionDaemonClient({
      fallback,
      currentUid: 1000,
      lookup: lookup({ "/home/nick/project": 1000 }, { 1000: "/home/nick" }),
    });

    const response = await client.request("GET", "/sessions?cwd=/home/nick/project");

    expect(JSON.parse(response.body)).toEqual({ daemon: "nick" });
    expect(fallback.requests).toEqual([{ method: "GET", path: "/sessions?cwd=/home/nick/project", body: undefined }]);
  });

  it("routes another user's workspace to that user's session daemon socket", async () => {
    const fallback = new FakeDaemon("nick");
    const will = new FakeDaemon("will");
    const client = new PerUserSessionDaemonClient({
      fallback,
      currentUid: 1000,
      lookup: lookup({ "/home/will/central-workspace": 1001 }, { 1001: "/home/will" }),
      socketForHome: (home) => `${home}/.pi-web/sessiond.sock`,
      clientForSocket: (socketPath) => {
        if (socketPath === "/home/will/.pi-web/sessiond.sock") return will;
        throw new Error(`Unexpected socket path: ${socketPath}`);
      },
    });

    const response = await client.request("POST", "/sessions", { cwd: "/home/will/central-workspace" });

    expect(JSON.parse(response.body)).toEqual({ daemon: "will" });
    expect(fallback.requests).toEqual([]);
    expect(will.requests).toEqual([{ method: "POST", path: "/sessions", body: { cwd: "/home/will/central-workspace" } }]);
  });

  it("keeps admin requests on the fallback daemon when no cwd is present", async () => {
    const fallback = new FakeDaemon("nick");
    const client = new PerUserSessionDaemonClient({
      fallback,
      currentUid: 1000,
      lookup: lookup({}, {}),
    });

    const response = await client.request("GET", "/runtime");

    expect(JSON.parse(response.body)).toEqual({ daemon: "nick" });
  });
});

function lookup(paths: Record<string, number>, homes: Record<number, string>): WorkspaceOwnerLookup {
  return {
    uidForPath(path) {
      return Promise.resolve(paths[path]);
    },
    homeForUid(uid) {
      return Promise.resolve(homes[uid]);
    },
  };
}
