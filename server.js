// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json());
app.use(cors()); 

// 1. Connect to MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sportywins';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

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

// Transaction Schema
const TransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true }, // Deposit, Withdrawal, Bet, Win
    amount: { type: Number, required: true },
    currency: String,
    status: { type: String, default: 'Pending' }, // Pending, Completed, Failed
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

// --- AUTHENTICATION ---
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, phone, password } = req.body;
        
        const existingUser = await User.findOne({ $or: [{ phone }, { email }, { username }] });
        if (existingUser) return res.status(400).json({ error: "Username, Email, or Phone already registered." });

        const hashedPassword = await bcrypt.hash(password, 10);
        
        let currency = 'USD';
        let countryCode = 'US';
        if(phone.startsWith('+254')) { currency = 'KES'; countryCode = 'KE'; }
        else if(phone.startsWith('+256')) { currency = 'UGX'; countryCode = 'UG'; }
        else if(phone.startsWith('+255')) { currency = 'TZS'; countryCode = 'TZ'; }
        else if(phone.startsWith('+233')) { currency = 'GHS'; countryCode = 'GH'; }
        else if(phone.startsWith('+260')) { currency = 'ZMW'; countryCode = 'ZM'; }
        else if(phone.startsWith('+27')) { currency = 'ZAR'; countryCode = 'ZA'; }
        else if(phone.startsWith('+44')) { currency = 'GBP'; countryCode = 'GB'; }
        else if(phone.startsWith('+49')) { currency = 'EUR'; countryCode = 'DE'; }

        const newUser = new User({ 
            username, email, phone, 
            password: hashedPassword, 
            name: username, // Explicitly map username to name
            currency, countryCode 
        });
        await newUser.save();

        // Welcome Notification
        await new Notification({ userId: newUser._id, title: "Welcome to SportyWins!", message: "Your account is ready. Deposit now to start betting." }).save();

        // Fixed payload: Include name, username, and oddsFormat explicitly
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
                oddsFormat: newUser.oddsFormat
            } 
        });
    } catch (err) {
        res.status(500).json({ error: "Server error during registration." });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;
        
        // Flexible Phone Matching Logic: Extracts the last 9 digits of the input
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

        // Fixed payload: Include name, username, and oddsFormat explicitly
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
                oddsFormat: user.oddsFormat
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
        res.status(200).json(user);
    } catch (err) { res.status(500).json({ error: "Fetch failed." }); }
});

app.get('/api/user/:id/notifications', async (req, res) => {
    try {
        const notifs = await Notification.find({ $or: [{ userId: req.params.id }, { userId: null }] }).sort({ date: -1 }).limit(20);
        res.status(200).json(notifs);
    } catch (err) { res.status(500).json({ error: "Fetch failed." }); }
});


// --- WALLET & TRANSACTIONS ---
app.post('/api/wallet/deposit', async (req, res) => {
    try {
        const { userId, amount, currency, method } = req.body;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found." });
        
        const txn = new Transaction({ userId, type: 'Deposit', amount, currency, status: 'Pending' });
        await txn.save();

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

        const now = new Date();
        const nextMonth = new Date();
        nextMonth.setDate(now.getDate() + 30);
        const fromDate = now.toISOString().split('.')[0] + 'Z';
        const toDate = nextMonth.toISOString().split('.')[0] + 'Z';

        const sportsToFetch = ['soccer_epl', 'soccer_uefa_champs_league', 'basketball_nba', 'tennis_atp', 'mma_mixed_martial_arts'];
        
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

            let mappedSport = 'football';
            if(match.sport_key.includes('basketball')) mappedSport = 'basketball';
            if(match.sport_key.includes('tennis')) mappedSport = 'tennis';
            if(match.sport_key.includes('mma')) mappedSport = 'mma';

            let gradeScore = 0;
            if(isLiveNow) gradeScore += 100;
            if(userCountry === 'GB' && match.sport_key.includes('epl')) gradeScore += 50;
            if(userCountry === 'US' && match.sport_key.includes('nba')) gradeScore += 50;

            return {
                id: match.id,
                sport: mappedSport,
                region: 'Global',
                league: match.sport_title,
                country: mappedSport === 'basketball' ? 'us' : 'gb-eng',
                home: match.home_team,
                away: match.away_team,
                isLive: isLiveNow, 
                isFeatured: gradeScore > 50,
                time: matchDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                date: matchDate.toLocaleDateString(),
                score: mockScore,
                odds: oddsArray,
                marketCount: Math.floor(Math.random() * 150) + 30,
                gradeScore: gradeScore 
            };
        });

        formattedMatches.sort((a, b) => b.gradeScore - a.gradeScore);
        res.status(200).json(formattedMatches.slice(0, 100)); 
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

        const txn = new Transaction({ userId, type: 'Bet Placed', amount: -stake, currency, status: 'Completed' });
        await txn.save();

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