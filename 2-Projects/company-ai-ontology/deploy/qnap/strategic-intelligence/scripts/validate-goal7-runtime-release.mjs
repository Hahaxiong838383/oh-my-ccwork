#!/usr/bin/env node

import { validateGoal7RuntimeRelease } from './goal7-runtime-release-lib.mjs'

const root = process.env.GOAL7_RUNTIME_EVIDENCE_ROOT || process.argv[2]
const sourceCommit = process.env.GOAL7_APPROVED_SOURCE_COMMIT || process.argv[3]
const hLiteSourceCommit = process.env.GOAL7_APPROVED_H_LITE_SOURCE_COMMIT || process.argv[4]
if (!root) throw new Error('Goal 7 runtime evidence root is required')
if (!sourceCommit || !hLiteSourceCommit) throw new Error('Goal 7 approved Ontology and H-Lite commits are required')

const result = await validateGoal7RuntimeRelease(root, { sourceCommit, hLiteSourceCommit })
process.stdout.write(`source_commit=${result.sourceCommit}\nh_lite_source_commit=${result.hLiteSourceCommit}\nh_lite_archive_sha256=${result.hLiteSourceArchiveSha256}\nchecksum_entry_count=${result.checksumEntryCount}\n`)
