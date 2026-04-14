// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json());
app.use(cors()); // Allows frontend to talk to backend

// 1. Connect to MongoDB (Replace with your Atlas URI if going live)
const MONGO_URI = 'mongodb://127.0.0.1:27017/sportywins';
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

// --- GET MATCHES ROUTE ---
app.get('/api/matches', async (req, res) => {
    try {
        const matches = await Match.find();
        res.status(200).json(matches);
    } catch (err) {
        res.status(500).json({ error: "Could not fetch matches." });
    }
});

// 4. Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));