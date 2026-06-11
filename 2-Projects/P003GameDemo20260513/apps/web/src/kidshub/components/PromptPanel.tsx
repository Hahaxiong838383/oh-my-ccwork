import { useState } from 'react';
import { useKidsHubStore } from '../store/kidshub-store';
import { PROMPT_VARIABLES } from '../prompts';
import { PromptPreviewModal } from './PromptPreviewModal';
import { WORLD_CORE, CARD_LORE_MAP, getSection } from '../knowledge';

interface PromptPanelProps {
  onSend: () => void; // 下发生效
  onExport: () => void; // 复制 + toast
  hasUnsent: boolean;
}

export function PromptPanel({ onSend, onExport, hasUnsent }: PromptPanelProps) {
  const activeCardId = useKidsHubStore((s) => s.activeCardId);
  const globalTemplate = useKidsHubStore((s) => s.globalTemplate);
  const editGlobal = useKidsHubStore((s) => s.editGlobal);
  const scenePromptDrafts = useKidsHubStore((s) => s.scenePromptDrafts);
  const editScenePrompt = useKidsHubStore((s) => s.editScenePrompt);
  const variables = useKidsHubStore((s) => s.variables);
  const setVariable = useKidsHubStore((s) => s.setVariable);
  const addendum = useKidsHubStore((s) => s.addendum);
  const editAddendum = useKidsHubStore((s) => s.editAddendum);
  const resetCard = useKidsHubStore((s) => s.resetCard);
  const resetAll = useKidsHubStore((s) => s.resetAll);

  const [showPreview, setShowPreview] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    global: false,
    scene: false,
    addendum: false,
    vars: false,
    lore: false,
  });

  const currentDraft = activeCardId ? scenePromptDrafts[activeCardId] ?? '' : '';

  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-sm text-neutral-200">
      <div className="border-b border-white/10 px-3 py-2 text-xs uppercase tracking-[1px] text-neutral-400">
        Prompt 工作区
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-4">
        {/* 全局模板 */}
        <section>
          <button
            onClick={() => toggle('global')}
            className="flex w-full items-center justify-between text-left text-xs font-medium text-neutral-400 hover:text-white"
          >
            全局 System Prompt
            <span>{collapsed.global ? '▶' : '▼'}</span>
          </button>
          {!collapsed.global && (
            <textarea
              value={globalTemplate}
              onChange={(e) => editGlobal(e.target.value)}
              className="mt-1 h-40 w-full resize-y rounded-lg border border-white/10 bg-neutral-900 p-2 font-mono text-[11px] text-neutral-100 focus:border-sky-500 focus:outline-none"
              spellCheck={false}
            />
          )}
        </section>

        {/* 当前卡子 Prompt */}
        <section>
          <button
            onClick={() => toggle('scene')}
            className="flex w-full items-center justify-between text-left text-xs font-medium text-neutral-400 hover:text-white"
          >
            场景子 Prompt（当前卡）
            <span>{collapsed.scene ? '▶' : '▼'}</span>
          </button>
          {!collapsed.scene && (
            <div>
              {!activeCardId && <div className="mt-1 text-[11px] text-neutral-500">未选择场景卡</div>}
              {activeCardId && (
                <textarea
                  value={currentDraft}
                  onChange={(e) => editScenePrompt(activeCardId, e.target.value)}
                  className="mt-1 h-36 w-full resize-y rounded-lg border border-white/10 bg-neutral-900 p-2 font-mono text-[11px] text-neutral-100 focus:border-sky-500 focus:outline-none"
                  spellCheck={false}
                />
              )}
            </div>
          )}
        </section>

        {/* 工程附加规则（防示例复读 + KidsHub 全局响应） */}
        <section>
          <button
            onClick={() => toggle('addendum')}
            className="flex w-full items-center justify-between text-left text-xs font-medium text-neutral-400 hover:text-white"
          >
            工程附加规则（非产品定义原文）
            <span>{collapsed.addendum ? '▶' : '▼'}</span>
          </button>
          {!collapsed.addendum && (
            <div>
              <textarea
                value={addendum}
                onChange={(e) => editAddendum(e.target.value)}
                className="mt-1 h-28 w-full resize-y rounded-lg border border-amber-400/20 bg-neutral-900 p-2 font-mono text-[11px] text-neutral-100 focus:border-amber-400 focus:outline-none"
                spellCheck={false}
              />
              <div className="mt-1 text-[10px] text-neutral-500">
                拼接在场景子 Prompt 之后下发。清空 = 关闭。调整验证有效后应回写产品定义文档。
              </div>
            </div>
          )}
        </section>

        {/* 世界观知识注入（工作台预览区：让 PM 一眼看到小可本轮/常驻带了哪些世界观知识） */}
        <section>
          <button
            onClick={() => toggle('lore')}
            className="flex w-full items-center justify-between text-left text-xs font-medium text-neutral-400 hover:text-white"
          >
            世界观知识注入
            <span>{collapsed.lore ? '▶' : '▼'}</span>
          </button>
          {!collapsed.lore && (
            <div className="mt-2 space-y-3 text-[11px]">
              {/* L1 核心常驻 */}
              <div>
                <div className="font-medium text-emerald-300">L1 核心常驻（进 system prompt，每轮均带）</div>
                <div className="mt-0.5 rounded border border-emerald-400/20 bg-neutral-900 p-2 text-neutral-300">
                  {WORLD_CORE.slice(0, 80)}
                  {WORLD_CORE.length > 80 ? '…' : ''}
                  <span className="ml-1 text-emerald-400">（常驻）</span>
                </div>
                <div className="mt-0.5 text-[10px] text-neutral-500">来源：KNOWLEDGE_META + boundaryDeclaration（死活分离声明）</div>
              </div>

              {/* L2 当前卡对应节（标注本场景会注入哪些；实际 1-2 节由 getKnowledge 运行时挑 + 避重） */}
              <div>
                <div className="font-medium text-emerald-300">L2 本场景素材（CARD_LORE_MAP 路由，实际注入见 debug「本次世界观素材」）</div>
                {!activeCardId && <div className="text-neutral-500">未选择场景卡</div>}
                {activeCardId && (
                  <div className="mt-1 space-y-0.5 text-neutral-300">
                    {(CARD_LORE_MAP[activeCardId] ?? []).length === 0 ? (
                      <div className="text-neutral-500">本卡暂无关联 lore 节</div>
                    ) : (
                      (CARD_LORE_MAP[activeCardId] ?? []).map((id) => {
                        const sec = getSection(id);
                        return (
                          <div key={id} className="rounded border border-white/10 bg-neutral-900 px-2 py-0.5">
                            • {sec?.title ?? id} <span className="text-[10px] text-neutral-500">（候选，本轮可能 1-2 节）</span>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
              <div className="text-[10px] text-neutral-500">
                说明：L1 常驻；L2 由 store getComposedPromptSampled 调用 getKnowledge(cardId, recentLoreIds) 选 1-2 节（候选≤2 全取；否则避重随机挑），picked 记入 recentLoreIds 保留最近 4-6。
              </div>
            </div>
          )}
        </section>

        {/* 变量表 */}
        <section>
          <button
            onClick={() => toggle('vars')}
            className="flex w-full items-center justify-between text-left text-xs font-medium text-neutral-400 hover:text-white"
          >
            变量注入
            <span>{collapsed.vars ? '▶' : '▼'}</span>
          </button>
          {!collapsed.vars && (
            <div className="mt-2 space-y-2">
              {PROMPT_VARIABLES.map((v) => {
                const val = variables[v.key] ?? '';
                return (
                  <div key={v.key} className="grid grid-cols-[auto,1fr] items-start gap-x-2 gap-y-1">
                    <div className="pt-1 text-[11px]">
                      <div className="font-mono text-sky-300">{v.key}</div>
                      <div className="text-[10px] text-neutral-500">{v.label}</div>
                    </div>
                    {v.multiline ? (
                      <textarea
                        value={val}
                        onChange={(e) => setVariable(v.key, e.target.value)}
                        className="h-20 w-full resize-y rounded border border-white/10 bg-neutral-900 p-1.5 font-mono text-[11px] text-white focus:border-emerald-400 focus:outline-none"
                        spellCheck={false}
                      />
                    ) : (
                      <input
                        value={val}
                        onChange={(e) => setVariable(v.key, e.target.value)}
                        className="w-full rounded border border-white/10 bg-neutral-900 px-2 py-1 font-mono text-[11px] text-white focus:border-emerald-400 focus:outline-none"
                        spellCheck={false}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* 固定操作区 */}
      <div className="border-t border-white/10 bg-neutral-900 p-3">
        {hasUnsent && (
          <div className="mb-2 flex items-center gap-2 text-[11px] text-amber-400">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
            有未下发的改动
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onSend}
            className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition active:scale-[0.985] ${
              hasUnsent
                ? 'bg-emerald-500 text-white shadow-[0_0_0_3px_rgba(16,185,129,0.35)]'
                : 'bg-emerald-600/80 text-white/90 hover:bg-emerald-600'
            }`}
          >
            下发生效
          </button>
          <button
            onClick={() => setShowPreview(true)}
            className="rounded-lg border border-white/15 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 active:bg-neutral-950"
          >
            查看组装结果
          </button>
          <button
            onClick={() => activeCardId && resetCard(activeCardId)}
            disabled={!activeCardId}
            className="rounded-lg border border-white/15 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
          >
            重置本卡
          </button>
          <button
            onClick={resetAll}
            className="rounded-lg border border-red-500/30 bg-neutral-900 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10"
          >
            全部重置出厂
          </button>
          <button
            onClick={onExport}
            className="rounded-lg border border-white/15 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
          >
            导出
          </button>
        </div>
        <div className="mt-2 text-[10px] text-neutral-500">
          右栏任意编辑后点「下发生效」才真正 sendSessionConfig。变量修改同理。
        </div>
      </div>

      <PromptPreviewModal open={showPreview} onClose={() => setShowPreview(false)} />
    </div>
  );
}
