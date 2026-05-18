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
    && rm -rf /var/lib/apt/lists/*

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

WORKDIR /opt/cddos-legacy/sdcc-portal/sdcc_portal

EXPOSE 8000

ENTRYPOINT ["sdcc-portal-entrypoint"]
CMD ["python", "manage.py", "runserver", "--verbosity", "3", "0.0.0.0:8000"]
