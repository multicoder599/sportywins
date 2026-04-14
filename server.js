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

// Updated User Schema to support the new Auth Page
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String, default: 'Player' },
    balance: { type: Number, default: 0.00 },
    currency: { type: String, default: 'KES' },
    oddsFormat: { type: String, default: 'decimal' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// Match Schema for Admin manual injections
const MatchSchema = new mongoose.Schema({
    sport: String, league: String, country: String,
    home: String, away: String, isLive: Boolean,
    time: String, date: String, score: String,
    odds: [Number], markets: Object
});
const Match = mongoose.model('Match', MatchSchema);

// NEW: Bet Ticket Schema for saving users' bets
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


// 3. API ROUTES

// --- AUTHENTICATION ROUTES ---
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, phone, password } = req.body;
        
        // Check if username, email, or phone is already taken
        const existingUser = await User.findOne({ $or: [{ phone }, { email }, { username }] });
        if (existingUser) return res.status(400).json({ error: "Username, Email, or Phone already registered." });

        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Auto-assign currency based on phone prefix
        let currency = 'USD';
        if(phone.startsWith('+254')) currency = 'KES';
        else if(phone.startsWith('+256')) currency = 'UGX';
        else if(phone.startsWith('+255')) currency = 'TZS';
        else if(phone.startsWith('+233')) currency = 'GHS';
        else if(phone.startsWith('+260')) currency = 'ZMW';
        else if(phone.startsWith('+27')) currency = 'ZAR';
        else if(phone.startsWith('+44')) currency = 'GBP';
        else if(phone.startsWith('+49')) currency = 'EUR';

        const newUser = new User({ 
            username, email, phone, 
            password: hashedPassword, 
            name: username, 
            currency 
        });
        await newUser.save();

        res.status(201).json({ 
            message: "User created", 
            user: { _id: newUser._id, username: newUser.username, email: newUser.email, phone: newUser.phone, name: newUser.name, balance: newUser.balance, currency: newUser.currency, oddsFormat: newUser.oddsFormat } 
        });
    } catch (err) {
        res.status(500).json({ error: "Server error during registration." });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;
        
        // Find user by matching identifier to either Username, Email, OR Phone
        const user = await User.findOne({ 
            $or: [{ phone: identifier }, { email: identifier }, { username: identifier }] 
        });
        
        if (!user) return res.status(400).json({ error: "User not found. Check your details." });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid password." });

        res.status(200).json({ 
            message: "Login successful", 
            user: { _id: user._id, username: user.username, email: user.email, phone: user.phone, name: user.name, balance: user.balance, currency: user.currency, oddsFormat: user.oddsFormat } 
        });
    } catch (err) {
        res.status(500).json({ error: "Server error during login." });
    }
});

// --- REAL-TIME ODDS API INTEGRATION (MAXIMIZED DATA) ---
const ODDS_API_KEY = process.env.ODDS_API_KEY || '2681c5eb4ab7810ab4809f5a80790ace';

