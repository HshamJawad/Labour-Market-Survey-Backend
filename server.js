'use strict';

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const store     = require('./store');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Lazy Anthropic client ───────────────────────────────────────────────────
let _ai = null;
function ai() {
    if (!_ai) _ai = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
    return _ai;
}

// ─── GET / ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({
    name: 'LMS MVP API',
    routes: [
        'GET  /health',
        'GET  /api/surveys',
        'POST /api/import',
        'GET  /api/responses?surveyId=&enumeratorId=',
        'POST /api/analyze'
    ]
}));

// ─── GET /health ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    claudeKey: !!process.env.CLAUDE_API_KEY
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

// ─── POST /api/analyze ───────────────────────────────────────────────────────
// Body: { surveyId, type: "summary"|"insights"|"recommendations"|"custom", prompt?, language?: "en"|"ar" }
app.post('/api/analyze', async (req, res) => {
    try {
        if (!process.env.CLAUDE_API_KEY) {
            return res.status(500).json({ error: 'CLAUDE_API_KEY is not set' });
        }

        const { surveyId, type = 'summary', prompt = '', language = 'en' } = req.body;
        if (!surveyId) return res.status(400).json({ error: 'surveyId is required' });

        const rows = store.queryResponses({ surveyId });
        if (rows.length === 0) {
            return res.status(400).json({ error: 'No responses found for this survey' });
        }

        // Build compact aggregate — never send raw PII to Claude
        const meta    = { gender: {}, age: {}, education: {} };
        const answers = {};
        let completed = 0;

        rows.forEach(r => {
            if (r.completed) completed++;
            ['gender', 'age', 'education'].forEach(f => {
                const v = r.meta?.[f] || '—';
                meta[f][v] = (meta[f][v] || 0) + 1;
            });
            Object.entries(r.answers || {}).forEach(([q, a]) => {
                answers[q] ??= {};
                answers[q][String(a)] = (answers[q][String(a)] || 0) + 1;
            });
        });

        const dataset = { totalResponses: rows.length, completedResponses: completed, demographics: meta, questions: answers };

        const TASKS = {
            summary:         'Write a professional summary report: demographics overview, key findings per question, notable trends, brief conclusion.',
            insights:        'Extract key insights: significant findings, skill gaps, demographic correlations, labour market patterns visible in the data.',
            recommendations: 'Provide actionable recommendations for: policy makers, TVET institutions, employers, and future survey improvements.',
            custom:          prompt || 'Provide a general analysis.'
        };

        const langNote = language === 'ar'
            ? 'أجب باللغة العربية الفصحى المناسبة للتقارير الرسمية.'
            : 'Respond in English. Use formal professional language.';

        const msg = await ai().messages.create({
            model:      'claude-opus-4-6',
            max_tokens: 2048,
            system:     'You are an expert labour market analyst. Produce concise, data-driven professional reports.',
            messages: [{
                role: 'user',
                content: `Survey data (aggregated, no PII):\n${JSON.stringify(dataset, null, 2)}\n\nTask: ${TASKS[type] || TASKS.summary}\n\n${langNote}`
            }]
        });

        const analysis = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

        res.json({
            ok: true, surveyId, type, language,
            totalRecords: rows.length,
            analysis
        });

    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`LMS MVP running on :${PORT}`));
