require('dotenv').config();
const WeatherService = require('./weatherService');

const apiKey = process.env.VC_WEATHER_KEY;
const zipCode = process.env.ZIP_CODE;
const dbUrl = process.env.DATABASE_URL;

if (!apiKey || !zipCode || !dbUrl) {
    console.error("❌ Error: Missing configuration. Ensure VC_WEATHER_KEY, ZIP_CODE, and DATABASE_URL are set in your environment or .env file.");
    process.exit(1);
}

const weather = new WeatherService(apiKey, zipCode, dbUrl);

async function run() {
    console.log("🌤️ Starting Weather Sync CLI...");
    console.log(`📍 Zip Code: ${zipCode}`);
    console.log(`📦 Database: ${dbUrl.split('@')[1]?.split('/')[0] || 'configured DB'}`);
    
    try {
        await weather.sync();
        console.log("✅ Weather sync process finished.");
    } catch (err) {
        console.error("❌ Weather sync failed:", err);
    } finally {
        await weather.pool.end();
    }
}

run();
