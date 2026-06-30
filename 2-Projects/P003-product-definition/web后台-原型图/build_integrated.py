# -*- coding: utf-8 -*-
"""把 KidsHub 运营台(8模块) + 运营操作台(2页) 注入 A16 Vue3 原型，产出整合版单 HTML"""

SRC = '/tmp/proto_serve/index.html'
DST = '/tmp/P003-Web后台-整合版原型.html'

html = open(SRC, encoding='utf-8').read()
hits = 0

def inject(anchor, payload, before=True):
    global html, hits
    assert anchor in html, 'anchor missing: ' + anchor[:50]
    assert html.count(anchor) == 1, 'anchor not unique: ' + anchor[:50]
    html = html.replace(anchor, (payload + anchor) if before else (anchor + payload))
    hits += 1

# ───────────────────────── 1. CSS ─────────────────────────
CSS = '''
    /* ====== 整合版新增：运营操作台 + KidsHub 运营台 ====== */
    .menu-group-title { padding: 14px 20px 6px; font-size: 11px; color: #5c6b77; border-top: 1px solid #1d2935; margin-top: 8px; }
    .kidshub-entry { margin: 14px 12px; padding: 12px 16px; background: #3B7A99; color: #fff; font-size: 14px; font-weight: 700; border-radius: 8px; cursor: pointer; transition: background .2s; }
    .kidshub-entry:hover { background: #2E6480; }
    .kidshub-entry.active { outline: 2px solid #9fc6d8; }
    .ops-banner { background: #E3F0FD; color: #2E6480; font-weight: 600; font-size: 13px; padding: 14px 20px; border-radius: 8px; margin-bottom: 16px; }
    /* KidsHub 工作区（brand-admin 青蓝体系） */
    .kh-wrap { display: flex; background: #F6F8FA; border-radius: 12px; overflow: hidden; min-height: 720px; border: 1px solid #E4E9EF; }
    .kh-nav { width: 168px; flex-shrink: 0; background: #fff; border-right: 1px solid #E4E9EF; padding: 16px 10px; display: flex; flex-direction: column; gap: 4px; }
    .kh-nav .kh-logo { font-size: 14px; font-weight: 800; padding: 4px 10px 12px; color: #3B7A99; }
    .kh-nav button { text-align: left; padding: 10px 12px; border-radius: 8px; border: none; cursor: pointer; font-size: 13.5px; font-weight: 700; background: transparent; color: #6B7785; }
    .kh-nav button.on { background: #E3F0FD; color: #3B7A99; }
    .kh-nav .kh-back { margin-top: auto; border: 1px solid #E4E9EF; background: #F6F8FA; color: #3B7A99; }
    .kh-main { flex: 1; min-width: 0; padding: 20px; overflow: auto; }
    .kh-h1 { font-size: 18px; font-weight: 700; color: #1F2933; }
    .kh-sub { font-size: 12.5px; color: #6B7785; margin: 4px 0 16px; }
    .kh-card { background: #fff; border-radius: 12px; border: 1px solid #E4E9EF; box-shadow: 0 1px 3px rgba(31,41,51,.06); }
    .kh-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px; border-radius: 999px; font-size: 12.5px; font-weight: 700; white-space: nowrap; }
    .kh-chip i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
    .kh-chip.received  { background: #FEF3DC; color: #F6A724; } .kh-chip.received i { background: #F6A724; }
    .kh-chip.reviewing { background: #E3F0FD; color: #4A9DF0; } .kh-chip.reviewing i { background: #4A9DF0; }
    .kh-chip.adopted   { background: #DEF5E9; color: #3DBE78; } .kh-chip.adopted i { background: #3DBE78; }
    .kh-chip.vault     { background: #EEE8FD; color: #9B7BF0; } .kh-chip.vault i { background: #9B7BF0; }
    .kh-board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .kh-issue { background: #fff; border: 1px solid #E4E9EF; border-radius: 8px; padding: 12px; cursor: pointer; box-shadow: 0 1px 3px rgba(31,41,51,.06); }
    .kh-issue:hover { border-color: #3B7A99; }
    .kh-issue .iid { font-size: 11px; color: #6B7785; font-family: monospace; }
    .kh-issue .src { font-size: 11px; font-weight: 700; color: #fff; padding: 1px 8px; border-radius: 999px; }
    .kh-issue p { margin: 8px 0 10px; font-size: 13.5px; line-height: 1.45; color: #1F2933; }
    .kh-issue .meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 11px; color: #6B7785; }
    .kh-issue .meta span { background: #F6F8FA; padding: 2px 8px; border-radius: 6px; }
    .kh-issue .meta .ct { margin-left: auto; background: none; color: #3B7A99; font-weight: 700; }
    .kh-pool { width: 240px; flex-shrink: 0; border-left: 1px solid #E4E9EF; background: #fff; padding: 16px; }
    .kh-pool .pt { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-radius: 8px; background: #F6F8FA; margin-bottom: 8px; }
    .kh-hint { padding: 12px; border-radius: 8px; background: #E3F0FD; font-size: 12px; color: #4A9DF0; font-weight: 600; line-height: 1.5; }
    .kh-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .kh-table th { text-align: left; padding: 12px 14px; color: #6B7785; font-size: 12px; border-bottom: 1px solid #E4E9EF; background: #fff; }
    .kh-table td { padding: 12px 14px; border-bottom: 1px solid #E4E9EF; color: #1F2933; }
    .kh-funnel-row { display: flex; align-items: center; gap: 10px; margin-bottom: 7px; }
    .kh-funnel-row .fl { width: 64px; font-size: 11.5px; color: #6B7785; text-align: right; }
    .kh-funnel-row .fb { height: 16px; background: #3B7A99; border-radius: 3px; }
    .kh-funnel-row .fv { font-size: 11px; color: #6B7785; }
    .kh-lvl { display: inline-block; min-width: 34px; text-align: center; padding: 3px 0; border-radius: 6px; font-weight: 800; font-size: 13px; }
'''
inject('  </style>', CSS, before=True)

