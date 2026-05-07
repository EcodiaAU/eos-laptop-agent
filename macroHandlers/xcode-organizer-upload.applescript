-- xcode-organizer-upload.applescript
-- Drives Xcode > Window > Organizer > Distribute App > App Store Connect > Upload
-- Assumes:
--   - Xcode is installed at /Applications/Xcode.app (or /Applications/Xcode26.3.app)
--   - The archive at the supplied path is a valid .xcarchive bundle
--   - Tate's Apple ID is signed in to Xcode > Settings > Accounts (must be done via macincloud-login first)
--   - The team has the right App Store Connect permissions
--
-- Usage: osascript xcode-organizer-upload.applescript /path/to/App.xcarchive
--
-- Wait/sleep discipline: polling waits, 5s intervals, max 600s total for upload.
-- Returns: "OK" on success, "ERR <reason>" on failure. Stdout-readable.
--
-- Authored by fork_mojlth0k_2b4be6, 29 Apr 2026.

on run argv
	if (count of argv) < 1 then
		return "ERR missing argv[1]: archive_path required"
	end if
	set archivePath to item 1 of argv
	set xcodePath to "/Applications/Xcode.app"

	-- Verify archive exists.
	try
		do shell script "test -d " & quoted form of archivePath
	on error
		return "ERR archive not found: " & archivePath
	end try

	-- Open the archive in Xcode. This auto-opens Organizer with the archive selected.
	try
		do shell script "open -a " & quoted form of xcodePath & " " & quoted form of archivePath
	on error errMsg
		return "ERR could not open archive in Xcode: " & errMsg
	end try

	-- Wait for Xcode to come up.
	delay 6

	tell application "System Events"
		tell process "Xcode"
			set frontmost to true
			delay 2

			-- Poll for Organizer window to be visible. Up to 30s.
			set organizerWin to missing value
			repeat with i from 1 to 15
				try
					repeat with w in windows
						if (title of w) contains "Archives" or (title of w) contains "Organizer" then
							set organizerWin to w
							exit repeat
						end if
					end repeat
					if organizerWin is not missing value then exit repeat
				end try
				delay 2
			end repeat

			if organizerWin is missing value then
				-- Force-open Organizer via menu.
				try
					click menu item "Organizer" of menu "Window" of menu bar 1
					delay 4
				on error
					return "ERR could not open Organizer window"
				end try
			end if

			-- Click Distribute App. The button label is "Distribute App" on a freshly-opened archive.
			set distributeClicked to false
			repeat with i from 1 to 8
				try
					click (first button whose name is "Distribute App") of front window
					set distributeClicked to true
					exit repeat
				end try
				delay 2
			end repeat

			if not distributeClicked then
				return "ERR could not find Distribute App button. Verify archive is selected in Organizer."
			end if

			-- Distribution sheet appears. Choose "App Store Connect".
			delay 4
			try
				-- The sheet has a list of distribution methods. Click App Store Connect (default first row in modern Xcode).
				click (first radio button whose name contains "App Store Connect") of sheet 1 of front window
			on error
				try
					-- Fallback: click by index 1 of radio group.
					click radio button 1 of radio group 1 of sheet 1 of front window
				on error
					return "ERR distribution method picker not found"
				end try
			end try

			delay 1

			-- Click Next button on the sheet.
			try
				click button "Next" of sheet 1 of front window
			on error
				return "ERR Next button not found on distribution sheet"
			end try

			delay 3

			-- Subsequent sheets vary by Xcode version. Loop click Next/Upload through up to 6 sheets.
			repeat with i from 1 to 6
				delay 3
				try
					if exists button "Upload" of sheet 1 of front window then
						click button "Upload" of sheet 1 of front window
						exit repeat
					else if exists button "Next" of sheet 1 of front window then
						click button "Next" of sheet 1 of front window
					end if
				on error
					-- Sheet may have closed.
					exit repeat
				end try
			end repeat

			-- Now we wait for the upload to complete. Poll every 10s for up to 600s.
			-- Success markers: "Upload Successful" sheet, or distribution sheet closes with no error.
			set uploadDone to false
			set uploadOk to false
			repeat with i from 1 to 60
				delay 10
				try
					if exists sheet 1 of front window then
						set sheetName to name of sheet 1 of front window
						if sheetName contains "Successful" or sheetName contains "Upload" and not (sheetName contains "Error") then
							-- Look for a Done button to dismiss.
							try
								if exists button "Done" of sheet 1 of front window then
									set uploadDone to true
									set uploadOk to true
									click button "Done" of sheet 1 of front window
									exit repeat
								end if
							end try
						end if
						if sheetName contains "Error" or sheetName contains "Failed" then
							set uploadDone to true
							set uploadOk to false
							exit repeat
						end if
					else
						-- No sheet means distribution flow closed - assume success.
						set uploadDone to true
						set uploadOk to true
						exit repeat
					end if
				end try
			end repeat

			if not uploadDone then
				return "ERR upload timed out after 600s"
			end if

			if not uploadOk then
				return "ERR upload reported failure"
			end if

			return "OK"
		end tell
	end tell
end run
