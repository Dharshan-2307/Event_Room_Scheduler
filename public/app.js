const API = '';

function showMsg(el, text, type) {
  el.textContent = text;
  el.className = 'msg ' + type;
  setTimeout(() => { el.textContent = ''; el.className = 'msg'; }, 8000);
}

// ── Upload ──
document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('uploadMsg');
  const preview = document.getElementById('parsedPreview');
  const form = new FormData();
  form.append('pdf', document.getElementById('pdfFile').files[0]);
  try {
    const res = await fetch(API + '/api/upload', { method: 'POST', body: form });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return showMsg(msg, 'Server error: ' + text.substring(0, 300), 'error'); }
    if (res.ok) {
      showMsg(msg, json.message, 'success');
      preview.style.display = 'block';
      preview.textContent = json.sections.map(s =>
        `${s.department} | ${s.year_sem} | Section ${s.section} | Room ${s.default_room} | ${s.entries} entries`
      ).join('\n');
      loadTimetables();
      loadSlots();
      loadUploadedPdfs();
    } else showMsg(msg, json.error, 'error');
  } catch (e) { showMsg(msg, 'Upload failed: ' + e.message, 'error'); }
});

// ── Uploaded PDFs ──
async function loadUploadedPdfs() {
  const list = await (await fetch(API + '/api/uploads')).json();
  const el = document.getElementById('uploadedPdfs');
  if (!list.length) {
    el.innerHTML = '<p style="color:#999;text-align:center">No PDFs uploaded yet.</p>';
    return;
  }
  el.innerHTML = list.map(f => `
    <div class="pdf-item">
      <span class="pdf-icon">📄</span>
      <div class="pdf-info">
        <div class="pdf-name">${f.filename}</div>
        <div class="pdf-meta">${f.sections} section(s) · Uploaded ${new Date(f.uploaded_at).toLocaleString()}</div>
      </div>
      <button class="danger" onclick="deletePdf('${encodeURIComponent(f.filename)}')">Remove</button>
    </div>`).join('');
}

async function deletePdf(filename) {
  await fetch(API + '/api/uploads/' + filename, { method: 'DELETE' });
  loadUploadedPdfs();
  loadTimetables();
  loadSlots();
}

// ── Timetables ──
async function loadTimetables() {
  const list = await (await fetch(API + '/api/timetables')).json();
  document.querySelector('#ttTable tbody').innerHTML = list.length ? list.map(t => `
    <tr><td>${t.id}</td><td>${t.department}</td><td>${t.year_sem}</td><td>${t.section}</td>
    <td>${t.default_room}</td><td>${t.filename}</td>
    <td><button class="secondary" onclick="viewSchedule(${t.id})">View</button>
    <button class="danger" onclick="deleteTimetable(${t.id})">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="7" style="text-align:center;color:#999">No timetables yet.</td></tr>';
}

async function viewSchedule(id) {
  const entries = await (await fetch(API + '/api/timetables/' + id + '/schedule')).json();
  const card = document.getElementById('scheduleCard');
  card.style.display = 'block';

  if (!entries.length) {
    document.querySelector('#scheduleTable').outerHTML = '<p style="color:#999;text-align:center">No entries.</p>';
    return;
  }

  // Build timetable grid: days as rows, time slots as columns
  const timeSlots = ['09:00-09:55', '09:55-10:50', '11:10-12:05', '12:05-01:00', '02:15-03:10', '03:10-04:05'];
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  // Group entries by day+time
  const grid = {};
  for (const e of entries) {
    const key = e.day + '|' + e.time_slot;
    grid[key] = e;
  }

  let html = '<table class="timetable-grid"><thead><tr><th>Day / Time</th>';
  for (const t of timeSlots) {
    html += `<th>${t}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const day of days) {
    html += `<tr><td class="day-cell">${day}</td>`;
    for (const slot of timeSlots) {
      const e = grid[day + '|' + slot];
      if (e) {
        const isAltRoom = e.room_number !== entries[0]?.room_number;
        html += `<td class="slot-cell${isAltRoom ? ' alt-room' : ''}">
          <div class="slot-subject">${e.subject}</div>
          <div class="slot-room">${e.room_number}</div>
        </td>`;
      } else {
        html += '<td class="slot-cell empty">—</td>';
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table>';

  document.getElementById('scheduleGrid').innerHTML = html;
}
async function deleteTimetable(id) {
  await fetch(API + '/api/timetables/' + id, { method: 'DELETE' });
  loadTimetables();
  document.getElementById('scheduleCard').style.display = 'none';
}

// ── Find Free Rooms ──
async function loadSlots() {
  const data = await (await fetch(API + '/api/slots')).json();
  const daySelect = document.getElementById('findDay');
  if (data.days.length) {
    daySelect.innerHTML = data.days.map(d => `<option value="${d}">${d}</option>`).join('');
  } else {
    daySelect.innerHTML = '<option value="">No data yet — upload a timetable</option>';
  }
}
async function findFreeRooms() {
  const day = document.getElementById('findDay').value;
  const from = document.getElementById('findFrom').value;
  const to = document.getElementById('findTo').value;
  if (!day || !from || !to) return;
  if (from >= to) {
    document.getElementById('freeResults').innerHTML = '<p style="color:#e74c3c;font-weight:600">"From" time must be before "To" time.</p>';
    return;
  }
  const data = await (await fetch(API + `/api/free-rooms?day=${encodeURIComponent(day)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json();
  const el = document.getElementById('freeResults');
  const rangeLabel = `${from} – ${to}`;
  if (data.free_rooms.length === 0) {
    el.innerHTML = '<p style="color:#e74c3c;font-weight:600">No free rooms for this time range.</p>';
  } else {
    el.innerHTML = `<p style="margin-bottom:0.8rem;color:#555">${data.free_rooms.length} room(s) free on <strong>${data.day}</strong> from <strong>${rangeLabel}</strong></p>`
      + data.free_rooms.map(r => `<div class="room-card"><div class="room-num">${r.room_number}</div>
      <div class="room-info">${r.room_type}</div></div>`).join('');
  }
}

loadTimetables();
loadSlots();
loadUploadedPdfs();
