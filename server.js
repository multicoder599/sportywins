// server.js

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json());

app.use((req, res, next) => {
    Object.defineProperty(req, 'query', {
        value: { ...req.query },
        writable: true, configurable: true, enumerable: true
    });
    next();
});

app.use(mongoSanitize());

const allowedOrigins = [
    'https://sportywins.onrender.com',
    'https://winsadmin.surge.sh',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
];

// 🔒 UNIVERSAL CORS POLICY
app.use(cors({
    origin: function (origin, callback) {
        callback(null, true);
    },
    credentials: true
}));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 200,
    message: { error: "Too many requests from this IP, please try again later." }
});
app.use('/api/', apiLimiter);

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sportywins';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

const sendTelegramMessage = async (message) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId, text: message, parse_mode: 'HTML'
        });
    } catch (err) { console.error("❌ Telegram notification failed:", err.message); }
};

const getCryptoAddresses = () => ({
    Bitcoin: process.env.BTC_ADDRESS || 'bc1q_configure_in_env',
    USDT: process.env.USDT_ADDRESS || '0x_configure_in_env',
    USDC: process.env.USDC_ADDRESS || '0x_configure_in_env',
    Solana: process.env.SOLANA_ADDRESS || 'sol_configure_in_env',
    Litecoin: process.env.LTC_ADDRESS || 'ltc_configure_in_env'
});

// ==========================================
// UPDATED SCHEMAS
// ==========================================

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String, default: 'Player' },
    balance: { type: Number, default: 0.00 },
    currency: { type: String, default: 'KES' },
    oddsFormat: { type: String, default: 'decimal' },
    countryCode: { type: String, default: 'KE' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// NEW: Expanded Match schema with lifecycle, markets, and result storage
const MatchSchema = new mongoose.Schema({
    sport: String,
    league: String,
    country: String,
    home: String,
    away: String,
    isLive: { type: Boolean, default: false },
    status: { type: String, enum: ['upcoming', 'live', 'completed'], default: 'upcoming' },
    startTime: { type: Date }, // NEW: Required for injected games
    time: String,
    date: String,
    score: String,
    finalScore: String, // NEW: Final result after completion
    odds: [Number],
    markets: {
        h2h: { home: Number, draw: Number, away: Number },
        correctScore: [{ score: String, odds: Number }],
        overUnder: [{ line: Number, over: Number, under: Number }],
        btts: { yes: Number, no: Number },
        doubleChance: { '1x': Number, x2: Number, '12': Number }
    },
    result: { // NEW: Injected result for settlement
        homeGoals: Number,
        awayGoals: Number,
        correctScore: String,
        btts: String,
        winner: String // '1', 'X', or '2'
    }
});
const Match = mongoose.model('Match', MatchSchema);

// NEW: Expanded Bet schema with per-leg startTime, marketType, and status
const BetSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ticketId: { type: String, required: true },
    date: { type: Date, default: Date.now },
    stake: { type: Number, required: true },
    totalOdds: { type: Number, required: true },
    potentialReturn: { type: Number, required: true },
    status: { type: String, default: 'Open', enum: ['Open', 'Partial', 'Won', 'Lost', 'Cancelled'] },
    currency: String,
    legs: [{
        matchId: String,
        match: String,
        pick: String,
        selection: String,
        marketType: { type: String, default: '1x2' }, // NEW: '1x2', 'correctScore', 'overUnder', 'btts', 'doubleChance'
        odds: Number,
        startTime: Date, // NEW: For per-leg settlement timing
        status: { type: String, default: 'Open' },
        score: String,
        finalScore: String
    }]
});
const Bet = mongoose.model('Bet', BetSchema);

const TransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userPhone: String,
    refId: String,
    type: { type: String, required: true },
    method: String,
    amount: { type: Number, required: true },
    currency: { type: String, default: 'KES' },
    status: { type: String, default: 'Pending' },
    proofUrl: String,
    date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

const NotificationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    title: String,
    message: String,
    isRead: { type: Boolean, default: false },
    date: { type: Date, default: Date.now }
});
const Notification = mongoose.model('Notification', NotificationSchema);

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_insecure_secret_do_not_use_in_prod';

const verifyAdminToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: "Access Denied. No token provided." });
    try {
        const tokenParts = token.split(" ");
        const actualToken = tokenParts.length === 2 ? tokenParts[1] : tokenParts[0];
        const verified = jwt.verify(actualToken, JWT_SECRET);
        if (verified.role !== 'admin') return res.status(403).json({ error: "Forbidden. Admin role required." });
        req.admin = verified;
        next();
    } catch (err) { return res.status(401).json({ error: "Invalid or expired token." }); }
};

const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Too many login attempts." }});
app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
    const { password } = req.body;
    const adminPass = process.env.ADMIN_PASS || 'admin@26wins';
    if (password === adminPass) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.status(200).json({ message: "Auth successful", token: token });
    } else { res.status(401).json({ error: "Invalid credentials" }); }
});

// ==========================================
// DEPOSIT & M-PESA (unchanged logic)
// ==========================================

app.post('/api/deposit', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        if (amount < 10) return res.status(400).json({ success: false, message: 'Minimum deposit is 10.' });
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        let formattedPhone = userPhone.replace(/\D/g, '');
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
        if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;

        const reference = "DEP" + Date.now();
        const payload = {
            api_key: process.env.MEGAPAY_API_KEY || "MGPYnwLXMM2V",
            email: process.env.MEGAPAY_EMAIL || "kanyingiwaitara@gmail.com",
            amount: amount,
            msisdn: formattedPhone,
            callback_url: `${process.env.APP_URL || 'https://sportywins.onrender.com'}/api/megapay/webhook`,
            description: "Sportwins Deposit",
            reference: reference
        };

        try { await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload); }
        catch (mpErr) { return res.status(500).json({ success: false, message: "Payment Gateway failed to initiate STK." }); }

        await Transaction.create({
            refId: reference,
            userId: user._id,
            userPhone: user.phone,
            type: 'Deposit',
            method: method || 'M-Pesa',
            amount: Number(amount),
            status: 'Pending'
        });

        res.status(200).json({ success: true, message: "STK Push Sent! Check your phone.", newBalance: user.balance, refId: reference });
    } catch (error) { res.status(500).json({ success: false, message: "Payment Gateway Error." }); }
});

app.post('/api/megapay/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    try {
        if ((data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode) != 0) return;
        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        let rawPhone = (data.Msisdn || data.phone || data.PhoneNumber || "").toString();

        const digitsOnly = rawPhone.replace(/\D/g, '');
        const last9 = digitsOnly.slice(-9);
        if (last9.length < 9) return;

        const user = await User.findOne({ phone: { $regex: new RegExp(last9 + '$') } });
        if (!user) return;
        const existingTx = await Transaction.findOne({ refId: receipt });
        if (existingTx) return;

        user.balance += amount; await user.save();

        await Transaction.create({
            refId: receipt,
            userId: user._id,
            userPhone: user.phone,
            type: "Deposit",
            method: "M-Pesa",
            amount: amount,
            status: "Success"
        });

        await new Notification({ userId: user._id, title: "Deposit Successful", message: `Your deposit of KES ${amount} has been credited. Receipt: ${receipt}` }).save();
        sendTelegramMessage(`💵 <b>SUCCESSFUL DEPOSIT</b>\n📱 User: ${user.phone}\n💰 Amount: KES ${amount}\n🧾 Ref: ${receipt}`);
    } catch (err) { console.error("Webhook processing error:", err); }
});

// ==========================================
// AUTH (unchanged)
// ==========================================

const authLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 15, message: { error: "Too many accounts created from this IP." }});

