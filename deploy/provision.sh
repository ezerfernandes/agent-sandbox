#!/usr/bin/env bash
#
# Provision a Debian/Ubuntu host to run agent-sandbox.
#
# Idempotent: safe to re-run. Every step checks for its own result first, so a
# partial run can simply be repeated.
#
#   sudo ./deploy/provision.sh                        # host setup only
#   sudo ./deploy/provision.sh --templates "node"     # also build templates
#   sudo ./deploy/provision.sh --install-service      # also install systemd unit
#   sudo ./deploy/provision.sh --skip-build           # re-provision, keep dist/
#
# What it deliberately does NOT do:
#   - create API keys (they must be created while the server is stopped; use
#     deploy/create-key.sh)
#   - start the service (you want to review the env file first)
#   - open any firewall port (the server speaks plain HTTP; keep it on loopback)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ARTIFACTS_DIR="${FIRECRACKER_ARTIFACTS_DIR:-/var/lib/agent-sandbox/artifacts}"
DEFAULT_KERNEL_URL="https://github.com/vivek1504/agent-sandbox/releases/download/Beta/vmlinux"
KERNEL_URL="${KERNEL_URL:-${DEFAULT_KERNEL_URL}}"
FC_UID="${FIRECRACKER_UID:-997}"
FC_GID="${FIRECRACKER_GID:-982}"
SERVICE_USER="${SERVICE_USER:-$(stat -c '%U' "${PROJECT_ROOT}")}"
CONFIG_DIR=/etc/agent-sandbox

# ---------------------------------------------------------------------------
# Pinned downloads
# ---------------------------------------------------------------------------
# Everything this script fetches is installed with root privileges and then run
# as root: the firecracker and jailer binaries, and the guest kernel every VM
# boots. Pinned by version and verified by checksum so a replaced, re-tagged or
# man-in-the-middled asset fails the run instead of being installed.
#
# To move to a newer firecracker: bump FC_VERSION and replace both digests with
# the ones from that release's own firecracker-<version>-<arch>.tgz.sha256.txt.
FC_VERSION="${FC_VERSION:-v1.17.0}"
FC_SHA256_x86_64="06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558"
FC_SHA256_aarch64="e351ebe4f7a16b5873bbd51005d2e6767103cff4d5ebc829df2d3f95a93e2256"

# sha256 of the guest kernel published at DEFAULT_KERNEL_URL. It applies only to
# that URL: pointing KERNEL_URL at your own kernel without supplying a matching
# KERNEL_SHA256 would otherwise fail the check against a digest for a different
# file, which reads as tampering rather than as the misconfiguration it is.
# Set KERNEL_SHA256 explicitly for a custom kernel, or to the empty string to
# skip verification deliberately (you will be warned).
DEFAULT_KERNEL_SHA256="e41c7048bd2475e7e788153823fcb9166a7e0b78c4c443bd6446d015fa735f53"
if [ -z "${KERNEL_SHA256+set}" ]; then
    if [ "${KERNEL_URL}" = "${DEFAULT_KERNEL_URL}" ]; then
        KERNEL_SHA256="${DEFAULT_KERNEL_SHA256}"
    else
        KERNEL_SHA256=""
    fi
fi

NODE_MAJOR_WANTED="${NODE_MAJOR_WANTED:-22}"

SKIP_PACKAGES=0
SKIP_KVM_CHECK=0
SKIP_BUILD=0
INSTALL_SERVICE=0
TEMPLATES=""

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Verify a downloaded file before anything is installed from it or executed.
# Always against a file on disk, never a pipe: a checksum can only be checked
# once the whole byte stream has been seen, so `curl | tar` cannot be verified
# at all.
verify_sha256() {
    local file="$1" expected="$2" what="$3" actual
    actual="$(sha256sum "${file}" | cut -d' ' -f1)"
    if [ "${actual}" != "${expected}" ]; then
        die "checksum mismatch for ${what}
  expected ${expected}
  actual   ${actual}
Refusing to install. Either the published asset changed, or the download was
tampered with. Confirm the digest upstream before overriding it here."
    fi
}

