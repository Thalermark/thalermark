import { type Database, createDatabase } from '../src/client.js';

let _db: Database | undefined;

export function getTestDb(): Database {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL not set — global-setup.ts should have set it');
    }
    _db = createDatabase(url);
  }
  return _db;
}
