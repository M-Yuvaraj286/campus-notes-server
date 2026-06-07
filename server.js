require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (origin === 'http://localhost:3000' || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({
    status: 'Campus Notes API is running',
    docs: 'Use /api/notes or /api/subjects'
  });
});

// Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  timeout: 120000
});

// Neon DB Connection - FIXED: Safe replace
let connectionString = process.env.DATABASE_URL;
if (connectionString && connectionString.includes('?sslmode=require&channel_binding=require')) {
  connectionString = connectionString.replace('?sslmode=require&channel_binding=require', '');
}

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test DB Connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Database connection error:', err.stack);
    process.exit(1); // Crash clearly if DB fails
  }
  console.log('Database connected at:', new Date().toISOString());
  release();
});

// Multer - FIXED: 100MB limit
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files allowed'), false);
    }
  }
});

// ==================== ROUTES ====================

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

// 2. GET APPROVED NOTES
app.get('/api/notes', async (req, res) => {
  try {
    const { subject_id, search } = req.query;
    let query = `
      SELECT n.id, n.title, n.description, n.file_url, n.created_at, n.file_size, n.upvotes,
             s.name as subject_name, s.semester, u.name as uploader_name
      FROM notes n
      JOIN subjects s ON n.subject_id = s.id
      JOIN users u ON n.user_id = u.id
      WHERE n.status = 'approved'
    `;
    const params = [];
    let paramCount = 1;

    if (subject_id) {
      query += ` AND n.subject_id = $${paramCount}`;
      params.push(subject_id);
      paramCount++;
    }

    if (search) {
      query += ` AND (LOWER(n.title) LIKE LOWER($${paramCount}) OR LOWER(n.description) LIKE LOWER($${paramCount}))`;
      params.push(`%${search}%`);
      paramCount++;
    }

    query += ' ORDER BY n.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// 3. UPLOAD NOTE - FIXED: Timeout + 100MB
app.post('/api/notes', upload.single('file'), async (req, res) => {
  req.setTimeout(120000);
  res.setTimeout(120000);

  try {
    const { title, description, subject_id, uploader_name, uploader_email } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    console.log(`Upload started: ${title} - ${(req.file.size / 1024).toFixed(2)}MB`);

    const cleanTitle = title.replace(/[^a-z0-9]/gi, '_').replace(/_{2,}/g, '_').substring(0, 40);

    const cloudinaryRes = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'campus-notes',
          resource_type: 'raw',
          public_id: `${Date.now()}_${cleanTitle}`,
          type: 'upload',
          access_mode: 'public'
        },
        (error, result) => {
          if (error) {
            console.error('Cloudinary Stream Error:', error);
            reject(error);
          } else {
            console.log('Cloudinary Success:', result.secure_url);
            resolve(result);
          }
        }
      );
      uploadStream.end(req.file.buffer);
    });

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

    await pool.query(
      `INSERT INTO notes (user_id, subject_id, title, description, file_url, file_size, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [userId, subject_id, title, description, cloudinaryRes.secure_url, req.file.size]
    );

    res.json({ success: true, message: 'Uploaded! Waiting for admin approval' });

  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// 4. ADMIN - GET ALL NOTES
app.get('/api/admin/notes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT n.*, s.name as subject_name, s.semester, n.upvotes, u.name as uploader_name, u.email as uploader_email
      FROM notes n
      JOIN subjects s ON n.subject_id = s.id
      JOIN users u ON n.user_id = u.id
      ORDER BY n.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// 5. ADMIN - APPROVE NOTE
app.put('/api/admin/notes/:id/approve', async (req, res) => {
  try {
    await pool.query("UPDATE notes SET status = 'approved' WHERE id = $1", [req.params.id]);
    res.json({ success: true, message: 'Note approved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Approval failed' });
  }
});

// 6. ADMIN - REJECT NOTE
app.put('/api/admin/notes/:id/reject', async (req, res) => {
  try {
    await pool.query("UPDATE notes SET status = 'rejected' WHERE id = $1", [req.params.id]);
    res.json({ success: true, message: 'Note rejected' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Rejection failed' });
  }
});

// 7. ADMIN - DELETE NOTE
app.delete('/api/admin/notes/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM notes WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Note deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// 8. ADD SUBJECT
app.post('/api/admin/subjects', async (req, res) => {
  try {
    const { name, semester } = req.body;
    await pool.query('INSERT INTO subjects (name, semester) VALUES ($1, $2)', [name, semester]);
    res.json({ success: true, message: 'Subject added' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add subject' });
  }
});

// 9. DELETE SUBJECT
app.delete('/api/admin/subjects/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM subjects WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Subject deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete failed. Subject may have notes.' });
  }
});

// 10. DOWNLOAD ROUTE
app.get('/api/download/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT title, file_url FROM notes WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).send('Note not found');

    const { title, file_url } = result.rows[0];
    const cleanTitle = title.replace(/[^a-z0-9]/gi, '_').substring(0, 50) + '.pdf';

    https.get(file_url, (cloudinaryRes) => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${cleanTitle}"`);
      cloudinaryRes.pipe(res);
    }).on('error', () => {
      res.status(500).send('Download failed');
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('Download failed');
  }
});

// 11. UPVOTE NOTE
app.put('/api/notes/:id/upvote', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'UPDATE notes SET upvotes = COALESCE(upvotes, 0) + 1 WHERE id = $1',
      [id]
    );
    const result = await pool.query('SELECT upvotes FROM notes WHERE id = $1', [id]);
    res.json({ success: true, upvotes: result.rows[0].upvotes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upvote failed' });
  }
});

// Error handling middleware for Multer
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 100MB.' });
    }
  }
  res.status(500).json({ error: error.message });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CORS enabled for: localhost:3000 and *.vercel.app`);
  console.log(`Max upload size: 100MB`);
});