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
interface DnsConfig {
    apiToken: string;
    zoneId: string;
    domain: string;
    subdomain?: string;
}
/**
 * 更新 DNS CNAME 记录指向 tunnel URL
 *
 * @param tunnelUrl - cloudflare tunnel URL (e.g. https://xxx.trycloudflare.com)
 * @param config - Cloudflare DNS 配置
 * @returns true if updated successfully
 */
export declare function updateDnsRecord(tunnelUrl: string, config: DnsConfig): Promise<boolean>;
/**
 * 从环境变量加载 DNS 配置
 */
export declare function loadDnsConfig(): DnsConfig | null;
export {};
//# sourceMappingURL=cf-dns.d.ts.map