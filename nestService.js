class NestService {
    constructor(config) {
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.projectId = config.projectId;
        this.refreshToken = config.refreshToken;
        this.accessToken = null;
    }

    async exchangeCode(code, redirectUri) {
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: this.clientId,
                client_secret: this.clientSecret,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error_description || data.error || 'exchangeCode failed');
        this.refreshToken = data.refresh_token;
        this.accessToken = data.access_token;
        return this.refreshToken;
    }

    async getAccessToken() {
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: this.clientId,
                client_secret: this.clientSecret,
                refresh_token: this.refreshToken,
                grant_type: 'refresh_token'
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error_description || data.error || 'getAccessToken failed');
        this.accessToken = data.access_token;
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

        const isProduction = !!process.env.K_SERVICE;
        const shouldPoll = isProduction || process.env.POLL_NEST === 'true';
        if (!shouldPoll) {
            return;
        }
        try {
            // Acquire lease for 30 seconds to prevent concurrent polling across multiple servers (e.g. dev, docker, Cloud Run)
            const lockRes = await pool.query(`
                INSERT INTO system_settings (key, value)
                VALUES ('LAST_NEST_POLL', NOW()::text)
                ON CONFLICT (key) DO UPDATE
                SET value = NOW()::text
                WHERE (system_settings.value::timestamp < NOW() - INTERVAL '30 seconds')
                RETURNING value
            `);

            if (lockRes.rows.length === 0) {
                // Skip silently - another active server instance already polled Nest < 50s ago
                return;
            }

            const token = await this.getAccessToken();
            const url = `https://smartdevicemanagement.googleapis.com/v1/enterprises/${this.projectId}/devices`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(JSON.stringify(errData));
            }
            const resData = await res.json();
            
            const device = resData.devices[0];
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
                INSERT INTO thermostat_runtime (date, heat_mins, ac_mins, avg_setpoint, sample_count, data_source, last_updated)
                VALUES ($1, $2, $3, $4, 1, 'polling', NOW())
                ON CONFLICT (date) DO UPDATE SET
                    heat_mins = thermostat_runtime.heat_mins + EXCLUDED.heat_mins,
                    ac_mins = thermostat_runtime.ac_mins + EXCLUDED.ac_mins,
                    avg_setpoint = (thermostat_runtime.avg_setpoint * thermostat_runtime.sample_count + EXCLUDED.avg_setpoint) / (thermostat_runtime.sample_count + 1),
                    sample_count = thermostat_runtime.sample_count + 1,
                    last_updated = NOW()
                WHERE thermostat_runtime.data_source != 'takeout';
            `, [date, heatAdd, acAdd, avgSetpointF]);

        } catch (err) {
            console.error("❌ Nest Poller Error:", err.message);
        }
    }
}

module.exports = NestService;
