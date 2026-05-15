const axios = require('axios');

class NestService {
    constructor(config) {
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.projectId = config.projectId;
        this.refreshToken = config.refreshToken;
        this.accessToken = null;
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
        if (!this.refreshToken) return;
        try {
            const token = await this.getAccessToken();
            const url = `https://smartdevicemanagement.googleapis.com/v1/enterprises/${this.projectId}/devices`;
            const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
            
            const device = res.data.devices[0];
            const stats = device.traits['sdm.devices.traits.ThermostatHvac'];
            const tempTrait = device.traits['sdm.devices.traits.ThermostatTemperatureSetpoint'];
            
            // Get raw Celsius and convert to Fahrenheit for the DB
            const rawCelsius = tempTrait.heatSetpointCelsius || tempTrait.coolSetpointCelsius || 21.0;
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
