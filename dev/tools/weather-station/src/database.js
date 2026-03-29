'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { createLogger } = require('./logger');

const log = createLogger('database');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'weather.db');

/** WMO weather interpretation codes → plain-English descriptions. */
const WMO_DESCRIPTIONS = {
  0: 'Clear sky',
  1: 'Mainly clear',      2: 'Partly cloudy',   3: 'Overcast',
  45: 'Fog',              48: 'Icy fog',
  51: 'Light drizzle',    53: 'Drizzle',         55: 'Heavy drizzle',
  61: 'Slight rain',      63: 'Moderate rain',   65: 'Heavy rain',
  71: 'Slight snow',      73: 'Moderate snow',   75: 'Heavy snow',
  80: 'Slight showers',   81: 'Moderate showers', 82: 'Violent showers',
  95: 'Thunderstorm',     99: 'Thunderstorm with hail',
};

/** @type {import('better-sqlite3').Database | null} */
let _db = null;

/**
 * Return the live database handle.
 * @returns {import('better-sqlite3').Database}
 */
function getDb() {
  if (!_db) throw new Error('Database not initialized — call init() first');
  return _db;
}

/**
 * Initialize (or open) the SQLite database and run migrations.
 * Safe to call multiple times.
 */
function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at         TEXT    NOT NULL,
      temperature_c       REAL,
      humidity_pct        REAL,
      pressure_hpa        REAL,
      wind_speed_kmh      REAL,
      wind_direction_deg  INTEGER,
      weather_code        INTEGER,
      weather_description TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_readings_recorded_at
      ON readings (recorded_at);

    -- Key/value store for station metadata
    CREATE TABLE IF NOT EXISTS station_info (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO station_info (key, value)
      VALUES ('started_at', datetime('now'));
  `);

  log.info(`Database ready at ${DB_PATH}`);
}

/**
 * Insert one weather reading.
 *
 * @param {{
 *   recorded_at:         string,
 *   temperature_c:       number,
 *   humidity_pct:        number,
 *   pressure_hpa:        number,
 *   wind_speed_kmh:      number,
 *   wind_direction_deg:  number,
 *   weather_code:        number,
 *   weather_description: string,
 * }} data
 */
function insertReading(data) {
  _db.prepare(`
    INSERT INTO readings
      (recorded_at, temperature_c, humidity_pct, pressure_hpa,
       wind_speed_kmh, wind_direction_deg, weather_code, weather_description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.recorded_at,
    data.temperature_c,
    data.humidity_pct,
    data.pressure_hpa,
    data.wind_speed_kmh,
    data.wind_direction_deg,
    data.weather_code,
    data.weather_description,
  );
}

/**
 * Return the most recent reading row, or undefined if no readings exist yet.
 * @returns {object|undefined}
 */
function getLatestReading() {
  return _db
    .prepare('SELECT * FROM readings ORDER BY recorded_at DESC LIMIT 1')
    .get();
}

/** @returns {string} Absolute path to the SQLite database file. */
function getDbPath() { return DB_PATH; }

/**
 * Translate a WMO weather code to a plain-English description.
 * @param {number} code
 * @returns {string}
 */
function getWmoDescription(code) {
  return WMO_DESCRIPTIONS[code] ?? `Weather code ${code}`;
}

module.exports = { init, getDb, getDbPath, insertReading, getLatestReading, getWmoDescription };
