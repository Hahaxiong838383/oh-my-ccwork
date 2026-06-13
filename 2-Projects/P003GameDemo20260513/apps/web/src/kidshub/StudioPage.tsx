import { useEffect, useRef, useState } from 'react';
import { useKidsHubStore, getComposedPromptNow } from './store/kidshub-store';
import { getSceneCard, SPEC_META } from './prompts';
import { perfStartTurn } from './perf-tracker';
import { pickFreshAngle } from './prompts/framing';
import { SceneNav } from './components/SceneNav';
import { CardDetail } from './components/CardDetail';
import { SectionReader } from './components/SectionReader';
import { CanvasHost } from './components/CanvasHost';
import { sharedTypewriter } from './subtitle/shared';
import { DebugFlow } from './components/DebugFlow';
import { PromptPanel } from './components/PromptPanel';
import { getSharedVoiceClient } from '../services/voice-client';
import { useAppStore } from '../store/app-store';
import { useTutorialStore } from './tutorial/tutorial-store';
import { ExperienceHintBar, ExperienceLeadModal } from './components/ExperienceFunnel';
import { useExperienceStore, EXPERIENCE_QUOTA_ENABLED } from './store/experience-store';

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
  const tutorialActive = useTutorialStore((s) => s.isActive);

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

  // 防 React 18 StrictMode（dev）下 useEffect 双触发导致一次进卡重复采样两条事实
  const processedCardRef = useRef<string | null>(null);

  // 核心交互序列：选中卡
  useEffect(() => {
    if (!activeCardId) return;
    if (processedCardRef.current === activeCardId) return;
    processedCardRef.current = activeCardId;

    const card = getSceneCard(activeCardId);
    if (!card) return;

    // 1. store 已在 selectCard 里设置，这里只做副作用

    // 2. 硬打断旧轮：server 端 trigger 自带 bargein 只停"合成"，已下发到本地的
    // mp3 chunk 还在播放队列里——不本地 bargeIn 就会把旧场景的话播完才开新场景。
    // 顺序：先 reset 打字机（bargeIn 同步 emit playback_end，空状态 no-op 防字幕复活）
    // 引导中点场景卡 = 打断引导（A03 §2.4：不标记完成，下次从 Step 1 重来）
    const tutorial = useTutorialStore.getState();
    if (tutorial.isActive) tutorial.interrupt();
    sharedTypewriter().reset();
    getSharedVoiceClient().bargeIn();
    useAppStore.getState().setSubtitle('');

    // 3. 强制设置 commander_suffix
    // 注意：setVariable 会把 dirty 设 true，这里我们手动在后面处理
    useKidsHubStore.setState((s) => ({
      variables: { ...s.variables, commander_suffix: card.commanderSuffix },
    }));

    // 4. 采样组装 + 下发 + 开场触发（顺序保证：config 先到 server，trigger 后到）
    // 采样：device_state 描述类多条 → 每次选一条「与上次不同」的（前端控制轮换，
    // 不靠 LLM 自觉——独立请求 LLM 无跨轮记忆，靠 prompt 规则会锁定同一条事实）
    // 新增：getKnowledge 世界观 lore 注入（L1 + L2 1-2 节），loreSections 供 debug 展示本次注入了哪些
    const { prompt: composed, picks, loreSections } = useKidsHubStore.getState().getComposedPromptSampled();
    const client = getSharedVoiceClient();

    void (async () => {
      // 公开模式体验限额：场景卡浏览额度（自动开场白消耗一次额度）。
      // 超限 → 仍切画面看美术（activeCardId 已变），但不下发、不发开场白、首次弹窗引导加微信。
      if (EXPERIENCE_QUOTA_ENABLED) {
        const exp = useExperienceStore.getState();
        if (!exp.canScene()) {
          if (!exp.modalShownOnce) exp.openModal();
          pushDebug({ kind: 'action', title: '🔒 体验次数已达上限——仅切换画面，加微信继续深聊' });
          return;
        }
        exp.recordSceneClick();
      }
      try {
        await client.unlockAudio();
      } catch (e) {
        // 不吞错：Brave 等隐私护盾可能让 AudioContext 创建/resume 异常，记到调试流便于定位
        const msg = e instanceof Error ? e.message : String(e);
        pushDebug({ kind: 'error', title: `🔇 解锁音频失败（不影响下发）：${msg}` });
      }
      try {
        if (!client.isConnected()) {
          await client.connect(getVoiceWsUrl());
        }
        client.sendSessionConfig(composed);
        pushDebug({
          kind: 'config',
          title: `下发 session.config（${composed.length} 字符）· ${card.title}`,
        });
        const factLine = Object.entries(picks)
          .map(([k, v]) => `${k}=${v}`)
          .join(' / ');
        if (factLine) pushDebug({ kind: 'action', title: `本次事实：${factLine}` });
        // 世界观素材注入记录（仅本次 sampled 触发的 loreSections）
        if (loreSections && loreSections.length > 0) {
          const titles = loreSections.map((s) => s.title).join('/');
          pushDebug({ kind: 'action', title: `本次世界观素材：${titles}` });
        }
        markPromptDirty(false);

        // 5. 开场触发：LLM 基于场景 prompt + 本轮 framing 角度实时生成开场白
        // framing 角度每次换不同的，让同一事实"像这次刚想到它的这一面"（解决录制感根因）
        if (card.triggerInstruction) {
          const angle = pickFreshAngle(useKidsHubStore.getState().lastFramingAngle);
          useKidsHubStore.getState().setLastFramingAngle(angle.id);
          const instr = `${card.triggerInstruction}\n本次表达角度：【${angle.label}】——${angle.hint}。`;
          perfStartTurn('trigger');
          client.sendChatTrigger(instr);
          pushDebug({ kind: 'action', title: `本次角度：${angle.label} · 开场触发`, detail: instr });
        }
      } catch (e) {
        // 暴露真实错误（连接超时/握手失败等）——之前只显示"失败"无法定位 Brave 卡点
        const msg = e instanceof Error ? e.message : String(e);
        pushDebug({ kind: 'error', title: `❌ 下发/触发失败：${msg}` });
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
    // 外层滚动兜底：视口小于最小可用布局（960×480）时出滚动条而不是 overflow 裁切——
    // 任意浏览器/窗口尺寸下控制条按钮永远可达；正常视口下无滚动条，行为不变
    <div className="h-screen overflow-auto bg-neutral-950 text-neutral-200">
      <div className="flex h-full min-h-[480px] min-w-[960px] flex-col">
      {/* 顶栏 */}
      <div className="flex items-center justify-between border-b border-white/10 bg-neutral-900 px-4 py-2 text-sm">
        <div className="flex items-center gap-3">
          <span className="font-semibold tracking-tight text-white">KidsHub-AI · 小可 Prompt 体验工作台</span>
          {/* 产品定义文档链接仅公司内部模式展示（个人站公开版不暴露内部文档入口） */}
          {import.meta.env.VITE_KIDSHUB_PUBLIC !== '1' && (
            <a
              href={SPEC_META.docUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-white/10 bg-neutral-800 px-2.5 py-0.5 text-[10px] text-emerald-300 hover:border-emerald-400/60"
              title="打开产品定义文档"
            >
              {SPEC_META.docName} {SPEC_META.docVersion}
            </a>
          )}
        </div>

        <div className="flex items-center gap-4 text-xs">
          {/* 数据后台原型子站（静态托管于 base 下 admin/，与工作台同一套登录凭据）。
              BASE_URL 跟随构建 base：公司侧 '/' → /admin/；个人站
              '/kidshub-ai/' → /kidshub-ai/admin/，避免撞宿主站自己的 /admin */}
          <a
            href={`${import.meta.env.BASE_URL}admin/`}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-white/10 px-2 py-0.5 text-sky-300 hover:bg-white/5 hover:text-sky-200"
            title="数据后台 + KidsHub 运营台（mock 数据 · 产品定义可视化）"
          >
            📊 KidsHub 数据管理后台
          </a>

          {/* WS 状态 */}
          <div className="flex items-center gap-1.5 text-neutral-400">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${wsConnected ? 'bg-emerald-400' : 'bg-neutral-600'}`} />
            {wsConnected ? 'WS 已连' : 'WS 未连'}
          </div>

          {/* 个人站公开模式无登录态，不渲染登出 */}
          {import.meta.env.VITE_KIDSHUB_PUBLIC !== '1' && (
            <button
              onClick={handleLogout}
              className="rounded border border-white/10 px-2 py-0.5 text-neutral-400 hover:bg-white/5 hover:text-white"
            >
              退出登录
            </button>
          )}
        </div>
      </div>

      {/* 体验限额峰值轻提示（公开模式，到爽点时出现，非阻断） */}
      {EXPERIENCE_QUOTA_ENABLED && <ExperienceHintBar />}

      {/* 三栏主体 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左栏（窄屏收窄，留高度宽度给画布区） */}
        <div className="flex w-72 flex-shrink-0 flex-col border-r border-white/10 xl:w-80">
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
          <div className="min-h-0 flex-1 overflow-hidden">
            {activeCardId || tutorialActive ? (
              // 引导可在未选卡时启动：CanvasHost 同时承载 TutorialManager，必须挂载
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

          {/* 调试流固定在画布下方：高度随视口 clamp（矮屏让位给画布+控制条，高屏维持 224px） */}
          <div className="h-[clamp(120px,22vh,224px)] flex-shrink-0 border-t border-white/10">
            <DebugFlow />
          </div>
        </div>

        {/* 右栏（窄屏收窄） */}
        <div className="flex w-80 flex-shrink-0 flex-col border-l border-white/10 xl:w-96">
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

      {/* 体验上限弹窗（公开模式，超限引导加微信） */}
      {EXPERIENCE_QUOTA_ENABLED && <ExperienceLeadModal />}
    </div>
  );
}
