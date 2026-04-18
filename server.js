// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors()); 

// 1. Connect to MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sportywins';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ==========================================
// TELEGRAM BOT NOTIFICATION HELPER
// ==========================================
const sendTelegramMessage = async (message) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!token || !chatId) {
        console.log("Telegram credentials missing. Skipping notification.");
        return;
    }

    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (err) {
        console.error("❌ Telegram notification failed:", err.message);
    }
};

// ==========================================
// CRYPTO ADDRESSES FROM .ENV
// ==========================================
const getCryptoAddresses = () => ({
    Bitcoin: process.env.BTC_ADDRESS || 'bc1q_configure_in_env',
    USDT: process.env.USDT_ADDRESS || '0x_configure_in_env',
    USDC: process.env.USDC_ADDRESS || '0x_configure_in_env',
    Solana: process.env.SOLANA_ADDRESS || 'sol_configure_in_env',
    Litecoin: process.env.LTC_ADDRESS || 'ltc_configure_in_env'
});

// 2. Define Database Schemas

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

const MatchSchema = new mongoose.Schema({
    sport: String, league: String, country: String,
    home: String, away: String, isLive: Boolean,
    time: String, date: String, score: String,
    odds: [Number], markets: Object
});
const Match = mongoose.model('Match', MatchSchema);

const BetSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ticketId: { type: String, required: true },
    date: { type: Date, default: Date.now },
    stake: { type: Number, required: true },
    totalOdds: { type: Number, required: true },
    potentialReturn: { type: Number, required: true },
    status: { type: String, default: 'Open' }, // Open, Won, Lost
    currency: String,
    legs: Array
});
const Bet = mongoose.model('Bet', BetSchema);

// Transaction Schema - Updated to support MegaPay Webhook data
const TransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Made optional for webhook flexibility
    userPhone: String, // Added for webhook lookup
    refId: String,     // Added for MegaPay receipt tracking
    type: { type: String, required: true }, // Deposit, Withdrawal, Bet, Win
    method: String,    // E.g., M-Pesa
    amount: { type: Number, required: true },
    currency: { type: String, default: 'KES' },
    status: { type: String, default: 'Pending' }, // Pending, Success, Failed
    date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

// Notification Schema
const NotificationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Null means global
    title: String,
    message: String,
    isRead: { type: Boolean, default: false },
    date: { type: Date, default: Date.now }
});
const Notification = mongoose.model('Notification', NotificationSchema);


// 3. API ROUTES

// --- MEGAPAY INTEGRATION ---
app.post('/api/deposit', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        if (amount < 10) return res.status(400).json({ success: false, message: 'Minimum deposit is 10 KES.' });
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

        await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        
        // Save initial pending transaction
        await Transaction.create({ 
            refId: reference, 
            userId: user._id,
            userPhone: user.phone, 
            type: 'deposit', 
            method: method || 'M-Pesa', 
            amount: Number(amount), 
            status: 'Pending' 
        });

        res.status(200).json({ success: true, message: "STK Push Sent! Check your phone.", newBalance: user.balance, refId: reference });
    } catch (error) { 
        console.error("MegaPay Initiation Error:", error.message);
        res.status(500).json({ success: false, message: "Payment Gateway Error." }); 
    }
});

app.post('/api/megapay/webhook', async (req, res) => {
    // Immediately acknowledge receipt to MegaPay to prevent retries
    res.status(200).send("OK");
    
    const data = req.body;
    try {
        if ((data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode) != 0) return; 

        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        let rawPhone = (data.Msisdn || data.phone || data.PhoneNumber).toString();
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: phone0 }, { phone: phone254 }, { phone: rawPhone }] });
        if (!user) return;
        
        const existingTx = await Transaction.findOne({ refId: receipt });
        if (existingTx) return;

        user.balance += amount; 
        await user.save();
        
        await Transaction.create({ 
            refId: receipt, 
            userId: user._id,
            userPhone: user.phone, 
            type: "Deposit", 
            method: "M-Pesa", 
            amount: amount, 
            status: "Success" 
        });
        
        // Internal Notification
        await new Notification({ 
            userId: user._id, 
            title: "Deposit Successful", 
            message: `Your deposit of KES ${amount} has been credited. Receipt: ${receipt}` 
        }).save();

        // Telegram Notification
        sendTelegramMessage(`💵 <b>SUCCESSFUL DEPOSIT</b>\n📱 User: ${user.phone}\n💰 Amount: KES ${amount}\n🧾 Ref: ${receipt}`);

    } catch (err) {
        console.error("Webhook processing error:", err);
    }
});


