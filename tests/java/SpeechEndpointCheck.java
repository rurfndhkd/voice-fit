package com.voicefit.app;

public class SpeechEndpointCheck {
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    static SpeechEndpoint spoken() {
        SpeechEndpoint ep = new SpeechEndpoint(0, 5000, 30000, SpeechEndpoint.SILENCE_MS);
        for (int t = 0; t <= 200; t += 20) check(!ep.feed(true, t));
        check(ep.heard()); return ep;
    }
    public static void main(String[] args) {
        SpeechEndpoint ep = spoken();
        check(!ep.feed(false, 1699)); check(ep.feed(false, 1700));
        ep = spoken(); ep.feed(false, 1600);
        for (int t = 1680; t <= 1780; t += 20) check(!ep.feed(true, t));
        check(!ep.feed(false, 3279)); check(ep.feed(false, 3280));
        ep = spoken(); ep.feed(false, 500); ep.feed(true, 1000); ep.feed(false, 1020);
        check(ep.feed(false, 1700));
        ep = new SpeechEndpoint(0, 5000, 30000, SpeechEndpoint.SILENCE_MS);
        ep.feed(true, 100); ep.feed(false, 120);
        check(!ep.feed(false, 1500)); check(!ep.feed(false, 4999));
        check(ep.feed(false, 5000)); check(!ep.heard());
        ep = spoken(); check(!ep.feed(true, 29999)); check(ep.feed(true, 30000));
        System.out.println("Native endpoint: boundary, resume, click, no-speech and max-duration passed");
    }
}
