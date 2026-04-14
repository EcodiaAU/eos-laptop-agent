const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { isWindows } = require('../lib/platform')

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
  const binary = encoding === 'base64' || isBinary(filePath)
  const content = fs.readFileSync(filePath, binary ? 'base64' : 'utf-8')
  return { content, encoding: binary ? 'base64' : 'utf-8', path: filePath }
}

async function writeFile({ path: filePath, content, encoding }) {
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
  const entries = []
  function walk(dir, depth) {
    if (depth >= maxDepth) return
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
  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) {
    fs.rmSync(filePath, { recursive: true, force: true })
  } else {
    fs.unlinkSync(filePath)
  }
  return { deleted: true, path: filePath }
}

async function fileInfo({ path: filePath }) {
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
      const out = execSync('wmic logicaldisk get size,freespace,caption', { encoding: 'utf-8' })
      const lines = out.trim().split('\n').slice(1).filter(l => l.trim())
      const drives = lines.map(line => {
        const parts = line.trim().split(/\s+/)
        return { drive: parts[0], free: parseInt(parts[1]) || 0, total: parseInt(parts[2]) || 0 }
      })
      return { drives }
    }
    const out = execSync('df -h / /home 2>/dev/null || df -h /', { encoding: 'utf-8' })
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
