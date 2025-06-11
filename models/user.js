// models/user.js

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  // change this line:
  faceEmbedding: { type: [String], default: [] },

  fidoCredentials: [
    {
      credentialID: Buffer,
      publicKey: Buffer,
      counter: Number
    }
  ],

  attendance: [
    {
      time: Date,
      lat: Number,
      long: Number
    }
  ],

  // ... any other fields ...
});

module.exports = mongoose.model('User', userSchema);
