// macroHandlers/xcode-organizer-upload.js
// Drive Xcode > Window > Organizer > Distribute App > App Store Connect > Upload
// over SSH on SY094 (the MacInCloud Mac with Xcode 26.3 + Tate's Apple ID logged in).
//
// PRECONDITION: macincloud-login macro has been run at least once so that
// Xcode > Settings > Accounts holds Tate's Apple ID. Without that, Distribute App
// fails at the team-selection step. This macro does NOT verify the precondition;
// the conductor should check, or rely on the AppleScript ERR return.
//
// Wait/sleep discipline: the AppleScript driver does its own polling (5-10s
// intervals, max 600s upload window). This Node handler adds an outer SSH
// timeout buffer (700s) to catch hung sessions.
//
// Authored by fork_mojlth0k_2b4be6, 29 Apr 2026.

const path = require('path')
const fs = require('fs')

const shellTool = require(path.join(__dirname, '..', 'tools', 'shell.js'))

// AppleScript driver bundled inline so the handler is self-contained. On first
// invocation we ensure-write to a stable path on SY094, then osascript-run it.
const APPLESCRIPT_REMOTE_PATH = '/tmp/eos-xcode-organizer-upload.applescript'
const APPLESCRIPT_BODY = fs.readFileSync(
  path.join(__dirname, 'xcode-organizer-upload.applescript'),
  'utf8'
)

async function handle({ params, helpers }) {
  params = params || {}
  const archivePath = params.archive_path || params.archivePath
  const ipaPath = params.ipa_path || params.ipaPath
  const sshHost = params.ssh_host || 'SY094.macincloud.com'
  const sshUser = params.ssh_user || 'user276189'
  const sshPass = params.ssh_pass
  const timeoutMs = params.timeout_ms || 700000
  const startTs = Date.now()

  if (!archivePath && !ipaPath) {
    return { success: false, error: 'archive_path or ipa_path required' }
  }
  if (!sshPass) {
    return { success: false, error: 'ssh_pass required (read from kv_store creds.macincloud.password)' }
  }

  // Xcode Organizer distributes from .xcarchive bundles. If only ipa_path was
  // provided, we cannot drive the Organizer flow - bail with a directive to
  // use transporter-upload instead.
  const targetPath = archivePath
  if (!targetPath) {
    return {
      success: false,
      error: 'Xcode Organizer requires archive_path (.xcarchive). For .ipa uploads use transporter-upload macro.',
      hint: 'Pass archive_path from xcodebuild archive output, not the .ipa from -exportArchive.',
    }
  }

  helpers.note(`xcode-organizer-upload start archive_path=${targetPath} ssh_host=${sshHost} ssh_user=${sshUser}`)
  helpers.mark('start')

  // Step 1: stage AppleScript on SY094 (idempotent, write every call).
  // Use a heredoc over ssh; sshpass for non-interactive auth.
  const stageCmd = sshHeredocWrite({
    host: sshHost,
    user: sshUser,
    pass: sshPass,
    remotePath: APPLESCRIPT_REMOTE_PATH,
    body: APPLESCRIPT_BODY,
  })

  helpers.note(`stage applescript -> ${APPLESCRIPT_REMOTE_PATH}`)
  if (helpers.dryRun) {
    helpers.mark('after_dryrun_stage')
    return {
      success: true,
      dryRun: true,
      archive_path: targetPath,
      ssh_host: sshHost,
      planned_ssh_stage: stageCmd.replace(sshPass, '[REDACTED]'),
      planned_ssh_run: `osascript ${APPLESCRIPT_REMOTE_PATH} ${shellEscape(targetPath)}`,
      note: 'dryRun: AppleScript would be staged then executed via osascript.',
    }
  }

  const stageResult = await shellTool.shell({ command: stageCmd, timeout: 30000 })
  if (stageResult.exitCode !== 0) {
    return {
      success: false,
      error: `AppleScript staging failed: ${stageResult.stderr || stageResult.stdout}`,
      stage_exit: stageResult.exitCode,
      elapsed_ms: Date.now() - startTs,
    }
  }
  helpers.mark('after_stage')

  // Step 2: invoke osascript on SY094 with the archive path.
  // sshpass -p <pass> ssh user@host "osascript /tmp/eos-xcode-organizer-upload.applescript <archivePath>"
  const runCmd = sshRun({
    host: sshHost,
    user: sshUser,
    pass: sshPass,
    remoteCmd: `osascript ${APPLESCRIPT_REMOTE_PATH} ${shellEscape(targetPath)}`,
  })

  helpers.note('invoke osascript on SY094 (long-running, up to ~700s)')
  const runResult = await shellTool.shell({ command: runCmd, timeout: timeoutMs })
  helpers.mark('after_run')

  const stdout = (runResult.stdout || '').trim()
  const stderr = (runResult.stderr || '').trim()
  const okMatch = /^OK\b/m.test(stdout)
  const errMatch = stdout.match(/^ERR\s+(.+)$/m)

  return {
    success: okMatch && runResult.exitCode === 0,
    error: okMatch ? null : (errMatch ? errMatch[1] : (stderr || `osascript exit ${runResult.exitCode}`)),
    archive_path: targetPath,
    ssh_host: sshHost,
    osascript_exit: runResult.exitCode,
    osascript_stdout: truncate(stdout, 2000),
    osascript_stderr: truncate(stderr, 1000),
    elapsed_ms: Date.now() - startTs,
    note: 'Verify upload landed in App Store Connect TestFlight. Build appears within 5-15 minutes after OK.',
  }
}

