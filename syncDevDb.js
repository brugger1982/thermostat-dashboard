const fs = require('fs');
const path = require('path');
const { Pool, Client } = require('pg');
const { execSync } = require('child_process');
const readline = require('readline');

const TABLES = [
    'weather_daily',
    'thermostat_runtime',
    'weather_forecast',
    'system_settings',
];

const TABLE_COLUMNS = {
    weather_daily:       ['date','hdd','cdd','tmax','tmin','temp_avg','humidity','solar_rad','wind_speed'],
    thermostat_runtime:  ['date','heat_mins','ac_mins','avg_setpoint','sample_count','last_updated','data_source'],
    weather_forecast:    ['date','hdd','cdd','tmax','tmin','temp_avg','humidity','solar_rad','wind_speed','last_updated','icon','cloudcover','est_heat_mins','est_ac_mins','precip','precipprob','conditions'],
    system_settings:     ['key','value'],
};

function getProdUrl() {
    const yamlPath = path.join(__dirname, 'env.yaml');
    if (!fs.existsSync(yamlPath)) {
        throw new Error(`Production config env.yaml not found at ${yamlPath}`);
    }
    const yaml = fs.readFileSync(yamlPath, 'utf8');
    const match = yaml.match(/DATABASE_URL:\s*"([^"]+)"/);
    if (!match) {
        throw new Error('Could not find DATABASE_URL in env.yaml');
    }
    return match[1];
}

function extractProjectRef(dbUrl) {
    const match = dbUrl.match(/postgres\.([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => rl.question(query, (ans) => {
        rl.close();
        resolve(ans);
    }));
}

async function runSync() {
    require('dotenv').config();
    const devUrl = process.env.DATABASE_URL;
    if (!devUrl) {
        console.error("❌ ERROR: DATABASE_URL is not set in your .env file.");
        return false;
    }

    let prodUrl;
    try {
        prodUrl = getProdUrl();
    } catch (err) {
        console.error(`❌ ERROR reading production config: ${err.message}`);
        return false;
    }

    // 1. Test Dev connection (with timeout to catch paused DB)
    console.log("🔍 Checking connection to development database...");
    const devClient = new Client({
        connectionString: devUrl,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000
    });

    let devReachable = false;
    try {
        await devClient.connect();
        devReachable = true;
        await devClient.end();
    } catch (err) {
        console.log(`⚠️  Could not connect to development database: ${err.message}`);
        const ref = extractProjectRef(devUrl);
        
        console.log('\n================================================================');
        console.log('⚠️  WARNING: Development database is unreachable (likely PAUSED).');
        if (ref) {
            console.log('To resume your database, please visit the Supabase Dashboard:');
            console.log(`👉 https://supabase.com/dashboard/project/${ref}`);
        } else {
            console.log('To resume your database, please visit the Supabase Dashboard.');
        }
        console.log('================================================================\n');

        if (!process.stdin.isTTY) {
            console.log("⚠️ Stdin is not a TTY. Skipping interactive prompt and starting server anyway (offline mode)...");
            return true;
        }

        const answer = await askQuestion("Would you like to start the dev server anyway? (y/n): ");
        if (answer.toLowerCase().startsWith('y')) {
            console.log("🚀 Continuing to start dev server (offline mode)...");
            return true;
        } else {
            console.log("🛑 Sync aborted. Exiting.");
            process.exit(1);
        }
    }

    // 2. Perform Sync
    console.log("🔄 Syncing development database with production data...");
    const prodPool = new Pool({ connectionString: prodUrl, ssl: { rejectUnauthorized: false } });
    const devPool = new Pool({ connectionString: devUrl, ssl: { rejectUnauthorized: false } });

    try {
        let totalRowsCopied = 0;
        
        // Truncate tables cascade (drops all rows, keeps views)
        console.log("   🧹 Clearing existing dev database tables...");
        const truncateSql = TABLES.map(t => `"${t}"`).join(', ');
        await devPool.query(`TRUNCATE TABLE ${truncateSql} CASCADE`);

        for (const table of TABLES) {
            console.log(`   📦 Syncing table: ${table}...`);
            const columns = TABLE_COLUMNS[table];
            const colList = columns.map(c => `"${c}"`).join(', ');
            
            // Fetch rows from Prod
            const { rows } = await prodPool.query(`SELECT ${colList} FROM "${table}"`);
            console.log(`      Found ${rows.length} rows in production.`);
            if (rows.length === 0) continue;

            // Bulk Insert into Dev
            const BATCH_SIZE = 500;
            for (let i = 0; i < rows.length; i += BATCH_SIZE) {
                const batch = rows.slice(i, i + BATCH_SIZE);
                const valuePlaceholders = [];
                const flatValues = [];
                let valCount = 1;

                for (const row of batch) {
                    const rowPlaceholders = [];
                    for (const col of columns) {
                        rowPlaceholders.push(`$${valCount++}`);
                        flatValues.push(row[col]);
                    }
                    valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
                }

                const insertSql = `
                    INSERT INTO "${table}" (${colList})
                    VALUES ${valuePlaceholders.join(', ')}
                `;
                await devPool.query(insertSql, flatValues);
            }
            console.log(`      Successfully copied ${rows.length} rows.`);
            totalRowsCopied += rows.length;
        }

        console.log(`✅ Sync complete: ${totalRowsCopied} total rows copied.`);

        // Recreate views
        console.log("🛠️  Recreating database views...");
        execSync('node setupViews.js', { stdio: 'inherit' });
        console.log("✅ Database views updated successfully!");

        return true;
    } catch (err) {
        console.error(`❌ ERROR during database sync: ${err.message}`);
        return false;
    } finally {
        await prodPool.end();
        await devPool.end();
    }
}

if (require.main === module) {
    runSync().then(success => {
        process.exit(success ? 0 : 1);
    }).catch(err => {
        console.error("FATAL ERROR:", err);
        process.exit(1);
    });
}

module.exports = runSync;
