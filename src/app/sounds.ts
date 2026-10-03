import type { AppliedMove } from "../core/chess/position";

// Move sounds synthesised with the Web Audio API, so no audio files ship with the app: a soft
// knock for a move, a sharper one for a capture, two notes for check and a low pair for castling.
// The audio context is created on the first sound (after a user gesture, as browsers require).

export type SoundKind = "move" | "capture" | "check" | "castle";

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    return null;
  }
  if (!context) {
    try {
      context = new Ctor();
    } catch {
      return null;
    }
  }
  if (context.state === "suspended") {
    void context.resume().catch(() => undefined);
  }
  return context;
}

function knock(ctx: AudioContext, at: number, frequency: number, duration: number, gain: number, type: OscillatorType = "triangle") {
  const oscillator = ctx.createOscillator();
  const envelope = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, at);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, frequency * 0.55), at + duration);
  envelope.gain.setValueAtTime(0.0001, at);
  envelope.gain.exponentialRampToValueAtTime(gain, at + 0.006);
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(envelope).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.02);
}

/** The sound a move makes. */
export function soundFor(move: Pick<AppliedMove, "captured" | "check" | "castle">): SoundKind {
  if (move.check) {
    return "check";
  }
  if (move.castle) {
    return "castle";
  }
  return move.captured ? "capture" : "move";
}

/** Plays a sound at `volume` (0..1). Silent where Web Audio is unavailable. */
export function playSound(kind: SoundKind, volume: number): void {
  if (volume <= 0) {
    return;
  }
  const ctx = audio();
  if (!ctx) {
    return;
  }
  const now = ctx.currentTime + 0.005;
  const level = 0.35 * Math.min(1, Math.max(0, volume));
  switch (kind) {
    case "move":
      knock(ctx, now, 420, 0.09, level);
      break;
    case "capture":
      knock(ctx, now, 620, 0.07, level * 1.1, "square");
      knock(ctx, now + 0.03, 300, 0.1, level * 0.8);
      break;
    case "check":
      knock(ctx, now, 660, 0.09, level);
      knock(ctx, now + 0.1, 880, 0.12, level * 0.9);
      break;
    case "castle":
      knock(ctx, now, 360, 0.08, level);
      knock(ctx, now + 0.09, 300, 0.1, level * 0.9);
      break;
  }
}
