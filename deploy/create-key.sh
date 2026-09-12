#!/usr/bin/env bash
#
# Create an API key safely on a host where agent-sandbox runs under systemd.
#
#   sudo ./deploy/create-key.sh <name> [scopes]
#   sudo ./deploy/create-key.sh webui exec,admin,metrics
#
# Why this script exists rather than calling the CLI directly:
#
#   The key store is read ONCE at process start and never re-read. A key created
#   while the server is running is invisible to it — every request with that key
#   answers 401 until a restart, which reads like a bad key rather than a stale
#   process. So: stop, create, start.
#
# The key is printed once and only its hash is stored. There is no way to
# recover it afterwards; losing it means creating another.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVICE="${SERVICE:-agent-sandbox}"
CONFIG_FILE="${CONFIG_FILE:-/etc/agent-sandbox/sandbox.env}"

NAME="${1:-}"
SCOPES="${2:-exec}"

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Read one variable out of the systemd EnvironmentFile the service runs with.
#
# Parsed, not sourced: systemd's format is not shell. `FOO=a b` is the literal
# value `a b` to systemd, but `.` would read it as an assignment followed by a
# command — sourcing a root-owned config file as a script is both wrong and
# needlessly dangerous.
env_value() {
    [ -f "${CONFIG_FILE}" ] || return 0
    sed -n "s/^[[:space:]]*$1=//p" "${CONFIG_FILE}" | tail -n 1
}

[ -n "${NAME}" ] || die "usage: sudo $0 <name> [scopes]   (scopes: exec,admin,metrics)"
[ "$(id -u)" -eq 0 ] || die "run as root: sudo $0 $*"
[ -f "${PROJECT_ROOT}/dist/auth/cli.js" ] || die "dist/auth/cli.js missing — run 'npm run build' first"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "${NODE_BIN}" ] || die "node not found. Pass it explicitly: NODE_BIN=/path/to/node sudo $0 $*"

# The CLI and the server each default AUTH_KEYS_PATH to
# /var/lib/agent-sandbox/keys.json independently. Customise it in sandbox.env and
# only the server moves: the CLI keeps writing to the default, and every request
# with the new key answers 401 forever. Nothing reports the mismatch — it looks
# exactly like a bad key. So the CLI is given the service's own configuration.
if [ -f "${CONFIG_FILE}" ]; then
    log "reading configuration from ${CONFIG_FILE}"
    CONFIGURED_KEYS_PATH="$(env_value AUTH_KEYS_PATH)"
    CONFIGURED_KEY_PREFIX="$(env_value AUTH_KEY_PREFIX)"
    CONFIGURED_PORT="$(env_value PORT)"

    if [ -n "${CONFIGURED_KEYS_PATH}" ]; then
        export AUTH_KEYS_PATH="${CONFIGURED_KEYS_PATH}"
    fi
    # Cosmetic only — verifyKey hashes the whole key, so a key minted under the
    # wrong prefix still authenticates. Matched anyway so `sk_live_` keys on a
    # production host are not silently issued looking like test keys.
    if [ -n "${CONFIGURED_KEY_PREFIX}" ]; then
        export AUTH_KEY_PREFIX="${CONFIGURED_KEY_PREFIX}"
    fi
    PORT="${PORT:-${CONFIGURED_PORT}}"
else
    warn "${CONFIG_FILE} not found — using built-in defaults.
     If the service runs with a different AUTH_KEYS_PATH, the key created here
     lands where the server will not look for it. Point CONFIG_FILE at the
     EnvironmentFile the unit actually uses."
fi

PORT="${PORT:-3000}"
KEYS_PATH="${AUTH_KEYS_PATH:-/var/lib/agent-sandbox/keys.json}"

WAS_ACTIVE=0
if systemctl is-active --quiet "${SERVICE}" 2>/dev/null; then
    WAS_ACTIVE=1
    log "stopping ${SERVICE} (the key store is only read at startup)"
    systemctl stop "${SERVICE}"
fi

# Restart the service even if key creation fails, so a typo does not leave the
# host with the sandbox down.
restore_service() {
    if [ "${WAS_ACTIVE}" -eq 1 ]; then
        log "starting ${SERVICE}"
        systemctl start "${SERVICE}"
    fi
}
trap restore_service EXIT

log "creating key '${NAME}' with scopes: ${SCOPES}"
log "key store: ${KEYS_PATH}"
cd "${PROJECT_ROOT}"
"${NODE_BIN}" dist/auth/cli.js create "${NAME}" --scopes "${SCOPES}"

cat <<EOF

Copy the key above now — only its hash is stored on disk.

Verify once the service is back up:

  curl -s -H "Authorization: Bearer <key>" http://localhost:${PORT}/exec/templates

A 401 here means the server is reading a different key store than
${KEYS_PATH} — check AUTH_KEYS_PATH in ${CONFIG_FILE}.

EOF
