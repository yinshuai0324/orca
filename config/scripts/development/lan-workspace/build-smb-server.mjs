import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const source = fileURLToPath(new URL('./smb-server/', import.meta.url))
const cache = resolve(source, '../../../../../node_modules/.cache/orca-lan-smb')
const version = '1.27.4'
const downloads = {
  arm64: ['arm64', '91a44a2b8a716600ad94a4f143e156116620db8828086a6e3602291be9bd0bb4'],
  x64: ['amd64', '2b799377704ef12db39bd254995d5c348c9cc8d86562ca817724390e56c38f43']
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false
  )
}

async function goTool() {
  const download = Object.hasOwn(downloads, process.arch) && downloads[process.arch]
  if (!download || process.platform !== 'darwin') {
    throw new Error('The LAN SMB helper requires an Apple Silicon or Intel Mac.')
  }
  const [arch, checksum] = download
  const install = join(cache, `go${version}-${arch}`)
  const binary = join(install, 'bin', 'go')
  if (await exists(binary)) {
    return binary
  }
  const staging = await mkdtemp(join(cache, 'download-'))
  try {
    const archive = join(staging, 'go.tar.gz')
    const response = await fetch(`https://go.dev/dl/go${version}.darwin-${arch}.tar.gz`, {
      signal: AbortSignal.timeout(120_000)
    })
    if (!response.ok || !response.body) {
      throw new Error(`Go download failed (HTTP ${response.status}).`)
    }
    const hash = createHash('sha256')
    await pipeline(
      response.body,
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk)
          yield chunk
        }
      },
      createWriteStream(archive, { mode: 0o600 })
    )
    if (hash.digest('hex') !== checksum) {
      throw new Error('The LAN SMB build tool checksum did not match.')
    }
    await exec('/usr/bin/tar', ['-xzf', archive, '-C', staging], { timeout: 30_000 })
    await rename(join(staging, 'go'), install).catch(async (error) => {
      if (!(await exists(binary))) {
        throw error
      }
    })
    return binary
  } finally {
    await rm(staging, { force: true, recursive: true })
  }
}

async function build() {
  const hash = createHash('sha256').update(`${process.arch}:${version}`)
  for (const name of ['go.mod', 'go.sum', 'main.go', 'project_fs.go']) {
    hash.update(await readFile(join(source, name)))
  }
  const output = join(cache, hash.digest('hex'), 'orca-lan-smb')
  if (await exists(output)) {
    return output
  }
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(cache, 'build-'))
  try {
    const go = await goTool()
    const binary = join(staging, 'orca-lan-smb')
    await exec(go, ['build', '-mod=readonly', '-trimpath', '-o', binary, '.'], {
      cwd: source,
      env: {
        ...process.env,
        GOCACHE: join(cache, 'build-cache'),
        GOMODCACHE: join(cache, 'modules'),
        GOENV: 'off',
        GOFLAGS: '',
        GOTOOLCHAIN: 'local',
        GOWORK: 'off',
        CGO_ENABLED: '0'
      },
      timeout: 240_000
    })
    await rename(binary, output)
    return output
  } finally {
    await rm(staging, { force: true, recursive: true })
  }
}

let pending
export function buildSmbServer() {
  pending ??= build().finally(() => {
    pending = undefined
  })
  return pending
}
