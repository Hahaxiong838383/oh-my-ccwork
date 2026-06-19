import { useEffect, useRef, useState } from 'react';
// kidshub 专属场景层（CardScene）+ 专属字幕条（KidsHubSubtitle），与原 demo 组件解耦：
// 原 StatusBar 的 popLayout 跨句动画与打字机高频更新冲突（exit 节点泄漏出重复字）
import { KidsHubSubtitle } from './KidsHubSubtitle';
import { CardScene } from './CardScene';
import { XiaokeAvatar } from '../avatar/XiaokeAvatar';
import { ExpressionPicker } from '../avatar/ExpressionPicker';
import { TutorialManager } from '../tutorial/TutorialManager';
import { TutorialHandoffPrompt } from '../tutorial/TutorialHandoffPrompt';
import { TutorialCanvasContent } from '../tutorial/TutorialCanvasContent';
import { BoardingCanvasContent } from '../tutorial/BoardingCanvasContent';
import { NightReportCanvasContent } from '../tutorial/NightReportCanvasContent';
import { FocusCanvasContent } from '../tutorial/FocusCanvasContent';
import { EcoPondCanvasContent } from '../tutorial/EcoPondCanvasContent';
import { useTutorialStore } from '../tutorial/tutorial-store';
import { getUnitStep } from '../tutorial/tutorial-units';
import { useAvatarStore } from '../avatar/avatar-store';
import { resolveExpressionName } from '../avatar/expressions';
import { sharedTypewriter } from '../subtitle/shared';
import {
  getSharedVoiceClient,
  getKidsHubSessionId,
  type VoiceClient,
} from '../../services/voice-client';
import { useKidsHubStore } from '../store/kidshub-store';
import { useExperienceStore, EXPERIENCE_QUOTA_ENABLED } from '../store/experience-store';
import { getSceneCard } from '../prompts';
import { useAppStore } from '../../store/app-store';
import {
  perfStartTurn,
  perfMarkAsrFinal,
  perfMarkLlmFirst,
  perfMarkTtsFirstAndReport,
  perfReset,
} from '../perf-tracker';

