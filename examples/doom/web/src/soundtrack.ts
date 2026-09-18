// Original generative score: “Parallel Afterglow”, 104 BPM in D minor.
// No samples, downloads or external audio services. One clock survives UI updates.
export interface AudioMix { music: boolean; effects: boolean; volume: number; playing: boolean; intensity: number }
const beat = 60 / 104, stepSeconds = beat / 4;
const chords = [[50, 53, 57, 60, 64], [46, 50, 53, 57, 60], [53, 57, 60, 64, 67], [48, 52, 55, 62, 67], [43, 46, 50, 53, 57], [50, 53, 57, 60, 64], [46, 50, 53, 57, 60], [45, 52, 55, 59, 61]];
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class Score {
  readonly master: GainNode;
  readonly music: GainNode;
  readonly effects: GainNode;
  private echo: DelayNode;
  private room: ConvolverNode;
  private noise: AudioBuffer;
  private seed = 7319;
  private nodes = new Set<AudioNode>();
  constructor(readonly context: BaseAudioContext) {
    const c = context;
    this.master = c.createGain(); this.master.gain.value = 0;
    this.music = c.createGain(); this.effects = c.createGain();
    const compressor = c.createDynamicsCompressor(); compressor.threshold.value = -18; compressor.knee.value = 12; compressor.ratio.value = 4; compressor.attack.value = .006; compressor.release.value = .2;
    const highpass = c.createBiquadFilter(); highpass.type = 'highpass'; highpass.frequency.value = 28;
    this.music.connect(highpass); this.effects.connect(highpass); highpass.connect(compressor); compressor.connect(this.master); this.master.connect(c.destination);
    this.echo = c.createDelay(2); this.echo.delayTime.value = beat * .75;
    const feedback = c.createGain(); feedback.gain.value = .27;
    const tone = c.createBiquadFilter(); tone.frequency.value = 2500;
    const wet = c.createGain(); wet.gain.value = .22;
    this.echo.connect(tone); tone.connect(feedback); feedback.connect(this.echo); tone.connect(wet); wet.connect(this.music);
    this.room = c.createConvolver();
    const impulse = c.createBuffer(2, Math.floor(c.sampleRate * 2.5), c.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < data.length; i++) data[i] = this.random() * (1 - i / data.length) ** 3 * .35;
    }
    this.room.buffer = impulse;
    const air = c.createGain(); air.gain.value = .25; this.room.connect(air); air.connect(this.music);
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const samples = this.noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = this.random();
  }
  private random() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 1073741823.5 - 1; }
  private voice(midi: number, time: number, duration: number, level: number, type: OscillatorType, cutoff: number, pan = 0, pad = false, destination = this.music) {
    const c = this.context, oscillator = c.createOscillator(), filter = c.createBiquadFilter(), envelope = c.createGain(), stereo = c.createStereoPanner();
    oscillator.type = type; oscillator.frequency.value = hz(midi); oscillator.detune.value = pad ? pan * 7 : 0;
    filter.type = 'lowpass'; filter.frequency.setValueAtTime(cutoff, time); filter.frequency.exponentialRampToValueAtTime(Math.max(150, cutoff * .45), time + duration);
    envelope.gain.setValueAtTime(.0001, time); envelope.gain.exponentialRampToValueAtTime(level, time + (pad ? .65 : .012));
    envelope.gain.exponentialRampToValueAtTime(.0001, time + duration);
    stereo.pan.value = pan;
    oscillator.connect(filter); filter.connect(envelope); envelope.connect(stereo); stereo.connect(destination);
    if (destination === this.music && midi >= 50) { stereo.connect(pad ? this.room : this.echo); }
    this.nodes.add(oscillator);
    oscillator.onended = () => { oscillator.disconnect(); filter.disconnect(); envelope.disconnect(); stereo.disconnect(); this.nodes.delete(oscillator); };
    oscillator.start(time); oscillator.stop(time + duration + .04);
  }
  private kick(time: number, level: number) {
    const c = this.context, source = c.createOscillator(), gain = c.createGain();
    source.frequency.setValueAtTime(135, time); source.frequency.exponentialRampToValueAtTime(43, time + .12);
    gain.gain.setValueAtTime(.0001, time); gain.gain.exponentialRampToValueAtTime(level, time + .004); gain.gain.exponentialRampToValueAtTime(.0001, time + .36);
    source.connect(gain); gain.connect(this.music); this.nodes.add(source);
    source.onended = () => { source.disconnect(); gain.disconnect(); this.nodes.delete(source); };
    source.start(time); source.stop(time + .4);
  }
  private percussion(time: number, length: number, level: number, cutoff: number, pan: number) {
    const c = this.context, source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain(), stereo = c.createStereoPanner();
    source.buffer = this.noise; filter.type = 'highpass'; filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(level, time); gain.gain.exponentialRampToValueAtTime(.0001, time + length); stereo.pan.value = pan;
    source.connect(filter); filter.connect(gain); gain.connect(stereo); stereo.connect(this.music); this.nodes.add(source);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); stereo.disconnect(); this.nodes.delete(source); };
    source.start(time, .13); source.stop(time + length + .02);
  }
  schedule(step: number, time: number, playing: boolean, intensity: number) {
    const bar = Math.floor(step / 16), position = step % 16, chord = chords[Math.floor(bar / 2) % chords.length]!;
    const energy = Math.max(0, Math.min(1, intensity));
    if (step % 32 === 0) chord.forEach((note, i) => this.voice(note, time, beat * 9, .043, 'triangle', 1300, (i - 2) * .3, true));
    if (!playing) return;
    const intro = bar % 32 < 2 ? .6 : 1;
    if ([0, 6, 8, 14].includes(position)) this.voice(chord[0]! - 12 + (position === 14 ? 12 : 0), time, beat * .8, .17 * intro, 'triangle', 440 + energy * 500);
    if ([0, 8].includes(position) || energy > .55 && position === 11) this.kick(time, .38 * intro);
    if ([4, 12].includes(position)) {
      this.percussion(time, .15, .07 * intro, 1700, -.06);
      this.voice(50, time, .09, .045 * intro, 'sine', 800);
    }
    if (position % 2 === 0 || energy > .65 && position === 15) this.percussion(time, position === 14 ? .12 : .045, position % 4 === 2 ? .034 : .018, 7500, .3);
    // A repeating motif with rests and an answering phrase every other bar.
    if (position % 4 === 2 && bar % 4 !== 3) {
      const motif = [0, 2, 3, 1, 4, 2, 1, 3], index = motif[(Math.floor(position / 4) + (bar % 2) * 4)]!;
      this.voice(chord[index]! + 12, time, beat * 1.5, .035 + energy * .025, 'sine', 3200, position < 8 ? -.25 : .25);
    }
    if (energy > .5 && position % 2 === 1) this.voice(chord[(Math.floor(position / 2) + bar) % 5]! + 12, time, .18, .014 * energy, 'triangle', 2800, -.35);
  }
  cue(kind: 'fork' | 'winner') {
    const notes = kind === 'fork' ? [74, 81] : [69, 74, 77];
    notes.forEach((note, index) => this.voice(note, this.context.currentTime + .02 + index * .085, .45, .07, 'sine', 3500, 0, false, this.effects));
  }
  get activeVoices() { return this.nodes.size; }
}

