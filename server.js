const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const qrcode = require("qrcode");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static("public"));
app.use(express.json());

let clientConnected = false;
let qrGenerated = false;

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
});

// Handle QR Code Generation
client.on("qr", (qr) => {
    if (clientConnected || qrGenerated) return;
    qrGenerated = true;
    console.log("📌 Scan the QR Code to authenticate.");
    qrcode.toDataURL(qr, (err, url) => {
        if (!err) io.emit("qr", url);
    });
});

// WebSocket Handling
io.on("connection", (socket) => {
    console.log("🟢 Client connected to WebSocket");

    socket.on("getContacts", async ({ page, pageSize }) => {
        try {
            let contacts = await client.getContacts();
            let filteredContacts = contacts
                .filter(c => c.isUser)
                .slice((page - 1) * pageSize, page * pageSize)
                .map(c => ({ name: c.name || "Unknown", number: c.number }));

            socket.emit("contactsList", filteredContacts);
        } catch (err) {
            console.error("❌ Error fetching contacts:", err);
            socket.emit("error", "Failed to fetch contacts");
        }
    });

    socket.on("disconnect", () => {
        console.log("🔴 Client disconnected");
    });
});

// Client Ready Event
client.on("ready", () => {
    console.log("✅ WhatsApp Web is ready!");
    clientConnected = true;
    io.emit("ready");
});

// Authentication Failure
client.on("auth_failure", () => {
    console.log("❌ Authentication failed!");
    io.emit("auth_failure");
    clientConnected = false;
    qrGenerated = false; // Allow re-generating QR
});

// Error Handling
client.on("error", (error) => {
    console.error("❌ WhatsApp Client Error:", error);
    io.emit("error", "WhatsApp client encountered an issue.");
    clientConnected = false;
    qrGenerated = false; // Allow QR regeneration
});

// **✅ FIXED: Send Message API with Personalization & Delay**
app.post("/send", async (req, res) => {
    const { numbers, message, delay = 1000 } = req.body;

    if (!numbers || !message) {
        return res.status(400).json({ error: "Missing parameters" });
    }

    // **Fix: Format numbers before looping**
    const formattedNumbers = numbers.map(num => num.replace(/\D/g, "") + "@c.us");

    console.log(`🚀 Sending messages to: ${formattedNumbers}`);

    formattedNumbers.forEach((number, index) => {
        setTimeout(async () => {
            try {
                await client.sendMessage(number, message);
                console.log(`✅ Sent to ${number}`);
            } catch (err) {
                console.log(`❌ Failed to send to ${number}: ${err.message}`);
            }
        }, index * delay);
    });

    res.json({ success: true, message: "Messages are being sent." });
});


app.get("/list-groups", async (req, res) => {
    try {
        let chats = await client.getChats();
        let groups = chats.filter(chat => chat.isGroup).map(chat => chat.name);
        res.json({ groups });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// **✅ FIXED: send to Group API**
app.post("/send-group", async (req, res) => {
    const { groupName, message } = req.body;

    if (!groupName || !message) {
        return res.status(400).json({ error: "Group name and message required" });
    }

    try {
        let chats = await client.getChats();
        let group = chats.find(chat => chat.isGroup && chat.name.toLowerCase() === groupName.toLowerCase());

        if (!group) {
            return res.status(404).json({ error: `Group '${groupName}' not found` });
        }

        await client.sendMessage(group.id._serialized, message);
        res.json({ success: true, message: `Message sent to ${groupName}` });
    } catch (err) {
        console.error("❌ Error sending group message:", err);
        res.status(500).json({ error: err.message });
    }
});

// **✅ FIXED: Send Media API**
const multer = require("multer");
const path = require("path");
const upload1 = multer({ dest: "uploads/" });
const fs = require("fs");


// Configure multer to preserve the original file name and extension
const storage = multer.diskStorage({
    destination: "uploads/",
    filename: (req, file, cb) => {
        cb(null, file.originalname); // Keep the original filename
    }
});

const upload = multer({ storage });

app.post("/send-media", upload.single("media"), async (req, res) => {
    const { number, caption } = req.body;

    if (!req.file || !number) {
        return res.status(400).json({ error: "Number and media file required" });
    }

    try {
        const formattedNumber = await client.getNumberId(number);
        if (!formattedNumber) {
            return res.status(400).json({ error: "Invalid WhatsApp number" });
        }

        const media = MessageMedia.fromFilePath(req.file.path);
        await client.sendMessage(formattedNumber._serialized, media, { caption });

        // Delete the uploaded file after sending
        fs.unlinkSync(req.file.path);

        res.json({ success: true, message: "Media sent successfully." });
    } catch (err) {
        console.error("❌ Error sending media:", err);
        res.status(500).json({ error: err.message });
    }
});


// **✅ FIXED: Scheduled Messaging**
app.post("/schedule", (req, res) => {
    const { numbers, message, timestamp } = req.body;
    if (!numbers || !message || !timestamp) {
        return res.status(400).json({ error: "Missing parameters" });
    }

    const delay = timestamp - Date.now();
    if (delay <= 0) {
        return res.status(400).json({ error: "Invalid timestamp" });
    }

    const formattedNumbers = numbers.map(num => num.replace(/\D/g, "") + "@c.us");

    setTimeout(() => {
        formattedNumbers.forEach(async (number) => {
            try {
                await client.sendMessage(number, message);
                console.log(`✅ Scheduled message sent to ${number}`);
            } catch (err) {
                console.log(`❌ Failed to send to ${number}: ${err.message}`);
            }
        });
    }, delay);

    res.json({ success: true, message: "Message scheduled successfully." });
});

// **✅ FIXED: Auto-Reconnect Mechanism**
const restartClient = () => {
    console.log("🔄 Restarting WhatsApp Client...");
    client.destroy().then(() => {
        client.initialize();
    }).catch((error) => {
        console.error("❌ Error restarting client:", error);
    });
};

// Reconnect on Client Disconnection
client.on("disconnected", (reason) => {
    console.error(`⚠️ Client disconnected: ${reason}`);
    clientConnected = false;
    qrGenerated = false;
    setTimeout(restartClient, 5000); // Auto-reconnect after 5s
});

// Start the Server
server.listen(8000, () => {
    console.log("🚀 Server running on http://localhost:8000");
});

// Start WhatsApp Client
client.initialize();
