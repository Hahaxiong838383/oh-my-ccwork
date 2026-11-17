import { useEffect, useRef, useState } from 'react';
import { Button, Text, View } from '@tarojs/components';
import { beijingWeekStart, getWeeklyReport, shiftWeek, WeeklyReportController, type WeeklyReport } from '../../services/weekly-report';
import { Card, Heading } from './components';

const reasons: Record<string, string> = {
  partial_history: '仅含已同步记录，覆盖不足', no_focus_segments: '未收到可信真实计时片段', no_reminder_events: '未收到可确认的提醒记录',
  unknown_reminder_outcome: '提醒播放结果未知', invalid_focus_events: '计时记录时间无效，未计入', invalid_reminder_events: '提醒记录时间无效，未计入',
  dependency_unavailable: '计算依赖暂不可用', pending: '待统计', no_observations: '尚未收到数据', invalid_response: '该指标返回不完整，请刷新',
  retained_dependency_unavailable: '数据依赖暂不可用，当前显示上次保存的周报；数据截至时间未前移',
  partial_history_retained_supplement: '补充数据依赖暂不可用，已保留此前保存的补充计算',
  partial_history_supplement_unavailable: '补充数据暂不可用，真实计时与提醒按各自状态显示',
  historical_coverage_limited: '历史覆盖受限，保留已保存结果', received_events_only: '仅含已收到事件',
};
const reasonText = (value: string) => reasons[value] || (value ? '数据范围待确认' : '');
const time = (value: number | null) => value === null ? '尚未发布' : `${new Date(value + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')}（北京时间）`;
const duration = (value: number | null) => value === null ? '暂无数据' : `${Math.floor(value / 60)} 分 ${Number((value % 60).toFixed(3))} 秒`;
const average = (value: number | null) => value === null ? '暂无数据' : `${Number((value / 60).toFixed(1))} 分钟`;

