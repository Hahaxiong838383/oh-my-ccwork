// 手动添加记忆表单（演示预埋）：五类 chip 单选 + 按类型动态字段
// （promise：谁答应的 + 兑现时间；relation：人名），保存成功后由父级收起并刷新。
import { useState } from 'react';
import { useKidsHubStore } from '../../store/kidshub-store';
import { addMemory } from './memory-api';
import type { AddMemoryBody } from './memory-api';
import { TYPE_META, TYPE_ORDER } from './types';
import type { MemoryTypeKey } from './types';

/** content 输入的示例占位（按类型变） */
const CONTENT_PLACEHOLDER: Record<MemoryTypeKey, string> = {
  promise: '周六一起看恐龙纪录片',
  event: '今天在幼儿园画了一只霸王龙',
  emotion: '这几天有点想妈妈',
  relation: '最好的朋友，喜欢一起拼乐高',
  preference: '最喜欢蓝色和恐龙',
};

interface MemoryAddFormProps {
  /** 保存成功回调（父级负责收起表单 + refresh） */
  onSaved: () => void;
}

export function MemoryAddForm({ onSaved }: MemoryAddFormProps) {
  const token = useKidsHubStore((s) => s.token);
  const [type, setType] = useState<MemoryTypeKey>('promise');
  const [content, setContent] = useState('');
  // promise 专属：谁答应的（后端默认 xiaoke）
  const [promiseSubject, setPromiseSubject] = useState<'xiaoke' | 'child'>('xiaoke');
  const [dueText, setDueText] = useState('');
  // relation 专属：人名（允许空）
  const [personName, setPersonName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmed = content.trim();
    if (trimmed === '') {
      setError('内容不能为空');
      return;
    }
    if (trimmed.length > 60) {
      setError('内容最多 60 字');
      return;
    }
    if (!token) {
      setError('未登录，无法添加');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: AddMemoryBody = { type, content: trimmed };
      if (type === 'promise') {
        body.subject = promiseSubject;
        if (dueText.trim() !== '') body.due_text = dueText.trim();
      } else if (type === 'relation' && personName.trim() !== '') {
        body.subject = personName.trim();
      }
      await addMemory(token, body);
      onSaved(); // 成功：父级收起 + 刷新（本组件随之卸载）
    } catch {
      setError('保存失败，请重试');
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-b border-white/10 bg-white/[0.02] px-3 py-2.5">
      {/* 类型五选（chip 单选，选中态用 TYPE_META 完整类串） */}
      <div className="flex flex-wrap gap-1">
        {TYPE_ORDER.map((key) => {
          const meta = TYPE_META[key];
          const active = type === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setType(key)}
              className={`rounded-full px-2 py-0.5 text-[10px] transition ${
                active ? `${meta.badgeCls} ring-1 ring-white/25` : 'bg-white/5 text-neutral-400 hover:bg-white/10'
              }`}
            >
              {meta.emoji} {meta.label}
            </button>
          );
        })}
      </div>

      {/* 内容（1–60 字，与后端 zod 校验对齐） */}
      <input
        type="text"
        value={content}
        maxLength={60}
        onChange={(e) => setContent(e.target.value)}
        placeholder={CONTENT_PLACEHOLDER[type]}
        className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-emerald-400/40 focus:outline-none"
      />

      {/* promise 专属：谁答应的 + 兑现时间 */}
      {type === 'promise' && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1">
            {(
              [
                { value: 'xiaoke', label: '小可答应的' },
                { value: 'child', label: '孩子答应的' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setPromiseSubject(opt.value)}
                className={`rounded px-2 py-0.5 text-[10px] transition ${
                  promiseSubject === opt.value
                    ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/40'
                    : 'bg-white/5 text-neutral-400 hover:bg-white/10'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={dueText}
            maxLength={20}
            onChange={(e) => setDueText(e.target.value)}
            placeholder="什么时候兑现:明天 / 周六 / 下次"
            className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-emerald-400/40 focus:outline-none"
          />
        </div>
      )}

      {/* relation 专属：人名 */}
      {type === 'relation' && (
        <input
          type="text"
          value={personName}
          maxLength={20}
          onChange={(e) => setPersonName(e.target.value)}
          placeholder="这个人叫什么:乐乐 / 王老师"
          className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-emerald-400/40 focus:outline-none"
        />
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md bg-emerald-500/15 px-3 py-1 text-[11px] font-medium text-emerald-200 ring-1 ring-emerald-400/40 hover:bg-emerald-500/25 disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存这条记忆'}
        </button>
        {error && <span className="text-[10px] text-red-400">{error}</span>}
      </div>
    </div>
  );
}
