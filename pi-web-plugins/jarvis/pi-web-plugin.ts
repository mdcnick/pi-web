import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

interface JarvisCommandResponse {
  text: string;
  speak?: boolean;
  mode?: string;
  needsApproval?: boolean;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionResultEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

let draft = "Brief me on this workspace";
let lastResponse = "Jarvis is ready.";
let busy = false;
let listening = false;
let recognition: SpeechRecognitionLike | undefined;

const plugin: PiWebPlugin = {
  apiVersion: 1,
  name: "Jarvis",
  activate: ({ pluginId, html, svg }) => ({
    contributions: {
      actions: [
        {
          id: "jarvis.open",
          title: "Open Jarvis",
          description: "Open the lightweight Jarvis voice panel.",
          group: "Jarvis",
          enabled: (context) => context.state.selectedWorkspace !== undefined,
          run: (context) => {
            if (context.state.selectedWorkspace === undefined) return;
            context.selectWorkspaceTool(`${pluginId}:jarvis.panel`);
          },
        },
        {
          id: "jarvis.speak-brief",
          title: "Jarvis: Speak Workspace Brief",
          description: "Ask Jarvis to brief the selected workspace and speak the response.",
          group: "Jarvis",
          enabled: (context) => context.state.selectedWorkspace !== undefined,
          run: async (context) => {
            if (context.state.selectedWorkspace === undefined) return;
            await sendJarvisCommand("Brief me on this workspace", context.state.selectedWorkspace.path, () => context.refreshAppData());
          },
        },
      ],
      workspacePanels: [
        {
          id: "jarvis.panel",
          title: "Jarvis",
          icon: svg`
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"></path>
              <path d="M19 10v1a7 7 0 0 1-14 0v-1"></path>
              <path d="M12 18v3"></path>
              <path d="M8 21h8"></path>
            </svg>
          `,
          order: 15,
          badge: () => listening ? "listening" : busy ? "thinking" : undefined,
          render: (context) => html`
            <section class="toolbar"><strong>Jarvis</strong><span class="muted">lightweight voice</span></section>
            <section class="viewer">
              <p class="muted">Selected workspace</p>
              <p><code>${context.workspace.path}</code></p>
              <label class="field-label" for="jarvis-command-input">Command</label>
              <textarea
                id="jarvis-command-input"
                rows="3"
                .value=${draft}
                @input=${(event: Event) => { draft = inputValue(event); }}
                placeholder="Ask Jarvis for a brief..."
                style="width:100%;box-sizing:border-box;border:1px solid var(--pi-border);border-radius:10px;background:var(--pi-bg);color:var(--pi-text);padding:10px;"
              ></textarea>
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
                <button @click=${async () => { await sendJarvisCommand(draft, context.workspace.path, () => { context.host.requestRender(); }); }} ?disabled=${busy}>Speak response</button>
                <button @click=${() => { toggleListening(context.workspace.path, () => { context.host.requestRender(); }); }} ?disabled=${busy || !speechRecognitionAvailable()}>${listening ? "Stop listening" : "Listen"}</button>
                <button @click=${() => { speak(lastResponse); }} ?disabled=${lastResponse === ""}>Repeat</button>
              </div>
              ${speechRecognitionAvailable() ? null : html`<p class="muted">Speech recognition is not available in this browser. You can still type commands and Jarvis will speak back.</p>`}
              <hr style="border:none;border-top:1px solid var(--pi-border);margin:16px 0;" />
              <p class="muted">Jarvis says</p>
              <p>${lastResponse}</p>
            </section>
          `,
        },
      ],
    },
  }),
};

async function sendJarvisCommand(text: string, cwd: string, afterUpdate: () => void | Promise<void>): Promise<void> {
  const command = text.trim();
  if (command === "") return;
  busy = true;
  lastResponse = "One moment.";
  await afterUpdate();
  try {
    const jarvis = localJarvisResponse(command, cwd);
    lastResponse = jarvis.text;
    if (jarvis.speak !== false) speak(jarvis.text);
  } catch (error) {
    lastResponse = `Jarvis error: ${error instanceof Error ? error.message : String(error)}`;
    speak(lastResponse);
  } finally {
    busy = false;
    await afterUpdate();
  }
}

function toggleListening(cwd: string, afterUpdate: () => void | Promise<void>): void {
  if (listening) {
    recognition?.stop();
    listening = false;
    void afterUpdate();
    return;
  }

  const Recognition = speechRecognitionConstructor();
  if (Recognition === undefined) return;
  recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-US";
  recognition.onresult = (event) => {
    const transcript = event.results[0]?.[0]?.transcript.trim() ?? "";
    if (transcript !== "") {
      draft = transcript;
      void sendJarvisCommand(transcript, cwd, afterUpdate);
    }
  };
  recognition.onerror = (event) => {
    lastResponse = `Jarvis listening error: ${event.error ?? "unknown error"}`;
    listening = false;
    void afterUpdate();
  };
  recognition.onend = () => {
    listening = false;
    void afterUpdate();
  };
  listening = true;
  recognition.start();
  void afterUpdate();
}

function speak(text: string): void {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

function speechRecognitionAvailable(): boolean {
  return speechRecognitionConstructor() !== undefined;
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

function localJarvisResponse(command: string, cwd: string): JarvisCommandResponse {
  const normalized = command.toLowerCase();
  if (["spawn", "worker", "agent", "run command", "install", "deploy", "delete", "secret"].some((term) => normalized.includes(term))) {
    return {
      mode: "blocked",
      speak: true,
      needsApproval: true,
      text: "That sounds like an action command. I am not running action commands from voice yet. The next step is the Jarvis approval queue.",
    };
  }
  if (["help", "commands", "what can you do"].some((term) => normalized.includes(term))) {
    return {
      mode: "help",
      speak: true,
      text: "Jarvis can speak lightweight workspace briefings and take typed or spoken notes. Server-backed action commands will come after the public plugin API supports them safely.",
    };
  }
  return {
    mode: "brief",
    speak: true,
    text: `Selected workspace: ${cwd}. Jarvis voice is online. Server-backed workspace summaries are disabled until plugins have a public request API.`,
  };
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLTextAreaElement ? event.target.value : "";
}

export default plugin;
