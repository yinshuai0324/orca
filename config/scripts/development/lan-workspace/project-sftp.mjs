import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  truncate,
  unlink,
  utimes
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, posix } from 'node:path'

const { SFTP, OPEN_MODE, STATUS_CODE } = createRequire(import.meta.url)('ssh2/lib/protocol/SFTP.js')
function privateName(value) {
  const name = value.toLowerCase()
  return name === '.git' || name === 'node_modules' || name === '.env' || name.startsWith('.env.')
}

function permissionDenied() {
  return Object.assign(new Error('Permission denied'), { code: 'EACCES' })
}

function attributes(stat) {
  return {
    mode: stat.mode,
    size: stat.size,
    uid: stat.uid,
    gid: stat.gid,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000)
  }
}

function openFlags(mode) {
  let flags =
    mode & OPEN_MODE.WRITE
      ? mode & OPEN_MODE.READ
        ? constants.O_RDWR
        : constants.O_WRONLY
      : constants.O_RDONLY
  for (const [sftp, native] of [
    [OPEN_MODE.APPEND, constants.O_APPEND],
    [OPEN_MODE.CREAT, constants.O_CREAT],
    [OPEN_MODE.TRUNC, constants.O_TRUNC],
    [OPEN_MODE.EXCL, constants.O_EXCL]
  ]) {
    if (mode & sftp) {
      flags |= native
    }
  }
  return flags | constants.O_NOFOLLOW | constants.O_NONBLOCK
}

