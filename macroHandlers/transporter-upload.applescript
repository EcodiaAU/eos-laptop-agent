-- transporter-upload.applescript
-- Drives Apple Transporter.app to upload an .ipa to App Store Connect using
-- the Apple ID signed in to Transporter (must be done via macincloud-login first).
--
-- Usage: osascript transporter-upload.applescript /path/to/App.ipa
--
-- Wait/sleep discipline: polling waits, 5s intervals, max 900s total for upload.
-- Returns: "OK" on success, "ERR <reason>" on failure. Stdout-readable.
--
-- Authored by fork_mojlth0k_2b4be6, 29 Apr 2026.

on run argv
	if (count of argv) < 1 then
		return "ERR missing argv[1]: ipa_path required"
	end if
	set ipaPath to item 1 of argv
	set transporterPath to "/Applications/Transporter.app"

	-- Verify ipa exists.
	try
		do shell script "test -f " & quoted form of ipaPath
	on error
		return "ERR ipa not found: " & ipaPath
	end try

	-- Open the IPA in Transporter. Transporter auto-imports the package.
	try
		do shell script "open -a " & quoted form of transporterPath & " " & quoted form of ipaPath
	on error errMsg
		return "ERR could not open ipa in Transporter: " & errMsg
	end try

	-- Wait for Transporter to launch.
	delay 8

	tell application "System Events"
		tell process "Transporter"
			set frontmost to true
			delay 2

			-- Poll for the main window with the imported package row to appear. Up to 60s.
			set mainWin to missing value
			repeat with i from 1 to 30
				try
					if (count of windows) > 0 then
						set mainWin to front window
						exit repeat
					end if
				end try
				delay 2
			end repeat

			if mainWin is missing value then
				return "ERR Transporter main window not visible"
			end if

			-- Wait for package to finish importing/validating. The Deliver button stays
			-- disabled until validation completes. Poll for up to 180s.
			set deliverButton to missing value
			repeat with i from 1 to 36
				try
					repeat with b in (every button of front window)
						if (name of b) is "Deliver" then
							if enabled of b then
								set deliverButton to b
								exit repeat
							end if
						end if
					end repeat
					if deliverButton is not missing value then exit repeat
				end try
				delay 5
			end repeat

			if deliverButton is missing value then
				-- Transporter may surface validation errors as a sheet.
				try
					if exists sheet 1 of front window then
						set sheetName to name of sheet 1 of front window
						return "ERR validation sheet appeared: " & sheetName
					end if
				end try
				return "ERR Deliver button never enabled (validation likely failed or hung)"
			end if

			-- Click Deliver.
			try
				click deliverButton
			on error
				return "ERR could not click Deliver"
			end try

			-- Upload begins. Poll for completion. Markers:
			--   - "Delivered" status text in the package row
			--   - Or a success sheet
			-- Poll every 10s for up to 900s.
			set uploadDone to false
			set uploadOk to false
			repeat with i from 1 to 90
				delay 10
				try
					-- Look for status text in the row. Transporter shows "Delivered" on success.
					set statusTexts to (value of every static text of front window)
					repeat with t in statusTexts
						if t contains "Delivered" then
							set uploadDone to true
							set uploadOk to true
							exit repeat
						end if
						if t contains "Failed" or t contains "Error" then
							set uploadDone to true
							set uploadOk to false
							exit repeat
						end if
					end repeat
					if uploadDone then exit repeat
					-- Also check sheets.
					if exists sheet 1 of front window then
						set sheetName to name of sheet 1 of front window
						if sheetName contains "Success" or sheetName contains "Delivered" then
							set uploadDone to true
							set uploadOk to true
							exit repeat
						end if
						if sheetName contains "Error" or sheetName contains "Failed" then
							set uploadDone to true
							set uploadOk to false
							exit repeat
						end if
					end if
				end try
			end repeat

			if not uploadDone then
				return "ERR upload timed out after 900s"
			end if

			if not uploadOk then
				return "ERR upload reported failure"
			end if

			return "OK"
		end tell
	end tell
end run
