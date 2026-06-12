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

app.get('/auth/login', (req, res) => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const redirectUri = `${protocol}://${req.get('host')}/auth/callback`;
    const authUrl = `https://nestservices.google.com/partnerconnections/${process.env.NEST_PROJECT_ID}/auth` +
        `?redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&client_id=${encodeURIComponent(process.env.CLIENT_ID)}` +
        `&access_type=offline` +
        `&prompt=consent` +
        `&state=state` +
        `&response_type=code` +
        `&scope=https://www.googleapis.com/auth/sdm.service`;
    res.redirect(authUrl);
});

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
        
        let responseMsg = "<h1>Success!</h1><p>Your Nest account is authorized. You can close this tab.</p>";
        if (process.env.DEV_MODE === 'true') {
            responseMsg = `
                <h1>Success!</h1>
                <p>Your Nest account is authorized.</p>
                <p><strong>Dev Refresh Token:</strong></p>
                <textarea rows="4" cols="80" readonly style="font-family: monospace; padding: 8px;">${refreshToken}</textarea>
                <p>To keep local dev working across database refreshes, copy this token and paste it into your <code>.env</code> file as:</p>
                <pre style="background: #f0f0f0; padding: 10px; border-radius: 4px; font-family: monospace;">NEST_REFRESH_TOKEN=${refreshToken}</pre>
            `;
        }
        res.send(responseMsg);
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

