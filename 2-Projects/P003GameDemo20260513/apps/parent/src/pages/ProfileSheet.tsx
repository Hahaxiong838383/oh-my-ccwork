// 异步建档浮层（配网「连接中」等待期弹出的底部 sheet）
// 严格复刻产品定义画板 net-profile-sheet-v2.svg / net-profile-sheet-success.svg（390×844 像素级）
// 核心交互：连接中弹出（success=false），配网成功后切成功态（success=true，顶部绿条 + 按钮变「保存并开始使用」）
// 字段=孩子昵称 + 出生年月（真实年月选择器 + 自动算年龄）+ 性别（男孩/女孩大按钮）；填完/跳过都不打断配网。

import { useEffect, useRef, useState } from 'react';

export type ProfileData = { nickname: string; birthday: string; gender: string };

// 跳过时的随机昵称词库（云端兜底 mock）
const FALLBACK_NAMES = ['小航海家', '小探险家', '小发现家', '小观察员', '小船长'];

// 由出生年月（"2018-08"）算当前周岁，按实时日期
export function calcAge(ym: string): number {
  const [by, bm] = ym.split('-').map(Number);
  const now = new Date();
  let age = now.getFullYear() - by;
  if (now.getMonth() + 1 < bm) age -= 1;
  return Math.max(0, age);
}

export default function ProfileSheet({
  success,
  onSave,
  onSkip,
}: {
  success: boolean;
  onSave: (data: ProfileData) => void;
  onSkip: (fallbackName: string) => void;
}) {
  const [nickname, setNickname] = useState('');
  const [birthday, setBirthday] = useState('');
  const [gender, setGender] = useState('男孩');
  const [showPicker, setShowPicker] = useState(false);

  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end">
      {/* 遮罩：画板 #000 opacity 0.42 */}
      <div className="absolute inset-0 bg-black/[0.42]" />

      {/* 底部 sheet：白色，顶部圆角 24，grabber */}
      <div className="relative rounded-t-[24px] bg-white px-7 pb-7 pt-3 shadow-[0_-10px_40px_rgba(0,0,0,0.16)]">
        <div className="mx-auto h-[5px] w-12 rounded-full bg-[#E0E3E8]" />

        {/* 成功态绿条 */}
        {success && (
          <div className="mt-4 flex items-center gap-2 rounded-[10px] bg-[#F6FFED] px-3 py-2.5">
            <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[#52C41A] text-[9px] font-bold text-white">
              ✓
            </span>
            <span className="text-xs font-semibold text-[#3E8E22]">设备已连接！填完这一步就全部完成啦</span>
          </div>
        )}

        <h2 className={`${success ? 'mt-4' : 'mt-5'} text-[19px] font-bold text-[#1F2933]`}>等待时填一下</h2>
        <p className="mt-1.5 text-xs text-[#8C94A3]">让小可第一次见面，就能叫出 TA 的名字</p>

        {/* 孩子昵称 */}
        <p className="mt-5 text-[13px] font-semibold text-[#5B6470]">孩子昵称</p>
        <input
          className="mt-2 h-11 w-full rounded-xl bg-[#F5F6F8] px-4 text-sm text-[#1F2933] outline-none placeholder:text-[#B8BFC9]"
          onChange={(e) => setNickname(e.target.value)}
          placeholder="例如：小明"
          value={nickname}
        />

        {/* 出生年月（真实年月选择器 + 自动算年龄） */}
        <p className="mt-4 text-[13px] font-semibold text-[#5B6470]">出生年月</p>
        <button
          className="mt-2 flex h-11 w-full items-center justify-between rounded-xl bg-[#F5F6F8] px-4 text-sm"
          onClick={() => setShowPicker(true)}
          type="button"
        >
          <span className={birthday ? 'text-[#1F2933]' : 'text-[#B8BFC9]'}>{birthday || '请选择'}</span>
          <span className="flex items-center gap-2">
            {birthday && (
              <span className="rounded-full bg-[#FFF3EC] px-2.5 py-0.5 text-xs font-semibold text-brand-orange">
                {calcAge(birthday)} 周岁
              </span>
            )}
            <span className="text-[#C2C9D1]">›</span>
          </span>
        </button>

        {/* 性别（男孩/女孩 大按钮） */}
        <p className="mt-4 text-[13px] font-semibold text-[#5B6470]">性别</p>
        <div className="mt-2 flex gap-2">
          {['男孩', '女孩'].map((g) => {
            const active = gender === g;
            return (
              <button
                key={g}
                className={`h-11 flex-1 rounded-xl text-sm tracking-[0.2em] transition ${
                  active
                    ? 'border-2 border-brand-orange bg-[#FFF3EC] font-semibold text-brand-orange'
                    : 'bg-[#F5F6F8] text-[#5B6470]'
                }`}
                onClick={() => setGender(g)}
                type="button"
              >
                {g}
              </button>
            );
          })}
        </div>

        {/* 保存 */}
        <button
          className="mt-5 h-[46px] w-full rounded-full bg-brand-orange text-[15px] font-bold text-white"
          onClick={() => onSave({ nickname: nickname.trim() || FALLBACK_NAMES[0], birthday, gender })}
          type="button"
        >
          {success ? '保存并开始使用' : '保 存'}
        </button>

        {/* 跳过 */}
        <button
          className="mt-3 w-full text-center text-[13px] text-[#8C94A3]"
          onClick={() => onSkip(FALLBACK_NAMES[0])}
          type="button"
        >
          跳过
        </button>

        {/* 底部说明（仅连接中态） */}
        {!success && (
          <p className="mt-2 text-center text-[10px] text-[#C2C9D1]">配网正在后台继续，填写或跳过都不影响连接</p>
        )}
      </div>

      {/* 出生年月选择器浮层 */}
      {showPicker && (
        <MonthPicker
          value={birthday}
          onCancel={() => setShowPicker(false)}
          onConfirm={(v) => {
            setBirthday(v);
            setShowPicker(false);
          }}
        />
      )}
    </div>
  );
}

