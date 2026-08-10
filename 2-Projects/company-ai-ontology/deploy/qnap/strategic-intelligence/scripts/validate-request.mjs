#!/usr/bin/env node

import fs from 'node:fs/promises'

const file = process.argv[2]
if (!file) throw new Error('request file is required')
const request = JSON.parse(await fs.readFile(file, 'utf8'))
if (request.requestVersion !== '1.0.0') throw new Error('unsupported request version')
if (!/^[a-z0-9][a-z0-9-]{4,120}$/.test(request.requestKey || '')) throw new Error('invalid request key')
if (request.jobType !== 'collector') throw new Error('only collector jobs are allowed')
if (request.publish !== false) throw new Error('publish must be false')
const requiredForbidden = ['formal_p2', 'employee_delivery', 'erp_writeback', 'social_writeback', 'causal_activation']
for (const value of requiredForbidden) {
  if (!request.forbiddenSideEffects?.includes(value)) throw new Error(`missing forbidden side effect ${value}`)
}
process.stdout.write(`${request.requestKey}\n`)
