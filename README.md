# 🏠 Nest Thermostat Analytics Dashboard

A premium, glassmorphism-style dashboard that compares your Google Nest HVAC runtime data against local environmental metrics (Outdoor Mean Temperature, Wind Speed, Solar Radiation, and Degree Days).

## ✨ Features

- **Automated Monthly Rollover**: Automatically detects new months and creates fresh analytics cards without manual intervention.
- **Smart Environmental Benchmarking**: Calculates Heating Degree Days (HDD) and Cooling Degree Days (CDD) to measure how hard your HVAC is working relative to the weather.
- **Real-Time Nest Polling**: Syncs with the Nest API every 60 seconds to track live runtime statistics.
- **Periodic Weather Sync**: Automatically fetches missing historical weather data every 12 hours.
- **Legacy Support**: Includes a comprehensive loader for Nest Takeout (JSON/JSONL) to import years of historical history.
- **Premium UI**: Dark-mode interface featuring dynamic efficiency badges, environmental iconography, and relative performance scaling.

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js** (v16+)
- **PostgreSQL** (Local or hosted like Neon.tech)
- **Visual Crossing API Key**: Required for local weather data.
- **Google Nest Device Access**: Required for live thermostat polling.

### 2. Environment Setup
Create a `.env` file in the root directory (this file is git-ignored for security):

```env
DATABASE_URL=your_postgres_connection_string
VC_WEATHER_KEY=your_visual_crossing_key
ZIP_CODE=your_zip_code
NEST_PROJECT_ID=your_nest_project_id
CLIENT_ID=your_google_client_id
CLIENT_SECRET=your_google_client_secret
PORT=3000

# Optional: Neon API keys for ephemeral dev branching workflow
NEON_API_KEY=your_neon_api_key
NEON_PROJECT_ID=your_neon_project_id
```

### 3. Installation & Running

Initialize the project dependencies and setup views:
```bash
npm install
node setupViews.js  # Initializes the database analytics views on the main database
```

#### Development Mode (with Ephemeral Neon Branches)
Running the dev server will automatically create a copy-on-write dev database branch from your production data, connect to it with Nest polling enabled, and delete the branch when you exit:
```bash
npm run dev
```
*(Requires `NEON_API_KEY` and `NEON_PROJECT_ID` configured in `.env`)*

If you want to run the dev server and connect directly to your production/configured `DATABASE_URL` without creating branches, run:
```bash
npm run dev:no-branch
```

#### Production Mode
Starts the web application directly using the production `DATABASE_URL`:
```bash
npm start
```

## 📊 Data & Automation

- **`server.js`**: The heart of the application. Handles the API, live Nest polling, and 12-hour weather synchronization.
- **`takeoutLoader.js`**: Use this to backfill historical data from your Nest Takeout folder.
- **`v_monthly_analytics`**: A PostgreSQL view that automatically handles all month/year transitions and cross-references weather data with HVAC runtime.

## 🛠️ Tech Stack
- **Backend**: Node.js, Express
- **Database**: PostgreSQL
- **Frontend**: Vanilla JS, HTML5, Glassmorphism CSS
- **APIs**: Google SDM (Nest), Visual Crossing (Weather)
