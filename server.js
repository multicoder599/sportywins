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

// 🔓 UNIVERSAL CORS POLICY (Unblocks Mobile Testing & All Domains)
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
// TIMEZONE HELPERS
// ==========================================

const getTimezoneFromCountry = (countryCode, phone = '') => {
    const map = {
        KE: 'Africa/Nairobi', UG: 'Africa/Kampala', TZ: 'Africa/Dar_es_Salaam',
        NG: 'Africa/Lagos', ZA: 'Africa/Johannesburg', GH: 'Africa/Accra',
        GB: 'Europe/London', US: 'America/New_York', CA: 'America/Toronto',
        AU: 'Australia/Sydney', IN: 'Asia/Kolkata', DE: 'Europe/Berlin',
        FR: 'Europe/Paris', ES: 'Europe/Madrid', IT: 'Europe/Rome',
        BR: 'America/Sao_Paulo', MX: 'America/Mexico_City', AE: 'Asia/Dubai'
    };
    const p = String(phone).replace(/\D/g, '');
    if (p.startsWith('254')) return 'Africa/Nairobi';
    if (p.startsWith('255')) return 'Africa/Dar_es_Salaam';
    if (p.startsWith('256')) return 'Africa/Kampala';
    if (p.startsWith('234')) return 'Africa/Lagos';
    if (p.startsWith('27'))  return 'Africa/Johannesburg';
    if (p.startsWith('233')) return 'Africa/Accra';
    if (p.startsWith('44'))  return 'Europe/London';
    if (p.startsWith('1'))   return 'America/New_York';
    return map[countryCode] || 'UTC';
};

// ==========================================
// SCHEMAS
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
    timezone: { type: String, default: 'Africa/Nairobi' }, 
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const MatchSchema = new mongoose.Schema({
    sport: String,
    league: String,
    country: String,
    home: String,
    away: String,
    isLive: { type: Boolean, default: false },
    status: { type: String, enum: ['upcoming', 'live', 'completed'], default: 'upcoming' },
    startTime: { type: Date }, // Always stored as UTC
    timezone: { type: String, default: 'UTC' }, // Origin timezone of the match
    time: String,
    date: String,
    score: String,
    finalScore: String,
    odds: [Number],
    markets: {
        h2h: { home: Number, draw: Number, away: Number },
        correctScore: [{ score: String, odds: Number }],
        overUnder: [{ line: Number, over: Number, under: Number }],
        btts: { yes: Number, no: Number },
        doubleChance: { '1x': Number, x2: Number, '12': Number }
    },
    result: {
        homeGoals: Number,
        awayGoals: Number,
        correctScore: String,
        btts: String,
        winner: String
    }
});
const Match = mongoose.model('Match', MatchSchema);

const BetSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ticketId: { type: String, required: true },
    date: { type: Date, default: Date.now },
    stake: { type: Number, required: true },
    totalOdds: { type: Number, required: true },
    potentialReturn: { type: Number, required: true },
    status: { type: String, default: 'Open', enum: ['Open', 'Partial', 'Won', 'Lost', 'Cancelled'] },
    currency: String,
    userTimezone: { type: String, default: 'Africa/Nairobi' }, // Snapshot at bet time
    bookingCode: { type: String, unique: true, sparse: true }, // Shareable code
    legs: [{
        matchId: String,
        match: String,
        pick: String,
        selection: String,
        marketType: { type: String, default: '1x2' },
        odds: Number,
        startTime: Date, // UTC
        status: { type: String, default: 'Open' },
        score: String,
        finalScore: String
    }]
});
const Bet = mongoose.model('Bet', BetSchema);

const BookingSlipSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, index: true },
    legs: [{
        matchId: String,
        match: String,
        pick: String,
        selection: String,
        marketType: { type: String, default: '1x2' },
        odds: Number,
        startTime: Date
    }],
    stake: Number,
    totalOdds: Number,
    potentialReturn: Number,
    currency: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 }
});
const BookingSlip = mongoose.model('BookingSlip', BookingSlipSchema);

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
// DEPOSIT & M-PESA
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
// AUTH & USERS
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
        const timezone = getTimezoneFromCountry(countryCode, phone);

        const newUser = new User({ username, email, phone, password: hashedPassword, name: username, currency, countryCode, timezone });
        await newUser.save();

        await new Notification({ userId: newUser._id, title: "Welcome to SportyWins!", message: "Your account is ready." }).save();
        sendTelegramMessage(`🎉 <b>NEW USER</b>\n👤 ${username}\n📞 ${phone}`);

        res.status(201).json({ message: "User created", user: { _id: newUser._id, username: newUser.username, name: newUser.name, email: newUser.email, phone: newUser.phone, balance: newUser.balance, currency: newUser.currency, countryCode: newUser.countryCode, timezone: newUser.timezone, oddsFormat: newUser.oddsFormat, cryptoAddresses: getCryptoAddresses() } });
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

        res.status(200).json({ message: "Login successful", user: { _id: user._id, username: user.username, name: user.name, email: user.email, phone: user.phone, balance: user.balance, currency: user.currency, countryCode: user.countryCode, timezone: user.timezone, oddsFormat: user.oddsFormat, cryptoAddresses: getCryptoAddresses() } });
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
// WALLET WITHDRAWALS & MANUAL DEPOSITS
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

const ODDS_API_KEY = process.env.ODDS_API_KEY || '6659e819db0bbdedf3d8d961d32b8ec9';

// 🔥 DETERMINISTIC SCORE GENERATOR
function getDeterministicScore(matchId, startTimeStr, adminResultObj) {
    const start = new Date(startTimeStr).getTime();
    const now = new Date().getTime();
    const elapsed = now - start;
    
    if (elapsed < 0) return null; 

    const duration = 2 * 60 * 60 * 1000; // 2 hours
    const progress = Math.min(elapsed / duration, 1);

    if (adminResultObj && adminResultObj.homeGoals !== undefined) {
        return `${Math.floor(adminResultObj.homeGoals * progress)}-${Math.floor(adminResultObj.awayGoals * progress)}`;
    }

    let seed = 0;
    for (let i = 0; i < matchId.length; i++) {
        seed += matchId.charCodeAt(i);
    }
    
    const maxHome = seed % 4; 
    const maxAway = (seed * 3) % 4;
    
    return `${Math.floor(maxHome * progress)}-${Math.floor(maxAway * progress)}`;
}

app.get('/api/matches', async (req, res) => {
    try {
        const dbMatches = await Match.find({
            status: { $in: ['upcoming', 'live'] }
        }).sort({ startTime: 1 });

        const formatted = dbMatches.map(m => {
            const obj = m.toObject();
            obj.startTime = m.startTime ? m.startTime.toISOString() : null;
            obj.markets = m.markets || {};
            if (obj.status === 'live' && obj.startTime) {
                obj.score = getDeterministicScore(obj._id.toString(), obj.startTime, obj.result);
            }
            return obj;
        });

        res.status(200).json(formatted);
    } catch (err) { res.status(500).json({ error: "Fetch failed." }); }
});

