/**
 * Mint a fresh 48-hour JWT for the stress test user.
 * Usage: node scripts/mintToken.js
 * Output: FRESH_TOKEN=<jwt>
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');

const userId = '6a0dd9700d2c3a23cdba2548';
const role = 'customer';
const secret = process.env.JWT_SECRET;

if (!secret) { console.error('JWT_SECRET missing in .env'); process.exit(1); }

const token = jwt.sign({ userId, role }, secret, { expiresIn: '48h' });
console.log('FRESH_TOKEN=' + token);
