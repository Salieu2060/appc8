import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs-extra';
import Stripe from 'stripe';

const app = express();
const PORT = process.env.PORT || 4000;
const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const DB_FILE = './db.json';
async function loadDB() {
  if (!await fs.pathExists(DB_FILE)) {
    const initial = { staff: [], qr: [], tips: [] };
    await fs.writeJson(DB_FILE, initial, { spaces: 2 });
    return initial;
  }
  return await fs.readJson(DB_FILE);
}
async function saveDB(db) { await fs.writeJson(DB_FILE, db, { spaces: 2 }); }

// Health check
app.get('/api/health', (req,res)=> res.json({ ok: true }));

// Register staff
app.post('/api/staff', async (req, res) => {
  const { name, role } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const db = await loadDB();
  const staff = { id: uuidv4(), name, role: role || "Staff" };
  db.staff.push(staff);
  await saveDB(db);
  res.json(staff);
});

// Generate QR token for a staff/location (e.g., table, room, taxi)
app.post('/api/qr', async (req, res) => {
  const { staffId, pointType, pointLabel } = req.body; // e.g., "Table", "Room", "Taxi"
  if (!staffId) return res.status(400).json({ error: "staffId is required" });
  const db = await loadDB();
  const staff = db.staff.find(s => s.id === staffId);
  if (!staff) return res.status(404).json({ error: "staff not found" });
  const token = uuidv4();
  const record = { token, staffId, pointType: pointType || "Table", pointLabel: pointLabel || "1", createdAt: Date.now() };
  db.qr.push(record);
  await saveDB(db);
  const tipUrl = `${BASE_URL}/t/${token}`;
  res.json({ token, url: tipUrl, record });
});

// Resolve QR token
app.get('/api/qr/:token', async (req, res) => {
  const db = await loadDB();
  const rec = db.qr.find(q => q.token === req.params.token);
  if (!rec) return res.status(404).json({ error: "not found" });
  const staff = db.staff.find(s => s.id === rec.staffId);
  res.json({ token: rec.token, staff, pointType: rec.pointType, pointLabel: rec.pointLabel });
});

// Create Stripe Checkout session
app.post('/api/checkout', async (req, res) => {
  try {
    const { token, amount, note } = req.body;
    if (!token || !amount) return res.status(400).json({ error: "token and amount are required" });

    const db = await loadDB();
    const rec = db.qr.find(q => q.token === token);
    if (!rec) return res.status(404).json({ error: "QR not found" });
    const staff = db.staff.find(s => s.id === rec.staffId);

    // Fallback if Stripe isn't configured: "simulate" success
    if (!stripe) {
      const fakeUrl = `${BASE_URL}/success?token=${token}&amount=${amount}`;
      return res.json({ url: fakeUrl, simulated: true });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: `Tip for ${staff?.name || 'Staff'} (${rec.pointType} ${rec.pointLabel})`,
            description: note ? String(note).slice(0, 100) : undefined
          },
          unit_amount: Math.round(Number(amount) * 100)
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/success?token=${token}&amount=${amount}`,
      cancel_url: `${BASE_URL}/cancel?token=${token}`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Simple "record a tip" endpoint you can call from /success
app.post('/api/record', async (req, res) => {
  const { token, amount } = req.body;
  const db = await loadDB();
  const rec = db.qr.find(q => q.token === token);
  if (!rec) return res.status(404).json({ error: "QR not found" });
  db.tips.push({ id: uuidv4(), token, amount: Number(amount), at: Date.now() });
  await saveDB(db);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`AppC8 backend listening on http://localhost:${PORT}`);
});