# ───────────────────────── 2. 侧栏菜单 ─────────────────────────
MENU = '''          <div class="menu-group-title" v-if="!asideCollapsed && isAdmin">运营操作台</div>
          <el-menu-item v-if="isAdmin" index="sn-manage">
            <span class="menu-icon">🏷️</span>
            <span>SN 与订单管理</span>
          </el-menu-item>
          <el-menu-item v-if="isAdmin" index="cs-tickets">
            <span class="menu-icon">📞</span>
            <span>客服挽回工单池</span>
          </el-menu-item>
'''
inject('        </el-menu>', MENU, before=True)
ENTRY = '''
        <div class="kidshub-entry" v-if="isAdmin && !asideCollapsed" :class="{active: currentPage==='kidshub'}" @click="handleMenuSelect('kidshub')">KidsHub 运营台 ↗</div>'''
inject('        </el-menu>', ENTRY, before=False)

# ───────────────────────── 3. 页面模板 ─────────────────────────
PAGES = '''
          <!-- ========== 运营操作台 · SN 与订单管理 ========== -->
          <div v-if="currentPage === 'sn-manage'">
            <div class="ops-banner">⚙ 口径 P0：退货 / 呆滞 SN 自动从激活率分母剔除（聚合层生效）——本页人工操作台为 P1 交付</div>
            <div style="background:#fff;border-radius:12px;padding:16px 20px;box-shadow:0 2px 12px rgba(0,0,0,0.04);margin-bottom:16px;display:flex;gap:12px;align-items:center">
              <el-input placeholder="SN / 订单号检索" style="width:300px" />
              <el-button type="primary">检索</el-button>
              <span style="color:#606266;font-size:13px;margin-left:12px">状态：</span>
              <el-select model-value="全部" style="width:130px"><el-option value="全部" label="全部" /></el-select>
            </div>
            <div style="background:#fff;border-radius:12px;padding:8px 20px 20px;box-shadow:0 2px 12px rgba(0,0,0,0.04)">
              <el-table :data="snRows" style="width:100%">
                <el-table-column prop="sn" label="设备 SN" width="170" />
                <el-table-column prop="order" label="绑定订单" width="130" />
                <el-table-column prop="date" label="出库日期" width="130" />
                <el-table-column label="激活状态" width="130">
                  <template #default="{row}"><el-tag :type="row.tagType" size="small">{{ row.status }}</el-tag></template>
                </el-table-column>
                <el-table-column prop="calc" label="分母处理" width="200" />
                <el-table-column label="操作">
                  <template #default="{row}"><el-button type="primary" link size="small">{{ row.op }}</el-button></template>
                </el-table-column>
              </el-table>
              <div style="font-size:12px;color:#909399;margin-top:14px">退货 SN 状态可重置（翻新二次售出不能直接算「已激活」）；P0 期间退货名单由订单系统导入兜底。</div>
            </div>
          </div>

          <!-- ========== 运营操作台 · 客服挽回工单池 ========== -->
          <div v-if="currentPage === 'cs-tickets'">
            <div class="stat-cards" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
              <div class="stat-card"><div class="label">今日新增工单（T+5）</div><div class="value" style="color:#409eff">14</div></div>
              <div class="stat-card"><div class="label">待外呼</div><div class="value" style="color:#e6a23c">9</div></div>
              <div class="stat-card"><div class="label">本周挽回成功率</div><div class="value" style="color:#67c23a">31%</div></div>
            </div>
            <div style="background:#fff;border-radius:12px;padding:8px 20px 20px;box-shadow:0 2px 12px rgba(0,0,0,0.04)">
              <el-table :data="csRows" style="width:100%">
                <el-table-column prop="sn" label="设备 SN" width="160" />
                <el-table-column prop="phone" label="家长联系方式" width="140" />
                <el-table-column prop="t" label="T+天数" width="90" />
                <el-table-column prop="log" label="蓝牙错误日志摘要（外呼前必看）" min-width="280" />
                <el-table-column label="状态" width="110">
                  <template #default="{row}"><el-tag :type="row.tagType" size="small">{{ row.status }}</el-tag></template>
                </el-table-column>
                <el-table-column label="操作" width="110">
                  <template #default><el-button type="primary" link size="small">记录外呼</el-button></template>
                </el-table-column>
              </el-table>
              <div style="font-size:12px;color:#909399;margin-top:14px;line-height:1.8">
                触达分级：T+1 / T+3 自动提醒（扣除周末权重），T+5 转人工 · 日志区分「卡配网」vs「激活了没真用」，话术按卡点精准。<br/>
                P0 过渡：未激活名单每日导出 excel（复用统计页导出），本工单池界面 P1 交付。
              </div>
            </div>
          </div>

          <!-- ========== KidsHub 运营台 ========== -->
          <div v-if="currentPage === 'kidshub'">
            <div class="kh-wrap">
              <div class="kh-nav">
                <div class="kh-logo">KidsHub 后台</div>
                <button v-for="n in khNavs" :key="n.k" :class="{on: khNav===n.k}" @click="khSelectNav(n.k)">{{ n.l }}</button>
                <button class="kh-back" @click="handleMenuSelect('dashboard')">⇠ 数据看板</button>
              </div>
              <div class="kh-main" style="display:flex;gap:0;padding:0">
                <!-- Issue 看板 -->
                <template v-if="khNav==='board'">
                  <div style="flex:1;min-width:0;padding:20px">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start">
                      <div><div class="kh-h1">KidsHub 后台 · Issue 看板</div>
                      <div class="kh-sub">拖动卡片推进状态 · 全正面态 · 终态变更需二次确认</div></div>
                      <el-button type="primary" size="small" style="background:#3B7A99;border-color:#3B7A99">+ 版本决策</el-button>
                    </div>
                    <div class="kh-board">
                      <div v-for="col in khIssueCols" :key="col.key">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                          <span class="kh-chip" :class="col.key"><i></i>{{ khStatusLabel(col.key) }}</span>
                          <span style="font-size:12px;color:#6B7785;font-weight:700">{{ col.items.length }}</span>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:10px">
                          <div class="kh-issue" v-for="it in col.items" :key="it.id" @click="openKhIssue(it, col.key)">
                            <div style="display:flex;justify-content:space-between;align-items:center">
                              <span class="iid">{{ it.id }}</span>
                              <span class="src" :style="{background: it.src==='孩子' ? '#E0913A' : '#5B8C7B'}">{{ it.src }}</span>
                            </div>
                            <p>{{ it.text }}</p>
                            <div class="meta"><span>😶 {{ it.mood }}</span><span>#{{ it.theme }}</span><span class="ct">+{{ it.c }}</span></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="kh-pool">
                    <div style="font-size:14px;font-weight:700">主题池</div>
                    <div style="font-size:12px;color:#6B7785;margin:4px 0 14px">情绪极性 + 主题 双标签聚合 · 攒够阈值进版本决策</div>
                    <div class="pt" v-for="t in khThemes" :key="t.name">
                      <div><div style="font-size:13px;font-weight:700">{{ t.name }}</div>
                      <div style="font-size:11px;color:#6B7785;margin-top:2px">情绪：{{ t.mood }}</div></div>
                      <div style="font-size:18px;font-weight:800" :style="{color: t.n>=10 ? '#3B7A99' : '#6B7785'}">{{ t.n }}</div>
                    </div>
                    <div class="kh-hint">“夜航·内容” 已达 12 条 ≥ 阈值，建议进入版本决策。</div>
                  </div>
                </template>

                <!-- 贡献账本 -->
                <div v-if="khNav==='ledger'" style="flex:1;padding:20px">
                  <div class="kh-h1">贡献账本</div>
                  <div class="kh-sub">贡献值 / 等级由「被采纳的质量」驱动，非提交数量（防灌水刷分）</div>
                  <div class="kh-card" style="overflow:hidden">
                    <table class="kh-table"><thead><tr><th>孩子</th><th>等级</th><th>贡献值</th><th>已采纳</th><th>质量分</th></tr></thead>
                    <tbody><tr v-for="r in khLedger" :key="r.name">
                      <td style="font-weight:600">{{ r.name }}</td><td>Lv.{{ r.lv }} {{ r.title }}</td>
                      <td style="color:#3B7A99;font-weight:700">{{ r.contrib }}</td><td>{{ r.adopted }}</td>
                      <td style="color:#3DBE78;font-weight:700">{{ r.quality }}</td>
                    </tr></tbody></table>
                  </div>
                  <div class="kh-sub" style="margin-top:12px">每笔贡献可溯源到来源工单；等级档位与命名后台可配置。</div>
                </div>

                <!-- 金点子库 -->
                <div v-if="khNav==='vault'" style="flex:1;padding:20px">
                  <div class="kh-h1">金点子库</div>
                  <div class="kh-sub">暂未进版本但被珍藏的点子 · 攒够热度可「翻牌」进版本决策 · 不是回收站</div>
                  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">
                    <div class="kh-card" v-for="it in khIdeas" :key="it.title" style="padding:14px;border-color:#D9CEF7">
                      <div style="font-size:11px;font-weight:800;color:#9B7BF0;margin-bottom:8px">★ {{ it.votes }} 热度</div>
                      <p style="margin:0 0 12px;font-size:14px;min-height:40px">{{ it.title }}</p>
                      <div style="display:flex;justify-content:space-between;align-items:center">
                        <span style="font-size:12px;color:#6B7785">by {{ it.by }}</span>
                        <el-button size="small" style="color:#9B7BF0;background:#EEE8FD;border:none">翻牌 →</el-button>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 版本决策 -->
                <div v-if="khNav==='version'" style="flex:1;padding:20px;max-width:760px">
                  <div class="kh-h1">版本决策与更新说明致谢</div>
                  <div class="kh-sub">采纳的反馈 → 升版 → 更新说明署名致谢（= changelog contributors）</div>
                  <div class="kh-card" style="padding:20px">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
                      <span style="font-size:16px;font-weight:700">v1.4 更新说明（草稿）</span>
                      <span class="kh-chip adopted"><i></i>已采纳</span>
                    </div>
                    <div style="font-size:14px;font-weight:700;margin-bottom:8px">这次因为小朋友们的建议，小可又进化了：</div>
                    <div v-for="a in khAdopted" :key="a.text" style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px dashed #E4E9EF">
                      <span style="font-size:13.5px">· {{ a.text }}</span>
                      <span style="font-size:13px;color:#3DBE78;font-weight:700">致谢 @{{ a.by }}</span>
                    </div>
                    <div style="margin-top:16px;display:flex;gap:10px">
                      <el-button type="primary" size="small" style="background:#3B7A99;border-color:#3B7A99">发布 + 推送致谢</el-button>
                      <el-button size="small">编辑文案</el-button>
                    </div>
                  </div>
                  <div class="kh-sub" style="margin-top:12px">发布后：孩子端 KidsHub 署名致谢（归功能 15）+ 家长端定向回告（归回告路由台）。</div>
                </div>

                <!-- 复访触发 -->
                <div v-if="khNav==='revisit'" style="flex:1;padding:20px">
                  <div class="kh-h1">复访触发台（孩子端 · 四级降级）</div>
                  <div class="kh-sub">不走推送 · 不走家长 App · 只在设备端主线场景由小可开口</div>
                  <div class="kh-card" style="overflow:hidden;margin-bottom:20px">
                    <table class="kh-table"><thead><tr><th>级别</th><th>规则</th><th>触发条件</th><th>动作（设备端主线场景）</th><th>状态</th></tr></thead>
                    <tbody><tr v-for="r in khRevisitRules" :key="r.lv">
                      <td><span class="kh-lvl" :style="{background:r.bg,color:r.c}">{{ r.lv }}</span></td>
                      <td style="font-weight:600">{{ r.name }}</td><td>{{ r.cond }}</td>
                      <td style="color:#6B7785">{{ r.act }}</td>
                      <td><el-tag size="small" :type="r.st==='开启'?'success':'info'">{{ r.st }}</el-tag></td>
                    </tr></tbody></table>
                  </div>
                  <div class="kh-h1" style="font-size:14px">触发记录（近 7 天）</div>
                  <div class="kh-card" style="overflow:hidden;margin-top:10px">
                    <table class="kh-table"><thead><tr><th>时间</th><th>孩子</th><th>级别</th><th>触达场景</th><th>结果</th></tr></thead>
                    <tbody><tr v-for="r in khRevisitRecs" :key="r.t">
                      <td style="color:#6B7785">{{ r.t }}</td><td style="font-weight:600">{{ r.kid }}</td>
                      <td style="color:#3B7A99;font-weight:700">{{ r.lv }}</td><td>{{ r.scene }}</td><td style="color:#6B7785">{{ r.result }}</td>
                    </tr></tbody></table>
                  </div>
                </div>

                <!-- 流失拦截 -->
                <div v-if="khNav==='intercept'" style="flex:1;padding:20px">
                  <div class="kh-h1">流失拦截台（家长端）</div>
                  <div class="kh-sub">活跃度命中流失规则 + 30 天频控 → 小程序软化单选题 → 按答案即时分流挽回</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
                    <div class="kh-card" style="padding:16px">
                      <div style="font-weight:700;margin-bottom:10px">触发规则</div>
                      <div class="kh-sub" style="margin:0;line-height:2">· 流失风险命中：30-60 天未使用<br/>· 频控：同一家长 30 天内最多触发 1 次<br/>· 必含「只是暂时没空」选项 · 未作答只记标记不追问</div>
                    </div>
                    <div class="kh-card" style="padding:16px">
                      <div style="font-weight:700;margin-bottom:10px">挽回分流规则（答案 → 动作）</div>
                      <div class="kh-sub" style="margin:0;line-height:2" v-for="f in khInterceptFlows" :key="f.a"><b style="color:#1F2933">{{ f.a }}</b> {{ f.b }}</div>
                    </div>
                  </div>
                  <div class="kh-h1" style="font-size:14px">答卷记录</div>
                  <div class="kh-card" style="overflow:hidden;margin-top:10px">
                    <table class="kh-table"><thead><tr><th>日期</th><th>家长</th><th>答案</th><th>挽回动作</th><th>状态</th></tr></thead>
                    <tbody><tr v-for="r in khInterceptRecs" :key="r.d + r.p">
                      <td style="color:#6B7785">{{ r.d }}</td><td>{{ r.p }}</td><td style="font-weight:600">{{ r.a }}</td>
                      <td style="color:#6B7785">{{ r.act }}</td>
                      <td><el-tag size="small" :type="r.tag">{{ r.st }}</el-tag></td>
                    </tr></tbody></table>
                  </div>
                  <div class="kh-sub" style="margin-top:12px">与复访触发台分开：孩子复访走设备端小可、家长拦截走小程序推送——通道 / 对象 / 话术不同，频控互不污染。</div>
                </div>

                <!-- 度量看板 -->
                <div v-if="khNav==='metrics'" style="flex:1;padding:20px">
                  <div class="kh-h1">KidsHub 度量看板</div>
                  <div class="kh-sub">两道验收闸门的判定依据 · 分层自然观察（本版不做 A/B）</div>
                  <div style="display:grid;grid-template-columns:58fr 42fr;gap:16px;margin-bottom:16px">
                    <div class="kh-card" style="padding:16px">
                      <div style="font-weight:700;margin-bottom:12px">孩子侧漏斗（本月）</div>
                      <div class="kh-funnel-row" v-for="f in khFunnel" :key="f.name">
                        <span class="fl">{{ f.name }}</span>
                        <div class="fb" :style="{width: f.pct*3.2+'px', opacity: 0.35+f.pct/150}"></div>
                        <span class="fv">{{ f.n }} · {{ f.pct }}%</span>
                      </div>
                    </div>
                    <div>
                      <div class="kh-card" v-for="c in khParentCards" :key="c.l" style="padding:12px 16px;margin-bottom:10px">
                        <div style="font-size:12px;color:#6B7785">{{ c.l }}</div>
                        <div style="font-size:20px;font-weight:700;color:#5B8C7B">{{ c.v }}</div>
                      </div>
                      <div style="padding:12px 16px;border-radius:12px;background:#EEE8FD">
                        <div style="font-size:12px;color:#9B7BF0">金点子库 vs 已采纳比</div>
                        <div style="font-size:16px;font-weight:700;color:#9B7BF0">4.2 : 1（防婉拒垃圾桶）</div>
                      </div>
                    </div>
                  </div>
                  <div class="kh-card" style="padding:16px">
                    <div style="font-weight:700">分层留存曲线（高/中/低/零贡献 · 30/60/90 日）　<span style="font-weight:400;font-size:12px;color:#6B7785">闸门②：高贡献显著高于零贡献 + 切片较基线 ≥5pp</span></div>
                    <div id="chartKhRetention" style="width:100%;height:300px"></div>
                  </div>
                </div>

                <!-- 回告路由 -->
                <div v-if="khNav==='notify'" style="flex:1;padding:20px">
                  <div class="kh-h1">回告路由台（仅家长端定向 + 全体公开预告）</div>
                  <div class="kh-sub">孩子端回告归 KidsHub（功能 15），不在本台 · 推送只是提醒，内容必落消息中心可重看</div>
                  <div class="kh-card" style="overflow:hidden;margin-bottom:16px">
                    <table class="kh-table"><thead><tr><th>工单</th><th>级别 · 阶段</th><th>路由目标</th><th>时效</th><th>送达状态</th></tr></thead>
                    <tbody><tr v-for="r in khNotifyRows" :key="r.id">
                      <td style="color:#6B7785;font-family:monospace">{{ r.id }}</td><td style="font-weight:600">{{ r.lvl }}</td>
                      <td>{{ r.target }}</td><td style="color:#6B7785">{{ r.sla }}</td>
                      <td><el-tag size="small" :type="r.tag">{{ r.st }}</el-tag></td>
                    </tr></tbody></table>
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                    <div class="kh-card" style="padding:16px">
                      <div style="font-weight:700;margin-bottom:10px">送达监控</div>
                      <div class="kh-sub" style="margin:0;line-height:2.2">定向回告送达率 <b style="color:#3B7A99;float:right">98%</b><br/>打开率 <b style="color:#3B7A99;float:right">62%</b><br/>7天未打开（已走兜底） <b style="color:#3B7A99;float:right">3 条</b></div>
                    </div>
                    <div class="kh-card" style="padding:16px">
                      <div style="font-weight:700;margin-bottom:10px">措辞模板（共创化）</div>
                      <div style="background:#F6F8FA;border-radius:8px;padding:12px 14px;font-size:13px;font-weight:600">「因为你的建议，小可又进化了」<div style="font-weight:400;font-size:12px;color:#6B7785;margin-top:4px">+ 改后对比图（眼见为实）</div></div>
                    </div>
                  </div>
                  <div class="kh-sub" style="margin-top:12px">兜底链：推送 7 天未打开 → 周报二次提醒 + 消息中心常驻红点；亲子纽带联动仅触发条件，孩子端展示归功能 15。</div>
                </div>
              </div>
            </div>

            <!-- 工单详情抽屉（状态机操作） -->
            <el-drawer v-model="khDrawerOpen" :title="khDrawer ? khDrawer.id : ''" size="400px">
              <div v-if="khDrawer" style="padding:0 4px">
                <div style="font-size:16px;font-weight:700;margin-bottom:12px">{{ khDrawer.text }}</div>
                <div style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap">
                  <el-tag size="small" type="info">来源：{{ khDrawer.src }}</el-tag>
                  <el-tag size="small" type="info">情绪：{{ khDrawer.mood }}</el-tag>
                  <el-tag size="small" type="info">#{{ khDrawer.theme }}</el-tag>
                </div>
                <div style="font-size:13px;font-weight:800;color:#6B7785;margin-bottom:10px">状态推进（全正面 · 终态需二次确认）</div>
                <div v-for="s in ['received','reviewing','adopted']" :key="s" @click="khSetStatus(s)"
                  :style="{border: khDrawer.status===s ? '2px solid #3B7A99' : '1px solid #E4E9EF', background: khDrawer.status===s ? '#F6F8FA' : '#fff'}"
                  style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:10px;margin-bottom:8px;cursor:pointer">
                  <span class="kh-chip" :class="s"><i></i>{{ khStatusLabel(s) }}</span>
                  <span v-if="khDrawer.status===s" style="font-size:12px;color:#3B7A99;font-weight:700">当前</span>
                </div>
                <div @click="khSetStatus('vault')"
                  :style="{border: khDrawer.status==='vault' ? '2px solid #9B7BF0' : '1px dashed #E4E9EF', background: khDrawer.status==='vault' ? '#EEE8FD' : '#fff'}"
                  style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:10px;cursor:pointer">
                  <span class="kh-chip vault"><i></i>金点子库</span><span style="font-size:12px;color:#6B7785">暂不采纳 → 珍藏</span>
                </div>
                <div style="font-size:13px;font-weight:800;color:#6B7785;margin:18px 0 8px">回告路由</div>
                <div style="font-size:13px;color:#6B7785;line-height:1.6">采纳后 → 孩子端 KidsHub 署名致谢 + 家长端消息中心定向回告。</div>
              </div>
            </el-drawer>
          </div>
'''
PAGE_ANCHOR = '''          </div>

  <script src="https://cdn.jsdelivr.net/npm/vue@3.4.21/dist/vue.global.prod.js"></script>'''
