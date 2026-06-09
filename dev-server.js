require('dotenv').config();
const { fork } = require('child_process');
const path = require('path');
const axios = require('axios');

const NEON_API_KEY = process.env.NEON_API_KEY;
const NEON_PROJECT_ID = process.env.NEON_PROJECT_ID;

if (!NEON_API_KEY || !NEON_PROJECT_ID) {
    console.error(`
❌ ERROR: Neon configuration missing in .env file.
To use ephemeral dev branches, please ensure you have the following in your .env:

  NEON_API_KEY=your_neon_api_key
  NEON_PROJECT_ID=${NEON_PROJECT_ID || 'still-grass-81482957'}

You can get an API key at: https://console.neon.tech/app/settings/api-keys

💡 If you want to run the dev server without Neon branch management (connecting directly to DATABASE_URL), run:
   npm run dev:no-branch
`);
    process.exit(1);
}

const API_BASE = 'https://console.neon.tech/api/v2';
const HEADERS = {
    Authorization: `Bearer ${NEON_API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
};

let createdBranchId = null;
let childProcess = null;
let isShuttingDown = false;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function listBranches() {
    const url = `${API_BASE}/projects/${NEON_PROJECT_ID}/branches`;
    const response = await axios.get(url, { headers: HEADERS });
    return response.data.branches || [];
}

async function deleteBranch(branchId) {
    const url = `${API_BASE}/projects/${NEON_PROJECT_ID}/branches/${branchId}`;
    await axios.delete(url, { headers: HEADERS });
}

async function createDevBranch() {
    const url = `${API_BASE}/projects/${NEON_PROJECT_ID}/branches`;
    const body = {
        branch: {
            name: 'dev'
        },
        endpoints: [
            {
                type: 'read_write'
            }
        ]
    };
    const response = await axios.post(url, body, { headers: HEADERS });
    return response.data.branch.id;
}

async function getConnectionString(branchId) {
    // pooled=true matches production URL format (uses -pooler endpoint)
    const url = `${API_BASE}/projects/${NEON_PROJECT_ID}/connection_uri?branch_id=${branchId}&database_name=neondb&role_name=neondb_owner&pooled=true`;
    const response = await axios.get(url, { headers: HEADERS });
    // Neon API may return the field as 'uri' or 'connection_uri' depending on version
    return response.data.uri || response.data.connection_uri || null;
}

async function cleanup() {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('\n🛑 Shutting down dev server...');

    if (childProcess) {
        console.log('   ├─ Stopping application server...');
        childProcess.kill('SIGINT');
        // Give the child process a moment to exit gracefully
        await sleep(1500);
    }

    if (createdBranchId) {
        console.log('   ├─ Deleting ephemeral dev database branch...');
        try {
            await deleteBranch(createdBranchId);
            console.log('   ├─ Dev database branch deleted.');
        } catch (err) {
            console.error(`   ⚠️  Failed to delete dev branch (${createdBranchId}):`, err.message);
        }
    }

    console.log('   └─ Cleanup complete. Goodbye!');
    process.exit(0);
}

// Handle termination signals
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

async function start() {
    console.log('🔄 Initializing ephemeral dev database branch...');

    try {
        // 1. Clean up any stale dev branch
        const branches = await listBranches();
        const staleBranch = branches.find(b => b.name === 'dev');
        if (staleBranch) {
            console.log(`   ├─ Found stale dev branch (${staleBranch.id}). Cleaning up...`);
            await deleteBranch(staleBranch.id);
            
            // Poll until stale branch is gone
            let isStaleDeleted = false;
            for (let i = 0; i < 15; i++) {
                await sleep(1000);
                const currentBranches = await listBranches();
                if (!currentBranches.some(b => b.name === 'dev')) {
                    isStaleDeleted = true;
                    break;
                }
            }
            if (isStaleDeleted) {
                console.log('   ├─ Stale dev branch cleaned up.');
            } else {
                console.warn('   ⚠️  Cleanup of stale branch timed out, proceeding anyway...');
            }
        }

        // 2. Create a fresh dev branch
        console.log('   ├─ Creating fresh dev branch from production main...');
        createdBranchId = await createDevBranch();
        console.log(`   ├─ Dev branch created: ${createdBranchId}`);

        // 3. Poll connection_uri until ready
        console.log('   ├─ Waiting for compute endpoint to provision...');
        let connectionString = null;
        let lastPollError = null;
        const maxRetries = 90;
        for (let i = 0; i < maxRetries; i++) {
            try {
                connectionString = await getConnectionString(createdBranchId);
                if (connectionString) {
                    lastPollError = null;
                    break;
                }
            } catch (err) {
                // Track the most recent error for diagnostic output on timeout
                lastPollError = err.response
                    ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
                    : err.message;
            }
            process.stdout.write('.');
            await sleep(1000);
        }

        if (!connectionString) {
            const detail = lastPollError ? `\n   Last API error: ${lastPollError}` : '';
            throw new Error(`Timeout waiting for compute endpoint connection URI.${detail}`);
        }
        process.stdout.write('\n');

        const dbHost = connectionString.split('@')[1]?.split('/')[0] || 'unknown';
        console.log(`   ├─ Dev database host: ${dbHost}`);
        console.log('   └─ Dev database ready!');

        // 4. Set environment and spawn server
        const env = {
            ...process.env,
            DATABASE_URL: connectionString,
            POLL_NEST: 'true',
            DEV_MODE: 'true'
        };

        console.log('\n🚀 Starting application server...');
        childProcess = fork(path.join(__dirname, 'server.js'), [], { env });

        childProcess.on('exit', (code) => {
            if (!isShuttingDown) {
                console.log(`\n⚠️  Application server exited with code ${code}`);
                cleanup();
            }
        });

    } catch (err) {
        console.error('\n❌ FATAL: Failed to initialize dev database branch:', err.message);
        if (err.response && err.response.data) {
            console.error('Details:', JSON.stringify(err.response.data, null, 2));
        }
        await cleanup();
    }
}

start();