app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const { username, email, phone, password } = req.body;

        if (await User.findOne({ username: { $regex: new RegExp('^' + username + '$', 'i') } })) return res.status(400).json({ error: "Username is taken." });
        if (await User.findOne({ email: { $regex: new RegExp('^' + email + '$', 'i') } })) return res.status(400).json({ error: "Email is registered." });
        if (await User.findOne({ phone })) return res.status(400).json({ error: "Phone number is registered." });

        const hashedPassword = await bcrypt.hash(password, 10);
        const cleanPhone = phone.replace(/\D/g, '');
        const isKenyan = phone.startsWith('+254') || cleanPhone.startsWith('254') || (cleanPhone.length === 10 && (cleanPhone.startsWith('07') || cleanPhone.startsWith('01')));
        const currency = isKenyan ? 'KES' : 'USD';
        const countryCode = isKenyan ? 'KE' : 'US';

        const newUser = new User({ username, email, phone, password: hashedPassword, name: username, currency, countryCode });
        await newUser.save();

        await new Notification({ userId: newUser._id, title: "Welcome to SportyWins!", message: "Your account is ready." }).save();
        sendTelegramMessage(`🎉 <b>NEW USER</b>\n👤 ${username}\n📞 ${phone}`);

        res.status(201).json({ message: "User created", user: { _id: newUser._id, username: newUser.username, name: newUser.name, email: newUser.email, phone: newUser.phone, balance: newUser.balance, currency: newUser.currency, countryCode: newUser.countryCode, oddsFormat: newUser.oddsFormat, cryptoAddresses: getCryptoAddresses() } });
    } catch (err) { res.status(500).json({ error: "Server error during registration." }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;
        const digitsOnly = identifier.replace(/\D/g, '');
        let phoneQuery = identifier;
        if (digitsOnly.length >= 9) phoneQuery = { $regex: new RegExp(digitsOnly.slice(-9) + '$') };

        const user = await User.findOne({ $or: [{ email: { $regex: new RegExp('^' + identifier + '$', 'i') } }, { username: { $regex: new RegExp('^' + identifier + '$', 'i') } }, { phone: phoneQuery }, { phone: identifier }] });
        if (!user) return res.status(404).json({ error: "User not registered." });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ error: "Wrong password." });

        res.status(200).json({ message: "Login successful", user: { _id: user._id, username: user.username, name: user.name, email: user.email, phone: user.phone, balance: user.balance, currency: user.currency, countryCode: user.countryCode, oddsFormat: user.oddsFormat, cryptoAddresses: getCryptoAddresses() } });
    } catch (err) { res.status(500).json({ error: "Server error during login." }); }
});

app.get('/api/user/:id/profile', async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('-password');
        if (!user) return res.status(404).json({ error: "User not found" });
        const userPayload = user.toObject(); userPayload.cryptoAddresses = getCryptoAddresses();
        res.status(200).json(userPayload);
    } catch (err) { res.status(500).json({ error: "Fetch failed." }); }
});

app.get('/api/user/:id/notifications', async (req, res) => {
    try {
        const notifs = await Notification.find({ $or: [{ userId: req.params.id }, { userId: null }] }).sort({ date: -1 }).limit(20);
        res.status(200).json(notifs);
    } catch (err) { res.status(500).json({ error: "Fetch failed." }); }
});

// ==========================================
// WALLET (unchanged)
// ==========================================

app.post('/api/wallet/deposit/manual', async (req, res) => {
    try {
        const { userId, amount, currency, method, proofSubmitted } = req.body;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found." });

        const proofStatus = proofSubmitted ? 'Proof Submitted' : 'Pending';
        const txn = new Transaction({ userId, type: 'Deposit', method, amount, currency, status: 'Pending', proofUrl: proofStatus });
        await txn.save();

        sendTelegramMessage(`⏳ <b>MANUAL DEPOSIT</b>\n👤 User: ${user.username}\n💳 Method: ${method}\n💰 Amount: ${amount} ${currency}`);
        res.status(200).json({ message: "Deposit requested successfully.", balance: user.balance });
    } catch (err) { res.status(500).json({ error: "Deposit failed." }); }
});

app.post('/api/wallet/withdraw', async (req, res) => {
    try {
        const { userId, amount, currency, accountDetails } = req.body;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found." });
        if (user.balance < amount) return res.status(400).json({ error: "Insufficient funds." });

        user.balance -= parseFloat(amount); await user.save();
        const txn = new Transaction({ userId, type: 'Withdrawal', amount, currency, status: 'Pending' });
        await txn.save();

        sendTelegramMessage(`💸 <b>WITHDRAWAL</b>\n👤 User: ${user.username}\n💳 Dest: ${accountDetails}\n💰 Amount: ${amount} ${currency}`);
        res.status(200).json({ message: "Withdrawal requested successfully", balance: user.balance });
    } catch (err) { res.status(500).json({ error: "Withdrawal failed." }); }
});

app.get('/api/wallet/transactions/:userId', async (req, res) => {
    try {
        const txns = await Transaction.find({ userId: req.params.userId }).sort({ date: -1 });
        res.status(200).json(txns);
    } catch (err) { res.status(500).json({ error: "Fetch failed." }); }
});

// ==========================================
// MATCHES & ODDS API
// ==========================================

