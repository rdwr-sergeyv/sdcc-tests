import './styles.css';

const state = {
  history: JSON.parse(localStorage.getItem('dpIsolateHistory') || '[]'),
  assets: [],
  config: null,
};

const elements = {
  loginForm: document.querySelector('#loginForm'),
  username: document.querySelector('#username'),
  password: document.querySelector('#password'),
  assetSearch: document.querySelector('#assetSearch'),
  assetList: document.querySelector('#assetList'),
  refreshAssets: document.querySelector('#refreshAssets'),
  clientValidations: document.querySelector('#clientValidations'),
  assetId: document.querySelector('#assetId'),
  requestPreview: document.querySelector('#requestPreview'),
  sessionBadge: document.querySelector('#sessionBadge'),
  statusBadge: document.querySelector('#statusBadge'),
  responseBox: document.querySelector('#responseBox'),
  lastRequest: document.querySelector('#lastRequest'),
  resultMeta: document.querySelector('#resultMeta'),
  history: document.querySelector('#history'),
  clearHistory: document.querySelector('#clearHistory'),
  actionButtons: Array.from(document.querySelectorAll('[data-action]')),
};

elements.username.value = localStorage.getItem('dpIsolateUsername') || '';
elements.clientValidations.checked = localStorage.getItem('dpIsolateClientValidations') !== '0';

function compactAsset(asset) {
  const siteNames = (asset.asset_site_data || asset.assetSiteData || [])
    .map((site) => site.site_name)
    .filter(Boolean)
    .join(', ');
  return {
    id: asset?._id?._oid || asset?._id || '',
    name: asset?.name || '(unnamed asset)',
    address: asset?.address || '',
    mask: asset?.mask ?? '',
    status: asset?.status || '',
    advStatus: asset?.adv_status || '',
    attackStatus: asset?.attack_status?.agg_attack_status || '',
    type: asset?._class || asset?.type || '',
    sites: siteNames,
    incident: null,
    applicable: false,
  };
}

function oid(value) {
  return value?._oid || value?._id?._oid || value?._id || value || '';
}

function compactIncident(incident) {
  return {
    id: oid(incident?._id),
    assetId: oid(incident?.asset),
    status: incident?.status || '',
    inQueue: Boolean(incident?.in_queue),
    isolated: Boolean(incident?.isolation_state?.isolated),
    topology: null,
  };
}

function topologyLabel(incident) {
  const primary = incident?.topology?.primaryDiversions || [];
  if (!incident) return 'off-cloud';
  if (!primary.length) return 'no primary SC';
  const names = primary.map((sc) => sc.abbreviation || sc.name).filter(Boolean).join(', ');
  return names || 'unknown SC';
}

function backendLabel(incident) {
  const primary = incident?.topology?.primaryDiversions || [];
  const labels = primary
    .map((sc) => sc.backend?.name || sc.backend?.role)
    .filter(Boolean);
  return labels.length ? labels.join(', ') : 'no backend';
}

function attackZoneLabel(incident) {
  const primary = incident?.topology?.primaryDiversions || [];
  if (!incident) return 'off-cloud';
  if (!primary.length) return 'not ready';
  const attackZoneDpCount = primary.reduce((sum, sc) => sum + (sc.attackZoneDpCount || 0), 0);
  return attackZoneDpCount > 0 ? `${attackZoneDpCount} Attack Zone DP${attackZoneDpCount === 1 ? '' : 's'}` : 'no Attack Zone DPs';
}

function selectedDpLabel(incident) {
  const primary = incident?.topology?.primaryDiversions || [];
  const names = primary.flatMap((sc) => sc.selectedDefensePros || []).map((dp) => dp.name);
  return names.length ? names.join(', ') : 'no selected DPs';
}

