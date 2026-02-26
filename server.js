const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static('public'));
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// ── Database ──
const db = new Database('scheduler.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_number TEXT UNIQUE NOT NULL,
    building TEXT,
    capacity INTEGER,
    room_type TEXT DEFAULT 'classroom'
  );
  CREATE TABLE IF NOT EXISTS timetables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT NOT NULL,
    year TEXT NOT NULL,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    raw_text TEXT,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timetable_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    room_number TEXT NOT NULL,
    subject TEXT,
    faculty TEXT,
    FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS room_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    raw_text TEXT,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const insertRoom = db.prepare('INSERT OR IGNORE INTO rooms (room_number, building, capacity, room_type) VALUES (?, ?, ?, ?)');
const insertTimetable = db.prepare('INSERT INTO timetables (department, year, filename, filepath, raw_text) VALUES (?, ?, ?, ?, ?)');
const insertSchedule = db.prepare('INSERT INTO schedules (timetable_id, day, time_slot, room_number, subject, faculty) VALUES (?, ?, ?, ?, ?, ?)');

// ── Upload Rooms PDF ──
app.post('/api/rooms/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'PDF file is required' });

    let rawText = '';
    try {
      const pdfBuffer = fs.readFileSync(req.file.path);
      const pdfData = await pdfParse(pdfBuffer);
      rawText = pdfData.text || '';
    } catch (pdfErr) {
      console.error('PDF parse error:', pdfErr.message);
      return res.status(400).json({ error: 'Could not read PDF: ' + pdfErr.message });
    }

    db.prepare('INSERT INTO room_uploads (filename, filepath, raw_text) VALUES (?, ?, ?)')
      .run(req.file.originalname, req.file.path, rawText);

    const rooms = parseRoomsPdf(rawText);
    let count = 0;
    db.transaction(() => {
      for (const r of rooms) {
        const result = insertRoom.run(r.room_number, r.building, r.capacity, r.room_type);
        if (result.changes) count++;
      }
    })();

    res.json({ message: `${count} rooms extracted and saved`, total_found: rooms.length, raw_text: rawText, rooms });
  } catch (err) {
    console.error('Rooms upload error:', err);
    res.status(500).json({ error: 'Failed to process rooms PDF: ' + err.message });
  }
});

