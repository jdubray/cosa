'use strict';

const cron = require('node-cron');
const { createLogger } = require('./logger');
const db = require('./database');

const log = createLogger('weather-fetcher');

/**
 * Fetch current weather from the Open-Meteo API (free, no API key required).
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<object>} Raw Open-Meteo API response.
 */
async function fetchFromOpenMeteo(lat, lon) {
  const params = new URLSearchParams({
    latitude:         String(lat),
    longitude:        String(lon),
    current:          'temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m,weather_code',
    wind_speed_unit:  'kmh',
    temperature_unit: 'celsius',
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Fetch weather and persist one reading to the database.
 *
 * @param {{ weather: { latitude, longitude, location_name } }} config
 */
async function runFetch(config) {
  const { latitude, longitude, location_name } = config.weather;
  log.info(`Fetching weather for ${location_name} (${latitude}, ${longitude})`);

  try {
    const data = await fetchFromOpenMeteo(latitude, longitude);
    const cur  = data.current;

    const reading = {
      recorded_at:        new Date().toISOString(),
      temperature_c:      cur.temperature_2m,
      humidity_pct:       cur.relative_humidity_2m,
      pressure_hpa:       cur.surface_pressure,
      wind_speed_kmh:     cur.wind_speed_10m,
      wind_direction_deg: cur.wind_direction_10m,
      weather_code:       cur.weather_code,
      weather_description: db.getWmoDescription(cur.weather_code),
    };

    db.insertReading(reading);
    log.info(
      `Weather recorded: ${reading.temperature_c}°C, ` +
      `${reading.humidity_pct}% RH, ${reading.weather_description}`
    );
  } catch (err) {
    log.error(`Weather fetch failed: ${err.message}`);
  }
}

/**
 * Start the weather fetcher.
 *
 * Runs an immediate fetch on startup, then schedules according to
 * `config.weather.fetch_cron` (default: "5 * * * *").
 *
 * @param {object} config
 */
function start(config) {
  const cronExpr = config.weather.fetch_cron ?? '5 * * * *';

  // Fetch immediately so the database has data on first startup
  runFetch(config).catch(() => {});

  cron.schedule(cronExpr, () => runFetch(config).catch(() => {}));
  log.info(`Weather fetcher scheduled (${cronExpr})`);
}

module.exports = { start };