// --- AUTHENTICATION ---
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, phone, password } = req.body;
        
        const existingUser = await User.findOne({ $or: [{ phone }, { email }, { username }] });
        if (existingUser) return res.status(400).json({ error: "Username, Email, or Phone already registered." });

        const hashedPassword = await bcrypt.hash(password, 10);
        
        let currency = 'USD';
        let countryCode = 'US';
        
        // Smart Kenyan Number Detection
        const cleanPhone = phone.replace(/\D/g, '');
        const isKenyan = phone.startsWith('+254') || 
                         cleanPhone.startsWith('254') || 
                         (cleanPhone.length === 10 && (cleanPhone.startsWith('07') || cleanPhone.startsWith('01')));

        if (isKenyan) {
            currency = 'KES'; 
            countryCode = 'KE';
        } else {
            currency = 'USD'; 
            countryCode = 'US';
        }

        const newUser = new User({ 
            username, email, phone, 
            password: hashedPassword, 
            name: username, 
            currency, countryCode 
        });
        await newUser.save();

        // Welcome Notification
        await new Notification({ userId: newUser._id, title: "Welcome to SportyWins!", message: "Your account is ready. Deposit now to start betting." }).save();
        sendTelegramMessage(`🎉 <b>NEW USER REGISTERED</b>\n👤 User: ${username}\n🌍 Country: ${countryCode}`);

        res.status(201).json({ 
            message: "User created", 
            user: { 
                _id: newUser._id, 
                username: newUser.username, 
                name: newUser.name,
                email: newUser.email, 
                phone: newUser.phone, 
                balance: newUser.balance, 
                currency: newUser.currency, 
                countryCode: newUser.countryCode,
                oddsFormat: newUser.oddsFormat,
                cryptoAddresses: getCryptoAddresses()
            } 
        });
    } catch (err) {
        res.status(500).json({ error: "Server error during registration." });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;
        
        // Flexible Phone Matching Logic
        const digitsOnly = identifier.replace(/\D/g, '');
        let phoneQuery = identifier;
        if (digitsOnly.length >= 9) {
            phoneQuery = { $regex: new RegExp(digitsOnly.slice(-9) + '$') };
        }

        const user = await User.findOne({ 
            $or: [
                { email: identifier }, 
                { username: identifier }, 
                { phone: phoneQuery },
                { phone: identifier } // Fallback exact match
            ] 
        });

        if (!user) return res.status(400).json({ error: "User not found. Check your details." });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid password." });

        res.status(200).json({ 
            message: "Login successful", 
            user: { 
                _id: user._id, 
                username: user.username, 
                name: user.name,
                email: user.email, 
                phone: user.phone, 
                balance: user.balance, 
                currency: user.currency, 
                countryCode: user.countryCode,
                oddsFormat: user.oddsFormat,
                cryptoAddresses: getCryptoAddresses()
            } 
        });
    } catch (err) {
        res.status(500).json({ error: "Server error during login." });
    }
});

// --- USER PROFILE & NOTIFICATIONS ---
app.get('/api/user/:id/profile', async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('-password');
        if(!user) return res.status(404).json({error: "User not found"});
        
        const userPayload = user.toObject();
        userPayload.cryptoAddresses = getCryptoAddresses();
        
        res.status(200).json(userPayload);
    } catch (err) { res.status(500).json({ error: "Fetch failed." }); }
});

