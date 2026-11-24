// PLAN 23: elapsed microphone silence, never transcript/network arrival time.
export const END_SILENCE_MS = 1500;

export class SpeechEndpoint {
  constructor(start, { waitMs = 30000, maxMs = 30000 } = {}) {
    Object.assign(this, { start, waitMs, maxMs, onset: null, lastVoice: null, run: null });
  }
  feed(speech, now) {
    if (speech) {
      this.run ??= now;
      // Require 60ms of activity: a single click must not extend the turn.
      if (now - this.run >= 60) {
        this.onset ??= this.run;
        this.lastVoice = now;
      }
    } else this.run = null;
    return this.onset === null
      ? now - this.start >= this.waitMs
      : (this.run === null && now - this.lastVoice >= END_SILENCE_MS) || now - this.onset >= this.maxMs;
  }
  get heard() { return this.onset !== null; }
}

// Adaptive energy gate, not speaker authentication or a trained speech classifier.
export class ActivityGate {
  floor = 0.001;
  feed(samples) {
    let sum = 0;
    for (const v of samples) sum += v * v;
    const rms = Math.sqrt(sum / samples.length);
    const active = rms >= Math.max(0.0025, Math.min(0.025, this.floor * 2.8));
    if (!active) this.floor = this.floor * 0.98 + rms * 0.02;
    return active;
  }
}
