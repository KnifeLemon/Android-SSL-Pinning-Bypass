#!/usr/bin/env python3
"""
Launch an app and inject one or more Frida scripts AT STARTUP, then keep the
session alive.

Two startup strategies, tried in order:

  1. spawn  - frida holds the app at its first instruction, we install the hooks,
              then resume. Best timing; used when it works.
  2. attach-by-pid (fallback) - when spawn fails (see below), launch the app via
              `adb` and attach to its main pid within a fraction of a second. On
              modern Instagram the Tigon `initHybrid` call happens several seconds
              into startup, so a fast attach still installs the hook in time.

Why the fallback exists: on some emulators/frida-server states, BOTH
`frida -U -f <pkg> ...` and low-level `dev.spawn()` fail with
    "unexpectedly timed out while waiting for app to launch"
and attaching *by name* fails too (the process is missing from frida's list),
even though attaching *by pid* works fine. The fallback handles all of that.

Usage (from the repo root):
    py -3.13 frida\\run.py                                   # IG + instagram_v444_bypass.js
    py -3.13 frida\\run.py <package>                         # <package> + instagram_v444_bypass.js
    py -3.13 frida\\run.py <package> a.js b.js c.js          # multiple scripts (like -l -l -l)

Force the fallback (skip the ~15s spawn timeout on known-broken setups):
    set FRIDA_ATTACH=1   &&  py -3.13 frida\\run.py ...

adb must be on PATH, or point ADB at it:  set ADB=D:\\platform-tools\\adb.exe

Requires: Python 3.11+, `pip install frida frida-tools` (version matching your
frida-server), a rooted device with frida-server running.
"""
import os
import subprocess
import sys
import time

import frida
import frida_tools

# Make console output UTF-8-safe on non-UTF-8 consoles (e.g. Korean cp949 on
# Windows), so script logs / status lines never crash with UnicodeEncodeError.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ADB = os.environ.get("ADB", "adb")
pkg = sys.argv[1] if len(sys.argv) > 1 else "com.instagram.android"
script_paths = sys.argv[2:] or [os.path.join(HERE, "instagram_v444_bypass.js")]
# frida 17 doesn't expose the Java bridge to raw scripts - bundle the one shipped
# with frida-tools so `Java.*` works in every script.
bridge_path = os.path.join(os.path.dirname(frida_tools.__file__), "bridges", "java.js")
BRIDGE = open(bridge_path, encoding="utf-8").read() + "\n;globalThis.Java = bridge;\n"


def make_handler(tag):
    def on_message(message, data):
        if message.get("type") == "error":
            print(f"[{tag}][error]", message.get("description"))
        else:
            payload = message.get("payload")
            if payload is not None:
                print(f"[{tag}]", payload)
    return on_message


def adb(*args):
    return subprocess.run([ADB, *args], capture_output=True, text=True).stdout.strip()


def launch_and_get_pid(package, timeout=25.0):
    """Cold-launch the app via adb and return its main pid as soon as it appears.

    Polls by wall-clock time (not a fixed iteration count) so a slow first launch
    doesn't fail spuriously. Re-issues the launch intent partway through in case the
    first monkey/am call didn't take.
    """
    adb("shell", "am", "force-stop", package)
    time.sleep(0.5)
    adb("shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1")
    deadline = time.time() + timeout
    relaunched = False
    while time.time() < deadline:
        out = adb("shell", "pidof", package)      # pidof's first pid is the main process
        if out:
            return int(out.split()[0])
        if not relaunched and time.time() > deadline - timeout / 2:
            adb("shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1")
            relaunched = True
        time.sleep(0.1)
    return None


SERVER_HINT = (
    "[x] frida-server isn't running on the device (frida fell back to 'jailed' mode).\n"
    "    Start it (from PowerShell, not Git Bash, so the path isn't mangled):\n"
    "      adb root\n"
    "      adb push frida-server /data/local/tmp/frida-server   # if it's missing after a wipe/reboot\n"
    "      adb shell \"chmod 755 /data/local/tmp/frida-server\"\n"
    "      adb shell \"/data/local/tmp/frida-server -D\"\n"
    "    Then re-run this script."
)


def start(dev):
    """Return (pid, spawned) using spawn, or the launch+attach-by-pid fallback."""
    if not os.environ.get("FRIDA_ATTACH"):
        try:
            print(f"[*] spawning {pkg} ...")
            return dev.spawn([pkg]), True
        except (frida.TimedOutError, frida.TransportError) as e:
            # spawn-gating is broken/slow on some emulators (LDPlayer): times out, or
            # the transport itself times out. Either way, fall back to attach-by-pid.
            print(f"[!] spawn failed ({type(e).__name__}) - falling back to launch + attach-by-pid")
        except frida.NotSupportedError:
            raise SystemExit(SERVER_HINT)          # 'need Gadget on jailed Android' = server down
    pid = launch_and_get_pid(pkg)
    if pid is None:
        raise SystemExit(f"[x] could not find a running pid for {pkg} (is adb on PATH? set ADB=...)")
    print(f"[*] launched {pkg}, main pid {pid}")
    return pid, False


def main():
    dev = frida.get_usb_device(timeout=10)
    pid, spawned = start(dev)
    try:
        session = dev.attach(pid)                  # attach by pid works even when by-name doesn't
    except frida.NotSupportedError:
        raise SystemExit(SERVER_HINT)

    scripts = []                                  # keep references alive
    for path in script_paths:
        tag = os.path.basename(path)
        script = session.create_script(BRIDGE + open(path, encoding="utf-8").read())
        script.on("message", make_handler(tag))
        script.load()                             # hooks installed before initHybrid runs
        scripts.append(script)
        print(f"[*] loaded {tag}")

    if spawned:
        dev.resume(pid)
    print(f"[*] running (pid {pid}). Use the app now; Ctrl-C to detach.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[*] detaching")
        try:
            session.detach()
        except Exception:
            pass


if __name__ == "__main__":
    main()