assert PAGE_ANCHOR in html and html.count(PAGE_ANCHOR) == 1
html = html.replace(PAGE_ANCHOR, '          </div>\n' + PAGES + '\n  <script src="https://cdn.jsdelivr.net/npm/vue@3.4.21/dist/vue.global.prod.js"></script>')
hits += 1

# ───────────────────────── 4. 标题映射 ─────────────────────────
OLD_MAP = "var map = { dashboard: '数据概览', 'user-query': '单用户查询', 'user-list': '全部用户列表', 'user-stats': '统计页面', 'date-query': '日期范围查询' };"
NEW_MAP = "var map = { dashboard: '数据概览', 'user-query': '单用户查询', 'user-list': '全部用户列表', 'user-stats': '统计页面', 'date-query': '日期范围查询', 'sn-manage': 'SN 与订单管理（运营操作台）', 'cs-tickets': '客服挽回工单池（运营操作台）', 'kidshub': 'KidsHub 运营台' };"
assert html.count(OLD_MAP) == 1
html = html.replace(OLD_MAP, NEW_MAP)
hits += 1

# ───────────────────────── 5. setup 逻辑 + 暴露 ─────────────────────────
LOGIC = '''
        // ====== 整合版新增：KidsHub 运营台 + 运营操作台 ======
        var khNav = ref('board');
        var khNavs = [
          { k: 'board', l: 'Issue 看板' }, { k: 'ledger', l: '贡献账本' }, { k: 'vault', l: '金点子库' },
          { k: 'version', l: '版本决策' }, { k: 'revisit', l: '复访触发' }, { k: 'intercept', l: '流失拦截' },
          { k: 'metrics', l: '度量看板' }, { k: 'notify', l: '回告路由' }
        ];
        var khDrawer = ref(null);
        var khDrawerOpen = ref(false);
        var khIssueCols = reactive([
          { key: 'received', items: [
            { id: 'KH-241', text: '专注按钮太小，孩子够不着', src: '孩子', mood: '吐槽', theme: '专注·交互', c: 5, status: 'received' },
            { id: 'KH-240', text: '周报里护眼数据看不太懂', src: '家长', mood: '困惑', theme: '周报·可读性', c: 2, status: 'received' } ] },
          { key: 'reviewing', items: [
            { id: 'KH-235', text: '夜航故事太短，想听更长', src: '孩子', mood: '期待', theme: '夜航·内容', c: 12, status: 'reviewing' } ] },
          { key: 'adopted', items: [
            { id: 'KH-198', text: '开机问候叫孩子名字', src: '孩子', mood: '建议', theme: '破冰·个性化', c: 8, status: 'adopted' } ] },
          { key: 'vault', items: [
            { id: 'KH-176', text: '想要会发光的恐龙皮肤', src: '孩子', mood: '愿望', theme: '皮肤·养成', c: 1, status: 'vault' },
            { id: 'KH-152', text: '能不能和同学比贡献值', src: '孩子', mood: '愿望', theme: '社交·PK', c: 1, status: 'vault' } ] }
        ]);
        var khThemes = [
          { name: '夜航·内容', n: 12, mood: '期待' }, { name: '专注·交互', n: 9, mood: '吐槽' },
          { name: '皮肤·养成', n: 7, mood: '愿望' }, { name: '周报·可读性', n: 4, mood: '困惑' }
        ];
        var khLedger = [
          { name: '乐乐', lv: 5, title: '金牌共建', contrib: 240, adopted: 4, quality: 4.9 },
          { name: '果果', lv: 4, title: '点子能手', contrib: 175, adopted: 2, quality: 4.4 },
          { name: '朵朵', lv: 3, title: '小小设计师', contrib: 128, adopted: 1, quality: 4.6 },
          { name: '豆豆', lv: 2, title: '新晋玩家', contrib: 56, adopted: 0, quality: 3.8 }
        ];
        var khIdeas = [
          { title: '夜航能不能去太空', by: '豆豆', votes: 15 }, { title: '想要会发光的恐龙皮肤', by: '朵朵', votes: 12 },
          { title: '能不能和同学比贡献值', by: '乐乐', votes: 8 }, { title: '生态缸加只小乌龟', by: '朵朵', votes: 9 },
          { title: '小可能不能讲笑话', by: '果果', votes: 6 }, { title: '专注音乐能换吗', by: '乐乐', votes: 5 }
        ];
        var khAdopted = [
          { text: '开机问候叫孩子名字', by: '朵朵' }, { text: '坐姿提醒改温和不锁屏', by: '乐乐' }, { text: '周报数据加图标说明', by: '果果' }
        ];
        var khRevisitRules = [
          { lv: 'L1', name: '入口冷启动', cond: '1 周触发 0 进入', act: '完成专注后弹引导 + 每周主动唤起一次', st: '开启', bg: '#E3F0FD', c: '#4A9DF0' },
          { lv: 'L2', name: '提交后不回看', cond: '提交后 24h 未查看状态', act: '小可下一次主线场景开口「你提的那条有结果啦」', st: '开启', bg: '#DEF5E9', c: '#3DBE78' },
          { lv: 'L3', name: '久未提交', cond: '14 日无新提交', act: '出航 / 破冰里软触发「最近有想吐槽的吗」', st: '开启', bg: '#FEF3DC', c: '#F6A724' },
          { lv: 'L4', name: '等级停滞', cond: '长期初级且无提交', act: '进入用户访谈名单（人工跟进）', st: '人工', bg: '#EEE8FD', c: '#9B7BF0' }
        ];
        var khRevisitRecs = [
          { t: '06-10 08:12', kid: '小宇', lv: 'L2', scene: '破冰场景', result: '已开口 · 孩子查看了状态' },
          { t: '06-09 16:40', kid: '果果', lv: 'L3', scene: '出航场景', result: '已开口 · 孩子提交新建议 +1' },
          { t: '06-08 19:05', kid: '豆豆', lv: 'L1', scene: '专注完成', result: '弹引导 · 进入 KidsHub' },
          { t: '06-07 10:30', kid: '安安', lv: 'L4', scene: '—', result: '已加入访谈名单' }
        ];
        var khInterceptFlows = [
          { a: '觉得没用', b: '→ 推送价值解读（孩子数据亮点）' }, { a: '觉得太贵', b: '→ 发放搬家券等挽留权益' },
          { a: '不会用', b: '→ 推送教程' }, { a: '暂时没空', b: '→ 记录，不再打扰' }
        ];
        var khInterceptRecs = [
          { d: '06-10', p: '138****2046', a: '觉得太贵', act: '已发搬家券', st: '挽回中', tag: 'warning' },
          { d: '06-09', p: '159****8812', a: '只是暂时没空', act: '记录 · 不再打扰', st: '已关闭', tag: 'info' },
          { d: '06-08', p: '186****0937', a: '不会用', act: '已推教程', st: '已回访', tag: 'success' },
          { d: '06-06', p: '—（未作答）', a: '—', act: '仅记未作答标记', st: '不纠缠', tag: 'info' }
        ];
        var khFunnel = [
          { name: '曝光', pct: 100, n: 2104 }, { name: '进入', pct: 64, n: 1347 }, { name: '开口', pct: 41, n: 863 },
          { name: '提交', pct: 33, n: 694 }, { name: '回应送达', pct: 32, n: 673 }, { name: '查看状态', pct: 24, n: 505 },
          { name: '再次提交', pct: 15, n: 316 }, { name: '升级', pct: 9, n: 189 }
        ];
        var khParentCards = [
          { l: '小程序 PV', v: '3,420' }, { l: 'KidsHub 主页 UV', v: '1,186' }, { l: '家长访问后孩子 7 日提交率', v: '38%' }
        ];
        var khNotifyRows = [
          { id: 'KH-198', lvl: '小改 · 已上线', target: '定向 → 来源家长（138****2046）', sla: '48h 内', st: '已送达·已打开', tag: 'success' },
          { id: 'KH-235', lvl: '大功能 · 开发中', target: '公开预告 → 全体（周报首页+开机预告位）', sla: '并入下周报', st: '排期中', tag: 'primary' },
          { id: 'KH-176', lvl: '小改 · 已上线', target: '定向 → 来源家长（159****8812）', sla: '48h 内', st: '7天未打开→兜底', tag: 'danger' },
          { id: 'KH-152', lvl: '大功能 · 规划中', target: '公开预告 → 全体（话术「在做」）', sla: '并入下周报', st: '草稿', tag: 'info' }
        ];
        var snRows = [
          { sn: 'SN-2403-0117', order: 'PO-88213', date: '2026-03-02', status: '已激活', tagType: 'success', calc: '—', op: '换绑 / 解绑' },
          { sn: 'SN-2403-0254', order: 'PO-88419', date: '2026-03-15', status: '未激活', tagType: 'warning', calc: '—', op: '查看' },
          { sn: 'SN-2402-0083', order: 'PO-87206', date: '2026-02-11', status: '已退货', tagType: 'danger', calc: '已剔除分母', op: '打呆滞标记' },
          { sn: 'SN-2402-0095', order: 'PO-87391', date: '2026-02-18', status: '呆滞', tagType: 'info', calc: '已剔除分母', op: '重置（翻新再售）' },
          { sn: 'SN-2401-0312', order: 'PO-86150', date: '2026-01-25', status: '已激活', tagType: 'success', calc: '—', op: '换绑 / 解绑' },
          { sn: 'SN-2401-0078', order: 'PO-85894', date: '2026-01-12', status: '重置待售', tagType: 'primary', calc: '重置后不计已激活', op: '绑定新订单' }
        ];
        var csRows = [
          { sn: 'SN-2403-0254', phone: '138****2046', t: 'T+6', log: '蓝牙日志：WiFi 5G 不兼容 · 卡配网', status: '待外呼', tagType: 'warning' },
          { sn: 'SN-2403-0311', phone: '159****8812', t: 'T+5', log: '蓝牙日志：闸门1已过 · 孩子未真用', status: '待外呼', tagType: 'warning' },
          { sn: 'SN-2402-0188', phone: '186****0937', t: 'T+8', log: '蓝牙日志：路由器密码错误 3 次', status: '已挽回', tagType: 'success' },
          { sn: 'SN-2402-0205', phone: '135****5523', t: 'T+9', log: '蓝牙日志：闸门2未过 · 开盖无交互', status: '跟进中', tagType: 'primary' },
          { sn: 'SN-2401-0420', phone: '150****7741', t: 'T+12', log: '未取得联系（2 次）', status: '二次跟进', tagType: 'danger' }
        ];
        function khStatusLabel(s) {
          return { received: '已收到', reviewing: '评估中', adopted: '已采纳', vault: '金点子库' }[s] || s;
        }
        function openKhIssue(it, colKey) {
          it.status = it.status || colKey;
          khDrawer.value = it;
          khDrawerOpen.value = true;
        }
        function khSetStatus(s) { if (khDrawer.value) khDrawer.value.status = s; }
        function khSelectNav(k) {
          khNav.value = k;
          if (k === 'metrics') nextTick(initKhRetention);
        }
        var khRetentionChart = null;
        function initKhRetention() {
          var dom = document.getElementById('chartKhRetention');
          if (!dom) return;
          if (khRetentionChart) { khRetentionChart.dispose(); }
          khRetentionChart = echarts.init(dom);
          khRetentionChart.setOption({
            tooltip: { trigger: 'axis' },
            legend: { data: ['高贡献', '中贡献', '低贡献', '零贡献'], right: 10 },
            grid: { left: 50, right: 30, top: 40, bottom: 30 },
            xAxis: { type: 'category', data: ['30日', '60日', '90日'] },
            yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
            series: [
              { name: '高贡献', type: 'line', data: [82, 74, 69], itemStyle: { color: '#3DBE78' } },
              { name: '中贡献', type: 'line', data: [66, 55, 48], itemStyle: { color: '#4A9DF0' } },
              { name: '低贡献', type: 'line', data: [52, 40, 33], itemStyle: { color: '#F6A724' } },
              { name: '零贡献', type: 'line', data: [41, 28, 21], itemStyle: { color: '#9aa4ae' } }
            ]
          });
        }

'''
RET_ANCHOR = '''        return {
          isLoggedIn: isLoggedIn,'''
