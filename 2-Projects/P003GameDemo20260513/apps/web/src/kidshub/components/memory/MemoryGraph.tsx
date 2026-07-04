// 记忆实体关联星图:实体从真实字段纯函数计算(兴趣词/关系人名/主题 subject),SVG 手绘中心-环形布局,点选聚合关联记忆。
// props 契约(items/profile/serverNow)与导出名不可改——MemoryPanel 已按此接线。
import { useMemo, useState } from 'react';
import type { MemoryItemView, ProfileView } from './types';
import { TYPE_META, TYPE_ORDER } from './types';

export interface MemoryGraphProps {
  items: MemoryItemView[];
  profile: ProfileView | null;
  serverNow: number;
}

/* ---------------- 实体计算(契约 5 条规则,纯函数导出以便测试) ---------------- */

export type GraphEntityKind = 'interest' | 'person' | 'topic';

export interface GraphEntity {
  name: string;
  kind: GraphEntityKind;
  /** 关联到该实体的记忆条目(一条记忆可同时挂多个实体) */
  items: MemoryItemView[];
}

/** relation 条目的实体人名:subject 非空用 subject,否则取 content 前 6 字 */
function relationEntityName(item: MemoryItemView): string {
  return item.subject.trim() ? item.subject : item.content.slice(0, 6);
}

/**
 * 图谱实体计算(契约规则 1-5):
 * 1) profile.interests[].value → interest 实体
 * 2) relation 条目:subject 非空用 subject,否则 content 前 6 字 → person 实体
 * 3) promise/event/emotion 的 subject 非空且非 xiaoke/child → topic 实体
 * 4) 名字去重(先到先得);条目归属:subject 全等 或 content 包含实体名,一条可挂多实体;relation 条目挂自己人名
 * 5) 按关联数降序取前 8;关联数 0 仅纯兴趣保留(挂 0 点、半径最小),其余丢弃
 */
export function computeGraphEntities(
  items: MemoryItemView[],
  profile: ProfileView | null,
): GraphEntity[] {
  // 名字 → kind:Map 保插入序(兴趣 → 人 → 主题),重名首个 kind 优先
  const kindByName = new Map<string, GraphEntityKind>();
  const addName = (name: string, kind: GraphEntityKind) => {
    if (!name.trim() || kindByName.has(name)) return;
    kindByName.set(name, kind);
  };

  for (const it of profile?.interests ?? []) addName(it.value, 'interest');
  for (const item of items) {
    if (item.type === 'relation') addName(relationEntityName(item), 'person');
  }
  for (const item of items) {
    if (item.type !== 'promise' && item.type !== 'event' && item.type !== 'emotion') continue;
    if (item.subject.trim() && item.subject !== 'xiaoke' && item.subject !== 'child') {
      addName(item.subject, 'topic');
    }
  }

  const entities: GraphEntity[] = [];
  kindByName.forEach((kind, name) => {
    const linked = items.filter(
      (item) =>
        item.subject === name ||
        item.content.includes(name) ||
        (item.type === 'relation' && relationEntityName(item) === name),
    );
    entities.push({ name, kind, items: linked });
  });

  return entities
    .filter((e) => e.items.length > 0 || e.kind === 'interest')
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, 8);
}

/* ---------------- SVG 布局常量(viewBox 坐标系,随容器宽度等比缩放,最窄 320px 设计) ---------------- */

const VIEW_W = 320;
const VIEW_H = 300;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2;
const RING_R = 98; // 实体环半径
const CENTER_R = 20; // 中心孩子节点半径
const DOT_R = 3.5; // 记忆色点半径
const DOT_GAP = 9; // 色点切向间距
const MAX_DOTS = 4; // 每实体最多挂 4 个色点,多余合并为 +N
const EMERALD = '#34d399'; // 选中强调色(面板统一 emerald)