const ODDS_API_KEY = process.env.ODDS_API_KEY || '2681c5eb4ab7810ab4809f5a80790ace';

// NEW: Helper to simulate live score based on injected final result
function getSimulatedScore(match) {
    if (!match.result || match.status !== 'live' || !match.startTime) {
        return match.score || '0-0';
    }
    const now = new Date();
    const elapsed = now - new Date(match.startTime);
    const duration = 2 * 60 * 60 * 1000; // 2 hours
    const progress = Math.min(Math.max(elapsed / duration, 0), 1);

    const finalH = match.result.homeGoals || 0;
    const finalA = match.result.awayGoals || 0;

    // Simple simulation: reveal goals progressively
    const simH = Math.floor(finalH * progress);
    const simA = Math.floor(finalA * progress);

    return `${simH}-${simA}`;
}

// UPDATED: Main page only shows UPCOMING matches (injected games disappear after start)
app.get('/api/matches', async (req, res) => {
    try {
        const now = new Date();
        // Only upcoming injected matches
        const dbMatches = await Match.find({
            $or: [
                { status: 'upcoming' },
                { status: { $exists: false }, startTime: { $gt: now } }
            ]
        }).sort({ startTime: 1 });

        const formatted = dbMatches.map(m => {
            const obj = m.toObject();
            obj.startTime = m.startTime;
            obj.markets = m.markets || {};
            return obj;
        });

        res.status(200).json(formatted);
    } catch (err) { res.status(500).json({ error: "Fetch failed." }); }
});

