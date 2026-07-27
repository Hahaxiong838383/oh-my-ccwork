// esbuild 单文件产物:dist/v1.js(IIFE,window.JavisVoice)。
// Apache-2.0 合规:banner 指向 THIRD_PARTY_NOTICES(品牌白标,声明保留——合规不冲突)。
import { build } from "esbuild";
import { writeFileSync } from "node:fs";

const banner = `/*! JavisVoice SDK v1 — proprietary glue layer.
 * Contains third-party components under Apache License 2.0 (livekit-client).
 * Third-party notices: served alongside as THIRD_PARTY_NOTICES.txt */`;

await build({
  entryPoints: ["src/index.js"],
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "JavisVoice",
  target: ["es2020"],
  outfile: "dist/v1.js",
  banner: { js: banner },
  logLevel: "info",
});

writeFileSync(
  "dist/THIRD_PARTY_NOTICES.txt",
  `JavisVoice SDK third-party notices

This bundle contains the following third-party software:

livekit-client (https://github.com/livekit/client-sdk-js)
Copyright LiveKit, Inc.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
`
);
console.log("build done: dist/v1.js + THIRD_PARTY_NOTICES.txt");
