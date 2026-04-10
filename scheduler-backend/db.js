const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('render.com')
            ? { rejectUnauthorized: false }
            : false,
    })
    : null;

module.exports = pool;
