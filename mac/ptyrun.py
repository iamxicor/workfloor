# Runs a command in a pseudo-terminal, relaying stdin to it and its output to stdout, and exits with
# its exit code as soon as it ends. (pty.spawn in the macOS system Python keeps waiting on stdin.)
import os, pty, select, sys

pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
stdin = sys.stdin.fileno()
watch = [fd, stdin]
while True:
    try:
        ready, _, _ = select.select(watch, [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b''
        if not data:
            break
        os.write(sys.stdout.fileno(), data)
    if stdin in ready:
        data = os.read(stdin, 4096)
        if data:
            os.write(fd, data)
        else:
            watch.remove(stdin)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