/** 时间戳 → MM-DD */
function fmtMMDD(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 超长名字截断显示(href/数据不动,仅展示) */
function truncName(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

export function MemoryGraph(props: MemoryGraphProps) {
  // serverNow 图谱视图暂不消费(注入高亮属列表视图职责),故不解构以过 noUnusedLocals
  const { items, profile } = props;
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const entities = useMemo(() => computeGraphEntities(items, profile), [items, profile]);

  // 未关联到任何展示实体的记忆条数(items 引用未变,可用引用相等判断)
  const unlinkedCount = useMemo(
    () => items.filter((item) => !entities.some((e) => e.items.includes(item))).length,
    [items, entities],
  );

  // 环形布局:从正上方起顺时针均布,半径 = 13 + min(关联数*2, 9)
  const nodes = useMemo(
    () =>
      entities.map((entity, i) => {
        const angle = ((-90 + (360 / entities.length) * i) * Math.PI) / 180;
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        return {
          entity,
          ux,
          uy,
          x: CX + RING_R * ux,
          y: CY + RING_R * uy,
          r: 13 + Math.min(entity.items.length * 2, 9),
        };
      }),
    [entities],
  );

  const selected = selectedName ? (entities.find((e) => e.name === selectedName) ?? null) : null;
  const nickname = profile?.nickname.trim() || '孩子';

  // 空态:实体不足 2 个织不成网
  if (entities.length < 2) {
    return (
      <div className="flex h-48 items-center justify-center px-6 text-center text-xs leading-relaxed text-neutral-500">
        记忆多起来之后,这里会织成一张{nickname}的世界之网
      </div>
    );
  }

  // 点选切换:再点同一实体取消
  const toggle = (name: string) => setSelectedName((prev) => (prev === name ? null : name));

  return (
    <div className="flex flex-col gap-2 p-3">
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-full select-none">
        {/* 中心 → 实体连线(先画,节点盖其上) */}
        {nodes.map((n) => {
          const active = selectedName === n.entity.name;
          const dim = selectedName !== null && !active;
          return (
            <line
              key={`edge-${n.entity.name}`}
              x1={CX}
              y1={CY}
              x2={n.x}
              y2={n.y}
              stroke={active ? EMERALD : 'rgba(255,255,255,0.12)'}
              strokeWidth={active ? 1.5 : 1}
              opacity={dim ? 0.25 : active ? 0.7 : 1}
            />
          );
        })}

        {/* 实体节点 + 外侧记忆色点 */}
        {nodes.map((n) => {
          const { entity } = n;
          const active = selectedName === entity.name;
          const dim = selectedName !== null && !active;
          // 色点:最近的 ≤4 条,多余合并 +N;沿节点外侧切向排开
          const dotItems = [...entity.items]
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, MAX_DOTS);
          const extra = entity.items.length - dotItems.length;
          const slots = dotItems.length + (extra > 0 ? 1 : 0);
          const dotDist = n.r + DOT_R + 4; // 色点圆心距节点圆心
          const bx = n.x + n.ux * dotDist;
          const by = n.y + n.uy * dotDist;
          const tx = -n.uy; // 切向单位向量
          const ty = n.ux;
          const extraOff = (dotItems.length - (slots - 1) / 2) * DOT_GAP;
          // 名字标签默认挂节点正下方;下半圈节点(外侧色点也朝下)再多让一段避碰撞
          const labelDy = n.r + (n.uy > 0.4 ? 22 : 11);

          return (
            <g
              key={entity.name}
              className="cursor-pointer"
              opacity={dim ? 0.35 : 1}
              onClick={() => toggle(entity.name)}
            >
              <circle
                cx={n.x}
                cy={n.y}
                r={n.r}
                fill="#171717"
                stroke={active ? EMERALD : 'rgba(255,255,255,0.22)'}
                strokeWidth={active ? 1.8 : 1}
              />
              {/* 节点内关联数(0 关联的纯兴趣不显示数字) */}
              {entity.items.length > 0 && (
                <text
                  x={n.x}
                  y={n.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={9}
                  fill={active ? EMERALD : '#737373'}
                >
                  {entity.items.length}
                </text>
              )}
              <text
                x={n.x}
                y={n.y + labelDy}
                textAnchor="middle"
                fontSize={9}
                fill={active ? '#d1fae5' : '#a3a3a3'}
              >
                {truncName(entity.name, 6)}
              </text>
              {dotItems.map((item, j) => {
                const off = (j - (slots - 1) / 2) * DOT_GAP;
                return (
                  <circle
                    key={item.id}
                    cx={bx + tx * off}
                    cy={by + ty * off}
                    r={DOT_R}
                    fill={TYPE_META[item.type].hex}
                    stroke="#0a0a0a"
                    strokeWidth={0.8}
                  />
                );
              })}
              {extra > 0 && (
                <text
                  x={bx + tx * extraOff}
                  y={by + ty * extraOff}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={8}
                  fill="#a3a3a3"
                >
                  +{extra}
                </text>
              )}
            </g>
          );
        })}

        {/* 中心孩子节点 */}
        <circle cx={CX} cy={CY} r={CENTER_R} fill="#262626" stroke="rgba(255,255,255,0.3)" strokeWidth={1} />
        <text x={CX} y={CY} textAnchor="middle" dominantBaseline="central" fontSize={11} fill="#e5e5e5">
          {truncName(nickname, 4)}
        </text>
      </svg>

      {/* 图例:五类色点 + label 一行 */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {TYPE_ORDER.map((key) => (
          <span key={key} className="inline-flex items-center gap-1 text-[10px] text-neutral-500">
            <span className={`h-1.5 w-1.5 rounded-full ${TYPE_META[key].dotCls}`} />
            {TYPE_META[key].label}
          </span>
        ))}
      </div>

      {/* 未关联记忆计数 */}
      {unlinkedCount > 0 && (
        <div className="text-[10px] text-neutral-600">
          另有 {unlinkedCount} 条记忆未关联到实体,见列表视图
        </div>
      )}

      {/* 点选聚合:该实体全部关联记忆(再点节点取消) */}
      {selected && (
        <div className="rounded-md border border-white/10 bg-white/5 p-2">
          <div className="mb-1.5 text-[11px] font-medium text-emerald-200">
            {selected.name} · {selected.items.length} 条关联记忆
          </div>
          {selected.items.length === 0 ? (
            <div className="text-[10px] text-neutral-600">暂无关联记忆</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {[...selected.items]
                .sort((a, b) => b.created_at - a.created_at)
                .map((item) => (
                  <div key={item.id} className="flex items-start gap-1.5">
                    <span
                      className={`mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full ${TYPE_META[item.type].dotCls}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="break-words text-[11px] leading-snug text-neutral-300">
                        {item.content}
                      </div>
                      <div className="text-[10px] text-neutral-600">
                        {fmtMMDD(item.created_at)} · {item.source === 'manual' ? '手动' : '会话'}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
