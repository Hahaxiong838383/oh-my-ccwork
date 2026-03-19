/**
 * CLI lP Patch（Agent Teams 死锁修复）
 *
 * CLI 2.1.63 的 lP 函数不检查 isIdle，导致 do-while 主循环死锁：
 * idle 的 teammate 被当成活跃 → 循环不退出 → inbox 轮询不执行 → 消息投递断裂
 *
 * ensurePatchedCli() 读取系统 CLI，注入 isIdle 检查，写到本地可写路径。
 * 若上游已修复或读取失败，回退到系统 CLI。
 */
/** CLI 原始 lP 函数（未 patch）*/
export declare const LP_ORIGINAL = "function lP(A){if(A.status!==\"running\"&&A.status!==\"pending\")return!1;if(\"isBackgrounded\"in A&&A.isBackgrounded===!1)return!1;return!0}";
/** CLI patched lP 函数（加了 isIdle 检查）*/
export declare const LP_PATCHED = "function lP(A){if(A.status!==\"running\"&&A.status!==\"pending\")return!1;if(\"isBackgrounded\"in A&&A.isBackgrounded===!1)return!1;if(A.isIdle)return!1;return!0}";
/**
 * 检查系统 CLI 是否需要 patch，如需要则写入 patchedPath。
 *
 * @param systemCliPath - 系统 CLI 的绝对路径
 * @param patchedPath   - patch 副本写入的目标路径
 * @returns 应使用的 CLI 路径（patched 副本或系统原路径）
 */
export declare function ensurePatchedCli(systemCliPath: string, patchedPath: string): string;
//# sourceMappingURL=cli-patch.d.ts.map