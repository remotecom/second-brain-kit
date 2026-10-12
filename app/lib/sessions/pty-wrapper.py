#!/usr/bin/env python3
"""
Copied from briefcase@070851e (native-host/pty-wrapper.py), unchanged in
behaviour. No runtime link to Briefcase.

PTY wrapper - bridges stdin/stdout pipes to a pseudo-terminal.
Avoids needing native Node.js modules (node-pty) which trigger macOS Gatekeeper.
Resize via SIGUSR1 + control file.
"""
import pty, os, sys, select, struct, fcntl, termios, signal, json

CONTROL_FILE = sys.argv[1]
cmd = sys.argv[2:]

if not cmd:
    sys.stderr.write("Usage: pty-wrapper.py <control-file> <command> [args...]\n")
    sys.exit(1)


def set_winsize(fd, rows, cols):
    s = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, s)


# Read initial size from control file
try:
    with open(CONTROL_FILE) as f:
        c = json.load(f)
    cols, rows = c.get("cols", 80), c.get("rows", 24)
except Exception:
    cols, rows = 80, 24

# Fork a PTY
pid, fd = pty.fork()
if pid == 0:
    # Child process - exec the command
    os.execvp(cmd[0], cmd)
    sys.exit(1)

# Parent process
set_winsize(fd, rows, cols)


def on_resize(sig, frame):
    try:
        with open(CONTROL_FILE) as f:
            c = json.load(f)
        set_winsize(fd, c.get("rows", 24), c.get("cols", 80))
    except Exception:
        pass


signal.signal(signal.SIGUSR1, on_resize)

stdin_fd = sys.stdin.fileno()
exit_code = 0

try:
    while True:
        try:
            rfds, _, _ = select.select([stdin_fd, fd], [], [], 0.5)
        except InterruptedError:
            # SIGUSR1 interrupts select - just continue
            continue

        if stdin_fd in rfds:
            data = os.read(stdin_fd, 4096)
            if not data:
                break
            os.write(fd, data)

        if fd in rfds:
            try:
                data = os.read(fd, 16384)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)

except Exception:
    pass
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        pass
    try:
        _, status = os.waitpid(pid, 0)
        exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
    except Exception:
        exit_code = 1

sys.exit(exit_code)
