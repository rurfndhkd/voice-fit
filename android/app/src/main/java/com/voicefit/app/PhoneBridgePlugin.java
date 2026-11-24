package com.voicefit.app;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.ContactsContract;
import android.telecom.TelecomManager;
import android.telephony.SmsManager;
import android.telephony.TelephonyManager;
import android.view.WindowManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.util.ArrayList;

/**
 * VOICE FIT 전화 연결부.
 * - 수신 감지(incomingCall 이벤트: number, name) / 통화 종료 감지(callEnded 이벤트)
 * - 받기(answer) · 끊기(reject) · 문자 전송(sendSms)
 * - 벨소리 잠시 무음(setRingerMuted) · 화면 켜짐 유지(keepScreenOn)
 *
 * 앱이 화면에 떠 있는 동안 동작한다(백그라운드 상시 감시는 하지 않음).
 * SEND_SMS · READ_CALL_LOG 는 Google Play 제한 권한이라, 캠프 시연용 APK 직접 설치를 전제로 한다.
 */
@CapacitorPlugin(
    name = "PhoneBridge",
    permissions = {
        @Permission(alias = "phone", strings = {
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.ANSWER_PHONE_CALLS
        }),
        @Permission(alias = "contacts", strings = { Manifest.permission.READ_CONTACTS }),
        @Permission(alias = "sms", strings = { Manifest.permission.SEND_SMS })
    }
)
public class PhoneBridgePlugin extends Plugin {

    private BroadcastReceiver receiver;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private String lastState = TelephonyManager.EXTRA_STATE_IDLE;
    private boolean ringingEmitted = false;
    private Runnable pendingEmit;

    @PluginMethod
    public void startListening(PluginCall call) {
        if (receiver == null) {
            receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    onPhoneState(intent);
                }
            };
            IntentFilter filter = new IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED);
            ContextCompat.registerReceiver(getContext(), receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED); // 보안: 다른 앱이 가짜 전화 신호를 못 보내게
        }
        call.resolve();
    }

    @SuppressWarnings("deprecation")
    private void onPhoneState(Intent intent) {
        String state = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
        if (state == null) return;
        // 번호는 READ_CALL_LOG 권한이 있을 때 두 번째 방송에 실려 온다
        String number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER);

        if (TelephonyManager.EXTRA_STATE_RINGING.equals(state)) {
            if (ringingEmitted) { lastState = state; return; }
            if (number != null && !number.isEmpty()) {
                emitIncoming(number);
            } else if (pendingEmit == null) {
                // 번호가 오지 않으면 잠시 기다렸다가 번호 없이 알린다
                pendingEmit = () -> { if (!ringingEmitted) emitIncoming(""); };
                handler.postDelayed(pendingEmit, 700);
            }
        } else if (TelephonyManager.EXTRA_STATE_IDLE.equals(state)) {
            if (!TelephonyManager.EXTRA_STATE_IDLE.equals(lastState)) {
                notifyListeners("callEnded", new JSObject());
            }
            resetRinging();
        }
        lastState = state;
    }

    private void emitIncoming(String number) {
        ringingEmitted = true;
        if (pendingEmit != null) { handler.removeCallbacks(pendingEmit); pendingEmit = null; }
        JSObject data = new JSObject();
        data.put("number", number);
        data.put("name", lookupContactName(number));
        notifyListeners("incomingCall", data);
    }

    private void resetRinging() {
        ringingEmitted = false;
        if (pendingEmit != null) { handler.removeCallbacks(pendingEmit); pendingEmit = null; }
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private String lookupContactName(String number) {
        if (number == null || number.isEmpty() || !granted(Manifest.permission.READ_CONTACTS)) return "";
        Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
        try (Cursor c = getContext().getContentResolver().query(
                uri, new String[] { ContactsContract.PhoneLookup.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) { }
        return "";
    }

    @PluginMethod
    public void answer(PluginCall call) {
        if (!granted(Manifest.permission.ANSWER_PHONE_CALLS)) { call.reject("전화 받기 권한이 없어요"); return; }
        TelecomManager tm = (TelecomManager) getContext().getSystemService(Context.TELECOM_SERVICE);
        try {
            tm.acceptRingingCall();
            call.resolve();
        } catch (SecurityException e) {
            call.reject("전화를 받지 못했어요", e);
        }
    }

    @PluginMethod
    @SuppressWarnings("deprecation")
    public void reject(PluginCall call) {
        if (!granted(Manifest.permission.ANSWER_PHONE_CALLS)) { call.reject("전화 끊기 권한이 없어요"); return; }
        TelecomManager tm = (TelecomManager) getContext().getSystemService(Context.TELECOM_SERVICE);
        try {
            boolean ended = tm.endCall();
            JSObject r = new JSObject();
            r.put("ended", ended);
            call.resolve(r);
        } catch (SecurityException e) {
            call.reject("전화를 끊지 못했어요", e);
        }
    }

    @PluginMethod
    @SuppressWarnings("deprecation")
    public void sendSms(PluginCall call) {
        String number = call.getString("number", "");
        String text = call.getString("text", "");
        if (number.isEmpty() || text.isEmpty()) { call.reject("번호나 내용이 비어 있어요"); return; }
        if (!granted(Manifest.permission.SEND_SMS)) { call.reject("문자 권한이 없어요"); return; }
        try {
            SmsManager sms = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? getContext().getSystemService(SmsManager.class)
                : SmsManager.getDefault();
            ArrayList<String> parts = sms.divideMessage(text);
            sms.sendMultipartTextMessage(number, null, parts, null, null);
            call.resolve();
        } catch (Exception e) {
            call.reject("문자를 보내지 못했어요", e);
        }
    }

    @PluginMethod
    public void setRingerMuted(PluginCall call) {
        boolean muted = Boolean.TRUE.equals(call.getBoolean("muted", false));
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            am.adjustStreamVolume(AudioManager.STREAM_RING, muted ? AudioManager.ADJUST_MUTE : AudioManager.ADJUST_UNMUTE, 0);
        } catch (SecurityException ignored) {
            // 방해 금지 모드에서는 바꿀 수 없음 — 그대로 진행
        }
        call.resolve();
    }

    @PluginMethod
    public void keepScreenOn(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (receiver != null) {
            try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) { }
            receiver = null;
        }
        resetRinging();
    }
}