export class Soundtrack {
  readonly context = new AudioContext();
  readonly score = new Score(this.context);
  private timer?: ReturnType<typeof setInterval>;
  private sleep?: ReturnType<typeof setTimeout>;
  private next = 0;
  private step = 0;
  private energy = 0;
  private enabled = false;
  private mix: AudioMix = { music: true, effects: true, volume: .15, playing: false, intensity: 0 };
  private lastCue = -10;
  private disposed = false;
  constructor(initialStep = 0) {
    // Restart on the last musical phrase so its pad is present immediately.
    this.step = Number.isSafeInteger(initialStep) && initialStep >= 0 ? Math.floor(initialStep / 32) * 32 : 0;
  }
  get position() { return this.step; }
  update(mix: AudioMix) {
    this.mix = mix;
    const now = this.context.currentTime;
    this.score.master.gain.setTargetAtTime(this.enabled ? Math.max(0, Math.min(.4, mix.volume)) * 1.5 : 0, now, .08);
    this.score.music.gain.setTargetAtTime(mix.music ? (mix.playing ? 1 : .45) : 0, now, .7);
    this.score.effects.gain.setTargetAtTime(mix.effects ? 1 : 0, now, .08);
  }
  async setEnabled(enabled: boolean) {
    if (this.disposed) return;
    this.enabled = enabled; clearTimeout(this.sleep);
    if (enabled) {
      await this.context.resume();
      if (this.disposed || !this.enabled) return;
      this.update(this.mix);
      if (!this.timer) { this.next = this.context.currentTime + .06; this.tick(); this.timer = setInterval(() => this.tick(), 25); }
    } else {
      this.update(this.mix); clearInterval(this.timer); this.timer = undefined;
      this.sleep = setTimeout(() => { if (!this.enabled && !this.disposed) void this.context.suspend(); }, 350);
    }
  }
  private tick() {
    if (this.context.state !== 'running') return;
    if (this.next < this.context.currentTime - .2) this.next = this.context.currentTime + .04;
    while (this.next < this.context.currentTime + .12) {
      this.energy += (this.mix.intensity - this.energy) * .06;
      if (this.mix.music) this.score.schedule(this.step, this.next, this.mix.playing, this.energy);
      this.step++; this.next += stepSeconds;
    }
  }
  cue(kind: 'fork' | 'winner') {
    if (!this.enabled || !this.mix.effects || this.context.currentTime - this.lastCue < 2) return;
    this.lastCue = this.context.currentTime; this.score.cue(kind);
  }
  async dispose() { this.disposed = true; clearInterval(this.timer); clearTimeout(this.sleep); await this.context.close(); }
}
