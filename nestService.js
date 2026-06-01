const axios = require('axios');

class NestService {
    constructor(config) {
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.projectId = config.projectId;
        this.refreshToken = config.refreshToken;
        this.accessToken = null;
    }

    async exchangeCode(code, redirectUri) {
        const response = await axios.post('https://oauth2.googleapis.com/token', {
            client_id: this.clientId,
            client_secret: this.clientSecret,
            code: code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri
        });
        this.refreshToken = response.data.refresh_token;
        this.accessToken = response.data.access_token;
        return this.refreshToken;
    }

    async getAccessToken() {
        const response = await axios.post('https://oauth2.googleapis.com/token', {
            client_id: this.clientId,
            client_secret: this.clientSecret,
            refresh_token: this.refreshToken,
            grant_type: 'refresh_token'
        });
        this.accessToken = response.data.access_token;
        return this.accessToken;
    }

    cToF(c) {
        return (c * 9/5) + 32;
    }

    async logRuntimes(pool) {
        try {
            // Load latest refresh token from database dynamically to prevent stale in-memory tokens across multiple instances
            const tokenRes = await pool.query("SELECT value FROM system_settings WHERE key = 'NEST_REFRESH_TOKEN'");
            if (tokenRes.rows.length > 0) {
                this.refreshToken = tokenRes.rows[0].value;
            }
        } catch (dbErr) {
            console.error("⚠️ Error loading refresh token from DB:", dbErr.message);
        }

        if (!this.refreshToken) return;
        try {
            // Acquire lease for 50 seconds to prevent concurrent polling across multiple servers (e.g. dev, docker, Cloud Run)
            const lockRes = await pool.query(`
                INSERT INTO system_settings (key, value)
                VALUES ('LAST_NEST_POLL', NOW()::text)
                ON CONFLICT (key) DO UPDATE
                SET value = NOW()::text
                WHERE (system_settings.value::timestamp < NOW() - INTERVAL '50 seconds')
                RETURNING value
            `);

            if (lockRes.rows.length === 0) {
                // Skip silently - another active server instance already polled Nest < 50s ago
                return;
            }

            const token = await this.getAccessToken();
            const url = `https://smartdevicemanagement.googleapis.com/v1/enterprises/${this.projectId}/devices`;
            const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
            
            const device = res.data.devices[0];
            const stats = device.traits['sdm.devices.traits.ThermostatHvac'];
            const tempTrait = device.traits['sdm.devices.traits.ThermostatTemperatureSetpoint'];
            
            // Get raw Celsius and convert to Fahrenheit for the DB (supports both old and new Nest SDM trait fields)
            const rawCelsius = tempTrait.heatCelsius || tempTrait.coolCelsius || tempTrait.heatSetpointCelsius || tempTrait.coolSetpointCelsius || 21.0;
            const avgSetpointF = this.cToF(rawCelsius);

            const status = stats.status; // HEATING, COOLING, OFF
            const date = new Date().toISOString().split('T')[0];

            let heatAdd = status === 'HEATING' ? 1 : 0;
            let acAdd = status === 'COOLING' ? 1 : 0;

            console.log(`DEBUG: Nest Poller - Status: ${status} | Target: ${avgSetpointF.toFixed(1)}°F`);

            await pool.query(`
                INSERT INTO thermostat_runtime (date, heat_mins, ac_mins, avg_setpoint, sample_count, last_updated)
                VALUES ($1, $2, $3, $4, 1, NOW())
                ON CONFLICT (date) DO UPDATE SET
                    heat_mins = thermostat_runtime.heat_mins + EXCLUDED.heat_mins,
                    ac_mins = thermostat_runtime.ac_mins + EXCLUDED.ac_mins,
                    avg_setpoint = (thermostat_runtime.avg_setpoint * thermostat_runtime.sample_count + EXCLUDED.avg_setpoint) / (thermostat_runtime.sample_count + 1),
                    sample_count = thermostat_runtime.sample_count + 1,
                    last_updated = NOW();
            `, [date, heatAdd, acAdd, avgSetpointF]);

        } catch (err) {
            console.error("❌ Nest Poller Error:", err.response ? err.response.data : err.message);
        }
    }
}

module.exports = NestService;
