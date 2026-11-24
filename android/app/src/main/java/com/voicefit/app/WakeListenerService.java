package com.voicefit.app;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import java.util.ArrayList;
import java.util.List;

/**
 * 앱이 백그라운드에 있을 때 호출어를 듣는 포그라운드 서비스.
 * - 화면 위에 작은 마이크 버블을 띄운다 (다른 앱 위에 표시 권한이 있을 때)
 * - 호출어가 들리면 즉시 짧은 효과음으로 반응하고, 화면이 꺼져 있으면 켜서
 *   VOICE FIT 을 잠금화면 위로 불러온 뒤 이어서 말한 내용을 넘긴다
 * - 화면이 꺼져도 듣기가 멈추지 않도록 CPU 를 깨워 둔다 (부분 깨우기)
 * - 앱이 화면에 있을 때는 듣지 않는다 (앱 안의 음성 인식이 맡음)
 * - 대화 세션 중에는(화면이 꺼져도) 앱이 마이크를 계속 쓰므로 서비스는 듣지 않고 깨어 있게만 한다
 */
public class WakeListenerService extends Service {
    public static final String ACTION_STOP = "com.voicefit.app.STOP_WAKE";
    public static final String EXTRA_WAKE = "voicefit_wake";
    public static final String EXTRA_REST = "voicefit_rest";
    public static final String EXTRA_TOKEN = "voicefit_token";
    /** 보안: 앱 안에서만 아는 무작위 값. 다른 앱이 "호출된 척" 신호를 보내도 이 값이 없으면 무시한다 */
    static final String WAKE_TOKEN = java.util.UUID.randomUUID().toString();
    static boolean isGenuineWake(android.content.Intent i) {
        return i != null && i.getBooleanExtra(EXTRA_WAKE, false) && WAKE_TOKEN.equals(i.getStringExtra(EXTRA_TOKEN));
    }
    static final String PREFS = "voicefit_wake";
    private static final String CHANNEL = "wake_listener";
    private static final int NOTIF_ID = 4021;

    private static WakeListenerService instance;
    private static volatile boolean appForeground = true;
    // 앱에서 대화 세션(대화·카운트·타이머)이 진행 중인지
    private static volatile boolean sessionActive = false;

    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private boolean listening = false;
    private boolean stopped = false;
    private boolean listenOn = false; // 홈 화면에서도 듣기 설정이 켜져 있는지
    private PowerManager.WakeLock cpuLock;
    private String wakeWord = "";
    // 소음 배제(음성 감지 기준): 기준보다 작은 소리로 들어온 말은 무시
    private boolean gateEnabled = false;
    private float gateLevel = 5f;
    private boolean voiceLock = false; // 등록된 내 목소리만 듣기
    private GatedRecognizer gated;
    private String lastBest = "";
    private String lastError = null;
    private final List<String> heard = new ArrayList<>();
    private Runnable pendingStop;

    private WindowManager windowManager;
    private FrameLayout bubble;
    private GradientDrawable bubbleBg;

    /* ---------- 앱(플러그인)에서 호출 ---------- */
    static void setAppForeground(boolean fg) {
        appForeground = fg;
        WakeListenerService s = instance;
        if (s == null) return;
        s.main.post(() -> {
            if (fg) { s.cancelRecognition(); s.setBubbleVisible(false); }
            else if (!sessionActive && s.listenOn) { s.setBubbleVisible(true); s.scheduleListen(700); }
        });
    }

    static boolean isRunning() { return instance != null; }

    static boolean isSessionActive() { return sessionActive; }

    /** 앱의 대화 세션 시작/끝. 세션 중에는 앱이 마이크를 쓰고, 서비스는 깨어 있게만 한다 */
    static void setSession(boolean active) {
        sessionActive = active;
        WakeListenerService s = instance;
        if (s != null) s.main.post(s::onSessionChanged);
    }

