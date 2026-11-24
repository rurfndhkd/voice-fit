package com.voicefit.app;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.NoiseSuppressor;
import android.os.SystemClock;
import java.io.ByteArrayOutputStream;

/** Bounded, in-memory PCM capture. Never blanks phonemes or persists recordings. */
final class UtteranceRecorder {
    interface Events { void ready(); void level(float level, boolean speech); }
    private volatile boolean cancelled;
    private volatile boolean stopped;
    void cancel() { cancelled = true; stopped = true; }
    void stop() { stopped = true; }

    @android.annotation.SuppressLint("MissingPermission")
    byte[] record(Context context, int waitMs, int maxMs, int silenceMs, Events events) throws Exception {
        final int rate = 16000, frame = 320;
        int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) throw new IllegalStateException("audio-format");
        AudioRecord audio = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, frame * 16));
        NoiseSuppressor ns = null;
        ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        byte[] preRoll = new byte[rate * 2 / 2]; // 500ms before onset preserves soft first syllables
        int prePos = 0, preCount = 0;
        try {
            if (audio.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("audio-init");
            MicRoute.apply(context, audio);
            if (NoiseSuppressor.isAvailable()) {
                try { ns = NoiseSuppressor.create(audio.getAudioSessionId()); if (ns != null) ns.setEnabled(true); }
                catch (Exception ignored) { }
            }
            if (cancelled) return null;
            audio.startRecording();
            if (audio.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IllegalStateException("audio-start");
            events.ready();
            long start = SystemClock.elapsedRealtime(), onset = 0, lastVoice = start, lastEvent = 0;
            double floor = 0.001;
            int above = 0, voicedFrames = 0;
            short[] buf = new short[frame];
            while (!stopped) {
                int n = audio.read(buf, 0, frame);
                if (n <= 0) throw new IllegalStateException("audio-read");
                long now = SystemClock.elapsedRealtime();
                double sum = 0;
                byte[] chunk = new byte[n * 2];
                for (int i = 0; i < n; i++) {
                    double v = buf[i] / 32768.0; sum += v * v;
                    chunk[i * 2] = (byte) buf[i]; chunk[i * 2 + 1] = (byte) (buf[i] >> 8);
                }
                double rms = Math.sqrt(sum / n);
                double threshold = Math.max(0.0025, Math.min(0.025, floor * 2.8));
                boolean speech = rms >= threshold;
                if (!speech) floor = floor * 0.98 + rms * 0.02;
                above = speech ? above + 1 : 0;
                if (onset == 0) {
                    for (byte b : chunk) { preRoll[prePos] = b; prePos = (prePos + 1) % preRoll.length; preCount = Math.min(preRoll.length, preCount + 1); }
                    if (above >= 3) {
                        onset = now; lastVoice = now;
                        for (int i = 0; i < preCount; i++) pcm.write(preRoll[(prePos - preCount + preRoll.length + i) % preRoll.length]);
                    }
                } else {
                    pcm.write(chunk);
                }
                if (speech && onset != 0) { lastVoice = now; voicedFrames++; }
                if (now - lastEvent >= 100) {
                    lastEvent = now;
                    events.level(VoicePrint.level(buf, n), speech && onset != 0);
                }
                if (onset == 0 && now - start >= waitMs) break;
                if (onset != 0 && (now - lastVoice >= silenceMs || now - onset >= maxMs)) break;
            }
            if (cancelled || onset == 0 || voicedFrames < 3) return null;
            return wav(pcm.toByteArray(), rate);
        } finally {
            try { audio.stop(); } catch (Exception ignored) { }
            if (ns != null) ns.release();
            audio.release();
            MicRoute.release(context);
        }
    }

    private static byte[] wav(byte[] pcm, int rate) {
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(44 + pcm.length).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        b.put(new byte[]{'R','I','F','F'}).putInt(36 + pcm.length).put(new byte[]{'W','A','V','E','f','m','t',' '});
        b.putInt(16).putShort((short)1).putShort((short)1).putInt(rate).putInt(rate * 2).putShort((short)2).putShort((short)16);
        b.put(new byte[]{'d','a','t','a'}).putInt(pcm.length).put(pcm);
        return b.array();
    }
}
