import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from "node:os";
import type { FastifyInstance } from "fastify";
import type { SystemResourceSnapshot } from "../shared/apiTypes.js";

interface CpuTimesSnapshot {
  idle: number;
  total: number;
}

interface IoCounters {
  readBytes: number;
  writeBytes: number;
}

interface NetworkCounters {
  rxBytes: number;
  txBytes: number;
}

const execFileAsync = promisify(execFile);

let previousCpu: CpuTimesSnapshot | undefined;
let previousIo: IoCounters | undefined;
let previousNetwork: NetworkCounters | undefined;
let previousAt: number | undefined;

export function registerSystemResourceRoutes(app: FastifyInstance, prefix: string): void {
  app.get(`${prefix}/system/resources`, async (): Promise<SystemResourceSnapshot> => collectSystemResources());
}

async function collectSystemResources(): Promise<SystemResourceSnapshot> {
  const sampledAt = Date.now();
  const cpuList = cpus();
  const cpuModel = cpuList[0]?.model;
  const cpuSnapshot = currentCpuTimes(cpuList);
  const ioCounters = await readIoCounters();
  const networkCounters = await readNetworkCounters();
  const elapsedSeconds = previousAt === undefined ? undefined : Math.max(0.001, (sampledAt - previousAt) / 1000);
  const memoryTotal = totalmem();
  const memoryFree = freemem();
  const memoryUsed = Math.max(0, memoryTotal - memoryFree);

  const snapshot: SystemResourceSnapshot = {
    hostname: hostname(),
    platform: platform(),
    sampledAt: new Date(sampledAt).toISOString(),
    uptimeSeconds: uptime(),
    cpu: {
      cores: cpuList.length,
      ...(cpuModel === undefined ? {} : { model: cpuModel }),
      usagePercent: previousCpu === undefined ? null : cpuUsagePercent(previousCpu, cpuSnapshot),
      loadAverage: loadavg(),
    },
    memory: {
      totalBytes: memoryTotal,
      usedBytes: memoryUsed,
      freeBytes: memoryFree,
      usagePercent: percentage(memoryUsed, memoryTotal),
    },
    storage: await readStorageUsage(),
    diskIo: {
      ...ioCounters,
      readBytesPerSecond: rate(previousIo?.readBytes, ioCounters.readBytes, elapsedSeconds),
      writeBytesPerSecond: rate(previousIo?.writeBytes, ioCounters.writeBytes, elapsedSeconds),
    },
    network: {
      ...networkCounters,
      rxBytesPerSecond: rate(previousNetwork?.rxBytes, networkCounters.rxBytes, elapsedSeconds),
      txBytesPerSecond: rate(previousNetwork?.txBytes, networkCounters.txBytes, elapsedSeconds),
    },
  };

  previousCpu = cpuSnapshot;
  previousIo = ioCounters;
  previousNetwork = networkCounters;
  previousAt = sampledAt;
  return snapshot;
}

function currentCpuTimes(cpuList = cpus()): CpuTimesSnapshot {
  return cpuList.reduce<CpuTimesSnapshot>((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((inner, value) => inner + value, 0);
    return { idle: sum.idle + cpu.times.idle, total: sum.total + total };
  }, { idle: 0, total: 0 });
}

function cpuUsagePercent(previous: CpuTimesSnapshot, current: CpuTimesSnapshot): number {
  const idle = current.idle - previous.idle;
  const total = current.total - previous.total;
  return percentage(Math.max(0, total - idle), total);
}

async function readStorageUsage(): Promise<SystemResourceSnapshot["storage"]> {
  try {
    const mounts = await readMounts();
    const entries = await Promise.all(mounts.map(async (mount) => {
      try {
        const stats = await statfs(mount.mountPoint);
        const totalBytes = stats.blocks * stats.bsize;
        const availableBytes = stats.bavail * stats.bsize;
        const usedBytes = Math.max(0, totalBytes - availableBytes);
        return {
          mountPoint: mount.mountPoint,
          filesystem: mount.filesystem,
          totalBytes,
          usedBytes,
          availableBytes,
          usagePercent: percentage(usedBytes, totalBytes),
        };
      } catch {
        return undefined;
      }
    }));
    return entries.filter((entry): entry is SystemResourceSnapshot["storage"][number] => entry !== undefined)
      .sort((left, right) => left.mountPoint.localeCompare(right.mountPoint));
  } catch {
    return [];
  }
}

async function readMounts(): Promise<{ filesystem: string; mountPoint: string; type: string }[]> {
  const mounts = platform() === "linux" ? await readLinuxMounts() : await readPortableMounts();
  const unique = new Map<string, { filesystem: string; mountPoint: string; type: string }>();
  for (const mount of mounts) unique.set(mount.mountPoint, mount);
  return [...unique.values()];
}

