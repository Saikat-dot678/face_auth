const express       = require('express');
const bcrypt        = require('bcrypt');
const multer        = require('multer');
const { Fido2Lib }  = require('fido2-lib');
const path          = require('path');
const fs            = require('fs');
const User          = require('../models/user');
const { spawn }     = require('child_process');

const router = express.Router();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const uploadFaces = multer({ storage }).array('faceImgs', 10);
const uploadFace = multer({ storage }).single('faceImg');

// Initialize FIDO2 library
const f2l = new Fido2Lib({
  timeout: 60000,
  rpId: process.env.RP_ID || 'localhost',
  rpName: process.env.RP_NAME || 'AuthApp',
  challengeSize: 64,
  authenticatorRequireResidentKey: false,
  authenticatorUserVerification: 'preferred'
});

// Determine Python command
const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

// --- Registration Route ---
router.post('/register', uploadFaces, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).send('Email and password are required');
  if (!req.files || req.files.length !== 10) return res.status(400).send('Exactly 10 face images are required');

  try {
    // Prevent duplicate email
    if (await User.findOne({ email })) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Save user with hashed password
    const hash = await bcrypt.hash(password, 10);
    const user = new User({ email, passwordHash: hash, faceEmbedding: [] });
    await user.save();

    // Ensure embeddings directory exists
    const embeddingsDir = path.join(__dirname, '../embeddings');
    if (!fs.existsSync(embeddingsDir)) fs.mkdirSync(embeddingsDir, { recursive: true });

    // Prepare Python arguments
    const facePaths = req.files.map(f => path.resolve(f.path));
    const scriptPath = path.join(__dirname, 'face_recognition.py');

    // Spawn Python to register embeddings
    const py = spawn(pythonCmd, [scriptPath, 'register', user._id.toString(), ...facePaths], {
      cwd: path.join(__dirname, '..')
    });

    let stdout = '', stderr = '';
    py.stdout.on('data', data => stdout += data.toString());
    py.stderr.on('data', data => stderr += data.toString());

    py.on('error', err => {
      console.error('Python spawn error:', err);
      return res.status(500).json({ error: 'Face processing unavailable' });
    });

    py.on('close', async code => {
      console.log('Python exit code:', code);
      if (code !== 0) {
        console.error('Face registration failed:', stderr || stdout);
        return res.status(500).json({ error: 'Face processing failed', details: stderr || stdout });
      }

      // Save embedding path to user
      try {
        const embedPath = `embeddings/${user._id}.npy`;
        user.faceEmbedding.push(embedPath);
        await user.save();
        console.log('Embedding saved, proceeding to WebAuthn');

        // Generate WebAuthn attestation options
        const opts = await f2l.attestationOptions({
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            requireResidentKey: false
          }
        });
        req.session.challenge = opts.challenge;
        req.session.tmpUserId = user._id;
        return res.json(opts);
      } catch (saveErr) {
        console.error('Error saving embedding path:', saveErr);
        return res.status(500).json({ error: 'Internal server error' });
      }
    });

  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).send('Registration failed');
  }
});

// --- Complete WebAuthn Registration ---
router.post('/register/complete', async (req, res) => {
  try {
    const attRes = req.body;
    const expected = { challenge: req.session.challenge };
    const reg = await f2l.attestationResult(attRes, expected);
    const user = await User.findById(req.session.tmpUserId);

    user.fidoCredentials.push({
      credentialID: reg.authnrData.get('credId'),
      publicKey: reg.authnrData.get('credentialPublicKeyPem'),
      counter: reg.authnrData.get('counter')
    });
    await user.save();

    return res.send('Fingerprint registered');
  } catch (err) {
    console.error('WebAuthn registration failed:', err);
    return res.status(400).send('WebAuthn registration failed');
  }
});

// --- Login Route ---
router.post('/login', uploadFace, async (req, res) => {
  const { email, useFingerprint } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).send('User not found');

    if (useFingerprint === 'true') {
      const opts = await f2l.assertionOptions({
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required'
        }
      });
      req.session.challenge = opts.challenge;
      req.session.userId = user._id;
      return res.json(opts);
    }

    if (!req.file) return res.status(400).send('Face image required');

    const scriptPath = path.join(__dirname, 'face_recognition.py');
    const py = spawn(pythonCmd, [scriptPath, 'verify', user._id.toString(), req.file.path], {
      cwd: path.join(__dirname, '..')
    });
    let out = '', errOut = '';
    py.stdout.on('data', d => out += d.toString());
    py.stderr.on('data', e => errOut += e.toString());

    py.on('error', e => {
      console.error('Face script start error:', e);
      return res.status(500).send('Face verification unavailable');
    });

    py.on('close', async code => {
      if (code !== 0) return res.status(500).send('Face verification error');
      try {
        const { match } = JSON.parse(out);
        if (!match) return res.status(401).send('Face mismatch');
        req.session.userId = user._id;
        return res.json({ success: true });
      } catch (parseErr) {
        console.error('Parse error:', parseErr);
        return res.status(500).send('Face verification failed');
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).send('Login failed');
  }
});

// --- Complete WebAuthn Login ---
router.post('/login/complete', async (req, res) => {
  try {
    const assertion = req.body;
    const expected = {
      challenge: req.session.challenge,
      origin: process.env.ORIGIN || `http://localhost:${process.env.PORT || 3000}`,
      factor: 'either'
    };
    await f2l.assertionResult(assertion, expected);
    return res.json({ success: true });
  } catch (err) {
    console.error('WebAuthn login failed:', err);
    return res.status(400).send('WebAuthn login failed');
  }
});

module.exports = router;
