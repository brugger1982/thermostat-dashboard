const { Pool } = require('pg');

const START_DATE = '2019-01-01';
const MAX_DAYS_PER_CALL = 100;

class WeatherService {
    constructor(apiKey, zipCode, connectionString) {
        this.apiKey = apiKey;
        this.zipCode = zipCode;
        this.pool = new Pool({
            connectionString: connectionString,
            ssl: { rejectUnauthorized: false }
        });
    }

    async sync() {
        if (!this.apiKey || !this.zipCode) {
            console.error("❌ Weather Service: Missing API Key or Zip Code.");
            return;
        }

        console.log("DEBUG: Checking database for missing or incomplete weather data...");
        const today = new Date().toISOString().split('T')[0];

        // 1. Get ALL dates where we have complete data
        const res = await this.pool.query(`
            SELECT date FROM weather_daily 
            WHERE temp_avg IS NOT NULL 
            AND hdd IS NOT NULL
            ORDER BY date ASC
        `);
        const validDates = new Set(res.rows.map(r => r.date.toISOString().split('T')[0]));

        const missingOrIncompleteRanges = this.getMissingRanges(START_DATE, today, validDates);

        if (missingOrIncompleteRanges.length === 0) {
            console.log("DEBUG: No missing or incomplete data detected. Everything up to date.");
            return;
        }

        console.log(`DEBUG: Found ${missingOrIncompleteRanges.length} optimized date ranges to fetch/repair.`);

        let stats = {
            apiCalls: 0,
            success: 0,
            failed: 0,
            daysUpdated: 0
        };

        for (const range of missingOrIncompleteRanges) {
            stats.apiCalls++;
            try {
                console.log(`DEBUG: [Call ${stats.apiCalls}] Processing range: ${range.start} to ${range.end}`);
                const days = await this.fetchRange(range.start, range.end);

                stats.success++;
                for (const day of days) {
                    // --- Failsafe Degree Day Calculation (Base 65) ---
                    // Visual Crossing sometimes returns null for these in history
                    let hdd = day.heatingdegreedays;
                    let cdd = day.coolingdegreedays;

                    if (hdd === null || hdd === undefined) {
                        hdd = Math.max(0, 65 - day.temp);
                    }
                    if (cdd === null || cdd === undefined) {
                        cdd = Math.max(0, day.temp - 65);
                    }

                    await this.pool.query(
                        `INSERT INTO weather_daily (
                            date, hdd, cdd, tmax, tmin, temp_avg, humidity, solar_rad, wind_speed
                        ) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
                         ON CONFLICT (date) DO UPDATE SET
                            hdd = EXCLUDED.hdd,
                            cdd = EXCLUDED.cdd,
                            tmax = EXCLUDED.tmax,
                            tmin = EXCLUDED.tmin,
                            temp_avg = EXCLUDED.temp_avg,
                            humidity = EXCLUDED.humidity,
                            solar_rad = EXCLUDED.solar_rad,
                            wind_speed = EXCLUDED.wind_speed`,
                        [
                            day.datetime, 
                            hdd, 
                            cdd, 
                            day.tempmax, 
                            day.tempmin,
                            day.temp,
                            day.humidity,
                            day.solarradiation,
                            day.windspeed
                        ]
                    );
                    stats.daysUpdated++;
                }

                // Pause to prevent rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (err) {
                stats.failed++;
                console.error(`DEBUG: [Call ${stats.apiCalls}] ❌ Failed:`, err.message);

                if (err.message.includes('429')) {
                    console.log("DEBUG: Daily limit reached. Stopping for now. Progress has been saved to the DB.");
                    break;
                }
            }
        }

        console.log("\n📊 WEATHER SYNC SUMMARY:");
        console.log(`   - API Calls Made: ${stats.apiCalls}`);
        console.log(`   - Successful:     ${stats.success}`);
        console.log(`   - Failed:         ${stats.failed}`);
        console.log(`   - Days Updated:   ${stats.daysUpdated}`);
        console.log("---------------------------\n");
    }

    getMissingRanges(startStr, endStr, validDates) {
        const ranges = [];
        let cur = new Date(startStr + 'T00:00:00');
        const stop = new Date(endStr + 'T00:00:00');
        let rangeStart = null;

        while (cur <= stop) {
            const s = cur.toISOString().split('T')[0];
            if (!validDates.has(s)) {
                if (!rangeStart) rangeStart = s;
            } else if (rangeStart) {
                const prev = new Date(cur.getTime() - (24 * 60 * 60 * 1000));
                this.addSplitRanges(ranges, rangeStart, prev.toISOString().split('T')[0]);
                rangeStart = null;
            }
            cur = new Date(cur.getTime() + (24 * 60 * 60 * 1000));
        }

        if (rangeStart) {
            this.addSplitRanges(ranges, rangeStart, endStr);
        }
        return ranges;
    }