// 🛡️ LIVE MATCHES & PARLAY API INTEGRATION
app.get('/api/live-matches', async (req, res) => {
    try {
        const now = new Date();
        const nextWeek = new Date();
        nextWeek.setDate(now.getDate() + 7);

        // 🕰️ TIME FIX: Reach back 3 hours to fetch CURRENTLY LIVE games
        const threeHoursAgo = new Date(now.getTime() - (3 * 60 * 60 * 1000));
        const fromDate = threeHoursAgo.toISOString().split('.')[0] + 'Z';
        const toDate = nextWeek.toISOString().split('.')[0] + 'Z';

        const sportsToFetch = [
            'soccer_epl', 'soccer_uefa_champs_league', 'soccer_uefa_europa_league', 'soccer_italy_serie_a',
            'soccer_spain_la_liga', 'soccer_germany_bundesliga', 'soccer_france_ligue_one', 'soccer_england_championship',
            'soccer_england_league_1', 'soccer_england_league_2', 'soccer_netherlands_eredivisie', 
            'soccer_portugal_primeira_liga', 'soccer_turkey_super_lig', 'soccer_brazil_campeonato', 'soccer_usa_mls',
            'basketball_nba', 'basketball_euroleague', 'basketball_ncaab',
            'tennis_atp', 'tennis_wta', 'icehockey_nhl',
            'mma_mixed_martial_arts', 'americanfootball_nfl', 'baseball_mlb'
        ];

        let allApiMatches = [];

        await Promise.all(sportsToFetch.map(async (sportKey) => {
            try {
                const response = await axios.get(`https://parlay-api.com/v1/sports/${sportKey}/odds?apiKey=${ODDS_API_KEY}&regions=uk,eu,us&markets=h2h,spreads&commenceTimeFrom=${fromDate}&commenceTimeTo=${toDate}`);
                if (response.data) {
                    allApiMatches = allApiMatches.concat(response.data);
                }
            } catch (e) {
                console.warn(`Parlay API skipped ${sportKey} (might be out of season).`);
            }
        }));

        if (allApiMatches.length === 0) {
            allApiMatches = [
                {
                    id: 'sim_1', sport_key: 'soccer_epl', sport_title: 'Premier League', home_team: 'Manchester City', away_team: 'Liverpool',
                    commence_time: new Date(now.getTime() + 3600000).toISOString(),
                    bookmakers: [{ markets: [{ outcomes: [{ name: 'Manchester City', price: 1.95 }, { name: 'Draw', price: 3.50 }, { name: 'Liverpool', price: 3.80 }] }] }]
                },
                {
                    id: 'sim_2', sport_key: 'soccer_spain_la_liga', sport_title: 'La Liga', home_team: 'Real Madrid', away_team: 'Atletico Madrid',
                    commence_time: new Date(now.getTime() + 7200000).toISOString(),
                    bookmakers: [{ markets: [{ outcomes: [{ name: 'Real Madrid', price: 1.80 }, { name: 'Draw', price: 3.60 }, { name: 'Atletico Madrid', price: 4.20 }] }] }]
                },
                {
                    id: 'sim_3', sport_key: 'soccer_italy_serie_a', sport_title: 'Serie A', home_team: 'Juventus', away_team: 'AC Milan',
                    commence_time: new Date(now.getTime() + 10800000).toISOString(),
                    bookmakers: [{ markets: [{ outcomes: [{ name: 'Juventus', price: 2.20 }, { name: 'Draw', price: 3.20 }, { name: 'AC Milan', price: 3.10 }] }] }]
                }
            ];
        }

        let formattedMatches = allApiMatches.map((match) => {
            const market = match.bookmakers[0]?.markets[0];
            let homeOdds = 2.10, drawOdds = null, awayOdds = 2.80;

            if (market && market.outcomes) {
                const homeOutcome = market.outcomes.find(o => o.name === match.home_team);
                const awayOutcome = market.outcomes.find(o => o.name === match.away_team);
                const drawOutcome = market.outcomes.find(o => o.name === 'Draw' || (o.name !== match.home_team && o.name !== match.away_team));

                if (homeOutcome) homeOdds = homeOutcome.price;
                if (awayOutcome) awayOdds = awayOutcome.price;
                if (drawOutcome) drawOdds = drawOutcome.price;
            }

            const matchDate = new Date(match.commence_time);
            const elapsed = now.getTime() - matchDate.getTime();
            const twoHours = 2 * 60 * 60 * 1000;

            // Hide from API feed exactly 2 hours after kickoff
            if (elapsed >= twoHours) return null;

            const isLiveNow = elapsed >= 0 && elapsed < twoHours;
            const liveScore = isLiveNow ? getDeterministicScore(match.id, match.commence_time, null) : null;

            let mappedSport = 'football';
            if (match.sport_key.includes('basketball')) mappedSport = 'basketball';
            if (match.sport_key.includes('tennis')) mappedSport = 'tennis';
            if (match.sport_key.includes('mma')) mappedSport = 'mma';
            if (match.sport_key.includes('icehockey')) mappedSport = 'icehockey';
            if (match.sport_key.includes('americanfootball')) mappedSport = 'rugby';
            if (match.sport_key.includes('baseball')) mappedSport = 'baseball';

            if (mappedSport === 'football' && !drawOdds) {
                drawOdds = parseFloat(((homeOdds + awayOdds) / 1.5).toFixed(2));
                if (drawOdds < 2.5) drawOdds = 3.10; 
            }

            let gradeScore = isLiveNow ? 200 : 0;
            if (mappedSport === 'football') gradeScore += 50;
            if (match.sport_key.includes('champs_league') || match.sport_key.includes('epl')) gradeScore += 75;

            return {
                id: match.id,
                sport: mappedSport,
                region: 'Global',
                league: match.sport_title,
                country: mappedSport === 'basketball' || mappedSport === 'rugby' || mappedSport === 'baseball' ? 'us' : 'gb-eng',
                home: match.home_team,
                away: match.away_team,
                isLive: isLiveNow,
                isFeatured: gradeScore > 50,
                startTime: match.commence_time,
                score: liveScore,
                odds: [homeOdds, drawOdds, awayOdds],
                marketCount: Math.floor(Math.random() * 150) + 30,
                gradeScore: gradeScore,
                status: isLiveNow ? 'live' : 'upcoming',
                result: null,
                finalScore: null
            };
        }).filter(m => m !== null); 

        let dbMatches = [];
        try {
            dbMatches = (await Match.find({ status: { $in: ['upcoming', 'live'] } })).map(m => ({
                id: m._id.toString(),
                sport: m.sport || 'football',
                region: 'Custom',
                league: m.league || 'League',
                country: m.country || 'gb-eng',
                home: m.home,
                away: m.away,
                isLive: m.status === 'live',
                isFeatured: true,
                startTime: m.startTime ? m.startTime.toISOString() : null,
                score: m.status === 'live' ? getDeterministicScore(m._id.toString(), m.startTime, m.result) : null,
                finalScore: m.finalScore || null,
                odds: m.odds || [2.1, 3.1, 2.8],
                marketCount: m.markets ? (Object.keys(m.markets).length * 5 + 20) : 50,
                gradeScore: 1000,
                detailedMarkets: m.markets || {},
                status: m.status,
                result: m.result || null
            }));
        } catch (e) {}

        const combined = [...dbMatches, ...formattedMatches].sort((a, b) => b.gradeScore - a.gradeScore);
        
        res.status(200).json(combined.slice(0, 500));
    } catch (err) {
        console.error("Live Matches Error:", err);
        res.status(500).json({ error: "Could not fetch live matches." });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(200).json([]);
        const dbResults = await Match.find({
            status: { $in: ['upcoming', 'live'] },
            $or: [{ home: { $regex: query, $options: 'i' } }, { away: { $regex: query, $options: 'i' } }, { league: { $regex: query, $options: 'i' } }]
        });
        res.status(200).json(dbResults);
    } catch (err) { res.status(500).json({ error: "Search failed." }); }
});

