# VM Creator Control Panel

Single web dashboard to:
- Input `project name` and `camera count`
- Auto-calculate VM count using `1 VM per 500 cameras` (configurable)
- Generate VM names like `west-bengal1`, `west-bengal2`, ...
- Trigger Terraform apply from UI

## 1) Start

```bash
cp .env.example .env
npm start
```

Open: `http://127.0.0.1:3003`

If your infra repo is at a different path, edit `.env` values first.

## 2) Existing Terraform Integration

Flow:
- `Set Config` writes: `TERRAFORM_WEB_TFVARS` (default: `terraform/terraform.tfvars`)
- `Create VMs` executes Terraform apply using tfvars files.

```bash
terraform -chdir=<TERRAFORM_DIR> init -input=false
terraform -chdir=<TERRAFORM_DIR> apply -auto-approve -input=false -var-file=<terraform.tfvars>
```

Generated/updated variables:
- `subscription_id` (preserved from existing file)
- `resource_group_name` (preserved from existing file)
- `location` (preserved from existing file)
- `vm_name` (list(string), updated by UI)

You can remap variable names in `.env`:
- `TF_PROJECT_VAR`
- `TF_CAMERA_COUNT_VAR`
- `TF_VM_COUNT_VAR`
- `TF_VM_NAMES_VAR`

## 3) Access

- App is meant for controlled internal use on `127.0.0.1`.

## 4) Azure CLI Requirement

If `REQUIRE_AZ_LOGIN=true`, app verifies login before terraform:

```bash
az account show
```

Ensure service login once on server (`az login` or service principal flow).

## 5) Production Setup

- Run as service (`systemd` / `pm2`)
- Put behind reverse proxy (`nginx`) with HTTPS
- Restrict access (SSO/VPN/IP allowlist)
- Store secrets in environment variables or managed secret vault
- Keep Terraform state backend remote and locked

## 6) Example Backend Paths

For your shared structure:
- `INFRA_ROOT=/home/sanket/ele-infra`
- `TERRAFORM_DIR=/home/sanket/ele-infra/terraform`
- `TERRAFORM_STATIC_TFVARS=/home/sanket/ele-infra/terraform/terraform.tfvars`
- `TERRAFORM_WEB_TFVARS=/home/sanket/ele-infra/terraform/terraform.tfvars`