async function readLinuxMounts(): Promise<{ filesystem: string; mountPoint: string; type: string }[]> {
  const content = await readFile("/proc/mounts", "utf8");
  return content.split("\n").flatMap((line) => {
    const [filesystem, mountPoint, type] = line.split(" ");
    if (filesystem === undefined || mountPoint === undefined || type === undefined) return [];
    if (isVirtualFilesystem(type, mountPoint)) return [];
    return [{ filesystem, mountPoint: unescapeMountPath(mountPoint), type }];
  });
}

async function readPortableMounts(): Promise<{ filesystem: string; mountPoint: string; type: string }[]> {
  try {
    const { stdout } = await execFileAsync("df", ["-kP"]);
    return stdout.split("\n").slice(1).flatMap((line) => {
      const match = /^(\S+)\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/u.exec(line.trim());
      if (match === null) return [];
      const [, filesystem, mountPoint] = match;
      if (filesystem === undefined || mountPoint === undefined) return [];
      if (isVirtualFilesystem("", mountPoint)) return [];
      return [{ filesystem, mountPoint, type: "" }];
    });
  } catch {
    return [];
  }
}

function isVirtualFilesystem(type: string, mountPoint: string): boolean {
  if (["proc", "sysfs", "devtmpfs", "devpts", "securityfs", "cgroup", "cgroup2", "pstore", "bpf", "tracefs", "debugfs", "configfs", "fusectl", "mqueue", "hugetlbfs", "autofs", "rpc_pipefs"].includes(type)) return true;
  if (mountPoint.startsWith("/proc") || mountPoint.startsWith("/sys") || mountPoint.startsWith("/run") || mountPoint.startsWith("/dev")) return true;
  return false;
}

function unescapeMountPath(value: string): string {
  return value.replace(/\\040/g, " ");
}

async function readIoCounters(): Promise<IoCounters> {
  try {
    const content = await readFile("/proc/diskstats", "utf8");
    return content.split("\n").reduce<IoCounters>((sum, line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 14) return sum;
      const name = parts[2] ?? "";
      if (isVirtualBlockDevice(name)) return sum;
      const readSectors = Number(parts[5] ?? 0);
      const writeSectors = Number(parts[9] ?? 0);
      if (!Number.isFinite(readSectors) || !Number.isFinite(writeSectors)) return sum;
      return { readBytes: sum.readBytes + readSectors * 512, writeBytes: sum.writeBytes + writeSectors * 512 };
    }, { readBytes: 0, writeBytes: 0 });
  } catch {
    return { readBytes: 0, writeBytes: 0 };
  }
}

function isVirtualBlockDevice(name: string): boolean {
  return /^(loop|ram|zram)\d+$/u.test(name);
}

async function readNetworkCounters(): Promise<NetworkCounters> {
  if (platform() === "linux") return readLinuxNetworkCounters();
  return readPortableNetworkCounters();
}

async function readLinuxNetworkCounters(): Promise<NetworkCounters> {
  try {
    const content = await readFile("/proc/net/dev", "utf8");
    return content.split("\n").slice(2).reduce<NetworkCounters>((sum, line) => {
      const [ifaceRaw, dataRaw] = line.split(":");
      const iface = ifaceRaw?.trim();
      if (iface === undefined || iface === "" || iface === "lo" || dataRaw === undefined) return sum;
      const parts = dataRaw.trim().split(/\s+/);
      const rxBytes = Number(parts[0] ?? 0);
      const txBytes = Number(parts[8] ?? 0);
      if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) return sum;
      return { rxBytes: sum.rxBytes + rxBytes, txBytes: sum.txBytes + txBytes };
    }, { rxBytes: 0, txBytes: 0 });
  } catch {
    return { rxBytes: 0, txBytes: 0 };
  }
}

async function readPortableNetworkCounters(): Promise<NetworkCounters> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ibn"]);
    const seen = new Set<string>();
    return stdout.split("\n").slice(1).reduce<NetworkCounters>((sum, line) => {
      const parts = line.trim().split(/\s+/);
      const iface = parts[0];
      if (iface === undefined || iface === "" || iface === "lo0" || seen.has(iface)) return sum;
      const rxBytes = Number(parts[6] ?? 0);
      const txBytes = Number(parts[9] ?? 0);
      if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) return sum;
      seen.add(iface);
      return { rxBytes: sum.rxBytes + rxBytes, txBytes: sum.txBytes + txBytes };
    }, { rxBytes: 0, txBytes: 0 });
  } catch {
    return { rxBytes: 0, txBytes: 0 };
  }
}

function rate(previous: number | undefined, current: number, elapsedSeconds: number | undefined): number | null {
  if (previous === undefined || elapsedSeconds === undefined) return null;
  return Math.max(0, (current - previous) / elapsedSeconds);
}

function percentage(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (used / total) * 100));
}