app.get('/api/rooms', (req, res) => res.json(db.prepare('SELECT * FROM rooms').all()));
app.delete('/api/rooms/:id', (req, res) => {
  db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── Upload Timetable PDF ──
app.post('/api/timetables', upload.single('pdf'), async (req, res) => {
  try {
    const { department, year } = req.body;
    if (!department || !year || !req.file)
      return res.status(400).json({ error: 'department, year, and pdf are required' });

    console.log('Processing file:', req.file.originalname, 'size:', req.file.size);

    let rawText = '';
    try {
      const pdfBuffer = fs.readFileSync(req.file.path);
      const pdfData = await pdfParse(pdfBuffer);
      rawText = pdfData.text || '';
      console.log('PDF parsed, text length:', rawText.length);
    } catch (pdfErr) {
      console.error('PDF parse error:', pdfErr.message);
      rawText = '[PDF could not be fully parsed: ' + pdfErr.message + ']';
    }

    const result = insertTimetable.run(department, year, req.file.originalname, req.file.path, rawText);
    const timetableId = result.lastInsertRowid;

    // Auto-extract rooms from timetable PDF
    const rooms = parseRoomsPdf(rawText);
    let roomCount = 0;
    db.transaction(() => {
      for (const r of rooms) {
        const res = insertRoom.run(r.room_number, r.building, r.capacity, r.room_type);
        if (res.changes) roomCount++;
      }
    })();
    console.log(`Auto-extracted ${roomCount} new rooms from timetable`);

    const entries = parseTimetableText(rawText);
    db.transaction(() => {
      for (const e of entries) {
        insertSchedule.run(timetableId, e.day, e.time_slot, e.room_number, e.subject || null, e.faculty || null);
      }
    })();

    return res.json({ message: `Timetable uploaded. ${entries.length} schedule entries, ${roomCount} new rooms extracted.`, timetable_id: Number(timetableId), entries_found: entries.length, rooms_added: roomCount, raw_text: rawText });
  } catch (err) {
    console.error('Timetable upload error:', err);
    return res.status(500).json({ error: 'Failed: ' + err.message });
  }
});

app.get('/api/timetables', (req, res) => {
  res.json(db.prepare('SELECT id, department, year, filename, uploaded_at FROM timetables').all());
});
app.get('/api/timetables/:id/schedule', (req, res) => {
  res.json(db.prepare('SELECT * FROM schedules WHERE timetable_id = ?').all(req.params.id));
});
app.delete('/api/timetables/:id', (req, res) => {
  const tt = db.prepare('SELECT filepath FROM timetables WHERE id = ?').get(req.params.id);
  if (tt && fs.existsSync(tt.filepath)) fs.unlinkSync(tt.filepath);
  db.prepare('DELETE FROM schedules WHERE timetable_id = ?').run(req.params.id);
  db.prepare('DELETE FROM timetables WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── Manually add schedule entry ──
app.post('/api/schedules', (req, res) => {
  const { timetable_id, day, time_slot, room_number, subject, faculty } = req.body;
  if (!timetable_id || !day || !time_slot || !room_number)
    return res.status(400).json({ error: 'timetable_id, day, time_slot, room_number required' });
  insertSchedule.run(timetable_id, day, time_slot, room_number, subject || null, faculty || null);
  res.json({ message: 'Entry added' });
});

// ── Free Rooms ──
app.get('/api/free-rooms', (req, res) => {
  const { day, time_slot } = req.query;
  if (!day || !time_slot) return res.status(400).json({ error: 'day and time_slot required' });
  const allRooms = db.prepare('SELECT * FROM rooms').all();
  const occupied = db.prepare(
    'SELECT DISTINCT room_number FROM schedules WHERE LOWER(day) = LOWER(?) AND time_slot = ?'
  ).all(day, time_slot).map(r => r.room_number);
  const freeRooms = allRooms.filter(r => !occupied.includes(r.room_number));
  res.json({ day, time_slot, free_rooms: freeRooms, occupied_rooms: occupied });
});

app.get('/api/slots', (req, res) => {
  const days = db.prepare('SELECT DISTINCT day FROM schedules ORDER BY day').all().map(r => r.day);
  const timeSlots = db.prepare('SELECT DISTINCT time_slot FROM schedules ORDER BY time_slot').all().map(r => r.time_slot);
  res.json({ days, time_slots: timeSlots });
});

// ── Rooms PDF Parser ──
// Extracts "Room No: XXX" patterns from timetable-style PDFs
function parseRoomsPdf(text) {
  const rooms = new Map();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Match patterns like "Room No: 322", "Room No. 328", "R.No.605", "R.No: 710"
    const matches = line.matchAll(/(?:Room\s*No[.:]\s*|R\.No[.:]\s*)(\d+\w*)/gi);
    for (const m of matches) {
      const roomNum = m[1];
      if (!rooms.has(roomNum)) {
        rooms.set(roomNum, { room_number: roomNum, building: null, capacity: null, room_type: 'classroom' });
      }
    }

    // Mark lab rooms
    if (/lab/i.test(line)) {
      const labRoomMatch = line.match(/R\.No[.:]\s*(\d+\w*)/i);
      if (labRoomMatch && rooms.has(labRoomMatch[1])) {
        rooms.get(labRoomMatch[1]).room_type = 'lab';
      }
    }
  }

  return Array.from(rooms.values());
}


// ── Timetable Text Parser ──
// Parses your college timetable format:
//   Section header: "Room No: 322"
//   Time slots as columns, days as rows (MON, TUE, etc.)
//   Subjects in different rooms shown as "(R.No.605)"
function parseTimetableText(text) {
  const entries = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Define the fixed time slots from the PDF structure
  const timeSlots = [
    '09:00-09:55', '09:55-10:50', '11:10-12:05',
    '12:05-01:00', '02:15-03:10', '03:10-04:05'
  ];

  const dayMap = { 'MON': 'Monday', 'TUE': 'Tuesday', 'WED': 'Wednesday', 'THU': 'Thursday', 'FRI': 'Friday', 'SAT': 'Saturday', 'SUN': 'Sunday' };
  const dayAbbrevs = Object.keys(dayMap);

  let defaultRoom = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect default room: "Room No: 322" or "Room No. 322"
    const roomHeaderMatch = line.match(/Room\s*No[.:]\s*(\d+\w*)/i);
    if (roomHeaderMatch) {
      defaultRoom = roomHeaderMatch[1];
      continue;
    }

    // Detect day rows: line starts with MON, TUE, etc.
    const dayMatch = line.match(/^(MON|TUE|WED|THU|FRI|SAT|SUN)\b/i);
    if (!dayMatch || !defaultRoom) continue;

    const day = dayMap[dayMatch[1].toUpperCase()];
    // Get the rest of the line after the day abbreviation
    const rest = line.substring(dayMatch[0].length).trim();

    // Split the rest into subject cells
    // Subjects are separated by whitespace, but some have (R.No.XXX) attached
    const cells = rest.split(/\s{2,}/).map(c => c.trim()).filter(Boolean);

    for (let j = 0; j < cells.length && j < timeSlots.length; j++) {
      const cell = cells[j];
      if (!cell || cell === 'B' || cell === 'R' || cell === 'E' || cell === 'A' || cell === 'K' ||
          cell === 'L' || cell === 'U' || cell === 'N' || cell === 'C' || cell === 'H' ||
          cell === 'BREAK' || cell === 'LUNCH') continue;

      // Check if this cell has a different room: "(R.No.605)"
      const altRoomMatch = cell.match(/\(R\.No[.:]\s*(\d+\w*)\)/i);
      const room = altRoomMatch ? altRoomMatch[1] : defaultRoom;
      const subject = cell.replace(/\(R\.No[.:]\s*\d+\w*\)/i, '').trim();

      if (subject && subject.length > 0) {
        entries.push({
          day,
          time_slot: timeSlots[j],
          room_number: room,
          subject,
          faculty: null
        });
      }
    }
  }

  return entries;
}

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Server error: ' + err.message });
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
