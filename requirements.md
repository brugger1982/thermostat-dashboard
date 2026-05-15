# Thermostat & Climate Dashboard Requirements

## Project Overview
A web-based dashboard to correlate household HVAC runtime with historical and real-time weather data (HDD/CDD) to analyze long-term energy efficiency.

## Phase 1: Weather Data Sync (Current)
- [x] Implement "Replay" sync for historical weather data (2019-Present).
- [x] Use Visual Crossing Timeline API for Heating/Cooling Degree Days.
- [x] Calculate HDD/CDD using a 65°F base temperature.
- [x] Implement local micro-batching (100-day chunks) to respect API quotas.
- [x] **New:** Migrate data from local JSON to Neon Postgres for cloud readiness.

## Phase 2: Thermostat Integration & GCP Deployment (In Progress)
### 1. Storage & Hosting
- [x] **Database:** Use Neon Postgres for all persistent data (Weather & Runtime).
- [ ] **Hosting:** Deploy to Google Cloud Run (Stateless Container).
- [ ] **Infrastructure:** Link existing GCP Project for SDM API Access.

### 2. Nest SDM API Integration
- [ ] **OAuth2 Flow:** Implement authorization for Google Nest access.
- [ ] **Live Runtime Logger:** 
    - Poll the Nest API every 2-5 minutes.
    - Record `hvacStatus` (HEATING/COOLING/OFF).
    - Accumulate daily runtime minutes in the `thermostat_runtime` table.
- [ ] **Historical Backfill:** 
    - Create an importer for Google Takeout files (JSON/CSV) to populate 2019-2024 data.

### 3. Visualization
- [ ] Build a dashboard to compare `Runtime Minutes / Degree Day` by month.
- [ ] Visualize seasonal efficiency trends.

## Data Schema (Postgres)
### `weather_daily`
- `date` (Primary Key)
- `hdd` / `cdd` (Heating/Cooling Degree Days)
- `tmax` / `tmin` (Max/Min Temperatures)

### `thermostat_runtime`
- `date` (Primary Key)
- `heat_mins` / `ac_mins` (Total accumulated runtime)
- `avg_setpoint` (Average daily target temp)
