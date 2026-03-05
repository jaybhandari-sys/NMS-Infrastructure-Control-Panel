const planForm = document.getElementById('planForm');
const projectNameEl = document.getElementById('projectName');
const resourceGroupNameEl = document.getElementById('resourceGroupName');
const cameraCountEl = document.getElementById('cameraCount');
const camerasPerVmEl = document.getElementById('camerasPerVm');
const vmSizeEl = document.getElementById('vmSize');
const vmSizeListEl = document.getElementById('vmSizeList');
const themeToggleEl = document.getElementById('themeToggle');

const calculateBtn = document.getElementById('calculateBtn');
const setConfigBtn = document.getElementById('setConfigBtn');
const createBtn = document.getElementById('createBtn');

const summaryEl = document.getElementById('summary');
const vmListEl = document.getElementById('vmList');
const logsEl = document.getElementById('logs');
const jobStatusEl = document.getElementById('jobStatus');

let currentPlan = null;
let pollTimer = null;
let vmSizes = [];

function setStatus(label, cls) {
  jobStatusEl.textContent = label;
  jobStatusEl.className = `status ${cls}`;
}

function setButtonsDisabled(disabled) {
  calculateBtn.disabled = disabled;
  setConfigBtn.disabled = disabled;
  createBtn.disabled = disabled;
}

function getInitialTheme() {
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (themeToggleEl) {
    themeToggleEl.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
  }
}

function formPayload() {
  return {
    projectName: projectNameEl.value.trim(),
    resourceGroupName: resourceGroupNameEl.value.trim(),
    vmSize: vmSizeEl.value.trim(),
    cameraCount: Number(cameraCountEl.value),
    camerasPerVm: Number(camerasPerVmEl.value)
  };
}

function renderVmSizeOptions(items) {
  const selected = vmSizeEl.value;
  vmSizeListEl.innerHTML = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.name;
    option.label = `${item.name} (${item.vcpus || 0} vCPU, ${(item.memoryGb || 0).toFixed(1)} GB)`;
    vmSizeListEl.appendChild(option);
  }
  vmSizeEl.value = selected;
}

function filterVmSizes() {
  const search = vmSizeEl.value.trim().toLowerCase();
  const filtered = vmSizes.filter((item) => {
    if (search && !item.name.toLowerCase().includes(search)) return false;
    return true;
  });
  renderVmSizeOptions(filtered);
}

async function loadVmSizes() {
  setButtonsDisabled(true);
  try {
    setStatus('Running', 'status-running');
    const data = await callApi('/api/vm-sizes', 'GET');
    vmSizes = Array.isArray(data.sizes) ? data.sizes : [];
    filterVmSizes();
    logsEl.textContent = `VM sizes loaded for location: ${data.location}\nAvailable sizes: ${vmSizes.length}`;
    setStatus('Idle', 'status-idle');
  } catch (err) {
    logsEl.textContent = `Failed to load VM sizes: ${err.message}`;
    setStatus('Failed', 'status-failed');
  } finally {
    setButtonsDisabled(false);
  }
}

function renderPlan(plan) {
  currentPlan = plan;
  summaryEl.classList.remove('muted');
  summaryEl.innerHTML = `
    <strong>Project:</strong> ${plan.projectName}<br>
    <strong>Cameras:</strong> ${plan.cameraCount.toLocaleString()}<br>
    <strong>Cameras/VM:</strong> ${plan.camerasPerVm.toLocaleString()}<br>
    <strong>Total VMs:</strong> ${plan.vmCount.toLocaleString()}
  `;

  vmListEl.classList.remove('muted');
  vmListEl.innerHTML = plan.vmNames
    .map((name) => `<span class="vm-pill">${name}</span>`)
    .join('');
}

function renderError(message) {
  summaryEl.classList.remove('muted');
  summaryEl.textContent = message;
}

async function callApi(path, method, payload) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

async function calculatePlan() {
  const payload = formPayload();
  const data = await callApi('/api/plan', 'POST', payload);
  renderPlan(data.plan);
  return data.plan;
}

async function setConfig() {
  setButtonsDisabled(true);
  try {
    setStatus('Running', 'status-running');
    const payload = formPayload();
    await calculatePlan();
    const data = await callApi('/api/set-config', 'POST', payload);
    logsEl.textContent = `Config saved to: ${data.tfvarsPath}\nProject: ${data.plan.projectName}\nVM Count: ${data.plan.vmCount}`;
    setStatus('Success', 'status-success');
  } catch (err) {
    logsEl.textContent = err.message;
    setStatus('Failed', 'status-failed');
  } finally {
    setButtonsDisabled(false);
  }
}

async function runJob(endpoint) {
  try {
    setButtonsDisabled(true);
    setStatus('Running', 'status-running');

    const plan = currentPlan || (await calculatePlan());
    const data = await callApi(endpoint, 'POST', plan);
    logsEl.textContent = `Job ${data.jobId} queued...`;

    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(async () => {
      try {
        const job = await callApi(`/api/jobs/${data.jobId}`, 'GET');
        logsEl.textContent = job.job.logs.join('\n') || 'No logs yet...';
        logsEl.scrollTop = logsEl.scrollHeight;

        if (job.job.status === 'success') {
          setStatus('Success', 'status-success');
          clearInterval(pollTimer);
          setButtonsDisabled(false);
        }

        if (job.job.status === 'failed') {
          setStatus('Failed', 'status-failed');
          clearInterval(pollTimer);
          setButtonsDisabled(false);
        }
      } catch (err) {
        setStatus('Failed', 'status-failed');
        logsEl.textContent += `\nPolling failed: ${err.message}`;
        clearInterval(pollTimer);
        setButtonsDisabled(false);
      }
    }, 1500);
  } catch (err) {
    setStatus('Failed', 'status-failed');
    logsEl.textContent = err.message;
    setButtonsDisabled(false);
  }
}

calculateBtn.addEventListener('click', async () => {
  try {
    await calculatePlan();
    setStatus('Idle', 'status-idle');
  } catch (err) {
    renderError(err.message);
    setStatus('Failed', 'status-failed');
  }
});

createBtn.addEventListener('click', () => runJob('/api/create'));
setConfigBtn.addEventListener('click', setConfig);
vmSizeEl.addEventListener('input', filterVmSizes);

themeToggleEl.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
});

planForm.addEventListener('submit', (e) => {
  e.preventDefault();
  calculateBtn.click();
});

(async function init() {
  applyTheme(getInitialTheme());
  try {
    const health = await callApi('/api/health', 'GET');
    camerasPerVmEl.value = String(health.config.camerasPerVm || 500);
    await loadVmSizes();
  } catch {
    camerasPerVmEl.value = '500';
  }
})();
