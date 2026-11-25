import { Capacitor, registerPlugin } from "@capacitor/core";
import { Haptics } from "@capacitor/haptics";

/**
 * App-wide touch feedback (ported from the Jenix Smart Token Display app):
 * a water bubble where the finger lands, a short generated sound and a short
 * vibration, chosen per button kind. Installed once from main.tsx with a single
 * capturing document listener — screens and buttons need no changes. Sounds are
 * synthesised (no asset files), stay quiet when the phone is on silent, and both
 * sound and vibration can be switched off in Settings.
 */

export type FeedbackKind =
  | "tap"
  | "nav"
  | "toggleOn"
  | "toggleOff"
  | "confirm"
  | "close"
  | "warn"
  | "unlock"
  | "lock"
  | "success"
  | "error";

const SOUND_KEY = "jenixlock:sounds";
const HAPTIC_KEY = "jenixlock:haptics";

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}
function writeFlag(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // not persisted; still applies for this session
  }
}

export const feedbackSettings = {
  get sounds() {
    return readFlag(SOUND_KEY);
  },
  set sounds(on: boolean) {
    writeFlag(SOUND_KEY, on);
  },
  get haptics() {
    return readFlag(HAPTIC_KEY);
  },
  set haptics(on: boolean) {
    writeFlag(HAPTIC_KEY, on);
  }
};

// ---- silent mode (optional native plugin; no-ops if absent) --------------- //
const RingerMode = registerPlugin<{ get(): Promise<{ silent: boolean }> }>("RingerMode");
let phoneSilent = false;
function refreshRinger() {
  if (!Capacitor.isNativePlatform()) return;
  RingerMode.get()
    .then((r) => {
      phoneSilent = r.silent;
    })
    .catch(() => undefined);
}