    addSplitRanges(ranges, startStr, endStr) {
        const start = new Date(startStr + 'T00:00:00');
        const end = new Date(endStr + 'T00:00:00');
        const chunkMs = MAX_DAYS_PER_CALL * 24 * 60 * 60 * 1000;

        let current = start;
        while (current <= end) {
            const chunkStart = current.toISOString().split('T')[0];
            let next = new Date(current.getTime() + chunkMs - (24 * 60 * 60 * 1000));
            if (next > end) next = end;

            const chunkEnd = next.toISOString().split('T')[0];
            ranges.push({ start: chunkStart, end: chunkEnd });

            current = new Date(next.getTime() + (24 * 60 * 60 * 1000));
        }
    }

    async fetchRange(start, end) {
        const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${this.zipCode}/${start}/${end}?unitGroup=us&elements=datetime,tempmax,tempmin,temp,humidity,windspeed,solarradiation,heatingdegreedays,coolingdegreedays&include=days&key=${this.apiKey}&contentType=json`;
        const res = await fetch(url);
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`API ${res.status}: ${errorText}`);
        }
        const data = await res.json();
        return data.days;
    }

    async syncForecast() {
        if (!this.apiKey || !this.zipCode) {
            console.error("❌ Weather Service (Forecast): Missing API Key or Zip Code.");
            return;
        }

        console.log("DEBUG: Fetching 7-day weather forecast from Visual Crossing...");
        const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${this.zipCode}/next7days?unitGroup=us&elements=datetime,tempmax,tempmin,temp,humidity,windspeed,solarradiation,heatingdegreedays,coolingdegreedays,icon,cloudcover,precip,precipprob,conditions&include=days&key=${this.apiKey}&contentType=json`;
        
        const res = await fetch(url);
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`API ${res.status}: ${errorText}`);
        }
        
        const data = await res.json();
        const days = data.days;
        
        console.log(`DEBUG: Syncing ${days.length} forecast days into the database...`);
        
        for (const day of days) {
            let hdd = day.heatingdegreedays;
            let cdd = day.coolingdegreedays;

            if (hdd === null || hdd === undefined) {
                hdd = Math.max(0, 65 - day.temp);
            }
            if (cdd === null || cdd === undefined) {
                cdd = Math.max(0, day.temp - 65);
            }

            await this.pool.query(
                `INSERT INTO weather_forecast (
                    date, hdd, cdd, tmax, tmin, temp_avg, humidity, solar_rad, wind_speed, last_updated, icon, cloudcover, precip, precipprob, conditions
                ) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, $12, $13, $14) 
                 ON CONFLICT (date) DO UPDATE SET
                    hdd = EXCLUDED.hdd,
                    cdd = EXCLUDED.cdd,
                    tmax = EXCLUDED.tmax,
                    tmin = EXCLUDED.tmin,
                    temp_avg = EXCLUDED.temp_avg,
                    humidity = EXCLUDED.humidity,
                    solar_rad = EXCLUDED.solar_rad,
                    wind_speed = EXCLUDED.wind_speed,
                    last_updated = EXCLUDED.last_updated,
                    icon = EXCLUDED.icon,
                    cloudcover = EXCLUDED.cloudcover,
                    precip = EXCLUDED.precip,
                    precipprob = EXCLUDED.precipprob,
                    conditions = EXCLUDED.conditions`,
                [
                    day.datetime, 
                    hdd, 
                    cdd, 
                    day.tempmax, 
                    day.tempmin,
                    day.temp,
                    day.humidity,
                    day.solarradiation,
                    day.windspeed,
                    day.icon,
                    day.cloudcover,
                    day.precip,
                    day.precipprob,
                    day.conditions
                ]
            );
        }
        
        console.log("✅ Weather forecast sync complete!");
        return days.length;
    }

    async getMonthlyTotals() {
        const query = `
            SELECT 
                TO_CHAR(date, 'YYYY-MM') as period,
                EXTRACT(YEAR FROM date) as year,
                EXTRACT(MONTH FROM date) as month,
                SUM(hdd) as hdd,
                SUM(cdd) as cdd,
                COUNT(*) as count
            FROM weather_daily
            GROUP BY period, year, month
            ORDER BY period DESC
        `;
        const res = await this.pool.query(query);
        return res.rows;
    }
}

module.exports = WeatherService;
