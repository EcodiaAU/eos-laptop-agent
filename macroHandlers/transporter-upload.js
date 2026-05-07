// macroHandlers/transporter-upload.js
// Drive Apple Transporter.app to upload an .ipa to App Store Connect.
// Runs over SSH on SY094 (the MacInCloud Mac).
//
// PRECONDITION: macincloud-login macro has been run at least once so that
// Transporter.app holds Tate's Apple ID. Without that, Deliver fails on auth.
// This macro does NOT verify the precondition; the AppleScript surfaces
// validation errors via stdout.
//
// PATH SELECTION: Transporter is installed at /Applications/Transporter.app.
// We do NOT use iTMSTransporter CLI directly because it requires explicit
// -username/-password (app-specific password) or -authKeyId/-authPath (.p8).
// Neither is wired up; the GUI Transporter uses the Apple ID logged in via
// the Sign In flow, which is what the macro path is for.
//
// Wait/sleep discipline: AppleScript driver does its own polling (5-10s,
// max 900s upload window). Outer SSH timeout buffer is 1000s.
//
// Authored by fork_mojlth0k_2b4be6, 29 Apr 2026.

const path = require('path')
const fs = require('fs')

const shellTool = require(path.join(__dirname, '..', 'tools', 'shell.js'))

const APPLESCRIPT_REMOTE_PATH = '/tmp/eos-transporter-upload.applescript'
const APPLESCRIPT_BODY = fs.readFileSync(
  path.join(__dirname, 'transporter-upload.applescript'),
  'utf8'
)

async function handle({ params, helpers }) {
  params = params || {}
  const ipaPath = params.ipa_path || params.ipaPath
  const sshHost = params.ssh_host || 'SY094.macincloud.com'
  const sshUser = params.ssh_user || 'user276189'
  const sshPass = params.ssh_pass
  const timeoutMs = params.timeout_ms || 1000000
  const startTs = Date.now()

  if (!ipaPath) {
    return { success: false, error: 'ipa_path required (full path on SY094 to .ipa)' }
  }
  if (!sshPass) {
    return { success: false, error: 'ssh_pass required (read from kv_store creds.macincloud.password)' }
  }

  helpers.note(`transporter-upload start ipa_path=${ipaPath} ssh_host=${sshHost} ssh_user=${sshUser}`)
  helpers.mark('start')

  // Step 1: stage AppleScript on SY094 (idempotent).
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
      ipa_path: ipaPath,
      ssh_host: sshHost,
      planned_ssh_stage: stageCmd.replace(sshPass, '[REDACTED]'),
      planned_ssh_run: `osascript ${APPLESCRIPT_REMOTE_PATH} ${shellEscape(ipaPath)}`,
      note: 'dryRun: AppleScript would be staged then executed via osascript driving Transporter.app.',
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

  // Step 2: invoke osascript on SY094 with the IPA path.
  const runCmd = sshRun({
    host: sshHost,
    user: sshUser,
    pass: sshPass,
    remoteCmd: `osascript ${APPLESCRIPT_REMOTE_PATH} ${shellEscape(ipaPath)}`,
  })

  helpers.note('invoke osascript -> Transporter.app on SY094 (long-running, up to ~1000s)')
  const runResult = await shellTool.shell({ command: runCmd, timeout: timeoutMs })
  helpers.mark('after_run')

  const stdout = (runResult.stdout || '').trim()
  const stderr = (runResult.stderr || '').trim()
  const okMatch = /^OK\b/m.test(stdout)
  const errMatch = stdout.match(/^ERR\s+(.+)$/m)

  return {
    success: okMatch && runResult.exitCode === 0,
    error: okMatch ? null : (errMatch ? errMatch[1] : (stderr || `osascript exit ${runResult.exitCode}`)),
    ipa_path: ipaPath,
    ssh_host: sshHost,
    osascript_exit: runResult.exitCode,
    osascript_stdout: truncate(stdout, 2000),
    osascript_stderr: truncate(stderr, 1000),
    elapsed_ms: Date.now() - startTs,
    note: 'Verify upload landed in App Store Connect TestFlight. Build appears within 5-15 minutes after OK.',
  }
}

// SSH helpers - duplicated from xcode-organizer-upload.js to keep handlers self-contained.

function sshRun({ host, user, pass, remoteCmd }) {
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
  const b64 = Buffer.from(body, 'utf8').toString('base64')
  const remote = `echo ${b64} | base64 -d > ${remotePath} && chmod 644 ${remotePath}`
  return sshRun({ host, user, pass, remoteCmd: remote })
}

function shellEscape(s) {
  if (!s) return "''"
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function sqEscape(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function dqEscape(s) {
  return '"' + String(s).replace(/(["\\$`])/g, '\\$1') + '"'
}

function truncate(s, n) {
  if (!s) return s
  if (s.length <= n) return s
  return s.slice(0, n) + '...[trunc]'
}

module.exports = {
  name: 'transporter-upload',
  description: 'Upload an iOS .ipa to App Store Connect via Apple Transporter.app GUI on SY094 (MacInCloud Mac). Uses Tate Apple ID logged in to Transporter (no API key required). Polling-wait discipline; 1000s outer timeout.',
  params: {
    ipa_path: 'Full path on SY094 to the .ipa file (REQUIRED)',
    ssh_host: 'SSH host (default SY094.macincloud.com)',
    ssh_user: 'SSH user (default user276189)',
    ssh_pass: 'SSH password - REQUIRED, read from kv_store creds.macincloud.password',
    timeout_ms: 'Outer ssh timeout in ms (default 1000000)',
  },
  handle,
}
