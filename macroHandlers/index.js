// macroHandlers/index.js
// Barrel for the macro dispatcher. Add new handlers here when authored.
// Authored by fork_mojldsgx_7b55bf, 29 Apr 2026.
// Updated by fork_mojlth0k_2b4be6, 29 Apr 2026: + xcode-organizer-upload, transporter-upload.
// Updated by fork_mojpge0a_3c7dcd, 29 Apr 2026: + macincloud-login, github-login, stripe-dashboard, gmail-send, supabase-dashboard, vercel-redeploy.

const apple = require('./apple-signin')
const vercelLogin = require('./vercel-login')
const coexist = require('./coexist-admin-signin')
const xcodeOrganizerUpload = require('./xcode-organizer-upload')
const transporterUpload = require('./transporter-upload')
const macincloudLogin = require('./macincloud-login')
const githubLogin = require('./github-login')
const stripeDashboard = require('./stripe-dashboard')
const gmailSend = require('./gmail-send')
const supabaseDashboard = require('./supabase-dashboard')
const vercelRedeploy = require('./vercel-redeploy')
const ascBuildReviewSubmit = require('./asc-build-review-submit')

const HANDLERS = {
  [apple.name]: apple,
  [vercelLogin.name]: vercelLogin,
  [coexist.name]: coexist,
  [xcodeOrganizerUpload.name]: xcodeOrganizerUpload,
  [transporterUpload.name]: transporterUpload,
  [macincloudLogin.name]: macincloudLogin,
  [githubLogin.name]: githubLogin,
  [stripeDashboard.name]: stripeDashboard,
  [gmailSend.name]: gmailSend,
  [supabaseDashboard.name]: supabaseDashboard,
  [vercelRedeploy.name]: vercelRedeploy,
  [ascBuildReviewSubmit.name]: ascBuildReviewSubmit,
}

module.exports = { HANDLERS }
