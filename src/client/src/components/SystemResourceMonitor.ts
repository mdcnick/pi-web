import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { systemApi, type SystemResourceSnapshot } from "../api";

const RESOURCE_POLL_MS = 2_000;

@customElement("system-resource-monitor")
export class SystemResourceMonitor extends LitElement {
  @property() machineId = "local";
  @state() private snapshot: SystemResourceSnapshot | undefined;
  @state() private error = "";
  private pollTimer: number | undefined;
  private refreshSeq = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    this.startPolling();
  }

  override disconnectedCallback(): void {
    this.stopPolling();
    super.disconnectedCallback();
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("machineId")) this.startPolling();
  }

  private startPolling(): void {
    this.stopPolling();
    void this.refresh();
    this.pollTimer = window.setInterval(() => { void this.refresh(); }, RESOURCE_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.refreshSeq += 1;
  }

  private async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    try {
      const snapshot = await systemApi.resources(this.machineId);
      if (seq !== this.refreshSeq) return;
      this.snapshot = snapshot;
      this.error = "";
    } catch (error) {
      if (seq !== this.refreshSeq) return;
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  override render() {
    const snapshot = this.snapshot;
    return html`
      <section class="resource-monitor">
        <header class="monitor-header">
          <div>
            <strong>System Resources</strong>
            <small>${snapshot === undefined ? "Loading live metrics…" : `${snapshot.hostname} · ${snapshot.platform} · ${formatUptime(snapshot.uptimeSeconds)} up`}</small>
          </div>
          <button @click=${() => { void this.refresh(); }}>Refresh</button>
        </header>
        ${this.error === "" ? nothing : html`<p class="error-line">${this.error}</p>`}
        ${snapshot === undefined ? html`<p class="muted">Waiting for the first sample. CPU and throughput rates appear after the second sample.</p>` : this.renderSnapshot(snapshot)}
      </section>
    `;
  }

  private renderSnapshot(snapshot: SystemResourceSnapshot) {
    const load = snapshot.cpu.loadAverage.map((value) => value.toFixed(2)).join(" · ");
    return html`
      <div class="cards">
        ${this.renderMeterCard("CPU", snapshot.cpu.usagePercent, snapshot.cpu.usagePercent === null ? "warming up" : `${formatPercent(snapshot.cpu.usagePercent)} busy`, `${String(snapshot.cpu.cores)} cores · load ${load}`)}
        ${this.renderMeterCard("Memory", snapshot.memory.usagePercent, `${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)}`, `${formatBytes(snapshot.memory.freeBytes)} free`)}
        ${this.renderRateCard("Disk I/O", formatRate(snapshot.diskIo.readBytesPerSecond), formatRate(snapshot.diskIo.writeBytesPerSecond), "read", "write")}
        ${this.renderRateCard("Network", formatRate(snapshot.network.rxBytesPerSecond), formatRate(snapshot.network.txBytesPerSecond), "down", "up")}
      </div>
      <section class="storage-section">
        <div class="section-title"><strong>Storage</strong><small>${snapshot.storage.length === 0 ? "No filesystem data available" : `${String(snapshot.storage.length)} mounts`}</small></div>
        <div class="storage-list">
          ${snapshot.storage.map((entry) => html`
            <article class="storage-row">
              <div class="row-top"><strong>${entry.mountPoint}</strong><span>${formatPercent(entry.usagePercent)}</span></div>
              <div class="meter"><span style=${`width:${String(clampPercent(entry.usagePercent))}%`}></span></div>
              <div class="row-bottom"><span>${entry.filesystem}</span><span>${formatBytes(entry.usedBytes)} / ${formatBytes(entry.totalBytes)} · ${formatBytes(entry.availableBytes)} free</span></div>
            </article>
          `)}
        </div>
      </section>
      <p class="timestamp">Live sample: ${new Date(snapshot.sampledAt).toLocaleTimeString()}</p>
    `;
  }

  private renderMeterCard(title: string, percent: number | null, value: string, detail: string) {
    return html`
      <article class="card">
        <div class="card-title"><strong>${title}</strong><span>${percent === null ? "—" : formatPercent(percent)}</span></div>
        <div class="meter"><span style=${`width:${String(percent === null ? 0 : clampPercent(percent))}%`}></span></div>
        <p>${value}</p>
        <small>${detail}</small>
      </article>
    `;
  }

  private renderRateCard(title: string, first: string, second: string, firstLabel: string, secondLabel: string) {
    return html`
      <article class="card rate-card">
        <div class="card-title"><strong>${title}</strong></div>
        <div class="rates"><span><b>${first}</b><small>${firstLabel}</small></span><span><b>${second}</b><small>${secondLabel}</small></span></div>
      </article>
    `;
  }

  static override styles = css`
    :host { display: block; height: 100%; min-height: 0; color: var(--pi-text); }
    .resource-monitor { box-sizing: border-box; height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 12px; padding: 12px; overflow: auto; }
    .monitor-header, .section-title, .card-title, .row-top, .row-bottom { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
    .monitor-header small, .section-title small, .card small, .row-bottom, .timestamp, .muted { color: var(--pi-muted); }
    .monitor-header > div { min-width: 0; display: grid; gap: 2px; }
    .monitor-header small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
    .card, .storage-row { border: 1px solid var(--pi-border-muted); border-radius: 10px; background: var(--pi-surface); padding: 10px; box-shadow: 0 8px 20px color-mix(in srgb, var(--pi-shadow) 40%, transparent); }
    .card { display: grid; gap: 8px; }
    .card p { margin: 0; }
    .meter { height: 8px; overflow: hidden; border-radius: 999px; background: color-mix(in srgb, var(--pi-border) 50%, transparent); }
    .meter span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--pi-accent), var(--pi-success)); transition: width .25s ease; }
    .rates { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .rates span { display: grid; gap: 2px; border: 1px solid var(--pi-border-muted); border-radius: 8px; padding: 8px; background: var(--pi-bg); }
    .rates b { font-size: 16px; }
    .storage-section { display: grid; gap: 8px; min-height: 0; }
    .storage-list { display: grid; gap: 8px; }
    .storage-row { display: grid; gap: 7px; }
    .row-top strong, .row-bottom span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-bottom { font-size: 12px; }
    .error-line { margin: 0; border: 1px solid var(--pi-danger); border-radius: 8px; background: color-mix(in srgb, var(--pi-danger) 10%, var(--pi-surface)); color: var(--pi-danger); padding: 8px; }
    .timestamp, .muted { margin: 0; }
  `;
}

function formatPercent(value: number): string {
  return `${Math.round(value).toString()}%`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = value;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled >= 10 || index === 0 ? Math.round(scaled).toString() : scaled.toFixed(1)} ${units[index] ?? "B"}`;
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${formatBytes(value)}/s`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}