// SSH helpers - keep them tiny + explicit.

function sshRun({ host, user, pass, remoteCmd }) {
  // sshpass -p '<pass>' ssh -o ... user@host "<remoteCmd>"
  // Single quotes around password; double quotes around remoteCmd (which is already shell-escaped).
  return [
    'sshpass',
    '-p',
    sqEscape(pass),
    'ssh',
    '-o', 'PubkeyAuthentication=no',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=20',
    '-o', 'ServerAliveInterval=30',
    `${user}@${host}`,
    dqEscape(remoteCmd),
  ].join(' ')
}

function sshHeredocWrite({ host, user, pass, remotePath, body }) {
  // base64-encode the body to bypass quoting headaches with the shell tunnel.
  const b64 = Buffer.from(body, 'utf8').toString('base64')
  const remote = `echo ${b64} | base64 -d > ${remotePath} && chmod 644 ${remotePath}`
  return sshRun({ host, user, pass, remoteCmd: remote })
}

function shellEscape(s) {
  if (!s) return "''"
  // Conservative single-quote wrap; escape embedded single quotes.
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function sqEscape(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function dqEscape(s) {
  // Wrap in double quotes; escape internal double quotes and dollar signs.
  return '"' + String(s).replace(/(["\\$`])/g, '\\$1') + '"'
}

function truncate(s, n) {
  if (!s) return s
  if (s.length <= n) return s
  return s.slice(0, n) + '...[trunc]'
}

module.exports = {
  name: 'xcode-organizer-upload',
  description: 'Upload an iOS .xcarchive to App Store Connect via Xcode Organizer GUI on SY094 (MacInCloud Mac). Uses Tate Apple ID logged in to Xcode (no ASC API key required). Polling-wait discipline; 700s outer timeout.',
  params: {
    archive_path: 'Full path on SY094 to the .xcarchive bundle (REQUIRED for this macro)',
    ipa_path: 'Ignored by this macro - use transporter-upload for .ipa flows',
    ssh_host: 'SSH host (default SY094.macincloud.com)',
    ssh_user: 'SSH user (default user276189)',
    ssh_pass: 'SSH password - REQUIRED, read from kv_store creds.macincloud.password',
    timeout_ms: 'Outer ssh timeout in ms (default 700000)',
  },
  handle,
}
