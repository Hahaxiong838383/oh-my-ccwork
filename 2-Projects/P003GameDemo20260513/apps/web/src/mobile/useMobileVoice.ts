import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getSharedVoiceClient,
  getKidsHubSessionId,
  type VoiceClient,
} from '../services/voice-client';
import { useAppStore } from '../store/app-store';
import { useAvatarStore } from '../kidshub/avatar/avatar-store';
import { resolveExpressionName } from '../kidshub/avatar/expressions';
import { useKidsHubStore } from '../kidshub/store/kidshub-store';
import {
  isWakeWordAvailable,
  pauseWakeListening,
  registerWebBridge,
  startWakeListening,
} from './bridge';

/**
 * 移动端语音控制 hook —— 复刻 CanvasHost 的 voice-client 接线（连接/重连 + 字幕 rAF +
 * 事件→store + PTT），剥离工作台专属逻辑（tutorial/吐槽/限额/调试流/perf），
 * 增加「唤醒词麦克风仲裁」（前台原生 Porcupine 与 Web getUserMedia 互斥）。
 *
 * 麦克风互斥（team 四发共识）：
 * - idle 且原生唤醒可用 → startWakeListening()，原生独占麦克风跑 Porcupine
 * - 开录音（PTT 或唤醒触发）前 → pauseWakeListening()，原生释放麦克风
 * - 一轮对话播完 → 回到 idle，恢复 startWakeListening()
 */

function getVoiceWsUrl(): string {
  const envUrl = (import.meta as any).env?.VITE_VOICE_WS_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl;
  const isHttps = window.location.protocol === 'https:';
  return `${isHttps ? 'wss' : 'ws'}://${window.location.host}/ws/voice`;
}

// 唤醒后自动录音窗口（demo：无端侧 VAD，固定时长后自动停；TODO 接 server 静音判停）
const WAKE_RECORD_MS = 6000;

export interface MobileVoiceController {
  /** PTT 按住中 */
  pressed: boolean;
  /** WS 已连接 */
  connected: boolean;
  /** 原生唤醒词可用（决定是否显示「喊小可小可」提示） */
  wakeAvailable: boolean;
  /** 当前这轮录音是唤醒触发的（UI 高亮区分） */
  listeningByWake: boolean;
  onPttDown: () => void;
  onPttUp: () => void;
  /** 打断小可（点屏幕任意处可调） */
  bargeIn: () => void;
}

