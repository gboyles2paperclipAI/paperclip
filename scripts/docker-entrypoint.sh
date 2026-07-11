#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Authenticated containers need an agent-signing secret that is independent
# from Better Auth's board-session secret. Generate it once in the instance
# .env on the persistent /paperclip volume when the operator did not provide
# one explicitly. The server loads this file before it constructs adapters, so
# local adapters can receive a valid run-bound JWT on the first boot.
ensure_agent_jwt_secret() {
    if [ "${PAPERCLIP_DEPLOYMENT_MODE:-}" != "authenticated" ] || [ -n "${PAPERCLIP_AGENT_JWT_SECRET:-}" ]; then
        return
    fi

    config_path=${PAPERCLIP_CONFIG:-/paperclip/instances/default/config.json}
    env_file="$(dirname "$config_path")/.env"
    export PAPERCLIP_DOCKER_ENV_FILE="$env_file"
    node_script='const fs=require("node:fs");const path=require("node:path");const crypto=require("node:crypto");const file=process.env.PAPERCLIP_DOCKER_ENV_FILE;fs.mkdirSync(path.dirname(file),{recursive:true});const current=fs.existsSync(file)?fs.readFileSync(file,"utf8"):"";const pattern=/^PAPERCLIP_AGENT_JWT_SECRET[ \t]*=[ \t]*(.*)$/m;const match=current.match(pattern);if(match&&match[1].trim())process.exit(0);const secret=crypto.randomBytes(32).toString("hex");const line=`PAPERCLIP_AGENT_JWT_SECRET=${secret}`;const next=pattern.test(current)?current.replace(pattern,line):`${current}${current&&!current.endsWith("\n")?"\n":""}${line}\n`;const tmp=`${file}.tmp-${process.pid}`;fs.writeFileSync(tmp,next,{mode:0o600});fs.renameSync(tmp,file);fs.chmodSync(file,0o600);'
    if [ "$(id -u)" -eq 0 ]; then
        gosu node node -e "$node_script"
    else
        node -e "$node_script"
    fi
    unset PAPERCLIP_DOCKER_ENV_FILE node_script config_path env_file
}

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    ensure_agent_jwt_secret
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

ensure_agent_jwt_secret
exec gosu node "$@"
