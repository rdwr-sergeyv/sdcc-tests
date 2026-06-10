#!/usr/bin/env sh
set -eu

mkdir -p /var/log/sdcc /var/lib/sdcc/core/device_templates /var/lib/sdcc/portal /var/lock/sdcc

: "${SDCC_MONGO_HOST:=mongo}"
: "${SDCC_MONGO_PORT:=27017}"
: "${SDCC_MONGO_DB:=sdcc}"
: "${SDCC_BACKEND_NAME:=docker}"
: "${SDCC_BACKEND_ROLE:=hybrid}"
: "${SDCC_BACKEND_IP:=127.0.0.1}"
: "${SDCC_TASK_TYPE:=build}"

cat > /etc/sdcc/sdcc.conf <<EOF
portal:
  debug: true

force_diversion_type: ${SDCC_TASK_TYPE}

log:
  logdir: /var/log/sdcc
  verbosity: DEBUG

db:
  db: ${SDCC_MONGO_DB}
  host: ${SDCC_MONGO_HOST}
  port: ${SDCC_MONGO_PORT}
  user:
  password:

statistics:
  db: ${SDCC_MONGO_DB}
  host: ${SDCC_MONGO_HOST}
  port: ${SDCC_MONGO_PORT}
  user:
  password:

rb:
  db: ${SDCC_MONGO_DB}
  host: ${SDCC_MONGO_HOST}
  port: ${SDCC_MONGO_PORT}
  user:
  password:

backend:
  name: ${SDCC_BACKEND_NAME}
  ip_addr: ${SDCC_BACKEND_IP}
  role: ${SDCC_BACKEND_ROLE}
  workers:
    sdcc-sc-poller:
      collect_dp_policies_stats: true
EOF

if [ "${SDCC_DOCKER_BOOTSTRAP_DB:-1}" = "1" ]; then
  echo "Waiting for MongoDB at ${SDCC_MONGO_HOST}:${SDCC_MONGO_PORT}..."
  until nc -z "${SDCC_MONGO_HOST}" "${SDCC_MONGO_PORT}"; do
    sleep 1
  done

  python - <<'PY'
from sdcc.common.constants import USER_DEFAULT_MAX_REPORTS
from sdcc.common.db.dbtools import get_db
from sdcc.common.db_defaults.service_settings_const import SERVICE_SETTINGS
from sdcc.common.model.documents import SdccSettings
from sdcc.common.util.app_context import get_sdcc_basic_config
from sdcc.common.utils import crypt_generate_key
import os

conf = get_sdcc_basic_config(invalidate=True)
db = get_db(conf, busy_wait_proxy=True)
raw_db = db.pymongo_db

if raw_db.Settings.find_one() is None:
    print("Bootstrapping minimal SDCC defaults into MongoDB...")
    settings = SdccSettings()
    settings["master_key"] = crypt_generate_key()
    settings["scrubbing_center_type"] = "DEFAULT"
    settings["user_metadata"]["reports"]["max_reports"] = USER_DEFAULT_MAX_REPORTS
    settings["ng_invitation"]["recipients"] = ["twister@example.com"]
    settings["ng_invitation"]["service_url"] = os.environ.get("SDCC_PORTAL_PUBLIC_URL", "http://localhost:8000")
    settings["ng_invitation"]["subject"] = "SDCC invitation"
    settings.save()
else:
    print("SDCC Settings already present; skipping settings bootstrap.")

if raw_db.Services.find_one({"_id": "defense-pipe"}) is None:
    raw_db.Services.insert_one({"_id": "defense-pipe"})

if raw_db.ServiceSettings.find_one() is None:
    raw_db.ServiceSettings.insert_one(SERVICE_SETTINGS)

if raw_db.GlobalSettings.find_one({"name": "branding"}) is None:
    raw_db.GlobalSettings.insert_one({
        "name": "branding",
        "metadata": {
            "default": {
                "title": "SecurityDAM Portal",
                "service_name": "DefensePipe"
            }
        }
    })

backend_name = os.environ.get("SDCC_BACKEND_NAME", "docker")
backend_role = os.environ.get("SDCC_BACKEND_ROLE", "hybrid")
backend_ip = os.environ.get("SDCC_BACKEND_IP", "127.0.0.1")
# Register the backend ONLY if one with this name does not already exist. We never
# blindly overwrite an existing record: re-running the bootstrap must not rewrite
# its ip_addr/role (rewriting ip_addr would also collide with the unique ip_addr_1
# index whenever another backend already owns the target IP).
if raw_db.Backends.find_one({"name": backend_name}) is None:
    raw_db.Backends.insert_one({
        "name": backend_name,
        "ssh_user": "sdcc",
        "ssh_passwd": "",
        "licensed_modules": {},
        "replicate_backup": False,
        "ip_addr": backend_ip,
        "role": backend_role,
        "active": True,
    })
    print(f"Registered backend {backend_name!r} (ip={backend_ip}, role={backend_role}).")
else:
    print(f"Backend {backend_name!r} already registered; leaving existing record untouched.")
PY
fi

exec "$@"