usage() {
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --skip-packages)   SKIP_PACKAGES=1 ;;
        --skip-kvm-check)  SKIP_KVM_CHECK=1 ;;
        --skip-build)      SKIP_BUILD=1 ;;
        --install-service) INSTALL_SERVICE=1 ;;
        --templates)       TEMPLATES="${2:-}"; shift ;;
        -h|--help)         usage ;;
        *)                 die "unknown argument: $1 (try --help)" ;;
    esac
    shift
done

[ "$(id -u)" -eq 0 ] || die "run as root: sudo $0 $*"

# ---------------------------------------------------------------------------
# 1. Hardware virtualisation
# ---------------------------------------------------------------------------
if [ "${SKIP_KVM_CHECK}" -eq 0 ]; then
    if [ ! -e /dev/kvm ]; then
        die "/dev/kvm is missing. Firecracker needs hardware virtualisation.
On AWS this means a bare-metal (*.metal) instance — KVM is not exposed on
normal Nitro instances. On most other VPS providers, ask support to enable
nested virtualisation. Re-run with --skip-kvm-check only to stage a host you
will not actually run VMs on."
    fi
    log "/dev/kvm present"
fi

# ---------------------------------------------------------------------------
# 2. Packages
# ---------------------------------------------------------------------------
if [ "${SKIP_PACKAGES}" -eq 0 ]; then
    log "installing packages"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq \
        ca-certificates curl git iproute2 iptables e2fsprogs \
        dnsmasq-base docker.io jq gnupg

    if ! command -v node >/dev/null 2>&1; then
        log "installing Node.js ${NODE_MAJOR_WANTED}"
        # NodeSource's own instructions are `curl … | bash -`, which runs an
        # unpinned remote script as root and whose content is whatever the
        # endpoint serves at that moment. The script's actual job is to add a
        # signing key and an apt source; done directly, apt verifies the
        # signature on every package that follows and no vendor code executes
        # here at all.
        install -d -m 0755 /usr/share/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
            | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
        chmod 0644 /usr/share/keyrings/nodesource.gpg
        printf 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' \
            "${NODE_MAJOR_WANTED}" > /etc/apt/sources.list.d/nodesource.list
        apt-get update -qq
        apt-get install -y -qq nodejs
    fi

    # The sandbox starts one dnsmasq per microVM. A system-wide resolver holding
    # port 53 collides with them, so the packaged service is disabled (the
    # binary from dnsmasq-base is what we actually need).
    if systemctl list-unit-files 2>/dev/null | grep -q '^dnsmasq\.service'; then
        systemctl disable --now dnsmasq >/dev/null 2>&1 || true
        log "disabled system-wide dnsmasq (per-VM instances are spawned by the server)"
    fi
else
    log "skipping package installation"
fi

command -v docker >/dev/null 2>&1 || die "docker is required for template builds"
command -v node   >/dev/null 2>&1 || die "node is required (v20+)"

NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "${NODE_MAJOR}" -ge 20 ] || die "node v20+ required, found v${NODE_MAJOR}"
log "node ${NODE_BIN} ($(node -v))"

# ---------------------------------------------------------------------------
# 3. Firecracker + jailer
# ---------------------------------------------------------------------------
if command -v firecracker >/dev/null 2>&1 && command -v jailer >/dev/null 2>&1; then
    log "firecracker already installed ($(firecracker --version | head -1))"
else
    ARCH="$(uname -m)"
    # Pinned rather than resolved from /releases/latest. "latest" is a moving
    # target: two hosts provisioned a week apart got different hypervisors, and
    # no digest can be pinned for a version that is not known in advance.
    FC_SHA256_VAR="FC_SHA256_${ARCH}"
    FC_SHA256="${FC_SHA256:-${!FC_SHA256_VAR:-}}"
    [ -n "${FC_SHA256}" ] || die "no pinned checksum for firecracker ${FC_VERSION} on ${ARCH}.
Fetch it from
  https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${ARCH}.tgz.sha256.txt
