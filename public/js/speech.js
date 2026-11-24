// 음성 엔진: 듣기(listenOnce)와 말하기(speak)를 환경에 맞게 제공한다.
//  - native : 안드로이드 앱 (직접 만든 VoiceListener 플러그인 + TextToSpeech 플러그인)
//  - browser: 크롬 등 Web Speech API
//  - openai : 녹음 → 사용자 키로 OpenAI Whisper 직접 호출. 말이 끝나면 자동으로 멈춘다(간단한 음량 감지).
import { isNative, nativePlugin } from './config.js';
import { transcribeWithAI, synthesizeWithAI } from './ai.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const browserRecognitionSupported = Boolean(SR);
export const recordingSupported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

export class VoiceError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const ERROR_TEXT = {
  'not-allowed': '마이크 권한이 거부됐어요. 설정에서 마이크를 허용해 주세요.',
  'service-not-allowed': '마이크 권한이 거부됐어요. 설정에서 마이크를 허용해 주세요.',
  'audio-capture': '마이크를 찾을 수 없어요.',
  network: '음성인식 네트워크 오류예요.',
  upstream: 'AI 음성인식 서버에 연결하지 못했어요.',
  quota: 'OpenAI 사용 한도나 잔액을 확인해 주세요. 이번 말은 처리하지 않았어요.',
  'invalid-key': 'OpenAI 키를 확인해 주세요. 이번 말은 처리하지 않았어요.',
};
export const voiceErrorText = (e) => ERROR_TEXT[e?.code] || '음성 입력을 쓸 수 없어요. 입력창을 써 주세요.';

/*
 * 모든 엔진 공통:
 *   listenOnce({ timeoutMs, onInterim, onReady, onLevel }) → Promise<string|null>
 *   engine.candidates : 마지막 듣기에서 나온 모든 후보 문장(최종 후보 + 중간 결과). 호출어 판별을 넓게 하기 위함
 */

/* ---------------- 브라우저 ---------------- */
function browserEngine() {
  let current = null;
  const engine = {
    kind: 'browser',
    candidates: [],
    listenOnce({ timeoutMs = 0, onInterim, onReady } = {}) {
      return new Promise((resolve, reject) => {
        const rec = new SR();
        rec.lang = 'ko-KR';
        rec.interimResults = true;
        rec.continuous = false;
        rec.maxAlternatives = 5;
        const seen = new Set();
        let finalText = '';
        let latest = '';
        let heard = false;
        let error = null;
        let settled = false;
        engine.candidates = [];
        const timer = timeoutMs ? setTimeout(() => { if (!heard) rec.abort(); }, timeoutMs) : null;
        rec.onaudiostart = () => onReady?.();
        rec.onspeechstart = () => { heard = true; };
        rec.onresult = (ev) => {
          heard = true;
          let interim = '';
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const r = ev.results[i];
            for (let a = 0; a < r.length; a++) if (r[a]?.transcript) seen.add(r[a].transcript.trim());
            if (r.isFinal) finalText += r[0].transcript;
            else interim += r[0].transcript;
          }
          latest = finalText + interim;
          if (latest.trim()) seen.add(latest.trim());
          onInterim?.(latest);
        };
        rec.onerror = (ev) => { if (!['no-speech', 'aborted', 'no-match'].includes(ev.error)) error = ev.error; };
        rec.onend = () => {
          clearTimeout(timer);
          current = null;
          if (settled) return;
          settled = true;
          const text = (finalText || latest).trim();
          engine.candidates = [...seen];
          if (error && !text) reject(new VoiceError(error));
          else resolve(text || null);
        };
        current = rec;
        try { rec.start(); } catch (e) { settled = true; reject(new VoiceError('start-failed', e.message)); }
      });
    },
    cancel() { try { current?.abort(); } catch { /* 이미 종료 */ } },
    stop() { try { current?.stop(); } catch { /* 이미 종료 */ } },
  };
  return engine;
}

