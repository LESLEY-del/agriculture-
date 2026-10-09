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

// CRITICAL: Serve static files (CSS, JS, images) from your project folder
app.use(express.static(__dirname));

// Initialize Supabase & Gemini
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const ai = new GoogleGenAI({});

// Optional Web Push
let webpush = null, pushReady = false;
try {
    webpush = require('web-push');
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@soilbuddies.org', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
        pushReady = true;
    }
} catch (e) { console.log('web-push not installed: push notifications disabled.'); }

// --- STATIC HTML ROUTES (GET) ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'register.html'));
});

// --- AUTHENTICATION ROUTES (POST) ---
app.post('/register', async (req, res) => {
    try {
        const { fullname, email, password } = req.body;
        const { data: existingUser } = await supabase.from('farmers').select('*').eq('email', email);
        if (existingUser && existingUser.length > 0) {
            return res.status(400).send('Email already registered. Please log in.');
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const { error: insertError } = await supabase.from('farmers').insert([
            { full_name: fullname, email: email, password_hash: hashedPassword }
        ]);
        if (insertError) throw insertError;
        res.redirect('/login');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error during registration');
    }
});

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const { data: users, error } = await supabase.from('farmers').select('*').eq('email', email);
        if (error || !users || users.length === 0) {
            return res.status(401).send('Invalid email or password');
        }
        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).send('Invalid email or password');
        }
        const token = jwt.sign(
            { id: user.id, email: user.email, fullname: user.full_name },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000
        });
        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error during login');
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('token', { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
    res.redirect('/login');
});

// ==========================================
// SECURITY MIDDLEWARE
// ==========================================
const authenticateToken = (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.redirect('/login');

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.redirect('/login');
        req.user = user; 
        next();
    });
};

const DEFAULT_READING = { moisture_level: 45, ph_level: 6.2, nitrogen_status: 'Low' };

// Get latest sensor telemetry for the dashboard UI
app.get('/api/sensors/latest', authenticateToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('soil_sensors')
            .select('*')
            .order('recorded_at', { ascending: false })
            .limit(1);

        if (error) throw error;

        const latestReading = data && data.length > 0 ? data[0] : DEFAULT_READING;
        res.json(latestReading);
    } catch (err) {
        console.error("Error fetching telemetry:", err);
        res.status(500).json({ error: 'Failed to fetch sensor data.' });
    }
});

