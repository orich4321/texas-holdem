type ActionSound = 'check' | 'call' | 'fold' | 'bet' | 'raise' | 'all-in';

let context: AudioContext | undefined;

function audio(): AudioContext | undefined {
  if (typeof window === 'undefined' || !window.AudioContext) return undefined;
  context ??= new window.AudioContext();
  return context;
}

/** Unlock audio during a real gesture; browsers otherwise suppress playback. */
export function unlockActionAudio(): void {
  const current = audio();
  if (current?.state === 'suspended') void current.resume().catch(() => undefined);
}

function tone(current: AudioContext, frequency: number, start: number, duration: number, volume: number, shape: OscillatorType): void {
  const oscillator = current.createOscillator();
  const envelope = current.createGain();
  oscillator.type = shape;
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(80, frequency * 0.8), start + duration);
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(volume, start + 0.008);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(envelope).connect(current.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.01);
}

/** Quiet, short felt-and-chips cues without downloads or copyrighted assets. */
export function playActionSound(action: ActionSound): void {
  try {
    const current = audio();
    if (!current || current.state !== 'running') return;
    const now = current.currentTime;
    if (action === 'check') tone(current, 540, now, 0.085, 0.065, 'sine');
    else if (action === 'fold') tone(current, 240, now, 0.12, 0.045, 'triangle');
    else if (action === 'call') {
      tone(current, 620, now, 0.075, 0.055, 'triangle');
      tone(current, 830, now + 0.08, 0.09, 0.045, 'triangle');
    } else {
      const notes = action === 'all-in' ? [420, 600, 850] : action === 'raise' ? [520, 760] : [600, 790];
      notes.forEach((frequency, index) => tone(current, frequency, now + index * 0.07, 0.1, 0.05, 'triangle'));
    }
  } catch {
    // Unsupported audio devices never affect game actions.
  }
}
