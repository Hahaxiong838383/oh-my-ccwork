# 来源

访问日期一律是 2026-11-11。命中次数不是使用频率。语料里的 `source_id` 只标记表达族指针：`quote` 才是页面上的短引，`rewrite` 是按公开说法改写，`synthetic` 是为边界写的句子。改写和合成都不是数据集原句，也不是真实用户日志。

本轮没有登录，没有抓私人账号，没有下载 DialogFlow 数据包、RiSAWOZ 数据文件、CrossWOZ 训练包或 Nexdata 句子。历史私聊没有外传。

## 全文打开

| ID | 标题 | URL | 支持的表达族 | 许可证与复用 |
| --- | --- | --- | --- | --- |
| S01 | 简书《语音灵犀》 | https://www.jianshu.com/p/82720b852de9 | 带伞问句；叙事里的没带伞、下雨、落汤鸡 | 著作权归作者。只保留下面 4 句短引，不转载正文 |
| S02 | IT之家，天猫精灵信鸽，2021-07-22 | https://www.ithome.com/0/564/493.htm | 灾情近况、紧急救援、订阅提醒、灾后知识问句 | 新闻版权。只保留下面 5 句短引 |
| S03 | howl-anderson/NLU_benchmark_dataset README | https://github.com/howl-anderson/NLU_benchmark_dataset | 意图名 weather、weather.temperature、weather.condition、weather.outfit、weather.activity、address、date-time | README 写明版权归 DialogFlow。未下 zip，语料中没有该数据集原句 |
| S04 | CrossWOZ README | https://github.com/thu-coai/CrossWOZ | 中文多轮、跨域追问这一现象。5 个域是 hotel、restaurant、attraction、metro、taxi，没有天气域 | 仓库 LICENSE 为 Apache-2.0：https://github.com/thu-coai/CrossWOZ/blob/master/LICENSE 。未下数据，0 句复制。论文只作引用：https://arxiv.org/abs/2002.11893 |
| S05 | RiSAWOZ README | https://github.com/terryqj0107/RiSAWOZ | 省略、指代这一现象。不把 12 个域写成天气词表 | README 声明 CC BY-NC 4.0：https://creativecommons.org/licenses/by-nc/4.0/ 。数据未下载。非商业，禁止把该数据集句子再分发。Hugging Face 卡片若写 CC BY 4.0，以仓库 README 的 NC 为准 |
| S05b | RiSAWOZ 论文摘要页 | https://arxiv.org/abs/2010.08738 | 同上。作者 Jun Quan 等，EMNLP 2020，930–940 页 | arXiv 非独占分发许可只覆盖论文页面。ACL 版本：https://www.aclweb.org/anthology/2020.emnlp-main.67 。未抄摘要进语料 |
| S06 | caiyun-weather SKILL.md | https://github.com/zhdsmy/caiyun-weather/blob/main/SKILL.md | 降雨、带伞、现在是否下雨、雨是否变大、体感、空气质量；先地址后坐标 | 本次未确认该仓库许可证。只引用能力名称，不把 SKILL 正文写入语料 |
| S07 | SMP2017ECDT-DATA 仓库页 | https://github.com/HITlilingzhi/SMP2017ECDT-DATA | 中文人机对话评测这一任务类型。页面可见“第六届全国社会媒体处理大会之中文人机对话技术评测” | README 未单独打开，数据未下。0 句复制。评测主页链接为 http://ir.hit.edu.cn/SMP2017-ECDT |

S01 短引，原句保留在语料 `provenance=quote`：

- 今天要不要带伞啊
- 所以我一出门练车就下雨，欺负我没带伞
- 没带伞出门，现在车外面大雨
- 今天注定落汤鸡吗

S02 短引，同样只在 `quote`：

- 郑州现在如何
- 河南暴雨紧急救援
- 车辆落水怎么办
- 如何防止灾后疫情
- 订阅异常天气提醒

## 检索摘要，未当全文

这些页面只看到标题、摘要或搜索片段。对应句子若进语料，标记为 rewrite 或 synthetic，不是引用。

