require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const session    = require('express-session');
const bodyParser = require('body-parser');
const path       = require('path');

const authRoutes = require('./routes/auth');
const attRoutes  = require('./routes/attendance');  // Assuming you have this

const app = express();

// —————————————
// 1) Connect to MongoDB
// —————————————
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// —————————————
// 2) Body parsers
// —————————————
// JSON for WebAuthn payloads, URL-encoded for form submissions
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// —————————————
// 3) Session management
// —————————————
app.use(session({
  secret:            process.env.SESSION_SECRET || 'fallback-secret',
  resave:            false,
  saveUninitialized: false,
  cookie:            {
    secure: false,    // set true if using HTTPS in production
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 2  // 2 hours
  }
}));

// —————————————
// 4) Static files
// —————————————
app.use('/public', express.static(path.join(__dirname, '../public')));

// —————————————
// 5) API routes
// —————————————
app.use('/api/auth', authRoutes);
app.use('/api/att',  attRoutes);

// —————————————
// 6) Root redirect (optional)
// —————————————
app.get('/', (req, res) => {
  res.redirect('/public/login.html');
});

// —————————————
// 7) Error handler
// —————————————
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// —————————————
// 8) Start server
// —————————————
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});
