# Deploy Bedrock Support to EC2

Run these commands on your EC2 instance (ssh -i gnm-key.pem ubuntu@65.0.93.40).

## Step 1: Update .env.production

```bash
cd /opt/gnm

# Add Bedrock config to .env.production
cat >> .env.production << 'EOF'

# Switch LLM provider to AWS Bedrock
LLM_PROVIDER=bedrock
LLM_MODEL_CHAT=us.anthropic.claude-sonnet-4-20250514-v1:0

# AWS credentials for Bedrock (must have InvokeModel permission)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-key-here
AWS_SECRET_ACCESS_KEY=your-secret-here
EOF
```

## Step 2: Update the changed code files

You need to apply these 4 file changes. The easiest way is to open each file and paste the new content, or use the commands below.

### File 1: lib/integrations-openai-ai-server/package.json
```bash
cat > /opt/gnm/lib/integrations-openai-ai-server/package.json << 'JSON'
{
  "name": "@workspace/integrations-openai-ai-server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./batch": "./src/batch/index.ts",
    "./image": "./src/image/index.ts",
    "./audio": "./src/audio/index.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.1",
    "@aws-sdk/client-bedrock-runtime": "^3.750.0",
    "openai": "^6.27.0",
    "p-limit": "^7.3.0",
    "p-retry": "^7.1.1"
  }
}
JSON
```

### File 2: lib/integrations-openai-ai-server/src/llm.ts
This file adds the Bedrock provider. Paste the full content from:
`@/lib/integrations-openai-ai-server/src/llm.ts` in your local IDE.

### File 3: docker-compose.prod.yml
Add these lines in the `api-server` service `environment` section (after `USE_NSE_DIRECT`):
```yaml
      # AWS Bedrock credentials (used when LLM_PROVIDER=bedrock)
      AWS_REGION: ${AWS_REGION:-us-east-1}
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID:-}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY:-}
      AWS_SESSION_TOKEN: ${AWS_SESSION_TOKEN:-}
```

### File 4: pnpm-workspace.yaml
In the `minimumReleaseAgeExclude` section, add:
```yaml
  # AWS SDK packages are published by Amazon and trusted
  - '@aws-sdk/*'
```

## Step 3: Rebuild and restart

```bash
cd /opt/gnm

# Install new dependency
pnpm install --prefer-offline

# Rebuild Docker image with Bedrock support
docker compose -f docker-compose.prod.yml --env-file .env.production build api-server

# Restart API server
docker compose -f docker-compose.prod.yml --env-file .env.production up -d api-server

# Verify env vars inside container
docker exec gnm_api_prod node -e "console.log('LLM_PROVIDER:', process.env.LLM_PROVIDER)"
docker exec gnm_api_prod node -e "console.log('AWS_REGION:', process.env.AWS_REGION)"
```

## Step 4: Verify Bedrock works

```bash
# Test a direct Bedrock call through the container
docker exec gnm_api_prod node -e "
const { chatComplete } = require('@workspace/integrations-openai-ai-server');
chatComplete({ messages: [{ role: 'user', content: 'Say hello in one word' }] })
  .then(r => console.log('OK:', r.choices[0].message.content))
  .catch(e => console.error('FAIL:', e.message));
"
```

Then check the dashboard at `http://65.0.93.40` — market signals should show real directional data instead of neutral/50-50.