app.get('/api/cron/sync-forecast', async (req, res) => {
    try {
        const count = await weather.syncForecast();
        res.send(`OK: Synced ${count} days`);
    } catch (err) {
        console.error("❌ Forecast Sync Error:", err);
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

app.get('/api/forecast/7day', async (req, res) => {
    try {
        // 1. Fetch forecast days
        let forecastRes = await weather.pool.query(`
            SELECT 
                TO_CHAR(date, 'YYYY-MM-DD') as date,
                hdd::float as hdd, 
                cdd::float as cdd, 
                tmax::float as tmax, 
                tmin::float as tmin, 
                temp_avg::float as temp_avg, 
                humidity::float as humidity, 
                solar_rad::float as solar_rad, 
                wind_speed::float as wind_speed,
                icon,
                cloudcover::float as cloudcover,
                precip::float as precip,
                precipprob::float as precipprob,
                conditions
            FROM weather_forecast
            WHERE date >= CURRENT_DATE
            ORDER BY date ASC
            LIMIT 7
        `);

        if (forecastRes.rows.length < 7) {
            console.log(`DEBUG: Only ${forecastRes.rows.length} forecast days available (need 7). Performing automatic on-the-fly sync...`);
            // Purge stale past-date rows before re-syncing
            await weather.pool.query(`DELETE FROM weather_forecast WHERE date < CURRENT_DATE`);
            await weather.syncForecast();
            forecastRes = await weather.pool.query(`
                SELECT 
                    TO_CHAR(date, 'YYYY-MM-DD') as date,
                    hdd::float as hdd, 
                    cdd::float as cdd, 
                    tmax::float as tmax, 
                    tmin::float as tmin, 
                    temp_avg::float as temp_avg, 
                    humidity::float as humidity, 
                    solar_rad::float as solar_rad, 
                    wind_speed::float as wind_speed,
                    icon,
                    cloudcover::float as cloudcover,
                    precip::float as precip,
                    precipprob::float as precipprob,
                    conditions
                FROM weather_forecast
                WHERE date >= CURRENT_DATE
                ORDER BY date ASC
                LIMIT 7
            `);
        }

        // 2. Fetch efficiency multiplier and setpoints
        const effRes = await weather.pool.query(`SELECT * FROM v_recent_efficiency LIMIT 1`);
        const eff = effRes.rows[0] || {
            heat_efficiency: 30.0,
            cool_efficiency: 45.0,
            heat_target_f: 68.0,
            cool_target_f: 74.0
        };

        // Ensure columns are floats/numbers
        const heatEff = parseFloat(eff.heat_efficiency);
        const coolEff = parseFloat(eff.cool_efficiency);
        const heatTarget = parseFloat(eff.heat_target_f);
        const coolTarget = parseFloat(eff.cool_target_f);

        // 3. Process recommendations and predictions
        const days = forecastRes.rows.map(day => {
            const hddVal = parseFloat(day.hdd) || 0;
            const cddVal = parseFloat(day.cdd) || 0;

            // Non-linear Heating runtime prediction
            let predictedHeatMins = 0;
            if (hddVal < 0.6) {
                predictedHeatMins = 0;
            } else if (hddVal < 5.0) {
                // Buffer band: mild weather with very low runtime probability (~15% scale)
                predictedHeatMins = Math.round(hddVal * heatEff * 0.15);
            } else {
                // Sustained heating
                predictedHeatMins = Math.round(hddVal * heatEff);
            }

            // Non-linear Cooling runtime prediction
            let predictedAcMins = 0;
            if (cddVal < 0.3) {
                predictedAcMins = 0;
            } else if (cddVal < 3.0) {
                // Buffer band: mild-to-warm weather with low runtime probability (~35% scale)
                predictedAcMins = Math.round(cddVal * coolEff * 0.35);
            } else {
                // Sustained cooling
                predictedAcMins = Math.round(cddVal * coolEff);
            }
            
            let recommendedMode = 'Off';
            let recommendedSetpoint = null;
            let reason = 'Weather is within the natural comfort band. Thermostat can be safely turned off.';

            // Dynamic Comfort Dead-Band Check: HDD < 5.0 and CDD < 3.0 (corresponds to ~60°F - 68°F daily average temp)
            if (hddVal < 5.0 && cddVal < 3.0) {
                recommendedMode = 'Off';
                recommendedSetpoint = null;
                reason = `Milder outdoor average of ${day.temp_avg}°F falls within your home's natural insulation dead-band. Recommend keeping the thermostat Off or running fans to save energy.`;
            } else if (hddVal >= 5.0 && cddVal === 0) {
                recommendedMode = 'Heat';
                recommendedSetpoint = heatTarget;
                reason = `Sustained outdoor chill expected (daily average of ${day.temp_avg}°F, HDD ${hddVal.toFixed(1)}). Recommend Heat mode set to ${heatTarget}°F.`;
            } else if (cddVal >= 3.0 && hddVal === 0) {
                recommendedMode = 'Cool';
                recommendedSetpoint = coolTarget;
                reason = `Warm outdoor average of ${day.temp_avg}°F expected (CDD ${cddVal.toFixed(1)}). Recommend Cool mode set to ${coolTarget}°F.`;
            } else {
                recommendedMode = 'Auto';
                recommendedSetpoint = { heat: heatTarget, cool: coolTarget };
                reason = `Wide daily temperature range (${day.tmin}°F to ${day.tmax}°F). Recommend Auto/Eco mode to balance daytime warmth and nighttime cool.`;
            }

            return {
                date: day.date,
                temp_avg: day.temp_avg,
                tmax: day.tmax,
                tmin: day.tmin,
                humidity: day.humidity,
                solar_rad: day.solar_rad,
                wind_speed: day.wind_speed,
                icon: day.icon,
                cloudcover: day.cloudcover,
                precip: day.precip,
                precipprob: day.precipprob,
                hdd: day.hdd,
                cdd: day.cdd,
                predicted_heat_hours: parseFloat((predictedHeatMins / 60).toFixed(1)),
                predicted_ac_hours: parseFloat((predictedAcMins / 60).toFixed(1)),
                predicted_total_hours: parseFloat(((predictedHeatMins + predictedAcMins) / 60).toFixed(1)),
                recommended_mode: recommendedMode,
                recommended_setpoint: recommendedSetpoint,
                reason: reason,
                pre_conditioning: null
            };
        });

        // 4. Add Pre-conditioning Logic looking ahead (Day i looks at Day i+1)
        for (let i = 0; i < days.length - 1; i++) {
            const currentDay = days[i];
            const nextDay = days[i + 1];

            if (nextDay.tmax >= 88 && currentDay.tmin < 72) {
                currentDay.pre_conditioning = `Tomorrow will be extremely hot (high of ${nextDay.tmax}°F). Since tonight will be a cooler ${currentDay.tmin}°F, we recommend pre-cooling your home overnight or opening windows in the evening to store cooler air, reducing AC stress tomorrow.`;
            } else if (nextDay.tmin <= 25) {
                currentDay.pre_conditioning = `Tomorrow will be extremely cold (low of ${nextDay.tmin}°F). We recommend pre-heating your home slightly above your standard setpoint during the afternoon today to store thermal energy and reduce strain on your heating system during peak morning freeze hours.`;
            }
        }

        res.json({
            efficiency_used: {
                heat_efficiency_mins_per_hdd: heatEff,
                cool_efficiency_mins_per_cdd: coolEff,
                heat_target_f: heatTarget,
                cool_target_f: coolTarget
            },
            forecast: days
        });
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
                (SELECT MAX(date) FROM weather_daily) as weather_heartbeat,
                (SELECT COALESCE(sample_count, 0) FROM thermostat_runtime WHERE date = CURRENT_DATE) as today_samples
        `;
        const healthRes = await weather.pool.query(healthQuery);
        
        // 2. Daily Density (90 days)
        const densityQuery = `
            SELECT date, sample_count, last_updated, COALESCE(data_source, 'polling') as data_source
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
    const isDev = process.env.DEV_MODE === 'true';
    const dbHost = process.env.DATABASE_URL ? (process.env.DATABASE_URL.split('@')[1]?.split('/')[0] || 'unknown') : 'unknown';
    console.log(`📦 Database: ${isDev ? 'DEVELOPMENT (ephemeral branch)' : 'PRODUCTION'} (${dbHost})`);
    try {
        await weather.pool.query('ALTER TABLE thermostat_runtime ADD COLUMN IF NOT EXISTS sample_count INTEGER DEFAULT 1');
        await weather.pool.query('ALTER TABLE thermostat_runtime ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP DEFAULT NOW()');
        await weather.pool.query("ALTER TABLE thermostat_runtime ADD COLUMN IF NOT EXISTS data_source VARCHAR DEFAULT 'polling'");
        await weather.pool.query("UPDATE thermostat_runtime SET data_source = 'excel' WHERE sample_count = 0 AND data_source = 'polling'");
        await weather.pool.query("UPDATE thermostat_runtime SET data_source = 'takeout' WHERE sample_count IN (720, 1440) AND date < '2026-05-20' AND data_source = 'polling'");
        await weather.pool.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                key VARCHAR PRIMARY KEY,
                value TEXT NOT NULL
            )
        `);
        await weather.pool.query(`
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
                last_updated TIMESTAMP DEFAULT NOW()
            )
        `);
        await weather.pool.query('ALTER TABLE weather_forecast ADD COLUMN IF NOT EXISTS icon VARCHAR');
        await weather.pool.query('ALTER TABLE weather_forecast ADD COLUMN IF NOT EXISTS cloudcover NUMERIC');
        await weather.pool.query('ALTER TABLE weather_forecast ADD COLUMN IF NOT EXISTS precip NUMERIC');
        await weather.pool.query('ALTER TABLE weather_forecast ADD COLUMN IF NOT EXISTS precipprob NUMERIC');
        await weather.pool.query('ALTER TABLE weather_forecast ADD COLUMN IF NOT EXISTS conditions VARCHAR');
        console.log("✅ Database schema verified.");
        
        // In dev mode, the database is cloned from production, which means it starts with the production token.
        // If we are in DEV_MODE, we override the DB token with whatever is in process.env.NEST_REFRESH_TOKEN (from .env).
        if (process.env.DEV_MODE === 'true') {
            const envToken = process.env.NEST_REFRESH_TOKEN || '';
            if (envToken) {
                await weather.pool.query(`
                    INSERT INTO system_settings (key, value)
                    VALUES ('NEST_REFRESH_TOKEN', $1)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                `, [envToken]);
                console.log("🔑 Dev mode: Synced NEST_REFRESH_TOKEN from .env to database.");
            } else {
                await weather.pool.query(`DELETE FROM system_settings WHERE key = 'NEST_REFRESH_TOKEN'`);
                console.log("🔑 Dev mode: Cleared production NEST_REFRESH_TOKEN from ephemeral database.");
            }
        }

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

    // Start Nest polling every 60 seconds (only in production or if explicitly enabled)
    const isProduction = !!process.env.K_SERVICE;
    const shouldPoll = isProduction || process.env.POLL_NEST === 'true';

    if (nest.refreshToken && shouldPoll) {
        console.log("🔄 Starting Nest Poller (every 60s)...");
        nest.logRuntimes(weather.pool).catch(console.error);
        setInterval(() => nest.logRuntimes(weather.pool).catch(console.error), 60000);
    } else if (!nest.refreshToken) {
        console.log("⚠️ Nest Poller skipped: No refresh token configured.");
    } else {
        console.log("⚠️ Nest Poller skipped: Running in development mode (set POLL_NEST=true to enable).");
    }

    // Auto-sync forecast on startup and every 6 hours
    console.log("🌤️ Syncing weather forecast...");
    weather.pool.query(`DELETE FROM weather_forecast WHERE date < CURRENT_DATE`)
        .then(() => weather.syncForecast())
        .catch(err => console.error("⚠️ Initial forecast sync failed:", err.message));
    setInterval(() => {
        console.log("🌤️ Scheduled forecast refresh...");
        weather.pool.query(`DELETE FROM weather_forecast WHERE date < CURRENT_DATE`)
            .then(() => weather.syncForecast())
            .catch(err => console.error("⚠️ Scheduled forecast sync failed:", err.message));
    }, 6 * 60 * 60 * 1000); // Every 6 hours

    console.log(`\n🏠 Webapp is live at http://localhost:${PORT}`);
});
