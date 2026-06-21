import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getSharedVoiceClient,
  getKidsHubSessionId,
  type VoiceClient,
} from '../services/voice-client';
import { useAppStore } from '../store/app-store';
import { useAvatarStore } from '../kidshub/avatar/avatar-store';
import { resolveExpressionName } from '../kidshub/avatar/expressions';
import { useKidsHubStore, getMobileVoicePromptNow } from '../kidshub/store/kidshub-store';
import {
  isOnDeviceAsrAvailable,
  isWakeWordAvailable,
  notifyTtsState,
  pauseWakeListening,
  registerWebBridge,
  startAsr,
  startWakeListening,
  stopAsr,
} from './bridge';
import { detectExitIntent } from './exit-intent';

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
// 问题1 多轮（docs/24）：小可说完不立即 idle，自动开录音等接话，连续最多 N 轮（防无限空转）；超限/无接话退 idle。
const MAX_FOLLOWUP_TURNS = 4;
// 问题2 填充音（docs/24，team gemini）：thinking 后延迟播，快返回(<300ms)则取消避免一闪，>300ms 拉起。
const THINKING_CUE_DELAY_MS = 300;
// 问题3 退出意图（docs/25）：多轮等接话时静默超时分级——先温柔提醒，再自动告别退出。孩子一开口重置。
const IDLE_NUDGE_MS = 9000; // 等接话静默到此 → 温柔提醒一次（"还在吗～"）
const IDLE_EXIT_MS = 9000; // 提醒后再静默到此 → 自动告别退出
// 退出/提醒话术（儿童产品：温暖不生硬）
const EXIT_FAREWELL_TEXT = "小可先去休息啦～想我了就喊'小可小可'，我马上回来！";
const IDLE_NUDGE_TEXT = '还在吗？想休息的话跟我说一声，小可随时都在哦～';
// 退出兜底：sayDirect 告别若迟迟无 tts.playback_end（WS 异常等）→ 强制收尾回唤醒态，防卡死。
const EXIT_FALLBACK_MS = 8000;

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
  const thinkingCueTimerRef = useRef<number | null>(null);
  // 问题1：连续多轮计数（onWakeWord/PTT 主动发起时清零；超 MAX 或无接话退 idle 清零）
  const turnCountRef = useRef(0);
  const mountedRef = useRef(true);
  // 问题3 退出意图（docs/25）：
  // exitingRef —— 退出流程进行中（幂等门：L1 白名单/L2 [EXIT]/L3 idle 多路径触发只退一次）。
  // exitPendingRef —— L2 标记：本轮 llm.done 带 exit=true，等 tts.playback_end 播完告别后再退。
  // idleNudgeTimerRef / idleExitTimerRef —— L3 等接话静默分级定时器。
  // idleNudgedRef —— 本轮 idle 是否已提醒过一次（防重复提醒）。
  // exitFallbackTimerRef —— 退出告别无 playback_end 的兜底强制收尾。
  const exitingRef = useRef(false);
  const exitPendingRef = useRef(false);
  const idleNudgeTimerRef = useRef<number | null>(null);
  const idleExitTimerRef = useRef<number | null>(null);
  const idleNudgedRef = useRef(false);
  const exitFallbackTimerRef = useRef<number | null>(null);
  // 供事件回调/timer 读最新值（避免闭包旧值）
  const wakeAvailableRef = useRef(false);
  wakeAvailableRef.current = wakeAvailable;
  const listeningByWakeRef = useRef(false);
  listeningByWakeRef.current = listeningByWake;
  // P2 端侧 ASR：是否走原生 AudioEngine ASR（onNativeReady 探测 onDeviceAsrAvailable；
  // false = 纯浏览器/原生 ASR 不可用 → 回退云火山，现状链路不变）。
  const useDeviceAsrRef = useRef(false);
  // P2 方向X：端侧一轮只接受一个 final 的哨兵（beginTurn 置 true，首个 onAsrFinal 收下即置 false，
  // 拒绝同轮后续 final）。防 native 切句/竞态多发 final → 多 chat.trigger → 双声音叠。
  const turnActiveRef = useRef(false);

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

  // 问题3：清 L3 等接话静默定时器（进入新录音 / 退出 / 出错时调）
  const clearIdleTimers = useCallback(() => {
    if (idleNudgeTimerRef.current !== null) {
      window.clearTimeout(idleNudgeTimerRef.current);
      idleNudgeTimerRef.current = null;
    }
    if (idleExitTimerRef.current !== null) {
      window.clearTimeout(idleExitTimerRef.current);
      idleExitTimerRef.current = null;
    }
  }, []);

  const clearExitFallback = useCallback(() => {
    if (exitFallbackTimerRef.current !== null) {
      window.clearTimeout(exitFallbackTimerRef.current);
      exitFallbackTimerRef.current = null;
    }
  }, []);

  // 问题3 退出流程收尾（= 唤醒进对话链反向走的最后一步）：
  // 停录音 + 释放麦（pauseWake）+ 回 idle + 重启唤醒监听回到待唤醒态。幂等。
  // 由「告别 TTS 播完(onPlaybackEnd)」或「兜底超时」调用。
  const finalizeExit = useCallback(() => {
    clearExitFallback();
    if (!exitingRef.current) return; // 已收尾过，幂等
    exitingRef.current = false;
    exitPendingRef.current = false;
    const client = clientRef.current;
    // 防御性停录音（退出流程理论上不在录音，但多路径触发兜底，避免麦泄漏）
    if (client) {
      try {
        // 退出：端侧停原生 ASR（auto 连续监听必须停，否则退出后还在听）/ 云停录音。
        if (useDeviceAsrRef.current) stopAsr();
        else client.stopRecording();
      } catch {
        /* 容错 */
      }
      try {
        client.restoreTts();
      } catch {
        /* 容错 */
      }
    }
    setListeningByWake(false);
    setFeedbackPressed(false);
    setVoiceStatus('idle');
    // 回到待唤醒 idle 态：原生重新独占麦跑 Porcupine（pauseWake 在 startExit 时已调，这里恢复监听）
    if (wakeAvailableRef.current) startWakeListening();
  }, [clearExitFallback, setFeedbackPressed, setListeningByWake, setVoiceStatus]);

  const finalizeExitRef = useRef(finalizeExit);
  finalizeExitRef.current = finalizeExit;

  // 问题3 触发退出：取消进行中 LLM/TTS（sayDirect 内部 bargeIn）→ 播暖告别 → 播完 finalizeExit。
  // 幂等（exitingRef 门）。reason 仅用于日志/调试。pressedRef 状态同步清掉防卡。
  const startExit = useCallback(
    (reason: 'l1_word' | 'l2_marker' | 'l3_idle') => {
      if (exitingRef.current) return; // 已在退出，多路径只退一次
      exitingRef.current = true;
      exitPendingRef.current = false;
      // 清一切等待/接话/思考定时器，停多轮
      clearWakeStopTimer();
      clearThinkingTimeout();
      clearIdleTimers();
      turnCountRef.current = 0;
      idleNudgedRef.current = false;
      // 同步清录音/按住态（退出可能从 thinking / followup 等待中触发）
      pressedRef.current = false;
      setPressed(false);
      setListeningByWake(false);
      setFeedbackPressed(false);
      // 退出期间不让原生唤醒抢麦（告别 TTS 要发声；finalizeExit 再恢复监听）
      pauseWakeListening();

      const client = clientRef.current;
      // 停填充音（避免和告别叠播）
      try {
        client?.stopThinkingCue();
      } catch {
        /* 容错 */
      }
      setVoiceStatus('speaking');
      setXiaokeEmotion('calm');

      if (!client) {
        // 没有 client（异常）→ 直接收尾
        finalizeExitRef.current();
        return;
      }
      // sayDirect 内部先 bargeIn（取消在途 LLM/TTS，复用退出链），再播告别。
      // 播完会走 tts.playback_end → onPlaybackEnd（exitingRef 命中 → finalizeExit）。
      try {
        client.sayDirect(EXIT_FAREWELL_TEXT);
      } catch {
        // sayDirect 抛错（WS 未就绪等）→ 不卡死，直接收尾回唤醒态
        finalizeExitRef.current();
        return;
      }
      // 兜底：告别 TTS 若无 playback_end（WS 异常/无音频）→ 强制收尾
      clearExitFallback();
      exitFallbackTimerRef.current = window.setTimeout(() => {
        exitFallbackTimerRef.current = null;
        if (mountedRef.current && exitingRef.current) finalizeExitRef.current();
      }, EXIT_FALLBACK_MS);
      console.log('[mobile-voice] exit triggered:', reason);
    },
    [
      clearExitFallback,
      clearIdleTimers,
      setFeedbackPressed,
      setListeningByWake,
      setPressed,
      setVoiceStatus,
      setXiaokeEmotion,
    ],
  );

  const startExitRef = useRef(startExit);
  startExitRef.current = startExit;

  // 问题3 L3：等接话静默分级——arm 一次 nudge 计时；触发则温柔提醒一次再 arm 退出计时。
  // 跨多个 6s followup 录音存活（追踪整体静默，不随单轮 recording 边界重置）；孩子真开口（asr partial/final 非空）清零。
  const armIdleTimers = useCallback(() => {
    if (exitingRef.current) return;
    // 已有静默周期在跑（nudge 待触发 或 已提醒+退出计时中）→ 不重置，让它继续倒数。
    // 防 nudge 播完后 followup 重新 arm 把退出计时清掉导致永不退出。
    if (idleNudgeTimerRef.current !== null || idleExitTimerRef.current !== null || idleNudgedRef.current) {
      return;
    }
    idleNudgeTimerRef.current = window.setTimeout(() => {
      idleNudgeTimerRef.current = null;
      if (!mountedRef.current || exitingRef.current) return;
      // 录音/启动中（孩子可能正在说）不打断，顺延一个周期再判
      if (pressedRef.current || actionInFlightRef.current) {
        armIdleTimersRef.current();
        return;
      }
      idleNudgedRef.current = true;
      const client = clientRef.current;
      try {
        client?.sayDirect(IDLE_NUDGE_TEXT);
      } catch {
        /* 容错：提醒失败不影响后续退出计时 */
      }
      // 提醒后再静默 → 自动告别退出
      idleExitTimerRef.current = window.setTimeout(() => {
        idleExitTimerRef.current = null;
        if (!mountedRef.current || exitingRef.current) return;
        if (pressedRef.current || actionInFlightRef.current) {
          // 仍在录音（孩子在说）→ 不退，重新 arm 一轮
          idleNudgedRef.current = false;
          armIdleTimersRef.current();
          return;
        }
        startExitRef.current('l3_idle');
      }, IDLE_EXIT_MS);
    }, IDLE_NUDGE_MS);
  }, [clearIdleTimers]);

  const armIdleTimersRef = useRef(armIdleTimers);
  armIdleTimersRef.current = armIdleTimers;
  // 供 [] 依赖的 bridge effect（onWakeWord）读最新清理函数，避免把这些 useCallback 塞进 effect 依赖触发重注册
  const clearIdleTimersRef = useRef(clearIdleTimers);
  clearIdleTimersRef.current = clearIdleTimers;
  const clearExitFallbackRef = useRef(clearExitFallback);
  clearExitFallbackRef.current = clearExitFallback;

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
    // 端侧 ASR：stopAsr（PTT 松手收尾，原生 flush 出 final）；云火山：stopRecording。
    if (useDeviceAsrRef.current) stopAsr();
    else client.stopRecording();
    setVoiceStatus('thinking');
    setXiaokeEmotion('calm');
    // 问题2：进 thinking 后延迟播填充音（"我想想哦"）掩盖 ASR→LLM→TTS 冷场；快返回(llm.delta/tts.audio)会取消/停。
    if (thinkingCueTimerRef.current !== null) window.clearTimeout(thinkingCueTimerRef.current);
    thinkingCueTimerRef.current = window.setTimeout(() => {
      thinkingCueTimerRef.current = null;
      // 端侧 ASR：不播 thinkingCue 填充音（小可音色，会被端侧 KWS/ASR 录到自激）；云火山保留。
      if (mountedRef.current && useAppStore.getState().voiceStatus === 'thinking' && !useDeviceAsrRef.current) {
        clientRef.current?.playThinkingCue();
      }
    }, THINKING_CUE_DELAY_MS);
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
      // 端侧 ASR：麦由原生 AudioEngine 持有，startAsr 内部切 KWS→ASR，不 pauseWakeListening（那会停录音线程）；
      // 云火山：释放 KWS 麦给 Web getUserMedia。
      if (!useDeviceAsrRef.current) pauseWakeListening();
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
            client.sendSessionConfig(getMobileVoicePromptNow());
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

        if (useDeviceAsrRef.current) {
          // 端侧：原生 ASR（auto = 唤醒/followup 用 endpoint 判停；ptt = 按住说话松手停）。不 getUserMedia、不上传 PCM。
          startAsr(byWake ? 'auto' : 'ptt');
          turnActiveRef.current = true; // 方向X：本轮开始，接受一个 final
        } else {
          await client.startRecording();
        }
        // 录音就绪前已松手/卸载 → 立即停，不留泄漏
        if (!mountedRef.current || needStopRef.current) {
          if (useDeviceAsrRef.current) stopAsr();
          else client.stopRecording();
          needStopRef.current = false;
          if (mountedRef.current) {
            setVoiceStatus('thinking');
            setXiaokeEmotion('calm');
          }
          return;
        }
        setVoiceStatus('listening');
        setXiaokeEmotion('curious');
        // 云火山唤醒录音用固定 6s 窗兜底；端侧 ASR 用原生 endpoint 自动判停（onAsrEndpoint）+ 连续多轮，不需固定窗。
        if (byWake && !useDeviceAsrRef.current) {
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
            // 问题2：不把 WS/技术错误原文（"WebSocket was closed..."）暴露给孩子，统一友好提示
            setSubtitle('网络好像不太好，待会再试试～');
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
    // 问题3：用户按住说话 = 主动互动 → 取消 idle 分级，重置提醒态（退出态若在播告别由 bargeIn 链处理）
    clearIdleTimers();
    idleNudgedRef.current = false;
    void beginTurn(false);
  }, [beginTurn, clearIdleTimers]);

  const onPttUp = useCallback(() => {
    finishTurn();
  }, [finishTurn]);

  // 问题4（docs/24）：按住吐槽 = captureMode:'feedback' 录音（复用 kidshub 吐槽链路：
  // server 落反馈库 + 吐槽人格回应）。按住录、松手提交，与 PTT 同收尾。
  const onFeedbackDown = useCallback(() => {
    clearIdleTimers();
    idleNudgedRef.current = false;
    void beginTurn(false, true);
  }, [beginTurn, clearIdleTimers]);

  const onFeedbackUp = useCallback(() => {
    finishTurn();
  }, [finishTurn]);

  const bargeIn = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    turnActiveRef.current = false; // 方向X：用户打断作废本轮，防原生在途 final 晚到误触发 chat
    clearWakeStopTimer();
    clearThinkingTimeout();
    // 问题3：用户主动打断 = 继续互动 → 取消退出/idle 分级，重置态
    clearIdleTimers();
    clearExitFallback();
    exitingRef.current = false;
    exitPendingRef.current = false;
    idleNudgedRef.current = false;
    // 录音中打断 → 先收尾录音状态，避免 pressedRef 残留锁死 + 双重占麦
    if (pressedRef.current) {
      pressedRef.current = false;
      setPressed(false);
      setListeningByWake(false);
      setFeedbackPressed(false);
    }
    // 停 ASR：端侧 stopAsr（auto 连续监听也要停）/ 云 stopRecording。再 bargeIn 停在途 TTS。
    try {
      if (useDeviceAsrRef.current) stopAsr();
      else client.stopRecording();
    } catch {
      /* 容错 */
    }
    try {
      client.bargeIn();
    } catch {
      /* 容错 */
    }
    setVoiceStatus('idle');
    setSubtitle('');
    resumeWakeIfIdle();
  }, [clearExitFallback, clearIdleTimers, resumeWakeIfIdle, setSubtitle, setVoiceStatus]);

  // 挂载/卸载守卫：卸载时兜底停录音，防麦克风后台泄漏
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearWakeStopTimer();
      clearThinkingTimeout();
      clearIdleTimers(); // 问题3：卸载清 idle 分级计时
      clearExitFallback(); // 问题3：卸载清退出兜底计时
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
      // 问题3 L3：孩子真开口（partial 有字）→ 清静默分级计时并复位提醒态（不退出）。
      if (msg.text && msg.text.trim()) {
        clearIdleTimers();
        idleNudgedRef.current = false;
      }
    };
    const onAsrFinal = (msg: { text: string }) => {
      speakingRef.current = false;
      cancelClear();
      lastShownCueRef.current = '';
      setSubtitle(`${msg.text}...`);
      // 问题3 L1 + L3：仅当 asr.final 真有内容（孩子开口）才处理。
      // 空 final（followup 录音无人说话）不清 L3 计时，让静默跨多轮累积到提醒/退出。
      if (!msg.text || !msg.text.trim()) return;
      // L3：孩子开口 → 取消静默分级计时并复位提醒态
      clearIdleTimers();
      idleNudgedRef.current = false;
      // L1：告别词白名单命中 → 退出流程（sayDirect 内部 bargeIn 取消 server 即将启动的这轮 LLM/TTS）
      if (!exitingRef.current && detectExitIntent(msg.text)) {
        startExitRef.current('l1_word');
      }
    };
    const cancelThinkingCue = () => {
      if (thinkingCueTimerRef.current !== null) {
        window.clearTimeout(thinkingCueTimerRef.current);
        thinkingCueTimerRef.current = null;
      }
      client.stopThinkingCue();
    };
    const onLlmDelta = (msg: { text: string }) => {
      if (!msg.text) return;
      clearThinkingTimeout(); // 有回复了，撤销无回复兜底
      cancelThinkingCue(); // 问题2：真回复来了，停填充音
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
    };
    // 问题3 L2：server 检测 LLM 回复开头 [EXIT]（已剥离）→ llm.done 带 exit=true。
    // 此刻 LLM 自己的告别正在 TTS 播；标记本轮待退，等告别 playback_end 后在 onPlaybackEnd 收尾
    //（不立即 sayDirect，避免双重告别；让 LLM 那句温暖告别自然播完）。
    const onLlmDone = (msg: { text?: string; exit?: boolean }) => {
      if (msg?.exit && !exitingRef.current) {
        exitPendingRef.current = true;
        clearIdleTimers();
        clearWakeStopTimer();
        turnCountRef.current = 0; // 退出轮不再进多轮接话
      }
    };
    const onTtsAudio = () => {
      clearThinkingTimeout();
      cancelThinkingCue(); // 问题2：真 TTS 发声，停填充音（淡出，避免叠播）
      speakingRef.current = true;
      cancelClear();
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
      // 问题3：小可说话时压低 TTS 音量减自声掩盖，改善唤醒打断 SNR。
      client.duckTts();
      // AEC（端侧 ASR）：TTS 开始播 → 通知原生（原生据此 gate ASR/KWS 防录到小可自声→自唤醒；纯浏览器 no-op）。
      // 注：硬件 AcousticEchoCanceler 对 WebView 的 STREAM_MUSIC 输出不生效，自声抑制靠原生 notifyTtsState gating。
      notifyTtsState(true);
      if (wakeAvailableRef.current) startWakeListening();
    };
    const onTtsEnd = () => {
      setVoiceStatus('idle');
      setXiaokeEmotion('happy');
    };
    const onSegmentStart = () => {
      consumeNextExpression();
    };
    const onPlaybackEnd = (data?: { reason?: string }) => {
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
      client.restoreTts(); // 问题3：恢复 TTS 音量
      // AEC（端侧 ASR）：TTS 播完 → 通知原生恢复 ASR（原生内部延迟 ~250ms 防扬声器尾音余振；纯浏览器 no-op）。
      notifyTtsState(false);
      // 问题3 退出收尾（两条退出路径都在「告别 TTS 播完」这一刻统一收尾到唤醒 idle 态）：
      // (a) exitingRef —— L1/L3：startExit 已 sayDirect 自家告别，播完即 finalizeExit。
      // (b) exitPendingRef —— L2：LLM 回复开头带 [EXIT]，它自己那句告别刚播完，这里直接收尾，
      //     不再 sayDirect（避免双重告别）。置 exitingRef 命中 finalizeExit 的幂等门后收尾。
      if (exitingRef.current || exitPendingRef.current) {
        exitingRef.current = true;
        finalizeExitRef.current();
        return;
      }
      // 用户主动打断（bargeIn emit reason='barge'）→ 收尾 idle，绝不进 followup。
      // 否则点按钮打断后 followup 又自动开一轮 startAsr → 连续 startAsr 自激、停不下来（真机实测 bug3/4）。
      if (data?.reason === 'barge') {
        turnCountRef.current = 0;
        setVoiceStatus('idle');
        if (wakeAvailableRef.current) startWakeListening();
        return;
      }
      // team 审查（gemini/gpt 高风险）：唤醒打断时 onWakeWord 会同步 bargeIn→本回调，紧接着设 listening+beginTurn。
      // 若此刻已在录音/启动中，绝不能 idle / 进 followup（会覆盖 listening 态 + 抢麦）。仅真正空闲收尾才走。
      if (!pressedRef.current && !actionInFlightRef.current) {
        // 问题1 多轮（docs/24）：小可说完不立即 idle，自动开录音等接话（复用 wake 录音链路、视觉"在听"、不播唤醒音），最多 MAX 轮。
        // 超限 / 原生唤醒不可用 → 退 idle 恢复 KWS。无接话时 followup 录音 6s 空 → thinking 兜底超时退（turnCount 下次唤醒清零）。
        if (wakeAvailableRef.current && turnCountRef.current < MAX_FOLLOWUP_TURNS) {
          turnCountRef.current += 1;
          // 问题3 L3：followup 等接话 → arm 静默分级计时（幂等：已在倒数则不重置）。孩子开口清零。
          // 方向X：端侧也走 followup beginTurn（内部 startAsr('auto') 重启下一轮 + 置 turnActive），与云火山统一态机。
          armIdleTimersRef.current();
          void beginTurnRef.current(true);
        } else {
          turnCountRef.current = 0;
          setVoiceStatus('idle');
          if (wakeAvailableRef.current) startWakeListening();
        }
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
      cancelThinkingCue(); // 问题2：出错停填充音
      client.restoreTts(); // 问题3：出错恢复音量
      turnCountRef.current = 0; // 问题1：出错结束多轮
      // 问题3：出错时清退出/idle 态，绝不让退出流程卡死状态机
      clearIdleTimers();
      clearExitFallback();
      exitingRef.current = false;
      exitPendingRef.current = false;
      idleNudgedRef.current = false;
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
    const onVadSpeechEnd = () => {
      // 问题1（team 共识）：前端 VAD 判定用户一句话说完 → 立即 finishTurn（替固定 6s 窗，对话流畅）。
      // 仅唤醒/followup 录音(listeningByWake)；PTT 靠松手不受 VAD 影响；finishTurn 内 pressedRef 守卫防与 6s 兜底重复。
      if (listeningByWakeRef.current) finishTurnRef.current();
    };

    client.on('asr.partial', onAsrPartial);
    client.on('asr.final', onAsrFinal);
    client.on('llm.delta', onLlmDelta);
    client.on('llm.done', onLlmDone);
    client.on('tts.audio', onTtsAudio);
    client.on('tts.end', onTtsEnd);
    client.on('tts.segment_start', onSegmentStart);
    client.on('tts.playback_end', onPlaybackEnd);
    client.on('avatar.expression', onAvatarExpression);
    client.on('error', onError);
    client.on('vad.speech_end', onVadSpeechEnd);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      cancelClear();
      client.off('asr.partial', onAsrPartial);
      client.off('asr.final', onAsrFinal);
      client.off('llm.delta', onLlmDelta);
      client.off('llm.done', onLlmDone);
      client.off('tts.audio', onTtsAudio);
      client.off('tts.end', onTtsEnd);
      client.off('tts.segment_start', onSegmentStart);
      client.off('tts.playback_end', onPlaybackEnd);
      client.off('avatar.expression', onAvatarExpression);
      client.off('error', onError);
      client.off('vad.speech_end', onVadSpeechEnd);
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
    useDeviceAsrRef.current = isOnDeviceAsrAvailable();
    const unregister = registerWebBridge({
      onWakeWord: () => {
        // 重入早退：已在录音/启动中则忽略重复唤醒（beginTurn 内亦有防护，这里早退避免多余 bargeIn/playCue）
        if (pressedRef.current || actionInFlightRef.current) return;
        turnCountRef.current = 0; // 问题1：用户主动喊唤醒词 = 新会话，多轮计数清零
        // 问题3：喊唤醒词 = 主动回来 → 取消退出/idle 分级（即便正在播告别也救回），重置态。
        // 先于下面 bargeIn（bargeIn 会 emit tts.playback_end→onPlaybackEnd，需此处已清 exitingRef 防误收尾）。
        clearIdleTimersRef.current();
        clearExitFallbackRef.current();
        exitingRef.current = false;
        exitPendingRef.current = false;
        idleNudgedRef.current = false;
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
        // 端侧 ASR：不播 playCue 唤醒确认音——小可音色会被原生 ASR 录到→识别→自答（真机实测 bug1）。
        // 端侧识别延迟低无需 cue 掩盖；云火山模式保留。
        if (client && !useDeviceAsrRef.current) {
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
        useDeviceAsrRef.current = !!info.onDeviceAsrAvailable;
        // 原生 ready 时若正在录音 → 不抢麦，等本轮结束 playback_end 再恢复
        if (info.wakeWordAvailable && !pressedRef.current) startWakeListening();
      },
      // ===== P2 端侧 ASR 回调（原生 AudioEngine 流式结果，仅端侧模式触发）=====
      onAsrPartial: (text: string) => {
        // 用户说话字幕（原生侧已节流 ≥120ms）。孩子开口 → 清退出静默分级计时。
        setSubtitle(text);
        if (text && text.trim()) {
          clearIdleTimersRef.current();
          idleNudgedRef.current = false;
        }
      },
      onAsrEndpoint: () => {
        // auto 模式端侧判停（一句说完）→ 进 thinking 等小可回答。
        // 原生自身 reset stream 继续监听多轮，Web 不停 ASR（与云火山的 finishTurn 语义不同）。
        if (useAppStore.getState().voiceStatus === 'listening') {
          setVoiceStatus('thinking');
          setXiaokeEmotion('calm');
        }
      },
      onAsrFinal: (text: string) => {
        if (!text || !text.trim()) return;
        // 方向X：一轮只接受一个 final（哨兵去重，防 native 切句/竞态多发 → 多 chat.trigger → 双声音叠）。
        if (!turnActiveRef.current) return;
        turnActiveRef.current = false;
        clearIdleTimersRef.current();
        idleNudgedRef.current = false;
        // 收尾本轮录音态：清 listeningByWake/pressed（修按钮常红）+ stopAsr 释放本轮 + 进 thinking。
        finishTurnRef.current();
        // L1 退出词白名单 → 退出流程（不入 LLM）。
        if (!exitingRef.current && detectExitIntent(text)) {
          startExitRef.current('l1_word');
          return;
        }
        // 端侧 final → chat.trigger 入 LLM→TTS（server 内部 bargein 旧轮）。
        // 不在此客户端 bargeIn：方向X 一轮一 final + followup 在 playback_end 之后，无在途 TTS 可叠；
        // 且 client.bargeIn() 会 emit tts.playback_end 误触发 followup beginTurn。
        try {
          clientRef.current?.sendChatTrigger(text);
        } catch {
          /* WS 未就绪：忽略，下次重连后可用 */
        }
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
