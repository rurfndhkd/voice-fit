package com.voicefit.app;

import android.Manifest;
import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.NoiseSuppressor;
import android.os.Handler;
import android.os.Looper;
import android.speech.SpeechRecognizer;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * VOICE FIT 음성 듣기 (앱 화면에 있을 때).
 * 한 번의 듣기(start)마다 이벤트를 순서대로 보낸다:
 *   speechReady / speechLevel {level} / speechBurst (말소리 하나 확인 — 카운트 즉시 +1 용)
 *   speechPartial {text, alternatives} / speechFinal {text, alternatives}
 *   speechError {code} / speechEnd (항상 마지막에 1번)
 * 목소리 등록: enrollVoice / voiceStatus / clearVoice
 */
@CapacitorPlugin(
    name = "VoiceListener",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class VoiceListenerPlugin extends Plugin {
    static final String PREFS = "voicefit_voice";

    private final Handler main = new Handler(Looper.getMainLooper());
    private GatedRecognizer rec;
    private boolean backgrounded = false;
    private volatile boolean enrolling = false;
    private volatile UtteranceRecorder utteranceRecorder;

    /** 저장된 목소리 지문 (백그라운드 서비스도 같이 쓴다) */
    static VoicePrint.Profile loadProfile(Context ctx) {
        return VoicePrint.Profile.fromJson(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("profile", null));
    }

    @Override
    public void load() {
        rec = new GatedRecognizer(getContext());
        android.media.AudioManager am = (android.media.AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am != null) am.registerAudioDeviceCallback(deviceCallback, main);
    }

    @Override
    protected void handleOnStart() { backgrounded = false; }

    /** 앱이 가려지면 앱 안의 듣기를 멈추고 마이크를 백그라운드 서비스에 넘긴다 */
    @Override
    protected void handleOnStop() {
        // 운동 세션 중 화면만 꺼진 경우: 앱이 계속 듣는다 (포그라운드 서비스가 마이크·CPU 유지)
        if (WakeListenerService.holdsSession(getContext())) return;
        backgrounded = true;
        if (utteranceRecorder != null) utteranceRecorder.cancel();
        main.post(() -> { if (rec != null) rec.cancel(); });
    }

    @Override
    protected void handleOnDestroy() {
        if (utteranceRecorder != null) utteranceRecorder.cancel();
        android.media.AudioManager am = (android.media.AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am != null) am.unregisterAudioDeviceCallback(deviceCallback);
        main.post(() -> { if (rec != null) rec.destroy(); });
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        call.resolve(new JSObject().put("available", SpeechRecognizer.isRecognitionAvailable(getContext())));
    }

    @PluginMethod
    public void ensurePermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) call.resolve(new JSObject().put("granted", true));
        else requestPermissionForAlias("microphone", call, "onMicPermission");
    }

    @PermissionCallback
    private void onMicPermission(PluginCall call) {
        call.resolve(new JSObject().put("granted", getPermissionState("microphone") == PermissionState.GRANTED));
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (backgrounded) { call.reject("paused"); return; } // 백그라운드에서는 서비스가 듣는다
        if (enrolling || utteranceRecorder != null) { call.reject("busy"); return; }
        GatedRecognizer.Options o = new GatedRecognizer.Options();
        o.language = call.getString("language", "ko-KR");
        o.silenceMs = call.getInt("silenceMs", 1500);
        o.minLengthMs = call.getInt("minLengthMs", 0);
        o.preferOffline = Boolean.TRUE.equals(call.getBoolean("preferOffline", false));
        o.gateEnabled = Boolean.TRUE.equals(call.getBoolean("gateEnabled", false));
        o.gateLevel = call.getFloat("gateLevel", 5f);
        o.voiceLock = Boolean.TRUE.equals(call.getBoolean("voiceLock", false));
        o.bursts = Boolean.TRUE.equals(call.getBoolean("bursts", false));
        o.keepBacklog = Boolean.TRUE.equals(call.getBoolean("keepBacklog", false));
        o.endSilenceMs = call.getInt("endSilenceMs", 0);
        main.post(() -> {
            rec.setProfile(o.voiceLock ? loadProfile(getContext()) : null);
            rec.start(o, new GatedRecognizer.Callback() {
                @Override public void onReady() { notifyListeners("speechReady", new JSObject()); }
                @Override public void onLevel(float level) { notifyListeners("speechLevel", new JSObject().put("level", level)); }
                @Override public void onBurst() { notifyListeners("speechBurst", new JSObject().put("t", System.currentTimeMillis())); }
                @Override public void onPartial(ArrayList<String> alts) { notifyListeners("speechPartial", payload(alts)); }
                @Override public void onFinal(ArrayList<String> alts) { notifyListeners("speechFinal", payload(alts)); }
                @Override public void onError(String code) { notifyListeners("speechError", new JSObject().put("code", code)); }
                @Override public void onEnd() { notifyListeners("speechEnd", new JSObject()); }
            });
            call.resolve(new JSObject().put("capture", rec.usingCapture()));
        });
    }

    private JSObject payload(ArrayList<String> list) {
        JSArray alts = new JSArray();
        for (String s : list) if (s != null && !s.isEmpty()) alts.put(s);
        return new JSObject().put("text", list.isEmpty() || list.get(0) == null ? "" : list.get(0)).put("alternatives", alts);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> { if (rec != null) rec.stop(); call.resolve(); });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        main.post(() -> { if (rec != null) rec.cancel(); call.resolve(); });
    }

    /** Capture a complete utterance for cloud transcription, independent of Android ASR. */
    @PluginMethod
    public void recordUtterance(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) { call.reject("permission"); return; }
        final String id = call.getString("id", "");
        final int waitMs = Math.max(1000, Math.min(30000, call.getInt("waitMs", 10000)));
        final int maxMs = Math.max(1000, Math.min(30000, call.getInt("maxMs", 30000)));
        final int silenceMs = Math.max(800, Math.min(4000, call.getInt("silenceMs", 1800)));
        main.post(() -> {
            if (backgrounded || enrolling || utteranceRecorder != null) { call.reject("busy"); return; }
            if (rec != null) rec.destroy();
            final UtteranceRecorder capture = new UtteranceRecorder();
            utteranceRecorder = capture;
            new Thread(() -> {
                byte[] wav = null;
                Exception failure = null;
                try {
                    wav = capture.record(getContext(), waitMs, maxMs, silenceMs, new UtteranceRecorder.Events() {
                        public void ready() { notifyListeners("recordReady", new JSObject().put("id", id)); }
                        public void level(float level, boolean speech) {
                            notifyListeners("recordLevel", new JSObject().put("id", id).put("level", level).put("speech", speech));
                        }
                    });
                } catch (Exception e) { failure = e; }
                finally { if (utteranceRecorder == capture) utteranceRecorder = null; }
                if (failure != null) call.reject("audio", failure);
                else call.resolve(new JSObject().put("wav", wav == null ? "" : Base64.encodeToString(wav, Base64.NO_WRAP)));
            }, "voicefit-utterance").start();
        });
    }

    @PluginMethod public void cancelRecording(PluginCall call) {
        if (utteranceRecorder != null) utteranceRecorder.cancel();
        call.resolve();
    }
    @PluginMethod public void stopRecording(PluginCall call) {
        if (utteranceRecorder != null) utteranceRecorder.stop();
        call.resolve();
    }

    /* ---------------- 내 목소리 등록 ---------------- */

    /**
     * durationMs 동안 녹음해 목소리 지문을 만들고 저장한다.
     * 결과: { ok, reason?, voicedMs, wav (base64, AI 품질 검사용) }
     */
    @PluginMethod
    public void enrollVoice(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) { call.reject("마이크 권한이 필요해요"); return; }
        int durationMs = Math.max(3000, Math.min(12000, call.getInt("durationMs", 7000)));
        main.post(() -> { if (rec != null) rec.destroy(); rec = new GatedRecognizer(getContext()); });
        enrolling = true;
        new Thread(() -> {
            try {
                List<short[]> frames = new ArrayList<>();
                recordFrames(durationMs, frames);
                VoicePrint.Profile p = VoicePrint.build(frames);
                int voiced = 0;
                float[] lv = new float[frames.size()];
                for (int i = 0; i < frames.size(); i++) lv[i] = VoicePrint.level(frames.get(i), VoicePrint.FRAME);
                JSObject r = new JSObject();
                r.put("wav", Base64.encodeToString(toWav(frames), Base64.NO_WRAP));
                if (p == null) {
                    r.put("ok", false);
                    r.put("reason", "too-short");
                } else {
                    getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("profile", p.toJson()).apply();
                    r.put("ok", true);
                    r.put("savedAt", p.savedAt);
                }
                call.resolve(r);
            } catch (Exception e) {
                call.reject("녹음하지 못했어요", e);
            } finally {
                enrolling = false;
            }
        }, "voicefit-enroll").start();
    }

    @android.annotation.SuppressLint("MissingPermission")
    private void recordFrames(int durationMs, List<short[]> frames) {
        int minBuf = AudioRecord.getMinBufferSize(VoicePrint.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord ar = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, VoicePrint.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuf, VoicePrint.FRAME * 2 * 8));
        MicRoute.apply(getContext(), ar); // 실제로 쓸 마이크로 등록해야 목소리 지문이 맞는다
        NoiseSuppressor ns = null;
        if (NoiseSuppressor.isAvailable()) {
            try { ns = NoiseSuppressor.create(ar.getAudioSessionId()); if (ns != null) ns.setEnabled(true); } catch (Exception ignored) { }
        }
        ar.startRecording();
        long end = System.currentTimeMillis() + durationMs;
        long lastLevel = 0;
        while (System.currentTimeMillis() < end) {
            short[] buf = new short[VoicePrint.FRAME];
            int n = ar.read(buf, 0, VoicePrint.FRAME);
            if (n == VoicePrint.FRAME) {
                frames.add(buf);
                long now = System.currentTimeMillis();
                if (now - lastLevel > 100) { lastLevel = now; notifyListeners("speechLevel", new JSObject().put("level", VoicePrint.level(buf, n))); }
            }
        }
        ar.stop();
        ar.release();
        if (ns != null) ns.release();
        MicRoute.release(getContext());
    }

    /* ---------------- 마이크 장치 고르기 (PLAN 2) ---------------- */

    /** 연결된 마이크 목록과 고른 장치. 결과: { devices:[{key,name,kind}], selected, active } */
    @PluginMethod
    public void listMics(PluginCall call) {
        call.resolve(micsPayload());
    }

    private JSObject micsPayload() {
        JSArray arr = new JSArray();
        for (MicRoute.Mic m : MicRoute.list(getContext())) {
            arr.put(new JSObject().put("key", m.key).put("name", m.name).put("kind", m.kind));
        }
        MicRoute.Mic active = MicRoute.resolve(getContext());
        return new JSObject().put("devices", arr)
            .put("selected", MicRoute.selectedKey(getContext()))
            .put("active", active == null ? MicRoute.AUTO : active.key);
    }

    /** 사용할 마이크 저장 ("auto" = 휴대폰 기본). 다음 듣기부터 적용 */
    @PluginMethod
    public void setMic(PluginCall call) {
        MicRoute.select(getContext(), call.getString("key", MicRoute.AUTO));
        // 열려 있던 마이크를 닫아 다음 듣기부터 새 마이크로 연다 (앱 화면이 다시 듣기를 시작한다)
        main.post(() -> { if (rec != null) rec.destroy(); });
        call.resolve(micsPayload());
    }

    // 이어폰·헤드셋을 꽂거나 빼면 화면의 목록을 바로 바꾼다
    private final android.media.AudioDeviceCallback deviceCallback = new android.media.AudioDeviceCallback() {
        @Override public void onAudioDevicesAdded(android.media.AudioDeviceInfo[] added) { notifyListeners("micsChanged", micsPayload()); }
        @Override public void onAudioDevicesRemoved(android.media.AudioDeviceInfo[] removed) { notifyListeners("micsChanged", micsPayload()); }
    };

    private static byte[] toWav(List<short[]> frames) {
        int dataLen = frames.size() * VoicePrint.FRAME * 2;
        ByteArrayOutputStream out = new ByteArrayOutputStream(44 + dataLen);
        writeStr(out, "RIFF"); writeInt(out, 36 + dataLen); writeStr(out, "WAVE");
        writeStr(out, "fmt "); writeInt(out, 16); writeShort(out, 1); writeShort(out, 1);
        writeInt(out, VoicePrint.SAMPLE_RATE); writeInt(out, VoicePrint.SAMPLE_RATE * 2); writeShort(out, 2); writeShort(out, 16);
        writeStr(out, "data"); writeInt(out, dataLen);
        for (short[] f : frames) for (short s : f) writeShort(out, s);
        return out.toByteArray();
    }
    private static void writeStr(ByteArrayOutputStream o, String s) { for (char c : s.toCharArray()) o.write(c); }
    private static void writeInt(ByteArrayOutputStream o, int v) { o.write(v); o.write(v >> 8); o.write(v >> 16); o.write(v >> 24); }
    private static void writeShort(ByteArrayOutputStream o, int v) { o.write(v); o.write(v >> 8); }

    @PluginMethod
    public void voiceStatus(PluginCall call) {
        VoicePrint.Profile p = loadProfile(getContext());
        call.resolve(new JSObject().put("enrolled", p != null).put("savedAt", p == null ? 0 : p.savedAt)
            .put("captureSupported", !GatedRecognizer.captureUnsupported && android.os.Build.VERSION.SDK_INT >= 33));
    }

    @PluginMethod
    public void clearVoice(PluginCall call) {
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("profile").apply();
        call.resolve();
    }
}
