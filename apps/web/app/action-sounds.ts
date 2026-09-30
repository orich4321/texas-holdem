type ActionSound = 'check' | 'call' | 'fold' | 'bet' | 'raise' | 'all-in' | 'turn';

let context: AudioContext | undefined;

function audio(): AudioContext | undefined {
  if (typeof window === 'undefined' || !window.AudioContext) return undefined;
  if (!context || context.state === 'closed') context = new window.AudioContext();
  return context;
}

/** iOS otherwise routes Web Audio through a session muted by the Silent switch. */
function choosePlaybackSession(): void {
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
  } catch {
    // Browsers without the Audio Session API still support ordinary Web Audio.
  }
}

/** Call from a real tap/click so mobile browsers can authorize later cues. */
export async function unlockActionAudio(): Promise<boolean> {
  try {
    choosePlaybackSession();
    const current = audio();
    if (!current) return false;
    if (current.state !== 'running') await current.resume();
    return current.state === 'running';
  } catch {
    return false;
  }
}

export function actionAudioIsReady(): boolean {
  return context?.state === 'running';
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

function scheduleSound(current: AudioContext, action: ActionSound): void {
  const now = current.currentTime;
  if (action === 'turn') {
    tone(current, 660, now, 0.13, 0.18, 'sine');
    tone(current, 880, now + 0.13, 0.18, 0.15, 'sine');
  } else if (action === 'check') tone(current, 540, now, 0.1, 0.17, 'sine');
  else if (action === 'fold') tone(current, 240, now, 0.14, 0.13, 'triangle');
  else if (action === 'call') {
    tone(current, 620, now, 0.085, 0.16, 'triangle');
    tone(current, 830, now + 0.09, 0.1, 0.14, 'triangle');
  } else {
    const notes = action === 'all-in' ? [420, 600, 850] : action === 'raise' ? [520, 760] : [600, 790];
    notes.forEach((frequency, index) => tone(current, frequency, now + index * 0.08, 0.12, 0.15, 'triangle'));
  }
}

/** Short felt-and-chips cues; no sound is queued before the player's first gesture. */
export function playActionSound(action: ActionSound): void {
  try {
    const current = context;
    if (!current || current.state === 'closed') return;
    if (current.state === 'running') scheduleSound(current, action);
    else void current.resume().then(() => {
      if (current.state === 'running' && document.visibilityState === 'visible') scheduleSound(current, action);
    }).catch(() => undefined);
  } catch {
    // Unsupported audio devices never affect game actions.
  }
}
