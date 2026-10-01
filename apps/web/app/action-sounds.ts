export type ActionSound = 'own-action' | 'chips' | 'cards' | 'turn';

let context: AudioContext | undefined;
let noiseBuffer: AudioBuffer | undefined;

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

function noise(current: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === current.sampleRate) return noiseBuffer;
  const buffer = current.createBuffer(1, Math.ceil(current.sampleRate * 0.4), current.sampleRate);
  const samples = buffer.getChannelData(0);
  // Deterministic texture for UI audio only; game cards use the server's CSPRNG.
  let seed = 123456789;
  for (let index = 0; index < samples.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    samples[index] = (seed / 2147483648) * 0.75;
  }
  noiseBuffer = buffer;
  return buffer;
}

function filteredNoise(current: AudioContext, start: number, duration: number, volume: number, frequency: number, endFrequency: number, type: BiquadFilterType): void {
  const source = current.createBufferSource();
  const filter = current.createBiquadFilter();
  const envelope = current.createGain();
  source.buffer = noise(current);
  filter.type = type;
  filter.Q.value = type === 'bandpass' ? 0.65 : 0.9;
  filter.frequency.setValueAtTime(frequency, start);
  filter.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.linearRampToValueAtTime(volume, start + Math.min(0.025, duration * 0.3));
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  source.connect(filter).connect(envelope).connect(current.destination);
  source.start(start);
  source.stop(start + duration);
}

function tone(current: AudioContext, frequency: number, start: number, duration: number, volume: number, shape: OscillatorType): void {
  const oscillator = current.createOscillator();
  const envelope = current.createGain();
  oscillator.type = shape;
  oscillator.frequency.setValueAtTime(frequency, start);
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(volume, start + 0.006);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(envelope).connect(current.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.01);
}

function scheduleSound(current: AudioContext, action: ActionSound): void {
  const now = current.currentTime + 0.005;
  if (action === 'turn') {
    // A restrained two-tap alert stands apart from ordinary table sounds.
    tone(current, 523, now, 0.14, 0.085, 'sine');
    tone(current, 659, now + 0.15, 0.18, 0.08, 'sine');
  } else if (action === 'own-action') {
    // Your own tap should acknowledge the action without competing with the turn alert.
    filteredNoise(current, now, 0.045, 0.012, 1200, 850, 'lowpass');
  } else if (action === 'chips') {
    // Three dry, slightly staggered ceramic chip clicks.
    for (const [index, pitch] of [740, 890, 680].entries()) {
      const clickAt = now + index * 0.052;
      filteredNoise(current, clickAt, 0.032, 0.045, 2600, 1700, 'bandpass');
      tone(current, pitch, clickAt, 0.055, 0.025, 'triangle');
    }
  } else {
    // A quick card sliding across felt, followed by a soft landing.
    filteredNoise(current, now, 0.16, 0.055, 900, 3400, 'bandpass');
    filteredNoise(current, now + 0.115, 0.04, 0.02, 1300, 900, 'lowpass');
  }
}

/** Short table cues; no sound is queued before the player's first gesture. */
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
