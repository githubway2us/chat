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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

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
            bannedUsers: [],
            reports: []
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    }
    const data = JSON.parse(fs.readFileSync(DB_FILE));
    if (!data.bannedUsers) data.bannedUsers = [];
    if (!data.reports) data.reports = [];
    if (!data.rooms) data.rooms = [];
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
    res.json({ users: db.users, bannedUsers: db.bannedUsers, reports: db.reports, rooms: db.rooms, globalMute });
});

// เพิ่ม API สำหรับให้แอดมินจัดการอนุมัติ (Approve), ปฏิเสธ (Reject) หรือแบน (Ban) สมาชิก
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

// รับรายงานปัญหาจากผู้ใช้ (ปุ่ม 🚩 รายงานปัญหา ในหน้าเว็บ) บันทึกลง database.json
// และแจ้งเตือนแอดมินที่ออนไลน์อยู่แบบเรียลไทม์ผ่าน socket event 'admin-report-alert'
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

// จัดการห้องสนทนาจากแผงแอดมิน: เปลี่ยนชื่อ / ลบห้องเดียว / ลบหลายห้องพร้อมกัน
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

// เปิด/ปิดการปิดกั้นการส่งข้อความทั้งระบบ (สลับสวิตช์ในแผงแอดมิน)
app.post('/api/admin/toggle-mute', (req, res) => {
    globalMute = !!req.body.mute;
    io.emit('global-mute-status', { globalMute });
    res.json({ success: true, globalMute });
});

// ส่งประกาศแบบป๊อปอัปให้ผู้ใช้ทุกคนที่ออนไลน์อยู่เห็นทันที
app.post('/api/admin/broadcast', (req, res) => {
    const { message } = req.body;
    if (!message || !String(message).trim()) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อความประกาศ' });
    }
    io.emit('admin-popup', { message });
    res.json({ success: true });
});

let onlineUsers = {};
let activeRooms = [];
let roomMembers = {}; 
let userMessageHistory = {};

io.on('connection', (socket) => {
    let db = readDB();
    activeRooms = db.rooms || [];

    socket.on('join', (user) => {
        socket.user = user;
        onlineUsers[socket.id] = user;
        updateGlobalState();
    });

    socket.on('create-room', (roomName) => {
        const newRoom = { id: 'room_' + Date.now(), name: roomName, createdBy: socket.user.username };
        activeRooms.push(newRoom);
        let db = readDB();
        db.rooms = activeRooms;
        writeDB(db);
        updateGlobalState();
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
            sender: socket.user.username,
            nickname: socket.user.nickname,
            text: cleanedText,
            fileUrl: data.fileUrl || null,
            fileName: data.fileName || null,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isDM: data.type === 'dm'
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

    socket.on('disconnect', () => {
        if (socket.user) {
            delete onlineUsers[socket.id];
            if (socket.currentRoom && roomMembers[socket.currentRoom]) {
                roomMembers[socket.currentRoom] = roomMembers[socket.currentRoom].filter(u => u.username !== socket.user.username);
                io.to(socket.currentRoom).emit('room-members-update', { roomId: socket.currentRoom, members: roomMembers[socket.currentRoom] });
            }
            updateGlobalState();
        }
    });
});

function updateGlobalState() {
    io.emit('update-users', Object.values(onlineUsers));
    io.emit('room-list', activeRooms);
}

server.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});