function setBadge(element, text, tone = 'neutral') {
  element.textContent = text;
  element.dataset.tone = tone;
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isHtmlResponse(body, contentType) {
  return contentType.includes('text/html') || (typeof body === 'string' && /^\s*<!doctype html/i.test(body));
}

function httpSummary(response, contentType, unexpectedHtml) {
  const statusText = response.statusText ? ` ${response.statusText}` : '';
  const typeText = contentType ? `; ${contentType}` : '';
  const htmlText = unexpectedHtml ? '; HTML response, likely not the backend endpoint' : '';
  return `HTTP ${response.status}${statusText}; ok=${response.ok}${typeText}${htmlText}`;
}

function currentAssetId() {
  const form = document.querySelector('#actionForm');
  const formValue = form ? new FormData(form).get('assetId') : '';
  const liveInput = document.querySelector('#assetId');
  const pickerSearch = document.querySelector('#assetSearch');
  return String(formValue || liveInput?.value || pickerSearch?.value || '').trim();
}

function currentActionPath(action = 'enable') {
  const assetId = currentAssetId();
  return `/api/incident/isolation/${action}/${assetId || '{asset_id}'}`;
}

function updateRequestPreview() {
  elements.requestPreview.textContent = `POST ${currentActionPath('enable')}`;
}

function remember(entry) {
  state.history.unshift(entry);
  state.history = state.history.slice(0, 20);
  localStorage.setItem('dpIsolateHistory', JSON.stringify(state.history));
  renderHistory();
}

function renderHistory() {
  elements.history.innerHTML = '';
  if (!state.history.length) {
    elements.history.innerHTML = '<p class="muted">No requests yet.</p>';
    return;
  }

  for (const item of state.history) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-row';
    row.innerHTML = `
      <span>${item.action.toUpperCase()} ${item.assetId}</span>
      <strong>${item.status}</strong>
      <small>${item.time}</small>
    `;
    row.addEventListener('click', () => {
      elements.responseBox.textContent = pretty(item);
      elements.lastRequest.textContent = `${item.method} ${item.path}`;
      elements.resultMeta.textContent = item.httpSummary || `HTTP ${item.status}; ok=${item.ok}`;
      setBadge(elements.statusBadge, item.badge || String(item.status), item.ok && !item.unexpectedHtml ? 'good' : 'bad');
    });
    elements.history.appendChild(row);
  }
}

function renderAssets() {
  const query = elements.assetSearch.value.trim().toLowerCase();
  const validateClientSide = elements.clientValidations.checked;
  const assets = state.assets
    .filter((asset) => {
      if (!query) return true;
      return [
        asset.id,
        asset.name,
        asset.address,
        asset.status,
        asset.advStatus,
        asset.attackStatus,
        asset.type,
        asset.sites,
        asset.incident?.id,
        asset.incident?.status,
        topologyLabel(asset.incident),
        backendLabel(asset.incident),
        attackZoneLabel(asset.incident),
        selectedDpLabel(asset.incident),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    })
    .slice(0, 80);

  elements.assetList.innerHTML = '';
  if (!assets.length) {
    elements.assetList.innerHTML = '<p class="muted">No matching assets.</p>';
    return;
  }

  for (const asset of assets) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'asset-row';
    row.disabled = validateClientSide && !asset.applicable;
    if (!asset.applicable) {
      row.classList.add('asset-row-disabled');
      row.title = asset.incident
        ? 'Not applicable: primary scrubbing center has no DefensePros in Attack Zone.'
        : 'Not applicable: no active incident is associated with this asset.';
    }
    row.innerHTML = `
      <span>
        <strong>${asset.name}</strong>
        <small>${asset.address}${asset.mask !== '' ? `/${asset.mask}` : ''} ${asset.sites ? `- ${asset.sites}` : ''}</small>
      </span>
      <span class="asset-status">
        <em data-status="${asset.status || 'unknown'}">${asset.status || 'unknown'}</em>
        <small>${asset.incident ? 'active incident' : 'no active incident'}</small>
      </span>
      <span class="asset-status">
        <em>${asset.incident?.status || 'none'}</em>
        <small>${asset.incident?.inQueue ? 'queued' : asset.incident?.isolated ? 'isolated' : asset.incident ? 'ready' : 'off-cloud'}</small>
      </span>
      <span class="asset-status sc-status">
        <em data-readiness="${asset.applicable ? 'ready' : 'blocked'}">${topologyLabel(asset.incident)}</em>
        <small>${backendLabel(asset.incident)}; ${attackZoneLabel(asset.incident)}</small>
        <small>${selectedDpLabel(asset.incident)}</small>
      </span>
      <span class="id-stack">
        <code>${asset.id}</code>
        <small>${asset.incident?.id ? `incident ${asset.incident.id}` : 'no incident'}</small>
      </span>
    `;
    if (asset.applicable || !validateClientSide) {
      row.addEventListener('click', () => {
        elements.assetId.value = asset.id;
        localStorage.setItem('dpIsolateAssetId', asset.id);
        updateRequestPreview();
      });
    }
    elements.assetList.appendChild(row);
  }
}

