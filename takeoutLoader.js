require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const readline = require('readline');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function findTakeoutFiles(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            findTakeoutFiles(filePath, fileList);
        } else {
            const ext = path.extname(file).toLowerCase();
            const name = file.toLowerCase();
            // Match old summary files OR new HvacRuntime files
            if ((ext === '.json' && name.includes('-summary')) || name.includes('hvacruntime.jsonl')) {
                fileList.push(filePath);
            }
        }
    });
    return fileList;
}

function cToF(c) {
    if (c === null || c === undefined) return null;
    return (c * 9/5) + 32;
}

function parseDuration(d) {
    if (!d) return 0;
    return parseInt(String(d).replace('s', '')) || 0;
}

async function processJsonlFile(filePath) {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    const dailyData = {}; // date -> { heatSec: 0, coolSec: 0, setpoints: [] }

    for await (const line of rl) {
        try {
            // Handle the escaped double-quote format seen in some JSONL exports
            let cleanLine = line.trim();
            if (cleanLine.startsWith('"') && cleanLine.endsWith('"')) {
                cleanLine = cleanLine.substring(1, cleanLine.length - 1).replace(/""/g, '"');
            }
            if (!cleanLine) continue;

            const entry = JSON.parse(cleanLine);
            const date = entry.interval_start.split('T')[0];

            if (!dailyData[date]) {
                dailyData[date] = { heatSec: 0, coolSec: 0, setpoints: [] };
            }

            dailyData[date].heatSec += (entry.heating_time || 0);
            dailyData[date].coolSec += (entry.cooling_time || 0);

            const target = entry.heating_target || entry.cooling_target || entry.sched_heating_target || entry.sched_cooling_target;
            if (target !== null && target !== undefined) {
                dailyData[date].setpoints.push(target);
            }
        } catch (err) {
            // Silence parsing errors for individual lines to keep logs clean
        }
    }

    return dailyData;
}

async function loadTakeoutData(rootPath) {
    console.log(`🔍 COMPREHENSIVE LOAD: Scanning for Nest Takeout in: ${rootPath}`);
    const files = findTakeoutFiles(rootPath);
    console.log(`Found ${files.length} data files (Summaries & JSONL).`);

    let totalDays = 0;

    for (const filePath of files) {
        console.log(`📂 Processing: ${path.basename(filePath)}`);
        
        if (filePath.toLowerCase().endsWith('.jsonl')) {
            // HANDLE NEW JSONL FORMAT (2024+)
            const dailyData = await processJsonlFile(filePath);
            for (const date in dailyData) {
                const data = dailyData[date];
                const heatMins = Math.round(data.heatSec / 60);
                const acMins = Math.round(data.coolSec / 60);
                let avgSetpoint = 70.0;
                if (data.setpoints.length > 0) {
                    const avgC = data.setpoints.reduce((a, b) => a + b, 0) / data.setpoints.length;
                    avgSetpoint = cToF(avgC);
                }

                await pool.query(`
                    INSERT INTO thermostat_runtime (date, heat_mins, ac_mins, avg_setpoint, sample_count, last_updated)
                    VALUES ($1, $2, $3, $4, 1440, NOW())
                    ON CONFLICT (date) DO UPDATE SET
                        heat_mins = EXCLUDED.heat_mins,
                        ac_mins = EXCLUDED.ac_mins,
                        avg_setpoint = EXCLUDED.avg_setpoint,
                        sample_count = 1440,
                        last_updated = NOW();
                `, [date, heatMins, acMins, avgSetpoint]);
                totalDays++;
            }
        } else {
            // HANDLE OLD JSON SUMMARY FORMAT (2019-2021)
            try {
                const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                for (const dateKey in content) {
                    const dayData = content[dateKey];
                    const date = dateKey.split('T')[0];
                    let heatSeconds = 0;
                    let acSeconds = 0;

                    if (dayData.cycles && Array.isArray(dayData.cycles)) {
                        dayData.cycles.forEach(cycle => {
                            const duration = parseDuration(cycle.duration);
                            const isHeat = cycle.heat1 || cycle.heat2 || cycle.heat3 || cycle.heatAux || cycle.emergencyHeat;
                            const isCool = cycle.cool1 || cycle.cool2 || cycle.cool3;
                            if (isHeat) heatSeconds += duration;
                            else if (isCool) acSeconds += duration;
                        });
                    } else {
                        heatSeconds = dayData.totalHeatingSeconds || 0;
                        acSeconds = dayData.totalCoolingSeconds || 0;
                    }

                    const heatMins = Math.round(heatSeconds / 60);
                    const acMins = Math.round(acSeconds / 60);
                    
                    let avgSetpoint = 70.0;
                    if (dayData.events && dayData.events.length > 0) {
                        const setpoints = dayData.events
                            .filter(e => e.setPoint && e.setPoint.targets)
                            .map(e => e.setPoint.targets.heatingTarget || e.setPoint.targets.coolingTarget);
                        if (setpoints.length > 0) {
                            const avgC = setpoints.reduce((a, b) => a + b, 0) / setpoints.length;
                            avgSetpoint = cToF(avgC);
                        }
                    }

                    await pool.query(`
                        INSERT INTO thermostat_runtime (date, heat_mins, ac_mins, avg_setpoint, sample_count, last_updated)
                        VALUES ($1, $2, $3, $4, 720, NOW())
                        ON CONFLICT (date) DO UPDATE SET
                            heat_mins = EXCLUDED.heat_mins,
                            ac_mins = EXCLUDED.ac_mins,
                            avg_setpoint = EXCLUDED.avg_setpoint,
                            sample_count = 720,
                            last_updated = NOW();
                    `, [date, heatMins, acMins, avgSetpoint]);
                    totalDays++;
                }
            } catch (err) {
                console.error(`❌ Error parsing ${filePath}:`, err.message);
            }
        }
    }

    console.log(`\n✅ COMPLETED: Processed ${totalDays} days across all formats.`);
    await pool.end();
}

const targetPath = process.argv[2] || 'C:\\Users\\jonah\\OneDrive\\NEST\\thermostats';
loadTakeoutData(targetPath).catch(err => {
    console.error("FATAL ERROR:", err);
    process.exit(1);
});
