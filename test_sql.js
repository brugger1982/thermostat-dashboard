const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_EqIRswe2Ntb9@ep-flat-hall-akciq33e-pooler.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require' });
const q = `
    SELECT 
        COALESCE(TO_CHAR(date, 'YYYY-MM'), 'Total') as period, 
        ROUND(AVG(CASE WHEN heat_mins > 0 THEN avg_setpoint END)::numeric, 1) as heat_target, 
        ROUND(AVG(CASE WHEN ac_mins > 0 THEN avg_setpoint END)::numeric, 1) as cool_target 
    FROM thermostat_runtime 
    GROUP BY period 
    ORDER BY period DESC 
    LIMIT 5
`;
pool.query(q).then(res => { 
    console.log(JSON.stringify(res.rows, null, 2)); 
    pool.end(); 
}).catch(console.error);