export function serveProjectFiles(channel, root, onError) {
  const flow = { id: 0, state: 'open', window: Number.MAX_SAFE_INTEGER, packetSize: 32768 }
  const transport = {
    channelData: (_id, data) => channel.write(data),
    channelClose: () => channel.close()
  }
  // The authenticated SSH exec channel carries SFTP directly in passive SSHFS mode.
  const sftp = new SFTP(
    { _protocol: transport },
    { type: 'session', incoming: flow, outgoing: { ...flow } },
    { server: true }
  )
  const handles = new Map()
  let nextHandle = 0
  let closed = false

  function newHandle(id, record) {
    if (closed || handles.size >= 256) {
      void record.file?.close().catch(onError)
      if (!closed) {
        sftp.status(id, STATUS_CODE.FAILURE)
      }
      return
    }
    const handle = Buffer.from(String(++nextHandle))
    handles.set(handle.toString(), record)
    sftp.handle(id, handle)
  }

  function findHandle(handle) {
    const record = handles.get(handle.toString())
    if (!record) {
      throw permissionDenied()
    }
    return record
  }

  async function pathFor(remotePath, { missing = false, mutate = false } = {}) {
    if (remotePath.split('/').some((part) => part === '..' || privateName(part))) {
      throw permissionDenied()
    }
    const relative = posix.normalize(`/${remotePath}`).replace(/^\/+|\/+$/g, '')
    if (mutate && !relative) {
      throw permissionDenied()
    }
    const local = relative ? join(root, relative) : root
    const parent = relative ? dirname(local) : root
    if ((await realpath(parent)) !== parent) {
      throw permissionDenied()
    }
    const entry = await lstat(local).catch((error) => {
      if (missing && error.code === 'ENOENT') {
        return null
      }
      throw error
    })
    if (entry && !entry.isDirectory() && (!entry.isFile() || entry.nlink > 1)) {
      throw permissionDenied()
    }
    return { local, relative, entry }
  }

  function listen(event, handler) {
    sftp.on(event, (id, ...args) => {
      if (closed) {
        return
      }
      void Promise.resolve()
        .then(() => handler(id, ...args))
        .catch((error) => {
          if (closed) {
            return
          }
          const code =
            error.code === 'ENOENT' || error.code === 'ENOTDIR'
              ? STATUS_CODE.NO_SUCH_FILE
              : ['EACCES', 'EPERM', 'ELOOP'].includes(error.code)
                ? STATUS_CODE.PERMISSION_DENIED
                : STATUS_CODE.FAILURE
          sftp.status(id, code)
        })
    })
  }

  const ok = (id) => sftp.status(id, STATUS_CODE.OK)
  listen('REALPATH', async (id, path) => {
    const { relative, entry } = await pathFor(path)
    const name = `/${relative}`
    sftp.name(id, [{ filename: name, longname: name, attrs: attributes(entry) }])
  })
  for (const event of ['STAT', 'LSTAT']) {
    listen(event, async (id, path) => sftp.attrs(id, attributes((await pathFor(path)).entry)))
  }
  listen('OPEN', async (id, path, flags, attrs) => {
    const { local, entry } = await pathFor(path, { missing: true, mutate: true })
    if (entry?.isDirectory()) {
      throw permissionDenied()
    }
    newHandle(id, { file: await open(local, openFlags(flags), (attrs.mode ?? 0o644) & 0o777) })
  })
  listen('READ', async (id, handle, offset, length) => {
    const buffer = Buffer.alloc(Math.min(length, 32 * 1024))
    const { bytesRead } = await findHandle(handle).file.read(buffer, 0, buffer.length, offset)
    if (bytesRead > 0) {
      sftp.data(id, buffer.subarray(0, bytesRead))
    } else {
      sftp.status(id, STATUS_CODE.EOF)
    }
  })
  listen('WRITE', async (id, handle, offset, data) => {
    const file = findHandle(handle).file
    let written = 0
    while (written < data.length) {
      const { bytesWritten } = await file.write(
        data,
        written,
        data.length - written,
        offset + written
      )
      if (!bytesWritten) {
        throw new Error('Zero-byte write')
      }
      written += bytesWritten
    }
    ok(id)
  })
  listen('CLOSE', async (id, handle) => {
    const record = findHandle(handle)
    handles.delete(handle.toString())
    await record.file?.close()
    ok(id)
  })
  listen('OPENDIR', async (id, path) => {
    const { local } = await pathFor(path)
    const names = await readdir(local, { withFileTypes: true })
    newHandle(id, {
      path,
      names: names.filter(
        (name) => !privateName(name.name) && (name.isFile() || name.isDirectory())
      ),
      offset: 0
    })
  })
  listen('READDIR', async (id, handle) => {
    const record = findHandle(handle)
    while (record.offset < record.names.length) {
      const batch = record.names.slice(record.offset, record.offset + 32)
      record.offset += batch.length
      const entries = await Promise.all(
        batch.map(async ({ name }) => {
          const entry = await pathFor(posix.join(record.path, name)).catch(() => null)
          return entry ? { filename: name, longname: name, attrs: attributes(entry.entry) } : null
        })
      )
      const present = entries.filter(Boolean)
      if (present.length) {
        sftp.name(id, present)
        return
      }
    }
    sftp.status(id, STATUS_CODE.EOF)
  })
  listen('FSTAT', async (id, handle) =>
    sftp.attrs(id, attributes(await findHandle(handle).file.stat()))
  )
  listen('SETSTAT', async (id, path, attrs) => {
    const { local, entry } = await pathFor(path, { mutate: true })
    if (attrs.size !== undefined) {
      await truncate(local, attrs.size)
    }
    if (attrs.mode !== undefined) {
      await chmod(local, attrs.mode & 0o777)
    }
    if (attrs.atime !== undefined || attrs.mtime !== undefined) {
      await utimes(local, attrs.atime ?? entry.atime, attrs.mtime ?? entry.mtime)
    }
    ok(id)
  })
  listen('FSETSTAT', async (id, handle, attrs) => {
    const file = findHandle(handle).file
    if (attrs.size !== undefined) {
      await file.truncate(attrs.size)
    }
    if (attrs.mode !== undefined) {
      await file.chmod(attrs.mode & 0o777)
    }
    if (attrs.atime !== undefined || attrs.mtime !== undefined) {
      const entry = await file.stat()
      await file.utimes(attrs.atime ?? entry.atime, attrs.mtime ?? entry.mtime)
    }
    ok(id)
  })
  listen('MKDIR', async (id, path, attrs) => {
    await mkdir((await pathFor(path, { missing: true, mutate: true })).local, {
      mode: (attrs.mode ?? 0o755) & 0o777
    })
    ok(id)
  })
  listen('RMDIR', async (id, path) => {
    await rmdir((await pathFor(path, { mutate: true })).local)
    ok(id)
  })
  listen('REMOVE', async (id, path) => {
    await unlink((await pathFor(path, { mutate: true })).local)
    ok(id)
  })
  listen('RENAME', async (id, from, to) => {
    const source = await pathFor(from, { mutate: true })
    const target = await pathFor(to, { missing: true, mutate: true })
    await rename(source.local, target.local)
    ok(id)
  })
  sftp.on('error', onError)
  channel.on('data', (data) => {
    try {
      sftp.push(data)
    } catch (error) {
      onError(error)
    }
  })
  channel.once('close', () => {
    closed = true
    for (const { file } of handles.values()) {
      void file?.close().catch(onError)
    }
    handles.clear()
  })
}
