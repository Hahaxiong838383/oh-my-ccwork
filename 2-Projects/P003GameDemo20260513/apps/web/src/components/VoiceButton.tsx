import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/app-store';
import { useAudioFx } from '../hooks/useAudioFx';
import { getSharedVoiceClient, type VoiceClient } from '../services/voice-client';

interface VoiceButtonProps {}

function getVoiceWsUrl(): string {
  const envUrl = import.meta.env.VITE_VOICE_WS_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl;

  // 同 origin WSS：dev 时 vite proxy 转发到本地 3001，
  // 部署后由 nginx/反代终结 wss。避免 HTTPS 页面连 ws:// 的 mixed content 拦截。
  const isHttps = window.location.protocol === 'https:';
  const protocol = isHttps ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws/voice`;
}

export function VoiceButton(_props: VoiceButtonProps) {
  const setVoiceStatus = useAppStore((s) => s.setVoiceStatus);
  const setSubtitle = useAppStore((s) => s.setSubtitle);
  const setXiaokeEmotion = useAppStore((s) => s.setXiaokeEmotion);
  const { unlock, playThinking } = useAudioFx();

  const [pressed, setPressed] = useState(false);
  const clientRef = useRef<VoiceClient | null>(null);
  const llmTextRef = useRef('');
  // D5 P19：字幕按 TTS sentence_break 推进，避免显示 LLM 全文超前 TTS 进度
  // D5 P20：firstAudioFiredRef 标"首段 tts.audio 已到"，之前 onLlmDelta 不 setSubtitle
  const sentenceListRef = useRef<string[]>([]);
  const sentenceIdxRef = useRef(0);
  const firstAudioFiredRef = useRef(false);
  // 异步竞态防护：pressedRef 反映"用户当前是否按住"，startInFlightRef 标启动中，
  // needStopRef 标"启动期间用户已松手，启动完成后必须立刻 stop"。
  const pressedRef = useRef(false);
  const startInFlightRef = useRef(false);
  const needStopRef = useRef(false);

  // 用 module-level 单例，让 jumpToScene 等非组件代码也能 bargeIn 中断在途会话
  if (!clientRef.current) {
    clientRef.current = getSharedVoiceClient();
  }

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;

    // React StrictMode 在 dev 跑 useEffect 两次，必须用 off 解绑避免重复触发
    const onAsrPartial = (msg: { text: string }) => {
      setSubtitle(msg.text);
    };
    const onAsrFinal = (msg: { text: string }) => {
      setSubtitle(`${msg.text}...`);
      llmTextRef.current = '';
      sentenceListRef.current = [];
      sentenceIdxRef.current = 0;
      firstAudioFiredRef.current = false;
    };
    // D5 P19：累积 LLM 全文 + 按句切分，字幕只显示当前正在 TTS 的句
    const splitSentences = (text: string): string[] => {
      const out: string[] = [];
      let buf = '';
      for (const ch of text) {
        buf += ch;
        if (/[。！？!?\n]/.test(ch)) {
          const trimmed = buf.trim();
          if (trimmed) out.push(trimmed);
          buf = '';
        }
      }
      const tail = buf.trim();
      if (tail) out.push(tail);
      return out;
    };
    const onLlmDelta = (msg: { text: string }) => {
      if (!msg.text) return;
      llmTextRef.current += msg.text;
      sentenceListRef.current = splitSentences(llmTextRef.current);
      // D5 P20：LLM 比 TTS 先到，这里只累积+切句，不 setSubtitle
      // 等首段 tts.audio 触发 onTtsAudio 时才显示第 1 句
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
      // 如果首段音频已到（LLM delta 晚于首段音频的罕见情况），立即推当前句
      if (firstAudioFiredRef.current) {
        const idx = Math.min(sentenceIdxRef.current, sentenceListRef.current.length - 1);
        const current = sentenceListRef.current[idx];
        if (current) setSubtitle(current);
      }
    };
    const onTtsAudio = (_msg: { mp3Base64: string }) => {
      // 播放由 voice-client 内部统一处理（兼容 sayDirect 等无 VoiceButton 的路径）
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
      // D5 P20：首段音频到达 → 字幕显示第 1 句（与 TTS 真发声同步）
      if (!firstAudioFiredRef.current) {
        firstAudioFiredRef.current = true;
        const first = sentenceListRef.current[0];
        if (first) setSubtitle(first);
      }
    };
    const onTtsSentenceBreak = () => {
      // 每收到一句 TTS 句末信号，字幕推进到下一句
      sentenceIdxRef.current += 1;
      const idx = Math.min(sentenceIdxRef.current, sentenceListRef.current.length - 1);
      const current = sentenceListRef.current[idx];
      if (current) setSubtitle(current);
    };
    const onTtsEnd = () => {
      // flush 由 voice-client 内部处理
      setVoiceStatus('idle');
      setXiaokeEmotion('happy');
      llmTextRef.current = '';
      sentenceListRef.current = [];
      sentenceIdxRef.current = 0;
      firstAudioFiredRef.current = false;
    };
    const onError = (msg: { message?: string }) => {
      setVoiceStatus('idle');
      setSubtitle(msg.message ?? '语音服务异常，请重试');
    };

    client.on('asr.partial', onAsrPartial);
    client.on('asr.final', onAsrFinal);
    client.on('llm.delta', onLlmDelta);
    client.on('tts.audio', onTtsAudio);
    client.on('tts.sentence_break', onTtsSentenceBreak);
    client.on('tts.end', onTtsEnd);
    client.on('error', onError);

    return () => {
      client.off('asr.partial', onAsrPartial);
      client.off('asr.final', onAsrFinal);
      client.off('llm.delta', onLlmDelta);
      client.off('tts.audio', onTtsAudio);
      client.off('tts.sentence_break', onTtsSentenceBreak);
      client.off('tts.end', onTtsEnd);
      client.off('error', onError);
      // 注意：不 client.close()，让 client 跨 effect 复用（避免 StrictMode 关掉 ws）
    };
  }, [setSubtitle, setVoiceStatus, setXiaokeEmotion]);

  const onPointerDown = async () => {
    // 重入防护：启动中再次按下忽略
    if (startInFlightRef.current || pressedRef.current) return;

    pressedRef.current = true;
    needStopRef.current = false;
    setPressed(true);
    unlock();

    const client = clientRef.current;
    if (!client) return;

    startInFlightRef.current = true;
    try {
      // 实时查 ws 状态，避免"上次连过就跳过 connect 但 ws 已断"的首按失败
      if (!client.isConnected()) {
        await client.connect(getVoiceWsUrl());
      }

      client.bargeIn();
      await client.startRecording();

      // 启动期间用户已松手 → 立刻补 stop，不让麦克风继续录
      if (needStopRef.current) {
        client.stopRecording();
        needStopRef.current = false;
        setVoiceStatus('thinking');
        setXiaokeEmotion('calm');
        playThinking();
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

    // 启动还在飞行中 → 标记 needStop，让 startRecording 完成后立刻补 stop
    if (startInFlightRef.current) {
      needStopRef.current = true;
      return;
    }

    client.stopRecording();
    setVoiceStatus('thinking');
    setXiaokeEmotion('calm');
    playThinking();
  };

  return (
    <button
      type="button"
      aria-label="按住说话"
      onPointerDown={(evt) => {
        evt.preventDefault();
        void onPointerDown();
      }}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerUp}
      className={`relative inline-flex h-9 select-none items-center gap-2 rounded-full px-5 text-[11px] tracking-widest transition-all duration-150 ${
        pressed
          ? 'bg-red-500/90 text-white shadow-[0_0_18px_rgba(239,68,68,0.6)] ring-2 ring-red-300/50'
          : 'bg-shell-trim text-white/70 shadow-inner shadow-black/40 ring-1 ring-white/5 hover:text-white/90'
      }`}
    >
      <span className={`text-[14px] leading-none ${pressed ? '' : 'opacity-80'}`}>🎤</span>
      <span>{pressed ? '聆听中…' : '按住说话'}</span>
      {pressed && <span className="absolute inset-0 rounded-full border border-red-200/40 animate-ping" />}
    </button>
  );
}
