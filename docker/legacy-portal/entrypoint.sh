#!/usr/bin/env sh
set -eu

mkdir -p /var/log/sdcc /var/lib/sdcc/core /var/lib/sdcc/portal /var/lock/sdcc

: "${SDCC_MONGO_HOST:=mongo}"
: "${SDCC_MONGO_PORT:=27017}"
: "${SDCC_MONGO_DB:=sdcc}"

cat > /etc/sdcc/sdcc.conf <<EOF
portal:
  debug: true

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
  name: docker
  role: hybrid
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
PY
fi

exec "$@"
