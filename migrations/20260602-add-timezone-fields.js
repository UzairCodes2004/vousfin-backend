/**
 * Migration script to add 'timezone' field to existing Business and JournalEntries.
 * This is a safe, additive migration. It does not overwrite any existing data.
 * Run via mongo shell or within a node script.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/vousfin';

async function migrate() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.');

  const db = mongoose.connection.db;
  const businesses = db.collection('businesses');
  const journalEntries = db.collection('journalentries');

  console.log('Starting migration for timezone fields...');

  const businessResult = await businesses.updateMany(
    { timezone: { $exists: false } },
    { $set: { timezone: 'UTC' } }
  );
  console.log(`Migration completed for businesses. Modified ${businessResult.modifiedCount} documents.`);

  const journalResult = await journalEntries.updateMany(
    { timezone: { $exists: false } },
    { $set: { timezone: 'UTC' } }
  );
  console.log(`Migration completed for journal entries. Modified ${journalResult.modifiedCount} documents.`);

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB.');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
