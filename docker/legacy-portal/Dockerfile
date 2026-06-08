# syntax=docker/dockerfile:1.7
FROM node:14-bullseye-slim AS portal-static-base

WORKDIR /opt/cddos-legacy/sdcc-portal

COPY --from=sdcc-portal-src sdcc_portal/portal/static/package.json /opt/cddos-legacy/sdcc-portal/sdcc_portal/portal/static/package.json

WORKDIR /opt/cddos-legacy/sdcc-portal/sdcc_portal/portal/static

RUN npm install

FROM portal-static-base AS portal-static

WORKDIR /opt/cddos-legacy/sdcc-portal

COPY --from=sdcc-portal-src . /opt/cddos-legacy/sdcc-portal

WORKDIR /opt/cddos-legacy/sdcc-portal/sdcc_portal/portal/static

RUN npm run build

FROM python:3.10-slim-bullseye AS portal-python-base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        git \
        libffi-dev \
        libxml2-dev \
        libxslt1-dev \
        netcat-openbsd \
        snmp \
        supervisor \
    && rm -rf /var/lib/apt/lists/* \
    # The SNMP poller (sc-poller) execs versioned net-snmp binaries by absolute path
    # (sdcc.common.constants.SNMP{GET,WALK,BULKWALK} = /usr/bin/snmp*-5.9.4), which
    # match a real SDCC appliance. Debian's "snmp" package installs the unsuffixed
    # binaries, so symlink the expected versioned names. Queries use numeric OIDs
    # with -Ofne, so no MIBs are required.
    && for b in snmpget snmpwalk snmpbulkwalk; do ln -sf /usr/bin/"$b" /usr/bin/"$b"-5.9.4; done

WORKDIR /opt/cddos-legacy

COPY --from=sdcc-src requirements.txt /tmp/sdcc-requirements.txt
COPY --from=sdcc-portal-src requirements.txt /tmp/sdcc-portal-requirements.txt

RUN pip install --upgrade pip 'setuptools<81' wheel \
    && pip install -r /tmp/sdcc-requirements.txt \
    && pip install -r /tmp/sdcc-portal-requirements.txt \
    && pip install 'setuptools<81'

FROM portal-python-base

WORKDIR /opt/cddos-legacy

COPY --from=sdcc-src . /opt/cddos-legacy/sdcc
COPY --from=sdcc-portal-src . /opt/cddos-legacy/sdcc-portal
COPY --from=portal-static /opt/cddos-legacy/sdcc-portal/sdcc_portal/portal/static/dist /opt/cddos-legacy/sdcc-portal/sdcc_portal/portal/static/dist
COPY sdcc.conf /etc/sdcc/sdcc.conf
COPY entrypoint.sh /usr/local/bin/sdcc-portal-entrypoint

RUN sed -i 's/\r$//' /usr/local/bin/sdcc-portal-entrypoint \
    && chmod +x /usr/local/bin/sdcc-portal-entrypoint \
    && mkdir -p /var/log/sdcc /var/lib/sdcc/core /var/lib/sdcc/portal /var/lock/sdcc \
    && pip install -e /opt/cddos-legacy/sdcc \
    && pip install -e /opt/cddos-legacy/sdcc-portal \
    && pip install 'setuptools<81'

# Lab-only dependency pin. Do NOT add this to the shared sdcc/ and sdcc-portal/
# requirements.txt — those are prod's and must stay untouched. httplib2 is an
# unpinned transitive dependency (pulled by google-api-python-client / oauth2client
# / google-auth-httplib2), so a fresh build floats it to a newer release whose
# auth.py calls pyparsing.DelimitedList. That symbol does not exist in the pinned
# pyparsing==3.0.9, so `import httplib2` raises AttributeError, which in turn breaks
# `import sdcc.management.executor.commands` and leaves import_policy() undefined —
# silently disabling all Policy Editor calls (no sdcc-policy-editor.log is created).
# Prod runs httplib2==0.22.0 (which uses the lowercase pp.delimitedList); match it
# here, as the final pip step so the editable installs above cannot override it.
RUN pip install 'httplib2==0.22.0'

# Override the node 'sdcc' control script: the slim container has no systemd/upstart,
# so delegate start/stop/restart/status to supervisord (which supervises this
# backend's modules). The original is kept as sdcc.real for other subcommands.
RUN if [ -e /usr/local/bin/sdcc ]; then mv /usr/local/bin/sdcc /usr/local/bin/sdcc.real; fi
COPY <<'SDCC_SHIM' /usr/local/bin/sdcc
#!/bin/bash
# Lab override: map node service control to supervisord; fall through to sdcc.real.
case "$1" in
  start)   exec supervisorctl start all ;;
  stop)    exec supervisorctl stop all ;;
  restart) exec supervisorctl restart all ;;
  status)  exec supervisorctl status ;;
  *)
    if [ -x /usr/local/bin/sdcc.real ]; then exec /usr/local/bin/sdcc.real "$@"; fi
    echo "Usage: sdcc {start|stop|restart|status}"; exit 1 ;;
esac
SDCC_SHIM
RUN chmod +x /usr/local/bin/sdcc

WORKDIR /opt/cddos-legacy/sdcc-portal/sdcc_portal

EXPOSE 8000

ENTRYPOINT ["sdcc-portal-entrypoint"]
CMD ["python", "manage.py", "runserver", "--verbosity", "3", "0.0.0.0:8000"]
