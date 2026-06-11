import { useEffect, useRef, useState } from 'react';
// kidshub 专属场景层（CardScene），与原 demo 场景组件完全解耦；
// StatusBar 复用原 demo 字幕系统（读 app-store.subtitle，TTS 严同步逻辑现成）
import { StatusBar } from '../../components/StatusBar';
import { CardScene } from './CardScene';
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

  const setVoiceStatus = useAppStore((s) => s.setVoiceStatus);
  const setSubtitle = useAppStore((s) => s.setSubtitle);
  const setXiaokeEmotion = useAppStore((s) => s.setXiaokeEmotion);

  const clientRef = useRef<VoiceClient | null>(null);
  const [pressed, setPressed] = useState(false);
  const pressedRef = useRef(false);
  const startInFlightRef = useRef(false);
  const needStopRef = useRef(false);
  const llmTextRef = useRef('');

  const [, setConnected] = useState(false);

  // 确保单例
  if (!clientRef.current) {
    clientRef.current = getSharedVoiceClient();
  }

  // 周期同步连接状态（给顶栏用）
  useEffect(() => {
    const id = window.setInterval(() => {
      const c = clientRef.current;
      setConnected(!!(c && c.isConnected()));
    }, 800);
    return () => window.clearInterval(id);
  }, []);

  // 挂载 voice 事件监听（仅调试流 + 画布字幕驱动）
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;

    const onAsrPartial = (msg: { text: string }) => {
      setSubtitle(msg.text);
    };
    const onAsrFinal = (msg: { text: string }) => {
      perfMarkAsrFinal();
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
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
    };
    const onLlmDone = (msg: { text?: string }) => {
      const full = (msg && msg.text) || llmTextRef.current || '';
      setVoiceStatus('idle');
      setXiaokeEmotion('happy');
      if (full) {
        setSubtitle(full);
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
      setVoiceStatus('idle');
      setXiaokeEmotion('happy');
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
    const onError = (msg: { message?: string; code?: string }) => {
      const t = msg.message || msg.code || '语音服务错误';
      onDebug('error', `❌ ${t}`);
      pushDebug({ kind: 'error', title: `❌ ${t}` });
      setVoiceStatus('idle');
      setSubtitle(t);
    };

    client.on('asr.partial', onAsrPartial);
    client.on('asr.final', onAsrFinal);
    client.on('llm.delta', onLlmDelta);
    client.on('llm.done', onLlmDone);
    client.on('tts.audio', onTtsAudio);
    client.on('tts.end', onTtsEnd);
    client.on('debug.prompt_assembled', onPromptAssembled);
    client.on('session.config.ack', handleConfigAck);
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
      client.off('error', onError);
    };
  }, [onDebug, onConfigAck, pushDebug, setSubtitle, setVoiceStatus, setXiaokeEmotion]);

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

    // 确保连接
    if (!client.isConnected()) {
      try {
        await client.connect(getVoiceWsUrl());
        setConnected(true);
      } catch (e) {
        setPressed(false);
        pressedRef.current = false;
        setSubtitle('语音服务连接失败');
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
      client.bargeIn();
      perfReset();
      setVoiceStatus('idle');
      setSubtitle('');
    }
  };

  const card = activeCardId ? getSceneCard(activeCardId) : null;

  return (
    <div className="flex h-full flex-col bg-neutral-950">
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
          <CardScene card={card ?? null} />
          <StatusBar />
        </div>
      </div>

      {/* 控制条 */}
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-neutral-900 px-3 py-2">
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
        </div>

        <div className="text-[11px] text-neutral-500">
          {card ? `当前：${card.title}` : '未选卡 · 画布空闲'}
        </div>
      </div>

      {/* 简要提示 */}
      <div className="px-3 py-2 text-[11px] text-neutral-500">
        按住说话后说一句话，松手 → 小可回复。打断可立即停止 TTS/ASR。
      </div>
    </div>
  );
}
