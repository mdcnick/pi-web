import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AuthStorage, ModelRegistry, type AuthStorageBackend } from "@earendil-works/pi-coding-agent";

export interface SharedProviderAuthPaths {
  authPath: string;
  modelsPath?: string;
}

interface LockResult<T> {
  result: T;
  next?: string;
}

const DIR_MODE = 0o770;
const FILE_MODE = 0o660;
const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_SHARED_PROVIDER_AUTH_DIRS = ["/opt/pi-web/provider-auth", "/var/tmp/pi-web-provider-auth"] as const;

export function resolveSharedProviderAuthPaths(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): SharedProviderAuthPaths | undefined {
  const authPath = env["PI_WEB_MODEL_AUTH_PATH"];
  const modelsPath = env["PI_WEB_MODEL_REGISTRY_PATH"];
  const providerAuthDir = env["PI_WEB_PROVIDER_AUTH_DIR"];

  if (authPath !== undefined && authPath !== "") {
    return {
      authPath: resolve(cwd, authPath),
      ...(modelsPath !== undefined && modelsPath !== "" ? { modelsPath: resolve(cwd, modelsPath) } : {}),
    };
  }

  if (providerAuthDir === undefined || providerAuthDir === "") {
    return env["PI_WEB_DISABLE_SHARED_PROVIDER_AUTH_DEFAULTS"] === "1" ? undefined : resolveExistingDefaultSharedProviderAuth();
  }

  const resolvedDir = resolve(cwd, providerAuthDir);
  return {
    authPath: join(resolvedDir, "auth.json"),
    modelsPath: modelsPath !== undefined && modelsPath !== "" ? resolve(cwd, modelsPath) : join(resolvedDir, "models.json"),
  };
}

function resolveExistingDefaultSharedProviderAuth(): SharedProviderAuthPaths | undefined {
  for (const dir of DEFAULT_SHARED_PROVIDER_AUTH_DIRS) {
    const authPath = join(dir, "auth.json");
    if (existsSync(authPath)) return { authPath, modelsPath: join(dir, "models.json") };
  }
  return undefined;
}

export function createSharedProviderModelRegistry(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ModelRegistry | undefined {
  const paths = resolveSharedProviderAuthPaths(env, cwd);
  if (paths === undefined) return undefined;

  const authStorage = AuthStorage.fromStorage(new SharedProviderAuthStorageBackend(paths.authPath));
  return ModelRegistry.create(authStorage, paths.modelsPath);
}

class SharedProviderAuthStorageBackend implements AuthStorageBackend {
  private readonly lockPath: string;

  constructor(private readonly authPath: string) {
    this.lockPath = `${authPath}.lock`;
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    this.ensureParentDir();
    this.ensureFileExists();
    const release = this.acquireLock();
    try {
      const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf8") : undefined;
      const { result, next } = fn(current);
      if (next !== undefined) this.writeAuthFile(next);
      return result;
    } finally {
      release();
    }
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    this.ensureParentDir();
    this.ensureFileExists();
    const release = this.acquireLock();
    try {
      const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf8") : undefined;
      const { result, next } = await fn(current);
      if (next !== undefined) this.writeAuthFile(next);
      return result;
    } finally {
      release();
    }
  }

  private ensureParentDir(): void {
    mkdirSync(dirname(this.authPath), { recursive: true, mode: DIR_MODE });
    this.tryChmod(dirname(this.authPath), DIR_MODE);
  }

  private ensureFileExists(): void {
    if (existsSync(this.authPath)) {
      this.tryChmod(this.authPath, FILE_MODE);
      return;
    }

    try {
      writeFileSync(this.authPath, "{}", { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    } catch (error) {
      if (!this.isNodeError(error, "EEXIST")) throw error;
    }
    this.tryChmod(this.authPath, FILE_MODE);
  }

  private writeAuthFile(next: string): void {
    writeFileSync(this.authPath, next, { encoding: "utf8", mode: FILE_MODE });
    this.tryChmod(this.authPath, FILE_MODE);
  }

  private acquireLock(): () => void {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        mkdirSync(this.lockPath, { mode: DIR_MODE });
        this.tryChmod(this.lockPath, DIR_MODE);
        return () => { rmSync(this.lockPath, { recursive: true, force: true }); };
      } catch (error) {
        if (!this.isNodeError(error, "EEXIST")) throw error;
        this.removeStaleLock();
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for shared provider auth lock: ${this.lockPath}`, { cause: error });
        this.sleepSync(20);
      }
    }
  }

  private removeStaleLock(): void {
    try {
      const ageMs = Date.now() - statSync(this.lockPath).mtimeMs;
      if (ageMs > LOCK_STALE_MS) rmSync(this.lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!this.isNodeError(error, "ENOENT")) throw error;
    }
  }

  private sleepSync(ms: number): void {
    const start = Date.now();
    while (Date.now() - start < ms) {
      // Short synchronous wait keeps AuthStorage's sync contract without adding a runtime dependency.
    }
  }

  private tryChmod(path: string, mode: number): void {
    try {
      chmodSync(path, mode);
    } catch (error) {
      if (!this.isNodeError(error, "EPERM") && !this.isNodeError(error, "EACCES")) throw error;
    }
  }

  private isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && String(error.code) === code;
  }
}
