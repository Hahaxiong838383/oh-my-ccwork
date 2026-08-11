#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

const EXPECTED = {
  manifestVersion: '1.2.0',
  releaseType: 'P1-SI-F-shadow-candidate-gated',
  candidateOntologySchema: '3.7.0',
  candidateOntologyHash: 'c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860',
  sourceRegistryCandidateHash: '0ce4022adcfc177ced670a8d7fd2e4b4e119c2fc1bc5c19cabefb3223c010eae',
  requiredGate: 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH',
  p003ReviewGateRequired: true,
  reviewerRoleAccessGateRequired: true,
  goal7AcceptanceGateRequired: true,
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => digest.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(digest.digest('hex')))
  })
}

const [manifestFile, sourceArchive, imageArchive] = process.argv.slice(2)
if (!manifestFile || !sourceArchive || !imageArchive) {
  throw new Error('manifest, source archive and image archive are required')
}

const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'))
const errors = []
for (const [key, expected] of Object.entries(EXPECTED)) {
  if (manifest[key] !== expected) errors.push(`${key} mismatch`)
}
if (!/^[a-f0-9]{40}$/.test(String(manifest.sourceCommit || ''))) errors.push('sourceCommit invalid')
if (!/^sha256:[a-f0-9]{64}$/.test(String(manifest.collectorImageId || ''))) errors.push('collectorImageId invalid')
if (!/^[a-f0-9]{64}$/.test(String(manifest.sourceArchiveSha256 || ''))) errors.push('sourceArchiveSha256 invalid')
if (!/^[a-f0-9]{64}$/.test(String(manifest.collectorImageArchiveSha256 || ''))) errors.push('collectorImageArchiveSha256 invalid')
if (!Number.isFinite(Date.parse(manifest.createdAt))) errors.push('createdAt invalid')
if (manifest.publish !== false) errors.push('publish must remain false')
if (manifest.productionDeploymentAuthorized !== false) errors.push('productionDeploymentAuthorized must remain false')

const sourceArchiveSha256 = await sha256(sourceArchive)
const collectorImageArchiveSha256 = await sha256(imageArchive)
if (sourceArchiveSha256 !== manifest.sourceArchiveSha256) errors.push('source archive hash mismatch')
if (collectorImageArchiveSha256 !== manifest.collectorImageArchiveSha256) errors.push('collector image archive hash mismatch')
if (errors.length > 0) throw new Error(`invalid strategic intelligence release manifest: ${errors.join('; ')}`)

process.stdout.write(`${JSON.stringify({
  ok: true,
  sourceCommit: manifest.sourceCommit,
  collectorImageId: manifest.collectorImageId,
  sourceArchiveSha256,
  collectorImageArchiveSha256,
  publish: false,
  productionDeploymentAuthorized: false,
  requiredGate: manifest.requiredGate,
  p003ReviewGateRequired: true,
  reviewerRoleAccessGateRequired: true,
  goal7AcceptanceGateRequired: true,
}, null, 2)}\n`)