app.get('/api/user/:id/notifications', async (req, res) => {
    try {
        const notifs = await Notification.find({ $or: [{ userId: req.params.id }, { userId: null }] }).sort({ date: -1 }).limit(20);
        res.status(200).json(notifs);
    } catch (err) { res.status(500).json({ error: "Fetch failed." }); }
});


// --- LEGACY WALLET BACKUP (Manual/Crypto logic) ---
app.post('/api/wallet/deposit/manual', async (req, res) => {
    try {
        const { userId, amount, currency, method } = req.body;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found." });
        
        const txn = new Transaction({ userId, type: 'Deposit', method, amount, currency, status: 'Pending' });
        await txn.save();
        
        sendTelegramMessage(`⏳ <b>MANUAL DEPOSIT PENDING</b>\n👤 User: ${user.username}\n💳 Method: ${method}\n💰 Amount: ${amount} ${currency}`);

        res.status(200).json({ message: "Deposit requested successfully. Pending admin approval.", balance: user.balance });
    } catch (err) { res.status(500).json({ error: "Deposit failed." }); }
});

app.post('/api/wallet/withdraw', async (req, res) => {
    try {
        const { userId, amount, currency, accountDetails } = req.body;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found." });
        if (user.balance < amount) return res.status(400).json({ error: "Insufficient funds." });

        user.balance -= parseFloat(amount);
        await user.save();

        const txn = new Transaction({ userId, type: 'Withdrawal', amount, currency, status: 'Pending' });
        await txn.save();
        
        sendTelegramMessage(`💸 <b>WITHDRAWAL REQUEST</b>\n👤 User: ${user.username}\n📞 Phone: ${user.phone}\n💳 Dest: ${accountDetails}\n💰 Amount: ${amount} ${currency}`);

        res.status(200).json({ message: "Withdrawal requested successfully", balance: user.balance });
    } catch (err) { res.status(500).json({ error: "Withdrawal failed." }); }
});

app.get('/api/wallet/transactions/:userId', async (req, res) => {
    try {
        const txns = await Transaction.find({ userId: req.params.userId }).sort({ date: -1 });
        res.status(200).json(txns);
    } catch (err) { res.status(500).json({ error: "Fetch failed." }); }
});


// --- REAL-TIME ODDS API INTEGRATION ---
const ODDS_API_KEY = process.env.ODDS_API_KEY || '2681c5eb4ab7810ab4809f5a80790ace';

