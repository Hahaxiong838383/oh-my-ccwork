import { SPEC_SECTIONS, SPEC_META } from '../prompts';

interface SectionReaderProps {
  sectionId: string;
  onBack: () => void;
}

export function SectionReader({ sectionId, onBack }: SectionReaderProps) {
  const sec = SPEC_SECTIONS.find((s) => s.id === sectionId);

  if (!sec) {
    return (
      <div className="p-4 text-sm text-neutral-400">
        版块不存在
        <button onClick={onBack} className="ml-2 text-sky-400 underline">返回</button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-200">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="text-sm font-medium">{sec.title}</div>
        <button
          onClick={onBack}
          className="rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-white/5 hover:text-white"
        >
          ← 返回导航
        </button>
      </div>

      {/* 极简渲染：保留原文结构，用 pre-wrap 展示 + 少量加粗处理 */}
      <div className="flex-1 overflow-auto p-3 text-[12px] leading-relaxed">
        <div className="mb-2 text-[10px] uppercase tracking-[1px] text-emerald-400/80">
          来源：{SPEC_META.docName} {SPEC_META.docVersion}
        </div>
        <pre className="whitespace-pre-wrap font-mono text-neutral-300">
          {sec.body}
        </pre>
      </div>

      <div className="border-t border-white/10 p-2 text-[10px] text-neutral-500">
        完整定义以飞书文档为准（左上角徽标可点开）
      </div>
    </div>
  );
}
