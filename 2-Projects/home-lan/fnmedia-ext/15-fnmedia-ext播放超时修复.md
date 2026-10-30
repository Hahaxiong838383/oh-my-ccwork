# fnmedia-ext 播放超时修复（2026-10-30）

已修复一个有真机证据的播放失败原因并部署0.2.19.2；尚不能认定电视和手机所有影片都能播放。用户此前自行改TV端口后片库可见，本轮针对“可见但无法播放”。

## 已定位

- 原search_all对全部源gather，HTTPX的12秒只是每阶段超时；个别源总耗时超过27秒。榜单25秒总限取消整批搜索，已成功的片源也丢失，preset返回503。
- 飞牛1原逻辑查询“敦煌英雄”：dytt 0.86秒、lzi 1.13秒、ffzy 4.42秒已有返回，但整批25秒超时。lzi可能忽略关键词，不能把它的20条都算正确片源。
- 候选同机同词12.04秒结束，22条中3条为精确同名且有播放地址，分别ffzy/lzi/dytt。测试模拟旧实现会失败；新实现通过。
- 实际TV请求带Authorization/Cookie，官方user/info返回code0，已观察到preset/main 200、分片206；没有统一401故障证据。未采用鉴权票据、匿名放行等改造。
- “脱口秀和Ta的朋友们 第三季”完整查询没有精确可用结果；去季名能搜出旧结果不等于本季有源。禁止随便把旧季/无关影片绑定到当前卡片。

## 最小变更

1. 每个search_source外套12秒wall-clock deadline，取消慢源后保留成功源。
2. online_search/resolve_chart用shield保护共享Future，不让一个客户端的超时取消其他等待者。
3. 删除无匹配时无条件选择briefs[0]的兜底。

源码提交 `e6de9a6ad5f680863dd63d31a414fe3f7e0b739d`。完整113项回归通过；新增5项用旧实现复核4失败/1保护用例原本即通过。Hermes只读复核无阻断，验证多慢源取消后无孤儿task。未修改官方影视、鉴权、SSRF与用户隔离。

## 正式部署与数据

- FPK：`/data/home-studio/artifacts/fnmedia-tv-20261030/releases/fnmedia-ext-0.2.19.2-public.fpk`。
- FPK SHA256：`ea34e7a6ea66897bf414c8f10a267f5d01f19f4d8d77291b179e4177669d4fcb`。NAS文件回读一致，离线wheel 17个；83个安装载荷与发布包逐文件一致。
- 升级前独立恢复点：NAS `/var/lib/fnmedia-ext-backups/playback-20261030T142405Z/state.tar.gz`，SHA256 `0b074c80c365dced6242997ab757c0540a7126b95dba3183daa0e0080040e3eb`。备份逐文件与现场核对，JSON可解析，不入Git。
- 正式升级回调的停止后恢复点：`/var/lib/fnmedia-ext-backups/20261030T142726Z-1314654/state.tar.gz`。配置/历史/收藏与这一恢复点逐字节一致。早一份备份的history摘要不同是备份后至停服前仍有播放上报，不能误报丢失。
- 官方trim-cli update task `1793370438886549935-fnmedia-ext`；app status返回version0.2.19.2/running。服务22:27:46启动、MainPID1315081，两socket存在，真实匿名管理接口 `/v/api/ext/status` 返回401。错误路径 `/v/online-admin/api/config` 返回网页200，不能用它判断API鉴权。
- 官方程序/manifest/nginx SHA分别仍为65ca8f8706798b3f9c59837e5ecd8f231c65e1588214fc9fefeaed1b0d3ca5ba / 0b6c2474841486e915c09d09f31d9fc66cd25febd24bffadff63479220c5a780 / 9fe577ca519d03ce3dc41d7ade0deca7f4ce9599e67b807c145251b2fb3cff17。
- home-studio维护timer升级期间暂停，随后恢复active；可信源码快进至新提交，service和runner-state的last-good都指向新FPK，实际runner执行exit0。

## CLI适配层发现

既有local_upgrade代理只允许/ogh/，令牌过期时拦了官方/oauthapi/refresh。先通过原CLI刷新，随后补固定Host、仅POST的精确刷新路径原样转发；没有导出令牌或改凭据。已强制在代理内运行CLI refresh成功。

本次download/status明确packageType=path；local/file的update/info报10100，path dry-run通过，随后正式升级成功。适配器已固定使用实测path，仍走官方下载、guard、update/task与轮询，未卸载重装。

## 实播证据与待验

升级前海量电影第一条“敦煌英雄”：play/info code0/can_play1；preset200两个变体，main200共364817字节/1861个EXTINF/ENDLIST；首段206共339904字节、188字节TS同步有效，非HTML/PNG。TV播放器曾显示00:43/02:04:17，SurfaceFlinger帧时间推进，但Amlogic视频层截图黑屏，无法据此证明真实画面声音，也不能据此判定解码故障。

升级后电视前台变为com.player.diyp2020；已询问是外部调用还是切换观看其他内容，未收到回答。停止继续遥控，避免干扰观看。升级后访问日志尚无新的TV/手机播放请求，故上述升级前证据不得冒充新版本端到端验收。手机是原生App还是浏览器也未确认。

下一次：在用户确认可测后从飞牛影视重开“海量电影→敦煌英雄”，核播放器持续推进、画面与声音；再选一个有精确片源的榜单项核新搜索及preset/main/TS。手机另测，不从TV推断。会话凭据只留诊断进程内存，不落pcap/日志/Git。

已知边界：第三方源可失效、标题别名/繁简/季数尚未统一；聚合先截12条再匹配可能漏掉相关项。Hermes指出播放列表共享Future也有同类取消风险，当前未修改，须有针对性复现再处理。不能承诺“海量内容全部能播”。
