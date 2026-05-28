require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const WeatherService = require('./weatherService');
const NestService = require('./nestService');

const app = express();
const PORT = process.env.PORT || 3000;

// Services
const weather = new WeatherService(
    process.env.VC_WEATHER_KEY,
    process.env.ZIP_CODE,
    process.env.DATABASE_URL
);

const nest = new NestService({
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    projectId: process.env.NEST_PROJECT_ID,
    refreshToken: process.env.NEST_REFRESH_TOKEN
});

app.use(express.static('public'));

// --- AUTH ROUTES ---

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("No code found.");
    try {
        // Build redirect URI dynamically from the incoming request
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const redirectUri = `${protocol}://${req.get('host')}/auth/callback`;
        const refreshToken = await nest.exchangeCode(code, redirectUri);
        await weather.pool.query(`
            INSERT INTO system_settings (key, value) 
            VALUES ('NEST_REFRESH_TOKEN', $1) 
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [refreshToken]);
        process.env.NEST_REFRESH_TOKEN = refreshToken;
        nest.refreshToken = refreshToken;
        nest.logRuntimes(weather.pool).catch(console.error); // Trigger immediate sync
        res.send("<h1>Success!</h1><p>Your Nest account is authorized. You can close this tab.</p>");
    } catch (err) {
        res.status(500).send("Auth Error: " + err.message);
    }
});

// --- API Endpoints ---

// --- CRON ROUTES ---
app.get('/api/cron/sync-nest', async (req, res) => {
    try {
        await nest.logRuntimes(weather.pool);
        res.send('OK');
    } catch (err) {
        console.error("❌ Nest Sync Error:", err);
        res.status(500).send(err.message);
    }
});

app.get('/api/cron/sync-weather', async (req, res) => {
    try {
        await weather.sync();
        res.send('OK');
    } catch (err) {
        console.error("❌ Weather Sync Error:", err);
        res.status(500).send(err.message);
    }
});

app.get('/api/weather/monthly', async (req, res) => {
    try {
        const data = await weather.getMonthlyTotals();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/thermostat/monthly', async (req, res) => {
    try {
        const query = `
            SELECT 
                period,
                total_heat_mins as heat_mins,
                total_ac_mins as ac_mins,
                heat_target_f,
                cool_target_f,
                avg_temp_outdoor,
                avg_wind_speed,
                avg_solar,
                total_hdd,
                total_cdd
            FROM v_monthly_analytics
            ORDER BY period DESC
        `;
        const result = await weather.pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// SYSTEM HEALTH STATUS API
app.get('/api/sync/status', async (req, res) => {
    try {
        // 1. Health Meta
        const healthQuery = `
            SELECT 
                (SELECT last_updated FROM thermostat_runtime ORDER BY last_updated DESC LIMIT 1) as nest_heartbeat,
                (SELECT MAX(date) FROM weather_daily) as weather_heartbeat
        `;
        const healthRes = await weather.pool.query(healthQuery);
        
        // 2. Daily Density (90 days)
        const densityQuery = `
            SELECT date, sample_count, last_updated 
            FROM thermostat_runtime 
            WHERE date > CURRENT_DATE - INTERVAL '90 days'
            ORDER BY date DESC
        `;
        const densityRes = await weather.pool.query(densityQuery);

        // 3. Year/Month Coverage
        const coverageQuery = `
            SELECT 
                TO_CHAR(d, 'YYYY-MM-01')::date as month,
                COUNT(w.date) as weather_days,
                COUNT(t.date) as nest_days,
                SUM(COALESCE(t.sample_count, 0)) as nest_samples
            FROM generate_series(
                (SELECT MIN(date) FROM thermostat_runtime),
                CURRENT_DATE,
                '1 day'::interval
            ) d
            LEFT JOIN weather_daily w ON w.date = d::date
            LEFT JOIN thermostat_runtime t ON t.date = d::date
            GROUP BY month
            ORDER BY month DESC
        `;
        const coverageRes = await weather.pool.query(coverageQuery);

        res.json({
            health: healthRes.rows[0],
            daily: densityRes.rows,
            coverage: coverageRes.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/health', (req, res) => res.send('OK'));

// --- Start Server ---

app.listen(PORT, async () => {
    console.log("🚀 Starting Thermostat Dashboard Webapp...");
    try {
        await weather.pool.query('ALTER TABLE thermostat_runtime ADD COLUMN IF NOT EXISTS sample_count INTEGER DEFAULT 1');
        await weather.pool.query('ALTER TABLE thermostat_runtime ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP DEFAULT NOW()');
        await weather.pool.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                key VARCHAR PRIMARY KEY,
                value TEXT NOT NULL
            )
        `);
        console.log("✅ Database schema verified.");
        
        // Load Nest Token from DB
        const tokenRes = await weather.pool.query(`SELECT value FROM system_settings WHERE key = 'NEST_REFRESH_TOKEN'`);
        if (tokenRes.rows.length > 0) {
            const dbToken = tokenRes.rows[0].value;
            process.env.NEST_REFRESH_TOKEN = dbToken;
            nest.refreshToken = dbToken;
        }
    } catch (err) {
        console.log("⚠️ Database schema check: ", err.message);
    }

    // Start Nest polling every 60 seconds
    if (nest.refreshToken) {
        console.log("🔄 Starting Nest Poller (every 60s)...");
        nest.logRuntimes(weather.pool).catch(console.error);
        setInterval(() => nest.logRuntimes(weather.pool).catch(console.error), 60000);
    } else {
        console.log("⚠️ Nest Poller skipped: No refresh token configured.");
    }

    console.log(`\n🏠 Webapp is live at http://localhost:${PORT}`);
});
