/**
 * device_state 事实采样（解决「LLM 跨独立请求无记忆，靠 addendum 轮换事实不可靠」）
 *
 * 实测发现：把多条事实全注入让 LLM「挑不同的说」不可靠——每次是独立请求，
 * LLM 不知道上次挑了哪条，会锁定同一条（如连续讲小海螺）。
 * 所以事实轮换必须前端控制：每次进卡，对描述类数组字段选一条注入为单条快照；
 * 数值类字段（夜航收益）绝不采样，全程锁死（团队边界护栏：防数字漂移）。
 *
 * 避重策略：避开「最近 (池长-1) 次」选过的——保证走遍整池才会重复，
 * 而不只是避上一次（avoid-last 在交替卡 + dev StrictMode 双触发下会锁死同一条）。
 */

// 描述类多条字段（可采样轮换）；夜航收益等数值类不在此列，永远原样保留
const SAMPLED_ARRAY_FIELDS = ['生态缸变化', '明日预告'] as const;

function pickFresh(arr: readonly string[], recent: readonly string[]): string {
  const avoid = new Set(recent);
  const pool = arr.filter((x) => !avoid.has(x));
  const list = pool.length > 0 ? pool : arr;
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 把 device_state JSON 里的描述类数组字段各采样为一条（避开最近选过的），
 * 返回单条快照 JSON + 本次选中项 + 更新后的最近记录。解析失败时原样返回，不阻断流程。
 *
 * recentPicks 的 key 是「cardId:字段」——每张卡独立轮换。否则夜航/回归共享同一份
 * recent、交替取时夜航只取到隔项（a,c,a,c 两条死循环，4 条池避最近 3 条的数学必然）。
 */
export function sampleDeviceState(
  json: string,
  cardId: string,
  recentPicks: Record<string, string[]>,
): {
  snapshot: string;
  picks: Record<string, string>;
  nextRecent: Record<string, string[]>;
} {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { snapshot: json, picks: {}, nextRecent: recentPicks };
  }

  const picks: Record<string, string> = {};
  const nextRecent: Record<string, string[]> = { ...recentPicks };

  for (const field of SAMPLED_ARRAY_FIELDS) {
    const val = obj[field];
    if (Array.isArray(val) && val.length > 0) {
      const strArr = val.map((x) => String(x));
      const key = `${cardId}:${field}`; // 每卡独立轮换
      const recent = recentPicks[key] ?? [];
      const pick = pickFresh(strArr, recent);
      obj[field] = pick; // 数组 → 单条，LLM 只看到这一条
      picks[field] = pick;
      // 保留最近 (池长-1) 条 → 该卡走遍整池才可能重复（彻底去连续重复）
      nextRecent[key] = [...recent, pick].slice(-Math.max(1, strArr.length - 1));
    }
  }

  return { snapshot: JSON.stringify(obj, null, 2), picks, nextRecent };
}