| 页面 | URL | 片段里出现的说法 | 边界 |
| --- | --- | --- | --- |
| 搜狐，小爱同学，2018 | https://www.sohu.com/a/231786490_231544 | 明天需要带伞吗、今天空气质量怎么样、明天穿什么合适 | 新闻转载，未打开全文 |
| 今日头条 | https://www.toutiao.com/article/7473774238197940751/ | 明天要带伞吗 | 未打开全文 |
| 小米小爱开放平台 | https://developers.xiaoai.mi.com/xiaoai6 | 营销例句“今天天气” | 不是天气技能规格 |
| 凤凰网，小度 | http://itech.ifeng.com/45043375/news.shtml | 北京明天的天气如何、今天需要带伞吗 | 未打开全文 |
| 驱动中国，小度 | https://www.qudong.com/article/331253.html | 小度小度，明天的天气怎么样；那天津呢；系统句“是问明天冷不冷么” | 未打开全文 |
| Apple 天气+ | https://apps.apple.com/cn/app/id1542742219 | 要带伞吗、外面到底多冷多热；Siri“天气 +今天会下雨吗” | 商店文案片段 |
| anthropics/skills PR 708 | https://github.com/anthropics/skills/pull/708/files | 技能说明里的冷不冷、会下雨、要带伞 | 未把 PR 里的原句写入语料 |
| 天猫精灵开发教程 | https://www.laitimes.com/zh/article/1q4rw_1wa4v.html | 城市+日期+天气怎么样；追问哪个城市；默认今天 | 模板说明，未打开全文 |
| 什么值得买，小度帖 | 检索片段，未保留不稳定帖子 URL 以外的正文 | 江苏邓州这一类行政区冲突说法 | 语料是改写“江苏邓州明天天气怎么样”，保留矛盾原文，不改成邓州或江苏某市 |
| 枳生天气 README | https://github.com/zhishengplus/ZhishengWeather | 要不要带伞、出门穿什么、会不会降温 | 搜索片段 |
| Rasa 中文 NLU | https://github.com/Aguila-team/Chinese_NLU_by_using_RASA_NLU | 项目代码可参考 MIT；其中天气数据仍是 DialogFlow 版权 | 未复制例句 |
| NLU 数据集索引 | https://github.com/sz128/NLU_datasets_with_task_oriented_dialogue | SMP2017 规模 train 2299 / dev 770 / test 666、31 个意图，以及 SMP2019 | 索引片段。论文 https://arxiv.org/abs/1709.10217 未全文打开 |
| Nexdata 47811 句 | Hugging Face 卡片，未下载 | 不使用 | cc-by-nc-nd-4.0，不能改写后再分发，故 0 句 |

## 论文元数据

OpenAlex `GET https://api.openalex.org/works?search=RiSAWOZ Chinese dialogue weather&per_page=3`，无需 API key。返回元数据约 29 条。置顶作品 W3098199128，DOI 10.18653/v1/2020.emnlp-main.67，开放获取 hybrid，PDF https://www.aclweb.org/anthology/2020.emnlp-main.67.pdf 。相关工作 X-RiSAWOZ：https://arxiv.org/abs/2306.17674 ，ACL Findings https://aclanthology.org/2023.findings-acl.174 。摘要未采信为语料，0 句复制。这次检索不能证明 RiSAWOZ 里有可直接借用的天气口语句。

## 语料 source_id 怎么读

| source_id | 含义 |
| --- | --- |
| S01–S02 | 上面的短引，以及围绕这些短引改写的带伞/灾情说法 |
| S03 | 只借用 DialogFlow 意图分类，句子是改写 |
| S04 | 多轮省略、缺地点、行政区冲突这些现象的改写。不是 CrossWOZ 原句 |
| S05 | 省略和指代现象的改写。不是 RiSAWOZ 原句 |
| S06 | 彩云技能文档里的降雨、带伞、空气质量能力，句子是改写 |
| S07、S12、S14 | 语音助手公开说明的片段族：现在多少度、开门、门票、汇率、新闻。句子是改写 |
| S15 | 合成边界：语序、重名、错字、不支持的日期、单字、已知缺口 |
| S16 | 合成的会话窗口、取消/继续/改查，以及硬负例 |

计数：251 条场景、263 轮。provenance 为 rewrite 121、synthetic 121、quote 9。与旧 88 条和 Grok 24 条的原句重叠为 0（封锁表 127 条唯一文本）。

## 访问限制

web 抓取曾对 arXiv、CrossWOZ raw、RiSAWOZ raw、SMP 仓库、彩云 raw 失败，随后用限时 curl 取回 README、LICENSE、摘要页和 SKILL。若干新闻页始终只有搜索片段。没有绕过登录。因此全文独立页面不到任务希望的 12 个；上表全文 8 个，另加 CrossWOZ LICENSE 与 OpenAlex 元数据。不足部分用摘要页如实列出，没有用想象来源填数。
