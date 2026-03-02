'use strict';

const express = require('express');
const cors    = require('cors');
const store   = require('./store');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── GET / ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({
    name: 'LMS MVP API',
    routes: [
        'GET  /health',
        'GET  /api/surveys',
        'POST /api/import',
        'GET  /api/responses?surveyId=&enumeratorId='
    ]
}));

// ─── GET /health ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
    status:    'ok',
    timestamp: new Date().toISOString()
}));

// ─── GET /api/surveys ────────────────────────────────────────────────────────
app.get('/api/surveys', (_req, res) => {
    res.json({ surveys: store.getSurveys() });
});

// ─── POST /api/import ────────────────────────────────────────────────────────
// Accepts the exact JSON exported by enumerator.html (v1.0 and legacy formats)
app.post('/api/import', (req, res) => {
    try {
        const obj = req.body;
        if (!obj || typeof obj !== 'object') {
            return res.status(400).json({ error: 'Invalid JSON' });
        }

        // Detect format
        const isV1 = obj.version === '1.0' && Array.isArray(obj.responses);
        if (!isV1 && !obj.respondents) {
            return res.status(400).json({ error: 'Unrecognised format — need responses[] or respondents' });
        }

        // Survey metadata
        const surveyId   = isV1 ? (obj.survey_info?.id   || 'unknown') : (obj.surveyId   || 'unknown');
        const surveyName = isV1 ? (obj.survey_info?.name || surveyId)  : (obj.surveyName  || surveyId);
        const org        = isV1 ? (obj.survey_info?.organization || '') : '';
        const loc        = isV1 ? (obj.survey_info?.location     || '') : '';

        // Enumerator
        const fileEnum = isV1 ? (obj.enumerator_info?.name || '') : (obj.enumeratorId || '');

        store.registerSurvey({ surveyId, surveyName, organization: org, location: loc });

        // Normalise to array
        const items = isV1
            ? obj.responses
            : (Array.isArray(obj.respondents)
                ? obj.respondents
                : Object.entries(obj.respondents).map(([id, r]) => ({ respondentId: id, ...r })));

        let added = 0, skipped = 0;

        for (const r of items) {
            const respondentId = r.id || r.respondentId || ('R-' + Math.random().toString(36).slice(2, 8));
            const meta         = r.respondent || r.meta || {};
            const answers      = (typeof r.answers === 'object' && !Array.isArray(r.answers)) ? r.answers : {};
            const startTime    = r.start_time || r.startTime || '';
            const endTime      = r.end_time   || r.endTime   || '';
            const enumeratorId = r.enumeratorId || fileEnum;
            const completed    = r.completed === true || r.completed === 'Yes';

            const { ok } = store.insertResponse({
                respondentId, surveyId, surveyName, enumeratorId,
                meta, answers, startTime, endTime, completed
            });

            ok ? added++ : skipped++;
        }

        res.status(201).json({ ok: true, surveyId, enumerator: fileEnum, added, skipped });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── GET /api/responses ──────────────────────────────────────────────────────
app.get('/api/responses', (req, res) => {
    const rows = store.queryResponses({
        surveyId:     req.query.surveyId,
        enumeratorId: req.query.enumeratorId
    });

    const enumerators = [...new Set(rows.map(r => r.enumeratorId).filter(Boolean))].sort();
    const completed   = rows.filter(r => r.completed).length;

    res.json({
        total:        rows.length,
        completed,
        incomplete:   rows.length - completed,
        enumerators,
        responses:    rows
    });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`LMS MVP running on :${PORT}`));
