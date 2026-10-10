require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;
if (!ai) console.warn('Gemini AI is disabled: set GEMINI_API_KEY or GOOGLE_API_KEY in .env.');
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.8-flash';

let pushReady = false;
try {
    const webpush = require('web-push');
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@soilbuddies.org', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
        pushReady = true;
    }
} catch (e) { console.log('web-push not installed: push notifications disabled.'); }

/* ---------- helpers ---------- */
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const cache = new Map();
const pendingCache = new Map();
async function cached(key, ttl, fn) {
    const h = cache.get(key);
    if (h && Date.now() - h.t < ttl) return h.v;
    if (pendingCache.has(key)) return pendingCache.get(key);
    const request = Promise.resolve().then(fn).then(v => {
        cache.set(key, { t: Date.now(), v });
        return v;
    }).finally(() => pendingCache.delete(key));
    pendingCache.set(key, request);
    return request;
}
const authenticateToken = (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.redirect('/login');
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.redirect('/login');
        req.user = user; next();
    });
};

/* ---------- pages ---------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));
app.get('/dashboard', authenticateToken, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

/* ---------- auth ---------- */
app.post('/register', async (req, res) => {
    try {
        const { fullname, email, password } = req.body;
        const { data: existing } = await supabase.from('farmers').select('id').eq('email', email);
        if (existing && existing.length) return res.status(400).send('Email already registered. Please log in.');
        const { error } = await supabase.from('farmers').insert([{ full_name: fullname, email, password_hash: await bcrypt.hash(password, 10) }]);
        if (error) throw error;
        res.redirect('/login');
    } catch (err) { console.error(err); res.status(500).send('Server error during registration'); }
});
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const { data: users, error } = await supabase.from('farmers').select('*').eq('email', email);
        if (error || !users || !users.length) return res.status(401).send('Invalid email or password');
        const user = users[0];
        if (!(await bcrypt.compare(password, user.password_hash))) return res.status(401).send('Invalid email or password');
        const token = jwt.sign({ id: user.id, email: user.email, fullname: user.full_name }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 864e5 });
        res.redirect('/dashboard');
    } catch (err) { console.error(err); res.status(500).send('Server error during login'); }
});
app.get('/logout', (req, res) => {
    res.clearCookie('token', { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
    res.redirect('/login');
});
app.get('/api/me', authenticateToken, (req, res) => res.json({ id: req.user.id, email: req.user.email, fullname: req.user.fullname }));

/* ---------- data access (per farmer, no fake defaults) ---------- */
async function getCoords(farmerId) {
    try {
        const { data } = await supabase.from('farmer_locations').select('latitude, longitude').eq('farmer_id', String(farmerId)).maybeSingle();
        if (data) return { lat: Number(data.latitude), lon: Number(data.longitude), known: true };
    } catch (e) {}
    return { lat: -23.887, lon: 29.7361, known: false };
}
async function getProfile(id) {
    try { const { data } = await supabase.from('farm_profiles').select('*').eq('farmer_id', String(id)).maybeSingle(); return data || null; }
    catch (e) { return null; }
}
async function getReadings(farmerId, n) {
    try {
        const { data } = await supabase.from('soil_sensors').select('*').eq('farmer_id', String(farmerId)).order('recorded_at', { ascending: false }).limit(n);
        return data || [];
    } catch (e) { return []; }
}

/* ---------- climate (20 years of real history) + forecast ---------- */
async function getClimate(lat, lon) {
    return cached(`clim:${lat.toFixed(1)},${lon.toFixed(1)}`, 7 * 864e5, async () => {
        const end = new Date().getFullYear() - 1, N = 20;
        const r = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${end - N + 1}-01-01&end_date=${end}-12-31&daily=temperature_2m_mean,temperature_2m_min,precipitation_sum&timezone=auto`);
        if (!r.ok) throw new Error('Archive ' + r.status);
        const d = (await r.json()).daily;
        const m = Array.from({ length: 12 }, () => ({ t: 0, mn: 0, rain: 0, frost: 0, n: 0 })), yT = {}, yR = {};
        d.time.forEach((day, i) => {
            const t = d.temperature_2m_mean[i]; if (t == null) return;
            const y = +day.slice(0, 4), o = m[+day.slice(5, 7) - 1], p = d.precipitation_sum[i] || 0, mn = d.temperature_2m_min[i];
            o.n++; o.t += t; o.mn += mn; o.rain += p; if (mn <= 2) o.frost++;
            (yT[y] = yT[y] || []).push(t); yR[y] = (yR[y] || 0) + p;
        });
        const months = m.map(o => ({ temp: +(o.t / o.n).toFixed(1), min: +(o.mn / o.n).toFixed(1), rain: Math.round(o.rain / N), frostPct: Math.round(100 * o.frost / o.n) }));
        const ys = Object.keys(yT).map(Number).sort(), h = ys.length >> 1, A = ys.slice(0, h), B = ys.slice(h);
        const annualRain = months.reduce((s, x) => s + x.rain, 0);
        const hot = months.reduce((a, x, i) => x.temp > months[a].temp ? i : a, 0);
        const cold = months.reduce((a, x, i) => x.temp < months[a].temp ? i : a, 0);
        return {
            months, annualRain,
            type: annualRain < 400 ? 'Dry area' : annualRain < 800 ? 'Moderately dry area' : 'Wet area',
            hot: { month: MON[hot], temp: months[hot].temp }, cold: { month: MON[cold], temp: months[cold].temp },
            rainyMonths: months.map((x, i) => x.rain >= annualRain / 12 * 1.3 ? MON[i] : null).filter(Boolean),
            frostMonths: months.map((x, i) => x.frostPct >= 5 ? MON[i] : null).filter(Boolean),
            warmingC: +(avg(B.map(y => avg(yT[y]))) - avg(A.map(y => avg(yT[y])))).toFixed(2),
            rainChangePct: Math.round(100 * (avg(B.map(y => yR[y])) / avg(A.map(y => yR[y])) - 1))
        };
    });
}
async function getForecast(lat, lon) {
    return cached(`fc:${lat.toFixed(2)},${lon.toFixed(2)}`, 10 * 60 * 1000, async () => {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&hourly=temperature_2m,weather_code,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum&past_days=2&forecast_days=7&timezone=auto`);
        if (!r.ok) throw new Error('Open-Meteo ' + r.status);
        return r.json();
    });
}
app.get('/api/weather', authenticateToken, async (req, res) => {
    try {
        const { lat, lon, known } = await getCoords(req.user.id);
        const climateKey = `clim:${lat.toFixed(1)},${lon.toFixed(1)}`;
        const cachedClimate = cache.get(climateKey);
        const climate = cachedClimate ? cachedClimate.v : null;
        if (!cachedClimate || Date.now() - cachedClimate.t >= 7 * 864e5) {
            getClimate(lat, lon).catch(err => console.error('Climate history:', err.message));
        }
        const d = await getForecast(lat, lon);
        const h = d.hourly, dd = d.daily, now = Math.max(0, h.time.findIndex(t => t >= d.current.time));
        const sum = (a, b) => +h.precipitation.slice(Math.max(0, a), b).reduce((x, y) => x + (y || 0), 0).toFixed(1);
        const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], c = d.current.weather_code;
        res.json({
            temp: Math.round(d.current.temperature_2m), humidity: d.current.relative_humidity_2m, windSpeed: d.current.wind_speed_10m,
            condition: c === 0 ? 'Clear sky' : c <= 3 ? 'Partly cloudy' : c >= 95 ? 'Thunderstorm' : (c >= 51 && c <= 67) || (c >= 80 && c <= 82) ? 'Rain' : 'Cloudy',
            high: Math.round(dd.temperature_2m_max[2]), low: Math.round(dd.temperature_2m_min[2]),
            rain48h: sum(now - 48, now), rainFuture48h: sum(now, now + 48),
            rain7d: +dd.precipitation_sum.slice(2).reduce((x, y) => x + (y || 0), 0).toFixed(1),
            hourly: h.time.slice(now, now + 6).map((t, i) => ({ time: i ? t.slice(11, 16) : 'Now', temp: Math.round(h.temperature_2m[now + i]), code: h.weather_code[now + i] })),
            daily: dd.time.slice(2, 7).map((t, i) => ({ day: i ? D[new Date(t).getDay()] : 'Today', max: Math.round(dd.temperature_2m_max[i + 2]), min: Math.round(dd.temperature_2m_min[i + 2]), code: dd.weather_code[i + 2], pop: dd.precipitation_probability_max[i + 2] })),
            city: known ? 'Your farm' : 'Default location (farm location not set)', locationKnown: known, climate
        });
    } catch (e) { console.error('Weather:', e.message); res.status(502).json({ error: 'Weather unavailable' }); }
});
app.get('/api/climate', authenticateToken, async (req, res) => {
    try {
        const { lat, lon } = await getCoords(req.user.id);
        res.json(await getClimate(lat, lon));
    } catch (e) {
        console.error('Climate history:', e.message);
        res.status(502).json({ error: 'Climate history unavailable' });
    }
});

