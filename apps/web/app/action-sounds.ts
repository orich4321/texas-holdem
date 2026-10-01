export type ActionSound = 'check' | 'fold' | 'chips' | 'turn';

let context: AudioContext | undefined;
let noiseBuffer: AudioBuffer | undefined;
let chipRecording: AudioBuffer | undefined;
let chipRecordingLoad: Promise<void> | undefined;

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
    if (current.state === 'running') void loadChipRecording(current);
    return current.state === 'running';
  } catch {
    return false;
  }
}

function loadChipRecording(current: AudioContext): Promise<void> {
  if (chipRecording) return Promise.resolve();
  if (!chipRecordingLoad) {
    chipRecordingLoad = globalThis.fetch('/sounds/poker-chips.mp3', { cache: 'force-cache' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Chip recording unavailable');
        chipRecording = await current.decodeAudioData(await response.arrayBuffer());
      })
      .catch(() => { chipRecordingLoad = undefined; });
  }
  return chipRecordingLoad;
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

function playChips(current: AudioContext, start: number, own: boolean): void {
  if (!chipRecording) {
    const requestedAt = performance.now();
    void loadChipRecording(current).then(() => {
      // A just-loaded clip may still match this action; never play it seconds late.
      if (chipRecording && performance.now() - requestedAt < 600 && current.state === 'running' && document.visibilityState === 'visible') {
        playChips(current, current.currentTime + 0.005, own);
      }
    });
    return;
  }
  const source = current.createBufferSource();
  const level = current.createGain();
  source.buffer = chipRecording;
  level.gain.value = own ? 0.09 : 0.35;
  source.connect(level).connect(current.destination);
  source.start(start);
}

function scheduleSound(current: AudioContext, action: ActionSound, own: boolean): void {
  const now = current.currentTime + 0.005;
  if (action === 'turn') {
    // A restrained two-tap alert stands apart from ordinary table sounds.
    tone(current, 523, now, 0.14, 0.085, 'sine');
    tone(current, 659, now + 0.15, 0.18, 0.08, 'sine');
  } else if (action === 'chips') {
    playChips(current, now, own);
  } else if (action === 'fold') {
    // Folding has a lower, firmer card toss than the light check swipe.
    filteredNoise(current, now, 0.19, own ? 0.018 : 0.075, 2400, 650, 'bandpass');
    filteredNoise(current, now + 0.15, 0.06, own ? 0.009 : 0.032, 700, 420, 'lowpass');
  } else {
    // A light swipe for checking, kept especially quiet for your own action.
    filteredNoise(current, now, 0.12, own ? 0.012 : 0.05, 900, 3000, 'bandpass');
  }
}

/** Short table cues; no sound is queued before the player's first gesture. */
export function playActionSound(action: ActionSound, own = false): void {
  try {
    const current = context;
    if (!current || current.state === 'closed') return;
    if (current.state === 'running') scheduleSound(current, action, own);
    else void current.resume().then(() => {
      if (current.state === 'running' && document.visibilityState === 'visible') scheduleSound(current, action, own);
    }).catch(() => undefined);
  } catch {
    // Unsupported audio devices never affect game actions.
  }
}
