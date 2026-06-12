/**
 * TutorialManager —— 设置引导协调器（无渲染）
 *
 * 职责：把纯状态机（tutorial-store）接到真实副作用上：
 *  - 步进时：锁表情上配表脸 + sayDirect 固定话术 + 手动喂打字机（tts.say 不产生
 *    llm.delta，字幕文本必须在这里喂；逐句开打仍由 tts.segment_start 驱动，零改打字机）
 *  - 等待步：30s 超时提醒 ×3（配表规则），第 3 次播过渡语后跳步
 *  - ASR 拦截：命中"准备好了"推进 step5；命中跳过词直接完成；其余放行 LLM
 *    （进引导/换步时已下发 tutorial 系统指令，LLM 简短回答后拉回）
 *  - 退出（完成/打断/跳过）：解表情锁 + 恢复待机
 */
import { useEffect, useRef } from 'react';
import { getSharedVoiceClient } from '../../services/voice-client';
import { sharedTypewriter } from '../subtitle/shared';
import { useAvatarStore } from '../avatar/avatar-store';
import { useKidsHubStore } from '../store/kidshub-store';
import { useTutorialStore } from './tutorial-store';
import {
  REMIND_FINAL_SUFFIX,
  REMIND_INTERVAL_MS,
  READY_HINTS,
  SKIP_HINTS,
  SKIP_RESPONSE,
  buildTutorialSystemPrompt,
  getStepByIndex,
  matchHints,
} from './tutorial-settings';

function getVoiceWsUrl(): string {
  const envUrl = (import.meta as any).env?.VITE_VOICE_WS_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws/voice`;
}

export function TutorialManager(): null {
  const isActive = useTutorialStore((s) => s.isActive);
  const stepIndex = useTutorialStore((s) => s.stepIndex);
  const phase = useTutorialStore((s) => s.phase);
  const remindCount = useTutorialStore((s) => s.remindCount);
  const generation = useTutorialStore((s) => s.generation);

  const pushDebug = useKidsHubStore((s) => s.pushDebug);

  // 第 3 次提醒过渡语 / 跳过回应 播完后要做的事（playback_end natural 时执行）
  const afterSpeechRef = useRef<null | (() => void)>(null);

  /** 固定话术发声 + 字幕喂句（统一入口；连接断了自动重连一次） */
  const speakLine = async (text: string): Promise<void> => {
    const client = getSharedVoiceClient();
    const tw = sharedTypewriter();
    tw.reset();
    try {
      if (!client.isConnected()) {
        await client.connect(getVoiceWsUrl());
      }
      // 先喂文本再发声：segment_start 到达时第 0 句才开打（同一时钟源）
      tw.feedText(text);
      tw.finalizeText(text);
      client.sayDirect(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushDebug({ kind: 'error', title: `❌ 引导语音失败：${msg}（3s 后静默续走）` });
      // 降级：语音链路坏了引导也不能卡死——3s 后视同播完推进状态机
      const gen = useTutorialStore.getState().generation;
      window.setTimeout(() => {
        const s = useTutorialStore.getState();
        if (s.isActive && s.generation === gen && s.phase !== 'waiting') {
          s.onSpeechEnd();
        }
      }, 3_000);
    }
  };

  // ── 表情锁生命周期：激活上锁，退出解锁回待机 ──
  useEffect(() => {
    const avatar = useAvatarStore.getState();
    if (isActive) {
      avatar.setTutorialLock(true);
      return () => {
        // isActive 翻 false 或卸载：解锁 + 收尾（endTurn 自带回待机脸）
        const a = useAvatarStore.getState();
        a.setTutorialLock(false);
        a.endTurn();
      };
    }
    return undefined;
  }, [isActive]);

  // ── 步进副作用：表情 + 话术 + tutorial 系统指令 ──
  useEffect(() => {
    if (!isActive) return;
    const step = getStepByIndex(stepIndex);
    if (!step) return;

    const avatar = useAvatarStore.getState();
    avatar.setExpression(step.expression, 'tutorial');

    // LLM 兜底指令随步骤更新（孩子步内插话时 LLM 知道当前在教什么）
    const client = getSharedVoiceClient();
    try {
      client.sendSessionConfig(buildTutorialSystemPrompt(step));
    } catch {
      // 未连接时跳过：speakLine 里会重连，config 缺失只影响兜底插话质量，不影响主线
    }

    pushDebug({ kind: 'action', title: `🧭 引导 Step ${step.specStep}（${step.id}）` });
    void speakLine(step.voiceCopy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, stepIndex, generation]);

  // ── playback_end：natural 才推状态机（barge 是用户/换步掐断，不算说完） ──
  useEffect(() => {
    if (!isActive) return;
    const client = getSharedVoiceClient();
    const onPlaybackEnd = (msg: { reason?: string }) => {
      if (msg?.reason !== 'natural') return;
      const after = afterSpeechRef.current;
      if (after) {
        afterSpeechRef.current = null;
        after();
        return;
      }
      const s = useTutorialStore.getState();
      // waiting 期的 natural end 是提醒语/LLM 兜底回复播完，不推主线
      if (s.phase === 'waiting') return;
      s.onSpeechEnd();
    };
    client.on('tts.playback_end', onPlaybackEnd);
    return () => {
      client.off('tts.playback_end', onPlaybackEnd);
      afterSpeechRef.current = null;
    };
  }, [isActive]);

  // ── 30s 超时提醒（仅 waiting 期；remindCount 变化重新armed下一轮） ──
  useEffect(() => {
    if (!isActive || phase !== 'waiting') return;
    const step = getStepByIndex(stepIndex);
    if (!step?.remindCopy) return;

    const timer = window.setTimeout(() => {
      const s = useTutorialStore.getState();
      const { exceeded } = s.onRemindTick();
      if (exceeded) {
        // 第 3 次：播过渡语，播完跳下一步（配表"提醒3次无反应进入下一步"）
        afterSpeechRef.current = () => useTutorialStore.getState().forceNext();
        void speakLine(REMIND_FINAL_SUFFIX);
      } else {
        void speakLine(step.remindCopy as string);
      }
    }, REMIND_INTERVAL_MS);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, phase, stepIndex, remindCount, generation]);

  // ── ASR 拦截：跳过词 > 推进词 > 放行 LLM ──
  useEffect(() => {
    if (!isActive) return;
    const client = getSharedVoiceClient();
    const onAsrFinal = (msg: { text: string }) => {
      const s = useTutorialStore.getState();
      if (!s.isActive) return;
      const text = msg?.text ?? '';

      if (matchHints(text, SKIP_HINTS)) {
        pushDebug({ kind: 'action', title: `🧭 引导跳过指令：「${text}」` });
        client.bargeIn(); // 掐掉 server 即将生成的 LLM 回复
        afterSpeechRef.current = () => useTutorialStore.getState().complete();
        void speakLine(SKIP_RESPONSE);
        return;
      }

      const step = getStepByIndex(s.stepIndex);
      if (step?.waitFor === 'close-panel' && matchHints(text, READY_HINTS)) {
        pushDebug({ kind: 'action', title: `🧭 语音推进：「${text}」→ 关闭面板` });
        client.bargeIn();
        s.advanceOnAction('close-panel');
        return;
      }
      // 其余放行：server 自动走 LLM（tutorial 系统指令已让它简短回答+拉回）
    };
    client.on('asr.final', onAsrFinal);
    return () => client.off('asr.final', onAsrFinal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  return null;
}
