'use strict';

const fs   = require('fs');
const path = require('path');

// On Railway, use the mounted volume if available; otherwise write locally
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH)
    : path.join(__dirname, 'data');

const FILE = path.join(DATA_DIR, 'responses.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Load from disk once at startup; keep everything in memory for fast reads
let _data = { surveys: {}, responses: {} };

try {
    if (fs.existsSync(FILE)) {
        _data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        console.log(`[store] loaded ${Object.keys(_data.responses).length} responses from ${FILE}`);
    }
} catch (e) {
    console.warn('[store] could not read data file, starting fresh:', e.message);
}

// Write to disk (debounced — max one write per 500 ms)
let _saveTimer = null;
function persist() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try { fs.writeFileSync(FILE, JSON.stringify(_data, null, 2)); }
        catch (e) { console.error('[store] write failed:', e.message); }
    }, 500);
}

/* ─── Public API ─────────────────────────────────────────────────────────── */

/** Register a survey (auto-called on import) */
function registerSurvey({ surveyId, surveyName = '', organization = '', location = '' }) {
    if (!_data.surveys[surveyId]) {
        _data.surveys[surveyId] = { surveyId, surveyName, organization, location, createdAt: new Date().toISOString() };
    } else {
        const s = _data.surveys[surveyId];
        if (!s.surveyName  && surveyName)  s.surveyName  = surveyName;
        if (!s.organization && organization) s.organization = organization;
        if (!s.location    && location)    s.location    = location;
    }
    persist();
    return _data.surveys[surveyId];
}

/** Get all surveys with live counts */
function getSurveys() {
    return Object.values(_data.surveys).map(s => ({
        ...s,
        total:     Object.values(_data.responses).filter(r => r.surveyId === s.surveyId).length,
        completed: Object.values(_data.responses).filter(r => r.surveyId === s.surveyId && r.completed).length
    }));
}

/** Insert one response; skip if pk already exists */
function insertResponse(doc) {
    // pk includes enumeratorId so two enumerators with the same respondentId
    // (e.g. both start at LMS-00001 after a reset) are stored as separate records
    const enumPart = (doc.enumeratorId || 'anon').replace(/::/g, '-');
    const pk = `${doc.surveyId}::${enumPart}::${doc.respondentId}`;
    if (_data.responses[pk]) return { ok: false, pk };
    _data.responses[pk] = { ...doc, _pk: pk, savedAt: new Date().toISOString() };
    persist();
    return { ok: true, pk };
}

/** Query responses with optional filters */
function queryResponses({ surveyId, enumeratorId } = {}) {
    let rows = Object.values(_data.responses);
    if (surveyId)     rows = rows.filter(r => r.surveyId     === surveyId);
    if (enumeratorId) rows = rows.filter(r => r.enumeratorId === enumeratorId);
    return rows;
}

/** Clear all responses and surveys */
function clearAll() {
    _data = { surveys: {}, responses: {} };
    persist();
}

module.exports = { registerSurvey, getSurveys, insertResponse, queryResponses, clearAll };
