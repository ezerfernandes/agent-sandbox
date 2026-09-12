#!/bin/sh
# Bring up the X session before start.sh prints READY.
#
# Timing is the whole point of this file: create_snapshot.ts freezes guest memory
# the moment it sees READY, so every daemon here must be *serving* by the time
# this script returns. A half-started Xvnc is frozen half-started, and every VM
# restored from that snapshot inherits the broken state.

set -e

: "${DISPLAY:=:1}"
: "${DESKTOP_GEOMETRY:=1280x800}"
: "${XDG_RUNTIME_DIR:=/tmp/xdg}"
# HOME must be on tmpfs: the guest root filesystem is mounted read-only
# (create_snapshot.ts sets is_read_only, and start.sh never remounts it), so any
# tool that writes under /root fails. With -SecurityTypes None, Xvnc reads and
# writes nothing in ~/.vnc anyway.
: "${HOME:=/tmp/desktop-home}"
: "${XDG_CONFIG_HOME:=${HOME}/.config}"
: "${XDG_CACHE_HOME:=${HOME}/.cache}"
export DISPLAY DESKTOP_GEOMETRY XDG_RUNTIME_DIR HOME XDG_CONFIG_HOME XDG_CACHE_HOME

mkdir -p "${XDG_RUNTIME_DIR}" "${HOME}" "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"
chmod 700 "${XDG_RUNTIME_DIR}"

# Respawn loops: a crashed Xvnc or window manager must not leave the session a
# black rectangle for the rest of the VM's life.
#
# -localhost keeps RFB off the guest's network interface — the only way in is
# the vsock bridge below, which the host gates on an API key.
# -SecurityTypes None is safe for the same reason: there is no listener an
# outside network can reach.
(
    while true; do
        Xvnc "${DISPLAY}" \
            -geometry "${DESKTOP_GEOMETRY}" \
            -depth 24 \
            -rfbport 5901 \
            -localhost \
            -SecurityTypes None \
            -AlwaysShared \
            -ac \
            -pn \
            >/tmp/xvnc.log 2>&1
        sleep 1
    done
) &

# Wait for the display to actually answer, not merely for the process to exist.
tries=0
until xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "${tries}" -ge 200 ]; then
        echo "desktop: Xvnc did not come up within 20s" >&2
        cat /tmp/xvnc.log >&2 2>/dev/null || true
        exit 1
    fi
    sleep 0.1
done

# No screen blanking or DPMS: the framebuffer must keep rendering while nobody
# is looking, or a reconnecting viewer gets a black screen.
xset -display "${DISPLAY}" s off 2>/dev/null || true
# Alpine tigervnc has no DPMS extension; it warns and exits non-zero. Harmless,
# but it would land in the boot log of every desktop VM.
xset -display "${DISPLAY}" -dpms 2>/dev/null || true

(
    while true; do
        openbox >/tmp/openbox.log 2>&1
        sleep 1
    done
) &

# Republish the loopback-only RFB port on vsock port 5900, where the host's
# /exec/:id/vnc route picks it up.
socat VSOCK-LISTEN:5900,fork,reuseaddr TCP:127.0.0.1:5901 >/tmp/vnc-bridge.log 2>&1 &
SOCAT_PID=$!

# Confirm the RFB port answers, so READY really does mean ready.
tries=0
until nc -z 127.0.0.1 5901 2>/dev/null; do
    tries=$((tries + 1))
    if [ "${tries}" -ge 100 ]; then
        echo "desktop: RFB port 5901 never accepted a connection" >&2
        exit 1
    fi
    sleep 0.1
done

# The probe above tests Xvnc's own port, not the bridge. socat dying on start
# (port collision, no vsock device) is the one failure a viewer only discovers as
# a 502 much later, so check it explicitly before claiming success.
#
# /proc, not `kill -0`: an exited background child is a zombie until the shell
# reaps it, and kill -0 answers 0 for a zombie — it would report a dead bridge
# as healthy.
#
# Sampled over a second rather than checked once: the RFB probe above is
# satisfied by Xvnc alone and returns immediately, so a socat that fails on its
# first syscall is often still alive at that instant.
socat_dead() {
    [ ! -r "/proc/${SOCAT_PID}/status" ] && return 0
    grep -q '^State:.*Z' "/proc/${SOCAT_PID}/status" 2>/dev/null && return 0
    return 1
}

tries=0
while [ "${tries}" -lt 10 ]; do
    if socat_dead; then
        echo "desktop: vsock bridge (socat) died on start" >&2
        cat /tmp/vnc-bridge.log >&2 2>/dev/null || true
        exit 1
    fi
    tries=$((tries + 1))
    sleep 0.1
done

echo "desktop: Xvnc on ${DISPLAY} (${DESKTOP_GEOMETRY}), RFB bridged to vsock 5900"
