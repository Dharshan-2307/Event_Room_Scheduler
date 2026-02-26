const API = 'http://localhost:3000';

function showMsg(el, text, type) {
  el.textContent = text;
  el.className = 'msg ' + type;
  setTimeout(() => { el.textContent = ''; el.className = 'msg'; }, 6000);
}

// ── Rooms Upload ──
document.getElementById('roomUploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('roomMsg');
  const preview = document.getElementById('roomPreview');
  const form = new FormData();
  form.append('pdf', document.getElementById('roomPdf').files[0]);
  try {
    const res = await fetch(API + '/api/rooms/upload', { method: 'POST', body: form });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return showMsg(msg, 'Server error: ' + text.substring(0, 200), 'error'); }
    if (res.ok) {
      showMsg(msg, `${json.message} (${json.total_found} found in PDF)`, 'success');
      preview.style.display = 'block';
      preview.textContent = json.raw_text;
      loadRooms();
    } else showMsg(msg, json.error, 'error');
  } catch (e) { showMsg(msg, 'Upload failed: ' + e.message, 'error'); }
});

async function loadRooms() {
  const rooms = await (await fetch(API + '/api/rooms')).json();
  document.querySelector('#roomsTable tbody').innerHTML = rooms.length ? rooms.map(r => `
    <tr><td>${r.room_number}</td><td>${r.building || '-'}</td><td>${r.capacity || '-'}</td>
    <td>${r.room_type}</td><td><button class="danger" onclick="deleteRoom(${r.id})">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="5" style="text-align:center;color:#999">No rooms yet.</td></tr>';
}
async function deleteRoom(id) { await fetch(API + '/api/rooms/' + id, { method: 'DELETE' }); loadRooms(); }

// ── Timetable Upload ──
document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('uploadMsg');
  const preview = document.getElementById('parsedPreview');
  const form = new FormData();
  form.append('department', document.getElementById('dept').value);
  form.append('year', document.getElementById('year').value);
  form.append('pdf', document.getElementById('pdfFile').files[0]);
  try {
    const res = await fetch(API + '/api/timetables', { method: 'POST', body: form });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return showMsg(msg, 'Server error: ' + text.substring(0, 200), 'error'); }
    if (res.ok) {
      showMsg(msg, `Uploaded! ${json.entries_found} schedule entries parsed.`, 'success');
      preview.style.display = 'block';
      preview.textContent = json.raw_text;
      loadTimetables();
    } else showMsg(msg, json.error, 'error');
  } catch (e) { showMsg(msg, 'Upload failed: ' + e.message, 'error'); }
});

// ── Manual Entry ──
document.getElementById('manualForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('manualMsg');
  const body = {
    timetable_id: +document.getElementById('manualTtId').value,
    day: document.getElementById('manualDay').value,
    time_slot: document.getElementById('manualTime').value,
    room_number: document.getElementById('manualRoom').value,
    subject: document.getElementById('manualSubject').value,
    faculty: document.getElementById('manualFaculty').value
  };
  const res = await fetch(API + '/api/schedules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const json = await res.json();
  if (res.ok) showMsg(msg, json.message, 'success');
  else showMsg(msg, json.error, 'error');
});

// ── Timetables List ──
async function loadTimetables() {
  const list = await (await fetch(API + '/api/timetables')).json();
  document.querySelector('#ttTable tbody').innerHTML = list.length ? list.map(t => `
    <tr><td>${t.id}</td><td>${t.department}</td><td>${t.year}</td><td>${t.filename}</td>
    <td>${new Date(t.uploaded_at).toLocaleString()}</td>
    <td><button class="secondary" onclick="viewSchedule(${t.id})">View</button>
    <button class="danger" onclick="deleteTimetable(${t.id})">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="6" style="text-align:center;color:#999">No timetables yet.</td></tr>';
}
async function viewSchedule(id) {
  const entries = await (await fetch(API + '/api/timetables/' + id + '/schedule')).json();
  document.getElementById('scheduleCard').style.display = 'block';
  document.querySelector('#scheduleTable tbody').innerHTML = entries.length ? entries.map(e => `
    <tr><td>${e.day}</td><td>${e.time_slot}</td><td>${e.room_number}</td>
    <td>${e.subject || '-'}</td><td>${e.faculty || '-'}</td></tr>`).join('')
    : '<tr><td colspan="5" style="text-align:center;color:#999">No entries.</td></tr>';
}
async function deleteTimetable(id) {
  await fetch(API + '/api/timetables/' + id, { method: 'DELETE' });
  loadTimetables();
  document.getElementById('scheduleCard').style.display = 'none';
}

// ── Find Free Rooms ──
async function loadSlots() {
  const data = await (await fetch(API + '/api/slots')).json();
  document.getElementById('findDay').innerHTML = data.days.length
    ? data.days.map(d => `<option value="${d}">${d}</option>`).join('')
    : '<option value="">No days — upload timetables first</option>';
  document.getElementById('findTime').innerHTML = data.time_slots.length
    ? data.time_slots.map(t => `<option value="${t}">${t}</option>`).join('')
    : '<option value="">No slots found</option>';
}
async function findFreeRooms() {
  const day = document.getElementById('findDay').value;
  const time = document.getElementById('findTime').value;
  if (!day || !time) return;
  const data = await (await fetch(API + `/api/free-rooms?day=${encodeURIComponent(day)}&time_slot=${encodeURIComponent(time)}`)).json();
  const el = document.getElementById('freeResults');
  if (data.free_rooms.length === 0) {
    el.innerHTML = '<p style="color:#e74c3c;font-weight:600">No free rooms for this slot.</p>';
  } else {
    el.innerHTML = `<p style="margin-bottom:0.8rem;color:#555">${data.free_rooms.length} room(s) free on <strong>${data.day}</strong> at <strong>${data.time_slot}</strong></p>`
      + data.free_rooms.map(r => `<div class="room-card"><div class="room-num">${r.room_number}</div>
      <div class="room-info">${r.building || 'N/A'} · ${r.capacity || '?'} seats · ${r.room_type}</div></div>`).join('');
  }
}

loadRooms();
loadTimetables();