/* ---------------- 녹음 + Whisper ---------------- */
function recorderEngine() {
  let cancelCurrent = null;
  return {
    kind: 'openai',
    candidates: [],
    async listenOnce({ timeoutMs = 0, maxMs = 15000, onInterim } = {}) {
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { throw new VoiceError('not-allowed'); }
      const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

      // 간단한 음량 감지: 말을 시작했는지, 말이 끝났는지(1.2초 조용함) 판단
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let heard = false;
      let lastLoud = performance.now();
      const started = performance.now();
      let cancelled = false;

      const stopped = new Promise((res) => { recorder.onstop = res; });
      recorder.start(250);
      onInterim?.('듣고 있어요…');

      await new Promise((res) => {
        cancelCurrent = () => { cancelled = true; res(); };
        const tick = () => {
          if (cancelled) return;
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += (v - 128) ** 2;
          const rms = Math.sqrt(sum / buf.length);
          const now = performance.now();
          if (rms > 12) { heard = true; lastLoud = now; }
          if (!heard && timeoutMs && now - started > timeoutMs) return res();
          if (heard && now - lastLoud > 1200) return res();
          if (now - started > maxMs) return res();
          requestAnimationFrame(tick);
        };
        tick();
      });
      cancelCurrent = null;
      if (recorder.state === 'recording') recorder.stop();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
      if (cancelled || !heard || !chunks.length) return null;

      onInterim?.('변환 중…');
      const fd = new FormData();
      fd.append('audio', new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), 'speech');
      try {
        return await transcribeWithAI(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      } catch {
        throw new VoiceError('upstream');
      }
    },
    cancel() { cancelCurrent?.(); },
  };
}

/* ---------------- 안드로이드 앱 ---------------- */
// 직접 만든 VoiceListener 플러그인 사용 (android/.../VoiceListenerPlugin.java).
// 결과든 오류든 항상 speechEnd 가 오므로 듣기가 멈춰 버리지 않는다.
function nativeEngine() {
  const plugin = nativePlugin('VoiceListener');
  let cancelCurrent = null;
  let permissionOk = false;
  // 소음 배제(음성 감지 기준): 기준보다 작은 소리로 들어온 말은 무시한다 (오버워치의 '음성 감지 기준'과 같은 방식)
  const gate = { enabled: false, level: 5 };
  let offlineUnavailable = false; // 기기에 오프라인 한국어 모델이 없으면 온라인으로 돌아간다
  const engine = {
    kind: 'native',
    candidates: [],
    gateSupported: true,
    setGate({ enabled, level, voiceLock }) {
      gate.enabled = Boolean(enabled);
      gate.level = Number(level) || 0;
      gate.voiceLock = Boolean(voiceLock);
    },
    /** 내 목소리 등록: ms 동안 녹음 → 폰 안에서 목소리 지문 생성·저장. { ok, reason?, wav(base64) } */
    enrollVoice: (ms) => plugin.enrollVoice({ durationMs: ms }),
    voiceStatus: () => plugin.voiceStatus().catch(() => ({ enrolled: false })),
    clearVoice: () => plugin.clearVoice().catch(() => {}),
    /** keepBacklog: 직전 듣기 뒤에 들어온 소리를 이어 붙임 (카운트 중 다시 시작하는 틈 보완) */
    async listenOnce({ timeoutMs = 0, mode = 'normal', keepBacklog = false, onInterim, onReady, onLevel, onSpeech } = {}) {
      if (!permissionOk) {
        const p = await plugin.ensurePermission().catch(() => null);
        if (!p?.granted) throw new VoiceError('not-allowed');
        permissionOk = true;
      }
      engine.candidates = [];
      const seen = new Set();
      let finalText = '';
      let latest = '';
      let heard = false;
      let errorCode = null;
      const handles = [];
      let settled = false;
      let resolveFn;
      const done = new Promise((r) => { resolveFn = r; });
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(safety);
        cancelCurrent = null;
        handles.forEach((h) => h.remove?.());
        engine.candidates = [...seen];
        resolveFn();
      };
      const add = (d) => {
        if (d?.text) seen.add(d.text.trim());
        for (const a of d?.alternatives || []) if (a) seen.add(String(a).trim());
      };
      handles.push(await plugin.addListener('speechReady', () => onReady?.()));
      handles.push(await plugin.addListener('speechBegin', () => { heard = true; onSpeech?.(); }));
      // 최근 1.5초 안에 기준 이상 큰 소리가 있었는지 (말한 시점과 인식 결과 사이 지연을 감안)
      const levels = [];
      let sessionPeak = -Infinity;
      const loudRecently = () => {
        const since = Date.now() - 1500;
        return levels.some((x) => x.t >= since && x.level >= gate.level);
      };
      // 앱이 마이크를 직접 받아 거르는 모드면(capture) 이미 걸러진 소리라 여기서는 다시 거르지 않는다
      let filteredNatively = false;
      const passes = () => filteredNatively || !gate.enabled || loudRecently();
      handles.push(await plugin.addListener('speechLevel', (d) => {
        const level = Number(d?.level ?? 0);
        levels.push({ t: Date.now(), level });
        if (levels.length > 60) levels.shift();
        sessionPeak = Math.max(sessionPeak, level);
        onLevel?.(level);
      }));
      handles.push(await plugin.addListener('speechPartial', (d) => {
        if (!passes()) return; // 작은 소리(주변 소음·먼 목소리)로 들어온 말은 무시
        heard = true;
        onSpeech?.();
        add(d);
        latest = d?.text || latest;
        onInterim?.(latest);
      }));
      handles.push(await plugin.addListener('speechFinal', (d) => {
        if (!filteredNatively && gate.enabled && sessionPeak < gate.level) return; // 기준 이상 큰 소리가 한 번도 없었음 → 주변 소리로 보고 버림
        seen.clear(); // Never replace a final correction with an earlier partial hypothesis.
        add(d);
        finalText = d?.text || latest;
      }));
      handles.push(await plugin.addListener('speechError', (d) => { errorCode = d?.code || 'other'; }));
      handles.push(await plugin.addListener('speechEnd', finish));

      const timer = timeoutMs ? setTimeout(() => { if (!heard) plugin.cancel().catch(() => {}); }, timeoutMs) : null;
      // 기기 음성인식이 아무 신호도 주지 않는 경우를 대비한 안전장치
      const safety = setTimeout(() => { plugin.cancel().catch(() => {}); finish(); }, 30000);
      cancelCurrent = () => { finalText = ''; latest = ''; seen.clear(); plugin.cancel().catch(() => {}); finish(); };

      try {
        // 카운트 모드: 숫자 사이에 쉬어도 끊기지 않게 오래 듣고, 기기 안 인식으로 지연을 줄인다
        const opts = mode === 'count'
          ? { language: 'ko-KR', silenceMs: 4000, minLengthMs: 30000, preferOffline: !offlineUnavailable }
          : { language: 'ko-KR', silenceMs: 1500, endSilenceMs: 1500 }; // 내 목소리가 1.5초 없으면 그때까지 한 말로 처리
        const filter = { gateEnabled: gate.enabled, gateLevel: gate.level, voiceLock: gate.voiceLock, keepBacklog };
        const started = await plugin.start({ ...opts, ...filter });
        filteredNatively = Boolean(started?.capture) && (gate.enabled || gate.voiceLock);
      } catch {
        errorCode = 'start-failed';
        finish();
      }
      const startedAt = Date.now();
      await done;
      if (mode === 'count' && !offlineUnavailable && !finalText && !latest
        && (errorCode === 'language' || (errorCode === 'other' && Date.now() - startedAt < 1500))) {
        offlineUnavailable = true;
      }
      const text = (finalText || latest).trim();
      if (!text && errorCode === 'permission') throw new VoiceError('not-allowed');
      if (!text && errorCode === 'audio') throw new VoiceError('audio-capture');
      return text || null;
    },
    cancel() { cancelCurrent?.(); },
    stop() { plugin.stop().catch(() => {}); },
  };
  return engine;
}

