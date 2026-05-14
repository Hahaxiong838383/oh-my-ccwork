import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/app-store';
import { useAudioFx } from '../hooks/useAudioFx';
import { createVoiceClient, type VoiceClient } from '../services/voice-client';

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
  const connectedRef = useRef(false);
  const llmTextRef = useRef('');

  if (!clientRef.current) {
    clientRef.current = createVoiceClient();
  }

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;

    client.on('asr.partial', (msg: { text: string }) => {
      setSubtitle(msg.text);
    });

    client.on('asr.final', (msg: { text: string }) => {
      setSubtitle(`${msg.text}...`);
      llmTextRef.current = '';
    });

    client.on('llm.delta', (msg: { text: string }) => {
      if (!msg.text) return;
      llmTextRef.current += msg.text;
      setSubtitle(llmTextRef.current);
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
    });

    client.on('tts.audio', (msg: { mp3Base64: string }) => {
      void client.playAudioChunk(msg.mp3Base64);
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
    });

    client.on('tts.end', () => {
      setVoiceStatus('idle');
      setXiaokeEmotion('happy');
      llmTextRef.current = '';
    });

    client.on('error', (msg: { message?: string }) => {
      setVoiceStatus('idle');
      setSubtitle(msg.message ?? '语音服务异常，请重试');
    });

    return () => {
      client.close();
      connectedRef.current = false;
    };
  }, [setSubtitle, setVoiceStatus, setXiaokeEmotion]);

  const onPointerDown = async () => {
    setPressed(true);
    unlock();

    const client = clientRef.current;
    if (!client) return;

    try {
      if (!connectedRef.current) {
        await client.connect(getVoiceWsUrl());
        connectedRef.current = true;
      }

      client.bargeIn();
      await client.startRecording();
      setVoiceStatus('listening');
      setXiaokeEmotion('curious');
    } catch (err) {
      setPressed(false);
      connectedRef.current = false;
      setVoiceStatus('idle');
      setSubtitle(err instanceof Error ? err.message : '麦克风启动失败');
    }
  };

  const onPointerUp = () => {
    if (!pressed) return;
    setPressed(false);

    const client = clientRef.current;
    if (!client) return;

    client.stopRecording();
    setVoiceStatus('thinking');
    setXiaokeEmotion('calm');

    // thinking 占位音：等真实 TTS chunk 到达后自动切 speaking。
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
