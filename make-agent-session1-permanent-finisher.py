"""Finishes what make-agent-session1-permanent.ps1 started.
PS ConvertFrom-Json choked on duplicate USERNAME/username keys in PM2's dump.pm2.
Python's json.loads handles it (last-wins). Steps 2-4 of the original script.

Run from the SAME admin PowerShell as the failed script (eos-pm2 is already stopped).
"""

import json
import os
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path

HOME = Path(os.environ["USERPROFILE"])
DUMP = HOME / ".pm2" / "dump.pm2"
NODE_EXE = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
AGENT_TOKEN = "fad80809116f70923d200b371d4b1b922e38951bac5fc30df516652cfea6011f"
DATABASE_URL = "postgresql://postgres.nxmtfzofemtrlezlyhcj:QR2uOIG0IcS8YSvq@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres"


def edit_dump():
    if not DUMP.exists():
        print(f"[2/5] no dump.pm2 at {DUMP}; skipping")
        return
    backup = DUMP.with_suffix(f".pm2.bak-{datetime.now().strftime('%Y%m%d%H%M%S')}")
    shutil.copy2(DUMP, backup)
    print(f"[2/5] backup: {backup}")
    raw = DUMP.read_text(encoding="utf-8")
    dump = json.loads(raw)  # python tolerates duplicate keys, last wins
    before = [a.get("name") for a in dump]
    kept = [a for a in dump if a.get("name") != "eos-laptop-agent"]
    if len(kept) == len(dump):
        print(f"[2/5] eos-laptop-agent already absent from dump.pm2; entries: {before}")
        return
    DUMP.write_text(json.dumps(kept, indent=2), encoding="utf-8")
    print(f"[2/5] dump.pm2 now lists: {[a.get('name') for a in kept]}")


def restart_service():
    print("[3/5] starting eos-pm2 service ...")
    r = subprocess.run(["sc", "start", "eos-pm2"], capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip())
    time.sleep(5)
    r = subprocess.run(["sc", "query", "eos-pm2"], capture_output=True, text=True)
    state_line = next((l for l in r.stdout.splitlines() if "STATE" in l), "")
    print(f"      eos-pm2 status: {state_line.strip()}")


def register_logon_task():
    print("[4/5] registering Task Scheduler entry EcodiaOSLaptopAgent ...")
    user = os.environ.get("USERNAME", "tjdTa")
    subprocess.run(
        ["schtasks", "/Delete", "/TN", "EcodiaOSLaptopAgent", "/F"],
        capture_output=True,
        text=True,
    )
    setters = (
        f"$env:AGENT_TOKEN='{AGENT_TOKEN}'; "
        f"$env:AGENT_PORT='7456'; "
        f"$env:SCHEDULER_ENABLED='true'; "
        f"$env:DATABASE_URL='{DATABASE_URL}'; "
        f"& '{NODE_EXE}' 'D:\\.code\\eos-laptop-agent\\index.js'"
    )
    tr = (
        '<?xml version="1.0" encoding="UTF-16"?>'
        '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'
        "<RegistrationInfo><Description>EcodiaOS laptop-agent in Session 1 at user logon</Description></RegistrationInfo>"
        "<Triggers><LogonTrigger>"
        f"<UserId>{user}</UserId><Delay>PT15S</Delay><Enabled>true</Enabled>"
        "</LogonTrigger></Triggers>"
        '<Principals><Principal id="Author">'
        f"<UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel>"
        "</Principal></Principals>"
        "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"
        "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"
        "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"
        "<AllowHardTerminate>true</AllowHardTerminate>"
        "<StartWhenAvailable>true</StartWhenAvailable>"
        "<Hidden>true</Hidden>"
        "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"
        "</Settings>"
        '<Actions Context="Author"><Exec>'
        "<Command>powershell.exe</Command>"
        f'<Arguments>-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "{setters}"</Arguments>'
        "</Exec></Actions></Task>"
    )
    xml_path = Path(os.environ["TEMP"]) / "EcodiaOSLaptopAgent.xml"
    xml_path.write_text(tr, encoding="utf-16")
    r = subprocess.run(
        [
            "schtasks",
            "/Create",
            "/TN",
            "EcodiaOSLaptopAgent",
            "/XML",
            str(xml_path),
            "/F",
        ],
        capture_output=True,
        text=True,
    )
    print((r.stdout.strip() or r.stderr.strip())[:200])


def verify():
    print("[5/5] verification ...")
    r = subprocess.run(
        ["schtasks", "/Query", "/TN", "EcodiaOSLaptopAgent"],
        capture_output=True,
        text=True,
    )
    if r.returncode == 0:
        print("      Task Scheduler entry: present")
    else:
        print(f"      Task Scheduler entry: MISSING ({r.stderr.strip()[:80]})")
    try:
        import urllib.request

        with urllib.request.urlopen(
            "http://127.0.0.1:7456/api/health", timeout=5
        ) as resp:
            body = resp.read().decode("utf-8")
            print(f"      /api/health: {body[:120]}")
    except Exception as e:
        print(
            f"      /api/health unreachable: {type(e).__name__} (current Session 1 agent process should still be alive; reboot to test the task)"
        )


def main():
    edit_dump()
    restart_service()
    register_logon_task()
    verify()
    print(
        "\nDone. Reboot Corazon when convenient to confirm the agent comes back in Session 1."
    )


if __name__ == "__main__":
    main()
