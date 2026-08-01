import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function normalizeBasePath(value) {
    const trimmed = String(value || "").trim();
    if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(trimmed)) {
        throw new Error(`invalid Dockge base path: ${trimmed || "<empty>"}`);
    }
    const segments = trimmed.slice(1).split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) {
        throw new Error(`invalid Dockge base path: ${trimmed}`);
    }
    return trimmed;
}

function replaceExactlyOnce(source, pattern, replacement, label) {
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) {
        throw new Error(`${label}: expected exactly one match, got ${matches.length}`);
    }
    return source.replace(pattern, replacement);
}

function removeCompressedVariants(filePath) {
    for (const suffix of [".br", ".gz"]) {
        const compressedPath = `${filePath}${suffix}`;
        if (fs.existsSync(compressedPath)) {
            fs.rmSync(compressedPath);
        }
    }
}

export function patchDockgeDist(distDir, requestedBasePath) {
    const basePath = normalizeBasePath(requestedBasePath);
    const indexPath = path.join(distDir, "index.html");
    let indexHtml = fs.readFileSync(indexPath, "utf8");
    const entryMatch = indexHtml.match(/src="(?:\/[A-Za-z0-9._~-]+)*\/assets\/([^"/]+\.js)"/);
    if (!entryMatch) {
        throw new Error("Dockge entry bundle was not found in index.html");
    }
    const entryPath = path.join(distDir, "assets", entryMatch[1]);
    let entrySource = fs.readFileSync(entryPath, "utf8");

    if (!indexHtml.includes(`src="${basePath}/assets/`)) {
        const assetReferences = (indexHtml.match(/(?:src|href)="\/assets\//g) || []).length;
        if (assetReferences < 2) {
            throw new Error(`index assets: expected at least two root references, got ${assetReferences}`);
        }
        indexHtml = indexHtml.replace(/((?:src|href)=")\/assets\//g, `$1${basePath}/assets/`);
    }
    for (const fileName of ["apple-touch-icon.png", "icon.svg", "manifest.json"]) {
        const rootReference = `href="/${fileName}"`;
        const prefixedReference = `href="${basePath}/${fileName}"`;
        if (indexHtml.includes(rootReference)) {
            indexHtml = indexHtml.replace(rootReference, prefixedReference);
        } else if (!indexHtml.includes(prefixedReference)) {
            throw new Error(`index static asset not found: ${fileName}`);
        }
    }

    const escapedBasePath = basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const routerPatched = new RegExp(`history:[A-Za-z_$][A-Za-z0-9_$]*\\("${escapedBasePath}\\/"\\),routes:`).test(entrySource);
    if (!routerPatched) {
        entrySource = replaceExactlyOnce(
            entrySource,
            /history:([A-Za-z_$][A-Za-z0-9_$]*)\(\),routes:/g,
            `history:$1("${basePath}/"),routes:`,
            "Vue Router base",
        );
    }

    const socketPath = `${basePath}/socket.io`;
    if (!entrySource.includes(`path:"${socketPath}"`)) {
        const initStart = entrySource.indexOf("initSocketIO(");
        if (initStart < 0) {
            throw new Error("Socket.IO initializer was not found");
        }
        const initEnd = entrySource.indexOf('.on("connect"', initStart);
        if (initEnd < 0 || initEnd - initStart > 3000) {
            throw new Error("Socket.IO initializer boundary was not found");
        }
        const before = entrySource.slice(0, initStart);
        const initializer = entrySource.slice(initStart, initEnd);
        const after = entrySource.slice(initEnd);
        const patchedInitializer = replaceExactlyOnce(
            initializer,
            /([A-Za-z_$][A-Za-z0-9_$]*)=([A-Za-z_$][A-Za-z0-9_$]*)\(t\);let/g,
            `$1=$2(t,{path:"${socketPath}"});let`,
            "Socket.IO path",
        );
        entrySource = before + patchedInitializer + after;
    }

    fs.writeFileSync(indexPath, indexHtml);
    fs.writeFileSync(entryPath, entrySource);
    removeCompressedVariants(indexPath);
    removeCompressedVariants(entryPath);

    return {
        basePath,
        entryFile: path.basename(entryPath),
        indexPath,
        entryPath,
    };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
    const distDir = process.argv[2];
    const basePath = process.argv[3] || "/dockge";
    if (!distDir) {
        throw new Error("usage: patch-subpath.mjs <frontend-dist> [base-path]");
    }
    const result = patchDockgeDist(path.resolve(distDir), basePath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}
