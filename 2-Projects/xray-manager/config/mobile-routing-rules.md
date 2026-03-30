# v2rayNG 路由规则配置

## 导入步骤

### 第一步：导入节点
1. 复制 mobile-links.txt 全部内容
2. v2rayNG → + → 从剪贴板导入
3. 30 个节点全部导入

### 第二步：配置路由规则
v2rayNG → 左上角 ☰ → 路由设置 → 自定义规则

#### 代理域名（Proxy domain）
粘贴以下内容：
```
domain:anthropic.com
domain:claude.ai
domain:claude.com
domain:openai.com
domain:chatgpt.com
domain:grok.com
domain:github.com
domain:googleapis.com
domain:google.com
domain:youtube.com
domain:twitter.com
domain:x.com
domain:facebook.com
domain:instagram.com
domain:telegram.org
domain:t.me
domain:netflix.com
domain:spotify.com
domain:reddit.com
domain:discord.com
domain:whatsapp.com
domain:wikipedia.org
```

#### 直连域名（Direct domain）
粘贴以下内容：
```
domain:hahaxiong.cc
domain:aliyun.com
domain:taobao.com
domain:tmall.com
domain:alipay.com
domain:feishu.cn
domain:bytedance.com
domain:douyin.com
domain:baidu.com
domain:qq.com
domain:wechat.com
domain:jd.com
domain:bilibili.com
domain:zhihu.com
geosite:cn
```

#### 直连 IP（Direct IP）
```
geoip:cn
geoip:private
```

#### 屏蔽（Block）
```
udp:443
```

## 注意事项
- v2rayNG 的路由规则**不支持 balancer**，所以不能自动在多节点间负载均衡
- 替代方案：手动选择节点，或使用「测速排序」功能选最快的
