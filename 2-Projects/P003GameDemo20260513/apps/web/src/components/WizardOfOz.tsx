import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/app-store';

interface WizardOfOzProps {}

export function WizardOfOz(_props: WizardOfOzProps) {
  const setSubtitle = useAppStore((s) => s.setSubtitle);
  const setXiaokeEmotion = useAppStore((s) => s.setXiaokeEmotion);
  const setVoiceStatus = useAppStore((s) => s.setVoiceStatus);
  const setFocusStatus = useAppStore((s) => s.setFocusStatus);
  const addStardust = useAppStore((s) => s.addStardust);

  const resetVoiceTimerRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdActiveRef = useRef(false);
  const speakingTimerRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);

  const clearFlowTimers = () => {
    if (resetVoiceTimerRef.current !== null) {
      window.clearTimeout(resetVoiceTimerRef.current);
      resetVoiceTimerRef.current = null;
    }
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (speakingTimerRef.current !== null) {
      window.clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;

      if (event.key === ' ') {
        if (holdTimerRef.current !== null || holdActiveRef.current) return;
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null;
          holdActiveRef.current = true;
          setVoiceStatus('listening');
          setXiaokeEmotion('curious');
        }, 500);
        return;
      }

      if (event.key === '1') {
        clearFlowTimers();
        setSubtitle('指挥官回家啦！今天一起读书吧～');
        setXiaokeEmotion('warm');
        setVoiceStatus('speaking');
        resetVoiceTimerRef.current = window.setTimeout(() => {
          setVoiceStatus('idle');
        }, 3000);
        return;
      }

      if (event.key === '2') {
        setSubtitle('哇，你做到啦！太棒了！');
        setXiaokeEmotion('excited');
        return;
      }

      if (event.key === '3') {
        setSubtitle('我想想哦...嗯，因为月亮其实没有跟着你走呢');
        setXiaokeEmotion('curious');
        return;
      }

      if (event.key === '0') {
        clearFlowTimers();
        holdActiveRef.current = false;
        setVoiceStatus('idle');
        setSubtitle('');
        setXiaokeEmotion('happy');
        setFocusStatus('idle');
        return;
      }

      if (event.key === '+' || event.key === '=') {
        addStardust(100);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== ' ') return;

      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }

      if (!holdActiveRef.current) return;

      holdActiveRef.current = false;
      setVoiceStatus('thinking');
      setXiaokeEmotion('calm');

      speakingTimerRef.current = window.setTimeout(() => {
        setVoiceStatus('speaking');
        setXiaokeEmotion('happy');
        setSubtitle('你好指挥官，今天想做什么呀？');
      }, 600);

      idleTimerRef.current = window.setTimeout(() => {
        setVoiceStatus('idle');
      }, 2100);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      clearFlowTimers();
      holdActiveRef.current = false;
    };
  }, [addStardust, setFocusStatus, setSubtitle, setVoiceStatus, setXiaokeEmotion]);

  return null;
}
