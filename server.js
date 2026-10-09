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

        const { data: existingUser } = await supabase
            .from('farmers')
            .select('*')
            .eq('email', email);

        if (existingUser && existingUser.length > 0) {
            return res.status(400).send('Email already registered. Please log in.');
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const { error: insertError } = await supabase
            .from('farmers')
            .insert([
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

        const { data: users, error } = await supabase
            .from('farmers')
            .select('*')
            .eq('email', email);

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

// Get latest sensor telemetry for the dashboard UI
app.get('/api/sensors/latest', authenticateToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('soil_sensors')
            .select('*')
            .order('recorded_at', { ascending: false })
            .limit(1);

        if (error) throw error;

        const latestReading = data && data.length > 0 ? data[0] : { moisture_level: 45, ph_level: 6.2, nitrogen_status: 'Low' };
        res.json(latestReading);
    } catch (err) {
        console.error("Error fetching telemetry:", err);
        res.status(500).json({ error: 'Failed to fetch sensor data.' });
    }
});

// ==========================================
// PROTECTED ROUTES & API ENDPOINTS
// ==========================================
app.get('/dashboard', authenticateToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.post('/api/chat', authenticateToken, async (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'Message content is required.' });
    }

    const maxRetries = 2; // Reduced retries so it doesn't hang long during network drops
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            attempt++;
            const response = await ai.models.generateContent({
                model: "gemini-3.8-flash",
                contents: `You are Agri-Talk, a friendly AI farming assistant for Soil Buddies. The user's name is ${req.user.fullname}. Their current soil stats are: pH 6.2, Moisture 45%, Nitrogen: Low. 
                
                Rules:
                - If the user greets you (e.g., "hello", "hi"), keep your response short, friendly, and conversational.
                - Only provide technical soil details if asked.
                
                User message: ${message}`,
            });

            return res.json({ reply: response.text });
        } catch (err) {
            console.error(`Gemini API Attempt ${attempt} failed:`, err.message || err);

            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
                // FALLBACK MODE: If network/API is down (like stage loads or drops), provide a smart offline answer!
                console.log("Switching to Agri-Talk Offline Fallback Mode...");
                
                let fallbackReply = `Hello ${req.user.fullname}! (Offline Mode Active): Based on your latest telemetry (pH 6.2, Moisture 45%, Nitrogen: Low), your soil is well-hydrated and ready for planting, but needs a nitrogen amendment. Once power and network are back, full Gemini capabilities will resume!`;
                
                const lowerMsg = message.toLowerCase();
                if (lowerMsg.includes('hello') || lowerMsg.includes('hi')) {
                    fallbackReply = `Hello ${req.user.fullname}! I am Agri-Talk. Network connection is unstable right now, but your dashboard telemetry is safe. How can I help you with your plot?`;
                }

                return res.json({ reply: fallbackReply });
            }
        }
    }
});

// Hardware Ingestion Endpoint (Called by your moisture sensor device)
app.post('/api/sensors/data', async (req, res) => {
    try {
        const { farmer_id, moisture_level, ph_level, nitrogen_status } = req.body;

        if (moisture_level === undefined) {
            return res.status(400).json({ error: 'Moisture level is required.' });
        }

        // Insert sensor data into Supabase
        const { data, error } = await supabase
            .from('soil_sensors')
            .insert([
                { 
                    farmer_id: farmer_id || null, 
                    moisture_level: moisture_level, 
                    ph_level: ph_level || 6.2, 
                    nitrogen_status: nitrogen_status || 'Low' 
                }
            ]);

        if (error) throw error;

        res.status(200).json({ success: true, message: 'Sensor data recorded successfully!' });
    } catch (err) {
        console.error("Sensor Data Error:", err);
        res.status(500).json({ error: 'Failed to save sensor data.' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Soil Buddies server is running on http://localhost:${PORT}`);
});