package com.voicefit.app;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 호출어 판별 (public/js/wake.js 와 같은 규칙).
 * 한글을 자모 단위로 쪼개고, 비슷한 소리는 같은 것으로 본 뒤, 음절 경계에 맞춘 구간끼리 편집 거리로 비교한다.
 * 허용 오차는 자모 길이의 약 30% (아주 짧은 호출어는 정확히 일치해야 함).
 */
public final class WakeWordMatcher {
    private static final String CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
    private static final String JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
    private static final String[] JONG = { "", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ" };
    private static final Map<String, String> SIMILAR = new HashMap<>();
    static {
        String[][] pairs = { { "ㅔ", "ㅐ" }, { "ㅖ", "ㅒ" }, { "ㄲ", "ㄱ" }, { "ㄸ", "ㄷ" }, { "ㅃ", "ㅂ" }, { "ㅆ", "ㅅ" }, { "ㅉ", "ㅈ" }, { "ㅋ", "ㄱ" }, { "ㅌ", "ㄷ" }, { "ㅍ", "ㅂ" }, { "ㅊ", "ㅈ" } };
        for (String[] p : pairs) SIMILAR.put(p[0], p[1]);
    }

    private WakeWordMatcher() { }

    public static final class Result {
        public final boolean matched;
        public final String rest;
        public final int score;
        Result(boolean matched, String rest, int score) { this.matched = matched; this.rest = rest; this.score = score; }
    }

    private static String sim(String j) {
        String s = SIMILAR.get(j);
        return s != null ? s : j;
    }

    /** 자모 목록과 각 자모가 속한 원문 글자 위치 */
    private static void toJamo(String text, List<String> jamo, List<Integer> idx) {
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (ch >= 0xAC00 && ch <= 0xD7A3) {
                int n = ch - 0xAC00;
                jamo.add(sim(String.valueOf(CHO.charAt(n / 588)))); idx.add(i);
                jamo.add(sim(String.valueOf(JUNG.charAt((n % 588) / 28)))); idx.add(i);
                String jong = JONG[n % 28];
                if (!jong.isEmpty()) { jamo.add(sim(jong)); idx.add(i); }
            } else if (Character.isLetterOrDigit(ch)) {
                jamo.add(String.valueOf(Character.toLowerCase(ch))); idx.add(i);
            }
        }
    }

    private static int distance(List<String> a, List<String> b) {
        int[] prev = new int[b.size() + 1];
        for (int j = 0; j <= b.size(); j++) prev[j] = j;
        for (int i = 1; i <= a.size(); i++) {
            int diag = prev[0];
            prev[0] = i;
            for (int j = 1; j <= b.size(); j++) {
                int tmp = prev[j];
                int cost = a.get(i - 1).equals(b.get(j - 1)) ? 0 : 1;
                prev[j] = Math.min(Math.min(prev[j] + 1, prev[j - 1] + 1), diag + cost);
                diag = tmp;
            }
        }
        return prev[b.size()];
    }

    static int tolerance(int len) {
        return len <= 4 ? 0 : Math.max(1, Math.round(len * 0.3f));
    }

    private static int lettersIn(String s) {
        int c = 0;
        for (int i = 0; i < s.length(); i++) if (Character.isLetterOrDigit(s.charAt(i))) c++;
        return c;
    }

    public static Result match(String transcript, String wakeWord) {
        if (transcript == null || wakeWord == null) return new Result(false, "", Integer.MAX_VALUE);
        List<String> t = new ArrayList<>();
        List<Integer> ti = new ArrayList<>();
        toJamo(transcript, t, ti);
        List<String> w = new ArrayList<>();
        toJamo(wakeWord, w, new ArrayList<>());
        if (t.isEmpty() || w.size() < 2) return new Result(false, "", Integer.MAX_VALUE);
        int tol = tolerance(w.size());

        List<Integer> starts = new ArrayList<>();
        List<Integer> ends = new ArrayList<>();
        for (int k = 0; k < t.size(); k++) {
            if (k == 0 || !ti.get(k).equals(ti.get(k - 1))) starts.add(k);
            if (k == t.size() - 1 || !ti.get(k).equals(ti.get(k + 1))) ends.add(k);
        }
        int bestD = Integer.MAX_VALUE;
        int bestEnd = -1;
        for (int s : starts) {
            for (int e : ends) {
                int len = e - s + 1;
                if (len < w.size() - tol || len > w.size() + tol) continue;
                int d = distance(t.subList(s, e + 1), w);
                if (d < bestD || (d == bestD && e < bestEnd)) { bestD = d; bestEnd = e; }
            }
        }
        if (bestD > tol) return new Result(false, "", bestD);

        int lastChar = ti.get(bestEnd);
        String rest = transcript.substring(lastChar + 1).replaceAll("^[\\s,.!?~]+", "").trim();
        if (lettersIn(rest) <= 1) rest = "";
        return new Result(true, rest, bestD);
    }

    /** 여러 후보 중 가장 잘 맞는 것 */
    public static Result matchAny(List<String> candidates, String wakeWord) {
        Result best = new Result(false, "", Integer.MAX_VALUE);
        for (String c : candidates) {
            Result r = match(c, wakeWord);
            if (r.matched && r.score < best.score) best = r;
            if (best.matched && best.score == 0) break;
        }
        return best;
    }
}