app.get('/api/live-matches', async (req, res) => {
    try {
        // Fetch 'upcoming' across all sports instead of just epl to maximize data
        const response = await fetch(`https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h`);
        
        if (!response.ok) throw new Error(`Odds API Error: ${response.statusText}`);
        
        const data = await response.json();
        
        const formattedMatches = data.map((match) => {
            const bookmaker = match.bookmakers[0];
            const market = bookmaker ? bookmaker.markets[0] : null;
            
            // Extract Odds
            let oddsArray = [2.10, 3.10, 2.80]; 
            if (market && market.outcomes) {
                const homeOdd = market.outcomes.find(o => o.name === match.home_team)?.price || 2.10;
                const drawOdd = market.outcomes.find(o => o.name === 'Draw')?.price || null; // Null if sport has no draw (like basketball)
                const awayOdd = market.outcomes.find(o => o.name === match.away_team)?.price || 2.80;
                oddsArray = [homeOdd, drawOdd, awayOdd];
            }

            const matchDate = new Date(match.commence_time);
            const now = new Date();
            
            // If the match start time has passed, mark it as LIVE and generate a simulated score
            const isLiveNow = matchDate <= now;
            const mockScore = isLiveNow ? `${Math.floor(Math.random()*3)}-${Math.floor(Math.random()*3)}` : null;

            // Map general sport categories and flag icons
            let mappedSport = 'football';
            let mappedCountry = 'eu';
            
            if(match.sport_key.includes('basketball')) mappedSport = 'basketball';
            if(match.sport_key.includes('tennis')) mappedSport = 'tennis';
            if(match.sport_key.includes('americanfootball')) mappedSport = 'rugby';

            if(match.sport_key.includes('us_') || match.sport_key.includes('nba')) mappedCountry = 'us';
            else if(match.sport_key.includes('uk_') || match.sport_key.includes('epl')) mappedCountry = 'gb-eng';
            else if(match.sport_key.includes('aussie')) mappedCountry = 'au';

            return {
                id: match.id,
                sport: mappedSport,
                region: 'Global',
                league: match.sport_title,
                country: mappedCountry,
                home: match.home_team,
                away: match.away_team,
                isLive: isLiveNow, 
                isFeatured: true,
                time: matchDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                date: matchDate.toLocaleDateString(),
                score: mockScore,
                odds: oddsArray,
                marketCount: Math.floor(Math.random() * 150) + 30 
            };
        });

        // Limit to 50 matches so frontend doesn't crash on mobile memory
        res.status(200).json(formattedMatches.slice(0, 50));
    } catch (err) {
        console.error("Odds API Fetch Error:", err.message);
        res.status(500).json({ error: "Could not fetch live matches from Odds API." });
    }
});


// --- BETTING ROUTES ---

// Place a real bet (saves to DB and deducts balance)
app.post('/api/bets/place', async (req, res) => {
    try {
        const { userId, stake, totalOdds, potentialReturn, currency, legs } = req.body;
        
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found." });
        
        // Prevent betting if insufficient funds
        if (user.balance < stake) return res.status(400).json({ error: "Insufficient balance to place this bet." });

        // Deduct stake from live balance
        user.balance -= stake; 
        await user.save();

        const newBet = new Bet({
            userId: user._id,
            ticketId: "SW-" + Math.random().toString(36).substring(2, 8).toUpperCase(),
            stake, 
            totalOdds, 
            potentialReturn, 
            currency, 
            legs
        });
        await newBet.save();

        res.status(201).json({ message: "Bet placed successfully!", ticketId: newBet.ticketId, newBalance: user.balance });
    } catch (err) {
        res.status(500).json({ error: "Failed to place bet. Server error." });
    }
});

// Fetch a user's bet history from the DB
app.get('/api/bets/user/:userId', async (req, res) => {
    try {
        const bets = await Bet.find({ userId: req.params.userId }).sort({ date: -1 });
        res.status(200).json(bets);
    } catch(err) {
        res.status(500).json({ error: "Failed to fetch bets." });
    }
});


// --- ADMIN ROUTES ---

app.get('/api/matches', async (req, res) => {
    try {
        const matches = await Match.find();
        res.status(200).json(matches);
    } catch (err) {
        res.status(500).json({ error: "Could not fetch DB matches." });
    }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find().select('-password'); 
        res.status(200).json(users);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch users." });
    }
});

app.put('/api/admin/users/:id/balance', async (req, res) => {
    try {
        const { amount } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: "User not found." });
        
        user.balance += parseFloat(amount);
        await user.save();
        
        res.status(200).json({ message: "Balance updated successfully!", balance: user.balance });
    } catch (err) {
        res.status(500).json({ error: "Failed to update balance." });
    }
});

app.post('/api/admin/matches', async (req, res) => {
    try {
        const newMatch = new Match(req.body);
        await newMatch.save();
        res.status(201).json({ message: "Match injected successfully!", match: newMatch });
    } catch (err) {
        res.status(500).json({ error: "Failed to add match." });
    }
});

app.delete('/api/admin/matches/:id', async (req, res) => {
    try {
        await Match.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: "Match deleted." });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete match." });
    }
});
// 5. Get All Bets (Admin View)
app.get('/api/admin/bets', async (req, res) => {
    try {
        const bets = await Bet.find().populate('userId', 'username phone').sort({ date: -1 });
        res.status(200).json(bets);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch all bets." });
    }
});

// 6. Fix/Update Match Result Override
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
    } catch (err) {
        res.status(500).json({ error: "Failed to update result." });
    }
});
// 4. Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));