    /** 화면이 꺼진 채 세션이 이어지는 중인지 (앱 안의 듣기를 멈추지 않아야 할 때) */
    static boolean holdsSession(Context ctx) {
        if (!sessionActive) return false;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return pm != null && !pm.isInteractive();
    }

    /** 홈 화면 듣기만 끈다 (세션이 진행 중이면 서비스는 세션이 끝날 때까지 유지) */
    static void disableListening(Context ctx) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", false).apply();
        WakeListenerService s = instance;
        if (s == null) return;
        s.main.post(() -> {
            s.listenOn = false;
            s.cancelRecognition();
            s.setBubbleVisible(false);
            s.updateNotification();
        });
    }

    private void onSessionChanged() {
        if (stopped) return;
        updateNotification();
        if (sessionActive) {
            cancelRecognition();
            setBubbleVisible(false);
            return;
        }
        if (!listenOn) { stopSelf(); return; } // 세션 때문에만 켜졌던 경우
        if (!appForeground) { setBubbleVisible(true); scheduleListen(500); }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        // 화면이 꺼져도 듣기·세션이 멈추지 않게 CPU 를 깨워 둔다 (서비스가 끝나면 놓는다)
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "voicefit:listen");
            cpuLock.setReferenceCounted(false);
            cpuLock.acquire();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (intent != null && intent.hasExtra("wakeWord")) {
            prefs.edit()
                .putString("wakeWord", intent.getStringExtra("wakeWord"))
                .putBoolean("gateEnabled", intent.getBooleanExtra("gateEnabled", false))
                .putFloat("gateLevel", intent.getFloatExtra("gateLevel", 5f))
                .putBoolean("voiceLock", intent.getBooleanExtra("voiceLock", false))
                .putBoolean("enabled", true).apply();
        }
        wakeWord = prefs.getString("wakeWord", "");
        gateEnabled = prefs.getBoolean("gateEnabled", false);
        gateLevel = prefs.getFloat("gateLevel", 5f);
        voiceLock = prefs.getBoolean("voiceLock", false);
        listenOn = prefs.getBoolean("enabled", false) && !wakeWord.isEmpty();

        Notification n = buildNotification();
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, n, type);
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!listenOn && !sessionActive) { // 할 일이 없음 (예: 시스템이 다시 띄웠는데 설정이 꺼져 있음)
            stopSelf();
            return START_NOT_STICKY;
        }
        main.post(() -> {
            boolean listenNow = listenOn && !appForeground && !sessionActive;
            if (listenOn) ensureBubble();
            setBubbleVisible(listenNow);
            if (listenNow) scheduleListen(300);
        });
        return START_STICKY;
    }

    /* ---------- 알림 ---------- */
    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "호출어 듣기", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("다른 화면에서도 호출어를 듣고 있을 때 표시돼요");
            ch.setShowBadge(false);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
    }

    private Notification buildNotification() {
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT), piFlags);
        PendingIntent stop = PendingIntent.getService(this, 1,
            new Intent(this, WakeListenerService.class).setAction(ACTION_STOP), piFlags);
        String word = wakeWord.isEmpty() ? "호출어" : "“" + wakeWord + "”";
        String title = sessionActive ? "VOICE FIT 운동 중" : "VOICE FIT 이 듣고 있어요";
        String text = sessionActive ? "화면이 꺼져도 계속 듣고 있어요"
            : "호출어를 부르면 화면이 꺼져 있어도 바로 대답해요";
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "끄기", stop)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void updateNotification() {
        try {
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIF_ID, buildNotification());
        } catch (Exception ignored) { }
    }

    /* ---------- 호출어 듣기 (걸러 듣는 음성 인식) ---------- */
    private void scheduleListen(long delayMs) {
        main.removeCallbacks(listenRunnable);
        main.postDelayed(listenRunnable, delayMs);
    }

    private final Runnable listenRunnable = this::startRecognition;

    private void startRecognition() {
        if (stopped || appForeground || listening || sessionActive || !listenOn || wakeWord.isEmpty()) return;
        if (!SpeechRecognizer.isRecognitionAvailable(this)) return;
        if (gated == null) gated = new GatedRecognizer(this);
        heard.clear();
        final long startedAt = System.currentTimeMillis();
        GatedRecognizer.Options o = new GatedRecognizer.Options();
        o.gateEnabled = gateEnabled;
        o.gateLevel = gateLevel;
        o.voiceLock = voiceLock;
        o.endSilenceMs = 1500; // 내 목소리가 1.5초 없으면 그때까지 한 말로 판단
        gated.setProfile(voiceLock ? VoiceListenerPlugin.loadProfile(this) : null);
        listening = true;
        setBubbleState(false);
        gated.start(o, new GatedRecognizer.Callback() {
            @Override public void onReady() { }
            @Override public void onLevel(float level) { pulseBubble(level); }
            @Override public void onBurst() { }
            @Override public void onPartial(ArrayList<String> alts) {
                heard.addAll(alts);
                // 호출어가 들리면 이어지는 말이 없을 때(0.5초) 바로 마무리해서 빠르게 반응
                if (pendingStop != null) main.removeCallbacks(pendingStop);
                if (WakeWordMatcher.match(alts.get(0), wakeWord).matched) {
                    pendingStop = () -> { if (gated != null) gated.stop(); };
                    main.postDelayed(pendingStop, 500);
                }
            }
            @Override public void onFinal(ArrayList<String> alts) {
                heard.addAll(alts);
                lastBest = alts.isEmpty() ? "" : alts.get(0);
            }
            @Override public void onError(String code) { lastError = code; }
            @Override public void onEnd() {
                listening = false;
                if (pendingStop != null) { main.removeCallbacks(pendingStop); pendingStop = null; }
                if (stopped || appForeground || sessionActive) return;
                if (WakeWordMatcher.matchAny(heard, wakeWord).matched) {
                    onWake(WakeWordMatcher.match(lastBest, wakeWord).rest);
                    return;
                }
                String err = lastError;
                lastError = null;
                lastBest = "";
                long elapsed = System.currentTimeMillis() - startedAt;
                if ("network".equals(err) || "permission".equals(err) || "audio".equals(err)) scheduleListen(3000);
                else scheduleListen(elapsed < 500 ? 600 : 100);
            }
        });
    }

    private void cancelRecognition() {
        main.removeCallbacks(listenRunnable);
        if (pendingStop != null) { main.removeCallbacks(pendingStop); pendingStop = null; }
        if (gated != null) gated.cancel();
        listening = false;
    }

    private void destroyRecognizer() {
        if (gated != null) gated.destroy();
        gated = null;
    }

    private void onWake(String rest) {
        cancelRecognition();
        setBubbleState(true);
        playWakeTone();  // 앱 화면이 뜨기 전에 '들었다'는 신호부터 바로
        wakeScreen();
        Intent open = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_WAKE, true)
            .putExtra(EXTRA_TOKEN, WAKE_TOKEN)
            .putExtra(EXTRA_REST, rest == null ? "" : rest);
        try { startActivity(open); } catch (Exception ignored) { }
        // 앱이 앞으로 나오지 못한 경우(권한 없음 등) 다시 듣기로 돌아간다
        main.postDelayed(() -> {
            if (!appForeground && !stopped && !sessionActive) { setBubbleState(false); scheduleListen(0); }
        }, 3000);
    }

    /** 짧은 두 음 — 호출을 알아들었다는 즉시 반응 (직접 고른 기본 톤, 다른 제품의 효과음 아님) */
    private void playWakeTone() {
        try {
            final ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_MUSIC, 70);
            tg.startTone(ToneGenerator.TONE_PROP_ACK, 180);
            main.postDelayed(tg::release, 500);
        } catch (Exception ignored) { }
    }

    /** 화면이 꺼져 있으면 켠다. 잠금은 풀지 않는다 (앱이 잠금화면 위에 뜬다) */
    @SuppressWarnings("deprecation")
    private void wakeScreen() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null || pm.isInteractive()) return;
            PowerManager.WakeLock wl = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE,
                "voicefit:wake");
            wl.acquire(5000);
        } catch (Exception ignored) { }
    }

    /* ---------- 떠 있는 버블 ---------- */
    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @SuppressLint("ClickableViewAccessibility")
    private void ensureBubble() {
        if (bubble != null || !Settings.canDrawOverlays(this)) return;
        windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        bubble = new FrameLayout(this);
        bubbleBg = new GradientDrawable();
        bubbleBg.setShape(GradientDrawable.OVAL);
        bubbleBg.setColor(0xFF15181D);
        bubbleBg.setStroke(dp(3), 0xFFC6FF3D);
        bubble.setBackground(bubbleBg);
        bubble.setElevation(dp(6));
        ImageView icon = new ImageView(this);
        icon.setImageResource(android.R.drawable.ic_btn_speak_now);
        icon.setColorFilter(0xFFC6FF3D);
        int pad = dp(12);
        icon.setPadding(pad, pad, pad, pad);
        bubble.addView(icon, new FrameLayout.LayoutParams(dp(56), dp(56)));
        bubble.setContentDescription("VOICE FIT 호출어 듣는 중. 누르면 앱을 열어요");

        final WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
            dp(56), dp(56),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = getResources().getDisplayMetrics().widthPixels - dp(72);
        lp.y = dp(220);

        // 끌어서 옮기기 / 눌러서 앱 열기
        bubble.setOnTouchListener(new View.OnTouchListener() {
            int startX, startY; float downX, downY; boolean moved;
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = lp.x; startY = lp.y; downX = e.getRawX(); downY = e.getRawY(); moved = false; return true;
                    case MotionEvent.ACTION_MOVE:
                        int dx = (int) (e.getRawX() - downX), dy = (int) (e.getRawY() - downY);
                        if (Math.abs(dx) > dp(6) || Math.abs(dy) > dp(6)) moved = true;
                        lp.x = startX + dx; lp.y = startY + dy;
                        try { windowManager.updateViewLayout(bubble, lp); } catch (Exception ignored) { }
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved) onWake("");
                        return true;
                }
                return false;
            }
        });
        try {
            windowManager.addView(bubble, lp);
        } catch (Exception e) {
            bubble = null;
        }
    }

    private void setBubbleVisible(boolean visible) {
        if (visible) ensureBubble();
        if (bubble != null) bubble.setVisibility(visible ? View.VISIBLE : View.GONE);
    }

    private void setBubbleState(boolean woke) {
        if (bubbleBg == null) return;
        bubbleBg.setStroke(dp(3), woke ? 0xFFFFFFFF : 0xFFC6FF3D);
        bubbleBg.setColor(woke ? 0xFFC6FF3D : 0xFF15181D);
    }

    private long lastPulse = 0;
    private void pulseBubble(float rms) {
        if (bubble == null) return;
        long now = System.currentTimeMillis();
        if (now - lastPulse < 100) return;
        lastPulse = now;
        float s = 1f + Math.max(0f, Math.min(10f, rms)) * 0.012f;
        bubble.setScaleX(s);
        bubble.setScaleY(s);
    }

    @Override
    public void onDestroy() {
        stopped = true;
        instance = null;
        main.removeCallbacksAndMessages(null);
        cancelRecognition();
        destroyRecognizer();
        if (cpuLock != null && cpuLock.isHeld()) cpuLock.release();
        cpuLock = null;
        if (bubble != null && windowManager != null) {
            try { windowManager.removeView(bubble); } catch (Exception ignored) { }
        }
        bubble = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
