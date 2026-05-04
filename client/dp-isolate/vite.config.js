import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const portalTarget = process.env.PORTAL_ORIGIN || 'http://localhost:8000';
const clientRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = path.resolve(clientRoot, '../../..');
const lastProxyRequest = {
  method: '',
  url: '',
  hasCookie: false,
  hasSessionId: false,
  hasCsrfToken: false,
  forwardedCsrfHeader: false,
};

function loadDotenv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/))
      .filter(Boolean)
      .map((match) => {
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return [match[1], value];
      }),
  );
}

function getCookieValue(cookieHeader, name) {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .map((part) => part.match(/^([^=]+)=(.*)$/))
    .filter(Boolean)
    .find((match) => match[1] === name)?.[2] || '';
}

function dpIsolateConfigPlugin() {
  return {
    name: 'dp-isolate-config',
    configureServer(server) {
      function readEnv() {
        return {
          ...loadDotenv(path.join(workspaceRoot, '.env')),
          ...loadDotenv(path.join(workspaceRoot, 'docker', 'legacy-portal', '.env')),
          ...loadDotenv(path.join(clientRoot, '.env.local')),
          ...process.env,
        };
      }

      server.middlewares.use('/__dp-isolate-config', (request, response) => {
        if (request.method !== 'GET') {
          response.statusCode = 405;
          response.end();
          return;
        }

        const env = readEnv();
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            portalOrigin: portalTarget,
            username: env.PORTAL_USER || '',
            password: env.PORTAL_PASSWORD || '',
            autoLogin: env.DP_ISOLATE_AUTO_LOGIN !== '0',
            defaultAssetId: env.DP_ISOLATE_ASSET_ID || '',
          }),
        );
      });

      server.middlewares.use('/__dp-isolate-proxy-debug', (request, response) => {
        if (request.method !== 'GET') {
          response.statusCode = 405;
          response.end();
          return;
        }

        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(lastProxyRequest));
      });

      server.middlewares.use('/__dp-isolate-topology', (request, response) => {
        if (request.method !== 'GET') {
          response.statusCode = 405;
          response.end();
          return;
        }

        const env = readEnv();
        const container = env.LEGACY_PORTAL_MONGO_CONTAINER || 'legacy-portal-mongo-1';
        const dbName = env.SDCC_MONGO_DB || 'sdcc';
        const script = String.raw`
const zoneById = new Map(db.DPZones.find({}, { name: 1 }).toArray().map((zone) => [String(zone._id), zone.name]));
const attackZone = db.DPZones.findOne({ name: 'attack_zone' });
const scs = db.ScrubbingCenters.find({}, { name: 1, abbreviation: 1, backend: 1, management_devices: 1 }).toArray();
const backends = new Map(db.Backends.find({}, { name: 1, role: 1 }).toArray().map((backend) => [String(backend._id), backend]));
const scById = new Map(scs.map((sc) => [String(sc._id), sc]));
function dpDevices(sc) {
  return (sc.management_devices || []).filter((device) => device.role === 'radware-defensepro' || device.type === 'radware-defensepro');
}
function routerOutDevices(sc) {
  return (sc.management_devices || []).filter((device) => device.role === 'router-out');
}
function selectedRouterOuts(sc, diversion) {
  const topology = diversion && diversion.state && diversion.state.topology || {};
  const selectedIds = new Set(Object.entries(topology)
    .filter((entry) => entry[1] && (entry[1].selected || entry[1].implicit))
    .map((entry) => entry[0]));
  const selected = routerOutDevices(sc).filter((device) => selectedIds.has(String(device.unique_id)));
  return selected.length ? selected : routerOutDevices(sc);
}
function dpMatchesRouter(dp, router) {
  return (router.interfaces || []).some((iface) => String(iface.ingress) === String(dp.unique_id))
    && (dp.interfaces || []).some((iface) => String(iface.router_out) === String(router.unique_id));
}
function isDpStatusBlocked(sc, dp) {
  const status = db.ScrubbingCenterDeviceStatuses.findOne({
    '_id.scrubbing_center': sc._id,
    '_id.device_uid': dp.unique_id
  });
  if (!status) return false;
  if (dp.max_policies && dp.max_policies !== -1 && Number(dp.max_policies) * 0.96 < (status.num_policies || 0)) return true;
  return status.op_status === 2;
}
function selectedDefensePros(sc, diversion) {
  const topology = diversion && diversion.state && diversion.state.topology || {};
  return dpDevices(sc).filter((device) => topology[String(device.unique_id)] && topology[String(device.unique_id)].selected).map((device) => ({
    id: String(device.unique_id),
    name: device.name,
    zone: zoneById.get(String(device.zone)) || String(device.zone || ''),
    model: device.model || '',
    version: device.version || ''
  }));
}
function summarizeSc(sc, diversion) {
  const backend = backends.get(String(sc.backend));
  const devices = dpDevices(sc);
  const currentZoneId = diversion && diversion.zone ? String(diversion.zone) : '';
  const routersOut = selectedRouterOuts(sc, diversion);
  const attackZoneDpCount = attackZone
    ? devices.filter((device) => String(device.zone) === String(attackZone._id)).length
    : 0;
  const reservableAttackZoneDpCount = attackZone
    ? devices.filter((device) => String(device.zone) === String(attackZone._id)
        && !isDpStatusBlocked(sc, device)
        && routersOut.some((router) => dpMatchesRouter(device, router))).length
    : 0;
  return {
    id: String(sc._id),
    name: sc.name,
    abbreviation: sc.abbreviation || '',
    currentZone: currentZoneId ? (zoneById.get(currentZoneId) || currentZoneId) : '',
    backend: backend ? { id: String(backend._id), name: backend.name, role: backend.role || '' } : null,
    selectedDefensePros: selectedDefensePros(sc, diversion),
    defenseProCount: devices.length,
    attackZoneDpCount,
    reservableAttackZoneDpCount,
    deactivated: Boolean(diversion && diversion.state && diversion.state.deactivated),
    connectedTo: (diversion && diversion.state && diversion.state.sc_connected || []).map(String)
  };
}
const incidents = db.Incidents.find({ $or: [{ status: 'activated' }, { in_queue: true }] }, { asset: 1, status: 1, in_queue: 1, isolation_state: 1, diversion: 1 }).toArray();
const result = incidents.map((incident) => {
  const diversions = (incident.diversion || []).map((diversion) => {
    const sc = scById.get(String(diversion.sc_id));
    if (!sc) return null;
    return summarizeSc(sc, diversion);
  }).filter(Boolean);
  const primaryDiversions = diversions.filter((sc) => !sc.deactivated && sc.connectedTo.length === 0);
  const activeDiversions = diversions.filter((sc) => !sc.deactivated);
  const currentZones = Array.from(new Set(activeDiversions.map((sc) => sc.currentZone).filter(Boolean)));
  return {
    id: String(incident._id),
    assetId: String(incident.asset),
    status: incident.status || '',
    inQueue: Boolean(incident.in_queue),
    isolated: Boolean(incident.isolation_state && incident.isolation_state.isolated),
    currentZone: currentZones.length === 1 ? currentZones[0] : currentZones.length ? currentZones.join(', ') : '',
    diversions,
    primaryDiversions: primaryDiversions.length ? primaryDiversions : diversions.filter((sc) => !sc.deactivated)
  };
});
JSON.stringify({ reply: result });
`;

        try {
          const stdout = execFileSync('docker', ['exec', container, 'mongosh', dbName, '--quiet', '--eval', script], {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024 * 4,
          });
          response.setHeader('Content-Type', 'application/json');
          response.end(stdout.trim());
        } catch (error) {
          response.statusCode = 502;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ error: error.message }));
        }
      });
    },
  };
}

export default defineConfig({
  root: clientRoot,
  plugins: [dpIsolateConfigPlugin()],
  server: {
    port: Number(process.env.DP_ISOLATE_CLIENT_PORT || 5173),
    strictPort: false,
    proxy: {
      '/api': {
        target: portalTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            const cookie = request.headers.cookie || '';
            lastProxyRequest.method = request.method || '';
            lastProxyRequest.url = request.url || '';
            lastProxyRequest.hasCookie = Boolean(cookie);
            lastProxyRequest.hasSessionId = Boolean(getCookieValue(cookie, 'sessionid'));
            lastProxyRequest.hasCsrfToken = Boolean(getCookieValue(cookie, 'csrftoken'));
            lastProxyRequest.forwardedCsrfHeader = false;
            if (cookie) {
              proxyRequest.setHeader('Cookie', cookie);
            }

            const csrfToken = getCookieValue(cookie, 'csrftoken');
            if (csrfToken) {
              proxyRequest.setHeader('X-CSRFToken', csrfToken);
              lastProxyRequest.forwardedCsrfHeader = true;
            }
          });
        },
      },
    },
  },
});
