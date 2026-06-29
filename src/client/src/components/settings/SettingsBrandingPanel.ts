import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";

interface BrandingDraft {
  siteName: string;
  siteTitle: string;
  siteShortName: string;
  description: string;
  logoUrl: string;
  faviconUrl: string;
  appleTouchIconUrl: string;
}

@customElement("settings-branding-panel")
export class SettingsBrandingPanel extends LitElement {
  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() savedMessage = "";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (config: PiWebConfigValues) => void | Promise<void>;
  @state() private draft: BrandingDraft = emptyBrandingDraft();
  @state() private localError = "";

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("configResponse") && this.configResponse !== undefined) {
      this.draft = brandingDraftFromConfig(this.configResponse.config);
    }
  }

  override render(): TemplateResult {
    const config = this.configResponse;
    return html`
      <div class="section-heading">
        <div>
          <h2>Branding</h2>
          <p>Adjust the site name, titles, metadata, and branded image URLs used by the UI.</p>
        </div>
        <button class="secondary" ?disabled=${this.loading} @click=${() => { void this.onReload?.(); }}>Reload</button>
      </div>
      ${this.renderMessages()}
      ${config === undefined && this.loading ? html`<div class="loading-card">Loading configuration…</div>` : html`
        <form class="config-form" @submit=${(event: Event) => { void this.saveConfig(event); }}>
          <label class="field">
            <span>Site name</span>
            <input .value=${this.draft.siteName} placeholder="PI WEB" autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateDraft({ siteName: inputValue(event) }); }}>
            <small>The short site label used across navigation and titles when not set.</small>
          </label>

          <label class="field">
            <span>Site title</span>
            <input .value=${this.draft.siteTitle} placeholder="pi-web" autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateDraft({ siteTitle: inputValue(event) }); }}>
            <small>Browser/tab title used in the document head.</small>
          </label>

          <label class="field">
            <span>Short name</span>
            <input .value=${this.draft.siteShortName} placeholder="PI WEB" autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateDraft({ siteShortName: inputValue(event) }); }}>
            <small>Compact name used in compact UI contexts.</small>
          </label>

          <label class="field">
            <span>App description</span>
            <textarea .value=${this.draft.description} rows="3" placeholder="Remote web UI and browser control plane for persistent Pi Coding Agent sessions." spellcheck="false" @input=${(event: Event) => { this.updateDraft({ description: textAreaValue(event) }); }}></textarea>
            <small>Used for metadata and manifests.</small>
          </label>

          <label class="field">
            <span>Logo URL</span>
            <input .value=${this.draft.logoUrl} placeholder="/logo.svg" autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateDraft({ logoUrl: inputValue(event) }); }}>
            <small>Optional URL for top-bar branding.</small>
          </label>

          <label class="field">
            <span>Favicon URL</span>
            <input .value=${this.draft.faviconUrl} placeholder="/favicon.svg" autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateDraft({ faviconUrl: inputValue(event) }); }}>
            <small>Defaults to <code>/favicon.svg</code> when unset.</small>
          </label>

          <label class="field">
            <span>Apple touch icon URL</span>
            <input .value=${this.draft.appleTouchIconUrl} placeholder="/apple-touch-icon.png" autocomplete="off" spellcheck="false" @input=${(event: Event) => { this.updateDraft({ appleTouchIconUrl: inputValue(event) }); }}>
            <small>Defaults to <code>/apple-touch-icon.png</code> when unset.</small>
          </label>

          <footer class="form-actions">
            <button class="primary" ?disabled=${this.loading || this.saving}>${this.saving ? "Saving…" : "Save branding"}</button>
          </footer>
        </form>
      `}
    `;
  }

  private renderMessages(): TemplateResult | null {
    const error = this.localError || this.error;
    if (error !== "") return html`<div class="message error-message">${error}</div>`;
    if (this.savedMessage !== "") return html`<div class="message success-message">${this.savedMessage}</div>`;
    return null;
  }

  private async saveConfig(event: Event): Promise<void> {
    event.preventDefault();
    this.localError = "";
    try {
      const branding = brandingFromDraft(this.draft);
      await this.onSave?.(branding === undefined ? {} : { branding });
    } catch (error) {
      this.localError = errorMessage(error);
    }
  }

  private updateDraft(patch: Partial<BrandingDraft>): void {
    this.draft = { ...this.draft, ...patch };
    this.localError = "";
  }

  static override styles = css`
    :host { display: block; }
    .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .section-heading > div { display: grid; gap: 6px; min-width: 0; }
    h2, p { margin: 0; }
    h2 { font-size: 17px; line-height: 1.25; }
    p { color: var(--pi-muted); line-height: 1.45; }
    button, input, textarea { font: inherit; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .secondary { flex: 0 0 auto; }
    .message, .loading-card { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; margin-bottom: 12px; }
    .message { margin-bottom: 12px; }
    .error-message { border-color: var(--pi-danger); color: var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 10%, var(--pi-surface)); }
    .success-message { border-color: var(--pi-success-border); color: var(--pi-success); background: var(--pi-success-surface); }
    .loading-card { color: var(--pi-muted); }
    .config-form { display: grid; gap: 14px; }
    .field { display: grid; gap: 7px; }
    input, textarea { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 9px 10px; outline: none; }
    input:focus, textarea:focus { border-color: var(--pi-accent); box-shadow: 0 0 0 1px var(--pi-accent-border); }
    textarea { resize: vertical; min-height: 72px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .field small { color: var(--pi-muted); }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .form-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 2px; }
    .primary { border-color: var(--pi-accent); background: var(--pi-selection-bg); color: var(--pi-text-bright); }
  `;
}

function brandingDraftFromConfig(config: PiWebConfigValues): BrandingDraft {
  const branding = config.branding ?? {};
  return {
    siteName: branding.siteName ?? "",
    siteTitle: branding.siteTitle ?? "",
    siteShortName: branding.siteShortName ?? "",
    description: branding.description ?? "",
    logoUrl: branding.logoUrl ?? "",
    faviconUrl: branding.faviconUrl ?? "",
    appleTouchIconUrl: branding.appleTouchIconUrl ?? "",
  };
}

function brandingFromDraft(draft: BrandingDraft): NonNullable<PiWebConfigValues["branding"]> | undefined {
  const output: NonNullable<PiWebConfigValues["branding"]> = {};
  if (draft.siteName.trim() !== "") output.siteName = draft.siteName.trim();
  if (draft.siteTitle.trim() !== "") output.siteTitle = draft.siteTitle.trim();
  if (draft.siteShortName.trim() !== "") output.siteShortName = draft.siteShortName.trim();
  if (draft.description.trim() !== "") output.description = draft.description.trim();
  if (draft.logoUrl.trim() !== "") output.logoUrl = draft.logoUrl.trim();
  if (draft.faviconUrl.trim() !== "") output.faviconUrl = draft.faviconUrl.trim();
  if (draft.appleTouchIconUrl.trim() !== "") output.appleTouchIconUrl = draft.appleTouchIconUrl.trim();
  return Object.keys(output).length === 0 ? undefined : output;
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : "";
}

function textAreaValue(event: Event): string {
  return event.target instanceof HTMLTextAreaElement ? event.target.value : "";
}

function emptyBrandingDraft(): BrandingDraft {
  return { siteName: "", siteTitle: "", siteShortName: "", description: "", logoUrl: "", faviconUrl: "", appleTouchIconUrl: "" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
