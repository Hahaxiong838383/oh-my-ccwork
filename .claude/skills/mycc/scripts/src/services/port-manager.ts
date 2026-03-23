/**
 * 端口管理器 — 端口注册表 + 冲突自动换端口 + /ports API 一览
 *
 * 核心能力：
 * 1. 维护已知服务端口注册表（静态 + 动态探测）
 * 2. 启动时检测端口冲突，自动换到冷门端口
 * 3. 提供 getPortsSnapshot() 供 HTTP API 调用
 */

import { execSync } from "child_process";
import chalk from "chalk";

// ============ 已知服务端口注册表 ============

export interface PortEntry {
  port: number;
  service: string;
  owner: "mycc" | "cc-remote" | "system" | "external" | "unknown";
  status: "listening" | "free" | "conflict";
  pid?: number;
  process?: string;
}

/** mycc 生态已知端口（静态声明） */
const KNOWN_PORTS: Omit<PortEntry, "status" | "pid" | "process">[] = [
  { port: 18080, service: "mycc 后端", owner: "mycc" },
  { port: 19001, service: "ttyd 终端 #1", owner: "cc-remote" },
  { port: 19002, service: "ttyd 终端 #2", owner: "cc-remote" },
  { port: 19003, service: "ttyd 终端 #3", owner: "cc-remote" },
  { port: 19010, service: "ttyd 终端 #4", owner: "cc-remote" },
  { port: 19100, service: "Python 服务 #1", owner: "external" },
  { port: 19200, service: "Python 服务 #2", owner: "external" },
  { port: 19443, service: "Caddy HTTPS", owner: "system" },
  { port: 2019, service: "Caddy Admin", owner: "system" },
  { port: 8899, service: "Local LLM", owner: "external" },
  { port: 10808, service: "xray SOCKS", owner: "system" },
  { port: 10812, service: "xray HTTP", owner: "system" },
];

/** 冷门端口池：高位、不常用、不与常见服务冲突 */
const COLD_PORTS = [
  28080, 28180, 28280, 28380, 28480,
  31080, 31180, 31280, 31380, 31480,
  37080, 37180, 37280, 37380, 37480,
  41080, 41180, 41280, 41380, 41480,
  45080, 45180, 45280, 45380, 45480,
];

// ============ 端口探测 ============

interface ListeningPort {
  port: number;
  pid: number;
  process: string;
}

/**
 * 探测当前所有 TCP 监听端口
 */
function scanListeningPorts(): ListeningPort[] {
  try {
    const output = execSync(
      'lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null',
      { encoding: "utf-8", timeout: 5000 }
    );
    const results: ListeningPort[] = [];
    for (const line of output.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;
      const processName = parts[0];
      const pid = parseInt(parts[1], 10);
      const addr = parts[8];
      // 提取端口号：格式 *:18080 或 127.0.0.1:8899
      const portMatch = addr.match(/:(\d+)$/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1], 10);
      if (isNaN(port)) continue;
      // 去重（同端口不同地址只记一次）
      if (!results.some(r => r.port === port)) {
        results.push({ port, pid, process: processName });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * 检查单个端口是否被占用
 */
export function isPortInUse(port: number): { inUse: boolean; pid?: number; process?: string } {
  try {
    const output = execSync(
      `lsof -iTCP:${port} -sTCP:LISTEN -P -n 2>/dev/null`,
      { encoding: "utf-8", timeout: 3000 }
    );
    const lines = output.trim().split("\n").slice(1);
    if (lines.length === 0) return { inUse: false };
    const parts = lines[0].split(/\s+/);
    return { inUse: true, pid: parseInt(parts[1], 10), process: parts[0] };
  } catch {
    return { inUse: false };
  }
}

// ============ 端口快照 ============

/**
 * 生成当前端口全景快照
 */
export function getPortsSnapshot(): PortEntry[] {
  const listening = scanListeningPorts();
  const result: PortEntry[] = [];

  // 1. 先处理已知端口
  const knownPortNums = new Set(KNOWN_PORTS.map(k => k.port));
  for (const known of KNOWN_PORTS) {
    const live = listening.find(l => l.port === known.port);
    result.push({
      ...known,
      status: live ? "listening" : "free",
      pid: live?.pid,
      process: live?.process,
    });
  }

  // 2. 补充未知的监听端口（不在注册表里的）
  for (const live of listening) {
    if (knownPortNums.has(live.port)) continue;
    result.push({
      port: live.port,
      service: `${live.process}(未注册)`,
      owner: "unknown",
      status: "listening",
      pid: live.pid,
      process: live.process,
    });
  }

  // 按端口号排序
  result.sort((a, b) => a.port - b.port);
  return result;
}

// ============ 自动换端口 ============

/**
 * 为指定服务寻找可用端口
 *
 * 策略：
 * 1. 先尝试首选端口
 * 2. 如果被占用，从冷门端口池中找第一个可用的
 * 3. 都不行就随机选一个高位端口
 */
export function findAvailablePort(preferredPort: number): { port: number; changed: boolean } {
  const check = isPortInUse(preferredPort);
  if (!check.inUse) {
    return { port: preferredPort, changed: false };
  }

  console.log(chalk.yellow(
    `⚠️ 端口 ${preferredPort} 已被 ${check.process}(PID:${check.pid}) 占用，自动寻找替代端口...`
  ));

  // 遍历冷门端口池
  for (const coldPort of COLD_PORTS) {
    if (!isPortInUse(coldPort).inUse) {
      console.log(chalk.green(`✓ 自动切换到端口 ${coldPort}`));
      return { port: coldPort, changed: true };
    }
  }

  // 冷门端口池耗尽（极端情况），随机试
  for (let i = 0; i < 10; i++) {
    const randomPort = 30000 + Math.floor(Math.random() * 30000);
    if (!isPortInUse(randomPort).inUse) {
      console.log(chalk.green(`✓ 随机分配到端口 ${randomPort}`));
      return { port: randomPort, changed: true };
    }
  }

  // 实在找不到（不太可能）
  throw new Error("无法找到可用端口，所有候选端口均被占用");
}

/**
 * 打印端口一览表（终端美化输出）
 */
export function printPortsTable(): void {
  const snapshot = getPortsSnapshot();
  const listening = snapshot.filter(s => s.status === "listening");

  console.log(chalk.cyan("\n📡 端口一览\n"));
  console.log(chalk.gray("  端口    服务                    所属       PID      进程"));
  console.log(chalk.gray("  ─────  ──────────────────────  ────────  ───────  ──────────"));

  for (const entry of listening) {
    const portStr = String(entry.port).padEnd(6);
    const serviceStr = entry.service.padEnd(22);
    const ownerStr = entry.owner.padEnd(10);
    const pidStr = entry.pid ? String(entry.pid).padEnd(8) : "—".padEnd(8);
    const procStr = entry.process || "—";

    const color = entry.owner === "mycc" ? chalk.green
      : entry.owner === "cc-remote" ? chalk.cyan
      : entry.owner === "system" ? chalk.gray
      : entry.owner === "unknown" ? chalk.yellow
      : chalk.white;

    console.log(color(`  ${portStr} ${serviceStr} ${ownerStr} ${pidStr} ${procStr}`));
  }
  console.log();
}