/** Native microphone selection + complete PCM utterance -> OpenAI. Wake/count stay local. */
export function nativeCloudEngine() {
  const local = nativeEngine();
  const plugin = nativePlugin('VoiceListener');
  let operation = null;
  let recording = Promise.resolve();
  const engine = {
    ...local,
    kind: 'native-openai',
    cloudTranscription: true,
    candidates: [],
    async listenOnce(options = {}) {
      if (['wake', 'count', 'signal', 'calibrate'].includes(options.mode)) {
        const text = await local.listenOnce(options);
        engine.candidates = local.candidates;
        return text;
      }
      engine.cancel();
      const ctrl = new AbortController();
      operation = ctrl;
      const handles = [];
      const id = crypto.randomUUID();
      try {
        await recording.catch(() => {}); // old recording releases the microphone before the next starts
        if (ctrl.signal.aborted) return null;
        const p = await plugin.ensurePermission();
        if (!p?.granted) throw new VoiceError('not-allowed');
        if (ctrl.signal.aborted) return null;
        handles.push(await plugin.addListener('recordReady', (e) => { if (e.id === id) options.onReady?.(); }));
        handles.push(await plugin.addListener('recordLevel', (e) => {
          if (e.id !== id || ctrl.signal.aborted) return;
          options.onLevel?.(e.level);
          if (e.speech) options.onSpeech?.();
        }));
        if (ctrl.signal.aborted) return null;
        engine.candidates = [];
        recording = plugin.recordUtterance({ id, waitMs: options.timeoutMs || 30000, maxMs: 30000, silenceMs: 1800 });
        const result = await recording;
        if (ctrl.signal.aborted || !result.wav) return null;
        options.onProcessing?.();
        const bytes = Uint8Array.from(atob(result.wav), (c) => c.charCodeAt(0));
        const text = await transcribeWithAI(new Blob([bytes], { type: 'audio/wav' }), { signal: ctrl.signal, context: options.context });
        if (ctrl.signal.aborted) return null;
        engine.candidates = text ? [text] : [];
        return text;
      } catch (e) {
        if (ctrl.signal.aborted) return null;
        throw e instanceof VoiceError ? e : new VoiceError(e.code || 'upstream');
      } finally {
        for (const h of handles) await h.remove?.();
        if (operation === ctrl) operation = null;
      }
    },
    cancel() {
      local.cancel();
      if (operation) { operation.abort(); plugin.cancelRecording().catch(() => {}); }
    },
    stop() {
      if (operation) plugin.stopRecording().catch(() => {});
      else local.stop();
    },
  };
  return engine;
}

