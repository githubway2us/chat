const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// โฟลเดอร์จัดเก็บข้อมูล
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// โฟลเดอร์จัดเก็บไฟล์แนบของระบบเมล
const mailDir = path.join(__dirname, 'mail_attachments');
if (!fs.existsSync(mailDir)) {
    fs.mkdirSync(mailDir, { recursive: true });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));
app.use('/mail-attachments', express.static(mailDir));

// API ดึงรายการเพลงทั้งหมด
app.get('/api/music-list', (req, res) => {
    if (!fs.existsSync(uploadDir)) {
        return res.json({ success: true, musicList: [] });
    }

    fs.readdir(uploadDir, (err, files) => {
        if (err) return res.status(500).json({ success: false, message: 'ไม่สามารถอ่านไฟล์ได้' });

        const musicFiles = files
            .filter(file => /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(file))
            .map(file => ({
                filename: file,
                originalName: file.replace(/^\d+-/, ''),
                url: `/uploads/${encodeURIComponent(file)}`
            }));

        res.json({ success: true, musicList: musicFiles });
    });
});

const DB_FILE = 'database.json';

function readDB() {
    if (!fs.existsSync(DB_FILE)) {
        const initialData = {
            users: [{
                id: 'admin_root',
                username: 'admin',
                password: bcrypt.hashSync('123456', 10),
                role: 'admin',
                status: 'approved',
                nickname: 'ผู้ดูแลระบบ',
                birthdate: '1990-01-01',
                office: 'Headquarters',
                province: 'Bangkok',
                facebookUrl: 'https://facebook.com'
            }],
            rooms: [
                { id: 'save-log-room', name: 'ห้องบันทึกข้อความ', createdBy: 'System', persistent: true }
            ],
            pendingRooms: [],
            voiceRooms: [],
            pendingVoiceRooms: [],
            bannedUsers: [],
            reports: [],
            mails: []
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    }
    const data = JSON.parse(fs.readFileSync(DB_FILE));
    if (!data.bannedUsers) data.bannedUsers = [];
    if (!data.reports) data.reports = [];
    if (!data.rooms) data.rooms = [];
    if (!data.pendingRooms) data.pendingRooms = [];
    if (!data.voiceRooms) data.voiceRooms = [];
    if (!data.pendingVoiceRooms) data.pendingVoiceRooms = [];
    if (!data.mails) data.mails = [];
    return data;
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + Buffer.from(file.originalname, 'latin1').toString('utf8'));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

const mailStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, mailDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + Buffer.from(file.originalname, 'latin1').toString('utf8'));
    }
});

