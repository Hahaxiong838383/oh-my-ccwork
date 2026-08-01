#!/usr/bin/env node
const fs = require("node:fs");
const { chromium } = require("playwright");

const baseUrl = (process.env.AI_OPS_BASE || "https://ops.hahaxiong.top").replace(/\/$/, "");
const authFile = process.env.AI_OPS_BROWSER_AUTH_FILE;
const outputFile = process.env.AI_OPS_BROWSER_OUTPUT || "/tmp/aiops-browser-acceptance.json";

if (!authFile) {
    throw new Error("AI_OPS_BROWSER_AUTH_FILE is required");
}

const credentials = JSON.parse(fs.readFileSync(authFile, "utf8"));
const allPageSpecs = [
    { path: "/", title: /AI Ops|运维/i, minText: 80 },
    { path: "/vibe/", title: /Vibe Coding/i, minText: 200 },
    { path: "/vibe/tasks", title: /任务|AI Ops/i, minText: 100 },
    { path: "/vibe/todos", title: /待办|AI Ops/i, minText: 100 },
    { path: "/vibe/assets", title: /资产|AI Ops/i, minText: 100 },
    { path: "/vibe/ops-runtime", title: /Ops Tool Runtime/i, minText: 100 },
    { path: "/kuma/", title: /Uptime Kuma/i, minText: 20 },
    { path: "/n8n/", title: /n8n/i, minText: 20 },
    { path: "/netdata/", title: /Netdata/i, minText: 20 },
    { path: "/dockge/", title: /Dockge/i, minText: 20 },
    { path: "/terminal/", title: /ttyd|Terminal|vibe-shell/i, minText: 0 },
];
const requestedPaths = new Set((process.env.AI_OPS_BROWSER_PATHS || "").split(",").map((item) => item.trim()).filter(Boolean));
const pageSpecs = requestedPaths.size ? allPageSpecs.filter((item) => requestedPaths.has(item.path)) : allPageSpecs;

async function inspectPage(page, spec) {
    const consoleErrors = [];
    const pageErrors = [];
    const resourceFailures = [];
    const responseErrors = [];
    const onConsole = (message) => {
        if (message.type() === "error") {
            consoleErrors.push(message.text());
        }
    };
    const onPageError = (error) => pageErrors.push(String(error && error.message || error));
    const onRequestFailed = (request) => {
        const resourceType = request.resourceType();
        if (!["document", "script", "stylesheet"].includes(resourceType)) {
            return;
        }
        if (request.url().startsWith(baseUrl)) {
            resourceFailures.push(`${resourceType}:${request.url()}:${request.failure()?.errorText || "failed"}`);
        }
    };
    const onResponse = (response) => {
        if (response.status() >= 400 && response.url().startsWith(baseUrl)) {
            responseErrors.push(`${response.status()}:${response.request().resourceType()}:${response.url()}`);
        }
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("requestfailed", onRequestFailed);
    page.on("response", onResponse);
    try {
        const response = await page.goto(baseUrl + spec.path, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(spec.path === "/netdata/" || spec.path === "/n8n/" ? 7000 : 4000);
        const title = await page.title();
        const text = await page.locator("body").innerText().catch(() => "");
        const result = {
            path: spec.path,
            status: response?.status() || 0,
            url: page.url(),
            title,
            bodyChars: text.trim().length,
            consoleErrors,
            pageErrors,
            resourceFailures,
            responseErrors,
        };
        if (spec.path === "/vibe/") {
            result.terminalFrameSrc = await page.locator("#terminalFrame").getAttribute("src");
            if (result.terminalFrameSrc !== "about:blank") {
                throw new Error(`/vibe/ started terminal eagerly: ${result.terminalFrameSrc}`);
            }
        }
        if (!response || response.status() >= 400) {
            throw new Error(`${spec.path} returned ${result.status}`);
        }
        if (!spec.title.test(title)) {
            throw new Error(`${spec.path} unexpected title: ${title}`);
        }
        if (result.bodyChars < spec.minText) {
            throw new Error(`${spec.path} body too small: ${result.bodyChars}`);
        }
        if (consoleErrors.length || pageErrors.length || resourceFailures.length || responseErrors.length) {
            throw new Error(`${spec.path} browser errors: ${JSON.stringify({ consoleErrors, pageErrors, resourceFailures, responseErrors })}`);
        }
        return result;
    } finally {
        page.off("console", onConsole);
        page.off("pageerror", onPageError);
        page.off("requestfailed", onRequestFailed);
        page.off("response", onResponse);
    }
}

async function verifyRefreshAndAbort(page) {
    await page.goto(baseUrl + "/vibe/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.locator("#taskQuestion").fill("浏览器刷新与终止验收：依次读取 README.md、compose.yaml、caddy/Caddyfile，并在最后回答 BROWSER_TASK_SHOULD_ABORT。");
    await page.locator("#sendTaskBtn").click();
    await page.waitForFunction(() => Boolean(sessionStorage.getItem("aiopsActiveTaskId")), null, { timeout: 15000 });
    const taskId = await page.evaluate(() => sessionStorage.getItem("aiopsActiveTaskId"));
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForFunction((id) => document.querySelector("#taskStatus")?.textContent.includes(id), taskId, { timeout: 20000 });
    const restoredStatus = await page.locator("#taskStatus").innerText();
    const abortButton = page.locator("#abortTaskBtn");
    if (!(await abortButton.isEnabled())) {
        throw new Error(`task completed before browser abort: ${restoredStatus}`);
    }
    await abortButton.click();
    await page.waitForFunction(() => {
        const text = document.querySelector("#taskStatus")?.textContent || "";
        return text.includes("已终止") || text.includes("失败") || text.includes("完成");
    }, null, { timeout: 45000 });
    const finalStatus = await page.locator("#taskStatus").innerText();
    if (!finalStatus.includes("已终止")) {
        throw new Error(`browser abort did not reach aborted state: ${finalStatus}`);
    }
    return { taskId, restoredStatus, finalStatus };
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        httpCredentials: credentials,
        ignoreHTTPSErrors: false,
        viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const output = { generatedAt: new Date().toISOString(), pages: [], taskLifecycle: null };
    try {
        for (const spec of pageSpecs) {
            output.pages.push(await inspectPage(page, spec));
            if (spec.path === "/terminal/") {
                await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 10000 });
                await page.waitForTimeout(8000);
            }
        }
        if (!requestedPaths.size || requestedPaths.has("/vibe/")) {
            output.taskLifecycle = await verifyRefreshAndAbort(page);
        }
        fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), { mode: 0o600 });
        process.stdout.write(`OK browser acceptance ${output.pages.length} pages\n`);
    } finally {
        await context.close();
        await browser.close();
    }
})().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
});
