/**
 * Cloudflare DNS Manager
 *
 * 自动管理 cli.hahaxiong.top 的 CNAME 记录
 * 当 tunnel URL 变化时（重启），自动更新 DNS 指向
 *
 * 用途：
 * - 你自己：cli.hahaxiong.top → 你的 macmini
 * - 朋友：friend.cli.hahaxiong.top → 朋友的 macbook
 */

import https from "https";

interface DnsConfig {
  apiToken: string;
  zoneId: string;
  domain: string;      // e.g. "cli.hahaxiong.top"
  subdomain?: string;  // e.g. "friend-name" → friend-name.cli.hahaxiong.top
}

function getFullDomain(config: DnsConfig): string {
  return config.subdomain
    ? `${config.subdomain}.${config.domain}`
    : config.domain;
}

function cfRequest(
  method: string,
  path: string,
  apiToken: string,
  body?: any
): Promise<any> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname: "api.cloudflare.com",
      path,
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * 更新 DNS CNAME 记录指向 tunnel URL
 *
 * @param tunnelUrl - cloudflare tunnel URL (e.g. https://xxx.trycloudflare.com)
 * @param config - Cloudflare DNS 配置
 * @returns true if updated successfully
 */
export async function updateDnsRecord(
  tunnelUrl: string,
  config: DnsConfig
): Promise<boolean> {
  if (!config.apiToken || !config.zoneId || !config.domain) {
    return false;
  }

  const fullDomain = getFullDomain(config);
  // 从 tunnel URL 提取域名部分（去掉 https://）
  const tunnelDomain = tunnelUrl.replace(/^https?:\/\//, "");

  try {
    // 查找现有记录
    const listResult = await cfRequest(
      "GET",
      `/client/v4/zones/${config.zoneId}/dns_records?type=CNAME&name=${fullDomain}`,
      config.apiToken
    );

    const existing = listResult.result?.[0];

    if (existing) {
      // 更新现有记录
      const updateResult = await cfRequest(
        "PUT",
        `/client/v4/zones/${config.zoneId}/dns_records/${existing.id}`,
        config.apiToken,
        { type: "CNAME", name: fullDomain, content: tunnelDomain, proxied: true }
      );
      if (updateResult.success) {
        console.log(`[CF-DNS] 已更新: ${fullDomain} → ${tunnelDomain}`);
        return true;
      }
      console.error("[CF-DNS] 更新失败:", updateResult.errors);
      return false;
    } else {
      // 创建新记录
      const createResult = await cfRequest(
        "POST",
        `/client/v4/zones/${config.zoneId}/dns_records`,
        config.apiToken,
        { type: "CNAME", name: fullDomain, content: tunnelDomain, proxied: true, ttl: 1 }
      );
      if (createResult.success) {
        console.log(`[CF-DNS] 已创建: ${fullDomain} → ${tunnelDomain}`);
        return true;
      }
      console.error("[CF-DNS] 创建失败:", createResult.errors);
      return false;
    }
  } catch (err) {
    console.error("[CF-DNS] 操作失败:", (err as Error).message);
    return false;
  }
}

/**
 * 从环境变量加载 DNS 配置
 */
export function loadDnsConfig(): DnsConfig | null {
  const apiToken = process.env.CF_API_TOKEN;
  const zoneId = process.env.CF_ZONE_ID;
  const domain = process.env.CF_DOMAIN;

  if (!apiToken || !zoneId || !domain) {
    return null;
  }

  return {
    apiToken,
    zoneId,
    domain,
    subdomain: process.env.CF_SUBDOMAIN || undefined,
  };
}
