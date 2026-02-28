# 🏫 College Room Scheduler

A web app for **Mohan Babu University (MBU)** that parses timetable PDFs, auto-extracts room schedules, and helps find free rooms for events.

🔗 **Live Demo:** [https://event-room-scheduler.onrender.com](https://event-room-scheduler.onrender.com)

## What It Does

- Upload timetable PDFs — department, semester, section, room numbers, and full weekly schedules are extracted automatically
- No manual data entry — the parser reads X/Y coordinates from the PDF to correctly map subjects to time slots
- Find free rooms by selecting a day and time range — instantly see which rooms are available
- Supports all MBU departments: CSE, ECE, EIE, EEE, Civil, Mechanical, DS, IT, CS, AIML

## How It Works

### PDF Parsing
The app uses a position-aware PDF parser that:
1. Extracts text items with their X/Y coordinates from each page
2. Groups items by Y-coordinate to reconstruct lines
3. Identifies the header (department, semester, section, room number) using pattern matching
4. Detects column boundaries from time header positions (09:00, 09:55, 11:10, etc.)
5. Maps each subject to the correct time slot based on its X position
6. Handles 2-hour subjects (LAB, QAVA, CP) that span consecutive slots
7. Merges fragmented text (split room numbers like `2 702` → `2702`, OCR artifacts like `B.Te c h` → `B.Tech`)

### Supported PDF Formats
| Department | Header Format | Example |
|---|---|---|
| CSE | `IV SEMESTER [SECTION-A1]` | Section A1 through A10 |
| ECE / EIE | `IV Sem – Section – 1` | Dash-separated |
| EEE | `VI SEMESTER (SECTION-01)` | Parenthesized |
| Civil | `B.Tech VI Semester` or `B.Tech IV Semester [CE]` | With/without bracket section |
| DS / IT / CS | `VI Semester (DS-1)` | Department code in parens |
| Mechanical | `[ IV SEMESTER ]` | Bracket-only, no section name |

### Free Room Search
- Pre-seeded with ~130 known event room numbers
- Compares requested time range against all stored schedules
- A room is "free" only if it has no classes in ALL overlapping time slots

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Database | SQLite (better-sqlite3) |
| PDF Parsing | pdf-parse with custom position-aware renderer |
| File Upload | Multer |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Deployment | Render.com |

No frameworks on the frontend — just plain HTML/CSS/JS.

## Project Structure

```
├── server.js          # Express server, PDF parser, API endpoints
├── public/
│   ├── index.html     # Single-page UI
│   ├── style.css      # Styling
│   └── app.js         # Frontend logic
├── package.json
└── scheduler.db       # SQLite database (auto-created)
```

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/upload` | Upload & parse a timetable PDF |
| `GET` | `/api/uploads` | List uploaded PDFs |
| `DELETE` | `/api/uploads/:filename` | Remove a PDF and its data |
| `GET` | `/api/rooms` | List all known rooms |
| `GET` | `/api/free-rooms?day=Monday&from=09:00&to=10:50` | Find free rooms for a time range |
| `GET` | `/api/slots` | Get available days and time slots |

## Time Slots

| Slot | Time |
|---|---|
| 1 | 09:00 - 09:55 |
| 2 | 09:55 - 10:50 |
| 3 | 11:10 - 12:05 |
| 4 | 12:05 - 01:00 |
| 5 | 02:15 - 03:10 |
| 6 | 03:10 - 04:05 |

## Setup & Run Locally

```bash
git clone https://github.com/Dharshan-2307/Event_Room_Scheduler.git
cd Event_Room_Scheduler
npm install
node server.js
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

1. Open the app
2. Upload a timetable PDF (single or merged multi-department PDF)
3. The parser extracts all sections, schedules, and room numbers automatically
4. Use the "Find Free Rooms" section — pick a day and time range to see available rooms
5. Uploaded PDFs can be removed from the "Uploaded PDFs" section

## Notes

- Saturday classes are excluded from the schedule
- Scanned/image PDFs need to be OCR'd first (use Google Drive, Adobe Acrobat, or ocr.space)
- The uploaded PDF file is auto-deleted after parsing — only the extracted data is stored in the database
- On Render.com, SQLite runs on ephemeral storage — data resets on redeploy