async function loadAssets() {
  elements.assetList.innerHTML = '<p class="muted">Loading assets...</p>';
  const [assetResponse, incidentResponse, topologyResponse] = await Promise.all([
    fetch('/api/assets/?size=500&sort=name', { credentials: 'include' }),
    fetch('/api/incident/active-and-queue', { credentials: 'include' }),
    fetch('/__dp-isolate-topology', { credentials: 'same-origin' }).catch(() => null),
  ]);
  const assetBody = parseBody(await assetResponse.text());
  const incidentBody = parseBody(await incidentResponse.text());
  const topologyBody = topologyResponse ? parseBody(await topologyResponse.text()) : null;
  if (!assetResponse.ok || !incidentResponse.ok) {
    elements.assetList.innerHTML =
      `<p class="muted">Asset load failed: assets HTTP ${assetResponse.status}, incidents HTTP ${incidentResponse.status}</p>`;
    elements.responseBox.textContent = pretty({
      assets: { status: assetResponse.status, body: assetBody },
      incidents: { status: incidentResponse.status, body: incidentBody },
    });
    return;
  }

  const incidents = (incidentBody?.reply || []).map(compactIncident).filter((incident) => incident.assetId);
  const topologyByIncidentId = new Map((topologyBody?.reply || []).map((item) => [item.id, item]));
  const topologyByAssetId = new Map((topologyBody?.reply || []).map((item) => [item.assetId, item]));
  for (const incident of incidents) {
    incident.topology = topologyByIncidentId.get(incident.id) || topologyByAssetId.get(incident.assetId) || null;
  }
  const incidentByAssetId = new Map(incidents.map((incident) => [incident.assetId, incident]));
  const assetsById = new Map();
  for (const asset of (assetBody?.reply || assetBody?.objects || assetBody?.results || [])) {
    const compact = compactAsset(asset);
    if (!compact.id) continue;
    compact.incident = incidentByAssetId.get(compact.id) || null;
    compact.applicable = Boolean(
      compact.incident
      && (compact.incident.topology?.primaryDiversions || []).some((sc) => (sc.attackZoneDpCount || 0) > 0),
    );
    assetsById.set(compact.id, compact);
  }

  for (const incident of incidentBody?.reply || []) {
    const assetId = oid(incident?.asset);
    if (!assetId || assetsById.has(assetId)) continue;
    const compact = compactAsset(incident.asset);
    compact.incident = compactIncident(incident);
    compact.incident.topology = topologyByIncidentId.get(compact.incident.id) || topologyByAssetId.get(assetId) || null;
    compact.applicable = Boolean(
      compact.incident
      && (compact.incident.topology?.primaryDiversions || []).some((sc) => (sc.attackZoneDpCount || 0) > 0),
    );
    assetsById.set(assetId, compact);
  }

  state.assets = Array.from(assetsById.values()).sort((a, b) => {
    if (Boolean(a.incident) !== Boolean(b.incident)) return a.incident ? -1 : 1;
    if (a.applicable !== b.applicable) return a.applicable ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  renderAssets();
}

async function checkSession() {
  const response = await fetch('/api/auth/', { credentials: 'include' });
  const text = await response.text();
  const body = parseBody(text);
  if (response.ok && body?.username) {
    setBadge(elements.sessionBadge, `Logged in as ${body.username}`, 'good');
    loadAssets().catch((error) => {
      elements.assetList.innerHTML = `<p class="muted">Asset load failed: ${error.message}</p>`;
    });
    return true;
  }
  setBadge(elements.sessionBadge, 'Not logged in', 'bad');
  return false;
}

async function login(event) {
  event.preventDefault();
  await loginWithFields();
}

async function loginWithFields() {
  const username = elements.username.value.trim();
  const password = elements.password.value;
  if (!username || !password) {
    setBadge(elements.sessionBadge, 'Missing credentials', 'bad');
    return;
  }

  setBadge(elements.sessionBadge, 'Logging in...', 'neutral');
  const response = await fetch('/api/auth/', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u: username, p: password }),
  });
  const body = parseBody(await response.text());
  localStorage.setItem('dpIsolateUsername', username);
  elements.responseBox.textContent = pretty({ status: response.status, body });
  if (response.ok) {
    setBadge(elements.sessionBadge, `Logged in as ${body.username || username}`, 'good');
    await loadAssets();
  } else {
    setBadge(elements.sessionBadge, 'Login failed', 'bad');
  }
}

