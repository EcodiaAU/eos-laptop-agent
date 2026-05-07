-- macincloud-login.applescript
-- Drives Xcode > Settings > Accounts > + > Apple ID sign-in dialog up to the
-- password input field, then PAUSES (returns "PAUSED_AT_PASSWORD" marker).
--
-- Tate (supervised) types the Apple ID password via VNC / Mac Keychain autofill,
-- then types the 2FA code from his iPhone. After 2FA clears, the Xcode keychain
-- holds the session for ~30 days, satisfying the precondition for
-- xcode-organizer-upload + transporter-upload macros.
--
-- Usage: osascript macincloud-login.applescript <apple_email>
-- Example: osascript /tmp/eos-macincloud-login.applescript code@ecodia.au
--
-- Returns:
--   "OK PAUSED_AT_PASSWORD email=<email>"  - dialog reached password field
--   "OK ALREADY_SIGNED_IN email=<email>"   - account already exists in Xcode
--   "ERR <reason>"                         - failure during navigation
--
-- Pause-point: after typing email + clicking Continue. Password field is focused
-- and waiting for input. AppleScript exits cleanly here. The supervised operator
-- types password, then 2FA, then the dialog completes outside this script.
--
-- Authored by fork_mojpge0a_3c7dcd, 29 Apr 2026.

on run argv
	if (count of argv) < 1 then
		return "ERR missing argv[1]: apple_email required"
	end if
	set appleEmail to item 1 of argv

	-- Step 1: launch Xcode if not running.
	try
		do shell script "open -a Xcode"
	on error errMsg
		return "ERR could not launch Xcode: " & errMsg
	end try

	-- Step 2: wait for Xcode process to be running.
	set xcodeReady to false
	repeat with i from 1 to 30
		tell application "System Events"
			if exists (process "Xcode") then
				set xcodeReady to true
				exit repeat
			end if
		end tell
		delay 1
	end repeat

	if not xcodeReady then
		return "ERR Xcode did not start within 30s"
	end if

	-- Brief settle delay for Xcode launch.
	delay 4

	tell application "System Events"
		tell process "Xcode"
			set frontmost to true
			delay 1

			-- Step 3: open Settings (Cmd+,).
			try
				keystroke "," using command down
			on error
				return "ERR could not send Cmd+,"
			end try

			-- Step 4: wait for Settings window.
			set settingsWin to missing value
			repeat with i from 1 to 15
				try
					repeat with w in windows
						set wname to name of w
						if wname contains "Settings" or wname contains "Preferences" then
							set settingsWin to w
							exit repeat
						end if
					end repeat
					if settingsWin is not missing value then exit repeat
				end try
				delay 1
			end repeat

			if settingsWin is missing value then
				return "ERR Settings window did not appear"
			end if

			-- Step 5: click the Accounts toolbar item.
			-- Settings has a toolbar with named items: General, Accounts, Behaviors, etc.
			try
				click button "Accounts" of toolbar 1 of settingsWin
			on error
				try
					-- Fallback: iterate toolbar buttons by name.
					set tb to toolbar 1 of settingsWin
					set accountsClicked to false
					repeat with b in buttons of tb
						if (name of b) contains "Accounts" then
							click b
							set accountsClicked to true
							exit repeat
						end if
					end repeat
					if not accountsClicked then return "ERR Accounts toolbar button not found"
				on error
					return "ERR Accounts toolbar button not found"
				end try
			end try

			delay 2

			-- Step 6: check if the requested email is already signed in. The Accounts
			-- pane lists accounts in a sidebar (table 1 / outline 1 of scroll area).
			-- Best-effort detection - we walk text descendants of the front window.
			set alreadySignedIn to false
			try
				set winText to ""
				set descs to entire contents of settingsWin
				repeat with d in descs
					try
						set v to value of d
						if v is not missing value then set winText to winText & " " & (v as string)
					end try
					try
						set t to title of d
						if t is not missing value then set winText to winText & " " & (t as string)
					end try
				end repeat
				if winText contains appleEmail then
					set alreadySignedIn to true
				end if
			end try

			if alreadySignedIn then
				return "OK ALREADY_SIGNED_IN email=" & appleEmail
			end if

			-- Step 7: click "+" (add account) at the bottom-left of Accounts pane.
			-- Modern Xcode has an "Add" button. Older versions use "+".
			set addClicked to false
			try
				click button "Add" of settingsWin
				set addClicked to true
			on error
				try
					click button "+" of settingsWin
					set addClicked to true
				on error
					-- Walk all buttons looking for one with name "+" or "Add".
					try
						repeat with b in buttons of settingsWin
							set bname to name of b
							if bname is "+" or bname is "Add" then
								click b
								set addClicked to true
								exit repeat
							end if
						end repeat
					end try
				end try
			end try

			if not addClicked then
				return "ERR could not find + / Add button on Accounts pane"
			end if

			delay 2

			-- Step 8: account-type sheet appears. Choose "Apple ID".
			-- Sheet contains a list of account types. Click "Apple ID" then Continue.
			try
				click (first row whose value contains "Apple ID") of (table 1 of scroll area 1 of sheet 1 of front window)
			on error
				-- Fallback: select first row + check name.
				try
					select row 1 of table 1 of scroll area 1 of sheet 1 of front window
				on error
					-- Newer Xcode may use different layout. Try clicking visible "Apple ID" text.
					try
						click (first UI element whose value contains "Apple ID") of sheet 1 of front window
					on error
						return "ERR Apple ID type selector not found"
					end try
				end try
			end try

			delay 1

			-- Click Continue.
			try
				click button "Continue" of sheet 1 of front window
			on error
				try
					click button "Next" of sheet 1 of front window
				on error
					return "ERR Continue button not found after type selection"
				end try
			end try

			delay 3

			-- Step 9: email/password dialog appears (sheet 1 still). Type email.
			-- The email text field is the first text field of the sheet.
			try
				set focused of text field 1 of sheet 1 of front window to true
				delay 1
				keystroke appleEmail
				delay 1
			on error
				-- Try typing into whatever field has focus.
				try
					keystroke appleEmail
					delay 1
				on error
					return "ERR could not type email into Apple ID field"
				end try
			end try

			-- Click Continue / Next to advance to password field.
			try
				click button "Continue" of sheet 1 of front window
			on error
				try
					click button "Next" of sheet 1 of front window
				on error
					try
						-- Press Return to submit.
						keystroke return
					on error
						return "ERR could not advance to password field"
					end try
				end try
			end try

			delay 3

			-- Step 10: PAUSE HERE. Password field is now focused. Do NOT type a password.
			-- The supervised operator (Tate) types the Apple ID password via VNC,
			-- Mac Keychain may autofill, then types the 2FA code from his iPhone.
			-- After 2FA clears, the dialog will close on its own.
			--
			-- AppleScript exits with the PAUSED_AT_PASSWORD marker. The handler
			-- captures stdout and surfaces the marker to the conductor.

			return "OK PAUSED_AT_PASSWORD email=" & appleEmail
		end tell
	end tell
end run
