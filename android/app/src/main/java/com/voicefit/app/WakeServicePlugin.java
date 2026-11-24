package com.voicefit.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 백그라운드 호출어 듣기 제어.
 *  start({ wakeWord }) / stop() / status()
 *  canDrawOverlays() / openOverlaySettings() / requestNotifications()
 *  moveToBack()  - 대화가 끝나면 원래 보던 화면(잠금화면 포함)으로 돌아가기
 *  setSession({ active }) - 대화 세션 시작/끝. 세션 중에는 화면이 꺼져도 앱이 계속 듣고, 잠금화면 위에 보인다
 *  openBatterySettings()  - 배터리 최적화 제외 요청 (화면 꺼짐 중 듣기 안정성)
 *  requestUnlock()        - 잠금 해제 요청 (잠금화면 위에서 설정·기록을 열 때)
 * 이벤트:
 *  appState     { active, screenOff, locked } - 앱이 화면에 보이는지 / 화면이 꺼져서 가려졌는지 / 잠금 상태
 *  wakeDetected { rest }    - 백그라운드에서 호출어가 들려 앱이 열림 (rest = 이어서 말한 내용)
 */
@CapacitorPlugin(
    name = "WakeService",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class WakeServicePlugin extends Plugin {

    @Override
    public void load() {
        WakeListenerService.setAppForeground(true);
        deliverWake(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        deliverWake(intent);
    }

    private void deliverWake(Intent intent) {
        if (intent == null || !intent.getBooleanExtra(WakeListenerService.EXTRA_WAKE, false)) return;
        if (!WakeListenerService.isGenuineWake(intent)) { intent.removeExtra(WakeListenerService.EXTRA_WAKE); return; } // 보안: 위조 신호
        String rest = intent.getStringExtra(WakeListenerService.EXTRA_REST);
        intent.removeExtra(WakeListenerService.EXTRA_WAKE);
        JSObject d = new JSObject();
        d.put("rest", rest == null ? "" : rest);
        notifyListeners("wakeDetected", d, true);
    }

    @Override
    protected void handleOnStart() {
        WakeListenerService.setAppForeground(true);
        notifyListeners("appState", new JSObject().put("active", true).put("screenOff", false).put("locked", isLocked()));
    }

    @Override
    protected void handleOnStop() {
        WakeListenerService.setAppForeground(false);
        notifyListeners("appState", new JSObject().put("active", false).put("screenOff", isScreenOff()).put("locked", isLocked()));
    }

    private boolean isScreenOff() {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && !pm.isInteractive();
    }

    private boolean isLocked() {
        KeyguardManager km = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isKeyguardLocked();
    }

    private void overLockScreen(boolean show, boolean turnOn) {
        if (!(getActivity() instanceof MainActivity)) return;
        MainActivity a = (MainActivity) getActivity();
        a.runOnUiThread(() -> a.setOverLockScreen(show, turnOn));
    }

    /** 대화 세션 시작/끝 */
    @PluginMethod
    public void setSession(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        WakeListenerService.setSession(active);
        // 세션 중: 화면이 꺼졌다 켜져도 잠금을 풀지 않고 카운터를 바로 볼 수 있게
        overLockScreen(active, false);
        if (active && !WakeListenerService.isRunning()) {
            // 화면이 꺼져도 마이크를 계속 쓰려면 앱이 보이는 지금 포그라운드 서비스를 시작해 둬야 한다
            try {
                ContextCompat.startForegroundService(getContext(), new Intent(getContext(), WakeListenerService.class));
            } catch (Exception ignored) { }
        }
        call.resolve();
    }

    @SuppressLint("BatteryLife")
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        String pkg = getContext().getPackageName();
        boolean exempt = pm != null && pm.isIgnoringBatteryOptimizations(pkg);
        boolean want = Boolean.TRUE.equals(call.getBoolean("exempt", true));
        if (!want) {
            // 최적화를 다시 켜는 건 안드로이드가 앱에 허락하지 않아서, 이 앱의 시스템 설정(배터리) 화면을 연다
            getContext().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
            return;
        }
        if (exempt) { call.resolve(); return; }
        try {
            getContext().startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            getContext().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    /* ---------- PLAN 12 · 휴식 종료 알림 (±2초) ----------
     * 화면이 꺼지면 웹 화면의 타이머가 늦게 울릴 수 있어서, 종료 시각에 앱 쪽에서 직접 짧은 알림음을 내고 화면에 알린다.
     * 세션 중에는 포그라운드 서비스가 CPU 를 깨워 두므로 제시간에 울린다. */
    private final android.os.Handler restHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable restRunnable = () -> {
        try {
            final android.media.ToneGenerator tg = new android.media.ToneGenerator(android.media.AudioManager.STREAM_MUSIC, 85);
            tg.startTone(android.media.ToneGenerator.TONE_PROP_BEEP2, 300);
            restHandler.postDelayed(tg::release, 600);
        } catch (Exception ignored) { }
        notifyListeners("restDone", new JSObject().put("at", System.currentTimeMillis()));
    };

    /** restAlarm({ ms }) — ms 뒤에 휴식 종료 알림. ms <= 0 이면 취소 */
    @PluginMethod
    public void restAlarm(PluginCall call) {
        long ms = call.getLong("ms", 0L);
        restHandler.removeCallbacks(restRunnable);
        if (ms > 0) restHandler.postDelayed(restRunnable, ms);
        call.resolve();
    }

    @PluginMethod
    public void lockState(PluginCall call) { call.resolve(new JSObject().put("locked", isLocked())); }

    /** 잠금 해제 요청: 사용자가 직접 PIN·지문 등으로 푼다. 결과 { unlocked } */
    @PluginMethod
    public void requestUnlock(PluginCall call) {
        KeyguardManager km = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
        if (km == null || !km.isKeyguardLocked() || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.resolve(new JSObject().put("unlocked", km == null || !km.isKeyguardLocked()));
            return;
        }
        getActivity().runOnUiThread(() -> km.requestDismissKeyguard(getActivity(), new KeyguardManager.KeyguardDismissCallback() {
            @Override public void onDismissSucceeded() { call.resolve(new JSObject().put("unlocked", true)); }
            @Override public void onDismissCancelled() { call.resolve(new JSObject().put("unlocked", false)); }
            @Override public void onDismissError() { call.resolve(new JSObject().put("unlocked", false)); }
        }));
    }

    @PluginMethod
    public void start(PluginCall call) {
        String wakeWord = call.getString("wakeWord", "");
        if (wakeWord.isEmpty()) { call.reject("호출어가 없어요"); return; }
        Intent i = new Intent(getContext(), WakeListenerService.class)
            .putExtra("wakeWord", wakeWord)
            .putExtra("gateEnabled", Boolean.TRUE.equals(call.getBoolean("gateEnabled", false)))
            .putExtra("gateLevel", call.getFloat("gateLevel", 5f))
            .putExtra("voiceLock", Boolean.TRUE.equals(call.getBoolean("voiceLock", false)));
        try {
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject("백그라운드 듣기를 시작하지 못했어요", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (WakeListenerService.isSessionActive()) {
            // 운동 세션 중이면 서비스는 남겨 두고(화면 꺼짐 중 마이크 유지) 홈 화면 듣기만 끈다
            WakeListenerService.disableListening(getContext());
        } else {
            getContext().getSharedPreferences(WakeListenerService.PREFS, 0).edit().putBoolean("enabled", false).apply();
            getContext().stopService(new Intent(getContext(), WakeListenerService.class));
        }
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("running", WakeListenerService.isRunning());
        r.put("overlay", Settings.canDrawOverlays(getContext()));
        r.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        r.put("battery", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(r);
    }

    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(new JSObject().put("granted", true));
        } else {
            requestPermissionForAlias("notifications", call, "onNotifications");
        }
    }

    @PermissionCallback
    private void onNotifications(PluginCall call) {
        call.resolve(new JSObject().put("granted", getPermissionState("notifications") == PermissionState.GRANTED));
    }

    @PluginMethod
    public void moveToBack(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            // 잠금화면 위에 떠 있었다면 내려놓아 다시 잠금화면이 보이게
            if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).setOverLockScreen(false, false);
            getActivity().moveTaskToBack(true);
        });
        call.resolve();
    }
}