/* ---------- farmer location ---------- */
app.post('/api/location', authenticateToken, async (req, res) => {
    const lat = Number(req.body.latitude), lng = Number(req.body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'Invalid coordinates.' });
    try {
        const row = { farmer_id: String(req.user.id), latitude: +lat.toFixed(4), longitude: +lng.toFixed(4), updated_at: new Date().toISOString() };
        await supabase.from('farmer_locations').upsert(row, { onConflict: 'farmer_id' });
        res.json({ success: true, ...row });
    } catch (err) { res.json({ success: true, latitude: lat, longitude: lng }); }
});
app.get('/api/location', authenticateToken, async (req, res) => {
    try {
        const { data } = await supabase.from('farmer_locations').select('*').eq('farmer_id', String(req.user.id)).maybeSingle();
        res.json({ location: data || null });
    } catch (err) { res.json({ location: null }); }
});

/* ---------- crop knowledge (one table feeds Problem AI and recommendations) ---------- */
const GENERAL = { ph: [6.0, 7.0], moisture: [35, 65], nHungry: true };
const CROPS = {
    Tomato:  { ph: [6.0, 6.8], moisture: [40, 70], temp: [18, 28], frost: true,  water: 'high', nHungry: true,  soils: ['loam', 'sandy loam', 'clay loam'] },
    Pepper:  { ph: [6.0, 6.8], moisture: [40, 65], temp: [18, 30], frost: true,  water: 'med',  nHungry: true,  soils: ['loam', 'sandy loam'] },
    Carrot:  { ph: [6.0, 6.8], moisture: [35, 60], temp: [14, 24], frost: false, water: 'med',  nHungry: false, soils: ['sandy loam', 'sandy', 'loam'] },
    Maize:   { ph: [5.8, 7.0], moisture: [40, 65], temp: [18, 30], frost: true,  water: 'med',  nHungry: true,  soils: ['loam', 'sandy loam', 'clay loam'] },
    Potato:  { ph: [5.0, 6.5], moisture: [40, 65], temp: [12, 22], frost: true,  water: 'med',  nHungry: true,  soils: ['sandy loam', 'loam'] },
    Spinach: { ph: [6.5, 7.5], moisture: [40, 65], temp: [10, 22], frost: false, water: 'med',  nHungry: true,  soils: ['loam', 'sandy loam', 'clay loam'] },
    Cabbage: { ph: [6.0, 7.0], moisture: [40, 65], temp: [12, 24], frost: false, water: 'med',  nHungry: true,  soils: ['loam', 'clay loam', 'sandy loam'] },
    Onion:   { ph: [6.0, 7.0], moisture: [35, 60], temp: [12, 26], frost: false, water: 'low',  nHungry: true,  soils: ['sandy loam', 'loam'] },
    Beans:   { ph: [6.0, 7.0], moisture: [35, 60], temp: [16, 28], frost: true,  water: 'low',  nHungry: false, soils: ['loam', 'sandy loam', 'sandy'] },
    Lettuce: { ph: [6.0, 7.0], moisture: [40, 70], temp: [10, 22], frost: false, water: 'med',  nHungry: true,  soils: ['loam', 'sandy loam'] }
};
function profileFor(name) {
    let lc = String(name).toLowerCase(); if (lc.includes('corn')) lc = 'maize';
    const key = Object.keys(CROPS).find(k => lc.includes(k.toLowerCase().replace(/s$/, '')));
    return key ? CROPS[key] : null;
}
function parseCrops(v) {
    return String(v || '').split(',').map(c => c.replace(/[^\p{L}\p{N} \-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean).slice(0, 3);
}

/* ---------- Problem AI: soil alerts from sensor ---------- */
const LABEL = { 'low-nitrogen': 'Low nitrogen', 'low-ph': 'Soil too acidic', 'high-ph': 'Soil too alkaline', 'low-moisture': 'Soil too dry', 'high-moisture': 'Soil too wet' };
const HARM = {
    'low-nitrogen': 'leaves can turn pale and growth slows', 'low-ph': 'roots struggle and nutrients get locked in the soil',
    'high-ph': 'iron and other nutrients become hard to absorb, so leaves can yellow', 'low-moisture': 'plants can wilt and growth stalls',
    'high-moisture': 'roots can rot from lack of air'
};
const ADVICE = {
    'low-nitrogen': 'Apply well-rotted compost or an organic nitrogen feed around the plants, water it in lightly, then re-check the nitrogen reading in about 7 days.',
    'low-ph': 'Work agricultural lime into the soil gradually, following the rate on the product label, and re-test the pH after 2 to 3 weeks.',
    'high-ph': 'Mix in compost or elemental sulphur gradually and avoid liming. Re-test the pH after 2 to 3 weeks.',
    'low-moisture': 'Water deeply, ideally early morning, and add a layer of mulch to hold moisture. Check the moisture reading again after watering.',
    'high-moisture': 'Pause irrigation, improve drainage and watch for yellowing leaves. Re-check moisture in a day or two.'
};
function evaluateSoil(reading, crops) {
    const ph = Number(reading.ph_level), m = Number(reading.moisture_level), n = String(reading.nitrogen_status || '').toLowerCase();
    const found = new Map();
    const note = (key, severity, detail, crop) => {
        let e = found.get(key);
        if (!e) { e = { key, severity, detail, crops: [] }; found.set(key, e); }
        if (severity === 'critical') e.severity = 'critical';
        if (crop && !e.crops.includes(crop)) e.crops.push(crop);
    };
    const targets = crops.length ? crops.map(c => ({ name: c, p: profileFor(c) || GENERAL })) : [{ name: null, p: GENERAL }];
    for (const { name, p } of targets) {
        const who = name && p !== GENERAL ? `${name} prefers` : 'the general healthy range is';
        if (n === 'low' && p.nHungry) note('low-nitrogen', 'critical', 'Nitrogen is Low.', name);
        if (!isNaN(ph)) {
            if (ph < p.ph[0]) note('low-ph', ph < p.ph[0] - 1 ? 'critical' : 'warning', `Soil pH is ${ph}, which is too acidic. ${who} ${p.ph[0]} to ${p.ph[1]}.`, name);
            else if (ph > p.ph[1]) note('high-ph', ph > p.ph[1] + 1 ? 'critical' : 'warning', `Soil pH is ${ph}, which is too alkaline. ${who} ${p.ph[0]} to ${p.ph[1]}.`, name);
        }
        if (!isNaN(m)) {
            if (m < p.moisture[0]) note('low-moisture', m < p.moisture[0] - 15 ? 'critical' : 'warning', `Soil moisture is ${m}%, which is too dry. ${who} ${p.moisture[0]}% to ${p.moisture[1]}%.`, name);
            else if (m > p.moisture[1]) note('high-moisture', m > p.moisture[1] + 15 ? 'critical' : 'warning', `Soil moisture is ${m}%, which is too wet. ${who} ${p.moisture[0]}% to ${p.moisture[1]}%.`, name);
        }
    }
    const rank = { critical: 0, warning: 1 };
    return [...found.values()].map(e => ({
        id: 'soil:' + e.key, issue: e.key, label: LABEL[e.key], severity: e.severity, title: 'Soil alert: ' + LABEL[e.key], detail: e.detail,
        harm: e.crops.length ? `May harm ${e.crops.join(', ')}: ${HARM[e.key]}.` : '', crops: e.crops, advice: ADVICE[e.key]
    })).sort((a, b) => rank[a.severity] - rank[b.severity]);
}
async function getPlantedCrops(farmerId) {
    try {
        const { data } = await supabase.from('planted_crops').select('crop_name').eq('farmer_id', String(farmerId));
        if (data && data.length) return data.map(r => r.crop_name).slice(0, 3);
    } catch (e) {}
    return [];
}
function computeChange(cur, prev) {
    if (!prev) return null;
    const ph = +(Number(cur.ph_level) - Number(prev.ph_level)).toFixed(2), mo = +(Number(cur.moisture_level) - Number(prev.moisture_level)).toFixed(1);
    return { ph: isNaN(ph) ? 0 : ph, moisture: isNaN(mo) ? 0 : mo, nitrogen_from: String(prev.nitrogen_status) !== String(cur.nitrogen_status) ? prev.nitrogen_status : null };
}
app.get('/api/alerts', authenticateToken, async (req, res) => {
    try {
        const [cur, prev] = await getReadings(req.user.id, 2);
        if (!cur) return res.json({ reading: null, change: null, crops: [], alerts: [] });
        const q = parseCrops(req.query.crop), crops = q.length ? q : await getPlantedCrops(req.user.id);
        res.json({ reading: cur, change: computeChange(cur, prev), crops, alerts: evaluateSoil(cur, crops) });
    } catch (err) { console.error('Alerts error:', err); res.status(500).json({ error: 'Failed to load alerts.' }); }
});
app.post('/api/crop', authenticateToken, async (req, res) => {
    const crops = parseCrops(req.body.crop);
    try {
        await supabase.from('planted_crops').delete().eq('farmer_id', String(req.user.id));
        if (crops.length) await supabase.from('planted_crops').insert(crops.map(c => ({ farmer_id: String(req.user.id), crop_name: c })));
    } catch (e) {}
    res.json({ success: true, crops });
});
app.get('/api/push/key', authenticateToken, (req, res) => res.json({ key: pushReady ? process.env.VAPID_PUBLIC_KEY : null }));
app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
    try {
        const sub = req.body;
        if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription.' });
        const { error } = await supabase.from('push_subscriptions').upsert({ farmer_id: String(req.user.id), endpoint: sub.endpoint, subscription: sub }, { onConflict: 'endpoint' });
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { console.error('Subscribe error:', err); res.status(500).json({ error: 'Could not save subscription.' }); }
});

/* ---------- Agri-Talk (general farming AI) ---------- */
const OFF_TOPIC_TAG = 'OFF_TOPIC';
const OFF_TOPIC_REPLY = "I'm Agri-Talk, and I can only help with farming and agriculture. Ask me about soil health, pH, nutrients, crops, planting seasons, or irrigation.";
function buildSystemInstruction(user, r) {
    return `You are Agri-Talk, a friendly AI farming assistant for Soil Buddies. The user's name is ${user.fullname}.
Their latest live soil readings: pH ${r.ph_level}, Moisture ${r.moisture_level}%, Nitrogen: ${r.nitrogen_status}.

YOUR SCOPE IS AGRICULTURE ONLY: crops, gardening, soil, soil pH, nutrients, irrigation, pests, and farm management.

CRITICAL MULTI-LANGUAGE & TRANSLATION RULE:
- If the user asks you to speak, translate, or respond in any language (such as Sepedi, Xitsonga, Tshivenda, IsiZulu, Afrikaans, or any other language), you MUST write your entire response in that requested language while maintaining your agricultural role.

STRICT RULES:
1. Greetings and pleasantries: keep them warm and invite a farming question.
2. If the message is NOT about agriculture, reply with exactly the single word ${OFF_TOPIC_TAG} and nothing else.
3. Keep answers practical, clear, and concise.`;
}
app.post('/api/chat', authenticateToken, async (req, res) => {
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'Message content is required.' });
    if (message.length > 1000) return res.status(400).json({ error: 'Message is too long. Please keep it under 1000 characters.' });
    if (!ai) return res.status(503).json({ error: 'AI is not configured. Add GEMINI_API_KEY to the server .env file and restart the server.' });
    const reading = (await getReadings(req.user.id, 1))[0] || { ph_level: 'unknown', moisture_level: 'unknown', nitrogen_status: 'unknown' };
    const prof = await getProfile(req.user.id), planted = await getPlantedCrops(req.user.id);
    const farmCtx = `\nRECORDED FARM FACTS: soil type ${(prof && prof.soil_type) || 'not recorded'}; irrigation ${prof ? (prof.irrigated ? 'yes' : 'none recorded') : 'not recorded'}; water source ${(prof && prof.water_source) || 'not recorded'}; crops planted ${planted.join(', ') || 'not recorded'}.\nNever invent farm facts. Do not prescribe fertiliser or pesticide quantities. If information is missing, say what is needed and suggest an agricultural advisor.`;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await ai.models.generateContent({ model: MODEL(), contents: message, config: { systemInstruction: buildSystemInstruction(req.user, reading) + farmCtx, temperature: 0.4, maxOutputTokens: 700 } });
            const reply = (response.text || '').trim();
            if (!reply || reply.toUpperCase().startsWith(OFF_TOPIC_TAG)) return res.json({ reply: OFF_TOPIC_REPLY, offTopic: true });
            return res.json({ reply });
        } catch (err) {
            const status = err.status || err.statusCode;
            if (status === 401 || status === 403) {
                console.error(`Gemini authentication failed (${status}). Check GEMINI_API_KEY or GOOGLE_API_KEY.`);
                return res.status(502).json({ error: 'Gemini authentication failed. Check GEMINI_API_KEY or GOOGLE_API_KEY in the server .env file.' });
            }
            console.error(`Gemini attempt ${attempt} failed:`, err.message || err);
            if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
        }
    }
    res.status(502).json({ error: 'The AI service is temporarily unavailable. Please try again shortly.' });
});

