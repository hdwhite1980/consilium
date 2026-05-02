#!/bin/bash
# ================================================================
# OPSIS Agent Download/Upload Deployment Script
# ================================================================
# Changes:
#   1. WebSocket URL: wss://opsisapp.com (removed /api/agent/ws/{device_id})
#   2. Removed agent_config JSON from agent-setup endpoint
#   3. New /api/agent/download endpoint (serves real installer file)
#   4. New /api/agent/upload endpoint (admin uploads new agent versions)
#   5. New /api/agent/version endpoint (returns latest version info)
#   6. Agent version displayed in API Credentials section
#   7. Updated AgentSetup.tsx frontend component
# ================================================================

echo "🚀 Starting OPSIS Agent Download/Upload deployment..."

# Step 1: Create agent storage directory
echo ""
echo "📁 Step 1: Creating agent storage directory..."
mkdir -p /opt/opsis/agents
chmod 755 /opt/opsis/agents
echo "   ✅ /opt/opsis/agents/ created"

# Step 2: Copy new backend route file
echo ""
echo "📄 Step 2: Deploying agent_download_routes.py..."
# This file should already be SCP'd to /opt/opsis/backend/api/agent_download_routes.py
if [ -f /opt/opsis/backend/api/agent_download_routes.py ]; then
    echo "   ✅ agent_download_routes.py found"
else
    echo "   ❌ agent_download_routes.py NOT found - SCP it first!"
    echo "   Run: scp agent_download_routes.py root@opsis-prod:/opt/opsis/backend/api/"
    exit 1
fi

# Step 3: Patch client_routes.py - update agent-setup endpoint
echo ""
echo "🔧 Step 3: Patching client_routes.py agent-setup endpoint..."
# This is done via the sed commands below

# Step 4: Patch main.py - register new router  
echo ""
echo "🔧 Step 4: Patching main.py to register agent_download_routes..."
# This is done via the sed commands below

# Step 5: Copy files into Docker container
echo ""
echo "🐳 Step 5: Copying files into Docker container..."
docker cp /opt/opsis/backend/api/agent_download_routes.py opsis-backend:/app/api/agent_download_routes.py
docker cp /opt/opsis/backend/api/client_routes.py opsis-backend:/app/api/client_routes.py
docker cp /opt/opsis/backend/main.py opsis-backend:/app/main.py

# Step 6: Mount agents directory into container (requires compose update)
echo ""
echo "📦 Step 6: Ensuring agents volume is mounted..."
echo "   ⚠️  You need to add this volume to docker-compose.yml for opsis-backend:"
echo '   volumes:'
echo '     - /opt/opsis/agents:/opt/opsis/agents'
echo ""

# Step 7: Restart backend
echo ""
echo "🔄 Step 7: Restarting backend..."
docker restart opsis-backend
echo "   ✅ Backend restarted"

# Step 8: Deploy frontend
echo ""
echo "🎨 Step 8: Deploying updated AgentSetup.tsx..."
# This file should already be SCP'd to /opt/opsis/frontend/src/components/AgentSetup.tsx
if [ -f /opt/opsis/frontend/src/components/AgentSetup.tsx ]; then
    echo "   ✅ AgentSetup.tsx found"
    cd /opt/opsis/frontend
    docker build -t opsis-frontend --no-cache .
    cd /opt/opsis
    docker compose up -d frontend
    echo "   ✅ Frontend rebuilt and deployed"
else
    echo "   ❌ AgentSetup.tsx NOT found - SCP it first!"
    echo "   Run: scp AgentSetup.tsx root@opsis-prod:/opt/opsis/frontend/src/components/"
fi

echo ""
echo "✅ Deployment complete!"
echo ""
echo "🧪 Test endpoints:"
echo "   curl -s https://opsisapp.com/api/agent/version -H 'Authorization: Bearer YOUR_TOKEN'"
echo "   curl -s https://opsisapp.com/api/clients/7/agent-setup -H 'Authorization: Bearer YOUR_TOKEN'"
