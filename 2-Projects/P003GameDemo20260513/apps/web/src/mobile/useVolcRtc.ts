import { useCallback, useRef, useState } from 'react';
import { useAppStore } from '../store/app-store';
import { useKidsHubStore } from '../kidshub/store/kidshub-store';

// 火山 RTC SDK（@volcengine/rtc）约 12MB，仅手机端实时对话用 → 动态 import 做 code-split，
// 体验台/工作台不加载它（否则主 bundle 暴涨 + 超 PWA SW precache 限制）。

// 火山 AIGC 状态机（onRoomBinaryMessageReceived 的 BRIEF 消息，docs 6348/1415216）
const AGENT_BRIEF = { UNKNOWN: 0, LISTENING: 1, THINKING: 2, SPEAKING: 3, INTERRUPTED: 4, FINISHED: 5 } as const;
const MSG_BRIEF = 'conv';
const MSG_SUBTITLE = 'subv';

/** TLV → { type, value }（移植 demo utils，big-endian length）。 */
function tlv2String(tlvBuffer: ArrayBufferLike): { type: string; value: string } {
  const typeBuffer = new Uint8Array(tlvBuffer, 0, 4);
  const lengthBuffer = new Uint8Array(tlvBuffer, 4, 4);
  const valueBuffer = new Uint8Array(tlvBuffer, 8);
  let type = '';
  for (let i = 0; i < typeBuffer.length; i++) type += String.fromCharCode(typeBuffer[i]!);
  const length = (lengthBuffer[0]! << 24) | (lengthBuffer[1]! << 16) | (lengthBuffer[2]! << 8) | lengthBuffer[3]!;
  const value = new TextDecoder().decode(valueBuffer.subarray(0, length));
  return { type, value };
}

export interface UseVolcRtc {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  needTapToPlay: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  resumePlay: () => void;
}

