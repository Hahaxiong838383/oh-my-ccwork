import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { patchDockgeDist } from "./patch-subpath.mjs";

function fixture() {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockge-subpath-"));
    fs.mkdirSync(path.join(distDir, "assets"));
    fs.writeFileSync(path.join(distDir, "index.html"), `
        <link rel="apple-touch-icon" href="/apple-touch-icon.png">
        <link rel="icon" href="/icon.svg">
        <link rel="manifest" href="/manifest.json">
        <script type="module" src="/assets/index-test.js"></script>
        <link rel="stylesheet" href="/assets/index-test.css">
    `);
    fs.writeFileSync(path.join(distDir, "index.html.br"), "stale");
    fs.writeFileSync(path.join(distDir, "index.html.gz"), "stale");
    fs.writeFileSync(
        path.join(distDir, "assets", "index-test.js"),
        'const router=z$({linkActiveClass:"active",history:m$(),routes:routes});const app={initSocketIO(e=!1){let t=location.host;bi=wu(t);let r=1;bi.on("connect",()=>{})}};',
    );
    fs.writeFileSync(path.join(distDir, "assets", "index-test.js.br"), "stale");
    fs.writeFileSync(path.join(distDir, "assets", "index-test.js.gz"), "stale");
    return distDir;
}

const distDir = fixture();
try {
    const first = patchDockgeDist(distDir, "/dockge");
    assert.equal(first.entryFile, "index-test.js");
    const indexHtml = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
    const entrySource = fs.readFileSync(path.join(distDir, "assets", "index-test.js"), "utf8");
    assert.match(indexHtml, /src="\/dockge\/assets\/index-test\.js"/);
    assert.match(indexHtml, /href="\/dockge\/assets\/index-test\.css"/);
    assert.match(indexHtml, /href="\/dockge\/manifest\.json"/);
    assert.match(entrySource, /history:m\$\("\/dockge\/"\),routes:/);
    assert.match(entrySource, /bi=wu\(t,\{path:"\/dockge\/socket\.io"\}\);let/);
    assert.equal(fs.existsSync(path.join(distDir, "index.html.gz")), false);
    assert.equal(fs.existsSync(path.join(distDir, "assets", "index-test.js.br")), false);

    patchDockgeDist(distDir, "/dockge");
    assert.equal(fs.readFileSync(path.join(distDir, "index.html"), "utf8"), indexHtml);
    assert.equal(fs.readFileSync(path.join(distDir, "assets", "index-test.js"), "utf8"), entrySource);
    assert.throws(() => patchDockgeDist(distDir, "/dockge/../escape"), /invalid Dockge base path/);
} finally {
    fs.rmSync(distDir, { recursive: true, force: true });
}

process.stdout.write("OK dockge subpath patch\n");
