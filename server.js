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

app.get('/dashboard', authenticateToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ---------- AGRI-TALK: MULTI-LANGUAGE AI ----------
const OFF_TOPIC_TAG = 'OFF_TOPIC';
const OFF_TOPIC_REPLY = "I'm Agri-Talk, and I can only help with farming and agriculture. Ask me about soil health, pH, nutrients, crops, planting seasons, or irrigation.";

function buildSystemInstruction(user, reading) {
    return `You are Agri-Talk, a friendly AI farming assistant for Soil Buddies. The user's name is ${user.fullname}.
Their latest live soil readings: pH ${reading.ph_level}, Moisture ${reading.moisture_level}%, Nitrogen: ${reading.nitrogen_status}.

YOUR SCOPE IS AGRICULTURE ONLY: crops, gardening, soil, soil pH, nutrients, irrigation, pests, and farm management.

CRITICAL MULTI-LANGUAGE & TRANSLATION RULE:
- If the user asks you to speak, translate, explain, or respond in any language (such as Sepedi, Xitsonga, Tshivenda, IsiZulu, Afrikaans, or any other language), you MUST immediately switch and write your entire response in that requested language. Maintain your role as a helpful agricultural assistant while doing so.

STRICT RULES:
1. Greetings and pleasantries: keep them warm and invite a farming question.
2. If the message is NOT about agriculture, reply with exactly the single word ${OFF_TOPIC_TAG} and nothing else.
3. Keep answers practical, clear, and concise.`;
}

async function getLatestReading() {
    try {
        const { data } = await supabase.from('soil_sensors').select('*').order('recorded_at', { ascending: false }).limit(1);
        if (data && data.length > 0) return { ...DEFAULT_READING, ...data[0] };
    } catch (e) { console.error(e); }
    return DEFAULT_READING;
}

app.post('/api/chat', authenticateToken, async (req, res) => {
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'Message content is required.' });

    const reading = await getLatestReading();
    try {
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
        console.error(err);
        return res.json({ reply: `Hello ${req.user.fullname}! (Offline Mode): Based on your readings (pH ${reading.ph_level}, Moisture ${reading.moisture_level}%, Nitrogen: ${reading.nitrogen_status}), your soil is stable.` });
    }
});

// ==========================================
// PROBLEM AI: SOIL FACTOR & CROP DEATH ANALYSIS
// ==========================================
const CROP_PROFILES = {
    'bell peppers': { ph: [6.0, 6.8], moisture: [40, 65], nHungry: true },
    'tomatoes':     { ph: [6.0, 6.8], moisture: [40, 70], nHungry: true },
    'carrots':      { ph: [6.0, 6.8], moisture: [35, 60], nHungry: false },
    'maize':        { ph: [5.8, 7.0], moisture: [40, 65], nHungry: true },
    'spinach':      { ph: [6.5, 7.5], moisture: [40, 65], nHungry: true }
};
const DEFAULT_PROFILE = { ph: [6.0, 7.0], moisture: [35, 65], nHungry: false };
const DEFAULT_PLANTED = ['Bell Peppers', 'Tomatoes'];

function evaluateCrop(crop, r) {
    const p = CROP_PROFILES[crop.toLowerCase()] || DEFAULT_PROFILE;
    const ph = Number(r.ph_level), m = Number(r.moisture_level);
    const n = String(r.nitrogen_status || '').toLowerCase();
    const out = [];
    const add = (key, severity, label, detail, advice) => out.push({
        id: crop.toLowerCase().replace(/\s+/g, '-') + ':' + key,
        crop, issue: key, label, severity, title: `${crop} risk alert`, detail, advice
    });
    if (n === 'low' && p.nHungry) add('low-nitrogen', 'critical', 'Low Nitrogen Risk', `Nitrogen is Low. ${crop} needs nitrogen; without it, leaves turn yellow and growth stalls.`, 'Apply nitrogen-rich organic compost immediately.');
    if (!isNaN(ph) && ph < p.ph[0]) add('low-ph', 'warning', 'Acidic Soil Risk', `Soil pH is ${ph}, making the soil too acidic for ${crop}, which can burn roots.`, 'Work agricultural lime into the soil.');
    if (!isNaN(m) && m < p.moisture[0]) add('low-moisture', 'critical', 'Moisture Drop Risk', `Soil moisture has dropped to ${m}%, causing severe drought stress that will dry out and kill ${crop}.`, 'Water deeply right away and add mulch.');
    return out;
}