// UPDATED: Live matches endpoint with lifecycle filtering and result passing
app.get('/api/live-matches', async (req, res) => {
    try {
        const userCountry = req.query.countryCode || 'GB';
        let timezone = 'UTC';
        if (['KE', 'UG', 'TZ'].includes(userCountry)) timezone = 'Africa/Nairobi';
        else if (userCountry === 'US') timezone = 'America/New_York';
        else if (userCountry === 'GB') timezone = 'Europe/London';
        else if (userCountry === 'ZA') timezone = 'Africa/Johannesburg';

        const now = new Date();
        const nextWeek = new Date();
        nextWeek.setDate(now.getDate() + 7);

        const fromDate = now.toISOString().split('.')[0] + 'Z';
        const toDate = nextWeek.toISOString().split('.')[0] + 'Z';

        const sportsToFetch = [
            'soccer_epl', 'soccer_uefa_champs_league', 'soccer_uefa_europa_league', 'soccer_italy_serie_a',
            'soccer_spain_la_liga', 'soccer_germany_bundesliga', 'soccer_france_ligue_one', 'soccer_england_championship',
            'basketball_nba', 'basketball_euroleague',
            'tennis_atp', 'tennis_wta', 'icehockey_nhl',
            'mma_mixed_martial_arts', 'americanfootball_nfl'
        ];

        let allApiMatches = [];

        await Promise.all(sportsToFetch.map(async (sportKey) => {
            try {
                const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h&commenceTimeFrom=${fromDate}&commenceTimeTo=${toDate}`);
                if (response.data) {
                    allApiMatches = allApiMatches.concat(response.data);
                }
            } catch (e) {
                console.error(`Odds API Error for ${sportKey}:`, e.response ? e.response.data : e.message);
            }
        }));

        let formattedMatches = allApiMatches.map((match) => {
            const market = match.bookmakers[0]?.markets[0];
            let oddsArray = [2.10, 3.10, 2.80];

            if (market && market.outcomes) {
                oddsArray = [
                    market.outcomes.find(o => o.name === match.home_team)?.price || 2.10,
                    market.outcomes.find(o => o.name === 'Draw')?.price || null,
                    market.outcomes.find(o => o.name === match.away_team)?.price || 2.80
                ];
            }

            const matchDate = new Date(match.commence_time);
            const isLiveNow = matchDate <= now;
            const mockScore = isLiveNow ? `${Math.floor(Math.random() * 3)}-${Math.floor(Math.random() * 3)}` : null;

            const getTzDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

            const matchDay = getTzDate(matchDate);
            const todayDay = getTzDate(new Date());

            const tmrw = new Date();
            tmrw.setDate(tmrw.getDate() + 1);
            const tomorrowDay = getTzDate(tmrw);

            let formattedTime = matchDate.toLocaleTimeString('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
            let formattedDate = matchDate.toLocaleDateString('en-US', { timeZone: timezone, month: 'short', day: 'numeric' });

            if (matchDay === todayDay) formattedDate = 'Today';
            else if (matchDay === tomorrowDay) formattedDate = 'Tomorrow';

            let mappedSport = 'football';
            if (match.sport_key.includes('basketball')) mappedSport = 'basketball';
            if (match.sport_key.includes('tennis')) mappedSport = 'tennis';
            if (match.sport_key.includes('mma')) mappedSport = 'mma';
            if (match.sport_key.includes('icehockey')) mappedSport = 'icehockey';
            if (match.sport_key.includes('americanfootball')) mappedSport = 'rugby';

            let gradeScore = isLiveNow ? 200 : 0;
            if (mappedSport === 'football') gradeScore += 50;
            if (match.sport_key.includes('champs_league') || match.sport_key.includes('epl')) gradeScore += 75;

            return {
                id: match.id,
                sport: mappedSport,
                region: 'Global',
                league: match.sport_title,
                country: mappedSport === 'basketball' || mappedSport === 'rugby' ? 'us' : 'gb-eng',
                home: match.home_team,
                away: match.away_team,
                isLive: isLiveNow,
                isFeatured: gradeScore > 50,
                time: formattedTime,
                date: formattedDate,
                startTime: match.commence_time, // NEW
                score: mockScore,
                odds: oddsArray,
                marketCount: Math.floor(Math.random() * 150) + 30,
                gradeScore: gradeScore,
                status: isLiveNow ? 'live' : 'upcoming', // NEW
                result: null,
                finalScore: null
            };
        });

        // UPDATED: Only include LIVE injected matches (upcoming ones moved to /api/matches, completed ones hidden)
        let dbMatches = [];
        try {
            dbMatches = (await Match.find({ status: 'live' })).map(m => ({
                id: m._id.toString(),
                sport: m.sport || 'football',
                region: 'Custom',
                league: m.league || 'League',
                country: m.country || 'gb-eng',
                home: m.home,
                away: m.away,
                isLive: true,
                isFeatured: true,
                time: m.time || '15:00',
                date: m.date || new Date().toLocaleDateString(),
                startTime: m.startTime, // NEW
                score: getSimulatedScore(m), // NEW: Simulated based on injected result
                finalScore: m.finalScore || null, // NEW
                odds: m.odds || [2.1, 3.1, 2.8],
                marketCount: m.markets ? (Object.keys(m.markets).length * 5 + 20) : 50,
                gradeScore: 1000,
                detailedMarkets: m.markets || {},
                status: m.status, // NEW
                result: m.result || null // NEW
            }));
        } catch (e) {}

        const combined = [...dbMatches, ...formattedMatches].sort((a, b) => b.gradeScore - a.gradeScore);
        res.status(200).json(combined.slice(0, 300));
    } catch (err) {
        console.error("Live Matches Error:", err);
        res.status(500).json({ error: "Could not fetch live matches." });
    }
});

// SEARCH (unchanged)
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(200).json([]);
        const dbResults = await Match.find({
            $or: [{ home: { $regex: query, $options: 'i' } }, { away: { $regex: query, $options: 'i' } }, { league: { $regex: query, $options: 'i' } }]
        });
        res.status(200).json(dbResults);
    } catch (err) { res.status(500).json({ error: "Search failed." }); }
});

// ==========================================
// BETTING (UPDATED for per-leg settlement & new markets)
// ==========================================

app.post('/api/bets/place', async (req, res) => {
    try {
        const { userId, stake, totalOdds, potentialReturn, currency, legs } = req.body;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found." });
        if (user.balance < stake) return res.status(400).json({ error: "Insufficient balance." });

        user.balance -= stake; await user.save();

        // NEW: Enrich each leg with startTime from match DB if available
        const trackedLegs = await Promise.all(legs.map(async leg => {
            let legStartTime = leg.startTime ? new Date(leg.startTime) : null;

            if (leg.matchId && mongoose.Types.ObjectId.isValid(leg.matchId)) {
                const dbMatch = await Match.findById(leg.matchId).select('startTime');
                if (dbMatch && dbMatch.startTime) legStartTime = dbMatch.startTime;
            }

            // Fallback: parse from leg.time if provided as "YYYY-MM-DD • HH:MM"
            if (!legStartTime && leg.time && leg.time.includes('•')) {
                const [dPart, tPart] = leg.time.split(' • ');
                const parsed = new Date(`${dPart} ${tPart}`);
                if (!isNaN(parsed)) legStartTime = parsed;
            }

            // Final fallback to now + 2hrs to prevent null
            if (!legStartTime) legStartTime = new Date(Date.now() + 2 * 60 * 60 * 1000);

            return {
                ...leg,
                status: 'Open',
                score: null,
                finalScore: null,
                startTime: legStartTime,
                marketType: leg.marketType || '1x2'
            };
        }));

        const newBet = new Bet({
            userId: user._id,
            ticketId: "SW-" + Math.random().toString(36).substring(2, 8).toUpperCase(),
            stake,
            totalOdds,
            potentialReturn,
            currency,
            legs: trackedLegs
        });
        await newBet.save();

        await Transaction.create({ userId, type: 'Bet Placed', amount: -stake, currency, status: 'Completed' });
        sendTelegramMessage(`🎲 <b>NEW BET PLACED</b>\n👤 User: ${user.username}\n💰 Stake: ${stake} ${currency}\n🎯 Win: ${potentialReturn} ${currency}`);

        res.status(201).json({ message: "Bet placed successfully!", ticketId: newBet.ticketId, newBalance: user.balance, bet: newBet });
    } catch (err) {
        console.error("Bet placement error:", err);
        res.status(500).json({ error: "Failed to place bet." });
    }
});

app.get('/api/bets/user/:userId', async (req, res) => {
    try {
        const bets = await Bet.find({ userId: req.params.userId }).sort({ date: -1 });
        res.status(200).json(bets);
    } catch (err) { res.status(500).json({ error: "Failed to fetch bets." }); }
});

// ==========================================
// ADMIN ROUTES (UPDATED)
// ==========================================

app.get('/api/admin/users', verifyAdminToken, async (req, res) => {
    try { const users = await User.find().select('-password'); res.status(200).json(users); }
    catch (err) { res.status(500).json({ error: "Failed to fetch users." }); }
});

app.put('/api/admin/users/:id/balance/set', verifyAdminToken, async (req, res) => {
    try {
        const { amount } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: "User not found." });
        user.balance = parseFloat(amount); await user.save();
        res.status(200).json({ message: "Balance updated successfully!", balance: user.balance });
    } catch (err) { res.status(500).json({ error: "Failed to update balance." }); }
});

app.delete('/api/admin/users/:id', verifyAdminToken, async (req, res) => {
    try { await User.findByIdAndDelete(req.params.id); res.status(200).json({ message: "User deleted." }); }
    catch (err) { res.status(500).json({ error: "Failed to delete user." }); }
});

app.get('/api/admin/transactions', verifyAdminToken, async (req, res) => {
    try {
        const statusFilter = req.query.status || 'Pending';
        const txns = await Transaction.find({ status: statusFilter }).populate('userId', 'username').sort({ date: -1 });
        res.status(200).json(txns);
    } catch (err) { res.status(500).json({ error: "Failed to fetch transactions." }); }
});

app.put('/api/admin/transactions/:id/:action', verifyAdminToken, async (req, res) => {
    try {
        const action = req.params.action.toLowerCase();
        const txn = await Transaction.findById(req.params.id);
        if (!txn) return res.status(404).json({ error: "Transaction not found." });
        if (txn.status !== 'Pending') return res.status(400).json({ error: "Transaction already processed." });

        if (action === 'approve') {
            txn.status = 'Completed';
            if (txn.type === 'Deposit') {
                const user = await User.findById(txn.userId); user.balance += txn.amount; await user.save();
                await new Notification({ userId: user._id, title: "Deposit Approved", message: `Your deposit of ${txn.amount} ${txn.currency} was approved.` }).save();
            }
        } else if (action === 'reject') {
            txn.status = 'Failed';
            if (txn.type === 'Withdrawal') {
                const user = await User.findById(txn.userId); user.balance += txn.amount; await user.save();
                await new Notification({ userId: user._id, title: "Withdrawal Rejected", message: `Your withdrawal of ${txn.amount} ${txn.currency} was rejected. Funds returned.` }).save();
            }
        }
        await txn.save(); res.status(200).json({ message: `Transaction ${action}d.` });
    } catch (err) { res.status(500).json({ error: "Failed to process transaction." }); }
});

// UPDATED: Admin inject match with full markets and startTime
app.post('/api/admin/matches', verifyAdminToken, async (req, res) => {
    try {
        const matchData = req.body;

        if (!matchData.startTime) {
            return res.status(400).json({ error: "startTime is required for match lifecycle." });
        }

        const newMatch = new Match({
            ...matchData,
            status: 'upcoming',
            isLive: false,
            startTime: new Date(matchData.startTime),
            markets: matchData.markets || {},
            result: matchData.result || null
        });

        await newMatch.save();
        res.status(201).json({ message: "Match injected successfully!", match: newMatch });
    } catch (err) {
        console.error("Admin inject error:", err);
        res.status(500).json({ error: "Failed to add match." });
    }
});

app.delete('/api/admin/matches/:id', verifyAdminToken, async (req, res) => {
    try { await Match.findByIdAndDelete(req.params.id); res.status(200).json({ message: "Match deleted." }); }
    catch (err) { res.status(500).json({ error: "Failed to delete match." }); }
});

app.get('/api/admin/bets', verifyAdminToken, async (req, res) => {
    try { const bets = await Bet.find().populate('userId', 'username phone').sort({ date: -1 }); res.status(200).json(bets); }
    catch (err) { res.status(500).json({ error: "Failed to fetch all bets." }); }
});

app.put('/api/admin/bets/:id/cancel', verifyAdminToken, async (req, res) => {
    try {
        const bet = await Bet.findById(req.params.id);
        if (!bet) return res.status(404).json({ error: "Bet not found." });
        if (bet.status !== 'Open' && bet.status !== 'Partial') return res.status(400).json({ error: "Only open/partial bets can be cancelled." });

        bet.status = 'Cancelled'; await bet.save();
        const user = await User.findById(bet.userId);
        if (user) {
            user.balance += bet.stake; await user.save();
            await Transaction.create({ userId: user._id, type: 'Refund', amount: bet.stake, currency: bet.currency, status: 'Completed' });
            await new Notification({ userId: user._id, title: "Bet Cancelled", message: `Your bet ${bet.ticketId} was cancelled by administration and your stake of ${bet.stake} ${bet.currency} has been refunded.` }).save();
        }
        res.status(200).json({ message: "Bet cancelled and stake refunded.", bet });
    } catch (err) { res.status(500).json({ error: "Failed to cancel bet." }); }
});

// UPDATED: Admin result injection now handles full result object and status
app.put('/api/admin/matches/:id/result', verifyAdminToken, async (req, res) => {
    try {
        const { score, finalScore, result, isLive, status } = req.body;
        const updateData = {};
        if (score !== undefined) updateData.score = score;
        if (finalScore !== undefined) updateData.finalScore = finalScore;
        if (result !== undefined) updateData.result = result;
        if (isLive !== undefined) updateData.isLive = isLive;
        if (status !== undefined) updateData.status = status;

        const match = await Match.findByIdAndUpdate(req.params.id, updateData, { new: true });
        if (!match) return res.status(404).json({ error: "Match not found." });
        res.status(200).json({ message: "Result updated", match });
    } catch (err) { res.status(500).json({ error: "Failed to update result." }); }
});

// ==========================================
// BACKGROUND WORKERS
// ==========================================

// NEW: Match Lifecycle Manager
// Auto-transition: upcoming -> live (at startTime), live -> completed (after 2hrs)
setInterval(async () => {
    try {
        const now = new Date();

        // Upcoming -> Live
        await Match.updateMany(
            { status: 'upcoming', startTime: { $lte: now } },
            { $set: { status: 'live', isLive: true } }
        );

        // Live -> Completed (remove from live after 2 hours)
        const twoHoursAgo = new Date(now.getTime() - (2 * 60 * 60 * 1000));
        await Match.updateMany(
            { status: 'live', startTime: { $lte: twoHoursAgo } },
            { $set: { status: 'completed', isLive: false } }
        );
    } catch (err) {
        console.error("Match Lifecycle Error:", err);
    }
}, 60000);

// UPDATED: Auto-Settlement Engine with per-leg 2hr settlement & expanded markets
setInterval(async () => {
    try {
        const openBets = await Bet.find({ status: { $in: ['Open', 'Partial'] } }).populate('userId');
        const now = new Date();

        for (let bet of openBets) {
            let betUpdated = false;
            let allSettled = true;
            let hasLost = false;
            let hasOpen = false;

            for (let leg of bet.legs) {
                if (leg.status === 'Open') {
                    const settlementTime = new Date(new Date(leg.startTime).getTime() + (2 * 60 * 60 * 1000));

                    if (now >= settlementTime) {
                        // Time to settle this leg
                        let matchResult = null;
                        try {
                            if (mongoose.Types.ObjectId.isValid(leg.matchId)) {
                                matchResult = await Match.findById(leg.matchId);
                            }
                            if (!matchResult && leg.match) {
                                const homeTeam = leg.match.split(' v ')[0];
                                matchResult = await Match.findOne({ home: homeTeam, startTime: leg.startTime });
                            }
                        } catch (e) {}

                        let isWin = false;
                        const pick = leg.pick || leg.selection;
                        const marketType = leg.marketType || '1x2';

                        if (matchResult && matchResult.result) {
                            const r = matchResult.result;
                            const hG = parseInt(r.homeGoals) || 0;
                            const aG = parseInt(r.awayGoals) || 0;
                            const total = hG + aG;

                            switch (marketType) {
                                case '1x2':
                                    if (pick === '1' && hG > aG) isWin = true;
                                    else if (pick === 'X' && hG === aG) isWin = true;
                                    else if (pick === '2' && aG > hG) isWin = true;
                                    break;
                                case 'correctScore':
                                    if (pick === `${hG}-${aG}`) isWin = true;
                                    break;
                                case 'overUnder':
                                    const line = parseFloat(pick.replace(/[^0-9.]/g, ''));
                                    if (pick.includes('Over') && total > line) isWin = true;
                                    if (pick.includes('Under') && total < line) isWin = true;
                                    break;
                                case 'btts':
                                    const bothScored = hG > 0 && aG > 0;
                                    if (pick === 'Yes' && bothScored) isWin = true;
                                    if (pick === 'No' && !bothScored) isWin = true;
                                    break;
                                case 'doubleChance':
                                    if (pick === '1X' && hG >= aG) isWin = true;
                                    if (pick === 'X2' && aG >= hG) isWin = true;
                                    if (pick === '12' && hG !== aG) isWin = true;
                                    break;
                                default:
                                    // Fallback to 1x2 logic
                                    if (pick === '1' && hG > aG) isWin = true;
                                    else if (pick === 'X' && hG === aG) isWin = true;
                                    else if (pick === '2' && aG > hG) isWin = true;
                            }
                        } else {
                            // No admin result found after 2hrs - random fallback to prevent stuck bets
                            console.warn(`No result found for match ${leg.matchId || leg.match}, using random settlement.`);
                            isWin = Math.random() > 0.5;
                        }

                        leg.status = isWin ? 'Won' : 'Lost';
                        leg.finalScore = matchResult ? (matchResult.finalScore || matchResult.score || `${matchResult.result?.homeGoals}-${matchResult.result?.awayGoals}`) : null;
                        betUpdated = true;
                    } else {
                        allSettled = false;
                        hasOpen = true;
                    }
                }

                if (leg.status === 'Lost') hasLost = true;
                if (leg.status === 'Open') {
                    hasOpen = true;
                    allSettled = false;
                }
            }

            // Determine bet status
            if (hasLost) {
                bet.status = 'Lost';
                betUpdated = true;
            } else if (allSettled) {
                bet.status = 'Won';
                betUpdated = true;
                const user = await User.findById(bet.userId);
                if (user) {
                    user.balance += bet.potentialReturn; await user.save();
                    await Transaction.create({
                        userId: user._id,
                        type: 'Win',
                        amount: bet.potentialReturn,
                        currency: bet.currency,
                        status: 'Success'
                    });
                    await new Notification({
                        userId: user._id,
                        title: "Bet Won! 🎉",
                        message: `Your bet ${bet.ticketId} has won! ${bet.potentialReturn} ${bet.currency} credited.`
                    }).save();
                }
            } else if (betUpdated && !hasLost && hasOpen) {
                // Some legs won, others still pending
                bet.status = 'Partial';
            }

            if (betUpdated) {
                bet.markModified('legs');
                await bet.save();
            }
        }
    } catch (err) {
        console.error("Auto-Settlement Engine Error:", err);
    }
}, 60000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));