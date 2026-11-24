package com.voicefit.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.os.Build;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * 마이크 장치 고르기 (PLAN 2 · MUST 1).
 * - 연결된 입력 장치 목록: 휴대폰 마이크 / 유선 헤드셋 / USB / 블루투스 이어폰
 * - 고른 장치는 "종류:제품명" 으로 기억한다 (블루투스는 다시 연결될 때마다 내부 번호가 바뀌기 때문)
 * - 블루투스 마이크는 통화용 연결(SCO)을 열어야 소리가 들어오므로, 듣는 동안만 연결하고 끝나면 놓는다
 * - 고른 장치가 없으면(연결 끊김) 휴대폰 기본 마이크로 듣는다
 */
final class MicRoute {
    private static final String TAG = "VoiceFitMic";
    static final String PREFS = VoiceListenerPlugin.PREFS;
    static final String KEY = "micKey";
    static final String AUTO = "auto";

    private static boolean commSet = false;

    private MicRoute() { }

    static final class Mic {
        final String key, name, kind;
        final AudioDeviceInfo device;
        Mic(String key, String name, String kind, AudioDeviceInfo device) {
            this.key = key; this.name = name; this.kind = kind; this.device = device;
        }
    }

    private static boolean isBluetooth(int type) {
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            || (Build.VERSION.SDK_INT >= 31 && type == AudioDeviceInfo.TYPE_BLE_HEADSET);
    }

    private static String kindOf(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_MIC: return "phone";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: return "wired";
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_USB_DEVICE: return "usb";
            default: return isBluetooth(type) ? "bluetooth" : null;
        }
    }

    private static String labelOf(String kind, AudioDeviceInfo d) {
        String product = d.getProductName() == null ? "" : d.getProductName().toString().trim();
        switch (kind) {
            case "phone": return "휴대폰 마이크";
            case "wired": return "유선 헤드셋 마이크";
            case "usb": return product.isEmpty() ? "USB 마이크" : product + " (USB)";
            default: return product.isEmpty() ? "블루투스 이어폰" : product + " (블루투스)";
        }
    }

    /** 지금 연결된 마이크 목록 (휴대폰 마이크는 여러 개여도 하나로) */
    static List<Mic> list(Context ctx) {
        List<Mic> out = new ArrayList<>();
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return out;
        boolean phoneAdded = false;
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            String kind = kindOf(d.getType());
            if (kind == null) continue;
            if (kind.equals("phone")) { if (phoneAdded) continue; phoneAdded = true; }
            String name = labelOf(kind, d);
            String key = kind + ":" + (kind.equals("phone") ? "" : String.valueOf(d.getProductName()));
            boolean dup = false;
            for (Mic m : out) if (m.key.equals(key)) { dup = true; break; }
            if (!dup) out.add(new Mic(key, name, kind, d));
        }
        return out;
    }

    static String selectedKey(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, AUTO);
    }

    static void select(Context ctx, String key) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY, key == null || key.isEmpty() ? AUTO : key).apply();
    }

    /** 고른 장치가 지금 연결돼 있으면 그 장치, 아니면 null (= 기본 마이크) */
    static Mic resolve(Context ctx) {
        String key = selectedKey(ctx);
        if (AUTO.equals(key)) return null;
        for (Mic m : list(ctx)) if (m.key.equals(key)) return m;
        return null;
    }

    /** 녹음 전에: 고른 마이크로 소리가 들어오게 한다 */
    static void apply(Context ctx, AudioRecord record) {
        Mic m = resolve(ctx);
        if (m == null || record == null) return;
        try {
            if (m.kind.equals("bluetooth")) openBluetooth(ctx, m);
            record.setPreferredDevice(m.device);
        } catch (Exception e) {
            Log.w(TAG, "마이크 연결 실패 → 기본 마이크", e);
        }
    }

    /** 블루투스 이어폰 마이크: 통화용 연결을 연다 (안드로이드 12+ 방식) */
    private static void openBluetooth(Context ctx, Mic m) {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am == null || Build.VERSION.SDK_INT < 31) return;
        String product = String.valueOf(m.device.getProductName());
        for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
            if (isBluetooth(d.getType()) && product.equals(String.valueOf(d.getProductName()))) {
                commSet = am.setCommunicationDevice(d);
                return;
            }
        }
    }

    /** 듣기가 끝나면: 블루투스 통화용 연결을 놓아 음악·안내 음성이 원래 음질로 돌아가게 */
    static void release(Context ctx) {
        if (!commSet || Build.VERSION.SDK_INT < 31) return;
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am != null) { try { am.clearCommunicationDevice(); } catch (Exception ignored) { } }
        commSet = false;
    }
}
