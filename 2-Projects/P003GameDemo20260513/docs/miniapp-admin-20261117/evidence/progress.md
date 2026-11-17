# SDD ledger — plan: 2-Projects/P003GameDemo20260513/docs/miniapp-admin-20261117/IMPLEMENTATION.md

Base: 53239abe320b1831c4101696f6243f09dd978efc. Active user goal approved implementation, regressions and acceptance.

## Preflight
| Tasks | Shared surface | Ruling |
|---|---|---|
| 1/2 | admin-data mount | Task2 owns file; root mounts Task1 router after Task2 delivery |
| 1/3 | API DTO | Task1 writes API.md early; stable envelope fixed in plan, Task3 maps fields |
| 2/3 | parent PATCH expected fields | exact names shared; Task3 owns both UI callers |
| 1 | query and auth | preserve parent contract; complete scope check includes grant |
| 2 | pairing cross-store | version CAS authoritative, cleanup alone insufficient |
| 3 | old admin vs standalone preview | implement actual Vue UI, no fixture/product mixing |
| 4 | production state drift | freeze/check source manifest, no whole DB restoration |

Ruling: user has authorized implementation under approved spec; do not ask plan approval again.
Ruling: existing linked worktree on task branch is appropriate; dependencies present, no installs.
Ruling: parallel implementers own disjoint files; higher-priority proactive collaboration favors parallelism; root serializes shared integration and commits.

Tasks 1/2/3 pending dispatch. Task4 root.

Tasks dispatched: /root/dashboard_api_impl (Task1), /root/dashboard_unbind_impl (Task2), /root/dashboard_ui_impl (Task3); root serial integration.
Task1 ownership extension: parent-conversations.ts shared non-JWT reader, authorized by root.
Production preflight: server relevant source matches old git baseline; admin HTML differs by 416 diff lines. UI agent instructed to preserve production source via 3-way merge. Private snapshot ~/.local/state/p003-miniapp-admin-20261117/production-source.
Old HEAD isolated baseline: pairing145/3fail (extra current DTO fields + stale recovery-switch expectations); SMS52/1fail (SIMPLE_SN_BINDING default auto-registration now200). These are pre-existing. Task2 handles pairing assertion correction with actual contract; root updates SMS to assert enabled200+owner/Brain and disabled404+no row. No production logic rolled back to old tests.
Initial mini008-dashboard16/16 passed. Full baseline RESULTS in task private baseline-tests.
Task1 query Ruling: preserve existing parent HTTP statuses and per-domain degradation; enforce complete binding/grant/role before/after guards in admin wrapper. This keeps compatibility and prevents stale admin disclosure.
Task2 ownership extension: binding helper is routes/profile.ts (sn-binding.ts does not exist).
Task2 delivered stable admin-data.ts ownership; root mounted miniappAdminRoute and set no-store before outer authentication.
Task3 preserves current production HTML features (weather preview, status cache, voice settings), then overlays dashboard.
Tasks1/2/3 delivered: admin13/13 integrated real parent router; unbind70/70; browser35 GET/3 isolated PATCH/0 pageerror.
Root integrated regression20 scripts passed; miniapp101 tests and typecheck passed.
Task1 review Important: missing Brain account reference uniqueness in authority fingerprint; original implementer assigned RED→GREEN, parent contract unchanged.
Task1 review fix1: account_uses omission ADDRESSED by original reviewer; admin14/14, parent contract preserved.
Task3 review fix1: device active semantics, fixture extra-write guard, portable runner and stable resize capture ADDRESSED; final40 GET/3 parent PATCH/0 status PATCH/0 pageerror; real401 regression permanent.
Root browser probe review: dependency/JSON/close failures all remove temporary token; three injected failures passed.
Whole-branch frozen677d519e review PASS, no Critical/open Important.
Candidate runtime: 19 suites Node22 passed; original ark-history writer gate rejects Node22 SQLite, unchanged analytics sources verified and actual analytics Node24 runtime11/11. Missing test schema restored from frozen commit and records32/32.
Release 2026-11-17 08:25:14: 10 files; idle0 after first transient room disappeared naturally; p003-voice restart7→8, other processes/environment/all bindings unchanged. No real unbind, no DB restore.
Actual public API DTOs and page GET pass, C274 history, usage null, records firstpage0, configured/effective uploadtrue, self-reportmini008. Final archive and push remaining.