and pass it as FC_SHA256=<hex>."

    log "installing firecracker ${FC_VERSION} (${ARCH})"
    RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases"
    TMP="$(mktemp -d)"
    trap 'rm -rf "${TMP}"' EXIT

    curl -fsSL "${RELEASE_URL}/download/${FC_VERSION}/firecracker-${FC_VERSION}-${ARCH}.tgz" \
        -o "${TMP}/firecracker.tgz"
    verify_sha256 "${TMP}/firecracker.tgz" "${FC_SHA256}" "firecracker ${FC_VERSION} (${ARCH})"

    tar -xzf "${TMP}/firecracker.tgz" -C "${TMP}"
    install -m 0755 "${TMP}/release-${FC_VERSION}-${ARCH}/firecracker-${FC_VERSION}-${ARCH}" /usr/local/bin/firecracker
    install -m 0755 "${TMP}/release-${FC_VERSION}-${ARCH}/jailer-${FC_VERSION}-${ARCH}"      /usr/local/bin/jailer
    rm -rf "${TMP}"
    trap - EXIT
    log "installed $(firecracker --version | head -1)"
fi

# ---------------------------------------------------------------------------
# 4. Unprivileged user the jailer drops into
# ---------------------------------------------------------------------------
# The UID/GID are not arbitrary: they are the defaults src/vm/jailer.ts passes to
# the jailer. Override with FIRECRACKER_UID/FIRECRACKER_GID in both places or
# neither.
if ! getent group firecracker >/dev/null; then
    groupadd -g "${FC_GID}" firecracker
    log "created group firecracker (gid ${FC_GID})"
fi
if ! getent passwd firecracker >/dev/null; then
    # -r marks it a system account, which also suppresses the UID_MIN warning
    # useradd would otherwise print for an explicit uid below 1000.
    useradd -r -u "${FC_UID}" -g "${FC_GID}" -M -s /usr/sbin/nologin firecracker
    log "created user firecracker (uid ${FC_UID})"
fi

# ---------------------------------------------------------------------------
# 5. IPv4 forwarding (guest internet access)
# ---------------------------------------------------------------------------
# Not fatal: on container-backed or otherwise restricted hosts /proc/sys is
# read-only, and the operator needs to be told rather than have provisioning
# abort after every other step has already succeeded.
if sysctl -qw net.ipv4.ip_forward=1 2>/dev/null; then
    printf 'net.ipv4.ip_forward = 1\n' > /etc/sysctl.d/99-agent-sandbox.conf
    log "ipv4 forwarding enabled"
else
    warn "could not set net.ipv4.ip_forward — guests will have no internet access.
     On a restricted host, set it from the hypervisor side or ask the provider."
fi

# ---------------------------------------------------------------------------
# 6. Artifacts directory and guest kernel
# ---------------------------------------------------------------------------
mkdir -p "${ARTIFACTS_DIR}"
if [ -f "${ARTIFACTS_DIR}/vmlinux" ]; then
    log "guest kernel already present"
else
    log "downloading guest kernel"
    # Staged and verified before it reaches its destination. Downloading
    # straight to ${ARTIFACTS_DIR}/vmlinux leaves a truncated or wrong kernel in
    # place when the transfer or the check fails, and the "already present"
    # branch above then skips past it on every later run.
    KERNEL_TMP="$(mktemp -d)"
    trap 'rm -rf "${KERNEL_TMP}"' EXIT
    curl -fsSL "${KERNEL_URL}" -o "${KERNEL_TMP}/vmlinux"

    if [ -n "${KERNEL_SHA256}" ]; then
        verify_sha256 "${KERNEL_TMP}/vmlinux" "${KERNEL_SHA256}" "guest kernel from ${KERNEL_URL}"
        log "guest kernel checksum verified"
    else
        warn "KERNEL_SHA256 is empty — installing an unverified guest kernel.
     Every microVM on this host boots it as its kernel."
    fi

    install -m 0644 "${KERNEL_TMP}/vmlinux" "${ARTIFACTS_DIR}/vmlinux"
    rm -rf "${KERNEL_TMP}"
    trap - EXIT
fi
chown -R "root:firecracker" "${ARTIFACTS_DIR}"
chmod 750 "${ARTIFACTS_DIR}"
log "artifacts at ${ARTIFACTS_DIR}"

