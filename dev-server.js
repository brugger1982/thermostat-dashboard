require('dotenv').config();
const { fork } = require('child_process');
const path = require('path');
const runSync = require('./syncDevDb');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error(`
❌ ERROR: DATABASE_URL is not set in your .env file.
Please add your Supabase dev project connection string:

  DATABASE_URL=postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres
`);
    process.exit(1);
}

// Extract host for display (without exposing password)
const dbHost = DATABASE_URL.split('@')[1]?.split('/')[0] || 'unknown';

let childProcess = null;
let isShuttingDown = false;

async function cleanup() {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('\n🛑 Shutting down dev server...');
    if (childProcess) {
        childProcess.kill('SIGINT');
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
    console.log('   └─ Goodbye!');
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

async function start() {
    try {
        const syncSuccess = await runSync();
        if (!syncSuccess) {
            console.error('❌ Database sync failed. Exiting.');
            process.exit(1);
        }
    } catch (err) {
        console.error('❌ Error during database sync:', err.message);
        process.exit(1);
    }

    console.log('🧪 Starting dev server (Supabase dev project)');
    console.log(`   📦 Database: ${dbHost}`);
    console.log('');

    const env = {
        ...process.env,
        POLL_NEST: 'true',
        DEV_MODE: 'true'
    };

    childProcess = fork(path.join(__dirname, 'server.js'), [], { env });

    childProcess.on('exit', (code) => {
        if (!isShuttingDown) {
            console.log(`\n⚠️  Application server exited with code ${code}`);
            cleanup();
        }
    });
}

start();