app.get('/api/live-matches', async (req, res) => {
    try {
        const userCountry = req.query.countryCode || 'GB'; 
        
        // Timezone Mapping based on requested country code
        let timezone = 'UTC';
        if(userCountry === 'KE' || userCountry === 'UG' || userCountry === 'TZ') timezone = 'Africa/Nairobi';
        else if(userCountry === 'US') timezone = 'America/New_York';
        else if(userCountry === 'GB') timezone = 'Europe/London';
        else if(userCountry === 'ZA') timezone = 'Africa/Johannesburg';

        const now = new Date();
        const nextMonth = new Date();
        nextMonth.setDate(now.getDate() + 30);
        const fromDate = now.toISOString().split('.')[0] + 'Z';
        const toDate = nextMonth.toISOString().split('.')[0] + 'Z';

        const sportsToFetch = [
            'soccer_epl', 'soccer_uefa_champs_league', 'soccer_italy_serie_a', 
            'soccer_spain_la_liga', 'soccer_germany_bundesliga', 'soccer_france_ligue_one',
            'basketball_nba', 'tennis_atp', 'mma_mixed_martial_arts', 'americanfootball_nfl'
        ];
        
        let allApiMatches = [];

        await Promise.all(sportsToFetch.map(async (sportKey) => {
            try {
                const response = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h&commenceTimeFrom=${fromDate}&commenceTimeTo=${toDate}`);
                if (response.ok) {
                    const data = await response.json();
                    allApiMatches = allApiMatches.concat(data);
                }
            } catch(e) { console.warn(`Skipped sport ${sportKey}`); }
        }));
        
        let formattedMatches = allApiMatches.map((match) => {
            const bookmaker = match.bookmakers[0];
            const market = bookmaker ? bookmaker.markets[0] : null;
            
            let oddsArray = [2.10, 3.10, 2.80]; 
            if (market && market.outcomes) {
                const homeOdd = market.outcomes.find(o => o.name === match.home_team)?.price || 2.10;
                const drawOdd = market.outcomes.find(o => o.name === 'Draw')?.price || null; 
                const awayOdd = market.outcomes.find(o => o.name === match.away_team)?.price || 2.80;
                oddsArray = [homeOdd, drawOdd, awayOdd];
            }

            const matchDate = new Date(match.commence_time);
            const isLiveNow = matchDate <= new Date();
            const mockScore = isLiveNow ? `${Math.floor(Math.random()*3)}-${Math.floor(Math.random()*3)}` : null;
            
            // Format time natively by Timezone mapping
            let formattedTime = matchDate.toLocaleTimeString('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
            let formattedDate = matchDate.toLocaleDateString('en-US', { timeZone: timezone, month: 'short', day: 'numeric' });

            let mappedSport = 'football';
            if(match.sport_key.includes('basketball')) mappedSport = 'basketball';
            if(match.sport_key.includes('tennis')) mappedSport = 'tennis';
            if(match.sport_key.includes('mma')) mappedSport = 'mma';
            if(match.sport_key.includes('americanfootball')) mappedSport = 'rugby';

            let gradeScore = 0;
            if(isLiveNow) gradeScore += 100;
            if(userCountry === 'GB' && match.sport_key.includes('epl')) gradeScore += 50;
            if(userCountry === 'US' && match.sport_key.includes('nba')) gradeScore += 50;

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
                time: formattedTime, // Dynamically adjusted Timezone
                date: formattedDate,
                score: mockScore,
                odds: oddsArray,
                marketCount: Math.floor(Math.random() * 150) + 30,
                gradeScore: gradeScore 
            };
        });

        formattedMatches.sort((a, b) => b.gradeScore - a.gradeScore);
        res.status(200).json(formattedMatches.slice(0, 300)); 
    } catch (err) {
        res.status(500).json({ error: "Could not fetch live matches." });
    }
});

// --- SEARCH ENGINE ---
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(200).json([]);
        
        const dbResults = await Match.find({
            $or: [
                { home: { $regex: query, $options: 'i' } },
                { away: { $regex: query, $options: 'i' } },
                { league: { $regex: query, $options: 'i' } }
            ]
        });
        res.status(200).json(dbResults);
    } catch (err) { res.status(500).json({ error: "Search failed." }); }
});


// --- BETTING ROUTES ---
app.post('/api/bets/place', async (req, res) => {
    try {
        const { userId, stake, totalOdds, potentialReturn, currency, legs } = req.body;
        
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found." });
        if (user.balance < stake) return res.status(400).json({ error: "Insufficient balance." });

        user.balance -= stake; 
        await user.save();

        const newBet = new Bet({
            userId: user._id,
            ticketId: "SW-" + Math.random().toString(36).substring(2, 8).toUpperCase(),
            stake, totalOdds, potentialReturn, currency, legs
        });
        await newBet.save();

        await Transaction.create({ userId, type: 'Bet Placed', amount: -stake, currency, status: 'Completed' });
        
        sendTelegramMessage(`🎲 <b>NEW BET PLACED</b>\n👤 User: ${user.username}\n💰 Stake: ${stake} ${currency}\n🎯 Potential Win: ${potentialReturn} ${currency}\n🎫 Legs: ${legs.length}`);

        res.status(201).json({ message: "Bet placed successfully!", ticketId: newBet.ticketId, newBalance: user.balance });
    } catch (err) { res.status(500).json({ error: "Failed to place bet." }); }
});

app.get('/api/bets/user/:userId', async (req, res) => {
    try {
        const bets = await Bet.find({ userId: req.params.userId }).sort({ date: -1 });
        res.status(200).json(bets);
    } catch(err) { res.status(500).json({ error: "Failed to fetch bets." }); }
});


// --- ADMIN ROUTES ---
app.get('/api/matches', async (req, res) => {
    try {
        const matches = await Match.find();
        res.status(200).json(matches);
    } catch (err) { res.status(500).json({ error: "Could not fetch DB matches." }); }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find().select('-password'); 
        res.status(200).json(users);
    } catch (err) { res.status(500).json({ error: "Failed to fetch users." }); }
});

app.put('/api/admin/users/:id/balance/set', async (req, res) => {
    try {
        const { amount } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: "User not found." });
        
        user.balance = parseFloat(amount);
        await user.save();
        res.status(200).json({ message: "Balance updated successfully!", balance: user.balance });
    } catch (err) { res.status(500).json({ error: "Failed to update balance." }); }
});

app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: "User deleted." });
    } catch (err) { res.status(500).json({ error: "Failed to delete user." }); }
});

app.get('/api/admin/transactions', async (req, res) => {
    try {
        const statusFilter = req.query.status || 'Pending';
        const txns = await Transaction.find({ status: statusFilter })
                                      .populate('userId', 'username')
                                      .sort({ date: -1 });
        res.status(200).json(txns);
    } catch (err) { res.status(500).json({ error: "Failed to fetch transactions." }); }
});

app.put('/api/admin/transactions/:id/:action', async (req, res) => {
    try {
        const action = req.params.action.toLowerCase();
        const txn = await Transaction.findById(req.params.id);
        if (!txn) return res.status(404).json({ error: "Transaction not found." });
        if (txn.status !== 'Pending') return res.status(400).json({ error: "Transaction already processed." });

        if (action === 'approve') {
            txn.status = 'Completed';
            if (txn.type === 'Deposit') {
                const user = await User.findById(txn.userId);
                user.balance += txn.amount;
                await user.save();
                await new Notification({ userId: user._id, title: "Deposit Approved", message: `Your deposit of ${txn.amount} ${txn.currency} was approved.` }).save();
            }
        } else if (action === 'reject') {
            txn.status = 'Failed';
            if (txn.type === 'Withdrawal') {
                const user = await User.findById(txn.userId);
                user.balance += txn.amount;
                await user.save();
                await new Notification({ userId: user._id, title: "Withdrawal Rejected", message: `Your withdrawal of ${txn.amount} ${txn.currency} was rejected. Funds returned.` }).save();
            }
        }

        await txn.save();
        res.status(200).json({ message: `Transaction ${action}d.` });
    } catch (err) { res.status(500).json({ error: "Failed to process transaction." }); }
});

app.post('/api/admin/matches', async (req, res) => {
    try {
        const newMatch = new Match(req.body);
        await newMatch.save();
        res.status(201).json({ message: "Match injected successfully!", match: newMatch });
    } catch (err) { res.status(500).json({ error: "Failed to add match." }); }
});

app.delete('/api/admin/matches/:id', async (req, res) => {
    try {
        await Match.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: "Match deleted." });
    } catch (err) { res.status(500).json({ error: "Failed to delete match." }); }
});

app.get('/api/admin/bets', async (req, res) => {
    try {
        const bets = await Bet.find().populate('userId', 'username phone').sort({ date: -1 });
        res.status(200).json(bets);
    } catch (err) { res.status(500).json({ error: "Failed to fetch all bets." }); }
});

app.put('/api/admin/matches/:id/result', async (req, res) => {
    try {
        const { score, isLive } = req.body;
        const match = await Match.findByIdAndUpdate(
            req.params.id,  
            { score: score, isLive: isLive }, 
            { new: true }
        );
        if (!match) return res.status(404).json({ error: "Match not found." });
        res.status(200).json({ message: "Result updated", match });
    } catch (err) { res.status(500).json({ error: "Failed to update result." }); }
});

// 4. Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));