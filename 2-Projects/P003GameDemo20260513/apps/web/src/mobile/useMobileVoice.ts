import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getSharedVoiceClient,
  getKidsHubSessionId,
  type VoiceClient,
} from '../services/voice-client';
import { useAppStore } from '../store/app-store';
import { useAvatarStore } from '../kidshub/avatar/avatar-store';
import { resolveExpressionName } from '../kidshub/avatar/expressions';
import { useKidsHubStore, getComposedPromptNow } from '../kidshub/store/kidshub-store';
import {
  isWakeWordAvailable,
  pauseWakeListening,
  registerWebBridge,
  startWakeListening,
} from './bridge';

/**
 * 移动端语音控制 hook —— 复刻 CanvasHost 的 voice-client 接线（连接/重连 + 字幕 rAF +
 * 事件→store + PTT），剥离工作台专属逻辑，增加「唤醒词麦克风仲裁」（前台原生 Porcupine
 * 与 Web getUserMedia 互斥）。
 *
 * 麦克风互斥（team 四发共识）：
 * - idle 且原生唤醒可用 → startWakeListening()，原生独占麦克风跑 Porcupine
 * - 开录音（PTT 或唤醒触发）前 → pauseWakeListening()，原生释放麦克风
 * - 一轮对话播完/出错/打断/录音无回复超时 → 回 idle，恢复 startWakeListening()
 *
 * 健壮性修复（team 四发代码审查 2026-06-19，合并 main 前质量门）：
 * - actionInFlightRef 覆盖整个异步启动（connect+record）→ 防极短按/卸载/并发录音泄漏
 * - mountedRef + 卸载兜底 stopRecording → 防离开页面麦克风后台泄漏
 * - bargeIn 清录音状态 + timer → 防双重占麦/锁死
 * - finishTurn thinking 超时兜底 → 防录音后无回复卡死、唤醒永久暂停
 * - beginTurn/finishTurn 用 ref 解耦，Bridge effect 依赖 [] 只注册一次 → 防重订阅抖动
 * - onNativeReady 检查 !pressedRef → 防原生 ready 时正录音抢麦
 */

function getVoiceWsUrl(): string {
  const envUrl = (import.meta as any).env?.VITE_VOICE_WS_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl;
  const isHttps = window.location.protocol === 'https:';
  return `${isHttps ? 'wss' : 'ws'}://${window.location.host}/ws/voice`;
}

// 唤醒后自动录音窗口（demo：无端侧 VAD，固定时长后自动停；TODO 接 server 静音判停）
const WAKE_RECORD_MS = 6000;
// 录音后进入 thinking 但迟迟无任何回复（无 tts.audio）的兜底：回 idle + 恢复唤醒，防卡死
const THINKING_TIMEOUT_MS = 12000;

export interface MobileVoiceController {
  pressed: boolean;
  connected: boolean;
  wakeAvailable: boolean;
  listeningByWake: boolean;
  feedbackPressed: boolean;
  onPttDown: () => void;
  onPttUp: () => void;
  onFeedbackDown: () => void;
  onFeedbackUp: () => void;
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
  const [feedbackPressed, setFeedbackPressed] = useState(false);

  const pressedRef = useRef(false);
  // 覆盖「连接+录音」整个异步启动生命周期：防极短按松手后录音才启动、防并发 beginTurn
  const actionInFlightRef = useRef(false);
  const needStopRef = useRef(false);
  const wakeStopTimerRef = useRef<number | null>(null);
  const thinkingTimeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  // 供事件回调/timer 读最新值（避免闭包旧值）
  const wakeAvailableRef = useRef(false);
  wakeAvailableRef.current = wakeAvailable;
  const listeningByWakeRef = useRef(false);
  listeningByWakeRef.current = listeningByWake;

  const clearWakeStopTimer = () => {
    if (wakeStopTimerRef.current !== null) {
      window.clearTimeout(wakeStopTimerRef.current);
      wakeStopTimerRef.current = null;
    }
  };
  const clearThinkingTimeout = () => {
    if (thinkingTimeoutRef.current !== null) {
      window.clearTimeout(thinkingTimeoutRef.current);
      thinkingTimeoutRef.current = null;
    }
  };

  const resumeWakeIfIdle = useCallback(() => {
    if (wakeAvailableRef.current) startWakeListening();
  }, []);