// ---- sounds (Web Audio) --------------------------------------------------- //
let ctx: AudioContext | null = null;
function audio(): AudioContext {
  ctx ??= new (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}
const NOTE = { C4: 261.63, E4: 329.63, G4: 392, A3: 220, C5: 523.25, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5 };

function tone(freq: number, start: number, dur: number, opts: { type?: OscillatorType; vol?: number; glideTo?: number } = {}) {
  const a = audio();
  const t = a.currentTime + start;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t);
  if (opts.glideTo) osc.frequency.exponentialRampToValueAtTime(opts.glideTo, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(opts.vol ?? 0.1, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}
function whoosh(dur: number, vol = 0.06) {
  const a = audio();
  const t = a.currentTime;
  const n = Math.floor(a.sampleRate * dur);
  const buffer = a.createBuffer(1, n, a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < n; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = a.createBufferSource();
  const filter = a.createBiquadFilter();
  const gain = a.createGain();
  src.buffer = buffer;
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(2400, t);
  filter.frequency.exponentialRampToValueAtTime(400, t + dur);
  gain.gain.value = vol;
  src.connect(filter).connect(gain).connect(a.destination);
  src.start(t);
}

const SOUNDS: Record<FeedbackKind, () => void> = {
  tap: () => tone(NOTE.A5, 0, 0.09, { glideTo: NOTE.E5, vol: 0.09 }),
  nav: () => tone(NOTE.E5, 0, 0.12, { type: "triangle", vol: 0.08 }),
  toggleOn: () => {
    tone(NOTE.G5, 0, 0.1, { vol: 0.08 });
    tone(NOTE.C6, 0.07, 0.14, { vol: 0.08 });
  },
  toggleOff: () => {
    tone(NOTE.C6, 0, 0.1, { vol: 0.07 });
    tone(NOTE.G5, 0.07, 0.14, { vol: 0.06 });
  },
  confirm: () => [NOTE.C5, NOTE.E5, NOTE.G5].forEach((f, i) => tone(f, i * 0.05, 0.35, { vol: 0.07 })),
  close: () => whoosh(0.16),
  warn: () => {
    tone(NOTE.A3, 0, 0.16, { type: "triangle", vol: 0.1 });
    tone(NOTE.A3, 0.2, 0.2, { type: "triangle", vol: 0.08 });
  },
  unlock: () => [NOTE.C5, NOTE.G5, NOTE.C6].forEach((f, i) => tone(f, i * 0.07, 0.4, { vol: 0.08 })),
  lock: () => {
    tone(NOTE.G5, 0, 0.12, { vol: 0.08 });
    tone(NOTE.C5, 0.1, 0.22, { vol: 0.07 });
  },
  success: () => [NOTE.E5, NOTE.G5, NOTE.C6].forEach((f, i) => tone(f, i * 0.09, 0.5, { vol: 0.07 })),
  error: () => {
    tone(NOTE.E4, 0, 0.18, { type: "triangle", vol: 0.09 });
    tone(NOTE.C4, 0.16, 0.26, { type: "triangle", vol: 0.08 });
  }
};

const HAPTICS: Record<FeedbackKind, number[]> = {
  tap: [8],
  nav: [10],
  toggleOn: [14],
  toggleOff: [10],
  confirm: [18],
  close: [6],
  warn: [30, 40, 30],
  unlock: [12, 40, 20],
  lock: [20],
  success: [15, 60, 25],
  error: [40, 50, 40]
};

function vibrate(pattern: number[]) {
  let at = 0;
  pattern.forEach((ms, index) => {
    if (index % 2 === 0) {
      const duration = ms;
      setTimeout(() => {
        if (Capacitor.isNativePlatform()) void Haptics.vibrate({ duration }).catch(() => undefined);
        else navigator.vibrate?.(duration);
      }, at);
    }
    at += ms;
  });
}

/** Vibration only. */
export function hapticOnly(kind: FeedbackKind): void {
  if (feedbackSettings.haptics) vibrate(HAPTICS[kind]);
}

/** Sound + vibration for one kind of action. Never throws. */
export function feedback(kind: FeedbackKind): void {
  try {
    if (feedbackSettings.sounds && !phoneSilent) SOUNDS[kind]();
  } catch {
    // audio unavailable: silent feedback is fine
  }
  if (feedbackSettings.haptics) vibrate(HAPTICS[kind]);
}

// ---- which kind of button was pressed ------------------------------------- //
function classify(button: HTMLElement): FeedbackKind {
  const text = (button.textContent ?? "").trim().toLowerCase();
  const label = (button.getAttribute("aria-label") ?? "").toLowerCase();
  const explicit = button.getAttribute("data-fb") as FeedbackKind | null;
  if (explicit) return explicit;
  if (button.closest(".tabbar")) return "nav";
  if (button.getAttribute("role") === "switch") return button.getAttribute("aria-checked") === "true" ? "toggleOff" : "toggleOn";
  if (button.classList.contains("danger") || /delete|remove|reset|forget|unbind/.test(label + " " + text)) return "warn";
  if (button.classList.contains("sheet-close") || /^(close|cancel|back|not now)$/.test(text)) return "close";
  if (button.classList.contains("primary")) return "confirm";
  return "tap";
}

// ---- water bubble overlay ------------------------------------------------- //
let layer: HTMLDivElement | null = null;
function bubbleAt(x: number, y: number, rect: DOMRect) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "fb-bubble-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.appendChild(layer);
  }
  const size = Math.min(140, Math.max(rect.width, rect.height) * 1.3);
  const bubble = document.createElement("span");
  bubble.className = "fb-bubble";
  bubble.style.width = `${size}px`;
  bubble.style.height = `${size}px`;
  bubble.style.left = `${x - size / 2}px`;
  bubble.style.top = `${y - size / 2}px`;
  layer.appendChild(bubble);
  window.setTimeout(() => bubble.remove(), 600);
}

let installed = false;
export function installTouchFeedback(): void {
  if (installed) return;
  installed = true;
  refreshRinger();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshRinger();
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      const button = (event.target as HTMLElement | null)?.closest("button");
      if (!button || (button as HTMLButtonElement).disabled) return;
      bubbleAt(event.clientX, event.clientY, button.getBoundingClientRect());
    },
    { passive: true, capture: true }
  );
  document.addEventListener(
    "click",
    (event) => {
      const button = (event.target as HTMLElement | null)?.closest("button");
      if (!button || (button as HTMLButtonElement).disabled) return;
      feedback(classify(button));
    },
    { capture: true }
  );
}