async function loadConfig() {
  const response = await fetch('/__dp-isolate-config', { credentials: 'same-origin' });
  if (!response.ok) return null;
  return response.json();
}

async function loadProxyDebug() {
  const response = await fetch('/__dp-isolate-proxy-debug', { credentials: 'same-origin' });
  if (!response.ok) return null;
  return response.json();
}

async function sendIsolation(action) {
  const assetId = currentAssetId();
  const trigger = document.querySelector('input[name="trigger"]:checked').value;
  if (elements.clientValidations.checked && !/^[a-fA-F0-9]{24}$/.test(assetId)) {
    setBadge(elements.statusBadge, 'Invalid asset ID', 'bad');
    elements.responseBox.textContent = pretty({ error: 'Asset ID must be a 24-character ObjectId.' });
    elements.resultMeta.textContent = `Will send: ${currentActionPath(action)}`;
    return;
  }

  localStorage.setItem('dpIsolateAssetId', assetId);
  const path = currentActionPath(action).replace('{asset_id}', '');
  const payload = action === 'enable' ? { trigger } : {};
  elements.lastRequest.textContent = `POST ${path}`;
  setBadge(elements.statusBadge, 'Sending...', 'neutral');

  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const contentType = response.headers.get('content-type') || '';
  const body = parseBody(await response.text());
  const proxyDebug = await loadProxyDebug().catch(() => null);
  const unexpectedHtml = isHtmlResponse(body, contentType);
  const summary = httpSummary(response, contentType, unexpectedHtml);
  const result = {
    time: new Date().toLocaleTimeString(),
    method: 'POST',
    path,
    action,
    assetId,
    trigger: action === 'enable' ? trigger : undefined,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    contentType,
    unexpectedHtml,
    httpSummary: summary,
    proxyDebug,
    body,
  };

  elements.responseBox.textContent = pretty(result);
  elements.resultMeta.textContent = summary;
  setBadge(
    elements.statusBadge,
    unexpectedHtml ? `${response.status} HTML` : String(response.status),
    response.ok && !unexpectedHtml ? 'good' : 'bad',
  );
  remember(result);
}

elements.loginForm.addEventListener('submit', login);
elements.assetSearch.addEventListener('input', () => {
  renderAssets();
  updateRequestPreview();
});
elements.assetId.addEventListener('input', updateRequestPreview);
elements.refreshAssets.addEventListener('click', () => loadAssets().catch((error) => {
  elements.assetList.innerHTML = `<p class="muted">Asset load failed: ${error.message}</p>`;
}));
elements.clientValidations.addEventListener('change', () => {
  localStorage.setItem('dpIsolateClientValidations', elements.clientValidations.checked ? '1' : '0');
  renderAssets();
});
elements.clearHistory.addEventListener('click', () => {
  state.history = [];
  localStorage.removeItem('dpIsolateHistory');
  renderHistory();
});
for (const button of elements.actionButtons) {
  button.addEventListener('click', () => sendIsolation(button.dataset.action));
}

renderHistory();
updateRequestPreview();
loadConfig()
  .then(async (config) => {
    state.config = config;
    if (config?.username) {
      elements.username.value = config.username;
      localStorage.setItem('dpIsolateUsername', config.username);
    }
    if (config?.password) {
      elements.password.value = config.password;
    }
    elements.assetId.value = config?.defaultAssetId || localStorage.getItem('dpIsolateAssetId') || '';
    updateRequestPreview();
    if (config?.defaultAssetId) {
      localStorage.setItem('dpIsolateAssetId', config.defaultAssetId);
    }

    const sessionActive = await checkSession();
    if (!sessionActive && config?.autoLogin && config.username && config.password) {
      await loginWithFields();
    }
  })
  .catch(() => {
    elements.assetId.value = localStorage.getItem('dpIsolateAssetId') || '';
    updateRequestPreview();
    return checkSession().catch(() => setBadge(elements.sessionBadge, 'Portal unavailable', 'bad'));
  });