/* ---------- Problem AI chat ---------- */
const PROBLEM_OFF_TAG = 'PROBLEM_OFF_TOPIC';
const PROBLEM_OFF_REPLY = 'Problem AI only reports soil issues from your sensor and how they affect the crop you planted. For other farming questions, please use the Agri-Talk chat.';
function buildProblemInstruction(user, reading, alerts) {
    const alertText = alerts.length ? alerts.map((a, i) => `${i + 1}. [${a.severity.toUpperCase()}] ${a.label}. ${a.detail}${a.harm ? ' ' + a.harm : ''}`).join('\n') : 'None. The soil readings are within healthy range.';
    return `You are Problem AI inside Soil Buddies. The user's name is ${user.fullname}.
You report SOIL issues only, using the farmer's soil sensor, and you explain whether the soil conditions can harm the crop the farmer says they planted.

LIVE SOIL READINGS: pH ${reading.ph_level}, Moisture ${reading.moisture_level}%, Nitrogen ${reading.nitrogen_status}.
ACTIVE SOIL ALERTS:
${alertText}

STRICT RULES:
1. Only discuss the soil readings, soil changes, soil alerts, and how soil conditions affect the farmer's crop. Reply with ${PROBLEM_OFF_TAG} if off-topic.
2. Write in clean plain text with no markdown symbols. Use numbered lists like 1. then 2.`;
}
app.post('/api/problem-chat', authenticateToken, async (req, res) => {
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'Message content is required.' });
    if (!ai) return res.status(503).json({ error: 'AI is not configured. Add GEMINI_API_KEY to the server .env file and restart the server.' });
    const history = (Array.isArray(req.body.history) ? req.body.history.slice(-8) : [])
        .map(h => ({ role: h.role === 'ai' ? 'model' : 'user', parts: [{ text: String(h.text || '').slice(0, 1000) }] }));
    const [reading] = await getReadings(req.user.id, 2);
    if (!reading) return res.json({ reply: 'No sensor readings are linked to your account yet.' });
    const bc = parseCrops(req.body.crop), crops = bc.length ? bc : await getPlantedCrops(req.user.id);
    const alerts = evaluateSoil(reading, crops);
    try {
        const response = await ai.models.generateContent({
            model: MODEL(), contents: [...history, { role: 'user', parts: [{ text: message }] }],
            config: { systemInstruction: buildProblemInstruction(req.user, reading, alerts), temperature: 0.3, maxOutputTokens: 600 }
        });
        const reply = (response.text || '').trim();
        if (!reply || reply.toUpperCase().startsWith(PROBLEM_OFF_TAG)) return res.json({ reply: PROBLEM_OFF_REPLY, offTopic: true });
        res.json({ reply });
    } catch (err) {
        const status = err.status || err.statusCode;
        if (status === 401 || status === 403) {
            console.error(`Gemini authentication failed (${status}) in Problem AI. Check GEMINI_API_KEY or GOOGLE_API_KEY.`);
            return res.status(502).json({ error: 'Gemini authentication failed. Check GEMINI_API_KEY or GOOGLE_API_KEY in the server .env file.' });
        }
        console.error('Problem AI request failed:', err.message || err);
        res.status(502).json({ error: 'The AI service is temporarily unavailable. Please try again shortly.' });
    }
});

