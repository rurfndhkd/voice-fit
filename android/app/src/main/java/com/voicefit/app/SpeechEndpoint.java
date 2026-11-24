package com.voicefit.app;

/** PLAN 23: monotonic microphone timing, independent of recognition/network latency. */
final class SpeechEndpoint {
    static final int SILENCE_MS = 1500;
    private final long start;
    private final int waitMs, maxMs, silenceMs;
    private long onset = -1, lastVoice = -1, run = -1;
    SpeechEndpoint(long start, int waitMs, int maxMs, int silenceMs) {
        this.start = start; this.waitMs = waitMs; this.maxMs = maxMs; this.silenceMs = silenceMs;
    }
    boolean feed(boolean speech, long now) {
        if (speech) {
            if (run < 0) run = now;
            // Ignore isolated clicks, including clicks during the trailing silence.
            if (now - run >= 60) {
                if (onset < 0) onset = run;
                lastVoice = now;
            }
        } else run = -1;
        return onset < 0 ? now - start >= waitMs
            : (run < 0 && now - lastVoice >= silenceMs) || now - onset >= maxMs;
    }
    boolean heard() { return onset >= 0; }
    boolean voicedAt(long now) { return lastVoice == now; }
}