// ==========================================
// ---------- LIVE WEATHER API (SUPABASE COORDINATES + OPEN-METEO) ----------
app.get('/api/weather', authenticateToken, async (req, res) => {
    try {
        const farmerId = String(req.user.id);

        // Query the farmer location table from Supabase
        // (Checking both 'farmer_locations' or 'farmer_location' depending on your table name)
        let locRow = null;
        try {
            const { data } = await supabase
                .from('farmer_locations')
                .select('latitude, longitude')
                .eq('farmer_id', farmerId)
                .order('updated_at', { ascending: false })
                .maybeSingle();
            locRow = data;
        } catch (e) {
            // Fallback table name check
            const { data } = await supabase
                .from('farmer_location')
                .select('latitude, longitude')
                .eq('farmer_id', farmerId)
                .order('updated_at', { ascending: false })
                .maybeSingle();
            locRow = data;
        }

        // Default fallbacks if none stored yet
        let lat = -23.887; 
        let lon = 29.7361;

        if (locRow && locRow.latitude && locRow.longitude) {
            lat = Number(locRow.latitude);
            lon = Number(locRow.longitude);
        }

        // Fetch live weather from Open-Meteo using the database coordinates
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&past_days=2&forecast_days=5&hourly=temperature_2m,weather_code,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto`;

        const weatherRes = await fetch(weatherUrl);
        if (!weatherRes.ok) throw new Error(`Open-Meteo returned status ${weatherRes.status}`);

        const data = await weatherRes.json();
        const hourlyPrecip = data.hourly && data.hourly.precipitation ? data.hourly.precipitation : [];
        const past48HoursRain = hourlyPrecip.slice(0, 48).reduce((acc, curr) => acc + curr, 0);
        const future48HoursRain = hourlyPrecip.slice(48, 96).reduce((acc, curr) => acc + curr, 0);

        // Build hourly forecast list
        const nowIndex = data.hourly.time.findIndex(t => new Date(t) >= new Date()) || 0;
        const hourlyList = [];
        for (let i = 0; i < 6; i++) {
            const idx = nowIndex + i;
            if (idx < data.hourly.time.length) {
                const hourStr = new Date(data.hourly.time[idx]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: false });
                hourlyList.push({
                    time: i === 0 ? 'Now' : hourStr,
                    temp: Math.round(data.hourly.temperature_2m[idx]),
                    code: data.hourly.weather_code[idx]
                });
            }
        }

        // Build daily forecast list (5 days)
        const dailyList = [];
        const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        if (data.daily && data.daily.time) {
            for (let i = 0; i < data.daily.time.length; i++) {
                const d = new Date(data.daily.time[i]);
                const dayName = i === 0 ? 'Today' : daysOfWeek[d.getDay()];
                dailyList.push({
                    day: dayName,
                    max: Math.round(data.daily.temperature_2m_max[i]),
                    min: Math.round(data.daily.temperature_2m_min[i]),
                    code: data.daily.weather_code[i],
                    pop: data.daily.precipitation_probability_max ? data.daily.precipitation_probability_max[i] : 0
                });
            }
        }

        const code = data.current.weather_code;
        let condition = "Mostly Cloudy";
        if ([0].includes(code)) condition = "Clear Sky";
        else if ([1, 2, 3].includes(code)) condition = "Mostly Cloudy";
        else if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) condition = "Rain Showers";
        else if ([95, 96, 99].includes(code)) condition = "Thunderstorm";

        res.json({
            temp: Math.round(data.current.temperature_2m),
            high: dailyList.length ? dailyList[0].max : Math.round(data.current.temperature_2m + 3),
            low: dailyList.length ? dailyList[0].min : Math.round(data.current.temperature_2m - 4),
            humidity: data.current.relative_humidity_2m,
            windSpeed: data.current.wind_speed_10m,
            rain48h: parseFloat(past48HoursRain.toFixed(1)),
            rainFuture48h: parseFloat(future48HoursRain.toFixed(1)),
            condition: condition,
            hourly: hourlyList,
            daily: dailyList,
            city: "Synced Farm Location"
        });
    } catch (err) {
        console.error("Live Weather API Error:", err.message);
        res.status(500).json({ error: "Failed to fetch live weather" });
    }
});

// ---------- FARMER LOCATION API ENDPOINTS (FIXES 404) ----------
app.post('/api/location', authenticateToken, async (req, res) => {
    const lat = Number(req.body.latitude), lng = Number(req.body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: 'Invalid coordinates.' });
    }
    try {
        const row = { farmer_id: String(req.user.id), latitude: +lat.toFixed(4), longitude: +lng.toFixed(4), updated_at: new Date().toISOString() };
        await supabase.from('farmer_locations').upsert(row, { onConflict: 'farmer_id' });
        res.json({ success: true, ...row });
    } catch (err) {
        // If farmer_locations table isn't created in Supabase yet, gracefully return success to prevent crashing frontend
        res.json({ success: true, latitude: lat, longitude: lng });
    }
});

app.get('/api/location', authenticateToken, async (req, res) => {
    try {
        const { data } = await supabase.from('farmer_locations').select('*').eq('farmer_id', String(req.user.id)).maybeSingle();
        res.json({ location: data || null });
    } catch (err) {
        res.json({ location: null });
    }
});

// ---------- AGRI-TALK: MULTI-LANGUAGE AI ----------
const OFF_TOPIC_TAG = 'OFF_TOPIC';
const OFF_TOPIC_REPLY = "I'm Agri-Talk, and I can only help with farming and agriculture. Ask me about soil health, pH, nutrients, crops, planting seasons, or irrigation.";

function buildSystemInstruction(user, reading) {
    return `You are Agri-Talk, a friendly AI farming assistant for Soil Buddies. The user's name is ${user.fullname}.
Their latest live soil readings: pH ${reading.ph_level}, Moisture ${reading.moisture_level}%, Nitrogen: ${reading.nitrogen_status}.

YOUR SCOPE IS AGRICULTURE ONLY: crops, gardening, soil, soil pH, nutrients, irrigation, pests, and farm management.

CRITICAL MULTI-LANGUAGE & TRANSLATION RULE:
- If the user asks you to speak, translate, or respond in any language (such as Sepedi, Xitsonga, Tshivenda, IsiZulu, Afrikaans, or any other language), you MUST write your entire response in that requested language while maintaining your agricultural role.

STRICT RULES:
1. Greetings and pleasantries: keep them warm and invite a farming question.
2. If the message is NOT about agriculture, reply with exactly the single word ${OFF_TOPIC_TAG} and nothing else.
3. Keep answers practical, clear, and concise.`;
}

async function getLatestReading() {
    try {
        const { data } = await supabase
            .from('soil_sensors')
            .select('*')
            .order('recorded_at', { ascending: false })
            .limit(1);
        if (data && data.length > 0) return { ...DEFAULT_READING, ...data[0] };
    } catch (e) {
        console.error('Could not load latest reading for chat:', e.message || e);
    }
    return DEFAULT_READING;
}

app.post('/api/chat', authenticateToken, async (req, res) => {
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
        return res.status(400).json({ error: 'Message content is required.' });
    }
    if (message.length > 1000) {
        return res.status(400).json({ error: 'Message is too long. Please keep it under 1000 characters.' });
    }

    const reading = await getLatestReading();
    const maxRetries = 2;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            attempt++;
            const response = await ai.models.generateContent({
                model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
                contents: message,
                config: {
                    systemInstruction: buildSystemInstruction(req.user, reading),
                    temperature: 0.4,
                    maxOutputTokens: 700
                }
            });

            const reply = (response.text || '').trim();

            if (!reply || reply.toUpperCase().startsWith(OFF_TOPIC_TAG)) {
                return res.json({ reply: OFF_TOPIC_REPLY, offTopic: true });
            }

            return res.json({ reply });
        } catch (err) {
            console.error(`Gemini API Attempt ${attempt} failed:`, err.message || err);

            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
                console.log("Switching to Agri-Talk Offline Fallback Mode...");

                let fallbackReply = `Hello ${req.user.fullname}! (Offline Mode): Based on your latest readings (pH ${reading.ph_level}, Moisture ${reading.moisture_level}%, Nitrogen: ${reading.nitrogen_status}), your soil is ready to work with. Full Agri-Talk answers will resume once the connection is back.`;

                if (/\b(hello|hi|hey)\b/i.test(message)) {
                    fallbackReply = `Hello ${req.user.fullname}! I am Agri-Talk. The connection is unstable right now, but your dashboard readings are safe. How can I help with your farm?`;
                }

                return res.json({ reply: fallbackReply });
            }
        }
    }
});

// ==========================================
// PROBLEM AI: soil issues from hardware readings
// ==========================================
const GENERAL = { ph: [6.0, 7.0], moisture: [35, 65], nHungry: true };
const CROP_PROFILES = {
    'pepper':  { ph: [6.0, 6.8], moisture: [40, 65], nHungry: true },
    'tomato':  { ph: [6.0, 6.8], moisture: [40, 70], nHungry: true },
    'carrot':  { ph: [6.0, 6.8], moisture: [35, 60], nHungry: false },
    'maize':   { ph: [5.8, 7.0], moisture: [40, 65], nHungry: true },
    'corn':    { ph: [5.8, 7.0], moisture: [40, 65], nHungry: true },
    'spinach': { ph: [6.5, 7.5], moisture: [40, 65], nHungry: true },
    'potato':  { ph: [5.0, 6.5], moisture: [40, 65], nHungry: true },
    'cabbage': { ph: [6.0, 7.0], moisture: [40, 65], nHungry: true },
    'onion':   { ph: [6.0, 7.0], moisture: [35, 60], nHungry: true },
    'bean':    { ph: [6.0, 7.0], moisture: [35, 60], nHungry: false },
    'lettuce': { ph: [6.0, 7.0], moisture: [40, 70], nHungry: true }
};
function profileFor(name) {
    const lc = String(name).toLowerCase();
    const key = Object.keys(CROP_PROFILES).find(k => lc.includes(k));
    return key ? CROP_PROFILES[key] : null;
}
function parseCrops(v) {
    return String(v || '').split(',')
        .map(c => c.replace(/[^\p{L}\p{N} \-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40))
        .filter(Boolean).slice(0, 3);
}

const LABEL = { 'low-nitrogen': 'Low nitrogen', 'low-ph': 'Soil too acidic', 'high-ph': 'Soil too alkaline', 'low-moisture': 'Soil too dry', 'high-moisture': 'Soil too wet' };
const HARM = {
    'low-nitrogen': 'leaves can turn pale and growth slows',
    'low-ph': 'roots struggle and nutrients get locked in the soil',
    'high-ph': 'iron and other nutrients become hard to absorb, so leaves can yellow',
    'low-moisture': 'plants can wilt and growth stalls',
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
    const ph = Number(reading.ph_level), m = Number(reading.moisture_level);
    const n = String(reading.nitrogen_status || '').toLowerCase();
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
        id: 'soil:' + e.key, issue: e.key, label: LABEL[e.key], severity: e.severity,
        title: 'Soil alert: ' + LABEL[e.key], detail: e.detail,
        harm: e.crops.length ? `May harm ${e.crops.join(', ')}: ${HARM[e.key]}.` : '',
        crops: e.crops, advice: ADVICE[e.key]
    })).sort((a, b) => rank[a.severity] - rank[b.severity]);
}

async function getPlantedCrops(farmerId) {
    try {
        if (farmerId) {
            const { data } = await supabase.from('planted_crops').select('crop_name').eq('farmer_id', String(farmerId));
            if (data && data.length) return data.map(r => r.crop_name).slice(0, 3);
        }
    } catch (e) {}
    return [];
}

async function getReadings(n) {
    try {
        const { data } = await supabase.from('soil_sensors').select('*').order('recorded_at', { ascending: false }).limit(n);
        if (data && data.length) return data.map(d => ({ ...DEFAULT_READING, ...d }));
    } catch (e) {}
    return [DEFAULT_READING];
}

function computeChange(cur, prev) {
    if (!prev) return null;
    const ph = +(Number(cur.ph_level) - Number(prev.ph_level)).toFixed(2);
    const mo = +(Number(cur.moisture_level) - Number(prev.moisture_level)).toFixed(1);
    return {
        ph: isNaN(ph) ? 0 : ph,
        moisture: isNaN(mo) ? 0 : mo,
        nitrogen_from: String(prev.nitrogen_status) !== String(cur.nitrogen_status) ? prev.nitrogen_status : null
    };
}

function describeChange(cur, ch) {
    if (!ch) return 'No earlier reading is available to compare with.';
    const parts = [];
    parts.push(ch.ph ? `pH changed by ${ch.ph > 0 ? '+' : ''}${ch.ph}` : 'pH is unchanged');
    parts.push(ch.moisture ? `moisture changed by ${ch.moisture > 0 ? '+' : ''}${ch.moisture} percentage points` : 'moisture is unchanged');
    parts.push(ch.nitrogen_from ? `nitrogen went from ${ch.nitrogen_from} to ${cur.nitrogen_status}` : 'nitrogen is unchanged');
    return parts.join('; ') + '.';
}

app.get('/api/alerts', authenticateToken, async (req, res) => {
    try {
        const [cur, prev] = await getReadings(2);
        const queryCrops = parseCrops(req.query.crop);
        const crops = queryCrops.length ? queryCrops : await getPlantedCrops(req.user.id);
        res.json({ reading: cur, change: computeChange(cur, prev), crops, alerts: evaluateSoil(cur, crops) });
    } catch (err) {
        console.error('Alerts error:', err);
        res.status(500).json({ error: 'Failed to load alerts.' });
    }
});

app.post('/api/crop', authenticateToken, async (req, res) => {
    const crops = parseCrops(req.body.crop);
    try {
        await supabase.from('planted_crops').delete().eq('farmer_id', String(req.user.id));
        if (crops.length) await supabase.from('planted_crops').insert(crops.map(c => ({ farmer_id: String(req.user.id), crop_name: c })));
    } catch (e) {}
    res.json({ success: true, crops });
});

app.get('/api/push/key', authenticateToken, (req, res) => {
    res.json({ key: pushReady ? process.env.VAPID_PUBLIC_KEY : null });
});

app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
    try {
        const sub = req.body;
        if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription.' });
        const { error } = await supabase.from('push_subscriptions')
            .upsert({ farmer_id: String(req.user.id), endpoint: sub.endpoint, subscription: sub }, { onConflict: 'endpoint' });
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('Subscribe error:', err);
        res.status(500).json({ error: 'Could not save subscription.' });
    }
});

const PROBLEM_OFF_TAG = 'PROBLEM_OFF_TOPIC';
const PROBLEM_OFF_REPLY =
    "Problem AI only reports soil issues from your sensor and how they affect the crop you planted. " +
    "For other farming questions, please use the Agri-Talk chat.";

function buildProblemInstruction(user, reading, change, crops, alerts) {
    const alertText = alerts.length
        ? alerts.map((a, i) => `${i + 1}. [${a.severity.toUpperCase()}] ${a.label}. ${a.detail}${a.harm ? ' ' + a.harm : ''}`).join('\n')
        : 'None. The soil readings are within healthy range.';
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

    const history = (Array.isArray(req.body.history) ? req.body.history.slice(-8) : [])
        .map(h => ({ role: h.role === 'ai' ? 'model' : 'user', parts: [{ text: h.text.slice(0, 1000) }] }));

    const [reading, prev] = await getReadings(2);
    const change = computeChange(reading, prev);
    const bodyCrops = parseCrops(req.body.crop);
    const crops = bodyCrops.length ? bodyCrops : await getPlantedCrops(req.user.id);
    const alerts = evaluateSoil(reading, crops);

    try {
        const response = await ai.models.generateContent({
            model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
            contents: [...history, { role: 'user', parts: [{ text: message }] }],
            config: { systemInstruction: buildProblemInstruction(req.user, reading, change, crops, alerts), temperature: 0.3, maxOutputTokens: 600 }
        });
        const reply = (response.text || '').trim();
        if (!reply || reply.toUpperCase().startsWith(PROBLEM_OFF_TAG)) {
            return res.json({ reply: PROBLEM_OFF_REPLY, offTopic: true });
        }
        return res.json({ reply });
    } catch (err) {
        return res.json({ reply: `Hello ${user.fullname}. Latest soil readings: pH ${reading.ph_level}, moisture ${reading.moisture_level}%, nitrogen ${reading.nitrogen_status}.` });
    }
});

app.post('/api/sensors/data', async (req, res) => {
    try {
        const { farmer_id, moisture_level, ph_level, nitrogen_status } = req.body;
        if (moisture_level === undefined) return res.status(400).json({ error: 'Moisture level is required.' });

        await supabase.from('soil_sensors').insert([{ 
            farmer_id: farmer_id || null, 
            moisture_level, 
            ph_level: ph_level || 6.2, 
            nitrogen_status: nitrogen_status || 'Low' 
        }]);

        res.status(200).json({ success: true, message: 'Sensor data recorded successfully!' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save sensor data.' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Soil Buddies server is running on http://localhost:${PORT}`);
});