export function useMobileVoice(): MobileVoiceController {
  const clientRef = useRef<VoiceClient | null>(null);
  if (!clientRef.current) clientRef.current = getSharedVoiceClient();

  const setVoiceStatus = useAppStore((s) => s.setVoiceStatus);
  const setSubtitle = useAppStore((s) => s.setSubtitle);
  const setXiaokeEmotion = useAppStore((s) => s.setXiaokeEmotion);
  const enqueueLlmExpression = useAvatarStore((s) => s.enqueueLlmExpression);
  const consumeNextExpression = useAvatarStore((s) => s.consumeNextExpression);
  const applyNetState = useAvatarStore((s) => s.applyNetState);
  const endAvatarTurn = useAvatarStore((s) => s.endTurn);

  const [pressed, setPressed] = useState(false);
  const [connected, setConnected] = useState(false);
  const [wakeAvailable, setWakeAvailable] = useState(false);
  const [listeningByWake, setListeningByWake] = useState(false);

  const pressedRef = useRef(false);
  const startInFlightRef = useRef(false);
  const needStopRef = useRef(false);
  const llmTextRef = useRef('');
  const wakeStopTimerRef = useRef<number | null>(null);
  // 原生唤醒可用性存 ref，事件回调里读最新值（避免闭包旧值）
  const wakeAvailableRef = useRef(false);
  wakeAvailableRef.current = wakeAvailable;

  const clearWakeStopTimer = () => {
    if (wakeStopTimerRef.current !== null) {
      window.clearTimeout(wakeStopTimerRef.current);
      wakeStopTimerRef.current = null;
    }
  };

  // 一轮对话彻底结束（播完/打断）→ 回 idle，恢复原生唤醒监听
  const resumeWakeIfIdle = useCallback(() => {
    if (wakeAvailableRef.current) startWakeListening();
  }, []);

  // 启动一轮录音（PTT 与唤醒共用）。byWake=true 时定时自动停（无 VAD）
  const beginTurn = useCallback(
    async (byWake: boolean) => {
      if (startInFlightRef.current || pressedRef.current) return;
      const client = clientRef.current;
      if (!client) return;

      pressedRef.current = true;
      needStopRef.current = false;
      setPressed(!byWake);
      setListeningByWake(byWake);

      // 录音前：原生释放麦克风（唤醒触发时原生已自停，这里幂等再保险一次）
      pauseWakeListening();

      try {
        await client.unlockAudio();
      } catch {
        /* 解锁失败不阻断 */
      }

      if (!client.isConnected()) {
        applyNetState('connecting');
        try {
          await client.connect(getVoiceWsUrl());
          setConnected(true);
          applyNetState('success');
        } catch {
          pressedRef.current = false;
          setPressed(false);
          setListeningByWake(false);
          setSubtitle('网络好像不太好，待会再试试～');
          applyNetState('fail');
          resumeWakeIfIdle();
          return;
        }
      }

      client.bargeIn();
      // 移动端 demo：捕获关闭（不进吐槽后台），sceneId 留空走 server 默认小可陪伴人格
      try {
        const vars = useKidsHubStore.getState().variables;
        client.sendSessionMeta({
          sessionId: getKidsHubSessionId(),
          sceneId: null,
          nickname: vars.nickname || '',
          gender: vars.gender || '',
          age: vars.age || '',
          captureMode: 'off',
          source: 'card',
        });
      } catch {
        /* meta best-effort */
      }

      startInFlightRef.current = true;
      try {
        await client.startRecording();
        if (needStopRef.current) {
          // 录音就绪前就松手了（仅 PTT 路径）→ 立即停
          client.stopRecording();
          needStopRef.current = false;
          setVoiceStatus('thinking');
          setXiaokeEmotion('calm');
        } else {
          setVoiceStatus('listening');
          setXiaokeEmotion('curious');
          if (byWake) {
            // 唤醒触发：固定窗口后自动停（demo 无 VAD）
            clearWakeStopTimer();
            wakeStopTimerRef.current = window.setTimeout(() => {
              wakeStopTimerRef.current = null;
              finishTurn();
            }, WAKE_RECORD_MS);
          }
        }
      } catch (err) {
        pressedRef.current = false;
        needStopRef.current = false;
        setPressed(false);
        setListeningByWake(false);
        setVoiceStatus('idle');
        setSubtitle(err instanceof Error ? err.message : '麦克风没打开成功');
        resumeWakeIfIdle();
      } finally {
        startInFlightRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyNetState, resumeWakeIfIdle, setSubtitle, setVoiceStatus, setXiaokeEmotion],
  );

  // 结束本轮录音（PTT 松手 / 唤醒窗口到期）
  const finishTurn = useCallback(() => {
    clearWakeStopTimer();
    if (!pressedRef.current) return;
    pressedRef.current = false;
    setPressed(false);
    setListeningByWake(false);

    const client = clientRef.current;
    if (!client) return;

    if (startInFlightRef.current) {
      needStopRef.current = true;
      return;
    }
    client.stopRecording();
    setVoiceStatus('thinking');
    setXiaokeEmotion('calm');
    // 唤醒监听的恢复等本轮 TTS 播完（tts.playback_end）再做，避免抢麦
  }, [setVoiceStatus, setXiaokeEmotion]);

  const onPttDown = useCallback(() => {
    void beginTurn(false);
  }, [beginTurn]);

  const onPttUp = useCallback(() => {
    finishTurn();
  }, [finishTurn]);

  const bargeIn = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    client.bargeIn();
    setVoiceStatus('idle');
    setSubtitle('');
    resumeWakeIfIdle();
  }, [resumeWakeIfIdle, setSubtitle, setVoiceStatus]);

  // 连接状态轮询 + 断线静默重连（节流 5s）——复刻 CanvasHost
  const lastReconnectAtRef = useRef(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      const c = clientRef.current;
      const ok = !!(c && c.isConnected());
      setConnected(ok);
      if (!ok && c && Date.now() - lastReconnectAtRef.current > 5_000) {
        lastReconnectAtRef.current = Date.now();
        c.connect(getVoiceWsUrl()).catch(() => {});
      }
    }, 800);
    return () => window.clearInterval(id);
  }, []);

  // voice-client 事件接线（字幕 rAF + 状态机 + 表情）——精简自 CanvasHost
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;

    let speaking = false;
    let lastShownCue = '';
    let clearTimer: number | null = null;
    let rafId: number | null = null;
    const cancelClear = () => {
      if (clearTimer !== null) {
        window.clearTimeout(clearTimer);
        clearTimer = null;
      }
    };
    const tick = () => {
      if (speaking) {
        const cue = client.getCurrentSubtitleCue();
        if (cue !== null && cue !== lastShownCue) {
          lastShownCue = cue;
          setSubtitle(cue);
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    const onAsrPartial = (msg: { text: string }) => {
      speaking = false;
      cancelClear();
      lastShownCue = '';
      setSubtitle(msg.text);
    };
    const onAsrFinal = (msg: { text: string }) => {
      speaking = false;
      cancelClear();
      lastShownCue = '';
      setSubtitle(`${msg.text}...`);
      llmTextRef.current = '';
    };
    const onLlmDelta = (msg: { text: string }) => {
      if (!msg.text) return;
      llmTextRef.current += msg.text;
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
    };
    const onTtsAudio = () => {
      speaking = true;
      cancelClear();
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
    };
    const onTtsEnd = () => {
      setVoiceStatus('idle');
      setXiaokeEmotion('happy');
    };
    const onSegmentStart = () => {
      consumeNextExpression();
    };
    const onPlaybackEnd = () => {
      endAvatarTurn();
      speaking = false;
      cancelClear();
      const snapshot = useAppStore.getState().subtitle;
      clearTimer = window.setTimeout(() => {
        clearTimer = null;
        if (useAppStore.getState().subtitle !== snapshot) return;
        lastShownCue = '';
        setSubtitle('');
      }, 1200);
      setVoiceStatus('idle');
      // 一轮对话彻底结束 → 恢复原生唤醒监听（前台 idle）
      if (wakeAvailableRef.current) startWakeListening();
    };
    const onAvatarExpression = (msg: { name: string; index: number }) => {
      const def = resolveExpressionName(msg.name);
      if (def) enqueueLlmExpression(def.id, msg.index ?? 0);
    };
    const onError = (msg: { message?: string; code?: string }) => {
      const t = msg.message || msg.code || '小可走神了一下，再说一次好吗～';
      setVoiceStatus('idle');
      speaking = false;
      cancelClear();
      lastShownCue = '';
      setSubtitle(t);
      applyNetState('fail');
      if (wakeAvailableRef.current) startWakeListening();
    };

    client.on('asr.partial', onAsrPartial);
    client.on('asr.final', onAsrFinal);
    client.on('llm.delta', onLlmDelta);
    client.on('tts.audio', onTtsAudio);
    client.on('tts.end', onTtsEnd);
    client.on('tts.segment_start', onSegmentStart);
    client.on('tts.playback_end', onPlaybackEnd);
    client.on('avatar.expression', onAvatarExpression);
    client.on('error', onError);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      cancelClear();
      client.off('asr.partial', onAsrPartial);
      client.off('asr.final', onAsrFinal);
      client.off('llm.delta', onLlmDelta);
      client.off('tts.audio', onTtsAudio);
      client.off('tts.end', onTtsEnd);
      client.off('tts.segment_start', onSegmentStart);
      client.off('tts.playback_end', onPlaybackEnd);
      client.off('avatar.expression', onAvatarExpression);
      client.off('error', onError);
    };
  }, [
    applyNetState,
    consumeNextExpression,
    endAvatarTurn,
    enqueueLlmExpression,
    setSubtitle,
    setVoiceStatus,
    setXiaokeEmotion,
  ]);

  // 唤醒词 Bridge 注册 + 能力探测 + 进入即开监听
  useEffect(() => {
    const avail = isWakeWordAvailable();
    setWakeAvailable(avail);
    const unregister = registerWebBridge({
      onWakeWord: () => {
        // 原生已让出麦克风（契约约定）→ 直接开录音
        void beginTurn(true);
      },
      onNativeReady: (info) => {
        setWakeAvailable(!!info.wakeWordAvailable);
        if (info.wakeWordAvailable) startWakeListening();
      },
    });
    if (avail) startWakeListening();
    return () => {
      unregister();
      pauseWakeListening();
      clearWakeStopTimer();
    };
  }, [beginTurn]);

  return { pressed, connected, wakeAvailable, listeningByWake, onPttDown, onPttUp, bargeIn };
}
