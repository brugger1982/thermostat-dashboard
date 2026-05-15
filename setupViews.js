require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
-- Drop existing views
DROP VIEW IF EXISTS v_monthly_analytics CASCADE;
DROP VIEW IF EXISTS v_seasonal_analytics CASCADE;
DROP VIEW IF EXISTS v_yearly_analytics CASCADE;

-- 1. Monthly Analytics View (FULL OUTER JOIN + Environmental Metrics)
CREATE VIEW v_monthly_analytics AS
SELECT 
    COALESCE(TO_CHAR(t.date, 'YYYY-MM'), TO_CHAR(d.date, 'YYYY-MM')) as period,
    MIN(COALESCE(t.date, d.date)) as month_start,
    COUNT(t.date) as nest_days,
    COUNT(d.date) as weather_days,
    SUM(COALESCE(t.heat_mins, 0)) as total_heat_mins,
    SUM(COALESCE(t.ac_mins, 0)) as total_ac_mins,
    SUM(COALESCE(t.heat_mins, 0) + COALESCE(t.ac_mins, 0)) as total_runtime_mins,
    SUM(COALESCE(d.hdd, 0)) as total_hdd,
    SUM(COALESCE(d.cdd, 0)) as total_cdd,
    ROUND(AVG(t.avg_setpoint)::numeric, 1) as avg_target_f,
    ROUND(AVG(d.temp_avg)::numeric, 1) as avg_temp_outdoor,
    ROUND(AVG(d.wind_speed)::numeric, 1) as avg_wind_speed,
    ROUND(AVG(d.solar_rad)::numeric, 1) as avg_solar,
    CASE WHEN SUM(COALESCE(d.hdd, 0)) > 0 THEN ROUND((SUM(t.heat_mins)::numeric / SUM(d.hdd)), 2) ELSE 0 END as heat_mins_per_hdd,
    CASE WHEN SUM(COALESCE(d.cdd, 0)) > 0 THEN ROUND((SUM(t.ac_mins)::numeric / SUM(d.cdd)), 2) ELSE 0 END as ac_mins_per_cdd
FROM thermostat_runtime t
FULL OUTER JOIN weather_daily d ON d.date = t.date
GROUP BY period;

-- 2. Seasonal Analytics View (FULL OUTER JOIN)
CREATE VIEW v_seasonal_analytics AS
SELECT 
    EXTRACT(YEAR FROM COALESCE(t.date, d.date)) as year,
    CASE 
        WHEN EXTRACT(MONTH FROM COALESCE(t.date, d.date)) IN (12, 1, 2) THEN 'Winter'
        WHEN EXTRACT(MONTH FROM COALESCE(t.date, d.date)) IN (3, 4, 5) THEN 'Spring'
        WHEN EXTRACT(MONTH FROM COALESCE(t.date, d.date)) IN (6, 7, 8) THEN 'Summer'
        ELSE 'Fall'
    END as season,
    COUNT(t.date) as nest_days,
    COUNT(d.date) as weather_days,
    SUM(COALESCE(t.heat_mins, 0)) as total_heat_mins,
    SUM(COALESCE(t.ac_mins, 0)) as total_ac_mins,
    SUM(COALESCE(d.hdd, 0)) as total_hdd,
    SUM(COALESCE(d.cdd, 0)) as total_cdd,
    ROUND(AVG(d.temp_avg)::numeric, 1) as avg_temp_outdoor,
    CASE WHEN SUM(COALESCE(d.hdd, 0)) > 0 THEN ROUND((SUM(t.heat_mins)::numeric / SUM(d.hdd)), 2) ELSE 0 END as heat_efficiency,
    CASE WHEN SUM(COALESCE(d.cdd, 0)) > 0 THEN ROUND((SUM(t.ac_mins)::numeric / SUM(d.cdd)), 2) ELSE 0 END as cool_efficiency
FROM thermostat_runtime t
FULL OUTER JOIN weather_daily d ON d.date = t.date
GROUP BY year, season;

-- 3. Yearly Analytics View (FULL OUTER JOIN)
CREATE VIEW v_yearly_analytics AS
SELECT 
    EXTRACT(YEAR FROM COALESCE(t.date, d.date)) as year,
    COUNT(t.date) as nest_days,
    COUNT(d.date) as weather_days,
    SUM(COALESCE(t.heat_mins, 0)) as total_heat_mins,
    SUM(COALESCE(t.ac_mins, 0)) as total_ac_mins,
    SUM(COALESCE(d.hdd, 0)) as total_hdd,
    SUM(COALESCE(d.cdd, 0)) as total_cdd,
    ROUND(AVG(d.temp_avg)::numeric, 1) as avg_temp_outdoor,
    CASE WHEN SUM(COALESCE(d.hdd, 0)) > 0 THEN ROUND((SUM(t.heat_mins)::numeric / SUM(d.hdd)), 2) ELSE 0 END as heat_efficiency,
    CASE WHEN SUM(COALESCE(d.cdd, 0)) > 0 THEN ROUND((SUM(t.ac_mins)::numeric / SUM(d.cdd)), 2) ELSE 0 END as cool_efficiency
FROM thermostat_runtime t
FULL OUTER JOIN weather_daily d ON d.date = t.date
GROUP BY year;
`;

async function setupViews() {
    try {
        await pool.query(sql);
        console.log("✅ SUCCESS: Analytics views upgraded with FULL OUTER JOIN and environmental metrics!");
    } catch (err) {
        console.error("❌ ERROR setting up views:", err.message);
    } finally {
        await pool.end();
    }
}

setupViews();
