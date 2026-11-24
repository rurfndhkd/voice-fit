package com.voicefit.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.NoiseSuppressor;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;

import androidx.core.content.ContextCompat;

import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 걸러 듣는 음성 인식기.
 *
 * [직접 듣기 모드] (안드로이드 13+, 기기 음성인식이 지원할 때)
 *   앱이 마이크를 직접 열어(소음 억제 켬) 20ms 단위로 소리를 받고,
 *   - 주변 소리 배제: 기준보다 작은 소리는 무음으로 바꾼다
 *   - 내 목소리만: 등록된 목소리 지문과 다른 소리 구간은 무음으로 바꾼다
 *   걸러진 소리만 음성 인식에 넘긴다 → 음성 인식은 내 목소리만 듣는다.
 *   또 말소리가 시작되는 순간(약 0.05~0.16초)을 바로 알려 카운트를 빠르게 올린다.
 *
 * [기본 모드] (직접 듣기를 지원하지 않는 기기)
 *   기기 음성인식이 마이크를 직접 쓰고, 음량 정보로만 말소리 시작을 감지한다.
 */
public class GatedRecognizer {
    private static final String TAG = "VoiceFitGate";

    public interface Callback {
        void onReady();
        void onLevel(float level);
        /** 말소리 하나가 확인됨 (카운트 +1 용). 내 목소리만 모드면 확인된 뒤에만 온다 */
        void onBurst();
        void onPartial(ArrayList<String> alternatives);
        void onFinal(ArrayList<String> alternatives);
        void onError(String code);
        /** 한 번의 듣기가 끝남 (결과든 오류든 항상 마지막에 1번) */
        void onEnd();
    }

    public static class Options {
        public String language = "ko-KR";
        public int silenceMs = 1500;
        public int minLengthMs = 0;
        public boolean preferOffline = false;
        public boolean gateEnabled = false;
        public float gateLevel = 5f;
        public boolean voiceLock = false;
        public boolean bursts = false;
        /** 직전 듣기가 끝난 뒤 들어온 소리(최대 1초)를 이번 듣기 앞에 이어 붙인다 — 카운트 중 다시 시작하는 틈에 놓치는 숫자 방지 */
        public boolean keepBacklog = false;
        /**
         * 내 목소리가 이 시간(ms) 동안 들리지 않으면 그때까지 한 말로 바로 끝낸다 (0 = 끄기).
         * 주변 소리·다른 사람 목소리가 계속 나도, '내 목소리'가 멈춘 것을 기준으로 한다.
         */
        public int endSilenceMs = 0;
    }

    /** 이 기기에서 직접 듣기 모드가 안 되는 것으로 판명되면 이후 기본 모드만 쓴다 */
    static volatile boolean captureUnsupported = false;

    private static final int LOOKAHEAD_FRAMES = 9; // 180ms: 목소리 판정이 날 때까지 소리를 잠깐 붙잡아 둔다

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private Callback cb;
    private Options opt = new Options();
    private boolean sessionActive = false;
    private boolean sessionCapture = false;
    private long sessionStartedAt = 0;
    private boolean gotReady = false;

    // 직접 듣기
    private AudioRecord record;
    private NoiseSuppressor suppressor;
    private Thread captureThread;
    private Thread writerThread;
    // 음성 인식으로 보낼 소리 (마이크 읽기가 쓰기 때문에 멈추지 않도록 따로 보낸다. 가득 차면 버림)
    private final ArrayBlockingQueue<byte[]> outQueue = new ArrayBlockingQueue<>(50); // 최대 1초
    private volatile boolean capturing = false;
    private volatile OutputStream pipeOut;
    private ParcelFileDescriptor pipeRead;
    private final BurstDetector detector = new BurstDetector();
    private VoicePrint.Profile profile;

    // 현재 말소리 구간 (내 목소리 판정용)
    private static final class Segment {
        final List<float[]> feats = new ArrayList<>();
        final List<Float> pitches = new ArrayList<>();
        int decided = 0; // 0 미정, 1 내 목소리, -1 아님
    }
    private Segment segment;
    private static final class Frame { short[] pcm; boolean voiced; Segment seg; }
    private final ArrayDeque<Frame> queue = new ArrayDeque<>();
    private long lastLevelAt = 0;
    // 내 목소리 기준 끝내기
    private volatile long lastUserVoiceAt = 0;
    private volatile boolean heardUser = false;
    private volatile boolean endRequested = false;

