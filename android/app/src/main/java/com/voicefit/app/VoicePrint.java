package com.voicefit.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * 사용자 목소리 지문(보이스프린트).
 * 20ms(16kHz, 320샘플) 프레임마다 음색 특징(MFCC 12개)과 음높이를 뽑아,
 * 등록 때 평균·분산을 저장하고, 이후 들어온 소리 구간이 얼마나 비슷한지 점수로 낸다.
 * (화자 인식 전용 AI 모델이 아닌 가벼운 통계 방식이라 100% 정확하지는 않다)
 */
public final class VoicePrint {
    public static final int SAMPLE_RATE = 16000;
    public static final int FRAME = 320; // 20ms
    private static final int FFT = 512;
    private static final int MELS = 24;
    private static final int COEFFS = 12;

    private static final float[] WINDOW = new float[FRAME];
    private static final float[][] MEL_FILTERS = new float[MELS][FFT / 2 + 1];
    static {
        for (int i = 0; i < FRAME; i++) WINDOW[i] = (float) (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (FRAME - 1)));
        double melLo = hzToMel(80), melHi = hzToMel(7600);
        int[] bins = new int[MELS + 2];
        for (int m = 0; m < MELS + 2; m++) {
            double hz = melToHz(melLo + (melHi - melLo) * m / (MELS + 1));
            bins[m] = (int) Math.floor((FFT + 1) * hz / SAMPLE_RATE);
        }
        for (int m = 1; m <= MELS; m++) {
            for (int k = bins[m - 1]; k < bins[m]; k++) MEL_FILTERS[m - 1][k] = (float) (k - bins[m - 1]) / Math.max(1, bins[m] - bins[m - 1]);
            for (int k = bins[m]; k < bins[m + 1]; k++) MEL_FILTERS[m - 1][k] = (float) (bins[m + 1] - k) / Math.max(1, bins[m + 1] - bins[m]);
        }
    }
    private static double hzToMel(double hz) { return 2595 * Math.log10(1 + hz / 700); }
    private static double melToHz(double mel) { return 700 * (Math.pow(10, mel / 2595) - 1); }

    /** 한 프레임의 음색 특징 (MFCC c1..c12) */
    public static float[] mfcc(short[] frame) {
        double[] re = new double[FFT], im = new double[FFT];
        for (int i = 0; i < FRAME && i < frame.length; i++) re[i] = frame[i] / 32768.0 * WINDOW[i];
        fft(re, im);
        double[] power = new double[FFT / 2 + 1];
        for (int k = 0; k <= FFT / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
        double[] logMel = new double[MELS];
        for (int m = 0; m < MELS; m++) {
            double e = 0;
            for (int k = 0; k <= FFT / 2; k++) e += MEL_FILTERS[m][k] * power[k];
            logMel[m] = Math.log(e + 1e-10);
        }
        float[] out = new float[COEFFS];
        for (int c = 1; c <= COEFFS; c++) {
            double s = 0;
            for (int m = 0; m < MELS; m++) s += logMel[m] * Math.cos(Math.PI * c * (m + 0.5) / MELS);
            out[c - 1] = (float) s;
        }
        return out;
    }

    /** 음높이(Hz). 목소리가 아니면 0 */
    public static float pitch(short[] frame) {
        int minLag = SAMPLE_RATE / 400, maxLag = SAMPLE_RATE / 70;
        double energy = 0;
        for (short s : frame) energy += (double) s * s;
        if (energy < 1e3) return 0;
        double best = 0; int bestLag = 0;
        for (int lag = minLag; lag <= maxLag && lag < frame.length; lag++) {
            double sum = 0, e1 = 0, e2 = 0;
            for (int i = 0; i + lag < frame.length; i++) {
                sum += (double) frame[i] * frame[i + lag];
                e1 += (double) frame[i] * frame[i];
                e2 += (double) frame[i + lag] * frame[i + lag];
            }
            double r = sum / Math.sqrt(e1 * e2 + 1e-9);
            if (r > best) { best = r; bestLag = lag; }
        }
        return best > 0.45 && bestLag > 0 ? (float) SAMPLE_RATE / bestLag : 0;
    }

    /** 프레임 음량 (안드로이드 음성인식 음량과 비슷한 눈금: 조용함 약 -2 ~ 큰 목소리 약 10) */
    public static float level(short[] frame, int n) {
        double sum = 0;
        for (int i = 0; i < n; i++) sum += (double) frame[i] * frame[i];
        double rms = Math.sqrt(sum / Math.max(1, n));
        double dbfs = 20 * Math.log10(rms / 32768.0 + 1e-9);
        return (float) ((dbfs + 50) / 3.5);
    }

    private static void fft(double[] re, double[] im) {
        int n = re.length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { double t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double ang = -2 * Math.PI / len;
            double wr = Math.cos(ang), wi = Math.sin(ang);
            for (int i = 0; i < n; i += len) {
                double cr = 1, ci = 0;
                for (int k = 0; k < len / 2; k++) {
                    int a = i + k, b = i + k + len / 2;
                    double xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                    double t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
                }
            }
        }
    }

    /* ---------------- 등록된 목소리 ---------------- */
    public static final class Profile {
        public final float[] mean = new float[COEFFS];
        public final float[] std = new float[COEFFS];
        public float pitchMean, pitchStd, threshold;
        public long savedAt;

        /** 구간(여러 프레임)의 특징이 등록 목소리와 얼마나 비슷한지 0~1 */
        public float score(List<float[]> feats, List<Float> pitches) {
            if (feats.isEmpty()) return 0;
            float[] m = new float[COEFFS];
            for (float[] f : feats) for (int i = 0; i < COEFFS; i++) m[i] += f[i] / feats.size();
            double d = 0;
            for (int i = 0; i < COEFFS; i++) { double z = (m[i] - mean[i]) / Math.max(1e-3, std[i]); d += z * z; }
            d = Math.sqrt(d / COEFFS);
            double s = 1.0 / (1.0 + d);
            float p = 0; int np = 0;
            for (float x : pitches) if (x > 0) { p += x; np++; }
            if (np > 0 && pitchMean > 0) {
                double pz = Math.abs(p / np - pitchMean) / Math.max(15f, pitchStd);
                if (pz > 2.5) s *= 0.6;
            }
            return (float) s;
        }

        public String toJson() {
            try {
                JSONObject o = new JSONObject();
                JSONArray a = new JSONArray(), b = new JSONArray();
                for (int i = 0; i < COEFFS; i++) { a.put(mean[i]); b.put(std[i]); }
                o.put("mean", a); o.put("std", b);
                o.put("pitchMean", pitchMean); o.put("pitchStd", pitchStd);
                o.put("threshold", threshold); o.put("savedAt", savedAt);
                return o.toString();
            } catch (Exception e) { return null; }
        }

        public static Profile fromJson(String s) {
            if (s == null || s.isEmpty()) return null;
            try {
                JSONObject o = new JSONObject(s);
                Profile p = new Profile();
                JSONArray a = o.getJSONArray("mean"), b = o.getJSONArray("std");
                for (int i = 0; i < COEFFS; i++) { p.mean[i] = (float) a.getDouble(i); p.std[i] = (float) b.getDouble(i); }
                p.pitchMean = (float) o.getDouble("pitchMean");
                p.pitchStd = (float) o.getDouble("pitchStd");
                p.threshold = (float) o.getDouble("threshold");
                p.savedAt = o.optLong("savedAt", 0);
                return p;
            } catch (Exception e) { return null; }
        }
    }

    /**
     * 등록 녹음(여러 프레임)으로 목소리 지문을 만든다. 목소리 구간이 너무 짧으면 null.
     * 기준점(threshold)은 등록 녹음 자체를 구간별로 다시 채점해, 하위 10% 점수보다 조금 낮게 둔다.
     */
    public static Profile build(List<short[]> frames) {
        float[] levels = new float[frames.size()];
        for (int i = 0; i < frames.size(); i++) levels[i] = level(frames.get(i), FRAME);
        float[] sorted = levels.clone();
        Arrays.sort(sorted);
        float floor = sorted[Math.max(0, (int) (sorted.length * 0.2) - 1)];
        List<float[]> feats = new ArrayList<>();
        List<Float> pitches = new ArrayList<>();
        for (int i = 0; i < frames.size(); i++) {
            if (levels[i] < floor + 3f) continue; // 목소리 구간만
            feats.add(mfcc(frames.get(i)));
            pitches.add(pitch(frames.get(i)));
        }
        if (feats.size() < 80) return null; // 목소리 1.6초 이상 필요
        Profile p = new Profile();
        for (float[] f : feats) for (int i = 0; i < COEFFS; i++) p.mean[i] += f[i] / feats.size();
        for (float[] f : feats) for (int i = 0; i < COEFFS; i++) p.std[i] += (f[i] - p.mean[i]) * (f[i] - p.mean[i]) / feats.size();
        for (int i = 0; i < COEFFS; i++) p.std[i] = (float) Math.sqrt(p.std[i]) + 1e-3f;
        float ps = 0; int np = 0;
        for (float x : pitches) if (x > 0) { ps += x; np++; }
        p.pitchMean = np > 0 ? ps / np : 0;
        float pv = 0;
        for (float x : pitches) if (x > 0) pv += (x - p.pitchMean) * (x - p.pitchMean);
        p.pitchStd = np > 1 ? (float) Math.sqrt(pv / np) : 30f;

        List<Float> scores = new ArrayList<>();
        for (int s = 0; s + 8 <= feats.size(); s += 4) {
            scores.add(p.score(feats.subList(s, s + 8), pitches.subList(s, s + 8)));
        }
        java.util.Collections.sort(scores);
        float low = scores.isEmpty() ? 0.3f : scores.get(Math.max(0, (int) (scores.size() * 0.1) - 1));
        p.threshold = Math.max(0.12f, low * 0.85f);
        p.savedAt = System.currentTimeMillis();
        return p;
    }
}
