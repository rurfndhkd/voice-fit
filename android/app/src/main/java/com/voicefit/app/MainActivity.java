package com.voicefit.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PhoneBridgePlugin.class);
        registerPlugin(VoiceListenerPlugin.class);
        registerPlugin(WakeServicePlugin.class);
        super.onCreate(savedInstanceState);
        // Voice replies may follow a wake word, with no screen tap.
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        applyWakeFlags(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // 플러그인이 호출 표시(extra)를 지우기 전에 먼저 확인한다
        applyWakeFlags(intent);
        super.onNewIntent(intent);
    }

    /** 화면이 꺼졌거나 잠긴 상태에서 호출됐으면: 화면을 켜고 잠금화면 위에 바로 띄운다 (잠금 해제는 하지 않음) */
    private void applyWakeFlags(Intent intent) {
        if (WakeListenerService.isGenuineWake(intent)) { // 다른 앱이 보낸 가짜 호출은 무시
            setOverLockScreen(true, true);
        }
    }

    /**
     * 잠금화면 위 표시.
     * @param show   잠금을 풀지 않아도 앱이 보이게
     * @param turnOn 앞으로 나올 때 화면을 켜기
     */
    public void setOverLockScreen(boolean show, boolean turnOn) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(show);
            setTurnScreenOn(turnOn);
        } else {
            int flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON;
            if (show) getWindow().addFlags(flags);
            else getWindow().clearFlags(flags);
        }
    }
}
