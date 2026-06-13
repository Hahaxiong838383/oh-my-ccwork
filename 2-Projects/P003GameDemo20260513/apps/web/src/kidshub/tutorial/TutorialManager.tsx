/**
 * TutorialManager —— 新手引导协调器（无渲染，unit 无关）
 *
 * 职责：把纯状态机（tutorial-store）接到真实副作用上：
 *  - 步进时：锁表情上配表脸 + sayDirect 固定话术（{child_nickname} 注入工作台变量）
 *    + 手动喂打字机（tts.say 不产生 llm.delta，字幕文本必须在这里喂）
 *  - 无语音步（登舰 1~3 幕纯演出）：durationMs 定时推进
 *  - 等待步：30s 超时提醒 ×3（配表规则），第 3 次播过渡语后跳步
 *  - ASR 拦截：跳过词 > 当前步推进词（准备好了/登舰）> 放行 LLM 兜底
 *  - 退出（完成/打断/跳过）：解表情锁 + 恢复待机
 */
import { useEffect, useRef } from 'react';
import { getSharedVoiceClient, getKidsHubSessionId } from '../../services/voice-client';
import { sharedTypewriter } from '../subtitle/shared';
import { useAvatarStore } from '../avatar/avatar-store';
import { useKidsHubStore } from '../store/kidshub-store';
import { useTutorialStore } from './tutorial-store';
import {
  REMIND_FINAL_SUFFIX,
  REMIND_INTERVAL_MS,
  SKIP_HINTS,
  SKIP_RESPONSE,
  buildTutorialSystemPrompt,
  matchHints,
  type TutorialStep,
} from './tutorial-types';
import { getUnit, getUnitStep } from './tutorial-units';
import { READY_HINTS } from './tutorial-settings';
import { BOARDING_HINTS } from './tutorial-boarding';
import { WAKE_HINTS } from './tutorial-night-report';
import { CLAIM_HINTS } from './tutorial-focus';

function getVoiceWsUrl(): string {
  const envUrl = (import.meta as any).env?.VITE_VOICE_WS_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws/voice`;
}

/** 等待目标 → ASR 推进关键词表 */
function hintsForTarget(target: TutorialStep['waitFor']): string[] {
  if (target === 'close-panel') return READY_HINTS;
  if (target === 'boot-button') return BOARDING_HINTS;
  if (target === 'wake-word') return WAKE_HINTS;
  if (target === 'claim-reward') return CLAIM_HINTS;
  return [];
}

/** 配表占位符注入：{child_nickname} ← 工作台 nickname 变量（默认"朵朵"） */
function applyVars(text: string): string {
  const nickname = useKidsHubStore.getState().variables.nickname || '指挥官';
  // lib 目标低于 es2021 没有 replaceAll，用 split/join 全量替换
  return text.split('{child_nickname}').join(nickname);
}

export function TutorialManager(): null {
  const isActive = useTutorialStore((s) => s.isActive);
  const unitId = useTutorialStore((s) => s.unitId);
  const stepIndex = useTutorialStore((s) => s.stepIndex);
  const phase = useTutorialStore((s) => s.phase);
  const remindCount = useTutorialStore((s) => s.remindCount);
  const generation = useTutorialStore((s) => s.generation);

  const pushDebug = useKidsHubStore((s) => s.pushDebug);

  // 第 3 次提醒过渡语 / 跳过回应 播完后要做的事（playback_end natural 时执行）
  const afterSpeechRef = useRef<null | (() => void)>(null);
  // 收尾衔接语只播一次（庆祝播完 → 衔接语 → 才 complete；防循环）
  const outroSpokenRef = useRef(false);

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

  // ── 步进副作用：表情 + 话术/定时演出 + tutorial 系统指令 ──
  useEffect(() => {
    if (!isActive) return;
    const step = getUnitStep(unitId, stepIndex);
    if (!step) return;

    const avatar = useAvatarStore.getState();
    avatar.setExpression(step.expression, 'tutorial');

    // LLM 兜底指令随步骤更新（孩子步内插话时 LLM 知道当前在教什么）
    const client = getSharedVoiceClient();
    try {
      client.sendSessionConfig(buildTutorialSystemPrompt(step));
      // 需求2：引导期会话元数据。kidshub 单元 = 反馈窗口 → captureMode=feedback（source=tutorial，
      // 孩子"试一句"会被捕获落库，后台可一键过滤引导来源）；其余单元 off。
      client.sendSessionMeta({
        sessionId: getKidsHubSessionId(),
        sceneId: null,
        nickname: useKidsHubStore.getState().variables.nickname || '',
        tutorialUnitId: unitId,
        captureMode: unitId === 'kidshub' ? 'feedback' : 'off',
        source: 'tutorial',
      });
    } catch {
      // 未连接时跳过：speakLine 里会重连，config 缺失只影响兜底插话质量，不影响主线
    }

    pushDebug({ kind: 'action', title: `🧭 引导[${unitId}] Step ${step.specStep}（${step.id}）` });

    if (step.voiceCopy) {
      void speakLine(applyVars(step.voiceCopy));
      return;
    }

    // 无语音步（纯演出幕）：定时推进，代际守卫防换步后旧定时器串台
    const gen = useTutorialStore.getState().generation;
    const timer = window.setTimeout(() => {
      const s = useTutorialStore.getState();
      if (s.isActive && s.generation === gen) s.onSpeechEnd();
    }, step.durationMs ?? 5_000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, unitId, stepIndex, generation]);

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
      // 庆祝步播完且单元配了衔接语：先播衔接（引导去下一单元），播完才 complete 退出
      const unit = getUnit(s.unitId);
      if (s.phase === 'celebrating' && unit?.outroCopy && !outroSpokenRef.current) {
        outroSpokenRef.current = true;
        pushDebug({ kind: 'action', title: `🧭 引导衔接语 → ${unit.nextUnitId ?? '下一单元'}` });
        void speakLine(applyVars(unit.outroCopy));
        return;
      }
      s.onSpeechEnd();
    };
    client.on('tts.playback_end', onPlaybackEnd);
    return () => {
      client.off('tts.playback_end', onPlaybackEnd);
      afterSpeechRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // 新一轮引导启动时重置衔接语标记
  useEffect(() => {
    if (isActive) outroSpokenRef.current = false;
  }, [isActive, generation]);

  // ── 30s 超时提醒（仅 waiting 期；remindCount 变化重新 arm 下一轮） ──
  useEffect(() => {
    if (!isActive || phase !== 'waiting') return;
    const step = getUnitStep(unitId, stepIndex);
    if (!step?.remindCopy) return;

    const timer = window.setTimeout(() => {
      const s = useTutorialStore.getState();
      const { exceeded } = s.onRemindTick();
      if (exceeded) {
        // 第 3 次：播过渡语，播完跳下一步（配表"提醒3次无反应进入下一步"）
        afterSpeechRef.current = () => useTutorialStore.getState().forceNext();
        void speakLine(REMIND_FINAL_SUFFIX);
      } else {
        void speakLine(applyVars(step.remindCopy as string));
      }
    }, REMIND_INTERVAL_MS);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, unitId, phase, stepIndex, remindCount, generation]);

  // ── ASR 拦截：跳过词 > 当前步推进词 > 放行 LLM ──
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

      const step = getUnitStep(s.unitId, s.stepIndex);
      if (step?.waitFor && matchHints(text, hintsForTarget(step.waitFor))) {
        pushDebug({ kind: 'action', title: `🧭 语音推进：「${text}」→ ${step.waitFor}` });
        client.bargeIn();
        s.advanceOnAction(step.waitFor);
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
