# Grok Brain Review

审查对象是本工作树已提交的 HEAD，不是未跟踪文件，也不是 Worker 二进制。

- HEAD：`15d07e6161dcd083d12501cd37d9511cad489427`
- 对比基线：`62d840c2e347d65bec1de4ddf523b6a2a7c117d6`
- 提交说明：`feat(p003): explain weather place resolution in read-only routing preview`
- 结论：**没有阻断项**。这次变更只给管理端预览附加 Brain 目录解释，不改配置 schema，不改执行期解析，不新增天气网络请求。

## 范围

相对 `62d840c2` 的提交只包含这些源码与测试，外加四份说明文档：

- `2-Projects/P003GameDemo20260513/apps/server/src/tools/weather-places.ts`
- `2-Projects/P003GameDemo20260513/apps/server/src/routes/search-routing-admin.ts`
- `2-Projects/P003GameDemo20260513/apps/web/public/admin/index.html`
- 新增 `weather-place-contract.test.ts`、`weather-preview-inspection.test.ts`、`search-routing-preview-ui.cjs` 和 3230 条契约样例

`fixed-weather.ts`、`search-runtime.ts`、两个既有失败测试、`search-routing-config.ts` 与基线字节相同。精确基线归档 `brain-baseline/` 里的这几个文件也与 `62d840c2` 字节相同。不能用灰度旧树的高德优先或网页 fallback 覆盖这条主池路径。

## 本次复核

Node 使用 `/Users/fu-121/.local/node-v24/bin/node`（v24.19.0）和树内已有的 `tsx`。没有安装依赖。

| 检查 | 结果 |
| --- | --- |
| 3230 条地点契约 | 通过，exit 0 |
| HTTP 预览：唯一、歧义、未知、非法、旧响应、不写库 | 通过，exit 0 |
| 既有管理路由权限、严格字段、预览不写、CAS、回归门 | 通过，exit 0 |
| 生产 Vue / WebKit 11 组场景 | 本机重跑通过。隔离 API fixture，不是供应商，也不是真机语音 |
| `fixed-weather` | exit 1，与基线同一断言 |
| `search-weather-fallback-runtime` | exit 1，与基线同一断言 |

另外用只读探针确认：无 token 预览返回 401；editor 登录成功但预览返回 403；admin 预览返回 200；`revision` 仍为 0；该过程 `fetch` 次数为 0。

目录指纹：`sha256=40f4cc66ff051ab205e9299e7b13bf458b62b28b4ce9e6e8e3a7a141b7ded69b`，`count=3220`。3220 是唯一天气站数。3230 是契约输入条数，两者不是同一个计数。

## 重点结论

Brain 仍是地点解析权威。`resolveWeatherPlace` 只是改为调用 `inspectWeatherPlace`，候选筛选、省份收窄和返回副本与原来一致。执行路径继续抛出原来的错误：`weather_place_invalid`、`weather_place_ambiguous`、`weather_place_unknown`。预览路由在 Brain 返回 `place_weather.place` 之后，再用同一个函数附加 `place_inspection`，不采用预览程序自带的站点结论。

配置 schema 没有新字段。`routingConfigSchema` 不在本次 diff 中，仍是 strict 的 schema 1。`weather_catalog` 和 `place_inspection` 只出现在预览响应里，不进入草稿、发布或回滚。

没有额外天气网络。检查函数只读进程内目录。预览处理函数不调用百度、墨迹或高德。页面文案写明预览不请求天气。

管理权限没有放宽。`app.use('*')` 仍先要求有效 token，再要求 `isAdminRole`。editor 和 guest 到不了新的预览逻辑。

预览保持只读。新处理函数不调用 `saveDraft`、`publish` 或 `rollback`。HTTP 测试和探针都看到 revision 不变。

错误语义保持兼容。非法、未知和歧义在预览里变成状态，不再把预览打成 500；执行期仍拒绝非唯一地点。旧预览结果没有 `place_weather` 时原样返回，页面显示“本版本未提供地点详情”。

重名不选。裸名“朝阳”得到三条候选：北京朝阳 `101010300`、吉林长春朝阳 `101060110`、辽宁朝阳 `101071201`。`resolveWeatherPlace('朝阳')` 抛出 `weather_place_ambiguous`。预览响应仍保留地点字符串“朝阳”，不把其中任一站写回决策。带省份上下文的执行解析仍可收窄，例如 `{province:'辽宁'}` 得到 `101071201`；预览路由故意不传设备省份，与“预览不读取设备位置”一致。

HTML 插值没有执行用户文本。新增模板只用 `{{ }}`，没有 `v-html`。WebKit 重跑把地点设为 `<img src=x onerror=window.xss=1>`：文本里能看到字面量 `<img`，页面 `img` 数量为 0，`window.xss` 为 undefined。11 组场景是：唯一、歧义、未知、非法/XSS、旧响应、普通聊天、503、409、发布、回滚、关闭天气开关。

状态兼容。`routing.catalog` 初始为 null；成功预览才写入，缺字段时写回 null。登出和改草稿会清掉 `preview`，目录行包在 `v-if="routing.preview"` 里，所以不会单独显示上一轮指纹。

## 既有失败，不是这次引入

两条失败的实现和测试与 `62d840c2` 字节相同。归档日志的 SHA-256 与 `KNOWN_BASELINE_FAILURES.json` 一致。本机在 HEAD 上重跑，失败点相同。

`fixed-weather`：前半段百度加墨迹的精确回退、范围、AQI 和取消已经打印通过。随后测试构造了 `amap` 选项，并让 `baidu.run` 抛出 `not_expected`。主池 `FixedWeather` 构造函数只接收 `baidu` 和 `moji`，`run` 在第 24 行调用百度，因此抛出 `not_expected`。这是测试期待高德优先，主池没有该行为。

`search-weather-fallback-runtime`：百度返回 429 后，测试期待正文匹配 `/成都/` 并且来源是 `weather.com.cn`。主池实际返回“这次天气数据暂时没能通过地点或时效校验，我先不报未经确认的结果。”这是测试期待网页 fallback，主池明确拒绝未校验天气。

这两条差异在基线归档里已经存在。本次预览变更没有碰到这两条路径，不能据此把灰度旧树整段覆盖到主池。

## 边界

正式语音不在本次通过范围内。Worker 归档只显示 `search-route-preview` 的 release 编译退出码 0，那是主 13 的独立编译记录。本审查重跑的 HTTP 和 Vue 都使用桩预览或隔离 API，不能当成真机实听通过。

管理预览不读取设备位置。裸重名在预览中保持歧义；设备执行若另行带上已就绪的省份，仍走原来的 `resolveWeatherPlace(place, context)`。预览列表不会代替那次执行选择。

WebKit 歧义样例只放入两条“朝阳”标签，用来检查渲染和转义。完整的三条候选以 Brain 解析和 HTTP 断言为准。

`brain-ui-debug.log` 是更早一次找不到 `#routing-utterances` 的超时。随后的 `brain-ui.log` 和本次重跑都已通过，不以那次调试日志作为当前失败。

审查期间工作树出现未跟踪文件 `apps/server/scripts/weather-compiled-http.test.ts`（13:29，非本审查所写，也未执行）。它不在 HEAD 里。文件自身把 provider 标成 synthetic frozen response，并把 `real_device` 标成 false，即使运行也不能当作正式语音通过。

登出后 `routing.catalog` 仍留在内存里，但当前模板没有 `preview` 就不会渲染。这不构成跨会话展示，也不是阻断。
