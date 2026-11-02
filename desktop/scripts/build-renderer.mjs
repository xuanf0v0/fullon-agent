import { cp, mkdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontendDir = path.resolve(desktopDir, '..', 'frontend')
const source = path.join(frontendDir, 'dist')
const target = path.join(desktopDir, 'renderer')

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const build = spawnSync(pnpm, ['run', 'build'], {
  cwd: frontendDir,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
if (build.status !== 0) process.exit(build.status ?? 1)

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(source, target, { recursive: true })
console.log(`renderer copied to ${target}`)