  // 结束本轮录音（PTT 松手 / 唤醒窗口到期）
  const finishTurn = useCallback(() => {
    clearWakeStopTimer();
    if (!pressedRef.current) return;
    pressedRef.current = false;
    setPressed(false);
    setListeningByWake(false);
    setFeedbackPressed(false);

    const client = clientRef.current;
    if (!client) return;

    // 录音尚未真正启动（still connecting/starting）→ 标记待停，由 beginTurn 启动完成后收尾
    if (actionInFlightRef.current) {
      needStopRef.current = true;
      return;
    }
    client.stopRecording();
    setVoiceStatus('thinking');
    setXiaokeEmotion('calm');
    // 兜底：thinking 后迟迟无回复（无 tts.audio 清掉本 timer）→ 回 idle + 恢复唤醒
    clearThinkingTimeout();
    thinkingTimeoutRef.current = window.setTimeout(() => {
      thinkingTimeoutRef.current = null;
      if (mountedRef.current && useAppStore.getState().voiceStatus === 'thinking') {
        setVoiceStatus('idle');
        resumeWakeIfIdle();
      }
    }, THINKING_TIMEOUT_MS);
  }, [resumeWakeIfIdle, setVoiceStatus, setXiaokeEmotion]);

  const finishTurnRef = useRef(finishTurn);
  finishTurnRef.current = finishTurn;

  // 启动一轮录音（PTT 与唤醒共用）
  const beginTurn = useCallback(
    async (byWake: boolean, feedbackMode = false) => {
      // 唤醒触发的 6s 录音期间用户按住 PTT → 转为「按住模式」（清 6s 限制，按住一直说）
      // team 审查（gpt/gemini）：吐槽入口不走「唤醒转 PTT」分支（否则唤醒录音被误切成 feedback captureMode）。
      if (pressedRef.current && listeningByWakeRef.current && !byWake && !feedbackMode) {
        clearWakeStopTimer();
        setListeningByWake(false);
        setPressed(true);
        return;
      }
      // team 审查（gpt/gemini/grok）：已在录音/启动中时，吐槽入口直接早退，不抢占 PTT/唤醒录音、不混 captureMode。
      if (feedbackMode && (pressedRef.current || actionInFlightRef.current)) return;
      if (actionInFlightRef.current || pressedRef.current) return;
      const client = clientRef.current;
      if (!client) return;

      actionInFlightRef.current = true; // 首行置位：覆盖整个异步启动
      pressedRef.current = true;
      needStopRef.current = false;
      setPressed(!byWake && !feedbackMode);
      setListeningByWake(byWake);
      setFeedbackPressed(feedbackMode);
      pauseWakeListening();
      clearThinkingTimeout();

      try {
        try {
          await client.unlockAudio();
        } catch {
          /* 解锁失败不阻断 */
        }
        if (!mountedRef.current || needStopRef.current) throw new Error('__aborted__');

        if (!client.isConnected()) {
          applyNetState('connecting');
          await client.connect(getVoiceWsUrl());
          if (!mountedRef.current || needStopRef.current) throw new Error('__aborted__');
          setConnected(true);
          applyNetState('success');
          // 问题1 修复（docs/24）：移动端补发完整世界观 prompt（复用前端组装，含世界观 L1+L2+人设）。
          // 否则 server 回退极简 DEFAULT_SYSTEM_PROMPT，孩子听不到方舟世界观。新连接发一次即可（server 存住）。
          try {
            client.sendSessionConfig(getComposedPromptNow());
          } catch {
            /* best-effort：失败不阻断；server 端已有内置世界观基座兜底 */
          }
        }

        try {
          client.bargeIn();
        } catch {
          /* 容错 */
        }
        try {
          const vars = useKidsHubStore.getState().variables;
          client.sendSessionMeta({
            sessionId: getKidsHubSessionId(),
            sceneId: null,
            nickname: vars.nickname || '',
            gender: vars.gender || '',
            age: vars.age || '',
            captureMode: feedbackMode ? 'feedback' : 'off',
            source: 'card',
          });
        } catch {
          /* meta best-effort */
        }

        await client.startRecording();
        // 录音就绪前已松手/卸载 → 立即停，不留泄漏
        if (!mountedRef.current || needStopRef.current) {
          client.stopRecording();
          needStopRef.current = false;
          if (mountedRef.current) {
            setVoiceStatus('thinking');
            setXiaokeEmotion('calm');
          }
          return;
        }
        setVoiceStatus('listening');
        setXiaokeEmotion('curious');
        if (byWake) {
          clearWakeStopTimer();
          wakeStopTimerRef.current = window.setTimeout(() => {
            wakeStopTimerRef.current = null;
            finishTurnRef.current();
          }, WAKE_RECORD_MS);
        }
      } catch (err) {
        const aborted = err instanceof Error && err.message === '__aborted__';
        pressedRef.current = false;
        needStopRef.current = false;
        setPressed(false);
        setListeningByWake(false);
        if (mountedRef.current) {
          setVoiceStatus('idle');
          if (!aborted) {
            setSubtitle(err instanceof Error ? err.message : '网络好像不太好，待会再试试～');
            applyNetState('fail');
          }
        }
        resumeWakeIfIdle();
      } finally {
        actionInFlightRef.current = false;
      }
    },
    [applyNetState, resumeWakeIfIdle, setSubtitle, setVoiceStatus, setXiaokeEmotion],
  );

