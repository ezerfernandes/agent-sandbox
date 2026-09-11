#!/bin/bash
set -euo pipefail

TEMPLATE=${1:-node}
ARTIFACTS_DIR=${FIRECRACKER_ARTIFACTS_DIR:-/var/lib/agent-sandbox/artifacts}
TEMPLATE_DIR="${ARTIFACTS_DIR}/templates/${TEMPLATE}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root, e.g. sudo -E env VM_MEM_SIZE_MIB=1024 ./templates/build.sh ${TEMPLATE}" >&2
  exit 1
fi

# sudo replaces PATH with secure_path, which hides a node installed under a user
# home (nvm, fnm, volta). Resolve an absolute interpreter instead of relying on PATH.
if [ -z "${NODE_BIN:-}" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "${NODE_BIN}" ] && [ -n "${SUDO_USER:-}" ]; then
  SUDO_HOME="$(getent passwd "${SUDO_USER}" | cut -d: -f6)"
  for candidate in \
    "${SUDO_HOME}/.nvm/versions/node"/*/bin/node \
    "${SUDO_HOME}/.local/share/fnm/node-versions"/*/installation/bin/node \
    "${SUDO_HOME}/.volta/bin/node"; do
    if [ -x "${candidate}" ]; then NODE_BIN="${candidate}"; fi
  done
fi
if [ -z "${NODE_BIN}" ] || [ ! -x "${NODE_BIN}" ]; then
  echo "ERROR: node not found. Pass it explicitly:" >&2
  echo "  sudo -E env NODE_BIN=\"\$(command -v node)\" ./templates/build.sh ${TEMPLATE}" >&2
  exit 1
fi

TSC_BIN="${PROJECT_ROOT}/node_modules/typescript/bin/tsc"
if [ ! -f "${TSC_BIN}" ]; then
  echo "ERROR: ${TSC_BIN} missing. Run 'npm install' first (as your own user)." >&2
  exit 1
fi
echo "Using node: ${NODE_BIN} ($("${NODE_BIN}" -v))"

echo "=== Building template: ${TEMPLATE} ==="

echo "[1/4] Building base Docker image..."
docker build --no-cache -t agent-sandbox-base \
  -f "${SCRIPT_DIR}/base/Dockerfile" \
  "${PROJECT_ROOT}"

echo "[2/4] Building ${TEMPLATE} Docker image..."
docker build --no-cache -t "agent-sandbox-${TEMPLATE}" \
  -f "${SCRIPT_DIR}/${TEMPLATE}/Dockerfile" \
  "${PROJECT_ROOT}"

echo "[3/4] Exporting rootfs.ext4..."
ROOTFS_SIZE=${ROOTFS_SIZE:-1024} 
ROOTFS_PATH="/tmp/rootfs-${TEMPLATE}.ext4"

if mountpoint -q /tmp/mnt-* 2>/dev/null || grep -q "${ROOTFS_PATH}" /proc/mounts 2>/dev/null; then
  umount -l "${ROOTFS_PATH}" 2>/dev/null || true
fi

dd if=/dev/zero of="${ROOTFS_PATH}" bs=1M count=${ROOTFS_SIZE}
mkfs.ext4 -F "${ROOTFS_PATH}"

MOUNT_DIR=$(mktemp -d /tmp/mnt-XXXXXX)
cleanup() {
  if mountpoint -q "${MOUNT_DIR}" 2>/dev/null; then
    umount -l "${MOUNT_DIR}" 2>/dev/null || true
  fi
  rm -rf "${MOUNT_DIR}"
}
trap cleanup EXIT

mount -o loop "${ROOTFS_PATH}" "${MOUNT_DIR}"

CONTAINER_ID=$(docker create "agent-sandbox-${TEMPLATE}")
docker export "${CONTAINER_ID}" | tar -x -C "${MOUNT_DIR}"
docker rm "${CONTAINER_ID}" > /dev/null

umount "${MOUNT_DIR}"
trap - EXIT
rmdir "${MOUNT_DIR}"


echo "[4/4] Creating Firecracker snapshot..."
mkdir -p "${TEMPLATE_DIR}"
cp "${ROOTFS_PATH}" "${TEMPLATE_DIR}/rootfs.ext4"
rm "${ROOTFS_PATH}"

cd "${PROJECT_ROOT}"
"${NODE_BIN}" "${TSC_BIN}" -b

# No inner sudo: the script already runs as root, and a nested sudo would reset
# the environment and drop the VM_* resource vars before create_snapshot reads them.
rm -rf "/var/lib/agent-sandbox/jailer/firecracker/snap-${TEMPLATE}"
"${NODE_BIN}" dist/create_snapshot.js "${TEMPLATE}" "${TEMPLATE_DIR}/rootfs.ext4"

# tsc ran as root; hand dist/ back so a later non-sudo `npm run build` still works.
if [ -n "${SUDO_UID:-}" ] && [ -n "${SUDO_GID:-}" ]; then
  chown -R "${SUDO_UID}:${SUDO_GID}" "${PROJECT_ROOT}/dist" 2>/dev/null || true
fi

echo "=== Template '${TEMPLATE}' ready at ${TEMPLATE_DIR} ==="
ls -lh "${TEMPLATE_DIR}"