function getVoiceWsUrl(): string {
  const envUrl = (import.meta as any).env?.VITE_VOICE_WS_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl;
  const isHttps = window.location.protocol === 'https:';
  const protocol = isHttps ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws/voice`;
}

interface CanvasHostProps {
  onDebug: (kind: any, title: string, detail?: string) => void;
  onConfigAck?: (msg: { chars: number }) => void;
}

export function CanvasHost({ onDebug, onConfigAck }: CanvasHostProps) {
  const activeCardId = useKidsHubStore((s) => s.activeCardId);
  const pushDebug = useKidsHubStore((s) => s.pushDebug);
  const voiceSpeed = useKidsHubStore((s) => s.voiceSpeed);
  const setVoiceSpeed = useKidsHubStore((s) => s.setVoiceSpeed);
  const tutorialActive = useTutorialStore((s) => s.isActive);
  const tutorialUnitId = useTutorialStore((s) => s.unitId);
  const tutorialStepIndex = useTutorialStore((s) => s.stepIndex);
  const skipAllTutorials = useTutorialStore((s) => s.skipAll);

  const setVoiceStatus = useAppStore((s) => s.setVoiceStatus);
  const setSubtitle = useAppStore((s) => s.setSubtitle);
  const setXiaokeEmotion = useAppStore((s) => s.setXiaokeEmotion);

  const enqueueLlmExpression = useAvatarStore((s) => s.enqueueLlmExpression);
  const consumeNextExpression = useAvatarStore((s) => s.consumeNextExpression);
  const applyNetState = useAvatarStore((s) => s.applyNetState);
  const endAvatarTurn = useAvatarStore((s) => s.endTurn);

  const clientRef = useRef<VoiceClient | null>(null);
  const [pressed, setPressed] = useState(false);
  // 需求1：区分当前按住的是「普通说话」还是「吐槽」按钮，用于两个按钮各自的高亮态
  const [activeRecordMode, setActiveRecordMode] = useState<'normal' | 'feedback' | null>(null);
  const pressedRef = useRef(false);
  const startInFlightRef = useRef(false);
  const needStopRef = useRef(false);
  const llmTextRef = useRef('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const [, setConnected] = useState(false);

  // 确保单例
  if (!clientRef.current) {
    clientRef.current = getSharedVoiceClient();
  }

  // 需求3：语速变化（含初次挂载）即时应用到语音客户端，下一段 TTS 生效
  useEffect(() => {
    clientRef.current?.setPlaybackRate(voiceSpeed);
  }, [voiceSpeed]);

  // 周期同步连接状态（给顶栏用）+ 断线静默重连（节流 5s）：
  // 国内→香港 wss 长连接偶发被运营商掐断，掉线后不自愈的话用户侧表现就是"没反应"
  const lastReconnectAtRef = useRef(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      const c = clientRef.current;
      const ok = !!(c && c.isConnected());
      setConnected(ok);
      if (!ok && c && Date.now() - lastReconnectAtRef.current > 5_000) {
        lastReconnectAtRef.current = Date.now();
        c.connect(getVoiceWsUrl()).catch(() => {
          /* 静默，下个周期再试 */
        });
      }
    }, 800);
    return () => window.clearInterval(id);
  }, []);

  // 挂载 voice 事件监听（仅调试流 + 画布字幕驱动）
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;

    const tw = sharedTypewriter();
    const onAsrPartial = (msg: { text: string }) => {
      // 用户开口 → 小可旧字幕的打字机让位（reset 幂等，连续 partial 无害）
      tw.reset();
      setSubtitle(msg.text);
    };
    const onAsrFinal = (msg: { text: string }) => {
      perfMarkAsrFinal();
      tw.reset();
      setSubtitle(`${msg.text}...`);
      llmTextRef.current = '';
      onDebug('asr', `👦 用户：${msg.text}`);
      // 也推 debugLog（store）
      pushDebug({ kind: 'asr', title: `👦 用户：${msg.text}` });
    };
    const onLlmDelta = (msg: { text: string }) => {
      if (!msg.text) return;
      perfMarkLlmFirst();
      llmTextRef.current += msg.text;
      // 字幕走打字机：文本只入引擎切句，显示由 tts.segment_start 按句驱动
      tw.feedText(msg.text);
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
    };
    const onLlmDone = (msg: { text?: string }) => {
      const full = (msg && msg.text) || llmTextRef.current || '';
      setVoiceStatus('idle');
      setXiaokeEmotion('happy');
      if (full) {
        // 不再整段 setSubtitle（打字机接管）；权威全文喂引擎做流缺字兜底
        tw.finalizeText(full);
        onDebug('llm', `🤖 小可：${full}`);
        pushDebug({ kind: 'llm', title: `🤖 小可：${full}` });
      }
      llmTextRef.current = '';
    };
    const onTtsAudio = () => {
      // 首段音频到达 → 产出本轮 perf 汇总（每轮只报一次）
      const perfLine = perfMarkTtsFirstAndReport();
      if (perfLine) {
        pushDebug({ kind: 'perf', title: perfLine });
      }
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
    };
    const onTtsEnd = () => {
      // tts.end 只是 server 合成完毕，音频可能还在播——avatar 收尾移到 tts.playback_end
      setVoiceStatus('idle');
      setXiaokeEmotion('happy');
    };
    // 句边界段真实开播 → 表情切下一个 + 字幕开始打这一句（同一时钟源，天然同步）
    const onSegmentStart = (msg?: { durationMs?: number }) => {
      consumeNextExpression();
      // 字幕节奏修复：用真实音频段时长动态校准打字速度（见 typewriter.dynamicCharMs）。
      tw.advanceSentence(msg?.durationMs);
    };
    // 本轮音频真正播完（含被打断）→ 表情收尾回待机 + 字幕补完后延迟清空
    const onPlaybackEnd = () => {
      endAvatarTurn();
      tw.finishPlayback();
    };
    const onPromptAssembled = (msg: { systemPrompt: string; userText: string }) => {
      const len = (msg.systemPrompt || '').length;
      const title = `📋 本轮 system prompt（${len} 字符）`;
      onDebug('prompt', title, msg.systemPrompt);
      pushDebug({ kind: 'prompt', title, detail: msg.systemPrompt });
    };
    // 命名避开 props.onConfigAck：同名遮蔽会变成自递归（实测刷几十条 ack 后爆栈）
    const handleConfigAck = (msg: { chars: number }) => {
      onDebug('config', `session.config.ack (${msg.chars} 字符)`);
      pushDebug({ kind: 'config', title: `session.config.ack (${msg.chars} 字符)` });
      onConfigAck?.(msg);
    };
    // LLM 句级表情（server 已按出现顺序剥离标记，index 为 turn 内序号）：
    // index 0 立即上脸（新一轮），后续入队等各自句子开播时切换
    const onAvatarExpression = (msg: { name: string; index: number }) => {
      const def = resolveExpressionName(msg.name);
      if (def) {
        enqueueLlmExpression(def.id, msg.index ?? 0);
        pushDebug({ kind: 'avatar', title: `🎭 小可选了表情[${msg.index ?? 0}]：${def.label}` });
      } else {
        pushDebug({ kind: 'avatar', title: `🎭 表情名未识别：「${msg.name}」（菜单外，已忽略）` });
      }
    };
    const onError = (msg: { message?: string; code?: string }) => {
      const t = msg.message || msg.code || '语音服务错误';
      onDebug('error', `❌ ${t}`);
      pushDebug({ kind: 'error', title: `❌ ${t}` });
      setVoiceStatus('idle');
      tw.reset();
      setSubtitle(t);
      applyNetState('fail');
    };

    client.on('asr.partial', onAsrPartial);
    client.on('asr.final', onAsrFinal);
    client.on('llm.delta', onLlmDelta);
    client.on('llm.done', onLlmDone);
    client.on('tts.audio', onTtsAudio);
    client.on('tts.end', onTtsEnd);
    client.on('debug.prompt_assembled', onPromptAssembled);
    client.on('session.config.ack', handleConfigAck);
    client.on('avatar.expression', onAvatarExpression);
    client.on('tts.segment_start', onSegmentStart);
    client.on('tts.playback_end', onPlaybackEnd);
    client.on('error', onError);

    return () => {
      client.off('asr.partial', onAsrPartial);
      client.off('asr.final', onAsrFinal);
      client.off('llm.delta', onLlmDelta);
      client.off('llm.done', onLlmDone);
      client.off('tts.audio', onTtsAudio);
      client.off('tts.end', onTtsEnd);
      client.off('debug.prompt_assembled', onPromptAssembled);
      client.off('session.config.ack', handleConfigAck);
      client.off('avatar.expression', onAvatarExpression);
      client.off('tts.segment_start', onSegmentStart);
      client.off('tts.playback_end', onPlaybackEnd);
      client.off('error', onError);
    };
  }, [onDebug, onConfigAck, pushDebug, setSubtitle, setVoiceStatus, setXiaokeEmotion, enqueueLlmExpression, consumeNextExpression, applyNetState, endAvatarTurn]);

  // 供外部调用的下发 + 开场白
  // 注意：此函数由 Studio 通过 ref / 事件驱动调用（见 StudioPage）
  // 这里暴露 window 上的辅助以便简单集成（实际由 Studio 直接调用 store + voice）
  // 真实下发逻辑集中在 StudioPage 里统一做。

  // 按住说话逻辑（精简自 VoiceButton）
  const onPointerDown = async (feedbackMode = false) => {
    if (startInFlightRef.current || pressedRef.current) return;

    // 公开模式语音对话限额：超限直接弹窗引导加微信，不录音（语音是真消耗，硬拦截点）
    if (EXPERIENCE_QUOTA_ENABLED && !useExperienceStore.getState().canVoice()) {
      useExperienceStore.getState().openModal();
      return;
    }

    pressedRef.current = true;
    needStopRef.current = false;
    setPressed(true);
    setActiveRecordMode(feedbackMode ? 'feedback' : 'normal');

    const client = clientRef.current;
    if (!client) return;

    try {
      await client.unlockAudio();
    } catch {}

    // 确保连接（小可同步演连网小剧场：敲键盘 → 跳起庆祝 / 哭哭）
    if (!client.isConnected()) {
      applyNetState('connecting');
      try {
        await client.connect(getVoiceWsUrl());
        setConnected(true);
        applyNetState('success');
      } catch (e) {
        setPressed(false);
        setActiveRecordMode(null);
        pressedRef.current = false;
        setSubtitle('语音服务连接失败');
        applyNetState('fail');
        return;
      }
    }

    client.bargeIn();
    // 需求1：录音前下发会话元数据，决定本轮是否吐槽捕获。
    // 显式吐槽按钮 OR 当前在 KidsHub 引导单元 → captureMode='feedback'（落库 + 小可吐槽人格回复）；
    // 普通「按住说话」→ 'off'（不进 KidsHub 后台）。best-effort，失败不挡录音主链路。
    const wantFeedback = feedbackMode || (tutorialActive && tutorialUnitId === 'kidshub');
    try {
      client.sendSessionMeta({
        sessionId: getKidsHubSessionId(),
        sceneId: activeCardId,
        nickname: useKidsHubStore.getState().variables.nickname || '',
        gender: useKidsHubStore.getState().variables.gender || '',
        age: useKidsHubStore.getState().variables.age || '',
        tutorialUnitId: tutorialActive ? tutorialUnitId : undefined,
        captureMode: wantFeedback ? 'feedback' : 'off',
        source: tutorialActive ? 'tutorial' : 'card',
      });
    } catch {
      /* meta best-effort：发送失败不影响录音 */
    }
    startInFlightRef.current = true;
    try {
      await client.startRecording();

      if (needStopRef.current) {
        client.stopRecording();
        needStopRef.current = false;
        setVoiceStatus('thinking');
        setXiaokeEmotion('calm');
      } else {
        setVoiceStatus('listening');
        setXiaokeEmotion('curious');
      }
    } catch (err) {
      pressedRef.current = false;
      needStopRef.current = false;
      setPressed(false);
      setActiveRecordMode(null);
      setVoiceStatus('idle');
      setSubtitle(err instanceof Error ? err.message : '麦克风启动失败');
    } finally {
      startInFlightRef.current = false;
    }
  };

  const onPointerUp = () => {
    if (!pressedRef.current) return;
    // 完成一次按住说话 = 消耗一轮语音对话额度（onPointerDown 已 gate 过未超限才到这）
    if (EXPERIENCE_QUOTA_ENABLED) useExperienceStore.getState().recordVoiceRound();
    pressedRef.current = false;
    setPressed(false);
    setActiveRecordMode(null);

    const client = clientRef.current;
    if (!client) return;

    if (startInFlightRef.current) {
      needStopRef.current = true;
      return;
    }

    client.stopRecording();
    // 松手 = 一轮 voice 计时起点（ASR→LLM TTFT→TTS 首包→端到端）
    perfStartTurn('voice');
    setVoiceStatus('thinking');
    setXiaokeEmotion('calm');
  };

  const doBargeIn = () => {
    const client = clientRef.current;
    if (client) {
      // 先 reset 打字机再 bargeIn：bargeIn 同步 emit playback_end，
      // 引擎空状态下 finishPlayback no-op，不会把被打断的句子又补完显示
      sharedTypewriter().reset();
      client.bargeIn();
      perfReset();
      setVoiceStatus('idle');
      setSubtitle('');
    }
  };

  const card = activeCardId ? getSceneCard(activeCardId) : null;
  const tutorialStep = tutorialActive ? getUnitStep(tutorialUnitId, tutorialStepIndex) : null;

  // 画布尺寸双约束自适应：之前只按宽度定高（max-w-800 + 5:3），矮视口（1366×768 /
  // 笔记本 100% 缩放）下画布把控制条顶出可视区。改为测量可用盒宽高，
  // 取 min(800, 可用宽, 可用高×5/3)，严格保 5:3——内部 cq 单位/百分比布局不受影响。
  const stageBoxRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(800);
  useEffect(() => {
    const el = stageBoxRef.current;
    if (!el) return;
    const PAD = 24; // p-3 两侧
    const compute = () => {
      const availW = el.clientWidth - PAD;
      const availH = el.clientHeight - PAD;
      if (availW <= 0 || availH <= 0) return;
      setStageWidth(Math.max(280, Math.min(800, availW, (availH * 5) / 3)));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950">
      {/* 引导协调器（无渲染）：状态机 ↔ 语音/字幕/表情副作用 */}
      <TutorialManager />
      {/* 画布容器：占据剩余高度（min-h-0 允许收缩），控制条/提示永远保底可见 */}
      <div
        ref={stageBoxRef}
        className="flex min-h-0 flex-1 items-center justify-center border-b border-white/10 bg-black/60 p-3"
      >
        <div
          className="relative overflow-hidden rounded-xl bg-[#0a1929] ring-1 ring-white/10"
          style={{
            width: stageWidth,
            aspectRatio: '5 / 3',
            containerType: 'size',
          }}
          data-scope="screen-canvas"
        >
          {tutorialActive ? (
            tutorialUnitId === 'boarding' ? (
              <BoardingCanvasContent />
            ) : tutorialUnitId === 'night-report' ? (
              <NightReportCanvasContent />
            ) : tutorialUnitId === 'focus' ? (
              <FocusCanvasContent />
            ) : tutorialUnitId === 'eco-pond' ? (
              <EcoPondCanvasContent />
            ) : tutorialUnitId === 'kidshub' ? (
              // 需求1：KidsHub 引导用 card5「情绪回应/点子墙」场景做背景，主题契合
              <CardScene card={getSceneCard('card5') ?? null} />
            ) : (
              <TutorialCanvasContent />
            )
          ) : (
            <CardScene card={card ?? null} />
          )}
          {/* 小可本体：表情库驱动的可互动形象（状态机兜底 + LLM 逐句选表情 + 点击逗它）。
              引导 3-x 步配表要求"小可隐藏，只留小手指+蒙版" */}
          {!tutorialStep?.hideAvatar && <XiaokeAvatar />}
          <KidsHubSubtitle />
          {/* 需求4：单元间衔接确认浮层（phase==='handoff' 显示「继续下一步 / 再来一次」按键） */}
          <TutorialHandoffPrompt />
        </div>
      </div>

      {/* 控制条（flex-shrink-0：任何视口高度下都不被画布挤出） */}
      <div className="relative flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-neutral-900 px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="按住说话"
            onPointerDown={(e) => {
              e.preventDefault();
              void onPointerDown(false);
            }}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={onPointerUp}
            className={`select-none rounded-full px-5 py-1.5 text-sm tracking-widest transition-all active:scale-[0.985] ${
              pressed && activeRecordMode === 'normal'
                ? 'bg-red-500/90 text-white shadow-[0_0_12px_rgba(239,68,68,0.5)]'
                : 'bg-neutral-800 text-white/80 ring-1 ring-white/10 hover:bg-neutral-700'
            }`}
          >
            {pressed && activeRecordMode === 'normal' ? '松手结束' : '按住说话'}
          </button>

          <button
            onClick={doBargeIn}
            className="rounded-full border border-white/15 bg-neutral-800 px-4 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700 active:bg-neutral-950"
          >
            打断
          </button>

          {/* 需求1：KidsHub 吐槽 = 按住直接录音，松手进 KidsHub 后台，小可用吐槽人格回应；
              普通「按住说话」不进后台。引导 KidsHub 单元的录音也自动走吐槽逻辑。 */}
          <button
            type="button"
            aria-label="按住吐槽"
            onPointerDown={(e) => {
              e.preventDefault();
              void onPointerDown(true);
            }}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={onPointerUp}
            title="按住对小可说出你的吐槽 / 建议 / 想法——松手后收进 KidsHub 后台，小可会认真回应你"
            className={`select-none rounded-full px-4 py-1.5 text-sm transition-all active:scale-[0.985] ${
              pressed && activeRecordMode === 'feedback'
                ? 'bg-red-500/90 text-white shadow-[0_0_12px_rgba(239,68,68,0.5)]'
                : 'border border-amber-400/40 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20'
            }`}
          >
            {pressed && activeRecordMode === 'feedback' ? '松手提交吐槽' : '💬 按住吐槽'}
          </button>

          {/* 表情库：PM 点任意表情直接驱动小可（验美术 / 调表情 prompt 用） */}
          <button
            onClick={() => setPickerOpen((v) => !v)}
            title="小可表情库：点击预览全部表情，标 AI 的是 LLM 回复时可自选的"
            className={`rounded-full px-4 py-1.5 text-sm transition ${
              pickerOpen
                ? 'bg-pink-500/80 text-white'
                : 'border border-pink-400/40 bg-pink-400/10 text-pink-300 hover:bg-pink-400/20'
            }`}
          >
            🎭 表情库
          </button>

          {/* 需求3：小可语速 1× / 1.5× / 2× */}
          <div className="flex items-center gap-1 rounded-full border border-white/10 bg-neutral-800 px-1.5 py-0.5">
            <span className="px-1 text-[11px] text-neutral-500">语速</span>
            {[1, 1.5, 2].map((sp) => (
              <button
                key={sp}
                onClick={() => setVoiceSpeed(sp)}
                title={`小可语速 ${sp}×`}
                className={`rounded-full px-2 py-0.5 text-xs transition ${
                  voiceSpeed === sp ? 'bg-sky-500 text-white' : 'text-neutral-400 hover:bg-neutral-700'
                }`}
              >
                {sp}×
              </button>
            ))}
          </div>

          {/* 需求4：一键跳过新手引导（仅引导进行中显示） */}
          {tutorialActive && (
            <button
              onClick={skipAllTutorials}
              title="跳过全部新手引导，直接开始体验"
              className="rounded-full border border-amber-400/30 bg-amber-400/10 px-4 py-1.5 text-sm text-amber-200/90 transition hover:bg-amber-400/20 active:bg-amber-400/5"
            >
              ⏭ 跳过引导
            </button>
          )}
        </div>

        <div className="text-[11px] text-neutral-500">
          {tutorialActive
            ? `🧭 设置引导中 · Step ${tutorialStep?.specStep ?? '?'}`
            : card
              ? `当前：${card.title}`
              : '未选卡 · 画布空闲'}
        </div>

        {pickerOpen && <ExpressionPicker onClose={() => setPickerOpen(false)} />}
      </div>

      {/* 简要提示 */}
      <div className="flex-shrink-0 px-3 py-2 text-[11px] text-neutral-500">
        按住说话后说一句话，松手 → 小可回复。打断可立即停止 TTS/ASR。
      </div>
    </div>
  );
}