assert html.count(RET_ANCHOR) == 1
html = html.replace(RET_ANCHOR, LOGIC + RET_ANCHOR)
hits += 1

EXPOSE_OLD = '''          resetDateQuery: resetDateQuery
        };'''
EXPOSE_NEW = '''          resetDateQuery: resetDateQuery,
          khNav: khNav, khNavs: khNavs, khDrawer: khDrawer, khDrawerOpen: khDrawerOpen,
          khIssueCols: khIssueCols, khThemes: khThemes, khLedger: khLedger, khIdeas: khIdeas,
          khAdopted: khAdopted, khRevisitRules: khRevisitRules, khRevisitRecs: khRevisitRecs,
          khInterceptFlows: khInterceptFlows, khInterceptRecs: khInterceptRecs,
          khFunnel: khFunnel, khParentCards: khParentCards, khNotifyRows: khNotifyRows,
          snRows: snRows, csRows: csRows,
          khStatusLabel: khStatusLabel, openKhIssue: openKhIssue, khSetStatus: khSetStatus, khSelectNav: khSelectNav
        };'''
assert html.count(EXPOSE_OLD) == 1
html = html.replace(EXPOSE_OLD, EXPOSE_NEW)
hits += 1

# 标题
html = html.replace('<title>P003读写台数据后台</title>', '<title>P003 Web 后台（整合版）· 数据看板 + KidsHub 运营台 + 运营操作台</title>')

open(DST, 'w', encoding='utf-8').write(html)
print('注入完成:', hits, '/ 7 锚点, 输出', DST, len(html), 'bytes')
