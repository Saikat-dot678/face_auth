const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const { Fido2Lib } = require('fido2-lib');
const User         = require('../models/user');
const { getDistance } = require('../utils/haversine');
const { spawn }    = require('child_process');

// Pre-parse environment variables
const ATTENDANCE_LAT = parseFloat(process.env.ATTENDANCE_LAT);
const ATTENDANCE_LONG = parseFloat(process.env.ATTENDANCE_LONG);
const GEOFENCE_RADIUS_M = parseFloat(process.env.GEOFENCE_RADIUS_M) || 100;

// Ensure uploads directory exists for face images
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer storage config for face image captures
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${req.session.userId || 'anon'}_${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage }).single('faceImg');

// Initialize FIDO2 library
const f2l = new Fido2Lib({
  timeout: 60000,
  rpId: process.env.RP_ID || 'localhost',
  rpName: process.env.RP_NAME || 'AuthApp',
  challengeSize: 64,
  authenticatorRequireResidentKey: false,
  authenticatorUserVerification: 'preferred'
});

const router = express.Router();

// --- Mark Attendance ---
router.post('/mark', upload, async (req, res, next) => {
  try {
    const uid = req.session.userId;
    if (!uid) return res.status(401).send('Not logged in');

    const { lat, long, useFingerprint } = req.body;
    if (!lat || !long) return res.status(400).send('GPS required');

    // Geofence check
    const dist = getDistance(
      parseFloat(lat), parseFloat(long),
      ATTENDANCE_LAT, ATTENDANCE_LONG
    );
    if (dist > GEOFENCE_RADIUS_M) {
      return res
        .status(403)
        .send(`You are ${Math.round(dist)}m away; must be ≤ ${GEOFENCE_RADIUS_M}m`);
    }

    // Fingerprint path
    if (useFingerprint === 'true') {
      const opts = await f2l.assertionOptions({
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required'
        }
      });
      req.session.challenge = opts.challenge;
      req.session.pendingLoc = { lat: parseFloat(lat), long: parseFloat(long) };
      return res.json(opts);
    }

    // Face path
    if (!req.file) return res.status(400).send('Face image required');

    // Spawn Python face verification
    const scriptPath = path.join(__dirname, 'face_recognition.py');
    const py = spawn('python3', [scriptPath, 'verify', uid.toString(), req.file.path]);

    let out = '';
    let errOut = '';
    py.stdout.on('data', d => out += d.toString());
    py.stderr.on('data', e => errOut += e.toString());

    py.on('close', async code => {
      if (code !== 0) {
        console.error('Face script error:', errOut);
        return res.status(500).send('Face verification error');
      }
      try {
        const { match } = JSON.parse(out);
        if (!match) return res.status(401).send('Face mismatch');

        await User.findByIdAndUpdate(uid, {
          $push: { attendance: { time: new Date(), lat: parseFloat(lat), long: parseFloat(long) } }
        });
        res.send(`Attendance marked via face at ${new Date().toISOString()}`);
      } catch (parseErr) {
        console.error('Error parsing face script output:', parseErr);
        res.status(500).send('Face verification failed');
      }
    });

  } catch (err) {
    next(err);
  }
});

// --- Complete WebAuthn attendance ---
router.post('/mark/complete', async (req, res, next) => {
  try {
    const assertion = req.body;
    const expected = {
      challenge: req.session.challenge,
      origin: process.env.ORIGIN || 'http://localhost:3000',
      factor: 'either'
    };

    await f2l.assertionResult(assertion, expected);

    const { lat, long } = req.session.pendingLoc || {};
    if (lat == null || long == null) {
      return res.status(400).send('Location not found');
    }

    await User.findByIdAndUpdate(req.session.userId, {
      $push: { attendance: { time: new Date(), lat, long } }
    });
    res.send(`Attendance marked via fingerprint at ${new Date().toISOString()}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
