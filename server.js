const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const morgan   = require('morgan');
require('dotenv').config();

const app         = express();
const PORT        = process.env.PORT        || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/callmonitor";
const API_KEY     = process.env.API_KEY     || "change-this-key";

// ─── Middleware ───────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(morgan('combined'));

const authenticate = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (API_KEY && key !== API_KEY)
    return res.status(401).json({ error: 'Unauthorized — invalid API key' });
  next();
};

// ─── Schema ───────────────────────────────────────────
const callLogSchema = new mongoose.Schema({
  phoneNumber:  { type: String, required: true, trim: true },
  callType:     { type: String, enum: ['INCOMING', 'OUTGOING', 'MISSED'], required: true },
  duration:     { type: Number, default: 0 },
  timestamp:    { type: Date,   required: true },
  deviceId:     { type: String, required: true },
  employeeName: { type: String, default: 'Unknown' },
  syncedAt:     { type: Date,   default: Date.now }
}, { timestamps: true });

callLogSchema.index({ deviceId: 1, timestamp: -1 });
callLogSchema.index({ employeeName: 1 });
callLogSchema.index({ timestamp: -1 });
callLogSchema.index({ phoneNumber: 1 });

const CallLog = mongoose.model('CallLog', callLogSchema);

// ─── MongoDB Connection ───────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected:', MONGODB_URI))
  .catch(err => { console.error('❌ MongoDB connection failed:', err.message); process.exit(1); });

// ─── Routes ───────────────────────────────────────────

// Health check — no auth required
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Submit a single call log
app.post('/api/calls', authenticate, async (req, res) => {
  try {
    const { phoneNumber, callType, duration, timestamp, deviceId, employeeName } = req.body;
    if (!phoneNumber || !callType || !deviceId)
      return res.status(400).json({ error: 'Missing required fields: phoneNumber, callType, deviceId' });

    const callLog = new CallLog({
      phoneNumber,
      callType:     callType.toUpperCase(),
      duration:     duration || 0,
      timestamp:    new Date(timestamp || Date.now()),
      deviceId,
      employeeName: employeeName || 'Unknown'
    });

    await callLog.save();
    console.log(`📞 ${callType} | ${employeeName} | ${phoneNumber} | ${duration}s`);
    res.status(201).json({ success: true, message: 'Call log saved', id: callLog._id });
  } catch (err) {
    console.error('Error saving call:', err.message);
    res.status(500).json({ error: 'Failed to save call log' });
  }
});

// Batch submit call logs (for offline sync)
app.post('/api/calls/batch', authenticate, async (req, res) => {
  try {
    const { calls } = req.body;
    if (!Array.isArray(calls) || calls.length === 0)
      return res.status(400).json({ error: 'calls must be a non-empty array' });

    const docs = calls.map(c => ({
      phoneNumber:  c.phoneNumber,
      callType:     c.callType.toUpperCase(),
      duration:     c.duration || 0,
      timestamp:    new Date(c.timestamp || Date.now()),
      deviceId:     c.deviceId,
      employeeName: c.employeeName || 'Unknown'
    }));

    const result = await CallLog.insertMany(docs, { ordered: false });
    res.status(201).json({ success: true, savedCount: result.length });
  } catch (err) {
    console.error('Batch insert error:', err.message);
    res.status(500).json({ error: 'Failed to save call logs' });
  }
});

// Get call logs with filtering and pagination
app.get('/api/calls', authenticate, async (req, res) => {
  try {
    const {
      deviceId, employeeName, callType,
      from, to, phone,
      page  = 1,
      limit = 50
    } = req.query;

    const filter = {};
    if (deviceId)     filter.deviceId = deviceId;
    if (employeeName) filter.employeeName = new RegExp(employeeName, 'i');
    if (callType)     filter.callType = callType.toUpperCase();
    if (phone)        filter.phoneNumber = new RegExp(phone);
    if (from || to) {
      filter.timestamp = {};
      if (from) filter.timestamp.$gte = new Date(from);
      if (to)   filter.timestamp.$lte = new Date(to);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [total, calls] = await Promise.all([
      CallLog.countDocuments(filter),
      CallLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(parseInt(limit))
    ]);

    res.json({
      calls,
      pagination: {
        total,
        page:  parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('Error fetching calls:', err.message);
    res.status(500).json({ error: 'Failed to fetch call logs' });
  }
});

// Statistics endpoint
app.get('/api/stats', authenticate, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [total, todayCount, byType, byEmployee, avgDur] = await Promise.all([
      CallLog.countDocuments(),
      CallLog.countDocuments({ timestamp: { $gte: today } }),
      CallLog.aggregate([{ $group: { _id: '$callType', count: { $sum: 1 } } }]),
      CallLog.aggregate([
        { $group: { _id: '$employeeName', count: { $sum: 1 }, totalDuration: { $sum: '$duration' } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      CallLog.aggregate([
        { $match: { callType: { $in: ['INCOMING', 'OUTGOING'] } } },
        { $group: { _id: null, avg: { $avg: '$duration' } } }
      ])
    ]);

    const typeMap = byType.reduce((acc, t) => { acc[t._id] = t.count; return acc; }, {});

    res.json({
      totalCalls:      total,
      todayCalls:      todayCount,
      byType:          typeMap,
      topEmployees:    byEmployee,
      avgCallDuration: Math.round(avgDur[0]?.avg || 0)
    });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Employee list
app.get('/api/employees', authenticate, async (req, res) => {
  try {
    const list = await CallLog.aggregate([
      { $group: {
          _id: { employeeName: '$employeeName', deviceId: '$deviceId' },
          callCount: { $sum: 1 },
          lastCall:  { $max: '$timestamp' }
      }},
      { $sort: { lastCall: -1 } }
    ]);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// ─── Export for Vercel ─────────────────────────────────────
module.exports = app;
