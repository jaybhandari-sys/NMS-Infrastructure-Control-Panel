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

const CONFIG = {
  camerasPerVm: Number(process.env.CAMERAS_PER_VM || 500),
  maxVmCount: Number(process.env.MAX_VM_COUNT || 5000),
  allowedOrigin: process.env.ALLOWED_ORIGIN || 'http://127.0.0.1:3003',
  terraformBin: process.env.TERRAFORM_BIN || 'terraform',
  terraformDir: path.resolve(process.env.TERRAFORM_DIR || path.join(INFRA_ROOT, 'terraform')),
  terraformStaticTfvars: path.resolve(
    process.env.TERRAFORM_STATIC_TFVARS || path.join(INFRA_ROOT, 'terraform', 'terraform.tfvars')
  ),
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

function findTfvarsValue(content, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm');
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertTfvarsKey(content, key, value) {
  const lines = content.split(/\r?\n/);
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (keyPattern.test(line)) {
      lines[i] = `${key} = ${value}`;
      return lines.join('\n');
    }
  }
  while (lines.length && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  lines.push(`${key} = ${value}`);
  return lines.join('\n') + '\n';
}

function buildManagedTfvars(plan, resourceGroupName, existingContent = '') {
  let content = existingContent;
  if (!content.trim()) {
    content = '# Managed by VM Creator UI\n';
  }

  const resolvedResourceGroup = resourceGroupName
    ? toHclString(resourceGroupName)
    : findTfvarsValue(content, 'resource_group_name') || toHclString('');

  content = upsertTfvarsKey(content, 'resource_group_name', resolvedResourceGroup);
  content = upsertTfvarsKey(content, 'project', toHclString(plan.projectName));
  content = upsertTfvarsKey(content, 'project_name', toHclString(plan.projectName));
  content = upsertTfvarsKey(content, 'vm_count', String(plan.vmCount));
  content = upsertTfvarsKey(content, 'vm_name', toHclList(plan.vmNames));
  return content;
}

async function writeManagedTfvars(plan, resourceGroupName) {
  const targetPath = CONFIG.terraformStaticTfvars;
  const parentDir = path.dirname(targetPath);
  await fsp.mkdir(parentDir, { recursive: true });
  let existingContent = '';
  if (fs.existsSync(targetPath)) {
    existingContent = await fsp.readFile(targetPath, 'utf-8');
  }
  const content = buildManagedTfvars(plan, resourceGroupName, existingContent);
  await fsp.writeFile(targetPath, content, 'utf-8');
  return { path: targetPath, content };
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