async function getPlantedCrops(farmerId) {
    try {
        if (farmerId) {
            const { data } = await supabase.from('planted_crops').select('crop_name').eq('farmer_id', String(farmerId));
            if (data && data.length) return data.map(r => r.crop_name);
        }
    } catch (e) {}
    return DEFAULT_PLANTED;
}

async function computeAlerts(farmerId, reading) {
    const crops = await getPlantedCrops(farmerId);
    return crops.flatMap(c => evaluateCrop(c, reading));
}

app.get('/api/alerts', authenticateToken, async (req, res) => {
    try {
        const reading = await getLatestReading();
        const alerts = await computeAlerts(req.user.id, reading);
        res.json({ reading, alerts });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load alerts.' });
    }
});

app.get('/api/push/key', authenticateToken, (req, res) => {
    res.json({ key: pushReady ? process.env.VAPID_PUBLIC_KEY : null });
});

app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
    try {
        const sub = req.body;
        if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription.' });
        await supabase.from('push_subscriptions').upsert({ farmer_id: String(req.user.id), endpoint: sub.endpoint, subscription: sub }, { onConflict: 'endpoint' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not save subscription.' });
    }
});

const PROBLEM_OFF_TAG = 'PROBLEM_OFF_TOPIC';
const PROBLEM_OFF_REPLY = "Problem AI only analyzes soil moisture drops, pH levels, and nutrient factors affecting your crops. Use Agri-Talk for other questions.";

function buildProblemInstruction(user, reading, alerts) {
    const alertText = alerts.length
        ? alerts.map((a, i) => `${i + 1}. [${a.severity.toUpperCase()}] Crop: ${a.crop} | Issue: ${a.label} | Detail: ${a.detail} | Fix: ${a.advice}`).join('\n')
        : 'All sensor telemetry is currently within healthy ranges.';

    return `You are Problem AI, the soil health and crop survival assistant inside Soil Buddies. The user's name is ${user.fullname}.

EXACT LIVE SENSOR READINGS:
- pH Level: ${reading.ph_level}
- Soil Moisture: ${reading.moisture_level}%
- Nitrogen Status: ${reading.nitrogen_status}

ACTIVE SOIL FINDINGS & RISKS:
${alertText}

YOUR MANDATE:
1. You MUST explicitly talk about what the sensors detected in the soil (mentioning the exact moisture drop percentage, pH, or nitrogen level).
2. Explain clearly whether these soil factors will cause the crops to die or suffer damage.
3. If the user hasn't specified what crops they planted, ask them what crops they are growing so you can warn them based on the active soil telemetry.

STRICT RULES:
1. Keep the tone urgent, practical, and clear.
2. Write in clean plain text with no asterisks, hashtags, or markdown formatting. Use numbered lists like 1. then 2.`;
}

app.post('/api/problem-chat', authenticateToken, async (req, res) => {
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'Message content is required.' });

    const history = (Array.isArray(req.body.history) ? req.body.history.slice(-8) : [])
        .map(h => ({ role: h.role === 'ai' ? 'model' : 'user', parts: [{ text: h.text.slice(0, 1000) }] }));

    const reading = await getLatestReading();
    const alerts = await computeAlerts(req.user.id, reading);

    try {
        const response = await ai.models.generateContent({
            model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
            contents: [...history, { role: 'user', parts: [{ text: message }] }],
            config: { 
                systemInstruction: buildProblemInstruction(req.user, reading, alerts), 
                temperature: 0.3, 
                maxOutputTokens: 600 
            }
        });
        const reply = (response.text || '').trim();
        if (!reply || reply.toUpperCase().startsWith(PROBLEM_OFF_TAG)) {
            return res.json({ reply: PROBLEM_OFF_REPLY, offTopic: true });
        }
        return res.json({ reply });
    } catch (err) {
        console.error('Problem AI error:', err);
        return res.json({ reply: `Hello ${req.user.fullname}. Your sensors record pH ${reading.ph_level}, moisture ${reading.moisture_level}%, and nitrogen ${reading.nitrogen_status}.` });
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
