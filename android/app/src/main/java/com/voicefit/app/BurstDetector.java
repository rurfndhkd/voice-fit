package com.voicefit.app;

/**
 * 말소리 시작/끝 감지 (숫자 하나 = 소리 덩어리 하나).
 * 주변 소음 바닥값을 스스로 따라가며, 그보다 충분히 큰 소리가 40ms 이상 이어지면 '시작',
 * 150ms 이상 조용하면 '끝'으로 본다. 시간 기준이라 프레임 간격이 일정하지 않아도 동작한다.
 */
final class BurstDetector {
    static final int NONE = 0, ONSET = 1, END = 2;

    private float floor = -1f;
    private boolean voiced = false;
    private long aboveSince = -1, belowSince = -1, lastEnd = 0, lastT = 0;
    boolean gateEnabled = false;
    float gateLevel = 5f;

    boolean isVoiced() { return voiced; }

    /** 소리 크기 하나를 넣고, ONSET/END/NONE 을 돌려준다 */
    int feed(float level, long t) {
        long dt = lastT == 0 ? 20 : Math.max(1, t - lastT);
        lastT = t;
        // 바닥값: 더 조용해지면 바로 내려가고, 커지면 아주 천천히 올라간다
        if (level < floor) floor = level;
        else if (!voiced) floor += (level - floor) * Math.min(1f, dt / 4000f);
        float on = Math.max(floor + 2.5f, gateEnabled ? gateLevel : -100f);
        float off = on - 1f;

        if (!voiced) {
            if (level >= on) {
                if (aboveSince < 0) aboveSince = t;
                if (t - aboveSince >= 40 && t - lastEnd >= 180) {
                    voiced = true;
                    belowSince = -1;
                    return ONSET;
                }
            } else {
                aboveSince = -1;
            }
        } else {
            if (level < off) {
                if (belowSince < 0) belowSince = t;
                if (t - belowSince >= 150) {
                    voiced = false;
                    lastEnd = t;
                    aboveSince = -1;
                    return END;
                }
            } else {
                belowSince = -1;
            }
        }
        return NONE;
    }
}
