import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const TOOL_URL = process.env.AI_OPS_TOOL_RUNNER_URL || "http://ops-tool-runner:8091/tool";
const INTERNAL_TOKEN = process.env.AI_OPS_INTERNAL_TOKEN || "";
const WORKFLOW = "readonly_safe";
const ALLOWED_TOOL_NAMES = ["aiops_read", "aiops_grep", "aiops_find", "aiops_ls"] as const;
const ALLOWED_TOOL_SET = new Set<string>(ALLOWED_TOOL_NAMES);

type ToolPayload = {
	tool: "read" | "grep" | "find" | "ls";
	project: string;
	params: Record<string, unknown>;
};

async function callRunner(payload: ToolPayload, signal?: AbortSignal) {
	if (!INTERNAL_TOKEN) {
		return { ok: false, error: "internal_auth_unavailable" };
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const response = await fetch(TOOL_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-aiops-internal-token": INTERNAL_TOKEN,
			},
			body: JSON.stringify({
				taskId: process.env.AI_OPS_BRAIN_TASK_ID || "interactive",
				project: process.env.AI_OPS_BRAIN_PROJECT || payload.project,
				workflow: WORKFLOW,
				tool: payload.tool,
				params: payload.params,
			}),
			signal: controller.signal,
		});
		const data = await response.json().catch(() => ({ ok: false, error: "invalid_runner_response" }));
		if (!response.ok || !data.ok) {
			return { ok: false, error: data.error || "policy_denied", reason: data.reason, recordId: data.recordId };
		}
		return data;
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.name : "runner_unavailable" };
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

function toolResult(result: unknown) {
	const payload = result as { ok?: boolean };
	return {
		content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
		details: result,
		isError: !payload?.ok,
	};
}

async function enforceReadonlySafeToolset(pi: ExtensionAPI) {
	await pi.setActiveTools([...ALLOWED_TOOL_NAMES]);
	const active = new Set(pi.getActiveTools());
	if (active.size !== ALLOWED_TOOL_NAMES.length || ALLOWED_TOOL_NAMES.some(name => !active.has(name))) {
		throw new Error("readonly_safe_toolset_unavailable");
	}
}

export default function readonlySafeExtension(pi: ExtensionAPI) {
	const project = pi.zod.string().min(1).max(80).describe("已登记的 AI Ops 项目 ID，例如 chenchuan-site、MyJavis");
	const path = pi.zod.string().min(1).max(512).default(".").describe("项目只读快照内的相对路径，禁止绝对路径和 ..");

	pi.registerTool({
		name: "aiops_read",
		label: "AI Ops Safe Read",
		description: "通过 readonly_safe 策略门读取已登记项目快照中的文本文件。不能读取本机、secret、SSH、Docker 或生产文件。",
		approval: "read",
		loadMode: "essential",
		parameters: pi.zod.object({
			project,
			path,
			startLine: pi.zod.number().int().min(1).max(1000000).default(1),
			lineCount: pi.zod.number().int().min(1).max(240).default(160),
		}),
		async execute(_toolCallId, params, signal) {
			return toolResult(await callRunner({ tool: "read", project: params.project, params }, signal));
		},
	});

	pi.registerTool({
		name: "aiops_grep",
		label: "AI Ops Safe Grep",
		description: "在已登记项目的只读快照中做受限文本搜索；查询和结果均有长度、文件数与敏感路径限制。",
		approval: "read",
		loadMode: "essential",
		parameters: pi.zod.object({
			project,
			path,
			query: pi.zod.string().min(1).max(160),
			caseSensitive: pi.zod.boolean().default(false),
		}),
		async execute(_toolCallId, params, signal) {
			return toolResult(await callRunner({ tool: "grep", project: params.project, params }, signal));
		},
	});

	pi.registerTool({
		name: "aiops_find",
		label: "AI Ops Safe Find",
		description: "按 glob 模式列出已登记项目只读快照中的文件；不跟随软链接，不允许跨项目。",
		approval: "read",
		loadMode: "essential",
		parameters: pi.zod.object({
			project,
			path,
			pattern: pi.zod.string().min(1).max(160).default("*"),
		}),
		async execute(_toolCallId, params, signal) {
			return toolResult(await callRunner({ tool: "find", project: params.project, params }, signal));
		},
	});

	pi.registerTool({
		name: "aiops_ls",
		label: "AI Ops Safe List",
		description: "列出已登记项目只读快照目录；隐藏敏感路径和软链接。",
		approval: "read",
		loadMode: "essential",
		parameters: pi.zod.object({ project, path }),
		async execute(_toolCallId, params, signal) {
			return toolResult(await callRunner({ tool: "ls", project: params.project, params }, signal));
		},
	});

	pi.on("session_start", async () => {
		await enforceReadonlySafeToolset(pi);
	});

	pi.on("before_agent_start", async () => {
		await enforceReadonlySafeToolset(pi);
	});

	pi.on("tool_call", async event => {
		if (!ALLOWED_TOOL_SET.has(event.toolName)) {
			return { block: true, reason: "readonly_safe blocks tools outside the AI Ops policy bridge" };
		}
	});
}
