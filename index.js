// Required modules
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Create an HTTP server
const server = http.createServer((req, res) => {
    // This simple server is just for the WebSocket handshake.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket server is running');
});

// Setup WebSocket server
const wss = new WebSocketServer({ server });

// PostgreSQL connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Global variables
let clients = {}; // Manages connected clients: { ws_id: ws_connection }
let loggedInUsers = {}; // Maps user_id to ws_id for quick lookup: { user_id: ws_id }
let matchmakingQueue = []; // Holds players waiting for a match: [{ ws, userId, deck }]

// --- Database Functions ---

// Ensure necessary tables and columns exist
async function ensureTables() {
    const client = await pool.connect();
    try {
        // Users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP WITH TIME ZONE
            );
        `);
        console.log('Database: Users table ensured.');

        // Add new columns to users table if they don't exist
        const columns = ['memos', 'battle_records', 'registered_decks', 'current_match_id'];
        for (const col of columns) {
            const res = await client.query(`
                SELECT column_name FROM information_schema.columns 
                WHERE table_name='users' AND column_name=$1
            `, [col]);
            if (res.rowCount === 0) {
                let colType = 'JSONB';
                if (col === 'current_match_id') colType = 'VARCHAR(255)';
                await client.query(`ALTER TABLE users ADD COLUMN ${col} ${colType}`);
                console.log(`Database: Column '${col}' added to users table.`);
            }
        }
        console.log('Database: New columns (memos, battle_records, registered_decks, current_match_id) ensured.');
        
        // Matches table
        await client.query(`
            CREATE TABLE IF NOT EXISTS matches (
                id VARCHAR(255) PRIMARY KEY,
                player1_id UUID NOT NULL,
                player2_id UUID NOT NULL,
                player1_username VARCHAR(255),
                player2_username VARCHAR(255),
                player1_deck JSONB,
                player2_deck JSONB,
                game_state JSONB,
                status VARCHAR(50),
                winner_id UUID,
                result_details TEXT,
                created_at TIMESTAMP WITH TIME ZONE,
                ended_at TIMESTAMP WITH TIME ZONE
            );
        `);
        console.log('Database: Matches table ensured.');

    } catch (err) {
        console.error('Error ensuring tables:', err);
    } finally {
        client.release();
    }
}

// Get user data from DB
async function getUserData(userId) {
    try {
        const res = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        if (res.rows.length > 0) {
            return res.rows[0];
        }
        return null;
    } catch (error) {
        console.error(`Database: Error fetching user data for ${userId}:`, error);
        return null;
    }
}

// Update user data in DB
async function updateUserData(userId, userData) {
    try {
        await pool.query(
            `UPDATE users SET 
                memos = $1, 
                battle_records = $2, 
                registered_decks = $3, 
                current_match_id = $4,
                last_login = $5
             WHERE id = $6`,
            [
                JSON.stringify(userData.memos || {}),
                JSON.stringify(userData.battle_records || {}),
                JSON.stringify(userData.registered_decks || []),
                userData.current_match_id,
                new Date(),
                userId
            ]
        );
    } catch (error) {
        console.error(`Database: Error updating user data for ${userId}:`, error);
        // Re-throw the error to be handled by the caller
        throw error;
    }
}

// --- Matchmaking Function ---

/**
 * Tries to match two players from the queue.
 * @param {Array} queue - The matchmaking queue.
 */
async function tryMatchPlayers(queue) {
    // Check if there are enough players in the queue
    if (queue.length >= 2) {
        const player1Data = queue.shift();
        const player2Data = queue.shift();
        const { ws: ws1, userId: userId1, deck: deck1 } = player1Data;
        const { ws: ws2, userId: userId2, deck: deck2 } = player2Data;

        // Get full user data for both players
        const player1 = { ws: ws1, userId: userId1, deck: deck1, userData: await getUserData(userId1) };
        const player2 = { ws: ws2, userId: userId2, deck: deck2, userData: await getUserData(userId2) };

        if (!player1.userData || !player2.userData) {
            console.error("Error: Could not retrieve user data for matchmaking.");
            ws1.send(JSON.stringify({ type: 'error', message: 'Failed to start match: Opponent data missing.' }));
            ws2.send(JSON.stringify({ type: 'error', message: 'Failed to start match: Your data missing.' }));
            // Optional: Put players back in queue if data fetch fails
            // queue.unshift(player2Data);
            // queue.unshift(player1Data);
            return;
        }

        const matchId = `match_${uuidv4()}`;
        console.log(`Match found between ${player1.userData.username} and ${player2.userData.username}. Match ID: ${matchId}`);

        const matchRecord = {
            id: matchId,
            player1_id: player1.userId,
            player2_id: player2.userId,
            player1_username: player1.userData.username,
            player2_username: player2.userData.username,
            player1_deck: player1.deck,
            player2_deck: player2.deck,
            game_state: {}, // Initial game state
            status: 'ongoing',
            created_at: new Date().toISOString()
        };

        try {
            // Insert match record into the database
            await pool.query(
                'INSERT INTO matches (id, player1_id, player2_id, player1_username, player2_username, player1_deck, player2_deck, game_state, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                [matchId, player1.userId, player2.userId, player1.userData.username, player2.userData.username, JSON.stringify(player1.deck), JSON.stringify(player2.deck), JSON.stringify(matchRecord.game_state), matchRecord.status, matchRecord.created_at]
            );
            
            // Generate a safe key for the battle record
            const battleRecordKey = new Date().toISOString();

            // Update Player 1's user data
            player1.userData.current_match_id = matchId;
            if (!player1.userData.battle_records) player1.userData.battle_records = {};
            player1.userData.battle_records[battleRecordKey] = {
                matchId: matchId,
                opponent: player2.userData.username,
                result: 'in_progress',
                deck_used: player1.deck.name,
            };
            await updateUserData(player1.userId, player1.userData);

            // Update Player 2's user data
            player2.userData.current_match_id = matchId;
            if (!player2.userData.battle_records) player2.userData.battle_records = {};
            player2.userData.battle_records[battleRecordKey] = {
                matchId: matchId,
                opponent: player1.userData.username,
                result: 'in_progress',
                deck_used: player2.deck.name,
            };
            await updateUserData(player2.userId, player2.userData);

            // Notify both players that the match is starting
            const goesFirstId = Math.random() < 0.5 ? player1.userId : player2.userId;

            ws1.send(JSON.stringify({
                type: 'match_start',
                matchId: matchId,
                opponent: { userId: player2.userId, username: player2.userData.username },
                yourDeck: player1.deck,
                opponentDeck: player2.deck, // Note: In a real game, you might not send the full deck
                goesFirst: goesFirstId
            }));

            ws2.send(JSON.stringify({
                type: 'match_start',
                matchId: matchId,
                opponent: { userId: player1.userId, username: player1.userData.username },
                yourDeck: player2.deck,
                opponentDeck: player1.deck,
                goesFirst: goesFirstId
            }));

        } catch (error) {
            console.error(`Database: Error during match creation for ${matchId}:`, error);
            ws1.send(JSON.stringify({ type: 'error', message: 'Failed to create match on server.' }));
            ws2.send(JSON.stringify({ type: 'error', message: 'Failed to create match on server.' }));
        }
    }
}


// --- WebSocket Server Logic ---

wss.on('connection', (ws) => {
    const wsId = uuidv4();
    clients[wsId] = ws;
    console.log(`Client connected: ${wsId}. Total active WS: ${Object.keys(clients).length}`);

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Invalid JSON received:', message);
            return;
        }

        console.log(`Message from WS_ID ${wsId} (Type: ${data.type})`);
        const { userId, deck } = data; // Destructure common properties

        switch (data.type) {
            case 'register':
                // Registration logic...
                break;

            case 'login':
                // Login logic...
                break;

            case 'auto_login':
                // Auto-login logic...
                break;

            case 'join_queue':
                if (!userId || !deck) {
                    ws.send(JSON.stringify({ type: 'error', message: 'User ID and deck are required to join queue.' }));
                    return;
                }
                // Add player to the queue
                matchmakingQueue.push({ ws, userId, deck });
                console.log(`User ${userId} joined queue. Current queue: ${matchmakingQueue.length}`);
                
                // Announce queue length to all players in queue
                matchmakingQueue.forEach(player => {
                    player.ws.send(JSON.stringify({
                        type: 'queue_update',
                        queueLength: matchmakingQueue.length
                    }));
                });

                // Attempt to match players
                // FIX: Pass the queue as an argument to the function
                await tryMatchPlayers(matchmakingQueue);
                break;

            case 'leave_queue':
                matchmakingQueue = matchmakingQueue.filter(p => p.userId !== userId);
                console.log(`User ${userId} left queue. Current queue: ${matchmakingQueue.length}`);
                ws.send(JSON.stringify({ type: 'left_queue_success' }));
                break;

            case 'game_action':
                // Game action logic...
                break;
                
            // Add other cases as needed
        }
    });

    ws.on('close', () => {
        // Find user associated with this wsId
        const userId = Object.keys(loggedInUsers).find(key => loggedInUsers[key] === wsId);
        if (userId) {
            delete loggedInUsers[userId];
        }
        delete clients[wsId];
        console.log(`Client disconnected: WS_ID ${wsId}.`);

        // Remove the user from matchmaking queue if they disconnect
        const queueIndex = matchmakingQueue.findIndex(p => p.ws === ws);
        if (queueIndex > -1) {
            matchmakingQueue.splice(queueIndex, 1);
            console.log(`User ${userId} removed from queue due to disconnect. Current queue: ${matchmakingQueue.length}`);
        }
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for client ${wsId}:`, error);
    });
});

// Start the server
const PORT = process.env.PORT || 10000;
server.listen(PORT, async () => {
    console.log('WebSocket server starting...');
    try {
        await ensureTables();
        const client = await pool.connect();
        console.log(`Database connected successfully: ${new Date().toISOString()}`);
        client.release();
    } catch (err) {
        console.error('Failed to connect to database on startup:', err);
        process.exit(1); // Exit if DB connection fails
    }
    console.log(`Server listening on port ${PORT}`);
});
