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
    room_type TEXT DEFAULT 'classroom'
  );
  CREATE TABLE IF NOT EXISTS timetables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT NOT NULL,
    year_sem TEXT NOT NULL,
    section TEXT,
    default_room TEXT,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timetable_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    room_number TEXT NOT NULL,
    subject TEXT,
    FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
  );
`);

const insertRoom = db.prepare('INSERT OR IGNORE INTO rooms (room_number, room_type) VALUES (?, ?)');
const insertTimetable = db.prepare('INSERT INTO timetables (department, year_sem, section, default_room, filename, filepath) VALUES (?, ?, ?, ?, ?, ?)');
const insertSchedule = db.prepare('INSERT INTO schedules (timetable_id, day, time_slot, room_number, subject) VALUES (?, ?, ?, ?, ?)');

// ── Upload PDF (single endpoint) ──
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'PDF file is required' });

    console.log('Processing:', req.file.originalname, 'size:', req.file.size);

    let rawText = '';
    try {
      const pdfBuffer = fs.readFileSync(req.file.path);
      const pdfData = await pdfParse(pdfBuffer);
      rawText = pdfData.text || '';
    } catch (pdfErr) {
      console.error('PDF parse error:', pdfErr.message);
      return res.status(400).json({ error: 'Could not read PDF: ' + pdfErr.message });
    }

    const sections = parsePdf(rawText);
    let totalEntries = 0;
    let totalRooms = 0;
    const timetableIds = [];

    db.transaction(() => {
      for (const sec of sections) {
        // Insert rooms
        for (const room of sec.rooms) {
          const r = insertRoom.run(room, /lab/i.test(room) ? 'lab' : 'classroom');
          if (r.changes) totalRooms++;
        }

        // Insert timetable
        const tt = insertTimetable.run(sec.department, sec.year_sem, sec.section, sec.default_room, req.file.originalname, req.file.path);
        const ttId = Number(tt.lastInsertRowid);
        timetableIds.push(ttId);

        // Insert schedule entries
        for (const e of sec.entries) {
          insertSchedule.run(ttId, e.day, e.time_slot, e.room_number, e.subject);
          totalEntries++;
        }
      }
    })();

    console.log(`Parsed: ${sections.length} sections, ${totalEntries} entries, ${totalRooms} new rooms`);

    return res.json({
      message: `Parsed ${sections.length} section(s): ${totalEntries} schedule entries, ${totalRooms} new rooms`,
      sections: sections.map(s => ({ department: s.department, year_sem: s.year_sem, section: s.section, default_room: s.default_room, entries: s.entries.length })),
      total_entries: totalEntries,
      total_rooms: totalRooms
    });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: 'Failed: ' + err.message });
  }
});

app.get('/api/rooms', (req, res) => res.json(db.prepare('SELECT * FROM rooms').all()));
app.delete('/api/rooms/:id', (req, res) => {
  db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

app.get('/api/timetables', (req, res) => {
  res.json(db.prepare('SELECT id, department, year_sem, section, default_room, filename, uploaded_at FROM timetables').all());
});
app.get('/api/timetables/:id/schedule', (req, res) => {
  res.json(db.prepare('SELECT * FROM schedules WHERE timetable_id = ?').all(req.params.id));
});
app.delete('/api/timetables/:id', (req, res) => {
  db.prepare('DELETE FROM schedules WHERE timetable_id = ?').run(req.params.id);
  db.prepare('DELETE FROM timetables WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
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

// ── PDF Parser ──
// Format per section:
//   DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING
//   IV SEMESTER [SECTION-A1]
//   Room No: 322
//   Then day rows: MON, TUE, etc.
//   Each day's subjects come on subsequent lines, one subject or group per line
//   Subjects on the same line separated by spaces = one subject per time slot
//   (R.No.605) on next line = previous subject uses that room instead of default
function parsePdf(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const sections = [];
  const timeSlots = [
    '09:00-09:55', '09:55-10:50', '11:10-12:05',
    '12:05-01:00', '02:15-03:10', '03:10-04:05'
  ];
  const dayMap = { 'MON': 'Monday', 'TUE': 'Tuesday', 'WED': 'Wednesday', 'THU': 'Thursday', 'FRI': 'Friday', 'SAT': 'Saturday' };
  const dayAbbrevs = new Set(Object.keys(dayMap));
  const skipWords = new Set(['B','R','E','A','K','L','U','N','C','H','BREAK','LUNCH','HOUR','TO','AM','PM']);

  let department = '';
  let yearSem = '';
  let section = '';
  let defaultRoom = '';
  let rooms = new Set();
  let entries = [];
  let inSection = false;

  function saveSection() {
    if (inSection && entries.length > 0) {
      sections.push({ department, year_sem: yearSem, section, default_room: defaultRoom, rooms: Array.from(rooms), entries: [...entries] });
    }
    entries = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect department
    const deptMatch = line.match(/DEPARTMENT\s+OF\s+(.+)/i);
    if (deptMatch) {
      saveSection();
      department = deptMatch[1].trim();
      rooms = new Set();
      inSection = false;
      continue;
    }

    // Detect semester/section: "IV SEMESTER [SECTION-A1]"
    const semMatch = line.match(/(\w+)\s+SEMESTER\s*\[SECTION[-\s]*(\w+)\]/i);
    if (semMatch) {
      saveSection();
      yearSem = semMatch[1].trim() + ' Semester';
      section = semMatch[2].trim();
      inSection = true;
      continue;
    }

    // Detect default room
    const roomHeaderMatch = line.match(/Room\s*No[.:]\s*(\d+\w*)/i);
    if (roomHeaderMatch) {
      defaultRoom = roomHeaderMatch[1];
      rooms.add(defaultRoom);
      continue;
    }

    // Skip non-content lines
    if (/^(HOUR|HEAD,|Theory|Laboratory|ACADEMIC|SCHOOL|TIME-TABLE|w\.e\.f)/i.test(line)) continue;
    if (/^\d{2}\.\d{2}\s*(AM|PM)/i.test(line)) continue;
    if (skipWords.has(line.toUpperCase())) continue;

    // Detect day row
    const dayMatch = line.match(/^(MON|TUE|WED|THU|FRI|SAT)\b/i);
    if (!dayMatch || !defaultRoom) continue;

    const day = dayMap[dayMatch[1].toUpperCase()];

    // Collect all content lines for this day until next day or section header
    let dayLines = [];
    const restOfLine = line.substring(dayMatch[0].length).trim();
    if (restOfLine) dayLines.push(restOfLine);

    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      // Stop at next day, section header, or time header
      if (/^(MON|TUE|WED|THU|FRI|SAT)\b/i.test(next)) break;
      if (/DEPARTMENT|SEMESTER|Room\s*No|HOUR|HEAD,|Theory|Laboratory|ACADEMIC|SCHOOL/i.test(next)) break;
      if (/^\d{2}\.\d{2}\s*(AM|PM)/i.test(next)) break;
      if (skipWords.has(next.toUpperCase())) { i++; continue; }
      i++;
      dayLines.push(next);
    }

    // Now parse dayLines into individual subject+room entries
    // Each line is either:
    //   "CP" - single subject (1 slot)
    //   "(R.No.605)" - room override for previous subject
    //   "CN NMPS SE MS" - multiple subjects (1 slot each)
    //   "CP LAB" - two-word subject (1 slot)
    //   "NSS NSS NSS NSS NSS NSS" - repeated subject
    let slotEntries = []; // {subject, room}

    for (const dl of dayLines) {
      // Check if this line is just a room reference
      const pureRoomMatch = dl.match(/^\(R\.No[.:]\s*(\d+\w*)\)$/i);
      if (pureRoomMatch) {
        // Apply room to previous entry
        if (slotEntries.length > 0) {
          slotEntries[slotEntries.length - 1].room = pureRoomMatch[1];
          rooms.add(pureRoomMatch[1]);
        }
        continue;
      }

      // Check if line contains inline room refs like "QAVA (R.No.802)"
      const inlineRoomMatch = dl.match(/^(.+?)\s*\(R\.No[.:]\s*(\d+\w*)\)(.*)$/i);
      if (inlineRoomMatch) {
        const beforeSubjects = inlineRoomMatch[1].trim().split(/\s+/);
        const roomNum = inlineRoomMatch[2];
        const afterSubjects = inlineRoomMatch[3].trim();
        rooms.add(roomNum);

        // Subjects before the room ref
        for (let s = 0; s < beforeSubjects.length - 1; s++) {
          slotEntries.push({ subject: beforeSubjects[s], room: defaultRoom });
        }
        // Last subject before room ref gets that room
        if (beforeSubjects.length > 0) {
          slotEntries.push({ subject: beforeSubjects[beforeSubjects.length - 1], room: roomNum });
        }
        // Subjects after the room ref
        if (afterSubjects) {
          for (const s of afterSubjects.split(/\s+/).filter(Boolean)) {
            slotEntries.push({ subject: s, room: defaultRoom });
          }
        }
        continue;
      }

      // Check for "XX LAB" pattern (two-word subject)
      const labMatch = dl.match(/^(\w+)\s+LAB$/i);
      if (labMatch) {
        slotEntries.push({ subject: dl, room: defaultRoom });
        continue;
      }

      // Plain subjects separated by spaces
      const subjects = dl.split(/\s+/).filter(Boolean);
      for (const s of subjects) {
        slotEntries.push({ subject: s, room: defaultRoom });
      }
    }

    // Map slot entries to time slots
    for (let j = 0; j < slotEntries.length && j < timeSlots.length; j++) {
      entries.push({
        day,
        time_slot: timeSlots[j],
        room_number: slotEntries[j].room,
        subject: slotEntries[j].subject
      });
    }
  }

  // Save last section
  saveSection();
  return sections;
}

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Server error: ' + err.message });
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