/* ---------- Tutor (fixed) ---------- */
app.post('/api/tutor-chat', authenticateToken, async (req, res) => {
    if (!ai) return res.status(503).json({ error: 'AI is not configured. Add GEMINI_API_KEY to the server .env file and restart the server.' });
    try {
        const c = (s, n) => String(s || '').slice(0, n), [r] = await getReadings(req.user.id, 1);
        const response = await ai.models.generateContent({
            model: MODEL(),
            contents: `You are a patient farming tutor. Crop: ${c(req.body.crop, 40)}. Soil now: ${r ? `pH ${r.ph_level}, moisture ${r.moisture_level}%, nitrogen ${r.nitrogen_status}` : 'no sensor data yet'}. Step: ${c(req.body.stepTitle, 100)} - "${c(req.body.stepText, 500)}". The farmer is confused: "${c(req.body.userConfusion, 500)}". Answer in ${c(req.body.language, 20) || 'English'}, simply, with the why and how.`,
            config: { temperature: 0.3, maxOutputTokens: 600 }
        });
        res.json({ reply: (response.text || '').trim() });
    } catch (e) {
        const status = e.status || e.statusCode;
        if (status === 401 || status === 403) {
            console.error(`Gemini authentication failed (${status}) in Tutor. Check GEMINI_API_KEY or GOOGLE_API_KEY.`);
            return res.status(502).json({ error: 'Gemini authentication failed. Check GEMINI_API_KEY or GOOGLE_API_KEY in the server .env file.' });
        }
        console.error('Tutor:', e.message);
        res.status(502).json({ error: 'The AI service is temporarily unavailable. Please try again shortly.' });
    }
});

