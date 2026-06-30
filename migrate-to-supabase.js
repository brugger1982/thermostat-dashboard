/**
 * migrate-to-supabase.js
 * 
 * Copies all data from Neon (source) to a target Supabase project.
 * Run once for prod, once for dev (change TARGET_URL accordingly).
 * 
 * Usage:
 *   node migrate-to-supabase.js prod   <- migrates to env.yaml DATABASE_URL (prod Supabase)
 *   node migrate-to-supabase.js dev    <- migrates to .env DATABASE_URL (dev Supabase)
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ── Source: always Neon production ──────────────────────────────────────────
const NEON_URL = 'postgresql://neondb_owner:npg_EqIRswe2Ntb9@ep-flat-hall-akciq33e-pooler.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require';

// ── Target: read from args ───────────────────────────────────────────────────
const target = process.argv[2];
if (!target || !['prod', 'dev'].includes(target)) {
    console.error('❌ Usage: node migrate-to-supabase.js [prod|dev]');
    process.exit(1);
}

let TARGET_URL;
if (target === 'dev') {
    TARGET_URL = process.env.DATABASE_URL; // .env -> dev Supabase
} else {
    // Read prod URL from env.yaml
    const yaml = fs.readFileSync(path.join(__dirname, 'env.yaml'), 'utf8');
    const match = yaml.match(/DATABASE_URL:\s*"([^"]+)"/);
    if (!match) { console.error('❌ Could not find DATABASE_URL in env.yaml'); process.exit(1); }
    // Encode special chars in password (e.g. # -> %23) using last-@ split
    const raw = match[1];
    const atIdx = raw.lastIndexOf('@');
    const credsPart = raw.substring(0, atIdx);
    const hostPart  = raw.substring(atIdx);
    const schemaEnd = credsPart.indexOf('://') + 3;
    const colonIdx  = credsPart.indexOf(':', schemaEnd);
    const user      = credsPart.substring(schemaEnd, colonIdx);
    const pass      = credsPart.substring(colonIdx + 1);
    const schema    = credsPart.substring(0, schemaEnd);
    TARGET_URL = `${schema}${user}:${encodeURIComponent(pass)}${hostPart}`;
}

if (!TARGET_URL) {
    console.error('❌ Target DATABASE_URL is not set.');
    process.exit(1);
}

const srcPool = new Pool({ connectionString: NEON_URL, ssl: { rejectUnauthorized: false } });
const dstPool = new Pool({ connectionString: TARGET_URL, ssl: { rejectUnauthorized: false } });

// ── Tables to migrate (in dependency order) ──────────────────────────────────
const TABLES = [
    'weather_daily',
    'thermostat_runtime',
    'weather_forecast',
    'system_settings',
];

// ── Schema: CREATE TABLE statements for each table ───────────────────────────
// These match what the app already creates/expects.
const SCHEMAS = {
    weather_daily: `
        CREATE TABLE IF NOT EXISTS weather_daily (
            date DATE PRIMARY KEY,
            hdd NUMERIC,
            cdd NUMERIC,
            tmax NUMERIC,
            tmin NUMERIC,
            temp_avg NUMERIC,
            humidity NUMERIC,
            solar_rad NUMERIC,
            wind_speed NUMERIC
        )`,
    thermostat_runtime: `
        CREATE TABLE IF NOT EXISTS thermostat_runtime (
            date DATE PRIMARY KEY,
            heat_mins INTEGER DEFAULT 0,
            ac_mins INTEGER DEFAULT 0,
            avg_setpoint NUMERIC DEFAULT 70,
            sample_count INTEGER DEFAULT 1,
            last_updated TIMESTAMP DEFAULT NOW(),
            data_source VARCHAR DEFAULT 'polling'
        )`,
    weather_forecast: `
        CREATE TABLE IF NOT EXISTS weather_forecast (
            date DATE PRIMARY KEY,
            hdd NUMERIC,
            cdd NUMERIC,
            tmax NUMERIC,
            tmin NUMERIC,
            temp_avg NUMERIC,
            humidity NUMERIC,
            solar_rad NUMERIC,
            wind_speed NUMERIC,
            last_updated TIMESTAMP DEFAULT NOW(),
            icon VARCHAR,
            cloudcover NUMERIC,
            est_heat_mins NUMERIC,
            est_ac_mins NUMERIC,
            precip NUMERIC,
            precipprob NUMERIC,
            conditions VARCHAR
        )`,
    system_settings: `
        CREATE TABLE IF NOT EXISTS system_settings (
            key VARCHAR PRIMARY KEY,
            value TEXT NOT NULL
        )`,
};

// ── Explicit column lists per table (only what we define in SCHEMAS) ─────────
const TABLE_COLUMNS = {
    weather_daily:       ['date','hdd','cdd','tmax','tmin','temp_avg','humidity','solar_rad','wind_speed'],
    thermostat_runtime:  ['date','heat_mins','ac_mins','avg_setpoint','sample_count','last_updated','data_source'],
    weather_forecast:    ['date','hdd','cdd','tmax','tmin','temp_avg','humidity','solar_rad','wind_speed','last_updated','icon','cloudcover','est_heat_mins','est_ac_mins','precip','precipprob','conditions'],
    system_settings:     ['key','value'],
};

async function migrateTable(tableName) {
    // Drop and recreate to ensure our exact schema (Supabase may have added extra columns)
    await dstPool.query(`DROP TABLE IF EXISTS ${tableName} CASCADE`);
    await dstPool.query(SCHEMAS[tableName]);

    // 2. Count source rows
    const countRes = await srcPool.query(`SELECT COUNT(*) FROM ${tableName}`);
    const total = parseInt(countRes.rows[0].count);
    console.log(`   📋 ${tableName}: ${total} rows to migrate`);
    if (total === 0) { console.log(`   ✅ ${tableName}: skipped (empty)`); return 0; }

    // 3. Fetch only the columns we know about (avoids pulling Neon-specific extras)
    const columns = TABLE_COLUMNS[tableName];
    const colList = columns.map(c => `"${c}"`).join(', ');
    const { rows } = await srcPool.query(`SELECT ${colList} FROM ${tableName}`);

    // 4. Upsert in batches of 500
    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        for (const row of batch) {
            const vals = columns.map(c => row[c]);
            const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
            const colList = columns.map(c => `"${c}"`).join(', ');
            const updateSet = columns
                .filter(c => c !== 'date' && c !== 'key')
                .map(c => `"${c}" = EXCLUDED."${c}"`)
                .join(', ');
            const pkCol = tableName === 'system_settings' ? 'key' : 'date';
            await dstPool.query(
                `INSERT INTO ${tableName} (${colList}) VALUES (${placeholders})
                 ON CONFLICT (${pkCol}) DO UPDATE SET ${updateSet}`,
                vals
            );
            inserted++;
        }
        process.stdout.write(`\r   ↳ ${inserted}/${total} rows...`);
    }
    process.stdout.write('\n');
    return inserted;
}

async function run() {
    const dstHost = TARGET_URL.split('@')[1]?.split('/')[0] || 'unknown';
    console.log(`\n🚀 Migrating Neon → Supabase (${target})`);
    console.log(`   Source: ep-flat-hall-akciq33e-pooler.c-3.us-west-2.aws.neon.tech`);
    console.log(`   Target: ${dstHost}\n`);

    let totalRows = 0;
    for (const table of TABLES) {
        try {
            console.log(`\n── ${table} ──`);
            const count = await migrateTable(table);
            console.log(`   ✅ Done (${count} rows)`);
            totalRows += count;
        } catch (err) {
            console.error(`   ❌ Failed: ${err.message || err.code || JSON.stringify(err)}`);
            if (err.code) console.error(`      Code: ${err.code}`);
        }
    }

    console.log(`\n📊 Migration complete: ${totalRows} total rows written to Supabase ${target}`);
    console.log(`\n💡 Next step: run   node setupViews.js   to recreate the analytics views.`);
    console.log(`   (Make sure DATABASE_URL in .env points at the right target first)\n`);

    await srcPool.end();
    await dstPool.end();
}

run().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