    public GatedRecognizer(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    public boolean isSessionActive() { return sessionActive; }
    public boolean usingCapture() { return sessionCapture; }

    public void setProfile(VoicePrint.Profile p) { this.profile = p; }

    private boolean canCapture() {
        return !captureUnsupported && Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /** 듣기 시작 (메인 스레드에서 호출) */
    public void start(Options o, Callback callback) {
        cancelSessionQuietly();
        this.opt = o;
        this.cb = callback;
        detector.gateEnabled = o.gateEnabled;
        detector.gateLevel = o.gateLevel;
        sessionCapture = canCapture();
        try {
            if (recognizer == null) recognizer = SpeechRecognizer.createSpeechRecognizer(ctx);
            recognizer.setRecognitionListener(new Listener());
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, o.language);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, o.language);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, (long) o.silenceMs);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, (long) o.silenceMs);
            if (o.minLengthMs > 0) intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, (long) o.minLengthMs);
            if (o.preferOffline) intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);

            if (sessionCapture) {
                ensureCapture();
                if (!o.keepBacklog) outQueue.clear();
                ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
                pipeRead = pipe[0];
                pipeOut = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]);
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0]);
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, VoicePrint.SAMPLE_RATE);
            } else {
                stopCaptureLater();
            }
            sessionActive = true;
            gotReady = false;
            heardUser = false;
            endRequested = false;
            lastUserVoiceAt = 0;
            sessionStartedAt = SystemClock.elapsedRealtime();
            recognizer.startListening(intent);
            if (sessionCapture) {
                // 기기 음성인식이 앱이 넘긴 소리를 받지 않으면(지원 안 함) 기본 모드로 전환
                main.postDelayed(captureWatchdog, 2500);
            }
        } catch (Exception e) {
            Log.w(TAG, "start failed", e);
            if (sessionCapture) captureUnsupported = true;
            endSession("start-failed");
        }
    }

    private final Runnable captureWatchdog = () -> {
        if (sessionActive && sessionCapture && !gotReady) {
            Log.w(TAG, "기기 음성인식이 앱 오디오를 받지 않음 → 기본 모드로 전환");
            captureUnsupported = true;
            cancel();
        }
    };

    /** 지금까지 들은 것으로 최종 결과를 받는다 */
    public void stop() {
        try { if (recognizer != null && sessionActive) recognizer.stopListening(); } catch (Exception ignored) { }
        closePipe();
    }

    /** 결과 없이 바로 끝낸다 */
    public void cancel() {
        try { if (recognizer != null) recognizer.cancel(); } catch (Exception ignored) { }
        endSession(null);
    }

    public void destroy() {
        cancelSessionQuietly();
        stopCapture();
        try { if (recognizer != null) recognizer.destroy(); } catch (Exception ignored) { }
        recognizer = null;
    }

    private void cancelSessionQuietly() {
        if (!sessionActive) return;
        try { if (recognizer != null) recognizer.cancel(); } catch (Exception ignored) { }
        sessionActive = false;
        closePipe();
        if (cb != null) cb.onEnd();
    }

    private void endSession(String errorCode) {
        main.removeCallbacks(captureWatchdog);
        closePipe();
        if (!sessionActive) return;
        sessionActive = false;
        if (errorCode != null && cb != null) cb.onError(errorCode);
        if (cb != null) cb.onEnd();
        stopCaptureLater();
    }

    private void closePipe() {
        OutputStream o = pipeOut;
        pipeOut = null;
        if (o != null) { try { o.close(); } catch (IOException ignored) { } }
        if (pipeRead != null) { try { pipeRead.close(); } catch (IOException ignored) { } pipeRead = null; }
    }

    /* ---------------- 직접 듣기 (마이크 → 거르기 → 음성 인식) ---------------- */
    private final Runnable stopCaptureRunnable = this::stopCapture;

    /** 듣기가 이어지는 동안에는 마이크를 계속 열어 둔다 (다시 시작할 때 놓치는 소리를 없애기 위해) */
    private void stopCaptureLater() {
        main.removeCallbacks(stopCaptureRunnable);
        main.postDelayed(stopCaptureRunnable, 1500);
    }

    @android.annotation.SuppressLint("MissingPermission")
    private void ensureCapture() {
        main.removeCallbacks(stopCaptureRunnable);
        if (capturing) return;
        int minBuf = AudioRecord.getMinBufferSize(VoicePrint.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        record = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, VoicePrint.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuf, VoicePrint.FRAME * 2 * 8));
        MicRoute.apply(ctx, record); // 설정에서 고른 마이크(이어폰·헤드셋)로
        if (NoiseSuppressor.isAvailable()) {
            try { suppressor = NoiseSuppressor.create(record.getAudioSessionId()); if (suppressor != null) suppressor.setEnabled(true); } catch (Exception ignored) { }
        }
        record.startRecording();
        capturing = true;
        queue.clear();
        segment = null;
        outQueue.clear();
        captureThread = new Thread(this::captureLoop, "voicefit-capture");
        captureThread.start();
        writerThread = new Thread(this::writerLoop, "voicefit-writer");
        writerThread.start();
    }

    private void stopCapture() {
        capturing = false;
        if (captureThread != null) { try { captureThread.join(300); } catch (InterruptedException ignored) { } captureThread = null; }
        if (writerThread != null) { writerThread.interrupt(); writerThread = null; }
        outQueue.clear();
        if (record != null) { try { record.stop(); } catch (Exception ignored) { } record.release(); record = null; }
        if (suppressor != null) { try { suppressor.release(); } catch (Exception ignored) { } suppressor = null; }
        MicRoute.release(ctx);
    }

    private void captureLoop() {
        short[] buf = new short[VoicePrint.FRAME];
        final byte[] silence = new byte[VoicePrint.FRAME * 2];
        while (capturing) {
            int n = record.read(buf, 0, VoicePrint.FRAME);
            if (n <= 0) continue;
            long t = SystemClock.elapsedRealtime();
            float level = VoicePrint.level(buf, n);
            postLevel(level, t);

            int ev = detector.feed(level, t);
            Frame f = new Frame();
            f.pcm = buf.clone();
            if (ev == BurstDetector.ONSET) {
                segment = new Segment();
                // 시작이 감지되기 전 40ms 도 같은 말소리로 묶는다
                int back = 0;
                for (java.util.Iterator<Frame> it = queue.descendingIterator(); it.hasNext() && back < 3; back++) {
                    Frame q = it.next(); q.voiced = true; q.seg = segment;
                }
                if (!opt.voiceLock || profile == null) { segment.decided = 1; emitBurst(); }
            }
            f.voiced = detector.isVoiced();
            if (f.voiced && segment != null) {
                f.seg = segment;
                if (segment.decided == 0) {
                    segment.feats.add(VoicePrint.mfcc(f.pcm));
                    segment.pitches.add(VoicePrint.pitch(f.pcm));
                    if (segment.feats.size() >= 8) decide(segment); // 160ms 들어 보고 판정
                }
            }
            if (ev == BurstDetector.END && segment != null) {
                if (segment.decided == 0) {
                    if (segment.feats.size() >= 4) decide(segment); else segment.decided = -1; // 너무 짧은 '딱' 소리는 제외
                }
                segment = null;
            }

            // 판정이 날 때까지 잠깐 붙잡았다가 음성 인식으로 넘긴다
            queue.addLast(f);
            int hold = (opt.gateEnabled || opt.voiceLock) ? LOOKAHEAD_FRAMES : 0;
            while (queue.size() > hold) {
                Frame out = queue.pollFirst();
                boolean pass;
                if (!opt.gateEnabled && !opt.voiceLock) pass = true;
                else if (!out.voiced) pass = false;
                else if (opt.voiceLock && profile != null && out.seg != null) pass = out.seg.decided != -1;
                else pass = true;
                // 내 목소리로 판정된 말소리 (걸러 듣기를 안 쓰면 말소리 전체)
                boolean userVoice = out.voiced && (!opt.voiceLock || profile == null || out.seg == null || out.seg.decided == 1);
                if (userVoice) { lastUserVoiceAt = SystemClock.elapsedRealtime(); heardUser = true; }
                checkEndSilence();
                {
                    byte[] chunk;
                    if (pass) {
                        chunk = new byte[VoicePrint.FRAME * 2];
                        for (int i = 0; i < VoicePrint.FRAME; i++) { chunk[2 * i] = (byte) out.pcm[i]; chunk[2 * i + 1] = (byte) (out.pcm[i] >> 8); }
                    } else {
                        chunk = silence;
                    }
                    // 듣기 사이 틈에도 계속 쌓아 두고(가득 차면 오래된 것부터 버림), 다음 듣기가 시작되면 이어서 보낸다
                    if (!outQueue.offer(chunk)) { outQueue.poll(); outQueue.offer(chunk); }
                }
            }
        }
    }

    private void writerLoop() {
        while (capturing) {
            try {
                OutputStream o = pipeOut;
                if (o == null) { Thread.sleep(10); continue; } // 받을 곳이 생길 때까지 쌓인 소리를 그대로 둔다
                byte[] chunk = outQueue.poll(200, TimeUnit.MILLISECONDS);
                if (chunk == null) continue;
                o.write(chunk);
            } catch (InterruptedException e) {
                return;
            } catch (IOException e) {
                pipeOut = null; // 음성 인식이 끝나 받는 쪽이 닫힘
            }
        }
    }

    /** 내 목소리가 endSilenceMs 동안 없으면 지금까지 들은 것으로 마무리 */
    private void checkEndSilence() {
        if (opt.endSilenceMs <= 0 || !heardUser || endRequested || !sessionActive) return;
        if (SystemClock.elapsedRealtime() - lastUserVoiceAt >= opt.endSilenceMs) {
            endRequested = true;
            main.post(() -> { if (sessionActive) stop(); });
        }
    }

    private void decide(Segment s) {
        float sc = profile.score(s.feats, s.pitches);
        s.decided = sc >= profile.threshold ? 1 : -1;
        if (s.decided == 1) emitBurst();
    }

    private void emitBurst() {
        if (!opt.bursts) return;
        main.post(() -> { if (cb != null && sessionActive) cb.onBurst(); });
    }

    private void postLevel(float level, long t) {
        if (t - lastLevelAt < 100) return;
        lastLevelAt = t;
        main.post(() -> { if (cb != null && sessionActive) cb.onLevel(level); });
    }

    /* ---------------- 기기 음성인식 결과 ---------------- */
    private class Listener implements RecognitionListener {
        @Override public void onReadyForSpeech(Bundle params) { gotReady = true; if (cb != null) cb.onReady(); }
        @Override public void onBeginningOfSpeech() { }
        @Override public void onBufferReceived(byte[] buffer) { }
        @Override public void onEndOfSpeech() { }
        @Override public void onEvent(int eventType, Bundle params) { }

        @Override
        public void onRmsChanged(float rmsdB) {
            if (sessionCapture) return; // 직접 듣기 모드에서는 우리 계산값을 쓴다
            long t = SystemClock.elapsedRealtime();
            if (t - lastLevelAt >= 100) { lastLevelAt = t; if (cb != null) cb.onLevel(rmsdB); }
            if (detector.feed(rmsdB, t) == BurstDetector.ONSET && opt.bursts && cb != null) cb.onBurst();
            if (detector.isVoiced()) { lastUserVoiceAt = t; heardUser = true; }
            checkEndSilence();
        }

        @Override
        public void onPartialResults(Bundle b) {
            ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (list != null && !list.isEmpty() && cb != null) cb.onPartial(list);
        }

        @Override
        public void onResults(Bundle b) {
            ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (cb != null) cb.onFinal(list == null ? new ArrayList<>() : list);
            endSession(null);
        }

        @Override
        public void onError(int error) {
            String code;
            switch (error) {
                case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: code = "no-speech"; break;
                case SpeechRecognizer.ERROR_NO_MATCH: code = "no-match"; break;
                case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: code = "busy"; break;
                case SpeechRecognizer.ERROR_NETWORK:
                case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                case SpeechRecognizer.ERROR_SERVER: code = "network"; break;
                case SpeechRecognizer.ERROR_AUDIO: code = "audio"; break;
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: code = "permission"; break;
                case SpeechRecognizer.ERROR_CLIENT: code = "client"; break;
                case 12: case 13: code = "language"; break;
                default: code = "other";
            }
            // 직접 듣기 모드에서 바로 실패하면 이 기기는 앱 오디오를 지원하지 않는 것으로 본다
            if (sessionCapture && !gotReady && SystemClock.elapsedRealtime() - sessionStartedAt < 2500
                && !code.equals("no-speech") && !code.equals("no-match")) {
                Log.w(TAG, "직접 듣기 모드 실패(" + code + ") → 기본 모드로 전환");
                captureUnsupported = true;
            }
            if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY || error == SpeechRecognizer.ERROR_CLIENT) {
                try { recognizer.destroy(); } catch (Exception ignored) { }
                recognizer = null;
            }
            endSession(code);
        }
    }
}