export function WeeklyReportContent({ report: r }: { report: WeeklyReport }) {
  const { postureReminders: posture, usage, activeDays: active } = r.metrics;
  const status = r.status === 'published' && r.dataCutoffAtMs < r.periodEndMs ? '已发布（本周未结束）' : { collecting: '统计中 · 累计预览', published: '已发布', revised: '已修订' }[r.status];
  return <View className="live-weekly-report">
    <Text className="row-title">{r.weekStart} — {r.weekEnd}</Text>
    <Text className="small-note">{status} · 版本 {r.revision}</Text>
    <Text className="small-note">{r.status === 'collecting' ? `尚未发布，计划 ${time(r.scheduledPublishAtMs)}` : `首次发布 ${time(r.publishedAtMs)}`}</Text>
    <Text className="small-note">统计区间截至 {time(r.dataCutoffAtMs)} · 报告更新于 {time(r.updatedAtMs)}</Text>
    <Text className="small-note">来源记录更新时间 {r.sourceUpdatedAtMs === null ? '暂无数据' : time(r.sourceUpdatedAtMs)}；晚到记录仍按原发生周更新。</Text>
    <View className="live-weekly-metrics">
      <View><Text className="metric-label">坐姿守护</Text><Text className="live-metric-value">{posture.available && posture.value !== null ? `已上报 ${posture.value} 次` : '暂无数据'}</Text><Text className="small-note">{reasonText(posture.reason)}</Text>{posture.available && posture.aboveReferenceMax === true && posture.referenceMax != null && <Text className="notice">已上报次数高于参考{posture.referenceMax}次，保留真实记录待核对。</Text>}</View>
      <View><Text className="metric-label">{r.coverage.complete ? '日均用眼时长' : '已同步折算日均'}</Text><Text className="live-metric-value">{usage.available ? average(usage.dailyAverageSeconds) : '暂无数据'}</Text><Text className="small-note">真实片段口径 · 分母 {usage.denominatorDays ?? '未知'} 天</Text><Text className="small-note">{reasonText(usage.reason)}</Text></View>
      <View><Text className="metric-label">活跃天数</Text><Text className="live-metric-value">{active.available && active.value !== null ? `已确认 ${active.value} 天` : '未能确认'}</Text><Text className="small-note">当天真实连续使用达到5分钟</Text><Text className="small-note">{reasonText(active.reason)}</Text></View>
    </View>
    <Text className="row-title">真实计时 {duration(usage.available ? usage.totalSeconds : null)}</Text>
    <Text className="small-note">补充计算 {duration(usage.supplementalSeconds)} · 合计 {duration(usage.combinedSeconds)}</Text>
    <Text className="small-note">补充量不计入周报日均与活跃天数。用眼时长指设备使用记录；坐姿提醒次数不是眼睛健康程度。</Text>
    {!r.coverage.complete && <Text className="notice">覆盖不足：已收到真实计时 {r.coverage.observedDays ?? '未知'} 天；已同步折算日均只把收到的真实时长摊到7天，缺测日不代表未使用。</Text>}
    {!!r.coverage.reason && <Text className="small-note">{reasonText(r.coverage.reason)}</Text>}
    {!!r.coverage.missingDates.length && <Text className="small-note">未能确认计时：{r.coverage.missingDates.join('、')}</Text>}
    {!!r.coverage.pendingDates.length && <Text className="small-note">待统计日期：{r.coverage.pendingDates.join('、')}</Text>}
    {!!r.coverage.invalidEventCount && <Text className="small-note">有 {r.coverage.invalidEventCount} 条时间异常或无效事件未计入</Text>}
    <Text className="row-title">每日证据</Text>
    {r.daily.map(day => <View key={day.date} className="live-history-entry">
      <Text className="row-title">{day.date} · {day.reason === 'pending' ? '待统计' : day.active === null ? '活跃未能确认' : day.active ? '已确认活跃' : '未达连续5分钟'}</Text>
      <Text className="small-note">真实计时 {duration(day.usageAvailable ? day.observedSeconds : null)} · 补充计算 {duration(day.supplementalSeconds)} · 合计 {duration(day.combinedSeconds)}</Text>
      <Text className="small-note">最长连续 {day.longestContinuousSeconds === null ? '未能确认' : `${day.longestContinuousSeconds} 秒`} · 提醒 {day.postureAvailable && day.postureCount !== null ? `${day.postureCount} 次` : '暂无数据'}</Text>
      <Text className="small-note">{reasonText(day.reason)}</Text>
    </View>)}
  </View>;
}

/** Must be keyed by the selected publicId; each mount owns its request lifetime. */
export default function WeeklyReportPanel({ publicId, deviceLabel, onAccessLost }: { publicId: string; deviceLabel: string; onAccessLost: (status: number) => void }) {
  const callback = useRef(onAccessLost); callback.current = onAccessLost;
  const [controller] = useState(() => new WeeklyReportController(week => getWeeklyReport(publicId, week), status => callback.current(status)));
  const [state, setState] = useState(controller.state);
  useEffect(() => { const stop = controller.subscribe(setState); void controller.refresh(); return () => { stop(); controller.dispose(); }; }, [controller]);
  const currentWeek = beijingWeekStart();
  return <Card>
    <Heading title="护眼周报" />
    <Text className="small-note">{deviceLabel} · 单设备 · 北京时间自然周</Text>
    <View className="live-history-filters">
      <Button size="mini" onClick={() => void controller.refresh(shiftWeek(state.weekStart, -1))}>上一周</Button>
      <Button size="mini" disabled={state.weekStart >= currentWeek} onClick={() => void controller.refresh(shiftWeek(state.weekStart, 1))}>下一周</Button>
      <Button size="mini" disabled={state.weekStart === currentWeek && state.busy} onClick={() => void controller.refresh(currentWeek)}>本周</Button>
      <Button size="mini" disabled={state.busy} onClick={() => void controller.refresh()}>刷新周报</Button>
    </View>
    <Text className="small-note">所选周起点：{state.weekStart}</Text>
    {state.busy && <Text className="paragraph muted">正在读取周报…</Text>}
    {state.error && <Text className="notice live-error">{state.error}{state.report ? '；以下保留上次读取的同周结果。' : ''}</Text>}
    {state.report && <WeeklyReportContent report={state.report} />}
  </Card>;
}
