const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

// Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'? { rejectUnauthorized: false } : false
});

// Multer setup for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Test DB connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected at:', res.rows[0].now);
  }
});

// 1. GET ALL SUBJECTS
app.get('/api/subjects', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM subjects ORDER BY semester, name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch subjects' });
  }
});

// 2. GET ALL APPROVED NOTES
app.get('/api/notes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT n.*, s.name as subject_name, s.semester, u.name as uploader_name
      FROM notes n
      LEFT JOIN subjects s ON n.subject_id = s.id
      LEFT JOIN users u ON n.user_id = u.id
      WHERE n.status = 'approved'
      ORDER BY n.upvotes DESC, n.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// 3. UPLOAD NOTE - Student uploads PDF
app.post('/api/notes', upload.single('file'), async (req, res) => {
  try {
    const { title, description, subject_id, uploader_name, uploader_email } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    // Upload to Cloudinary
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const dataURI = 'data:' + req.file.mimetype + ';base64,' + b64;

    const cleanTitle = title.replace(/[^a-z0-9]/gi, '_').substring(0, 50);

    const cloudinaryRes = await cloudinary.uploader.upload(dataURI, {
      folder: 'campus-notes',
      resource_type: 'raw',
      type: 'upload', // Makes file PUBLIC
      access_mode: 'public', // Allows browser access
      use_filename: true,
      filename_override: cleanTitle,
      unique_filename: false
    });

    // Check if user exists, else create
    let userResult = await pool.query('SELECT id FROM users WHERE email = $1', [uploader_email]);
    let userId;

    if (userResult.rows.length === 0) {
      const newUser = await pool.query(
        'INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING id',
        [uploader_name, uploader_email, 'student']
      );
      userId = newUser.rows[0].id;
    } else {
      userId = userResult.rows[0].id;
    }

    // Insert note into DB
    await pool.query(
      `INSERT INTO notes (user_id, subject_id, title, description, file_url, file_size, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [userId, subject_id, title, description, cloudinaryRes.secure_url, Math.round(req.file.size / 1024)]
    );

    res.json({
      success: true,
      message: 'Uploaded! Waiting for admin approval',
      file_url: cloudinaryRes.secure_url
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// 4. UPVOTE NOTE
app.post('/api/notes/:id/upvote', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE notes SET upvotes = upvotes + 1 WHERE id = $1', [id]);
    res.json({ success: true, message: 'Upvoted!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upvote failed' });
  }
});

// 5. ADMIN - GET ALL NOTES
app.get('/api/admin/notes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT n.*, s.name as subject_name, s.semester, u.name as uploader_name, u.email as uploader_email
      FROM notes n
      LEFT JOIN subjects s ON n.subject_id = s.id
      LEFT JOIN users u ON n.user_id = u.id
      ORDER BY n.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// 6. ADMIN - APPROVE NOTE
app.put('/api/admin/notes/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE notes SET status = $1 WHERE id = $2', ['approved', id]);
    res.json({ success: true, message: 'Note approved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Approval failed' });
  }
});

// 7. ADMIN - REJECT NOTE
app.put('/api/admin/notes/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE notes SET status = $1 WHERE id = $2', ['rejected', id]);
    res.json({ success: true, message: 'Note rejected' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Rejection failed' });
  }
});

// 8. ADMIN - DELETE NOTE
app.delete('/api/admin/notes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM notes WHERE id = $1', [id]);
    res.json({ success: true, message: 'Note deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});