# ---------------------------------------------------------------------------
# 7. Build the project
# ---------------------------------------------------------------------------
if [ "${SKIP_BUILD}" -eq 0 ]; then
    # Installed unconditionally. Guarding on node_modules existing made a re-run
    # after a pull that adds a dependency a silent no-op — the tree stayed stale
    # in precisely the case the re-run was meant to repair, and the failure
    # surfaced later as a missing module at startup.
    if [ -f "${PROJECT_ROOT}/package-lock.json" ]; then
        # `npm ci` installs exactly the lockfile and removes anything else, which
        # is what a deploy wants; it also fails loudly if the lockfile and
        # package.json have drifted, rather than quietly resolving something new.
        log "installing npm dependencies (npm ci)"
        sudo -u "${SERVICE_USER}" -H bash -lc "cd '${PROJECT_ROOT}' && npm ci"
    else
        log "installing npm dependencies (npm install — no lockfile present)"
        sudo -u "${SERVICE_USER}" -H bash -lc "cd '${PROJECT_ROOT}' && npm install"
    fi
    # Built as the repo's owner rather than root: a root-owned dist/ breaks the
    # next plain `npm run build` the operator runs.
    log "compiling TypeScript"
    sudo -u "${SERVICE_USER}" -H bash -lc "cd '${PROJECT_ROOT}' && npm run build"
else
    log "skipping npm install/build"
fi

# ---------------------------------------------------------------------------
# 8. Config directory and env file
# ---------------------------------------------------------------------------
mkdir -p "${CONFIG_DIR}"
if [ ! -f "${CONFIG_DIR}/sandbox.env" ]; then
    install -m 0640 "${SCRIPT_DIR}/sandbox.env.example" "${CONFIG_DIR}/sandbox.env"
    log "wrote ${CONFIG_DIR}/sandbox.env — review it before starting the service"
else
    log "${CONFIG_DIR}/sandbox.env already exists, left untouched"
fi

# ---------------------------------------------------------------------------
# 9. Templates (optional — these take several minutes each)
# ---------------------------------------------------------------------------
if [ -n "${TEMPLATES}" ]; then
    for tpl in ${TEMPLATES}; do
        log "building template: ${tpl}"
        # build.sh must run as root and resolves its own node; NODE_BIN is
        # passed because sudo's secure_path hides a node installed under a user
        # home (nvm, fnm, volta).
        NODE_BIN="${NODE_BIN}" "${PROJECT_ROOT}/templates/build.sh" "${tpl}"
    done
    warn "rebuilding any template rebuilds the shared base image — rebuild ALL templates you use, or the others are left stale"
fi

# ---------------------------------------------------------------------------
# 10. systemd unit (optional)
# ---------------------------------------------------------------------------
if [ "${INSTALL_SERVICE}" -eq 1 ]; then
    log "installing systemd unit"
    mkdir -p /etc/systemd/system
    sed -e "s|@PROJECT_ROOT@|${PROJECT_ROOT}|g" \
        -e "s|@NODE_BIN@|${NODE_BIN}|g" \
        "${SCRIPT_DIR}/agent-sandbox.service" > /etc/systemd/system/agent-sandbox.service

    # The unit is written either way; only activation needs systemd to be the
    # running init (it is not, inside a container or a chroot).
    if command -v systemctl >/dev/null 2>&1; then
        systemctl daemon-reload
        systemctl enable agent-sandbox >/dev/null
        log "unit installed and enabled (not started)"
    else
        warn "systemctl not available — unit written to /etc/systemd/system/agent-sandbox.service but not enabled"
    fi
fi

cat <<EOF

$(log "provisioning complete")

Next steps:

  1. Review the configuration:
       \$EDITOR ${CONFIG_DIR}/sandbox.env

  2. Build at least one template (if you did not pass --templates):
       sudo ${PROJECT_ROOT}/templates/build.sh node

  3. Create an API key. The key store is read once at process start, so this
     must happen while the server is stopped — deploy/create-key.sh handles the
     stop/create/start cycle for you:
       sudo ${SCRIPT_DIR}/create-key.sh my-key exec,admin,metrics

  4. Start it:
       sudo systemctl start agent-sandbox
       sudo journalctl -u agent-sandbox -f

  5. From your workstation, tunnel rather than exposing the port — the server
     speaks plain HTTP and the API key is a bearer token:
       ssh -N -L 3000:localhost:3000 ${SERVICE_USER}@<host>

EOF