const mailUpload = multer({
    storage: mailStorage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

const MAIL_QUOTA = 5 * 1024 * 1024 * 1024;

function getMailSize(mail) {
    const bodySize = mail.body ? Buffer.byteLength(mail.body, 'utf8') : 0;
    const attachSize = (mail.attachments || []).reduce((sum, a) => sum + (a.size || 0), 0);
    return bodySize + attachSize;
}

function getMailUsage(db, username) {
    return db.mails.reduce((total, m) => {
        let size = 0;
        if (m.from === username && !m.senderDeleted) size += getMailSize(m);
        if (m.to === username && !m.recipientDeleted) size += getMailSize(m);
        return total + size;
    }, 0);
}

function deleteAttachmentFiles(attachments) {
    (attachments || []).forEach(a => {
        const filePath = path.join(mailDir, a.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
}

const badWords = ['kuy', 'hedhee', 'stfu', 'ไอ้สัตว์', 'เย็ด'];
function filterBadWords(text) {
    let cleanText = text;
    badWords.forEach(word => {
        const regex = new RegExp(word, 'gi');
        cleanText = cleanText.replace(regex, '***');
    });
    return cleanText;
}

let globalMute = false;

app.post('/api/register', (req, res) => {
    const { username, password, facebookUrl, birthdate, office, province, nickname, details } = req.body;
    let db = readDB();

    if (db.bannedUsers.find(b => b.username === username)) {
        return res.status(400).json({ success: false, message: 'บัญชีนี้ถูกแบนจากระบบแล้ว' });
    }
    if (db.users.find(u => u.username === username)) {
        return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว' });
    }

    const newUser = {
        id: 'user_' + Date.now(),
        username,
        password: bcrypt.hashSync(password, 10),
        status: 'pending',
        role: 'member',
        facebookUrl,
        birthdate,
        office,
        province,
        nickname,
        details: details || '-'
    };

    db.users.push(newUser);
    writeDB(db);
    res.json({ success: true, message: 'ส่งคำขอสมัครสมาชิกสำเร็จ! กรุณารอแอดมินตรวจสอบข้อมูล' });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    let db = readDB();

    const isBanned = db.bannedUsers.find(b => b.username === username);
    if (isBanned) {
        return res.status(403).json({ success: false, message: `บัญชีของคุณถูกแบน เนื่องจาก: ${isBanned.reason}` });
    }

    const user = db.users.find(u => u.username === username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    if (user.role !== 'admin' && user.status !== 'approved') {
        return res.status(403).json({ success: false, message: 'System : บัญชีของคุณยังไม่ได้รับการอนุมัติจากแอดมิน\nกรุณารอ 15 นาที หรือ สอบถามที่ way2us@hotmail.com' });
    }

    res.json({ success: true, user });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'ไม่พบไฟล์ที่อัปโหลด' });
    res.json({
        success: true,
        fileUrl: `/uploads/${req.file.filename}`,
        originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
        size: req.file.size
    });
});

app.get('/api/admin/data', (req, res) => {
    let db = readDB();
    res.json({
        users: db.users,
        bannedUsers: db.bannedUsers,
        reports: db.reports,
        rooms: db.rooms,
        pendingRooms: db.pendingRooms,
        voiceRooms: db.voiceRooms,
        pendingVoiceRooms: db.pendingVoiceRooms,
        globalMute
    });
});

app.post('/api/admin/action', (req, res) => {
    const { userId, action, reason } = req.body;
    let db = readDB();
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้นี้ในระบบ' });

    if (action === 'approve') {
        user.status = 'approved';
    } else if (action === 'reject') {
        db.users = db.users.filter(u => u.id !== userId);
    } else if (action === 'ban' || action === 'kick') {
        db.bannedUsers.push({ username: user.username, reason: reason || 'ทำผิดกฎแพลตฟอร์ม', time: new Date().toLocaleString() });
        db.users = db.users.filter(u => u.id !== userId);
        io.emit('force-kick', { username: user.username, reason: reason || 'ทำผิดกฎแพลตฟอร์ม' });
    }

    writeDB(db);
    res.json({ success: true, message: 'ดำเนินการสำเร็จ' });
});

app.post('/api/report', (req, res) => {
    const { reporter, roomName, reason } = req.body;
    if (!reason || !String(reason).trim()) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุรายละเอียดปัญหา' });
    }

    let db = readDB();
    const newReport = {
        id: 'rep_' + Date.now(),
        reporter: reporter || 'ไม่ระบุชื่อ',
        roomName: roomName || '-',
        reason,
        time: new Date().toLocaleString()
    };
    db.reports.push(newReport);
    writeDB(db);

    io.emit('admin-report-alert', newReport);
    res.json({ success: true, message: 'ส่งรายงานการละเมิดไปยังผู้ดูแลระบบเรียบร้อยแล้ว' });
});

app.post('/api/admin/room-action', (req, res) => {
    const { action, roomId, roomIds, newName } = req.body;
    let db = readDB();

    if (action === 'delete') {
        db.rooms = db.rooms.filter(r => r.id !== roomId);
        io.emit('force-leave-room', { roomId });
    } else if (action === 'bulk-delete') {
        if (roomIds && Array.isArray(roomIds)) {
            db.rooms = db.rooms.filter(r => !roomIds.includes(r.id));
            roomIds.forEach(id => io.emit('force-leave-room', { roomId: id }));
        }
    } else if (action === 'rename') {
        const room = db.rooms.find(r => r.id === roomId);
        if (room) {
            room.name = newName;
            io.emit('room-renamed', { roomId, newName });
        }
    } else {
        return res.status(400).json({ success: false, message: 'action ไม่ถูกต้อง' });
    }

    writeDB(db);
    activeRooms = db.rooms;
    updateGlobalState();
    res.json({ success: true, rooms: db.rooms });
});

app.post('/api/admin/room-request-action', (req, res) => {
    const { requestId, action } = req.body;
    let db = readDB();

    const reqIndex = db.pendingRooms.findIndex(r => r.id === requestId);
    if (reqIndex === -1) {
        return res.status(404).json({ success: false, message: 'ไม่พบคำขอสร้างห้องนี้' });
    }
    const request = db.pendingRooms[reqIndex];
    db.pendingRooms.splice(reqIndex, 1);

    if (action === 'approve') {
        const newRoom = { id: 'room_' + Date.now(), name: request.name, requestedBy: request.requestedBy };
        db.rooms.push(newRoom);
        writeDB(db);
        activeRooms = db.rooms;
        updateGlobalState();

        const targetSocketId = Object.keys(onlineUsers).find(id => onlineUsers[id].username === request.requestedBy);
        if (targetSocketId) io.to(targetSocketId).emit('room-request-approved', newRoom);

        return res.json({ success: true, message: 'อนุมัติห้องเรียบร้อยแล้ว', room: newRoom });
    } else if (action === 'reject') {
        writeDB(db);
        const targetSocketId = Object.keys(onlineUsers).find(id => onlineUsers[id].username === request.requestedBy);
        if (targetSocketId) io.to(targetSocketId).emit('room-request-rejected', request);

        return res.json({ success: true, message: 'ปฏิเสธคำขอสร้างห้องเรียบร้อยแล้ว' });
    }

    return res.status(400).json({ success: false, message: 'action ไม่ถูกต้อง' });
});

// ===== ห้องเสียง (Voice Room) : จัดการห้อง (แก้ไข/ลบ/เปลี่ยนชื่อ) — ต้องอนุมัติทุกครั้งตอนสร้าง =====
app.post('/api/admin/voice-room-action', (req, res) => {
    const { action, roomId, roomIds, newName } = req.body;
    let db = readDB();

    if (action === 'delete') {
        db.voiceRooms = db.voiceRooms.filter(r => r.id !== roomId);
        io.emit('force-leave-voice-room', { roomId });
    } else if (action === 'bulk-delete') {
        if (roomIds && Array.isArray(roomIds)) {
            db.voiceRooms = db.voiceRooms.filter(r => !roomIds.includes(r.id));
            roomIds.forEach(id => io.emit('force-leave-voice-room', { roomId: id }));
        }
    } else if (action === 'rename') {
        const room = db.voiceRooms.find(r => r.id === roomId);
        if (room) {
            room.name = newName;
            io.emit('voice-room-renamed', { roomId, newName });
        }
    } else {
        return res.status(400).json({ success: false, message: 'action ไม่ถูกต้อง' });
    }

    writeDB(db);
    activeVoiceRooms = db.voiceRooms;
    updateGlobalState();
    res.json({ success: true, voiceRooms: db.voiceRooms });
});

// อนุมัติ/ปฏิเสธคำขอสร้างห้องเสียง (แอดมินต้องอนุมัติทุกครั้ง)
app.post('/api/admin/voice-room-request-action', (req, res) => {
    const { requestId, action } = req.body;
    let db = readDB();

    const reqIndex = db.pendingVoiceRooms.findIndex(r => r.id === requestId);
    if (reqIndex === -1) {
        return res.status(404).json({ success: false, message: 'ไม่พบคำขอสร้างห้องเสียงนี้' });
    }
    const request = db.pendingVoiceRooms[reqIndex];
    db.pendingVoiceRooms.splice(reqIndex, 1);

    if (action === 'approve') {
        const newRoom = { id: 'voice_' + Date.now(), name: request.name, requestedBy: request.requestedBy };
        db.voiceRooms.push(newRoom);
        writeDB(db);
        activeVoiceRooms = db.voiceRooms;
        updateGlobalState();

        const targetSocketId = Object.keys(onlineUsers).find(id => onlineUsers[id].username === request.requestedBy);
        if (targetSocketId) io.to(targetSocketId).emit('voice-room-request-approved', newRoom);

        return res.json({ success: true, message: 'อนุมัติห้องเสียงเรียบร้อยแล้ว', room: newRoom });
    } else if (action === 'reject') {
        writeDB(db);
        const targetSocketId = Object.keys(onlineUsers).find(id => onlineUsers[id].username === request.requestedBy);
        if (targetSocketId) io.to(targetSocketId).emit('voice-room-request-rejected', request);

        return res.json({ success: true, message: 'ปฏิเสธคำขอสร้างห้องเสียงเรียบร้อยแล้ว' });
    }

    return res.status(400).json({ success: false, message: 'action ไม่ถูกต้อง' });
});

app.post('/api/admin/toggle-mute', (req, res) => {
    globalMute = !!req.body.mute;
    io.emit('global-mute-status', { globalMute });
    res.json({ success: true, globalMute });
});

app.post('/api/admin/broadcast', (req, res) => {
    const { message } = req.body;
    if (!message || !String(message).trim()) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อความประกาศ' });
    }
    io.emit('admin-popup', { message });
    res.json({ success: true });
});

// เมลภายใน
app.post('/api/mail/send', mailUpload.array('attachments', 5), (req, res) => {
    const { from, to, subject, body } = req.body;

    if (!from || !to || !subject) {
        deleteAttachmentFiles((req.files || []).map(f => ({ filename: f.filename })));
        return res.status(400).json({ success: false, message: 'กรุณากรอกผู้ส่ง ผู้รับ และหัวข้อให้ครบ' });
    }

    let db = readDB();
    const senderExists = db.users.find(u => u.username === from);
    const recipientExists = db.users.find(u => u.username === to);

    if (!senderExists || !recipientExists) {
        deleteAttachmentFiles((req.files || []).map(f => ({ filename: f.filename })));
        return res.status(404).json({ success: false, message: !senderExists ? 'ไม่พบผู้ส่งในระบบ' : 'ไม่พบผู้รับในระบบ' });
    }

    const attachments = (req.files || []).map(f => ({
        filename: f.filename,
        originalName: Buffer.from(f.originalname, 'latin1').toString('utf8'),
        size: f.size,
        url: `/mail-attachments/${encodeURIComponent(f.filename)}`
    }));

    const newMail = {
        id: 'mail_' + Date.now() + '_' + Math.round(Math.random() * 1e6),
        from,
        to,
        subject,
        body: body || '',
        attachments,
        time: new Date().toLocaleString(),
        read: false,
        senderDeleted: false,
        recipientDeleted: false
    };
    const mailSize = getMailSize(newMail);

    if (getMailUsage(db, to) + mailSize > MAIL_QUOTA || getMailUsage(db, from) + mailSize > MAIL_QUOTA) {
        deleteAttachmentFiles(attachments);
        return res.status(400).json({ success: false, message: 'พื้นที่กล่องจดหมายเต็ม (จำกัด 5GB)' });
    }

    db.mails.push(newMail);
    writeDB(db);

    const targetSocketId = Object.keys(onlineUsers).find(id => onlineUsers[id].username === to);
    if (targetSocketId) {
        io.to(targetSocketId).emit('new-mail', { id: newMail.id, from: newMail.from, subject: newMail.subject, time: newMail.time });
    }

    res.json({ success: true, message: 'ส่งเมลสำเร็จ', mail: newMail });
});

app.get('/api/mail/:username', (req, res) => {
    const { username } = req.params;
    const folder = req.query.folder === 'sent' ? 'sent' : 'inbox';
    let db = readDB();

    let list = folder === 'inbox'
        ? db.mails.filter(m => m.to === username && !m.recipientDeleted)
        : db.mails.filter(m => m.from === username && !m.senderDeleted);

    list = list.slice().reverse();
    res.json({ success: true, folder, mails: list });
});

app.get('/api/mail-usage/:username', (req, res) => {
    const { username } = req.params;
    let db = readDB();
    const used = getMailUsage(db, username);
    res.json({ success: true, used, quota: MAIL_QUOTA, percent: Math.min(100, (used / MAIL_QUOTA) * 100) });
});

app.patch('/api/mail/:mailId/read', (req, res) => {
    const { mailId } = req.params;
    const { username } = req.body;
    let db = readDB();
    const mail = db.mails.find(m => m.id === mailId);

    if (!mail) return res.status(404).json({ success: false, message: 'ไม่พบจดหมาย' });
    if (mail.to !== username) return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เข้าถึง' });

    mail.read = true;
    writeDB(db);
    res.json({ success: true });
});

app.delete('/api/mail/:mailId', (req, res) => {
    const { mailId } = req.params;
    const { username, folder } = req.body;
    let db = readDB();
    const mailIndex = db.mails.findIndex(m => m.id === mailId);

    if (mailIndex === -1) return res.status(404).json({ success: false, message: 'ไม่พบจดหมาย' });
    const mail = db.mails[mailIndex];

    if (folder === 'inbox' && mail.to === username) {
        mail.recipientDeleted = true;
    } else if (folder === 'sent' && mail.from === username) {
        mail.senderDeleted = true;
    } else {
        return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์' });
    }

    if (mail.senderDeleted && mail.recipientDeleted) {
        deleteAttachmentFiles(mail.attachments);
        db.mails.splice(mailIndex, 1);
    }

    writeDB(db);
    res.json({ success: true, message: 'ลบจดหมายเรียบร้อยแล้ว' });
});

let onlineUsers = {};
let activeRooms = [];
let activeVoiceRooms = [];
let roomMembers = {};
let voiceRoomMembers = {}; // { [roomId]: [{ username, nickname, socketId, muted }] }
let userMessageHistory = {};

io.on('connection', (socket) => {
    let db = readDB();
    activeRooms = db.rooms || [];
    activeVoiceRooms = db.voiceRooms || [];

    socket.on('join', (user) => {
        socket.user = user;
        onlineUsers[socket.id] = user;
        updateGlobalState();
    });

    socket.on('create-room', (roomName) => {
        if (!socket.user) return;
        const cleanName = String(roomName || '').trim();
        if (!cleanName) return;

        const newRequest = {
            id: 'req_' + Date.now(),
            name: cleanName,
            requestedBy: socket.user.username,
            time: new Date().toLocaleString()
        };

        let db = readDB();
        db.pendingRooms.push(newRequest);
        writeDB(db);

        socket.emit('room-request-submitted', newRequest);
        io.emit('admin-room-request-alert', newRequest);
    });

    // ===== ขอสร้างห้องเสียง (ต้องรอแอดมินอนุมัติทุกครั้ง) =====
    socket.on('create-voice-room', (roomName) => {
        if (!socket.user) return;
        const cleanName = String(roomName || '').trim();
        if (!cleanName) return;

        const newRequest = {
            id: 'vreq_' + Date.now(),
            name: cleanName,
            requestedBy: socket.user.username,
            time: new Date().toLocaleString()
        };

        let db = readDB();
        db.pendingVoiceRooms.push(newRequest);
        writeDB(db);

        socket.emit('voice-room-request-submitted', newRequest);
        io.emit('admin-voice-room-request-alert', newRequest);
    });

    socket.on('join-room-socket', (roomId) => {
        if (!socket.user) return;
        if (socket.currentRoom && roomMembers[socket.currentRoom]) {
            roomMembers[socket.currentRoom] = roomMembers[socket.currentRoom].filter(u => u.username !== socket.user.username);
            io.to(socket.currentRoom).emit('room-members-update', { roomId: socket.currentRoom, members: roomMembers[socket.currentRoom] });
            socket.leave(socket.currentRoom);
        }

        socket.join(roomId);
        socket.currentRoom = roomId;

        if (!roomMembers[roomId]) roomMembers[roomId] = [];
        if (!roomMembers[roomId].some(u => u.username === socket.user.username)) {
            roomMembers[roomId].push({ username: socket.user.username, nickname: socket.user.nickname });
        }

        io.to(roomId).emit('room-members-update', { roomId, members: roomMembers[roomId] });
    });

    socket.on('room-music-control', (data) => {
        io.to(data.roomId).emit('room-music-sync', data);
    });

    // ===== เข้าห้องเสียง (WebRTC mesh signaling) =====
    socket.on('join-voice-room-socket', (roomId) => {
        if (!socket.user) return;

        // เช็คว่าห้องนี้ถูกอนุมัติแล้วจริง
        const room = activeVoiceRooms.find(r => r.id === roomId);
        if (!room) return socket.emit('error-msg', 'ไม่พบห้องเสียงนี้ หรือยังไม่ได้รับการอนุมัติ');

        // ออกจากห้องเสียงเดิมก่อน (ถ้ามี)
        if (socket.currentVoiceRoom) {
            leaveVoiceRoom(socket);
        }

        socket.join('voice-' + roomId);
        socket.currentVoiceRoom = roomId;

        if (!voiceRoomMembers[roomId]) voiceRoomMembers[roomId] = [];
        const existingMembers = voiceRoomMembers[roomId].slice(); // สมาชิกเดิมก่อนคนใหม่เข้า

        voiceRoomMembers[roomId].push({
            username: socket.user.username,
            nickname: socket.user.nickname,
            socketId: socket.id,
            muted: false
        });

        // แจ้งสมาชิกเดิมในห้องว่ามีคนใหม่เข้ามา (ให้ฝั่งเดิมเป็นผู้ยิง offer หา peer ใหม่)
        socket.to('voice-' + roomId).emit('voice-peer-joined', {
            roomId,
            socketId: socket.id,
            username: socket.user.username,
            nickname: socket.user.nickname
        });

        // ส่งรายชื่อสมาชิกที่มีอยู่ก่อนแล้วกลับไปให้คนที่เพิ่งเข้า (เพื่อเตรียม peer connection)
        socket.emit('voice-existing-peers', { roomId, peers: existingMembers });

        io.to('voice-' + roomId).emit('voice-room-members-update', { roomId, members: voiceRoomMembers[roomId] });
    });

    socket.on('leave-voice-room-socket', () => {
        leaveVoiceRoom(socket);
    });

    // ---- WebRTC signaling relay (ส่งต่อระหว่าง peer ที่ระบุ socketId ปลายทาง) ----
    socket.on('voice-offer', ({ targetSocketId, offer }) => {
        io.to(targetSocketId).emit('voice-offer', { fromSocketId: socket.id, offer });
    });

    socket.on('voice-answer', ({ targetSocketId, answer }) => {
        io.to(targetSocketId).emit('voice-answer', { fromSocketId: socket.id, answer });
    });

    socket.on('voice-ice-candidate', ({ targetSocketId, candidate }) => {
        io.to(targetSocketId).emit('voice-ice-candidate', { fromSocketId: socket.id, candidate });
    });

    socket.on('voice-mute-toggle', ({ muted }) => {
        const roomId = socket.currentVoiceRoom;
        if (!roomId || !voiceRoomMembers[roomId]) return;
        const member = voiceRoomMembers[roomId].find(m => m.socketId === socket.id);
        if (member) member.muted = !!muted;
        io.to('voice-' + roomId).emit('voice-room-members-update', { roomId, members: voiceRoomMembers[roomId] });
    });

    function leaveVoiceRoom(sock) {
        const roomId = sock.currentVoiceRoom;
        if (!roomId) return;

        sock.leave('voice-' + roomId);
        if (voiceRoomMembers[roomId]) {
            voiceRoomMembers[roomId] = voiceRoomMembers[roomId].filter(m => m.socketId !== sock.id);
        }

        sock.to('voice-' + roomId).emit('voice-peer-left', { roomId, socketId: sock.id });
        io.to('voice-' + roomId).emit('voice-room-members-update', { roomId, members: voiceRoomMembers[roomId] || [] });

        sock.currentVoiceRoom = null;
    }

    // ส่งข้อความ พร้อมกำหนด ID และสถานะอ่านแล้ว (read: false)
    socket.on('send-message', (data) => {
        if (!socket.user) return socket.emit('error-msg', 'เซสชันหมดอายุ');
        if (globalMute && socket.user.role !== 'admin') return socket.emit('error-msg', 'ระบบถูกปิดกั้นการส่งข้อความ');

        const username = socket.user.username;
        const now = Date.now();

        if (!userMessageHistory[username]) userMessageHistory[username] = [];
        userMessageHistory[username] = userMessageHistory[username].filter(t => now - t < 1500);
        if (userMessageHistory[username].length >= 3 && socket.user.role !== 'admin') {
            return socket.emit('flood-warning', '⚠️ ส่งข้อความเร็วเกินไป กรุณาเว้นระยะห่าง');
        }
        userMessageHistory[username].push(now);

        let cleanedText = filterBadWords(data.text || '');
        const messageData = {
            id: 'msg_' + Date.now() + '_' + Math.round(Math.random() * 1000),
            sender: socket.user.username,
            nickname: socket.user.nickname,
            text: cleanedText,
            fileUrl: data.fileUrl || null,
            fileName: data.fileName || null,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isDM: data.type === 'dm',
            read: false // สถานะเริ่มต้นยังไม่ได้อ่าน
        };

        if (data.type === 'global') {
            io.emit('message', messageData);
        } else if (data.type === 'room') {
            io.to(data.targetId).emit('message', messageData);
        } else if (data.type === 'dm') {
            const targetSocketId = Object.keys(onlineUsers).find(id => onlineUsers[id].username === data.targetUser);
            if (targetSocketId) {
                io.to(targetSocketId).emit('message', messageData);
            }
            socket.emit('message', messageData);
        }
    });

    // รับอีเวนต์อัปเดตสถานะ "อ่านแล้ว" แบบ LINE
    socket.on('mark-as-read', (data) => {
        // data สามารถส่ง { targetUser, roomId, type } เพื่อแจ้งเตือนฝั่งผู้ส่งว่าข้อความถูกอ่านแล้ว
        io.emit('messages-read-update', { reader: socket.user.username, ...data });
    });

    socket.on('disconnect', () => {
        if (socket.user) {
            delete onlineUsers[socket.id];
            if (socket.currentRoom && roomMembers[socket.currentRoom]) {
                roomMembers[socket.currentRoom] = roomMembers[socket.currentRoom].filter(u => u.username !== socket.user.username);
                io.to(socket.currentRoom).emit('room-members-update', { roomId: socket.currentRoom, members: roomMembers[socket.currentRoom] });
            }
            leaveVoiceRoom(socket);
            updateGlobalState();
        }
    });
});

function updateGlobalState() {
    io.emit('update-users', Object.values(onlineUsers));
    io.emit('room-list', activeRooms);
    io.emit('voice-room-list', activeVoiceRooms);
}

server.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});