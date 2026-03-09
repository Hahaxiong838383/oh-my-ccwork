/**
 * EvoMap 集成模块
 *
 * 连接 EvoMap 协作进化市场，注册节点并获取绑定链接
 */

import crypto from "crypto";
import { fetchWithRetry } from "./http-retry.js";

// EvoMap Hub URL
const HUB_URL = "https://evomap.ai";

/**
 * 生成 sender_id（节点身份）
 */
function generateSenderId(): string {
  return "node_" + crypto.randomBytes(4).toString("hex");
}

/**
 * 生成 message_id
 */
function generateMessageId(): string {
  return "msg_" + Date.now() + "_" + crypto.randomBytes(2).toString("hex");
}

/**
 * 构建协议信封
 */
function buildEnvelope(messageType: string, senderId: string, payload: Record<string, any>): any {
  return {
    protocol: "gep-a2a",
    protocol_version: "1.0.0",
    message_type: messageType,
    message_id: generateMessageId(),
    sender_id: senderId,
    timestamp: new Date().toISOString(),
    payload,
  };
}

/**
 * 发送 A2A 协议请求
 */
async function sendA2ARequest(endpoint: string, body: any): Promise<any> {
  const response = await fetchWithRetry(`${HUB_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, { maxRetries: 3, timeoutMs: 15_000 });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  return response.json();
}

/**
 * 注册节点并获取绑定链接
 */
export async function registerNode(envFingerprint?: { platform: string; arch: string }): Promise<{
  senderId: string;
  claimCode: string;
  claimUrl: string;
}> {
  const senderId = generateSenderId();

  const envelope = buildEnvelope("hello", senderId, {
    capabilities: {},
    gene_count: 0,
    capsule_count: 0,
    env_fingerprint: envFingerprint || {
      platform: process.platform || "darwin",
      arch: process.arch || "x64",
    },
  });

  console.log(`[EvoMap] 注册节点: ${senderId}`);

  const response = await sendA2ARequest("/a2a/hello", envelope);

  if (response.status === "acknowledged" && response.claim_code) {
    const claimUrl = `https://evomap.ai/claim/${response.claim_code}`;
    console.log(`[EvoMap] ✓ 注册成功, 绑定码: ${response.claim_code}`);
    return {
      senderId,
      claimCode: response.claim_code,
      claimUrl,
    };
  }

  throw new Error(`注册失败: ${JSON.stringify(response)}`);
}

/**
 * 获取指定资产详情
 */
export async function fetchAsset(senderId: string, assetId: string): Promise<any> {
  const envelope = buildEnvelope("fetch", senderId, {
    asset_id: assetId,
  });

  const response = await sendA2ARequest("/a2a/fetch", envelope);
  return response;
}

/**
 * 获取可用任务
 */
export async function fetchTasks(senderId: string): Promise<any[]> {
  const envelope = buildEnvelope("fetch", senderId, {
    asset_type: "Capsule",
    include_tasks: true,
  });

  const response = await sendA2ARequest("/a2a/fetch", envelope);
  return response.tasks || [];
}

/**
 * 发布 Gene + Capsule 包
 */
export async function publishBundle(senderId: string, assets: any[]): Promise<any> {
  const envelope = buildEnvelope("publish", senderId, {
    assets,
  });

  return sendA2ARequest("/a2a/publish", envelope);
}

// 单独运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  registerNode()
    .then((result) => {
      console.log("\n=== EvoMap 节点注册成功 ===");
      console.log(`节点 ID: ${result.senderId}`);
      console.log(`绑定链接: ${result.claimUrl}`);
      console.log("\n请在 24 小时内打开链接绑定到你的账户");
    })
    .catch((err) => {
      console.error("注册失败:", err.message);
      process.exit(1);
    });
}
