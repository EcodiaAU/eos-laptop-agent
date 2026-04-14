const os = require('os')
const path = require('path')

const platform = os.platform()
const isWindows = platform === 'win32'
const isMac = platform === 'darwin'
const isLinux = platform === 'linux'

const shellCmd = isWindows
  ? { shell: 'powershell.exe', flag: '-Command' }
  : { shell: '/bin/bash', flag: '-c' }

const homeDir = os.homedir()
const tempDir = os.tmpdir()

module.exports = { platform, isWindows, isMac, isLinux, shellCmd, homeDir, tempDir }
