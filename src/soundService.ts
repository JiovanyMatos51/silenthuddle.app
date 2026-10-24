export type SoundEffect =
  | "call-join"
  | "call-leave"
  | "message"
  | "channel-join"
  | "channel-leave"
  | "call-start"
  | "toggle-on"
  | "toggle-off";

interface ToneStep {
  frequency: number;
  duration: number;
  delay?: number;
  volume?: number;
  wave?: OscillatorType;
}

const PATTERNS: Record<SoundEffect, ToneStep[]> = {
  "call-join": [
    { frequency: 392, duration: 0.09, volume: 0.08 },
    { frequency: 523.25, duration: 0.11, delay: 0.065, volume: 0.08 },
    { frequency: 659.25, duration: 0.16, delay: 0.14, volume: 0.07 },
  ],
  "call-leave": [
    { frequency: 659.25, duration: 0.09, volume: 0.075 },
    { frequency: 493.88, duration: 0.11, delay: 0.07, volume: 0.075 },
    { frequency: 349.23, duration: 0.16, delay: 0.15, volume: 0.065 },
  ],
  message: [
    { frequency: 880, duration: 0.075, volume: 0.055, wave: "sine" },
    { frequency: 1174.66, duration: 0.12, delay: 0.055, volume: 0.045, wave: "sine" },
  ],
  "channel-join": [
    { frequency: 293.66, duration: 0.08, volume: 0.055, wave: "triangle" },
    { frequency: 440, duration: 0.13, delay: 0.06, volume: 0.06, wave: "triangle" },
  ],
  "channel-leave": [
    { frequency: 440, duration: 0.08, volume: 0.055, wave: "triangle" },
    { frequency: 261.63, duration: 0.14, delay: 0.065, volume: 0.05, wave: "triangle" },
  ],
  "call-start": [
    { frequency: 523.25, duration: 0.1, volume: 0.065 },
    { frequency: 659.25, duration: 0.1, delay: 0.085, volume: 0.065 },
    { frequency: 783.99, duration: 0.2, delay: 0.17, volume: 0.07 },
  ],
  "toggle-on": [
    { frequency: 520, duration: 0.055, volume: 0.04, wave: "square" },
    { frequency: 720, duration: 0.07, delay: 0.04, volume: 0.035, wave: "square" },
  ],
  "toggle-off": [
    { frequency: 620, duration: 0.055, volume: 0.04, wave: "square" },
    { frequency: 390, duration: 0.08, delay: 0.04, volume: 0.035, wave: "square" },
  ],
};

/** Efeitos curtos sintetizados localmente. Não dependem de arquivos externos,
 * rede ou licenças de terceiros. */
export class SoundService {
  private context: AudioContext | null = null;

  async unlock(): Promise<void> {
    const context = this.getContext();
    if (context.state === "suspended") await context.resume();
  }

  async play(effect: SoundEffect): Promise<void> {
    try {
      const context = this.getContext();
      if (context.state === "suspended") await context.resume();
      const start = context.currentTime + 0.01;
      for (const step of PATTERNS[effect]) this.scheduleTone(context, start, step);
    } catch (error) {
      // Áudio de interface nunca deve impedir o fluxo principal do app.
      console.debug("Não foi possível reproduzir o efeito sonoro", error);
    }
  }

  private getContext(): AudioContext {
    this.context ??= new AudioContext();
    return this.context;
  }

  private scheduleTone(context: AudioContext, baseTime: number, step: ToneStep): void {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startsAt = baseTime + (step.delay ?? 0);
    const endsAt = startsAt + step.duration;

    oscillator.type = step.wave ?? "sine";
    oscillator.frequency.setValueAtTime(step.frequency, startsAt);
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(step.volume ?? 0.06, startsAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startsAt);
    oscillator.stop(endsAt + 0.015);
  }
}
