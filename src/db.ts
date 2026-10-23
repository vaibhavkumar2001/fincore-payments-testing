import { Pool } from 'pg';


export const pool = new Pool({
    //yaha pe configuration aayenge
    connectionString: 
        process.env.DATABASE_URL || 'postgres://fincore:fincore@localhost:5432/fincore',
        //Fail fast when the database is down instead of hanging
        connectionTimeoutMillis: 2000,
})