/**
 * Converts mongodb+srv:// URI to direct multi-host URI.
 * Needed because TXT record lookups time out on this network, but SRV lookups work.
 * Usage: node scripts/fixMongoUri.js
 */
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../.env');
let envContent = fs.readFileSync(envPath, 'utf8');

// Extract the SRV URI
const srvMatch = envContent.match(/MONGO_URI=mongodb\+srv:\/\/([^:]+):([^@]+)@([^/?]+)(.*)/);
if (!srvMatch) {
  console.log('MONGO_URI is not an SRV URI or already converted. No change made.');
  process.exit(0);
}

const [, user, pass, cluster, rest] = srvMatch;

// Extract just the DB name from rest (path component before ?)
const dbMatch = rest.match(/^\/([^?]*)/);
const db = dbMatch ? dbMatch[1] : 'vousfin';

// Known shard hosts from Atlas cluster0.baevhfh.mongodb.net
const shards = [
  'ac-faaqydq-shard-00-00.baevhfh.mongodb.net:27017',
  'ac-faaqydq-shard-00-01.baevhfh.mongodb.net:27017',
  'ac-faaqydq-shard-00-02.baevhfh.mongodb.net:27017',
];

const directUri = `mongodb://${user}:${pass}@${shards.join(',')}/${db}?replicaSet=atlas-mkm8sg-shard-0&authSource=admin&tls=true&retryWrites=true&w=majority`;

// Replace the line in .env
const newEnv = envContent.replace(
  /^MONGO_URI=.*/m,
  `MONGO_URI=${directUri}`
);

fs.writeFileSync(envPath, newEnv, 'utf8');
console.log('MONGO_URI updated to direct URI (3 shards). Restart the server.');
