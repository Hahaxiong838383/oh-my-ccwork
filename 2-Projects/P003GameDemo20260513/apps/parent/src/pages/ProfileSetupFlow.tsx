// 完善孩子信息流程（建档）
// 还原原型设计稿《完善孩子信息》：头像/昵称 + 性别*/出生年月*/是否近视
// 选「是否近视=是」展开 左眼/右眼裸眼度数 + 是否佩戴眼镜。
// 必填（昵称/性别/出生年月）未填完 → 保存按钮浅橙禁用态。纯前端 mock。

import { useState, type ReactNode } from 'react';
import { FlowNav } from '../components/chrome';

export default function ProfileSetupFlow({ onExit }: { onExit: () => void }) {
  const [nickname, setNickname] = useState('大妮');
  const [gender, setGender] = useState('女');
  const [birthday, setBirthday] = useState('');
  const [myopia, setMyopia] = useState('');
  const [leftEye, setLeftEye] = useState('');
  const [rightEye, setRightEye] = useState('');
  const [glasses, setGlasses] = useState('');
  const [saved, setSaved] = useState(false);

  const canSave = Boolean(nickname.trim() && gender && birthday);

  function handleSave() {
    if (!canSave) return;
    setSaved(true);
    window.setTimeout(onExit, 1200);
  }

  return (
    <div className="flex h-full flex-col bg-page-bg">
      <FlowNav onBack={onExit} />
      <div className="no-scrollbar flex-1 overflow-y-auto px-5 pt-1">
        <h1 className="text-2xl font-black text-text-main">完善孩子信息</h1>
        <p className="mt-2 text-sm leading-6 text-text-muted">
          为了给您提供更准确、科学的使用建议，请填写孩子的基本信息
        </p>

        {/* 头像 + 昵称 */}
        <div className="mt-5 rounded-[20px] bg-white px-4 shadow-card">
          <Row label="头像">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-gradient-to-br from-orange-200 to-brand-orange text-lg">
              👧
            </div>
          </Row>
          <Divider />
          <Row label={<Req>昵称</Req>}>
            <input
              className="w-32 bg-transparent text-right font-semibold text-text-main outline-none"
              onChange={(e) => setNickname(e.target.value)}
              value={nickname}
            />
          </Row>
        </div>

        {/* 性别 / 出生年月 / 是否近视（+ 展开） */}
        <div className="mt-4 rounded-[20px] bg-white px-4 shadow-card">
          <Row label={<Req>性别</Req>}>
            <RadioGroup options={['男', '女']} value={gender} onChange={setGender} />
          </Row>
          <Divider />
          <button
            className="flex w-full items-center justify-between py-4 text-left"
            onClick={() => setBirthday('2018-08')}
            type="button"
          >
            <Req>出生年月</Req>
            <span
              className={`flex items-center gap-1 ${
                birthday ? 'font-semibold text-text-main' : 'text-text-muted'
              }`}
            >
              {birthday || '未填写'} <span className="text-text-muted">›</span>
            </span>
          </button>
          <Divider />
          <Row label="是否近视">
            <RadioGroup options={['是', '否']} value={myopia} onChange={setMyopia} />
          </Row>

          {myopia === '是' && (
            <>
              <Divider />
              <Row label="左眼裸眼度数">
                <input
                  className="w-24 bg-transparent text-right text-text-main outline-none placeholder:text-text-muted"
                  onChange={(e) => setLeftEye(e.target.value)}
                  placeholder="未填写"
                  value={leftEye}
                />
              </Row>
              <Divider />
              <Row label="右眼裸眼度数">
                <input
                  className="w-24 bg-transparent text-right text-text-main outline-none placeholder:text-text-muted"
                  onChange={(e) => setRightEye(e.target.value)}
                  placeholder="未填写"
                  value={rightEye}
                />
              </Row>
              <Divider />
              <Row label="是否佩戴眼镜">
                <RadioGroup options={['是', '否']} value={glasses} onChange={setGlasses} />
              </Row>
            </>
          )}
        </div>

        <div className="h-24" />
      </div>

      {/* 底部保存 */}
      <div className="px-5 pb-6 pt-2">
        <button
          className={`h-14 w-full rounded-full font-bold text-white shadow-card transition ${
            canSave ? 'bg-brand-orange' : 'bg-brand-orange/40'
          }`}
          disabled={!canSave}
          onClick={handleSave}
          type="button"
        >
          保存
        </button>
      </div>

      {saved && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/10">
          <div className="rounded-2xl bg-neutral-700 px-7 py-5 text-center text-white">
            <div className="text-3xl">✓</div>
            <p className="mt-2 text-sm">保存成功</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-[56px] items-center justify-between py-3">
      <span className="text-text-main">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-black/5" />;
}

function Req({ children }: { children: ReactNode }) {
  return (
    <span>
      {children}
      <span className="text-brand-orange">*</span>
    </span>
  );
}

function RadioGroup({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-5">
      {options.map((opt) => (
        <button
          key={opt}
          className="flex items-center gap-1.5"
          onClick={() => onChange(opt)}
          type="button"
        >
          <span
            className={`grid h-5 w-5 place-items-center rounded-full border-2 ${
              value === opt ? 'border-brand-orange' : 'border-gray-300'
            }`}
          >
            {value === opt && <span className="h-2.5 w-2.5 rounded-full bg-brand-orange" />}
          </span>
          <span className="text-text-main">{opt}</span>
        </button>
      ))}
    </div>
  );
}
