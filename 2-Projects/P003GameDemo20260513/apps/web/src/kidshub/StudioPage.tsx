import { useEffect, useState } from 'react';
import { useKidsHubStore, getComposedPromptNow } from './store/kidshub-store';
import { getSceneCard, SPEC_META } from './prompts';
import { perfStartTurn } from './perf-tracker';
import { SceneNav } from './components/SceneNav';
import { CardDetail } from './components/CardDetail';
import { SectionReader } from './components/SectionReader';
import { CanvasHost } from './components/CanvasHost';
import { DebugFlow } from './components/DebugFlow';
import { PromptPanel } from './components/PromptPanel';
import { getSharedVoiceClient } from '../services/voice-client';
import { useAppStore } from '../store/app-store';

function getVoiceWsUrl(): string {
  const envUrl = (import.meta as any).env?.VITE_VOICE_WS_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl;
  const isHttps = window.location.protocol === 'https:';
  const protocol = isHttps ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws/voice`;
}

export function StudioPage() {
  const setToken = useKidsHubStore((s) => s.setToken);

  const activeCardId = useKidsHubStore((s) => s.activeCardId);
  const activeSectionId = useKidsHubStore((s) => s.activeSectionId);
  const promptDirty = useKidsHubStore((s) => s.promptDirty);
  const markPromptDirty = useKidsHubStore((s) => s.markPromptDirty);
  const pushDebug = useKidsHubStore((s) => s.pushDebug);

  const [showSection, setShowSection] = useState(false); // 控制左栏下半显示阅读还是详情
  const [toast, setToast] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  // 周期刷新 ws 状态（顶栏）
  useEffect(() => {
    const client = getSharedVoiceClient();
    const id = window.setInterval(() => {
      setWsConnected(client.isConnected());
    }, 700);
    return () => window.clearInterval(id);
  }, []);

  // 进入 Studio 预连接（不阻塞）
  useEffect(() => {
    const client = getSharedVoiceClient();
    client.connect(getVoiceWsUrl()).catch(() => {
      /* 静默，后面再说 */
    });
  }, []);

  // 核心交互序列：选中卡
  useEffect(() => {
    if (!activeCardId) return;

    const card = getSceneCard(activeCardId);
    if (!card) return;

    // 1. store 已在 selectCard 里设置，这里只做副作用

    // 2. 画布场景由 CardScene 按 activeCardId 渲染（kidshub 专属场景层，无需跳原 demo 状态机）
    // 清掉上一张卡残留字幕
    useAppStore.getState().setSubtitle('');

    // 3. 强制设置 commander_suffix
    // 注意：setVariable 会把 dirty 设 true，这里我们手动在后面处理
    useKidsHubStore.setState((s) => ({
      variables: { ...s.variables, commander_suffix: card.commanderSuffix },
    }));

    // 4. 组装 + 下发 + 开场触发（顺序保证：config 先到 server，trigger 后到）
    const composed = getComposedPromptNow();
    const client = getSharedVoiceClient();

    void (async () => {
      try {
        await client.unlockAudio();
      } catch {}
      try {
        if (!client.isConnected()) {
          await client.connect(getVoiceWsUrl());
        }
        client.sendSessionConfig(composed);
        pushDebug({
          kind: 'config',
          title: `下发 session.config（${composed.length} 字符）· ${card.title}`,
        });
        markPromptDirty(false);

        // 5. 开场触发：LLM 基于场景 prompt 实时生成开场白（参考示例风格，每次不同）
        if (card.triggerInstruction) {
          perfStartTurn('trigger');
          client.sendChatTrigger(card.triggerInstruction);
          pushDebug({ kind: 'action', title: `开场触发 → LLM 生成开场白`, detail: card.triggerInstruction });
        }
      } catch (e) {
        pushDebug({ kind: 'error', title: 'sendSessionConfig 失败' });
      }
    })();

    // 6. debug action
    pushDebug({ kind: 'action', title: `进入卡${card.cardNo}·${card.title}` });
  }, [activeCardId]); // 仅依赖 id，内部手动读最新变量

  // 当 activeSection 变了就显示阅读器
  useEffect(() => {
    setShowSection(!!activeSectionId);
  }, [activeSectionId]);

  const currentCard = activeCardId ? getSceneCard(activeCardId) : null;

  // 下发生效（右栏按钮）
  const handleSend = () => {
    if (!activeCardId) return;
    const composed = getComposedPromptNow();
    const client = getSharedVoiceClient();

    void (async () => {
      try {
        if (!client.isConnected()) {
          await client.connect(getVoiceWsUrl());
        }
        client.sendSessionConfig(composed);
        pushDebug({ kind: 'config', title: `手动下发（${composed.length} 字符）` });
        markPromptDirty(false);
      } catch {
        pushDebug({ kind: 'error', title: '手动下发失败' });
      }
    })();
  };

  // 导出 = 复制 + toast
  const handleExport = async () => {
    const text = getComposedPromptNow();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setToast('已复制组装后的完整 Prompt 到剪贴板');
    window.setTimeout(() => setToast(null), 1600);
  };

  // CanvasHost 回调：把 config ack 也记一下
  const handleConfigAck = (_msg: { chars: number }) => {
    // 已在 CanvasHost 内部 push，这里可以再标记已同步
  };

  // debug 回调（CanvasHost 内部已同时 push，这里主要是为了统一）
  const handleCanvasDebug = (_kind: any, _title: string, _detail?: string) => {
    // CanvasHost 已经 push，这里留空或做额外处理
  };

  const handleLogout = () => {
    setToken(null);
  };

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-200">
      {/* 顶栏 */}
      <div className="flex items-center justify-between border-b border-white/10 bg-neutral-900 px-4 py-2 text-sm">
        <div className="flex items-center gap-3">
          <span className="font-semibold tracking-tight text-white">KidsHub-AI · 小可 Prompt 体验工作台</span>
          <a
            href={SPEC_META.docUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-white/10 bg-neutral-800 px-2.5 py-0.5 text-[10px] text-emerald-300 hover:border-emerald-400/60"
            title="打开产品定义文档"
          >
            {SPEC_META.docName} {SPEC_META.docVersion}
          </a>
        </div>

        <div className="flex items-center gap-4 text-xs">
          {/* WS 状态 */}
          <div className="flex items-center gap-1.5 text-neutral-400">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${wsConnected ? 'bg-emerald-400' : 'bg-neutral-600'}`} />
            {wsConnected ? 'WS 已连' : 'WS 未连'}
          </div>

          <button
            onClick={handleLogout}
            className="rounded border border-white/10 px-2 py-0.5 text-neutral-400 hover:bg-white/5 hover:text-white"
          >
            退出登录
          </button>
        </div>
      </div>

      {/* 三栏主体 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左栏 */}
        <div className="flex w-80 flex-shrink-0 flex-col border-r border-white/10">
          <SceneNav />

          {/* 卡详情 或 版块阅读（互斥） */}
          <div className="flex-1 overflow-auto border-t border-white/10">
            {showSection && activeSectionId ? (
              <SectionReader
                sectionId={activeSectionId}
                onBack={() => {
                  useKidsHubStore.setState({ activeSectionId: null });
                }}
              />
            ) : currentCard ? (
              <CardDetail card={currentCard} />
            ) : (
              <div className="p-4 text-sm text-neutral-500">从左侧选择一张场景卡或版块查看详情</div>
            )}
          </div>
        </div>

        {/* 中栏：画布 + 调试流 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-hidden">
            {activeCardId ? (
              <CanvasHost onDebug={handleCanvasDebug} onConfigAck={handleConfigAck} />
            ) : (
              <div className="flex h-full items-center justify-center bg-neutral-950 text-center text-neutral-400">
                <div>
                  <div className="text-lg text-neutral-300">从左侧选择一张场景卡开始</div>
                  <div className="mt-1 text-xs">选择后会自动跳场景、下发 Prompt 并播放开场白（如有）</div>
                </div>
              </div>
            )}
          </div>

          {/* 调试流固定在画布下方 */}
          <div className="h-56 border-t border-white/10">
            <DebugFlow />
          </div>
        </div>

        {/* 右栏 */}
        <div className="flex w-96 flex-shrink-0 flex-col border-l border-white/10">
          <PromptPanel
            onSend={handleSend}
            onExport={handleExport}
            hasUnsent={!!promptDirty}
          />
        </div>
      </div>

      {/* 简单 toast */}
      {toast && (
        <div className="fixed bottom-4 right-4 z-[200] rounded-lg border border-white/10 bg-neutral-900 px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
