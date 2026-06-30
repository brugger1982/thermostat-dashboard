const fs = require('fs');

const path = 'public/style.css';
let content = fs.readFileSync(path, 'utf8');

// 1. Remove the bad insert at the top (after .brand p {)
// The bad insert starts with /* --- Daily Usage Calendar View --- */ and ends with } \n    color: var(--text-dim);
// Let's use regex to find and remove the calendar CSS block.
const calendarBlockRegex = /\/\* \-\-\- Daily Usage Calendar View \-\-\- \*\/[\s\S]*?\}\s*\}/g;

let matches = content.match(calendarBlockRegex);
if (matches) {
    for (let match of matches) {
        content = content.replace(match, '');
    }
}

// 2. Remove the old daily-row CSS at the bottom
const oldDailyRowRegex = /\.daily-row \{[\s\S]*?\.demand-block \{ align-items: flex-start; flex-direction: row; gap: 20px;\}\s*\}/g;
let oldMatches = content.match(oldDailyRowRegex);
if (oldMatches) {
    for (let match of oldMatches) {
        content = content.replace(match, '');
    }
}

// Also remove .daily-list-container
content = content.replace(/\.daily-list-container \{[\s\S]*?\}/, '');

// Clean up any double empty lines
content = content.replace(/\n\s*\n\s*\n/g, '\n\n');

// 3. Append the clean calendar CSS at the very end
const cleanCalendarCSS = `
/* --- Daily Usage Calendar View --- */
.calendar-wrapper {
    background: var(--card-bg);
    border: 1px solid var(--glass-border);
    border-radius: 20px;
    padding: 24px;
    margin-bottom: 40px;
}
.calendar-header-row {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    text-align: center;
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--text-dim);
    margin-bottom: 15px;
    gap: 8px;
}
.calendar-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 8px;
}
.calendar-cell {
    aspect-ratio: 0.85;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
    transition: all 0.2s;
}
.calendar-cell:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.2);
}
.calendar-cell.empty-padding {
    background: transparent;
    border: none;
    pointer-events: none;
}
.calendar-cell.future-blank {
    background: rgba(255, 255, 255, 0.01);
    opacity: 0.5;
}
.calendar-cell.no-data {
    background: rgba(255, 255, 255, 0.02);
    opacity: 0.7;
    justify-content: center;
    align-items: center;
}
.no-data-msg {
    font-size: 0.8rem;
    color: var(--text-dim);
    font-style: italic;
    margin-top: 10px;
}

/* Mini Premium Card inside Calendar Cell */
.mini-premium-card {
    cursor: pointer;
}
.mini-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
}
.cell-date-label {
    font-family: 'Outfit', sans-serif;
    font-weight: 700;
    font-size: 1.2rem;
    color: var(--text);
}
.mini-comparison {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
}
.mini-runtime-section {
    margin-top: auto;
}
.runtime-bar-bg {
    background: rgba(0,0,0,0.4);
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
}
.runtime-bar-fill {
    height: 100%;
    border-radius: 2px;
}

/* Mobile Responsive */
@media (max-width: 768px) {
    .calendar-header-row {
        display: none;
    }
    .calendar-grid {
        grid-template-columns: 1fr;
        gap: 12px;
    }
    .calendar-cell {
        aspect-ratio: auto;
        min-height: 100px;
        flex-direction: row;
        align-items: center;
        padding: 16px;
        gap: 20px;
    }
    .calendar-cell.empty-padding {
        display: none;
    }
    .mini-card-header {
        flex-direction: column;
        margin-bottom: 0;
        align-items: flex-start;
        gap: 8px;
        width: 60px;
    }
    .mini-comparison {
        margin-bottom: 0 !important;
        flex: 1;
        background: transparent;
    }
    .mini-runtime-section {
        flex: 1;
        margin-top: 0;
    }
}
`;

content += '\n' + cleanCalendarCSS;

fs.writeFileSync(path, content, 'utf8');
console.log('Fixed style.css');