/** 설정과 환경에 맞는 음성 엔진을 만든다. 쓸 수 없으면 null. */
export function createVoiceEngine(pref = 'auto', aiAvailable = false) {
  if (isNative && nativePlugin('VoiceListener')) {
    return aiAvailable && pref !== 'browser' ? nativeCloudEngine() : nativeEngine();
  }
  if (pref === 'openai' && recordingSupported) return recorderEngine();
  if (browserRecognitionSupported) return browserEngine();
  if (recordingSupported && aiAvailable) return recorderEngine();
  return null;
}

/* ---------------- 말하기 ---------------- */
let koVoice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  koVoice ||= speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith('ko')) || null;
  return koVoice;
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { koVoice = null; pickVoice(); };

/** 다 말할 때까지 기다리는 Promise 를 돌려준다. (듣기 전에 끝까지 말해야 자기 목소리를 듣지 않는다) */
function speakLocal(text, rate = 1) {
  if (!text) return Promise.resolve();
  const tts = isNative && nativePlugin('TextToSpeech');
  if (tts) {
    return tts.speak({ text, lang: 'ko-KR', rate, pitch: 1, volume: 1, category: 'playback' }).catch(() => {});
  }
  if (!('speechSynthesis' in window)) return Promise.resolve();
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.rate = rate;
    const v = pickVoice();
    if (v) u.voice = v;
    const safety = setTimeout(resolve, 1500 + text.length * 220 / rate);
    u.onend = u.onerror = () => { clearTimeout(safety); resolve(); };
    speechSynthesis.speak(u);
  });
}

let cloudSpeech = null;
let speechEpoch = 0;
const voiceCache = new Map(); // short repeated replies only, memory-only, bounded

export async function speak(text, rate = 1, { cloud = false } = {}) {
  stopSpeaking();
  const epoch = speechEpoch;
  if (!cloud || !text) return speakLocal(text, rate);
  const ctrl = new AbortController();
  const task = { ctrl, audio: null, finish: null };
  cloudSpeech = task;
  let url;
  try {
    const key = `${rate}:${text}`;
    let blob = voiceCache.get(key);
    if (!blob) {
      blob = await synthesizeWithAI(text, { signal: ctrl.signal, rate });
      if (blob && text.length < 120) {
        voiceCache.set(key, blob);
        if (voiceCache.size > 16) voiceCache.delete(voiceCache.keys().next().value);
      }
    }
    if (ctrl.signal.aborted || epoch !== speechEpoch) return;
    if (!blob) return speakLocal(text, rate);
    url = URL.createObjectURL(blob);
    const audio = task.audio = new Audio(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { audio.pause(); reject(new Error('tts-timeout')); }, 45000);
      task.finish = () => { clearTimeout(timer); resolve(); };
      audio.onended = task.finish;
      audio.onerror = () => { clearTimeout(timer); reject(new Error('tts-playback')); };
      audio.play().catch((e) => { clearTimeout(timer); reject(e); });
    });
  } catch {
    if (!ctrl.signal.aborted && epoch === speechEpoch) await speakLocal(text, rate);
  } finally {
    if (url) URL.revokeObjectURL(url);
    if (cloudSpeech === task) cloudSpeech = null;
  }
}

export function stopSpeaking() {
  speechEpoch++;
  if (cloudSpeech) {
    cloudSpeech.ctrl.abort();
    cloudSpeech.audio?.pause();
    cloudSpeech.finish?.();
    cloudSpeech = null;
  }
  const tts = isNative && nativePlugin('TextToSpeech');
  if (tts) tts.stop().catch(() => {});
  else if ('speechSynthesis' in window) speechSynthesis.cancel();
}