// 底部年/月选择器：两列可滚动列表，tap 选中，确定回填
function MonthPicker({
  value,
  onConfirm,
  onCancel,
}: {
  value: string;
  onConfirm: (v: string) => void;
  onCancel: () => void;
}) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(value ? Number(value.split('-')[0]) : thisYear - 6);
  const [month, setMonth] = useState(value ? Number(value.split('-')[1]) : 1);
  const years = Array.from({ length: 19 }, (_, i) => thisYear - 18 + i); // 近 18 年
  const months = Array.from({ length: 12 }, (_, i) => i + 1);

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div className="relative rounded-t-[20px] bg-white pb-5">
        <div className="flex items-center justify-between border-b border-black/5 px-5 py-3.5">
          <button className="text-sm text-[#8C94A3]" onClick={onCancel} type="button">
            取消
          </button>
          <span className="text-[15px] font-semibold text-[#1F2933]">选择出生年月</span>
          <button
            className="text-sm font-semibold text-brand-orange"
            onClick={() => onConfirm(`${year}-${String(month).padStart(2, '0')}`)}
            type="button"
          >
            确定
          </button>
        </div>
        <div className="flex h-52">
          <PickerCol items={years} onSelect={setYear} unit="年" value={year} />
          <PickerCol items={months} onSelect={setMonth} unit="月" value={month} />
        </div>
      </div>
    </div>
  );
}

function PickerCol({
  items,
  value,
  onSelect,
  unit,
}: {
  items: number[];
  value: number;
  onSelect: (v: number) => void;
  unit: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 打开时把当前选中项滚到列表中部（容器 h-52=208，每项 h-10=40）
  useEffect(() => {
    const idx = items.indexOf(value);
    if (ref.current && idx >= 0) ref.current.scrollTop = Math.max(0, idx * 40 - 84);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="no-scrollbar flex-1 overflow-y-auto py-2" ref={ref}>
      {items.map((it) => (
        <button
          key={it}
          className={`flex h-10 w-full items-center justify-center transition ${
            it === value ? 'text-[17px] font-bold text-brand-orange' : 'text-sm text-[#8C94A3]'
          }`}
          onClick={() => onSelect(it)}
          type="button"
        >
          {it}
          {unit}
        </button>
      ))}
    </div>
  );
}