// ==========================================
// BETTING
// ==========================================

app.post('/api/bets/place', async (req, res) => {
    try {
        let { userId, stake, totalOdds, potentialReturn, currency, legs, bookingCode } = req.body;

        stake = parseFloat(stake);
        totalOdds = parseFloat(totalOdds);

        if (isNaN(stake) || stake <= 0) {
            return res.status(400).json({ error: "Invalid stake amount." });
        }
        if (isNaN(totalOdds) || totalOdds < 1) {
            return res.status(400).json({ error: "Invalid total odds." });
        }

        // Always calculate server-side — ignore whatever frontend sent
        potentialReturn = parseFloat((stake * totalOdds).toFixed(2));

        if (!Array.isArray(legs) || legs.length === 0) {
            return res.status(400).json({ error: "No bet legs provided." });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found." });
        if (user.balance < stake) return res.status(400).json({ error: "Insufficient balance." });

        user.balance -= stake;
        await user.save();

        const trackedLegs = await Promise.all(legs.map(async leg => {
            let legStartTime = leg.startTime ? new Date(leg.startTime) : null;

            if (leg.matchId && mongoose.Types.ObjectId.isValid(leg.matchId)) {
                const dbMatch = await Match.findById(leg.matchId).select('startTime');
                if (dbMatch && dbMatch.startTime) legStartTime = dbMatch.startTime;
            }

            if (!legStartTime && leg.time && leg.time.includes('•')) {
                const [dPart, tPart] = leg.time.split(' • ');
                const parsed = new Date(`${dPart} ${tPart}`);
                if (!isNaN(parsed)) legStartTime = parsed;
            }

            if (!legStartTime) legStartTime = new Date(Date.now() + 2 * 60 * 60 * 1000);

            return {
                matchId: leg.matchId,
                match: leg.match,
                pick: leg.pick,
                selection: leg.selection,
                marketType: leg.marketType || '1x2',
                odds: parseFloat(leg.odds) || 0,
                startTime: legStartTime,
                status: 'Open',
                score: null,
                finalScore: null
            };
        }));

        const newBet = new Bet({
            userId: user._id,
            ticketId: "SW-" + Math.random().toString(36).substring(2, 8).toUpperCase(),
            bookingCode: bookingCode || undefined,
            stake,
            totalOdds,
            potentialReturn,
            currency: currency || user.currency,
            userTimezone: user.timezone || 'Africa/Nairobi',
            legs: trackedLegs
        });
        await newBet.save();

        await Transaction.create({
            userId,
            type: 'Bet Placed',
            amount: -stake,
            currency: newBet.currency,
            status: 'Completed'
        });

        sendTelegramMessage(`🎲 <b>NEW BET PLACED</b>\n👤 User: ${user.username}\n💰 Stake: ${stake} ${newBet.currency}\n🎯 Win: ${potentialReturn} ${newBet.currency}`);

        res.status(201).json({
            message: "Bet placed successfully!",
            ticketId: newBet.ticketId,
            newBalance: user.balance,
            bet: newBet
        });
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

app.post('/api/bets/save-code', async (req, res) => {
    try {
        const { code, legs, stake, totalOdds, potentialReturn, currency } = req.body;
        if (!code || !legs || legs.length === 0) {
            return res.status(400).json({ error: "Code and legs are required." });
        }
        await BookingSlip.findOneAndUpdate(
            { code: code.toUpperCase() },
            { code: code.toUpperCase(), legs, stake, totalOdds, potentialReturn, currency },
            { upsert: true, new: true }
        );
        res.status(200).json({ success: true, message: "Code saved." });
    } catch (err) {
        console.error("Save code error:", err);
        res.status(500).json({ error: "Failed to save code." });
    }
});

app.get('/api/bets/code/:code', async (req, res) => {
    try {
        const slip = await BookingSlip.findOne({ code: req.params.code.toUpperCase() });
        if (!slip) return res.status(404).json({ error: "Code not found or expired." });
        res.status(200).json(slip);
    } catch (err) {
        res.status(500).json({ error: "Failed to load code." });
    }
});

// ==========================================
// ADMIN ROUTES
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

// 🛡️ ADMIN FEED: Fetches ALL matches (Upcoming, Live, and Completed)
app.get('/api/admin/matches', verifyAdminToken, async (req, res) => {
    try {
        const matches = await Match.find().sort({ startTime: -1 }).limit(500);
        res.status(200).json(matches);
    } catch (err) {
        console.error("Admin matches error:", err);
        res.status(500).json({ error: "Failed to fetch matches." });
    }
});

app.post('/api/admin/matches', verifyAdminToken, async (req, res) => {
    try {
        const matchData = req.body;

        if (!matchData.startTime) {
            return res.status(400).json({ error: "startTime is required for match lifecycle." });
        }

        const parsedStart = new Date(matchData.startTime);
        if (isNaN(parsedStart.getTime())) {
            return res.status(400).json({ error: "Invalid startTime format. Use ISO 8601 (e.g. 2026-04-24T14:00:00Z)" });
        }

        const newMatch = new Match({
            ...matchData,
            status: 'upcoming',
            isLive: false,
            startTime: parsedStart,
            timezone: matchData.timezone || 'UTC',
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

app.put('/api/admin/matches/:id/result', verifyAdminToken, async (req, res) => {
    try {
        const { score, finalScore, result, isLive, status } = req.body;
        const updateData = {};

        if (score !== undefined) updateData.score = score;
        if (finalScore !== undefined) updateData.finalScore = finalScore;

        if (result !== undefined) {
            if (typeof result === 'string' && result.includes('-')) {
                const [h, a] = result.split('-').map(s => parseInt(s.trim()));
                updateData.result = {
                    homeGoals: h || 0,
                    awayGoals: a || 0,
                    correctScore: result,
                    winner: h > a ? 'home' : a > h ? 'away' : 'draw'
                };
            } else if (typeof result === 'object' && result !== null) {
                const h = parseInt(result.homeGoals);
                const a = parseInt(result.awayGoals);
                updateData.result = {
                    homeGoals: isNaN(h) ? 0 : h,
                    awayGoals: isNaN(a) ? 0 : a,
                    correctScore: result.correctScore || `${h}-${a}`,
                    btts: result.btts,
                    winner: result.winner || (h > a ? 'home' : a > h ? 'away' : 'draw')
                };
            } else {
                updateData.result = result;
            }
        }

        if (!updateData.result && (finalScore || score)) {
            const scoreStr = finalScore || score;
            if (typeof scoreStr === 'string' && scoreStr.includes('-')) {
                const [h, a] = scoreStr.split('-').map(s => parseInt(s.trim()));
                if (!isNaN(h) && !isNaN(a)) {
                    updateData.result = {
                        homeGoals: h,
                        awayGoals: a,
                        correctScore: scoreStr,
                        winner: h > a ? 'home' : a > h ? 'away' : 'draw'
                    };
                }
            }
        }

        if (isLive !== undefined) updateData.isLive = isLive;
        if (status !== undefined) updateData.status = status;

        const match = await Match.findByIdAndUpdate(req.params.id, updateData, { new: true });
        if (!match) return res.status(404).json({ error: "Match not found." });
        res.status(200).json({ message: "Result updated", match });
    } catch (err) {
        console.error("Admin result error:", err);
        res.status(500).json({ error: "Failed to update result." });
    }
});

// ==========================================
// BACKGROUND WORKERS
// ==========================================

setInterval(async () => {
    try {
        const now = new Date();
        await Match.updateMany(
            { status: 'upcoming', startTime: { $lte: now } },
            { $set: { status: 'live', isLive: true } }
        );
        const twoHoursAgo = new Date(now.getTime() - (2 * 60 * 60 * 1000));
        await Match.updateMany(
            { status: 'live', startTime: { $lte: twoHoursAgo } },
            { $set: { status: 'completed', isLive: false } }
        );
    } catch (err) {
        console.error("Match Lifecycle Error:", err);
    }
}, 60000);

setInterval(async () => {
    try {
        const openBets = await Bet.find({ status: { $in: ['Open', 'Partial'] } }).populate('userId');
        const now = new Date();

        for (let bet of openBets) {
            let betUpdated = false;
            let allSettled = true;
            let hasLost = false;

            for (let leg of bet.legs) {
                if (leg.status !== 'Open') {
                    if (leg.status === 'Lost') hasLost = true;
                    continue;
                }

                const settlementTime = new Date(new Date(leg.startTime).getTime() + (2 * 60 * 60 * 1000));

                if (now < settlementTime) {
                    allSettled = false;
                    continue;
                }

                let matchResult = null;
                try {
                    if (mongoose.Types.ObjectId.isValid(leg.matchId)) {
                        matchResult = await Match.findById(leg.matchId);
                    }
                    if (!matchResult && leg.match) {
                        const homeTeam = leg.match.split(' v ')[0];
                        matchResult = await Match.findOne({ home: homeTeam, startTime: leg.startTime });
                    }
                } catch (e) {
                    console.error("Match lookup error:", e);
                }

                let resultObj = null;
                if (matchResult) {
                    if (matchResult.result &&
                        matchResult.result.homeGoals !== undefined &&
                        matchResult.result.awayGoals !== undefined) {
                        resultObj = matchResult.result;
                    } else {
                        const scoreStr = matchResult.finalScore || matchResult.score;
                        if (typeof scoreStr === 'string' && scoreStr.includes('-')) {
                            const parts = scoreStr.split('-').map(s => parseInt(s.trim()));
                            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                                resultObj = {
                                    homeGoals: parts[0],
                                    awayGoals: parts[1],
                                    correctScore: scoreStr
                                };
                            }
                        }
                    }
                }

                let isWin = false;
                const pick = (leg.pick || leg.selection || '').toString().trim();
                const marketType = leg.marketType || '1x2';

                if (resultObj) {
                    const hG = parseInt(resultObj.homeGoals) || 0;
                    const aG = parseInt(resultObj.awayGoals) || 0;
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
                            if (pick === '1' && hG > aG) isWin = true;
                            else if (pick === 'X' && hG === aG) isWin = true;
                            else if (pick === '2' && aG > hG) isWin = true;
                    }
                } else {
                    console.warn(`No admin result for match ${leg.matchId || leg.match} after 2hrs. Random settlement.`);
                    isWin = Math.random() > 0.5;
                }

                leg.status = isWin ? 'Won' : 'Lost';
                leg.finalScore = matchResult
                    ? (matchResult.finalScore || matchResult.score || `${resultObj?.homeGoals || 0}-${resultObj?.awayGoals || 0}`)
                    : null;
                betUpdated = true;

                if (leg.status === 'Lost') hasLost = true;
            }

            if (hasLost) {
                bet.status = 'Lost';
                betUpdated = true;
            } else if (allSettled) {
                bet.status = 'Won';
                betUpdated = true;
                const user = await User.findById(bet.userId);
                if (user) {
                    user.balance += bet.potentialReturn;
                    await user.save();
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
            } else if (betUpdated) {
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