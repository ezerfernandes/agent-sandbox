#!/bin/sh
set -e

[ -f /etc/profile ] && . /etc/profile 2>/dev/null || true
if [ -f /etc/environment ]; then
    export $(cat /etc/environment | grep -v '^#' | xargs) 2>/dev/null || true
fi

# Pseudo-filesystems. `docker export` ships no device nodes and mounts nothing, so
# the guest starts with empty /proc, /sys and /dev. Node and socat tolerate that;
# anything that reads /proc or needs /dev/null (Chromium, for one) does not.
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sysfs /sys 2>/dev/null || true
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mkdir -p /dev/pts /dev/shm 2>/dev/null || true
mount -t devpts devpts /dev/pts 2>/dev/null || true
mount -t tmpfs -o size=256m,mode=1777 tmpfs /dev/shm 2>/dev/null || true

mount -t tmpfs tmpfs /tmp
mount -t tmpfs -o size=512m,mode=0755 tmpfs /workspace

# Loopback. `docker export` carries no network configuration and nothing else in
# the guest brings lo up, so it boots DOWN with no address and 127.0.0.1 is
# unusable. Anything binding localhost fails with EADDRNOTAVAIL - the desktop
# template's `Xvnc -localhost` dies with "createTcpListeners: no addresses
# available", and a debug port or a local daemon would fail the same way.
ip link set lo up 2>/dev/null || true
ip addr add 127.0.0.1/8 dev lo 2>/dev/null || true

ip link set eth0 up 2>/dev/null || true

ip addr add 192.168.241.2/29 dev eth0 2>/dev/null || true
ip route add default via 192.168.241.1 dev eth0 2>/dev/null || true

# The root filesystem is mounted read-only, so writing /etc/resolv.conf in place
# fails silently and the guest ends up with no resolver at all. Fall back to a
# copy on tmpfs bind-mounted over it. The host redirects port 53 to its per-VM
# dnsmasq regardless of the address listed here.
if ! printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' >/etc/resolv.conf 2>/dev/null; then
    printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' >/tmp/resolv.conf
    mount -o bind /tmp/resolv.conf /etc/resolv.conf 2>/dev/null || true
fi

ip -family inet neigh flush any 2>/dev/null || true
ip -family inet6 neigh flush any 2>/dev/null || true

rm -f /tmp/runtime.sock

/bin/node /runtime/runtime.js &
NODE_PID=$!

while [ ! -S /tmp/runtime.sock ]; do
    sleep 0.05
done

/bin/socat \
    VSOCK-LISTEN:5000,fork \
    UNIX-CONNECT:/tmp/runtime.sock &

# Per-template boot hooks. A template drops executable scripts in
# /etc/sandbox/boot.d/ (the desktop template starts Xvnc and openbox there).
# Each hook must return only once its daemons are actually serving: READY is
# what create_snapshot.ts waits for before freezing memory, and a half-started
# process is frozen half-started. A failing hook must not abort boot, hence the
# `|| echo` under `set -e`.
if [ -d /etc/sandbox/boot.d ]; then
    for hook in /etc/sandbox/boot.d/*.sh; do
        [ -f "$hook" ] || continue
        echo "running boot hook: $hook"
        sh "$hook" || echo "boot hook failed: $hook"
    done
fi

echo "READY"

wait $NODE_PID