export function useVolcRtc(): UseVolcRtc {
  const authToken = useKidsHubStore((s) => s.token); // 登录 JWT → 透传 server → CustomLLM 注入记忆
  const setVoiceStatus = useAppStore((s) => s.setVoiceStatus);
  const setSubtitle = useAppStore((s) => s.setSubtitle);
  const setUserSubtitle = useAppStore((s) => s.setUserSubtitle);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const engineRef = useRef<any>(null);
  const vertcRef = useRef<any>(null);
  const sessionRef = useRef<{ roomId: string; taskId: string; userId: string } | null>(null);
  const failedUsersRef = useRef<Set<string>>(new Set());
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needTapToPlay, setNeedTapToPlay] = useState(false);

  /** 解析火山二进制消息（状态 + 字幕）→ 更新 store。 */
  const handleBinary = useCallback(
    (event: { userId: string; message: ArrayBuffer }) => {
      try {
        const { type, value } = tlv2String(event.message);
        if (type === MSG_BRIEF) {
          const code = JSON.parse(value)?.Stage?.Code;
          if (code === AGENT_BRIEF.THINKING) setVoiceStatus('thinking');
          else if (code === AGENT_BRIEF.SPEAKING) setVoiceStatus('speaking');
          else if (code === AGENT_BRIEF.LISTENING || code === AGENT_BRIEF.FINISHED || code === AGENT_BRIEF.INTERRUPTED)
            setVoiceStatus('listening');
        } else if (type === MSG_SUBTITLE) {
          const data = JSON.parse(value)?.data?.[0];
          const myId = sessionRef.current?.userId;
          if (data?.text && data.userId) {
            if (data.userId === myId) setUserSubtitle(data.text); // 用户说的（ASR 转写，给川哥看识别准不准）
            else setSubtitle(data.text); // 小可说的
          }
        }
      } catch {
        /* tlv/json 解析异常忽略 */
      }
    },
    [setVoiceStatus, setSubtitle, setUserSubtitle],
  );

  const start = useCallback(async () => {
    if (engineRef.current || connecting) return;
    setConnecting(true);
    setError(null);
    setNeedTapToPlay(false);
    try {
      console.log('[volc] fetch /api/rtc/start');
      const res = await fetch('/api/rtc/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: '{}',
      });
      const data = (await res.json()) as { ok: boolean; error?: string; appId: string; roomId: string; userId: string; token: string; taskId: string };
      if (!data.ok) throw new Error(data.error || '起 AI 失败');
      sessionRef.current = { roomId: data.roomId, taskId: data.taskId, userId: data.userId };

      console.log('[volc] load SDK + createEngine');
      const rtcMod: any = await import('@volcengine/rtc'); // eslint-disable-line @typescript-eslint/no-explicit-any
      const VERTC = rtcMod.default;
      const { MediaType, RoomProfileType } = rtcMod;
      vertcRef.current = VERTC;
      const engine = VERTC.createEngine(data.appId);
      engineRef.current = engine;
      // ⚠️ 不再注册 AI 降噪扩展（extension-ainr）——手机 Chrome 加载降噪 WASM 会卡住 registerExtension
      //    导致 connecting 永久挂起；火山云侧本就有 3A 回声消除/降噪，端侧降噪是冗余可省。

      engine.on(VERTC.events.onRoomBinaryMessageReceived, handleBinary as never);
      engine.on(VERTC.events.onAutoplayFailed, ((e: { userId?: string }) => {
        console.log('[volc] AUTOPLAY FAILED user=', e?.userId);
        if (e?.userId) failedUsersRef.current.add(e.userId);
        setNeedTapToPlay(true);
      }) as never);

      console.log('[volc] joinRoom...');
      await engine.joinRoom(
        data.token,
        data.roomId,
        { userId: data.userId, extraInfo: JSON.stringify({ call_scene: 'RTC-AIGC', user_id: data.userId }) },
        { isAutoPublish: true, isAutoSubscribeAudio: true, roomProfileType: RoomProfileType.chat },
      );
      // ★ 进房成功即视为连上（不等麦克风采集）——麦克风权限弹窗慢不该卡住 UI / 小可的开场白
      console.log('[volc] joined → connected');
      // 降远端播放音量（川哥反馈过响）；与 server 端 loudness_ratio 0.6 叠加，综合约 30%
      try {
        engine.setPlaybackVolume?.(50);
      } catch {
        /* 老 SDK 无此方法忽略 */
      }
      setConnected(true);
      setConnecting(false);
      setVoiceStatus('listening');

      // 采麦 + 发布（异步，权限慢/失败不阻塞连接与小可开口）
      engine
        .startAudioCapture()
        .then(() => {
          engine.publishStream(MediaType.AUDIO);
          console.log('[volc] mic captured + published');
        })
        .catch((e: Error) => {
          console.log('[volc] mic fail:', e?.message);
          setError('麦克风没打开，小可听不到你——点圆圈重试或检查麦克风权限');
        });
    } catch (e) {
      console.log('[volc] start ERROR:', (e as Error)?.message);
      setError((e as Error)?.message ?? String(e));
      const engine = engineRef.current;
      if (engine) {
        try {
          await engine.leaveRoom();
        } catch {
          /* ignore */
        }
        vertcRef.current?.destroyEngine?.(engine);
        engineRef.current = null;
      }
      setConnected(false);
      setVoiceStatus('idle');
      setConnecting(false);
    }
  }, [connecting, handleBinary, setVoiceStatus, authToken]);

  /** autoplay 被浏览器拦时，用户手势内恢复播放 AI 音频。 */
  const resumePlay = useCallback(() => {
    const engine = engineRef.current;
    if (engine) {
      for (const uid of failedUsersRef.current) {
        try {
          engine.play?.(uid);
        } catch {
          /* ignore */
        }
      }
      failedUsersRef.current.clear();
    }
    setNeedTapToPlay(false);
  }, []);

  const stop = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) {
      try {
        await engine.stopAudioCapture();
      } catch {
        /* ignore */
      }
      try {
        await engine.leaveRoom();
      } catch {
        /* ignore */
      }
      vertcRef.current?.destroyEngine?.(engine);
      engineRef.current = null;
    }
    const sess = sessionRef.current;
    if (sess) {
      void fetch('/api/rtc/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: sess.roomId, taskId: sess.taskId }),
      }).catch(() => {});
      sessionRef.current = null;
    }
    failedUsersRef.current.clear();
    setConnected(false);
    setConnecting(false);
    setNeedTapToPlay(false);
    setVoiceStatus('idle');
    setSubtitle('');
    setUserSubtitle('');
  }, [setVoiceStatus, setSubtitle, setUserSubtitle]);

  return { connected, connecting, error, needTapToPlay, start, stop, resumePlay };
}
