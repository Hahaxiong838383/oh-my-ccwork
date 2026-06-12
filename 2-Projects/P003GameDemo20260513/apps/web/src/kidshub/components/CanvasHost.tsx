import { useEffect, useRef, useState } from 'react';
// kidshub 专属场景层（CardScene）+ 专属字幕条（KidsHubSubtitle），与原 demo 组件解耦：
// 原 StatusBar 的 popLayout 跨句动画与打字机高频更新冲突（exit 节点泄漏出重复字）
import { KidsHubSubtitle } from './KidsHubSubtitle';
import { CardScene } from './CardScene';
import { XiaokeAvatar } from '../avatar/XiaokeAvatar';
import { ExpressionPicker } from '../avatar/ExpressionPicker';
import { TutorialManager } from '../tutorial/TutorialManager';
import { TutorialCanvasContent } from '../tutorial/TutorialCanvasContent';
import { useTutorialStore } from '../tutorial/tutorial-store';
import { getStepByIndex } from '../tutorial/tutorial-settings';
import { useAvatarStore } from '../avatar/avatar-store';
import { resolveExpressionName } from '../avatar/expressions';
import { sharedTypewriter } from '../subtitle/shared';
import {
  getSharedVoiceClient,
  type VoiceClient,
} from '../../services/voice-client';
import { useKidsHubStore } from '../store/kidshub-store';
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
  const selectCard = useKidsHubStore((s) => s.selectCard);
  const pushDebug = useKidsHubStore((s) => s.pushDebug);
  const tutorialActive = useTutorialStore((s) => s.isActive);
  const tutorialStepIndex = useTutorialStore((s) => s.stepIndex);

  const setVoiceStatus = useAppStore((s) => s.setVoiceStatus);
  const setSubtitle = useAppStore((s) => s.setSubtitle);
  const setXiaokeEmotion = useAppStore((s) => s.setXiaokeEmotion);

  const enqueueLlmExpression = useAvatarStore((s) => s.enqueueLlmExpression);
  const consumeNextExpression = useAvatarStore((s) => s.consumeNextExpression);
  const applyNetState = useAvatarStore((s) => s.applyNetState);
  const endAvatarTurn = useAvatarStore((s) => s.endTurn);

  const clientRef = useRef<VoiceClient | null>(null);
  const [pressed, setPressed] = useState(false);
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
    const onSegmentStart = () => {
      consumeNextExpression();
      tw.advanceSentence();
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
  const onPointerDown = async () => {
    if (startInFlightRef.current || pressedRef.current) return;

    pressedRef.current = true;
    needStopRef.current = false;
    setPressed(true);

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
        pressedRef.current = false;
        setSubtitle('语音服务连接失败');
        applyNetState('fail');
        return;
      }
    }

    client.bargeIn();
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
      setVoiceStatus('idle');
      setSubtitle(err instanceof Error ? err.message : '麦克风启动失败');
    } finally {
      startInFlightRef.current = false;
    }
  };

  const onPointerUp = () => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    setPressed(false);

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
  const tutorialStep = tutorialActive ? getStepByIndex(tutorialStepIndex) : null;

  return (
    <div className="flex h-full flex-col bg-neutral-950">
      {/* 引导协调器（无渲染）：状态机 ↔ 语音/字幕/表情副作用 */}
      <TutorialManager />
      {/* 画布容器：严格 800x480 等比 + container queries 支持 */}
      <div className="flex items-center justify-center border-b border-white/10 bg-black/60 p-3">
        <div
          className="relative w-full max-w-[800px] overflow-hidden rounded-xl bg-[#0a1929] ring-1 ring-white/10"
          style={{
            aspectRatio: '5 / 3',
            containerType: 'size',
          }}
          data-scope="screen-canvas"
        >
          {tutorialActive ? <TutorialCanvasContent /> : <CardScene card={card ?? null} />}
          {/* 小可本体：表情库驱动的可互动形象（状态机兜底 + LLM 逐句选表情 + 点击逗它）。
              引导 3-x 步配表要求"小可隐藏，只留小手指+蒙版" */}
          {!tutorialStep?.hideAvatar && <XiaokeAvatar />}
          <KidsHubSubtitle />
        </div>
      </div>

      {/* 控制条 */}
      <div className="relative flex items-center justify-between gap-3 border-b border-white/10 bg-neutral-900 px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="按住说话"
            onPointerDown={(e) => {
              e.preventDefault();
              void onPointerDown();
            }}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={onPointerUp}
            className={`select-none rounded-full px-5 py-1.5 text-sm tracking-widest transition-all active:scale-[0.985] ${
              pressed
                ? 'bg-red-500/90 text-white shadow-[0_0_12px_rgba(239,68,68,0.5)]'
                : 'bg-neutral-800 text-white/80 ring-1 ring-white/10 hover:bg-neutral-700'
            }`}
          >
            {pressed ? '松手结束' : '按住说话'}
          </button>

          <button
            onClick={doBargeIn}
            className="rounded-full border border-white/15 bg-neutral-800 px-4 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700 active:bg-neutral-950"
          >
            打断
          </button>

          {/* KidsHub 反馈是贯穿小可体验的全局能力（任何场景都可吐槽/提建议），常驻入口 */}
          <button
            onClick={() => selectCard('card5')}
            title="KidsHub 反馈贯穿所有场景：随时切到卡 5 体验完整反馈流（附加规则已让所有场景都能接住建议/吐槽）"
            className={`rounded-full px-4 py-1.5 text-sm transition ${
              activeCardId === 'card5'
                ? 'bg-amber-500/90 text-neutral-950'
                : 'border border-amber-400/40 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20'
            }`}
          >
            💬 KidsHub
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
      <div className="px-3 py-2 text-[11px] text-neutral-500">
        按住说话后说一句话，松手 → 小可回复。打断可立即停止 TTS/ASR。
      </div>
    </div>
  );
}