  const beginTurnRef = useRef(beginTurn);
  beginTurnRef.current = beginTurn;

  const onPttDown = useCallback(() => {
    void beginTurn(false);
  }, [beginTurn]);

  const onPttUp = useCallback(() => {
    finishTurn();
  }, [finishTurn]);

  // 问题4（docs/24）：按住吐槽 = captureMode:'feedback' 录音（复用 kidshub 吐槽链路：
  // server 落反馈库 + 吐槽人格回应）。按住录、松手提交，与 PTT 同收尾。
  const onFeedbackDown = useCallback(() => {
    void beginTurn(false, true);
  }, [beginTurn]);

  const onFeedbackUp = useCallback(() => {
    finishTurn();
  }, [finishTurn]);

  const bargeIn = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    clearWakeStopTimer();
    clearThinkingTimeout();
    // 录音中打断 → 先收尾录音状态，避免 pressedRef 残留锁死 + 双重占麦
    if (pressedRef.current) {
      pressedRef.current = false;
      setPressed(false);
      setListeningByWake(false);
      setFeedbackPressed(false);
      try {
        client.stopRecording();
      } catch {
        /* 容错 */
      }
    }
    try {
      client.bargeIn();
    } catch {
      /* 容错 */
    }
    setVoiceStatus('idle');
    setSubtitle('');
    resumeWakeIfIdle();
  }, [resumeWakeIfIdle, setSubtitle, setVoiceStatus]);

  // 挂载/卸载守卫：卸载时兜底停录音，防麦克风后台泄漏
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearWakeStopTimer();
      clearThinkingTimeout();
      const client = clientRef.current;
      if (client) {
        try {
          client.stopRecording();
        } catch {
          /* 容错 */
        }
      }
    };
  }, []);

  // 连接状态轮询 + 断线静默重连（节流 5s；录音/启动中不抢连接，voice-client 内部亦有 connectPromise 防重）
  const lastReconnectAtRef = useRef(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      const c = clientRef.current;
      const ok = !!(c && c.isConnected());
      setConnected(ok);
      if (
        !ok &&
        c &&
        !actionInFlightRef.current &&
        Date.now() - lastReconnectAtRef.current > 5_000
      ) {
        lastReconnectAtRef.current = Date.now();
        c.connect(getVoiceWsUrl()).catch(() => {});
      }
    }, 800);
    return () => window.clearInterval(id);
  }, []);

  // voice-client 事件接线（字幕 rAF + 状态机 + 表情）。
  // 跨 render 私有状态用 ref（speakingRef/lastShownCueRef）防 effect 重建时丢失播放上下文。
  const speakingRef = useRef(false);
  const lastShownCueRef = useRef('');
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;

    let clearTimer: number | null = null;
    let rafId: number | null = null;
    const cancelClear = () => {
      if (clearTimer !== null) {
        window.clearTimeout(clearTimer);
        clearTimer = null;
      }
    };
    const tick = () => {
      if (speakingRef.current) {
        const cue = client.getCurrentSubtitleCue();
        if (cue !== null && cue !== lastShownCueRef.current) {
          lastShownCueRef.current = cue;
          setSubtitle(cue);
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    const onAsrPartial = (msg: { text: string }) => {
      speakingRef.current = false;
      cancelClear();
      lastShownCueRef.current = '';
      setSubtitle(msg.text);
    };
    const onAsrFinal = (msg: { text: string }) => {
      speakingRef.current = false;
      cancelClear();
      lastShownCueRef.current = '';
      setSubtitle(`${msg.text}...`);
    };
    const onLlmDelta = (msg: { text: string }) => {
      if (!msg.text) return;
      clearThinkingTimeout(); // 有回复了，撤销无回复兜底
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
    };
    const onTtsAudio = () => {
      clearThinkingTimeout();
      speakingRef.current = true;
      cancelClear();
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
      // 需求2：小可说话时开唤醒监听（此刻 Web 不录音、麦空闲），让「小可小可」能打断。
      // 原生 KWS 用 VOICE_RECOGNITION+AcousticEchoCanceler 抑制 TTS 自声回声（见 WakeWordBridge.kt）。
      if (wakeAvailableRef.current) startWakeListening();
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
      speakingRef.current = false;
      cancelClear();
      const snapshot = useAppStore.getState().subtitle;
      clearTimer = window.setTimeout(() => {
        clearTimer = null;
        if (useAppStore.getState().subtitle !== snapshot) return;
        lastShownCueRef.current = '';
        setSubtitle('');
      }, 1200);
      // team 审查（gemini/gpt 高风险）：唤醒打断时 onWakeWord 会同步 bargeIn→本回调，紧接着设 listening+beginTurn。
      // 若此刻已在录音/启动中，绝不能重置 idle / 恢复 KWS（会覆盖 listening 态 + 抢麦）。仅真正空闲收尾才走。
      if (!pressedRef.current && !actionInFlightRef.current) {
        setVoiceStatus('idle');
        if (wakeAvailableRef.current) startWakeListening();
      }
    };
    const onAvatarExpression = (msg: { name: string; index: number }) => {
      const def = resolveExpressionName(msg.name);
      if (def) enqueueLlmExpression(def.id, msg.index ?? 0);
    };
    const onError = (msg: { message?: string; code?: string }) => {
      // 统一收尾：清 timer + 重置录音 ref + 回 idle + 恢复唤醒
      clearWakeStopTimer();
      clearThinkingTimeout();
      pressedRef.current = false;
      setPressed(false);
      setListeningByWake(false);
      setFeedbackPressed(false);
      speakingRef.current = false;
      cancelClear();
      lastShownCueRef.current = '';
      const t = msg.message || msg.code || '小可走神了一下，再说一次好吗～';
      setVoiceStatus('idle');
      setSubtitle(t);
      applyNetState('fail');
      resumeWakeIfIdle();
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
    resumeWakeIfIdle,
    setSubtitle,
    setVoiceStatus,
    setXiaokeEmotion,
  ]);

  // 唤醒词 Bridge 注册 + 能力探测 + 进入即开监听（beginTurnRef 解耦 → 依赖 [] 只注册一次）
  useEffect(() => {
    const avail = isWakeWordAvailable();
    setWakeAvailable(avail);
    const unregister = registerWebBridge({
      onWakeWord: () => {
        // 重入早退：已在录音/启动中则忽略重复唤醒（beginTurn 内亦有防护，这里早退避免多余 bargeIn/playCue）
        if (pressedRef.current || actionInFlightRef.current) return;
        const client = clientRef.current;
        // 需求2：小可说话中被唤醒 → 先打断 TTS。bargeIn 同步 emit tts.playback_end（→onPlaybackEnd 置 idle），
        // 紧接着下面同步覆盖为 listening（React 批处理同一执行栈，不闪 idle）。
        if (speakingRef.current && client) {
          try {
            client.bargeIn();
          } catch {
            /* 容错 */
          }
        }
        // 需求1：立即切聆听态 + 本地即时确认音（先于 connect/录音，衔接云端 LLM+TTS 延时空窗）
        setVoiceStatus('listening');
        setXiaokeEmotion('curious');
        if (client) {
          try {
            client.playCue();
          } catch {
            /* 容错 */
          }
        }
        void beginTurnRef.current(true);
      },
      onNativeReady: (info) => {
        setWakeAvailable(!!info.wakeWordAvailable);
        // 原生 ready 时若正在录音 → 不抢麦，等本轮结束 playback_end 再恢复
        if (info.wakeWordAvailable && !pressedRef.current) startWakeListening();
      },
    });
    if (avail) startWakeListening();
    return () => {
      unregister();
      pauseWakeListening();
      clearWakeStopTimer();
    };
  }, []);

  return {
    pressed,
    connected,
    wakeAvailable,
    listeningByWake,
    feedbackPressed,
    onPttDown,
    onPttUp,
    onFeedbackDown,
    onFeedbackUp,
    bargeIn,
  };
}
