const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

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

// ── Pre-seed all known event rooms ──
const ALL_ROOMS = [
  '101','106','120','125','126','128','129','131','132','133','134',
  '201','207','208','222','224','229','233',
  '301','302','311','321','322','323','324','327','328','330','331','332',
  '503','504','519',
  '603','605','606','609','610','611','612','618',
  '703','704','705','706','709','710','711','712','715','718',
  '802','803','817','818','824','825',
  '1805',
  '2003','2010','2011','2052',
  '2303','2406','2407','2452','2453','2456',
  '2603','2702','2703','2706','2802','2852','2853',
  '4001','4002','4003','4004','4101','4102','4103',
  '4200','4201','4202','4203','4204','4215','4216','4217','4218','4219','4221',
  '4300','4301','4302','4303','4304','4315','4316','4317','4318','4319','4320','4321','4324',
  '4416','4417','4418','4419'
];
db.transaction(() => {
  for (const room of ALL_ROOMS) {
    insertRoom.run(room, 'classroom');
  }
})();

// ── Custom page renderer for position-aware text extraction ──
function positionPageRender(pageData) {
  return pageData.getTextContent({ normalizeWhitespace: false }).then(function(textContent) {
    const items = textContent.items.map(item => ({
      x: Math.round(item.transform[4]),
      y: Math.round(item.transform[5]),
      t: item.str.trim(),
      w: Math.round(item.width)
    })).filter(i => i.t.length > 0);
    return JSON.stringify(items);
  });
}

