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
    refreshToken: process.env.NEST_REFRESH_TOKEN,
    redirectUri: `http://localhost:${PORT}/auth/callback`
});

app.use(express.static('public'));

// --- AUTH ROUTES ---

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("No code found.");
    try {
        const refreshToken = await nest.exchangeCode(code);
        const envPath = path.join(__dirname, '.env');
        let envContent = fs.readFileSync(envPath, 'utf8');
        if (envContent.includes('NEST_REFRESH_TOKEN=')) {
            envContent = envContent.replace(/NEST_REFRESH_TOKEN=.*/, `NEST_REFRESH_TOKEN=${refreshToken}`);
        } else {
            envContent += `\nNEST_REFRESH_TOKEN=${refreshToken}\n`;
        }
        fs.writeFileSync(envPath, envContent);
        process.env.NEST_REFRESH_TOKEN = refreshToken;
        nest.refreshToken = refreshToken;
        if (!global.nestPollerStarted) {
            console.log("📡 Nest Poller started (2-minute interval)");
            setInterval(() => nest.logRuntimes(weather.pool), 120000);
            global.nestPollerStarted = true;
            nest.logRuntimes(weather.pool);
        }
        res.send("<h1>Success!</h1><p>Your Nest account is authorized. You can close this tab.</p>");
    } catch (err) {
        res.status(500).send("Auth Error: " + err.message);
    }
});

// --- API Endpoints ---

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
                avg_target_f as avg_setpoint,
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
        console.log("✅ Database schema verified.");
    } catch (err) {
        console.log("⚠️ Database schema check: ", err.message);
    }

    try { await weather.sync(); } catch (err) { console.error("❌ Weather Sync Error:", err); }

    if (process.env.NEST_REFRESH_TOKEN && !global.nestPollerStarted) {
        console.log("📡 Nest Poller started (1-minute interval)");
        setInterval(() => nest.logRuntimes(weather.pool), 60000);
        global.nestPollerStarted = true;
        nest.logRuntimes(weather.pool);
    }

    // --- Periodic Weather Sync (Every 12 hours) ---
    setInterval(async () => {
        console.log("🔄 Periodic Weather Sync triggering...");
        try { await weather.sync(); } catch (err) { console.error("❌ Periodic Weather Sync Error:", err); }
    }, 12 * 60 * 60 * 1000);

    console.log(`\n🏠 Webapp is live at http://localhost:${PORT}`);
});
