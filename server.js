const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

function loadDotEnv(dotenvPath = path.resolve('./.env')) {
  if (!fs.existsSync(dotenvPath)) return;
  const content = fs.readFileSync(dotenvPath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const PORT = Number(process.env.PORT || 3003);
const HOST = process.env.HOST || '127.0.0.1';
const NODE_ENV = process.env.NODE_ENV || 'production';
const INFRA_ROOT = path.resolve(process.env.INFRA_ROOT || '.');
const DEFAULT_STATIC_TFVARS = '/home/sanket/ele-infra/terraform/terraform.tfvars';
const RESOLVED_STATIC_TFVARS = path.resolve(process.env.TERRAFORM_STATIC_TFVARS || DEFAULT_STATIC_TFVARS);
const VM_SIZES_CACHE_PATH = path.resolve('./.runtime/azure-vm-sizes-cache.json');

const CONFIG = {
  camerasPerVm: Number(process.env.CAMERAS_PER_VM || 500),
  maxVmCount: Number(process.env.MAX_VM_COUNT || 5000),
  allowedOrigin: process.env.ALLOWED_ORIGIN || 'http://127.0.0.1:3003',
  terraformBin: process.env.TERRAFORM_BIN || 'terraform',
  terraformDir: path.resolve(process.env.TERRAFORM_DIR || path.dirname(RESOLVED_STATIC_TFVARS)),
  terraformStaticTfvars: RESOLVED_STATIC_TFVARS,
  useStaticTfvars: String(process.env.USE_STATIC_TFVARS || 'true') === 'true',
  tfProjectVar: process.env.TF_PROJECT_VAR || 'project_name',
  tfCameraCountVar: process.env.TF_CAMERA_COUNT_VAR || 'camera_count',
  tfVmCountVar: process.env.TF_VM_COUNT_VAR || 'vm_count',
  tfVmNamesVar: process.env.TF_VM_NAMES_VAR || 'vm_names',
  requireAzureLogin: String(process.env.REQUIRE_AZ_LOGIN || 'true') === 'true'
};

const PUBLIC_DIR = path.resolve('./public');
const jobs = new Map();

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': CONFIG.allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

function sanitizeProjectName(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function computePlan(projectName, cameraCount, customCamerasPerVm) {
  const cameras = Number(cameraCount);
  const perVm = Number(customCamerasPerVm || CONFIG.camerasPerVm);
  const sanitizedProject = sanitizeProjectName(projectName);

  if (!sanitizedProject) {
    throw new Error('Project name is required and must contain letters or numbers.');
  }
  if (!Number.isFinite(cameras) || cameras <= 0) {
    throw new Error('Camera count must be a positive number.');
  }
  if (!Number.isFinite(perVm) || perVm <= 0) {
    throw new Error('Cameras per VM must be a positive number.');
  }

  const vmCount = Math.ceil(cameras / perVm);
  if (vmCount > CONFIG.maxVmCount) {
    throw new Error(`VM count ${vmCount} exceeds configured limit ${CONFIG.maxVmCount}.`);
  }

  const vmNames = Array.from({ length: vmCount }, (_, idx) => `${sanitizedProject}${idx + 1}`);
  return {
    projectName: sanitizedProject,
    cameraCount: cameras,
    camerasPerVm: perVm,
    vmCount,
    vmNames
  };
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON payload.');
  }
}

function toHclString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function toHclList(values) {
  return `[${values.map((v) => toHclString(v)).join(', ')}]`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceTfvarsKey(content, key, value) {
  const lines = content.split(/\r?\n/);
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (keyPattern.test(line)) {
      lines[i] = `${key} = ${value}`;
      return { content: lines.join('\n'), replaced: true };
    }
  }
  return { content, replaced: false };
}

function removeTfvarsKey(content, key) {
  const lines = content.split(/\r?\n/);
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  return lines.filter((line) => !keyPattern.test(line)).join('\n');
}

function buildManagedTfvars(plan, resourceGroupName, existingContent = '') {
  let content = existingContent || '';
  if (!content.trim()) {
    throw new Error('Static tfvars file is empty. Refusing to add/remove variables automatically.');
  }

  // Cleanup from older app versions that wrote undeclared key `project`.
  content = removeTfvarsKey(content, 'project');

  const resolvedResourceGroup = resourceGroupName ? toHclString(resourceGroupName) : null;
  const vmSize = String(plan.vmSize || '').trim();
  const requiredUpdates = [
    { key: 'resource_group_name', value: resolvedResourceGroup },
    { key: 'project_name', value: toHclString(plan.projectName) },
    { key: 'vm_count', value: String(plan.vmCount) },
    { key: 'vm_name', value: toHclString(plan.projectName) },
    { key: 'vm_size', value: vmSize ? toHclString(vmSize) : null }
  ].filter((item) => item.value !== null);

  for (const update of requiredUpdates) {
    const replaced = replaceTfvarsKey(content, update.key, update.value);
    if (!replaced.replaced) {
      throw new Error(`Required key '${update.key}' not found in static tfvars. Refusing to add/remove keys.`);
    }
    content = replaced.content;
  }

  return content;
}

async function writeManagedTfvars(plan, resourceGroupName) {
  const targetPath = CONFIG.terraformStaticTfvars;
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Static tfvars file not found: ${targetPath}. Refusing to create a new file/path.`);
  }
  let existingContent = '';
  existingContent = await fsp.readFile(targetPath, 'utf-8');
  const content = buildManagedTfvars(plan, resourceGroupName, existingContent);
  await fsp.writeFile(targetPath, content, 'utf-8');
  return { path: targetPath, content };
}

function runCommandCapture(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      shell: false
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf-8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf-8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error((stderr || `Command exited with code ${code}`).trim()));
      }
    });
  });
}

async function listAzureVmSizes(locationQuery, searchQuery) {
  let sizes = [];
  let source = 'azure';
  try {
    if (CONFIG.requireAzureLogin) {
      await runCommandCapture('az', ['account', 'show']);
    }
    const result = await runCommandCapture('az', [
      'vm',
      'list-skus',
      '--resource-type',
      'virtualMachines',
      '--all',
      '-o',
      'json'
    ]);
    const raw = JSON.parse(result.stdout);
    const map = new Map();
    for (const item of raw) {
      if (!item || item.resourceType !== 'virtualMachines' || !item.name) continue;
      const caps = Array.isArray(item.capabilities) ? item.capabilities : [];
      const vcpus = Number((caps.find((c) => c && c.name === 'vCPUs') || {}).value || 0);
      const memoryGb = Number((caps.find((c) => c && c.name === 'MemoryGB') || {}).value || 0);
      if (!map.has(item.name)) {
        map.set(item.name, { name: item.name, vcpus, memoryGb });
      }
    }
    sizes = Array.from(map.values());
    await fsp.mkdir(path.dirname(VM_SIZES_CACHE_PATH), { recursive: true });
    await fsp.writeFile(VM_SIZES_CACHE_PATH, JSON.stringify(sizes), 'utf-8');
  } catch {
    source = 'cache';
    if (fs.existsSync(VM_SIZES_CACHE_PATH)) {
      const cached = await fsp.readFile(VM_SIZES_CACHE_PATH, 'utf-8');
      sizes = JSON.parse(cached);
    } else {
      throw new Error("Azure VM sizes unavailable. Run 'az login' once on this server.");
    }
  }

  const search = String(searchQuery || '').trim().toLowerCase();
  const filtered = sizes
    .filter((s) => (search ? s.name.toLowerCase().includes(search) : true))
    .sort((a, b) => a.vcpus - b.vcpus || a.name.localeCompare(b.name));

  return {
    location: String(locationQuery || 'all').trim() || 'all',
    source,
    sizes: filtered
  };
}

function createJob(type, plan) {
  const id = crypto.randomUUID();
  const job = {
    id,
    type,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    plan,
    logs: [],
    error: null
  };
  jobs.set(id, job);
  return job;
}

function appendJobLog(job, line) {
  const message = `[${new Date().toISOString()}] ${line}`;
  job.logs.push(message);
  if (job.logs.length > 5000) {
    job.logs = job.logs.slice(-5000);
  }
}

function runCommand(job, cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    appendJobLog(job, `Running: ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      shell: false
    });

    child.stdout.on('data', (d) => appendJobLog(job, d.toString('utf-8').trimEnd()));
    child.stderr.on('data', (d) => appendJobLog(job, d.toString('utf-8').trimEnd()));

    child.on('error', (err) => {
      appendJobLog(job, `Command failed to start: ${err.message}`);
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command exited with code ${code}`));
      }
    });
  });
}

let activeJobPromise = Promise.resolve();

function enqueueJob(job, workFn) {
  activeJobPromise = activeJobPromise
    .catch(() => undefined)
    .then(async () => {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      try {
        await workFn();
        job.status = 'success';
      } catch (err) {
        job.status = 'failed';
        job.error = err.message;
        appendJobLog(job, `Job failed: ${err.message}`);
      } finally {
        job.completedAt = new Date().toISOString();
      }
    });
}

async function executeTerraform(job, plan) {
  if (!fs.existsSync(CONFIG.terraformDir)) {
    throw new Error(`Terraform directory not found: ${CONFIG.terraformDir}`);
  }

  if (!fs.existsSync(CONFIG.terraformStaticTfvars)) {
    throw new Error(`Set Config file not found: ${CONFIG.terraformStaticTfvars}. Click 'Set Config' first.`);
  }

  if (CONFIG.requireAzureLogin) {
    await runCommand(job, 'az', ['account', 'show']);
  }

  await runCommand(job, CONFIG.terraformBin, ['-chdir=' + CONFIG.terraformDir, 'init', '-input=false']);
  const applyArgs = [
    '-chdir=' + CONFIG.terraformDir,
    'apply',
    '-auto-approve',
    '-input=false'
  ];
  applyArgs.push(`-var-file=${CONFIG.terraformStaticTfvars}`);
  appendJobLog(job, `Using static tfvars: ${CONFIG.terraformStaticTfvars}`);
  await runCommand(job, CONFIG.terraformBin, applyArgs);
}

function serveStatic(req, res, pathname) {
  const routePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, routePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };

    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': NODE_ENV === 'production' ? 'public, max-age=300' : 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;

    if (req.method === 'OPTIONS') {
      sendJson(res, 200, { ok: true });
      return;
    }

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        env: NODE_ENV,
        config: {
          camerasPerVm: CONFIG.camerasPerVm,
          maxVmCount: CONFIG.maxVmCount,
          terraformConfigured: fs.existsSync(CONFIG.terraformDir),
          managedTfvarsPath: CONFIG.terraformStaticTfvars,
          staticTfvarsPresent: fs.existsSync(CONFIG.terraformStaticTfvars),
          useStaticTfvars: CONFIG.useStaticTfvars,
          tfProjectVar: CONFIG.tfProjectVar,
          tfCameraCountVar: CONFIG.tfCameraCountVar,
          tfVmCountVar: CONFIG.tfVmCountVar,
          tfVmNamesVar: CONFIG.tfVmNamesVar,
          requireAzureLogin: CONFIG.requireAzureLogin
        }
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/plan') {
      const body = await parseBody(req);
      const plan = computePlan(body.projectName, body.cameraCount, body.camerasPerVm);
      sendJson(res, 200, { ok: true, plan });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/create') {
      const body = await parseBody(req);
      const plan = computePlan(body.projectName, body.cameraCount, body.camerasPerVm);
      const job = createJob('terraform-create', plan);
      enqueueJob(job, () => executeTerraform(job, plan));
      sendJson(res, 202, { ok: true, jobId: job.id, status: job.status, plan });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/set-config') {
      const body = await parseBody(req);
      const plan = computePlan(body.projectName, body.cameraCount, body.camerasPerVm);
      plan.vmSize = String(body.vmSize || '').trim();
      if (!plan.vmSize) {
        throw new Error('VM size is required.');
      }
      const resourceGroupName = String(body.resourceGroupName || '').trim();
      const saved = await writeManagedTfvars(plan, resourceGroupName);
      sendJson(res, 200, {
        ok: true,
        message: 'Terraform config updated.',
        tfvarsPath: saved.path,
        plan
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/vm-sizes') {
      const location = parsed.searchParams.get('location') || '';
      const search = parsed.searchParams.get('search') || '';
      const data = await listAzureVmSizes(location, search);
      sendJson(res, 200, { ok: true, ...data });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/jobs/')) {
      const id = pathname.split('/').pop();
      const job = jobs.get(id);
      if (!job) {
        sendJson(res, 404, { ok: false, error: 'Job not found.' });
        return;
      }
      sendJson(res, 200, { ok: true, job });
      return;
    }

    if (req.method === 'GET') {
      serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found.' });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`VM Creator control panel running at http://${HOST}:${PORT}`);
});
