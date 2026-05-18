const fs = require('fs')
const path = require('path')
const os = require('os')
const { runSilent } = require('./_lib/silentExec')
const { isWindows } = require('../lib/platform')

// ── Privacy blocklist ────────────────────────────────────────────────
// Paths listed here are completely off-limits. No read, write, list,
// or delete operations. The agent will refuse with a clear error.
// Edit .blocked-paths in the agent root to add/remove paths.
const BLOCKED_PATHS_FILE = path.join(__dirname, '..', '.blocked-paths')
function loadBlockedPaths() {
  try {
    return fs.readFileSync(BLOCKED_PATHS_FILE, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => path.resolve(l))
  } catch { return [] }
}

function isBlocked(targetPath) {
  const resolved = path.resolve(targetPath)
  const blocked = loadBlockedPaths()
  return blocked.some(b => resolved.startsWith(b) || resolved === b)
}

function guardPath(targetPath) {
  if (isBlocked(targetPath)) {
    throw new Error(`ACCESS DENIED: ${targetPath} is in the privacy blocklist. This path is off-limits.`)
  }
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm',
  '.woff', '.woff2', '.ttf', '.eot',
  '.sqlite', '.db',
])

function isBinary(filePath) {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

async function readFile({ path: filePath, encoding }) {
  guardPath(filePath)
  const binary = encoding === 'base64' || isBinary(filePath)
  const content = fs.readFileSync(filePath, binary ? 'base64' : 'utf-8')
  return { content, encoding: binary ? 'base64' : 'utf-8', path: filePath }
}

async function writeFile({ path: filePath, content, encoding }) {
  guardPath(filePath)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (encoding === 'base64') {
    fs.writeFileSync(filePath, Buffer.from(content, 'base64'))
  } else {
    fs.writeFileSync(filePath, content, 'utf-8')
  }
  const stat = fs.statSync(filePath)
  return { path: filePath, size: stat.size, written: true }
}

async function listDir({ path: dirPath, recursive = false, maxDepth = 3 }) {
  guardPath(dirPath)
  const entries = []
  function walk(dir, depth) {
    if (depth >= maxDepth) return
    if (isBlocked(dir)) return
    let items
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      if (item.name === 'node_modules' || item.name === '.git') continue
      const full = path.join(dir, item.name)
      const isDir = item.isDirectory()
      entries.push({ name: item.name, path: full, type: isDir ? 'dir' : 'file' })
      if (isDir && recursive) walk(full, depth + 1)
    }
  }
  walk(dirPath, 0)
  return { entries, count: entries.length, path: dirPath }
}

async function deleteFile({ path: filePath }) {
  guardPath(filePath)
  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) {
    fs.rmSync(filePath, { recursive: true, force: true })
  } else {
    fs.unlinkSync(filePath)
  }
  return { deleted: true, path: filePath }
}

async function fileInfo({ path: filePath }) {
  guardPath(filePath)
  const stat = fs.statSync(filePath)
  return {
    path: filePath,
    size: stat.size,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString(),
    permissions: stat.mode.toString(8),
  }
}

async function diskUsage() {
  try {
    if (isWindows) {
      const out = runSilent('wmic logicaldisk get size,freespace,caption', { encoding: 'utf-8' })
      const lines = out.trim().split('\n').slice(1).filter(l => l.trim())
      const drives = lines.map(line => {
        const parts = line.trim().split(/\s+/)
        return { drive: parts[0], free: parseInt(parts[1]) || 0, total: parseInt(parts[2]) || 0 }
      })
      return { drives }
    }
    const out = runSilent('df -h / /home 2>/dev/null || df -h /', { encoding: 'utf-8' })
    const lines = out.trim().split('\n').slice(1)
    const mounts = lines.map(line => {
      const parts = line.split(/\s+/)
      return { filesystem: parts[0], size: parts[1], used: parts[2], available: parts[3], usePercent: parts[4], mount: parts[5] }
    })
    return { mounts }
  } catch (err) {
    return { error: err.message }
  }
}

module.exports = { readFile, writeFile, listDir, deleteFile, fileInfo, diskUsage }