// ── Upload PDF ──
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'PDF file is required' });
    console.log('Processing:', req.file.originalname, 'size:', req.file.size);

    const pdfBuffer = fs.readFileSync(req.file.path);
    let pages;
    try {
      const pdfData = await pdfParse(pdfBuffer, { pagerender: positionPageRender });
      pages = pdfData.text.split('\n\n').filter(Boolean);
    } catch (pdfErr) {
      console.error('PDF parse error:', pdfErr.message);
      return res.status(400).json({ error: 'Could not read PDF: ' + pdfErr.message });
    }

    const sections = parsePdfPages(pages);
    let totalEntries = 0;
    let totalRooms = 0;
    const skippedCount = pages.length - sections.length;

    db.transaction(() => {
      for (const sec of sections) {
        for (const room of sec.rooms) {
          const r = insertRoom.run(room, /lab/i.test(room) ? 'lab' : 'classroom');
          if (r.changes) totalRooms++;
        }
        const tt = insertTimetable.run(sec.department, sec.year_sem, sec.section, sec.default_room, req.file.originalname, '');
        const ttId = Number(tt.lastInsertRowid);
        for (const e of sec.entries) {
          insertSchedule.run(ttId, e.day, e.time_slot, e.room_number, e.subject);
          totalEntries++;
        }
      }
    })();

    // Clean up uploaded file — data is in DB now
    try { fs.unlinkSync(req.file.path); } catch {}

    console.log(`Parsed: ${sections.length} sections, ${totalEntries} entries, ${totalRooms} new rooms, ${skippedCount} pages skipped`);
    return res.json({
      message: `Parsed ${sections.length} section(s) from ${pages.length} pages: ${totalEntries} schedule entries, ${totalRooms} new rooms. ${skippedCount} page(s) skipped.`,
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

app.get('/api/timetables', (req, res) => {
  res.json(db.prepare('SELECT id, department, year_sem, section, default_room, filename, uploaded_at FROM timetables').all());
});

app.delete('/api/uploads/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const tts = db.prepare('SELECT id, filepath FROM timetables WHERE filename = ?').all(filename);
  db.transaction(() => {
    for (const tt of tts) {
      db.prepare('DELETE FROM schedules WHERE timetable_id = ?').run(tt.id);
      if (tt.filepath && fs.existsSync(tt.filepath)) fs.unlinkSync(tt.filepath);
    }
    db.prepare('DELETE FROM timetables WHERE filename = ?').run(filename);
  })();
  res.json({ message: `Removed ${tts.length} section(s) from ${filename}` });
});

app.get('/api/uploads', (req, res) => {
  res.json(db.prepare('SELECT filename, MIN(uploaded_at) as uploaded_at, COUNT(*) as sections FROM timetables GROUP BY filename ORDER BY uploaded_at DESC').all());
});

app.get('/api/timetables/:id/schedule', (req, res) => {
  res.json(db.prepare('SELECT * FROM schedules WHERE timetable_id = ?').all(req.params.id));
});

app.delete('/api/timetables/:id', (req, res) => {
  db.prepare('DELETE FROM schedules WHERE timetable_id = ?').run(req.params.id);
  db.prepare('DELETE FROM timetables WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── Free Rooms (flexible time range) ──
// Convert "HH:MM" (12h or 24h) to minutes since midnight for comparison
function timeToMinutes(t) {
  let [h, m] = t.split(':').map(Number);
  // Handle 12-hour format: 01:00-04:05 are PM (13:00-16:05)
  if (h >= 1 && h <= 4) h += 12;
  // 12:xx stays as 12:xx (noon)
  return h * 60 + m;
}

app.get('/api/free-rooms', (req, res) => {
  const { day, from, to } = req.query;
  if (!day || !from || !to) return res.status(400).json({ error: 'day, from, and to are required' });

  const fromMin = timeToMinutes(from);
  const toMin = timeToMinutes(to);

  // Find all time slots that overlap with the requested range
  const allSlots = TIME_SLOTS;
  const overlapping = allSlots.filter(slot => {
    const [start, end] = slot.split('-');
    const slotStart = timeToMinutes(start);
    const slotEnd = timeToMinutes(end);
    // Overlap: requested range starts before slot ends AND ends after slot starts
    return fromMin < slotEnd && toMin > slotStart;
  });

  const allRooms = db.prepare('SELECT * FROM rooms').all();

  // A room is free only if it's free in ALL overlapping slots
  const occupiedSet = new Set();
  for (const slot of overlapping) {
    const rows = db.prepare(
      'SELECT DISTINCT room_number FROM schedules WHERE LOWER(day) = LOWER(?) AND time_slot = ?'
    ).all(day, slot);
    for (const r of rows) occupiedSet.add(r.room_number);
  }

  const freeRooms = allRooms.filter(r => !occupiedSet.has(r.room_number));
  res.json({ day, from, to, overlapping_slots: overlapping, free_rooms: freeRooms, occupied_rooms: Array.from(occupiedSet) });
});

app.get('/api/slots', (req, res) => {
  const days = db.prepare('SELECT DISTINCT day FROM schedules ORDER BY day').all().map(r => r.day);
  const timeSlots = db.prepare('SELECT DISTINCT time_slot FROM schedules ORDER BY time_slot').all().map(r => r.time_slot);
  res.json({ days, time_slots: timeSlots });
});

// ══════════════════════════════════════════════════════════
// Position-aware PDF Parser
// Uses X/Y coordinates from pdf-parse pagerender to correctly
// map subjects to time slot columns, preserving free periods.
// ══════════════════════════════════════════════════════════

const TIME_SLOTS = [
  '09:00-09:55', '09:55-10:50', '11:10-12:05',
  '12:05-01:00', '02:15-03:10', '03:10-04:05'
];
const DAY_NAMES = { MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday' };
const SKIP_WORDS = new Set(['B','R','E','A','K','L','U','N','C','H','BREAK','LUNCH','DAY','/HR','HOUR','TO','AM','PM']);

function parsePdfPages(pages) {
  const allSections = [];
  const skippedPages = [];

  for (let p = 0; p < pages.length; p++) {
    let items;
    try { items = JSON.parse(pages[p]); } catch { 
      skippedPages.push({ page: p + 1, reason: 'JSON parse failed' });
      continue; 
    }
    if (!items.length) {
      skippedPages.push({ page: p + 1, reason: 'Empty page' });
      continue;
    }

    const section = parseOnePage(items, p + 1);
    if (section && section.entries.length > 0) {
      section.pageNum = p + 1;
      allSections.push(section);
    } else if (!section) {
      // Grab first few text items to help identify the format
      const sample = items.slice(0, 40).map(i => i.t).join(' | ');
      skippedPages.push({ page: p + 1, reason: 'No section header found', sample });
    } else {
      skippedPages.push({ page: p + 1, reason: '0 entries extracted', section: section.section });
    }
  }

  if (skippedPages.length > 0) {
    console.log(`\n=== SKIPPED PAGES (${skippedPages.length}) ===`);
    for (const sp of skippedPages) {
      console.log(`  Page ${sp.page}: ${sp.reason}${sp.sample ? '\n    Sample: ' + sp.sample.substring(0, 400) : ''}`);
    }
    console.log('=== END SKIPPED ===\n');
  }

  return allSections;
}

function parseOnePage(items, pageNum) {
  // ── Step 1: Extract header info (department, semester, section, default room) ──
  let department = '', yearSem = '', section = '', defaultRoom = '';
  const rooms = new Set();

  // Concatenate all text items sorted by Y desc (top first) then X asc
  // to find header patterns
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  // Build full text lines by grouping items at similar Y
  const yGroups = groupByY(sorted, 5);

  // Also build full page text for fallback matching (handles split fragments across Y-groups)
  const allText = items.map(i => i.t).join(' ');
  const normAll = allText
    .replace(/\bI\s+V\b/g, 'IV').replace(/\bV\s+I\s+I\s+I\b/g, 'VIII')
    .replace(/\bV\s+I\s+I\b/g, 'VII').replace(/\bV\s+I\b/g, 'VI')
    .replace(/\bI\s+I\s+I\b/g, 'III').replace(/\bI\s+I\b/g, 'II')
    .replace(/Sec\s*tion/gi, 'Section');

  for (const group of yGroups) {
    // Merge adjacent fragments within the group (e.g., "285" + "2" → "2852")
    const mergedGroup = mergeAdjacentItems(group.sort((a, b) => a.x - b.x));
    const lineText = mergedGroup.map(i => i.t).join(' ');

    // Department
    const deptMatch = lineText.match(/DEPARTMENT\s+OF\s+(.+)/i);
    if (deptMatch && !department) { department = deptMatch[1].trim(); continue; }

    // Normalize split roman numerals: "I V" → "IV", "V I" → "VI", "I I" → "II", "V I I I" → "VIII"
    const normLine = lineText
      .replace(/\bV\s+I\s+I\s+I\b/g, 'VIII')
      .replace(/\bV\s+I\s+I\b/g, 'VII')
      .replace(/\bI\s+V\b/g, 'IV')
      .replace(/\bV\s+I\b/g, 'VI')
      .replace(/\bI\s+I\s+I\b/g, 'III')
      .replace(/\bI\s+I\b/g, 'II')
      .replace(/Sec\s*tion/gi, 'Section');

    // CSE format: "IV SEMESTER [SECTION-A1]" or "IV SEMESTER [SECTION A1]"
    const cseMatch = normLine.match(/(\w+)\s+SEMESTER\s*\[SECTION[-\s]*(\w+)\]/i);
    if (cseMatch && !section) {
      yearSem = cseMatch[1] + ' Semester';
      section = cseMatch[2];
      continue;
    }

    // EEE format: "VI SEMESTER (SECTION - 01)" or "IV SEMESTER (SECTION-01)"
    const eeeMatch = normLine.match(/(\w+)\s+SEMESTER\s*\(SECTION[-\s]*(\w+)\)/i);
    if (eeeMatch && !section) {
      yearSem = eeeMatch[1] + ' Semester';
      section = eeeMatch[2];
      continue;
    }

    // ECE/EIE format: "IV Sem – Section – 1" or "VI Sem - Section - 2"
    const eceMatch = normLine.match(/(\w+)\s+Sem\w*\s*[–\-]\s*Section\s*[–\-]\s*(\w+)/i);
    if (eceMatch && !section) {
      yearSem = eceMatch[1] + ' Semester';
      section = eceMatch[2];
      continue;
    }

    // Civil format: "B.Tech VI Semester" (section may be on same or different line)
    const civilMatch = normLine.match(/B\.?\s*Tech\s+(\w+)\s+Semester/i);
    if (civilMatch && !yearSem) {
      yearSem = civilMatch[1] + ' Semester';
      const secInLine = normLine.match(/Section[-\s]*(\w+)/i);
      if (secInLine) section = secInLine[1];
      continue;
    }

    // DS/IT/CS format: "IV Semester (DS-1)" or "VI Semester ( IT )" or "VI Semester (CS-2)"
    const dsMatch = normLine.match(/(\w+)\s+Semester\s*\(\s*([^)]+)\)/i);
    if (dsMatch && !section) {
      yearSem = dsMatch[1] + ' Semester';
      section = dsMatch[2].trim();
      continue;
    }

    // Mechanical bracket format: "[ IV SEMESTER ]" — no section, just semester in brackets
    const mechBracketLine = normLine.match(/\[\s*(\w+)\s+SEMESTER\s*\]/i);
    if (mechBracketLine && !section) {
      yearSem = mechBracketLine[1] + ' Semester';
      const deptAbbr = department.match(/MECH/i) ? 'ME' : department.substring(0, 3).toUpperCase();
      section = deptAbbr + '-1';
      continue;
    }

    // Default room: "Room No: 322" or "Room No.: 2852" or "Room No: 2 702"
    const roomHeaderMatch = normLine.match(/Room\s*No[.:]*\s*([\d\s]+\d)/i);
    if (roomHeaderMatch && !defaultRoom) {
      if (group[0].y > 590) {
        defaultRoom = roomHeaderMatch[1].replace(/\s+/g, '');
        rooms.add(defaultRoom);
        continue;
      }
    }
  }

  // ── Fallback: if per-line matching failed, try full page text ──
  if (!section) {
    // Department from full text
    const deptFull = normAll.match(/DEPARTMENT\s+OF\s+([\w\s&]+?)(?:\s+ACADEMIC|\s+CLASS|\s+TIME)/i);
    if (deptFull && !department) department = deptFull[1].trim();

    // CSE: [SECTION-A1]
    const cseFull = normAll.match(/(\w+)\s+SEMESTER\s*\[SECTION[-\s]*(\w+)\]/i);
    if (cseFull) { yearSem = cseFull[1] + ' Semester'; section = cseFull[2]; }

    // EEE: (SECTION - 01)
    if (!section) {
      const eeeFull = normAll.match(/(\w+)\s+SEMESTER\s*\(SECTION[-\s]*(\w+)\)/i);
      if (eeeFull) { yearSem = eeeFull[1] + ' Semester'; section = eeeFull[2]; }
    }

    // ECE/EIE: Sem – Section – 1
    if (!section) {
      const eceFull = normAll.match(/(\w+)\s+Sem\w*\s*[–\-]\s*Section\s*[–\-]\s*(\w+)/i);
      if (eceFull) { yearSem = eceFull[1] + ' Semester'; section = eceFull[2]; }
    }

    // Civil: B.Tech VI Semester
    if (!section) {
      const civilFull = normAll.match(/B\.?\s*Tech\s+(\w+)\s+Semester/i);
      if (civilFull) {
        yearSem = civilFull[1] + ' Semester';
        const secFull = normAll.match(/Section[-\s]*(\w+)/i);
        section = secFull ? secFull[1] : 'A';
      }
    }

    // DS/IT/CS: Semester (DS-1)
    if (!section) {
      const dsFull = normAll.match(/(\w+)\s+Semester\s*\(\s*([^)]+)\)/i);
      if (dsFull) { yearSem = dsFull[1] + ' Semester'; section = dsFull[2].trim(); }
    }

    // Mechanical bracket format: "[ IV SEMESTER ]" or "[ V I SEMESTER ]"
    // These pages have no section name — just semester inside brackets
    if (!section) {
      const mechBracket = normAll.match(/\[\s*(\w+)\s+SEMESTER\s*\]/i);
      if (mechBracket) {
        yearSem = mechBracket[1] + ' Semester';
        // Mechanical has no section — derive from department
        const deptAbbr = department.match(/MECH/i) ? 'ME' : department.substring(0, 3).toUpperCase();
        section = deptAbbr + '-1';
      }
    }

    // Generic fallback: look for "IV Sem" or "VI Sem" + section number
    if (!section) {
      const mechSem = normAll.match(/(\w+)\s+Sem(?:ester)?/i);
      const mechSec = normAll.match(/Section[-–\s]*(\w+)/i);
      if (mechSem && mechSec) {
        yearSem = mechSem[1] + ' Semester';
        section = mechSec[1];
      } else if (mechSem) {
        const mechNum = normAll.match(/Sem\w*\s*[–\-]?\s*(\d+)/i);
        if (mechNum) {
          yearSem = mechSem[1] + ' Semester';
          section = mechNum[1];
        }
      }
    }

    // Room from full text (handles split digits like "2 702")
    if (!defaultRoom) {
      const roomFull = normAll.match(/Room\s*No[.:]*\s*([\d\s]+\d)/i);
      if (roomFull) {
        defaultRoom = roomFull[1].replace(/\s+/g, '');
        rooms.add(defaultRoom);
      }
    }

    // Handle non-numeric room names like "Project Lab"
    if (!defaultRoom) {
      const roomName = normAll.match(/Room\s*(?:No)?[.:]*\s*([A-Za-z]+\s*Lab)/i);
      if (roomName) {
        defaultRoom = roomName[1].trim();
        rooms.add(defaultRoom);
      }
    }
  }

  if (!section) return null;

  // ── Step 2: Determine column boundaries from time header positions ──
  // Find time header items (09:00, 09:55, 11:10, etc.)
  const timeHeaderItems = items.filter(i =>
    /^(09|10|11|12|01|02|03|04)[.:]\d{2}/.test(i.t) && i.y > 640
  );

  let colBoundaries;
  if (timeHeaderItems.length >= 4) {
    colBoundaries = computeColumnBoundaries(timeHeaderItems);
  } else {
    // Fallback: use BREAK/LUNCH column positions to infer boundaries
    colBoundaries = inferColumnBoundaries(items);
  }

  if (!colBoundaries) {
    // Last resort: hardcoded boundaries that work for both CSE and DS
    colBoundaries = [
      { left: 95, right: 170 },   // Slot 1
      { left: 170, right: 237 },  // Slot 2
      { left: 255, right: 325 },  // Slot 3
      { left: 325, right: 395 },  // Slot 4
      { left: 410, right: 475 },  // Slot 5
      { left: 475, right: 550 },  // Slot 6
    ];
  }

  // ── Step 3: Find day rows and extract schedule entries ──
  const dayItems = items.filter(i => /^(MON|TUE|WED|THU|FRI)$/i.test(i.t));
  const entries = [];

  for (const dayItem of dayItems) {
    const dayName = DAY_NAMES[dayItem.t.toUpperCase()];
    if (!dayName) continue;

    // Collect all items in this day's row (within Y tolerance)
    const rowItems = items.filter(i =>
      Math.abs(i.y - dayItem.y) <= 10 && i.x > 90
    ).sort((a, b) => a.x - b.x);

    // Also collect items slightly above/below (room refs, MOOC tags)
    // that belong to this row (within ~14px Y range)
    let extendedRowItems = items.filter(i =>
      Math.abs(i.y - dayItem.y) <= 14 && i.x > 90
    ).sort((a, b) => a.y - b.y || a.x - b.x);

    // Merge adjacent text fragments at same Y that are very close in X
    // (e.g., "2" + "406" → "2406", "80" + "3" + ")" → "803)")
    extendedRowItems = mergeAdjacentItems(extendedRowItems);

    // Assign each item to a column slot
    const slotData = [null, null, null, null, null, null]; // 6 slots

    for (const item of extendedRowItems) {
      // Skip BREAK/LUNCH letters and day names
      if (SKIP_WORDS.has(item.t.toUpperCase())) continue;
      if (/^(MON|TUE|WED|THU|FRI|SAT)$/i.test(item.t)) continue;

      const slotIdx = getSlotIndex(item.x, colBoundaries);
      if (slotIdx === -1) continue;

      if (!slotData[slotIdx]) {
        slotData[slotIdx] = { subjects: [], roomOverride: null, mooc: false };
      }

      const txt = item.t;

      // Room reference: "Room No. 704", "(R.No.605)", "(R.No.80" + "3" + ")"
      if (/^Room\s*No[.:]/i.test(txt)) {
        const m = txt.match(/Room\s*No[.:]+\s*(\d+)/i);
        if (m) {
          slotData[slotIdx].roomOverride = m[1];
          rooms.add(m[1]);
        }
        continue;
      }
      if (/^\(R\.No[.:]/i.test(txt)) {
        const m = txt.match(/\(R\.No[.:]\s*(\d+)/i);
        if (m) {
          slotData[slotIdx].roomOverride = m[1];
          rooms.add(m[1]);
        }
        continue;
      }
      // Closing part of split R.No like "3)" or ")"
      if (/^\d*\)$/.test(txt)) continue;

      // MOOC tag
      if (/^\(MOOC\)$/i.test(txt)) {
        slotData[slotIdx].mooc = true;
        continue;
      }

      // Bare room number (3-4 digits) appearing above/below subject
      if (/^\d{3,4}$/.test(txt) && Math.abs(item.y - dayItem.y) > 5) {
        slotData[slotIdx].roomOverride = txt;
        rooms.add(txt);
        continue;
      }

      // Skip single BREAK/LUNCH letters
      if (txt.length === 1 && /[BREAKLUNCH]/i.test(txt)) continue;

      // It's a subject name
      slotData[slotIdx].subjects.push(txt);
    }

    // ── Step 4: Build entries from slot data ──
    // LAB subjects span 2 consecutive slots. In the PDF, the merged cell
    // places the text in the first column. The second column is empty.
    // We detect LAB subjects and duplicate them into the next slot.
    for (let s = 0; s < 6; s++) {
      const sd = slotData[s];
      if (!sd || sd.subjects.length === 0) continue;
      if (sd.subjects[0] === '_FILLED_') continue; // Already filled by LAB span

      let subjectName = sd.subjects.join(' ');
      if (sd.mooc) subjectName += ' (MOOC)';

      const roomNum = sd.roomOverride || defaultRoom;
      // 2-hour subjects: LAB, QAVA, CP — they span 2 consecutive slots
      const is2Hour = /\bLAB\b/i.test(subjectName) || /^QAVA$/i.test(subjectName) || /^CP$/i.test(subjectName);

      entries.push({
        day: dayName,
        time_slot: TIME_SLOTS[s],
        room_number: roomNum,
        subject: subjectName
      });

      // If it's a 2-hour subject and the next slot is empty, fill it too
      if (is2Hour && s + 1 < 6 && (!slotData[s + 1] || slotData[s + 1].subjects.length === 0)) {
        // Also check if next slot has a room override we should use
        const nextRoom = (slotData[s + 1] && slotData[s + 1].roomOverride) || roomNum;
        entries.push({
          day: dayName,
          time_slot: TIME_SLOTS[s + 1],
          room_number: nextRoom,
          subject: subjectName
        });
        slotData[s + 1] = { subjects: ['_FILLED_'], roomOverride: null, mooc: false };
      }

      if (roomNum) rooms.add(roomNum);
    }
  }

  return {
    department,
    year_sem: yearSem,
    section,
    default_room: defaultRoom,
    rooms: Array.from(rooms),
    entries
  };
}

// Merge adjacent text items that are very close in X and at similar Y
// This handles split numbers like "2" + "406" → "2406"
function mergeAdjacentItems(items) {
  if (items.length <= 1) return items;
  const merged = [{ ...items[0] }];
  for (let i = 1; i < items.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = items[i];
    const prevEnd = prev.x + prev.w;
    const gap = curr.x - prevEnd;
    // Merge only if same Y (within 2px), gap is tiny (< 3px),
    // AND at least one item is short (≤3 chars) — indicating a fragment
    // This merges "285"+"2" and "(R.No.80"+"3"+")" but not "DEPARTMENT OF"+"COMPUTER..."
    const isFragment = curr.t.length <= 3 || prev.t.length <= 3;
    if (Math.abs(curr.y - prev.y) <= 2 && gap < 3 && gap >= -3 && isFragment) {
      prev.t = prev.t + curr.t;
      prev.w = (curr.x + curr.w) - prev.x;
      continue;
    }
    merged.push({ ...curr });
  }
  return merged;
}

// Group items by Y coordinate (within tolerance)
function groupByY(items, tolerance) {
  const groups = [];
  let currentGroup = [];
  let currentY = null;

  for (const item of items) {
    if (currentY === null || Math.abs(item.y - currentY) <= tolerance) {
      currentGroup.push(item);
      if (currentY === null) currentY = item.y;
    } else {
      if (currentGroup.length) groups.push(currentGroup);
      currentGroup = [item];
      currentY = item.y;
    }
  }
  if (currentGroup.length) groups.push(currentGroup);
  return groups;
}

// Compute column boundaries from time header X positions
function computeColumnBoundaries(timeHeaders) {
  // Group time headers by X proximity to find 6 column left edges
  const leftEdges = [];
  const sorted = [...timeHeaders].sort((a, b) => a.x - b.x);

  for (const th of sorted) {
    const existing = leftEdges.find(c => Math.abs(c - th.x) < 40);
    if (!existing) leftEdges.push(th.x);
  }
  leftEdges.sort((a, b) => a - b);

  if (leftEdges.length < 6) return null;

  const cols = leftEdges.slice(0, 6);

  // Each column spans from its left edge to just before the next column's left edge
  // Add margin before first column and after last column
  const boundaries = [];
  for (let i = 0; i < 6; i++) {
    const left = i === 0 ? cols[i] - 25 : cols[i] - 10;
    const right = i < 5 ? cols[i + 1] - 11 : cols[i] + 50;
    boundaries.push({ left, right });
  }
  return boundaries;
}

// Infer column boundaries from BREAK/LUNCH positions
function inferColumnBoundaries(items) {
  // BREAK letters appear between slots 2 and 3
  // LUNCH letters appear between slots 4 and 5
  const breakLetters = items.filter(i => i.t === 'B' || i.t === 'E' || i.t === 'K');
  const lunchLetters = items.filter(i => i.t === 'L' || i.t === 'U' || i.t === 'H');

  if (breakLetters.length < 2) return null;

  // Compute LUNCH X first
  let lunchX = null;
  if (lunchLetters.length >= 2) {
    lunchX = Math.round(lunchLetters.reduce((s, i) => s + i.x, 0) / lunchLetters.length);
  }

  // Filter BREAK items to only morning BREAK (not near LUNCH position)
  let morningBreak = breakLetters;
  if (lunchX !== null) {
    morningBreak = breakLetters.filter(i => Math.abs(i.x - lunchX) > 50);
  }
  if (morningBreak.length < 2) morningBreak = breakLetters;

  const breakX = Math.round(morningBreak.reduce((s, i) => s + i.x, 0) / morningBreak.length);

  if (lunchX === null || Math.abs(lunchX - breakX) < 50) {
    lunchX = breakX + 150;
  }

  // BREAK at breakX means: slots 1-2 are to the left, slots 3-4 between BREAK and LUNCH
  // Use the gap positions to define column boundaries
  // Slot widths: before BREAK ~70px each, between BREAK-LUNCH ~70px each, after LUNCH ~65px each
  const preBreakWidth = (breakX - 100) / 2;  // 2 slots before BREAK
  const midWidth = (lunchX - breakX - 20) / 2; // 2 slots between BREAK and LUNCH
  const postWidth = 65; // estimate for after LUNCH

  return [
    { left: 95, right: 95 + preBreakWidth },                                    // Slot 1
    { left: 95 + preBreakWidth, right: breakX - 5 },                            // Slot 2
    { left: breakX + 10, right: breakX + 10 + midWidth },                       // Slot 3
    { left: breakX + 10 + midWidth, right: lunchX - 5 },                        // Slot 4
    { left: lunchX + 10, right: lunchX + 10 + postWidth },                      // Slot 5
    { left: lunchX + 10 + postWidth, right: lunchX + 10 + 2 * postWidth + 10 }, // Slot 6
  ];
}


// Determine which time slot (0-5) an X coordinate falls into
function getSlotIndex(x, boundaries) {
  for (let i = 0; i < boundaries.length; i++) {
    if (x >= boundaries[i].left && x <= boundaries[i].right) return i;
  }
  // If between boundaries (in BREAK/LUNCH gap), skip
  return -1;
}

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Server error: ' + err.message });
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
