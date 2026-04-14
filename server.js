// server.js
require('dotenv').config(); // Allows loading from a local .env file
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json());
app.use(cors()); // Allows frontend to talk to backend

// 1. Connect to MongoDB (Reads from Render ENV, falls back to local)
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sportywins';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 2. Define Database Schemas
const UserSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String, default: 'Player' },
    balance: { type: Number, default: 0.00 },
    currency: { type: String, default: 'KES' },
    oddsFormat: { type: String, default: 'decimal' }
});
const User = mongoose.model('User', UserSchema);

const MatchSchema = new mongoose.Schema({
    sport: String, league: String, country: String,
    home: String, away: String, isLive: Boolean,
    time: String, date: String, score: String,
    odds: [Number], markets: Object
});
const Match = mongoose.model('Match', MatchSchema);

// 3. API ROUTES

// --- REGISTER ROUTE ---
app.post('/api/auth/register', async (req, res) => {
    try {
        const { phone, password, currency, oddsFormat } = req.body;
        
        // Check if user exists
        const existingUser = await User.findOne({ phone });
        if (existingUser) return res.status(400).json({ error: "Phone number already registered." });

        // Hash password and save
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ phone, password: hashedPassword, currency, oddsFormat });
        await newUser.save();

        // Return user data (without password)
        res.status(201).json({ 
            message: "User created", 
            user: { phone: newUser.phone, name: newUser.name, balance: newUser.balance, currency: newUser.currency, oddsFormat: newUser.oddsFormat } 
        });
    } catch (err) {
        res.status(500).json({ error: "Server error during registration." });
    }
});

// --- LOGIN ROUTE ---
app.post('/api/auth/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        
        const user = await User.findOne({ phone });
        if (!user) return res.status(400).json({ error: "User not found." });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid password." });

        res.status(200).json({ 
            message: "Login successful", 
            user: { phone: user.phone, name: user.name, balance: user.balance, currency: user.currency, oddsFormat: user.oddsFormat } 
        });
    } catch (err) {
        res.status(500).json({ error: "Server error during login." });
    }
});

// --- GET MATCHES (LOCAL DB) ---
app.get('/api/matches', async (req, res) => {
    try {
        const matches = await Match.find();
        res.status(200).json(matches);
    } catch (err) {
        res.status(500).json({ error: "Could not fetch matches." });
    }
});

// --- GET REAL MATCHES (THE ODDS API) ---
const ODDS_API_KEY = process.env.ODDS_API_KEY || '2681c5eb4ab7810ab4809f5a80790ace';

app.get('/api/live-matches', async (req, res) => {
    try {
        // Fetch upcoming English Premier League matches from UK bookmakers
        const response = await fetch(`https://api.the-odds-api.com/v4/sports/soccer_epl/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h`);
        
        if (!response.ok) throw new Error(`Odds API Error: ${response.statusText}`);
        
        const data = await response.json();
        
        // Map the complex API response to the format your app.js expects
        const formattedMatches = data.map((match) => {
            // Find the first available bookmaker to extract 1X2 odds
            const bookmaker = match.bookmakers[0];
            const market = bookmaker ? bookmaker.markets[0] : null;
            
            let oddsArray = [2.10, 3.10, 2.80]; // Fallback odds if missing
            if (market && market.outcomes) {
                const homeOdd = market.outcomes.find(o => o.name === match.home_team)?.price || 2.10;
                const drawOdd = market.outcomes.find(o => o.name === 'Draw')?.price || 3.10;
                const awayOdd = market.outcomes.find(o => o.name === match.away_team)?.price || 2.80;
                oddsArray = [homeOdd, drawOdd, awayOdd];
            }

            const matchDate = new Date(match.commence_time);

            return {
                id: match.id,
                sport: 'football',
                region: 'England',
                league: match.sport_title,
                country: 'gb-eng',
                home: match.home_team,
                away: match.away_team,
                isLive: false, 
                isFeatured: true,
                time: matchDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                date: matchDate.toLocaleDateString(),
                score: null,
                odds: oddsArray,
                marketCount: Math.floor(Math.random() * 150) + 30 
            };
        });

        res.status(200).json(formattedMatches);
    } catch (err) {
        console.error("Odds API Fetch Error:", err.message);
        res.status(500).json({ error: "Could not fetch live matches from Odds API." });
    }
});

// 4. Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));