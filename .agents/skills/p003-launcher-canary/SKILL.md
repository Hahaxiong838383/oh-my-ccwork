---
name: p003-launcher-canary
description: Safely reverse, patch, rebuild, sign, install, validate, and roll back the P003 EyesCare system Launcher on RK3562. Use for FuturusLauncher.apk, apktool, jadx, smali hooks, classes3.dex injection, system UID signing, ADB Canary, crash recovery, VAD/MyJavis hooks, or P003 Godot Launcher deployment.
---

# P003 Launcher Canary

Use the versioned project skill as the single procedural source:

`/Users/fu-121/mycc/2-Projects/kidshub-ai---godot/skills/p003-launcher-canary/SKILL.md`

Then read its referenced workflow and the repository document:

`/Users/fu-121/mycc/2-Projects/kidshub-ai---godot/docs/LAUNCHER_APKTOOL_S2_PLAN.md`

Do not copy the full workflow into this entry point; keep one versioned source in the P003 code repository.

Current verified S2-B1 READY baseline: `1.2.2-canary.28 (40)`, `135751278` bytes, APK SHA256 `877f7140b5e7e1d3ec05605b948e4cd81124f1d5d10d38d9697585fcb252bd43`, Android JVM `72/72`, Game Rust `7/7` and six Launcher services. Production Worker is `66214a31ee561b9f726d118cc05d46b52de303ef`; Session API is `ab9f30a02bcff0c2ff14e98fa2fc1a375a5d069c`. The v40 input-ready matrix passed three ready-immediate turns and three “嗯/咳嗽” non-interruption turns; one late “停” sample was correctly marked `INCONCLUSIVE`, so the input-ready default remains off. Product credentials live in Android Keystore; bootstrap and ADB reverse `38541/38542` must remain `0`. Before any install or voice diagnosis, run `REQUIRE_SESSION_EVIDENCE=1 /Users/fu-121/mycc/2-Projects/kidshub-ai---godot/scripts/verify_p003_product_voice_baseline.sh`. Resolve the HOME activity instead of assuming `.MainActivity`, restore both input-ready experiment flags to `0` after every run, and never use `pm clear`, uninstall, an older APK or a same-version different-SHA artifact. Online product interruption is Worker-ASR-owned; do not restore Android VAD fast-stop.
