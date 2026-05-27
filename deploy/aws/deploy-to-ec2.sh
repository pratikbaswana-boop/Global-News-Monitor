#!/bin/bash
# Deploy GNM stack to AWS EC2 using AWS CLI
# Run this from your laptop (requires AWS CLI v2 + configured credentials)
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.xlarge}"   # 4 vCPU / 16 GB — recommended
REGION="${AWS_REGION:-ap-south-1}"
KEY_NAME="${KEY_NAME:-gnm-key}"
STACK_NAME="${STACK_NAME:-gnm}"
ENV_FILE="${ENV_FILE:-./.env.production}"

# ── Validate AWS CLI ────────────────────────────────────────────────────────
aws --version >/dev/null 2>&1 || { echo "AWS CLI not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || { echo "AWS CLI not authenticated. Run: aws configure"; exit 1; }

# ── 1. Create Key Pair (one-time) ───────────────────────────────────────────
if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "Creating key pair: $KEY_NAME"
  aws ec2 create-key-pair \
    --key-name "$KEY_NAME" \
    --region "$REGION" \
    --query 'KeyMaterial' --output text > "${KEY_NAME}.pem"
  chmod 400 "${KEY_NAME}.pem"
  echo "Saved private key to ${KEY_NAME}.pem"
else
  echo "Key pair $KEY_NAME already exists."
fi

# ── 2. Create Security Group ──────────────────────────────────────────────────
SG_NAME="${STACK_NAME}-sg"
SG_ID=$(aws ec2 describe-security-groups \
  --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)

if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  echo "Creating security group: $SG_NAME"
  SG_ID=$(aws ec2 create-security-group \
    --group-name "$SG_NAME" \
    --description "GNM stack security group" \
    --region "$REGION" \
    --query 'GroupId' --output text)

  # Allow HTTP, HTTPS, SSH
  aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --region "$REGION" \
    --protocol tcp --port 22 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --region "$REGION" \
    --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --region "$REGION" \
    --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  echo "Security group $SG_ID created with ports 22, 80, 443 open."
else
  echo "Security group $SG_NAME already exists: $SG_ID"
fi

# ── 3. Get latest Ubuntu 22.04 AMI ──────────────────────────────────────────
AMI_ID=$(aws ec2 describe-images \
  --region "$REGION" \
  --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
            "Name=virtualization-type,Values=hvm" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text)
echo "Using AMI: $AMI_ID"

# ── 4. Read env file into UserData ──────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: Env file not found: $ENV_FILE"
  echo "Create it first: cp .env.production.example .env.production && edit"
  exit 1
fi

# Encode env vars for the user-data script
ENV_EXPORTS=""
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^#.*$ ]] && continue
  [[ -z "$line" ]] && continue
  # Escape for shell safety
  escaped=$(printf '%q' "$line")
  ENV_EXPORTS="${ENV_EXPORTS}export ${escaped}\n"
done < "$ENV_FILE"

# Read the user-data template and inject env vars
USER_DATA=$(cat deploy/aws/ec2-user-data.sh)
USER_DATA="${ENV_EXPORTS}\n${USER_DATA}"
USER_DATA_B64=$(echo -e "$USER_DATA" | base64 -w 0)

# ── 5. Launch EC2 Instance ──────────────────────────────────────────────────
echo "Launching EC2 instance: $INSTANCE_TYPE in $REGION ..."
RUN_RESULT=$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --user-data "$USER_DATA_B64" \
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=80,VolumeType=gp3}" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$STACK_NAME},{Key=Project,Value=GNM}]" \
  --query 'Instances[0].InstanceId' --output text)

INSTANCE_ID="$RUN_RESULT"
echo "Instance launched: $INSTANCE_ID"

# ── 6. Wait for instance running & get IP ────────────────────────────────────
echo "Waiting for instance to reach running state..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

echo ""
echo "=== GNM Deployed ==="
echo "Instance ID: $INSTANCE_ID"
echo "Public IP:   $PUBLIC_IP"
echo "SSH:         ssh -i ${KEY_NAME}.pem ubuntu@$PUBLIC_IP"
echo "Dashboard:   http://$PUBLIC_IP"
echo ""
echo "Monitor bootstrap: ssh -i ${KEY_NAME}.pem ubuntu@$PUBLIC_IP 'tail -f /var/log/gnm-bootstrap.log'"
echo "Check services:    ssh -i ${KEY_NAME}.pem ubuntu@$PUBLIC_IP 'docker compose -f /opt/gnm/docker-compose.prod.yml ps'"