/* ---------- Crop recommendations: real data in, reasons out ---------- */
function scoreCrop(name, c, x) {
    let s = 100; const pros = [], cons = [];
    if (x.ph >= c.ph[0] && x.ph <= c.ph[1]) pros.push(`Soil pH ${x.ph} suits ${name} (${c.ph[0]} to ${c.ph[1]}).`);
    else { const d = x.ph < c.ph[0] ? c.ph[0] - x.ph : x.ph - c.ph[1]; s -= Math.min(35, d * 25); cons.push(`Soil pH ${x.ph} is outside the ${c.ph[0]} to ${c.ph[1]} ${name} likes. ${x.ph < c.ph[0] ? 'Add lime first.' : 'Add compost first.'}`); }
    const t = avg(x.next3.map(m => m.temp));
    if (t >= c.temp[0] && t <= c.temp[1]) pros.push(`Your area is usually about ${Math.round(t)}°C in the next 3 months, good for ${name}.`);
    else { s -= Math.min(40, Math.abs(t < c.temp[0] ? c.temp[0] - t : t - c.temp[1]) * 6); cons.push(`Next 3 months are usually about ${Math.round(t)}°C here, but ${name} grows best at ${c.temp[0]} to ${c.temp[1]}°C.`); }
    const fr = Math.max(...x.next3.map(m => m.frostPct));
    if (c.frost && fr >= 5) { s -= 25; cons.push(`Frost often happens in this period (${fr}% of days) and damages ${name}.`); }
    const rain = avg(x.next3.map(m => m.rain)), need = { low: 40, med: 70, high: 100 }[c.water];
    if (rain >= need) pros.push(`Usual rain (~${Math.round(rain)} mm/month) covers its water needs.`);
    else if (x.irrigated) pros.push('You have irrigation to cover the dry months.');
    else { s -= 20; cons.push(`Usual rain (~${Math.round(rain)} mm/month) is below the ~${need} mm it needs and no irrigation is recorded.`); }
    if (x.soilType) { if (c.soils.includes(x.soilType)) pros.push(`${x.soilType} soil suits ${name}.`); else { s -= 15; cons.push(`${x.soilType} soil is not the best for ${name}.`); } }
    if (x.nitrogen === 'low' && c.nHungry) { s -= 10; cons.push('Nitrogen is low. Add compost about 2 days before planting.'); }
    if (x.rain7d >= 50) { s -= 5; cons.push(`${x.rain7d} mm of rain is forecast this week. Wait for it to pass before planting or fertilising.`); }
    s = Math.max(0, Math.round(s));
    return { crop: name, score: s, verdict: s >= 75 ? 'plant' : s >= 50 ? 'plant_with_care' : 'wait', pros, cons };
}
app.get('/api/recommendations', authenticateToken, async (req, res) => {
    try {
        const id = req.user.id, { lat, lon, known } = await getCoords(id);
        const [rs, profile, climate, fc] = await Promise.all([getReadings(id, 1), getProfile(id), getClimate(lat, lon), getForecast(lat, lon).catch(() => null)]);
        const r = rs[0], missing = [];
        if (!r) missing.push('soil sensor readings');
        if (!profile || !profile.soil_type) missing.push('soil type from your farm study');
        if (!known) missing.push('farm location');
        if (!r) return res.json({ ready: false, missing, crops: [] });
        const m0 = new Date().getMonth(), next3 = [0, 1, 2].map(i => climate.months[(m0 + i) % 12]);
        const x = {
            ph: Number(r.ph_level), nitrogen: String(r.nitrogen_status || '').toLowerCase(), soilType: profile && profile.soil_type ? String(profile.soil_type).toLowerCase() : null,
            irrigated: !!(profile && profile.irrigated), next3, rain7d: fc ? +fc.daily.precipitation_sum.slice(2).reduce((a, b) => a + (b || 0), 0).toFixed(1) : 0
        };
        res.json({
            ready: true, missing, basis: { ph: x.ph, moisture: r.moisture_level, nitrogen: r.nitrogen_status, soilType: x.soilType },
            crops: Object.entries(CROPS).map(([n, c]) => scoreCrop(n, c, x)).sort((a, b) => b.score - a.score)
        });
    } catch (e) { console.error('Reco:', e.message); res.status(502).json({ error: 'Could not build recommendations' }); }
});
app.get('/api/farm-profile', authenticateToken, async (req, res) => res.json({ profile: await getProfile(req.user.id) }));
app.post('/api/admin/farm-profile', async (req, res) => {
    if (!process.env.ADMIN_KEY || req.get('x-admin-key') !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const { farmer_id, soil_type, irrigated, water_source, size_m2 } = req.body;
    if (!farmer_id) return res.status(400).json({ error: 'farmer_id required' });
    const { error } = await supabase.from('farm_profiles').upsert({ farmer_id: String(farmer_id), soil_type: String(soil_type || '').toLowerCase().trim() || null, irrigated: !!irrigated, water_source, size_m2, updated_at: new Date().toISOString() }, { onConflict: 'farmer_id' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

/* ---------- MY FARM: 3-level findings, glance, next actions, calendar tasks, history ---------- */
const STATUS = { good: 'Good', attention: 'Needs attention', action: 'Action recommended', unassessed: 'Not yet assessed' };
const SOIL_NOTES = {
    'sandy': 'Sandy soil drains fast and holds little water and nutrients, so crops may need water more often.',
    'sandy loam': 'Sandy loam drains well and still holds a fair amount of water.',
    'loam': 'Loam is balanced: it holds water and still drains well.',
    'clay loam': 'Clay loam holds water well and drains more slowly than loam.',
    'clay': 'Clay holds water and nutrients but drains slowly and can get waterlogged.'
};
function rainNext48(d) {
    if (!d) return null;
    const h = d.hourly, now = Math.max(0, h.time.findIndex(t => t >= d.current.time));
    return +h.precipitation.slice(now, now + 48).reduce((a, b) => a + (b || 0), 0).toFixed(1);
}
function buildFindings(r, p, crops, rain) {
    const F = [], f = (area, title, status, result, meaning, todo) => F.push({ area, title, status, statusLabel: STATUS[status], result, meaning, todo: todo || [] });
    const cp = crops.length ? profileFor(crops[0]) : null, rng = cp || GENERAL, forCrop = cp ? crops[0] : 'most vegetables';
    const ph = r ? Number(r.ph_level) : NaN, m = r ? Number(r.moisture_level) : NaN, n = r ? String(r.nitrogen_status || '').toLowerCase() : '';
    if (isNaN(ph)) f('soil', 'Soil acidity (pH)', 'unassessed', 'No pH reading has been recorded yet.', 'pH shows how acidic or alkaline your soil is. It affects how well plants take up nutrients.', ['We will add this when your soil is measured.']);
    else {
        const d = ph < rng.ph[0] ? rng.ph[0] - ph : ph > rng.ph[1] ? ph - rng.ph[1] : 0;
        f('soil', 'Soil acidity (pH)', d === 0 ? 'good' : d <= 1 ? 'attention' : 'action',
            `Your soil pH is ${ph}. ` + (d === 0 ? `That is in the usual range for ${forCrop} (${rng.ph[0]} to ${rng.ph[1]}).` : `That is more ${ph < rng.ph[0] ? 'acidic' : 'alkaline'} than the usual range for ${forCrop} (${rng.ph[0]} to ${rng.ph[1]}).`),
            'pH affects how well plants take up nutrients. The effect depends on the crop and how far the pH is from its range.',
            d === 0 ? ['Keep checking pH each season.'] : ['Check the pH range your crop needs.', 'Ask an agricultural advisor before adding lime or sulphur, using your soil test.', 'Test the soil again after any change.']);
    }
    if (isNaN(m)) f('soil', 'Soil moisture', 'unassessed', 'No moisture reading has been recorded yet.', 'Moisture shows how much water is in the soil right now.');
    else {
        const lo = rng.moisture[0], hi = rng.moisture[1], s = m < lo ? (m < lo - 15 ? 'action' : 'attention') : m > hi ? (m > hi + 15 ? 'action' : 'attention') : 'good';
        f('soil', 'Soil moisture', s, `Your soil moisture is ${m}%. ` + (s === 'good' ? 'That is in a healthy range.' : m < lo ? `The soil is drier than the usual ${lo}% to ${hi}%.` : `The soil is wetter than the usual ${lo}% to ${hi}%.`),
            'Too little water makes plants wilt. Too much water starves roots of air.',
            s === 'good' ? ['Check again in a few days.'] : m < lo ? ['Water deeply, early in the morning.', 'Add mulch to keep moisture in.'] : ['Pause watering.', 'Check that water can drain away.']);
    }
    if (!n) f('soil', 'Nitrogen', 'unassessed', 'No nitrogen reading has been recorded yet.', 'Nitrogen helps leaves and stems grow.');
    else f('soil', 'Nitrogen', n === 'low' ? 'action' : 'good', `Nitrogen is ${r.nitrogen_status}.`, 'Nitrogen helps leaves and stems grow. Low nitrogen can make leaves pale and slow growth.',
        n === 'low' ? ['Add well-rotted compost or an organic nitrogen feed.', 'Do it when no heavy rain is forecast.', 'Check the reading again in about 7 days.'] : ['Keep a record of any fertiliser you add.']);
    const st = p && p.soil_type;
    f('soil', 'Soil type', st ? 'good' : 'unassessed', st ? `Your soil type was recorded as ${st}.` : 'Your soil type has not been recorded yet.',
        st ? (SOIL_NOTES[st] || 'Soil type affects how well your soil holds water and nutrients.') : 'Soil type affects how much water and nutrient your soil holds.', st ? [] : ['We will add this after your farm study.']);
    const heavy = rain != null && rain > 10;
    f('water', 'Water and rain', !p ? 'unassessed' : heavy ? 'attention' : 'good',
        (p ? `Water source: ${p.water_source || 'not recorded'}. Irrigation: ${p.irrigated ? 'yes' : 'none recorded'}.` : 'Your water sources have not been recorded yet.') + (rain != null ? ` Rain expected in the next 48 hours: ${rain} mm.` : ''),
        'Crops need steady water. Heavy rain can wash fertiliser out of the soil.',
        heavy ? ['Postpone fertiliser and compost until the rain has passed.'] : ['Check whether your water supply meets what your crop needs.']);
    return F;
}
function buildTasks(r, crops, rain) {
    const t = [{ id: 'moisture', title: 'Check the soil moisture in your field this week.' }];
    if (r && String(r.nitrogen_status || '').toLowerCase() === 'low') t.push({ id: 'compost', title: 'Add organic compost to low-nitrogen areas, when no heavy rain is expected.' });
    if (rain > 10) t.push({ id: 'rainhold', title: `Postpone fertiliser: ${rain} mm of rain is expected in the next 48 hours.` });
    t.push(crops.length ? { id: 'inspect', title: `Inspect your ${crops[0]} for signs of pests and disease.` } : { id: 'plant', title: 'Tell us what you planted (use Problem AI) so we can check your soil against it.' });
    t.push({ id: 'record', title: 'Write down any fertiliser you apply, and the date.' });
    return t;
}
const weekKey = () => { const y = new Date().getFullYear(); return `${y}w${Math.ceil((Date.now() - new Date(y, 0, 1)) / 6048e5)}`; };
app.get('/api/my-farm', authenticateToken, async (req, res) => {
    try {
        const id = req.user.id, { lat, lon } = await getCoords(id), wk = weekKey();
        const [rs, p, crops, fc, st] = await Promise.all([
            getReadings(id, 10), getProfile(id), getPlantedCrops(id),
            getForecast(lat, lon).catch(() => null),
            supabase.from('farm_task_status').select('task_id,status').eq('farmer_id', String(id)).then(x => x.data || []).catch(() => [])
        ]);
        const r = rs[0] || null, rain = rainNext48(fc), F = buildFindings(r, p, crops, rain);
        const worst = a => ['action', 'attention', 'unassessed', 'good'].find(s => a.some(x => x.status === s)) || 'unassessed';
        const G = (area, status, note) => ({ area, status, statusLabel: STATUS[status], note });
        const soilF = F.filter(x => x.area === 'soil' && x.title !== 'Soil type'), waterF = F.find(x => x.area === 'water');
        res.json({
            name: req.user.fullname, date: new Date().toISOString().slice(0, 10), hasReading: !!r, crops,
            profile: p ? { soil_type: p.soil_type, irrigated: p.irrigated, water_source: p.water_source } : null,
            findings: F,
            glance: [G('Soil condition', worst(soilF), 'Based on pH, moisture and temperature.'), G('Water availability', waterF.status, 'Based on your recorded water source and the rain forecast.'),
                G('Crop condition', 'unassessed', 'No crop observations have been recorded yet.'), G('', '', ''),
                G('Farming records', crops.length ? 'good' : 'attention', crops.length ? 'Crops recorded: ' + crops.join(', ') : 'Tell us what you planted.')],
            nextActions: F.filter(x => x.status === 'action' || x.status === 'attention').sort((a, b) => (a.status === 'action' ? 0 : 1) - (b.status === 'action' ? 0 : 1)).slice(0, 3).map(x => ({ title: x.title, text: x.todo[0] || x.result })),
            tasks: buildTasks(r, crops, rain).map(t => { const id2 = `${t.id}-${wk}`; const s = st.find(x => x.task_id === id2); return { id: id2, title: t.title, status: s ? s.status : 'todo' }; }),
            history: rs.map(x => ({ at: x.recorded_at, ph: x.ph_level, moisture: x.moisture_level, nitrogen: x.nitrogen_status })).reverse()
        });
    } catch (e) { console.error('My farm:', e.message); res.status(500).json({ error: 'Could not load your farm' }); }
});
app.post('/api/tasks', authenticateToken, async (req, res) => {
    const { id, status } = req.body;
    if (!/^[a-z0-9-]{3,40}$/.test(String(id)) || !['todo', 'doing', 'done'].includes(status)) return res.status(400).json({ error: 'Invalid task' });
    const { error } = await supabase.from('farm_task_status').upsert({ farmer_id: String(req.user.id), task_id: id, status, updated_at: new Date().toISOString() }, { onConflict: 'farmer_id,task_id' });
    if (error) return res.status(500).json({ error: 'Could not save' });
    res.json({ success: true });
});

/* ---------- sensors: per farmer, device must authenticate ---------- */
app.get('/api/sensors/latest', authenticateToken, async (req, res) => { const [r] = await getReadings(req.user.id, 1); res.json(r || null); });
app.post('/api/sensors/data', async (req, res) => {
    if (!process.env.DEVICE_KEY || req.get('x-device-key') !== process.env.DEVICE_KEY) return res.status(401).json({ error: 'Unauthorized device' });
    const { farmer_id, moisture_level, ph_level, nitrogen_status } = req.body;
    if (!farmer_id || moisture_level === undefined) return res.status(400).json({ error: 'farmer_id and moisture_level are required.' });
    const { error } = await supabase.from('soil_sensors').insert([{ farmer_id: String(farmer_id), moisture_level, ph_level, nitrogen_status }]);
    if (error) return res.status(500).json({ error: 'Failed to save sensor data.' });
    res.json({ success: true });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Soil Buddies server is running on http://localhost:${PORT}`));
