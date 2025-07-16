/*
 * Supabase & WebSocket Server: Full Feature Integration
 * This file integrates all features: User Authentication, Rate Matchmaking,
 * 1-on-1 WebRTC Chat, and the global Spectator Mode with a live broadcast list.
 * Version: Complete, Stable & Corrected Data Mapping
 */

const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

// --- Supabase Setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are not set.');
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
console.log('Supabase client initialized.');

// --- Server Setup ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket server with Supabase is running.');
});
const wss = new WebSocket.Server({ server });
console.log('WebSocket server starting...');

// --- In-memory State Management ---
let waitingPlayers = []; // Array for players waiting for a match
const activeConnections = new Map(); // ws -> { ws_id, user_id, username, opponent_ws_id, lastOffer }
const wsIdToWs = new Map(); // ws_id -> ws
const userToWsId = new Map(); // user_id -> ws_id
const spectateRooms = new Map(); // roomId -> { broadcaster: ws, broadcasterUsername: string, spectators: Set<ws> }
const BCRYPT_SALT_ROUNDS = 10;

// =================================================================
// HELPER FUNCTIONS
// =================================================================
async function getUserData(userId) {
    if (!supabase) return null;
    const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).single();
    if (error) {
        console.error(`Error getting user data for ${userId}:`, error.message);
        return null;
    }
    return data;
}

async function updateUserData(userId, updatePayload) {
    if (!supabase) return;
    const updateObject = {};
    if (updatePayload.rate !== undefined) updateObject.rate = updatePayload.rate;
    if (updatePayload.matchHistory !== undefined) updateObject.match_history = updatePayload.matchHistory;
    if (updatePayload.memos !== undefined) updateObject.memos = updatePayload.memos;
    if (updatePayload.battleRecords !== undefined) updateObject.battle_records = updatePayload.battleRecords;
    if (updatePayload.registeredDecks !== undefined) updateObject.registered_decks = updatePayload.registeredDecks;
    if (updatePayload.hasOwnProperty('currentMatchId')) updateObject.current_match_id = updatePayload.currentMatchId;
    if (Object.keys(updateObject).length === 0) return;
    const { error } = await supabase.from('users').update(updateObject).eq('user_id', userId);
    if (error) {
        console.error(`Error updating user data for ${userId}:`, error.message);
        throw error;
    }
}

async function registerNewUser(userId, username, passwordHash) {
    if (!supabase) throw new Error('Supabase client not configured.');
    const { error } = await supabase.from('users').insert([{
        user_id: userId, username: username, password_hash: passwordHash,
        rate: 1500, match_history: [], memos: [], battle_records: [], registered_decks: [], current_match_id: null
    }]);
    if (error) {
        console.error('Error registering new user:', error.message);
        throw error;
    }
}

async function getUserIdByUsername(username) {
    if (!supabase) return null;
    const { data, error } = await supabase.from('users').select('user_id').eq('username', username).single();
    if (error && error.code !== 'PGRST116') console.error(`Error getting user id for ${username}:`, error.message);
    return data ? data.user_id : null;
}

async function getUsernameByUserId(userId) {
    if (!supabase) return null;
    const { data, error } = await supabase.from('users').select('username').eq('user_id', userId).single();
    if (error && error.code !== 'PGRST116') console.error(`Error getting username for ${userId}:`, error.message);
    return data ? data.username : null;
}

function formatUserDataForClient(dbData) {
    if (!dbData) return null;
    return {
        userId: dbData.user_id,
        username: dbData.username,
        rate: dbData.rate,
        matchHistory: dbData.match_history || [],
        memos: dbData.memos || [],
        battleRecords: dbData.battle_records || [],
        registeredDecks: dbData.registered_decks || [],
        currentMatchId: dbData.current_match_id
    };
}

async function tryMatchPlayers() {
    if (waitingPlayers.length < 2) return;
    const player1UserId = waitingPlayers.shift();
    const player2UserId = waitingPlayers.shift();
    const ws1Id = userToWsId.get(player1UserId);
    const ws2Id = userToWsId.get(player2UserId);
    const ws1 = wsIdToWs.get(ws1Id);
    const ws2 = wsIdToWs.get(ws2Id);

    if (ws1 && ws2 && ws1.readyState === WebSocket.OPEN && ws2.readyState === WebSocket.OPEN) {
        const matchId = uuidv4();
        const player1Username = await getUsernameByUserId(player1UserId);
        const player2Username = await getUsernameByUserId(player2UserId);
        activeConnections.get(ws1).opponent_ws_id = ws2Id;
        activeConnections.get(ws2).opponent_ws_id = ws1Id;
        await updateUserData(player1UserId, { currentMatchId: matchId });
        await updateUserData(player2UserId, { currentMatchId: matchId });
        const { error: matchInsertError } = await supabase.from('matches').insert([{ match_id: matchId, player1_id: player1UserId, player2_id: player2UserId }]);
        if (matchInsertError) {
            console.error('Error inserting new match:', matchInsertError.message);
            waitingPlayers.unshift(player1UserId, player2UserId);
            return;
        }
        ws1.send(JSON.stringify({ type: 'match_found', matchId, opponentUserId: player2UserId, opponentUsername: player2Username, isInitiator: true }));
        ws2.send(JSON.stringify({ type: 'match_found', matchId, opponentUserId: player1UserId, opponentUsername: player1Username, isInitiator: false }));
        console.log(`Matched ${player1Username} with ${player2Username}`);
    } else {
        if (ws1 && ws1.readyState === WebSocket.OPEN) waitingPlayers.unshift(player1UserId);
        if (ws2 && ws2.readyState === WebSocket.OPEN) waitingPlayers.unshift(player2UserId);
    }
}

function broadcastListUpdate() {
    const broadcastList = [];
    spectateRooms.forEach((room, roomId) => {
        broadcastList.push({
            roomId: roomId,
            broadcasterUsername: room.broadcasterUsername
        });
    });
    const message = JSON.stringify({ type: 'broadcast_list_update', list: broadcastList });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
    console.log(`Broadcast list updated. Sending to ${wss.clients.size} clients.`);
}

// =================================================================
// WEBSOCKET CONNECTION HANDLING
// =================================================================
wss.on('connection', ws => {
    const wsId = uuidv4();
    activeConnections.set(ws, { ws_id: wsId, user_id: null, username: null, opponent_ws_id: null, lastOffer: null });
    wsIdToWs.set(wsId, ws);
    console.log(`Client connected: ${wsId}. Total: ${activeConnections.size}`);
    
    const initialList = [];
    spectateRooms.forEach((room, roomId) => {
        initialList.push({ roomId: roomId, broadcasterUsername: room.broadcasterUsername });
    });
    ws.send(JSON.stringify({ type: 'broadcast_list_update', list: initialList }));


    ws.on('message', async message => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error("Failed to parse message:", message);
            return;
        }

        const senderInfo = activeConnections.get(ws);
        if (!senderInfo) return;

        console.log(`Message from WS_ID ${senderInfo.ws_id} (User: ${senderInfo.username || 'Guest'}) (Type: ${data.type})`);

        switch (data.type) {
            // --- User Auth & Data ---
            case 'register':
                const { username: regUsername, password: regPassword } = data;
                if (!regUsername || !regPassword) return ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'ユーザー名とパスワードを入力してください。' }));
                const existingUserId = await getUserIdByUsername(regUsername);
                if (existingUserId) return ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'このユーザー名は既に使われています。' }));
                const hashedPassword = await bcrypt.hash(regPassword, BCRYPT_SALT_ROUNDS);
                const newUserId = uuidv4();
                try {
                    await registerNewUser(newUserId, regUsername, hashedPassword);
                    ws.send(JSON.stringify({ type: 'register_response', success: true, message: 'アカウント登録が完了しました！ログインしてください。' }));
                } catch (dbErr) {
                    ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'データベースエラーにより登録できませんでした。' }));
                }
                break;

            case 'login':
                const { username: loginUsername, password: loginPassword } = data;
                const userIdFromUsername = await getUserIdByUsername(loginUsername);
                if (!userIdFromUsername) return ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'ユーザー名またはパスワードが間違っています。' }));
                const storedUserData = await getUserData(userIdFromUsername);
                if (!storedUserData || !(await bcrypt.compare(loginPassword, storedUserData.password_hash))) {
                    return ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'ユーザー名またはパスワードが間違っています。' }));
                }
                senderInfo.user_id = storedUserData.user_id;
                senderInfo.username = storedUserData.username;
                userToWsId.set(storedUserData.user_id, senderInfo.ws_id);
                ws.send(JSON.stringify({ type: 'login_response', success: true, message: 'ログインしました！', ...formatUserDataForClient(storedUserData) }));
                break;
            
            case 'auto_login':
                const { userId: autoLoginUserId, username: autoLoginUsername } = data;
                if (!autoLoginUserId || !autoLoginUsername) return ws.send(JSON.stringify({ type: 'auto_login_response', success: false, message: '自動ログイン情報が不足しています。' }));
                const autoLoginUserData = await getUserData(autoLoginUserId);
                if (autoLoginUserData && autoLoginUserData.username === autoLoginUsername) {
                    senderInfo.user_id = autoLoginUserData.user_id;
                    senderInfo.username = autoLoginUserData.username;
                    userToWsId.set(autoLoginUserData.user_id, senderInfo.ws_id);
                    ws.send(JSON.stringify({ type: 'auto_login_response', success: true, message: '自動ログインしました！', ...formatUserDataForClient(autoLoginUserData) }));
                } else {
                    ws.send(JSON.stringify({ type: 'auto_login_response', success: false, message: '自動ログインに失敗しました。' }));
                }
                break;

            case 'logout':
                if (senderInfo.user_id) {
                    userToWsId.delete(senderInfo.user_id);
                    senderInfo.user_id = null;
                    senderInfo.username = null;
                    ws.send(JSON.stringify({ type: 'logout_response', success: true, message: 'ログアウトしました。' }));
                }
                break;

            case 'update_user_data':
                if (!senderInfo.user_id) return ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                try {
                    await updateUserData(senderInfo.user_id, data);
                    const updatedUserData = await getUserData(senderInfo.user_id);
                    ws.send(JSON.stringify({ type: 'update_user_data_response', success: true, message: 'ユーザーデータを更新しました。', userData: formatUserDataForClient(updatedUserData) }));
                } catch (dbErr) {
                    ws.send(JSON.stringify({ type: 'update_user_data_response', success: false, message: 'データベース更新エラー。' }));
                }
                break;

            case 'change_username':
                if (!senderInfo.user_id) return ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                const { newUsername } = data;
                if (!newUsername || newUsername.length < 3 || newUsername.length > 15) {
                    return ws.send(JSON.stringify({ type: 'change_username_response', success: false, message: 'ユーザー名は3文字以上15文字以下にしてください。' }));
                }
                try {
                    const { data: existingUser } = await supabase.from('users').select('user_id').eq('username', newUsername).single();
                    if (existingUser && existingUser.user_id !== senderInfo.user_id) {
                        return ws.send(JSON.stringify({ type: 'change_username_response', success: false, message: 'そのユーザー名は既に使用されています。' }));
                    }
                    await supabase.from('users').update({ username: newUsername }).eq('user_id', senderInfo.user_id);
                    senderInfo.username = newUsername; // Update cached username
                    ws.send(JSON.stringify({ type: 'change_username_response', success: true, newUsername: newUsername, message: 'ユーザー名を変更しました！' }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'change_username_response', success: false, message: 'ユーザー名の変更中にエラーが発生しました。' }));
                }
                break;

            // --- Matchmaking & Rate Match ---
            case 'join_queue':
                if (!senderInfo.user_id) return ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                if (!waitingPlayers.includes(senderInfo.user_id)) {
                    waitingPlayers.push(senderInfo.user_id);
                    ws.send(JSON.stringify({ type: 'queue_status', message: '対戦相手を検索中です...' }));
                    tryMatchPlayers();
                }
                break;

            case 'leave_queue':
                waitingPlayers = waitingPlayers.filter(id => id !== senderInfo.user_id);
                ws.send(JSON.stringify({ type: 'queue_status', message: 'マッチングをキャンセルしました。' }));
                break;

            case 'webrtc_signal': // For 1-on-1 match chat
                if (!senderInfo.user_id || !senderInfo.opponent_ws_id) return;
                const opponentWs = wsIdToWs.get(senderInfo.opponent_ws_id);
                if (opponentWs && opponentWs.readyState === WebSocket.OPEN) {
                    opponentWs.send(JSON.stringify({ type: 'webrtc_signal', senderUserId: senderInfo.user_id, signal: data.signal }));
                }
                break;

            case 'report_result':
                const { matchId: reportedMatchId, result: reportedResult } = data;
                if (!senderInfo.user_id || !reportedMatchId || !reportedResult) return ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '報告情報が不足しています。' }));
                try {
                    const { data: match, error: matchError } = await supabase.from('matches').select('*').eq('match_id', reportedMatchId).single();
                    if (matchError || !match) return ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '無効なマッチIDです。' }));

                    const reporterIsPlayer1 = (match.player1_id === senderInfo.user_id);
                    const reporterIsPlayer2 = (match.player2_id === senderInfo.user_id);
                    if (!reporterIsPlayer1 && !reporterIsPlayer2) return ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: 'このマッチに参加していません。' }));
                    
                    const updateField = reporterIsPlayer1 ? 'player1_report' : 'player2_report';
                    const opponentReportField = reporterIsPlayer1 ? 'player2_report' : 'player1_report';
                    const opponentId = reporterIsPlayer1 ? match.player2_id : match.player1_id;

                    if ((reporterIsPlayer1 && match.player1_report) || (reporterIsPlayer2 && match.player2_report)) {
                        return ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '既に結果を報告済みです。' }));
                    }

                    await supabase.from('matches').update({ [updateField]: reportedResult }).eq('match_id', reportedMatchId);
                    console.log(`User ${senderInfo.user_id} reported ${reportedResult} for match ${reportedMatchId}.`);
                    
                    const { data: updatedMatch } = await supabase.from('matches').select('*').eq('match_id', reportedMatchId).single();
                    const opponentReport = updatedMatch[opponentReportField];

                    if (opponentReport) {
                        let resolutionMessage = '';
                        const myUserData = await getUserData(senderInfo.user_id);
                        const opponentUserData = await getUserData(opponentId);
                        let myNewRate = myUserData.rate;
                        let opponentNewRate = opponentUserData.rate;
                        let myMatchHistory = myUserData.match_history || [];
                        let opponentMatchHistory = opponentUserData.match_history || [];
                        const timestamp = new Date().toLocaleString();

                        if (reportedResult === 'cancel' && opponentReport === 'cancel') {
                            resolutionMessage = 'resolved_cancel';
                            myMatchHistory.unshift(`${timestamp} - 対戦中止 vs ${opponentUserData.username}`);
                            opponentMatchHistory.unshift(`${timestamp} - 対戦中止 vs ${myUserData.username}`);
                        } else if ((reportedResult === 'win' && opponentReport === 'lose') || (reportedResult === 'lose' && opponentReport === 'win')) {
                            resolutionMessage = 'resolved_consistent';
                            const K_FACTOR = 32;
                            const myExpectedScore = 1 / (1 + Math.pow(10, (opponentUserData.rate - myUserData.rate) / 400));
                            const myActualScore = (reportedResult === 'win') ? 1 : 0;
                            const myRateChange = Math.round(K_FACTOR * (myActualScore - myExpectedScore));
                            myNewRate = myUserData.rate + myRateChange;
                            opponentNewRate = opponentUserData.rate - myRateChange;
                            if (reportedResult === 'win') {
                                myMatchHistory.unshift(`${timestamp} - 勝利 vs ${opponentUserData.username} (レート: ${myUserData.rate} → ${myNewRate})`);
                                opponentMatchHistory.unshift(`${timestamp} - 敗北 vs ${myUserData.username} (レート: ${opponentUserData.rate} → ${opponentNewRate})`);
                            } else {
                                myMatchHistory.unshift(`${timestamp} - 敗北 vs ${opponentUserData.username} (レート: ${myUserData.rate} → ${myNewRate})`);
                                opponentMatchHistory.unshift(`${timestamp} - 勝利 vs ${myUserData.username} (レート: ${opponentUserData.rate} → ${opponentNewRate})`);
                            }
                        } else {
                            resolutionMessage = 'disputed';
                            myMatchHistory.unshift(`${timestamp} - 結果不一致 vs ${opponentUserData.username}`);
                            opponentMatchHistory.unshift(`${timestamp} - 結果不一致 vs ${myUserData.username}`);
                        }

                        await supabase.from('matches').update({ resolved_at: new Date().toISOString() }).eq('match_id', reportedMatchId);
                        await updateUserData(senderInfo.user_id, { rate: myNewRate, matchHistory: myMatchHistory, currentMatchId: null });
                        await updateUserData(opponentId, { rate: opponentNewRate, matchHistory: opponentMatchHistory, currentMatchId: null });

                        const responseToReporter = { type: 'report_result_response', success: true, message: `結果が確定しました`, result: resolutionMessage, myNewRate, myMatchHistory };
                        ws.send(JSON.stringify(responseToReporter));

                        const opponentWsInstance = wsIdToWs.get(userToWsId.get(opponentId));
                        if (opponentWsInstance && opponentWsInstance.readyState === WebSocket.OPEN) {
                            const responseToOpponent = { type: 'report_result_response', success: true, message: `対戦相手が結果を報告し、結果が確定しました`, result: resolutionMessage, myNewRate: opponentNewRate, myMatchHistory: opponentMatchHistory };
                            opponentWsInstance.send(JSON.stringify(responseToOpponent));
                        }
                        console.log(`Match ${reportedMatchId} resolved: ${resolutionMessage}`);
                    } else {
                        ws.send(JSON.stringify({ type: 'report_result_response', success: true, message: '結果を報告しました。相手の報告を待っています。', result: 'pending' }));
                    }
                } catch (reportErr) {
                    ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '結果報告中にエラーが発生しました。' }));
                }
                break;

            case 'clear_match_info':
                senderInfo.opponent_ws_id = null;
                if (senderInfo.user_id) await updateUserData(senderInfo.user_id, { currentMatchId: null });
                break;

            case 'get_ranking':
                try {
                    const { data: rankingData } = await supabase.from('users').select('username, rate').order('rate', { ascending: false }).limit(10);
                    ws.send(JSON.stringify({ type: 'ranking_data', success: true, data: rankingData }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'ranking_data', success: false, message: 'ランキングの取得に失敗しました。' }));
                }
                break;

            // --- Spectator Mode Cases ---
            case 'start_broadcast':
                if (!senderInfo.user_id || !senderInfo.username) {
                    return ws.send(JSON.stringify({ type: 'error', message: '配信を開始するにはログインが必要です。' }));
                }
                const newRoomId = `room_${uuidv4().substring(0, 8)}`;
                spectateRooms.set(newRoomId, { broadcaster: ws, broadcasterUsername: senderInfo.username, spectators: new Set() });
                console.log(`Room created: ${newRoomId} by ${senderInfo.username}`);
                ws.send(JSON.stringify({ type: 'broadcast_started', roomId: newRoomId }));
                broadcastListUpdate();
                break;

            case 'stop_broadcast':
                if (spectateRooms.has(data.roomId)) {
                    spectateRooms.get(data.roomId).spectators.forEach(spectatorWs => {
                        if (spectatorWs.readyState === WebSocket.OPEN) {
                            spectatorWs.send(JSON.stringify({ type: 'broadcast_stopped', roomId: data.roomId, message: '配信者が配信を終了しました。' }));
                        }
                    });
                    spectateRooms.delete(data.roomId);
                    console.log(`Room closed: ${data.roomId}`);
                    broadcastListUpdate();
                }
                break;

            case 'join_spectate_room':
                const roomToJoin = spectateRooms.get(data.roomId);
                if (roomToJoin) {
                    roomToJoin.spectators.add(ws);
                    console.log(`${senderInfo.ws_id} joined room ${data.roomId}`);
                    const broadcasterWs = roomToJoin.broadcaster;
                    const broadcasterInfo = activeConnections.get(broadcasterWs);
                    if(broadcasterInfo && broadcasterInfo.lastOffer) {
                         ws.send(JSON.stringify({ type: 'spectate_signal', roomId: data.roomId, signal: { offer: broadcasterInfo.lastOffer } }));
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: '指定された観戦ルームが見つかりません。' }));
                }
                break;
            
            case 'leave_spectate_room':
                 const roomToLeave = spectateRooms.get(data.roomId);
                 if (roomToLeave) roomToLeave.spectators.delete(ws);
                 break;

            case 'spectate_signal':
                const room = spectateRooms.get(data.roomId);
                if (!room) break;
                if (ws === room.broadcaster) {
                    if(data.signal.offer) activeConnections.get(ws).lastOffer = data.signal.offer;
                    room.spectators.forEach(spectatorWs => {
                        if (spectatorWs.readyState === WebSocket.OPEN) spectatorWs.send(JSON.stringify({ type: 'spectate_signal', roomId: data.roomId, signal: data.signal }));
                    });
                } else if (room.spectators.has(ws)) {
                    if (room.broadcaster.readyState === WebSocket.OPEN) room.broadcaster.send(JSON.stringify({ type: 'spectate_signal', roomId: data.roomId, signal: data.signal }));
                }
                break;
            
            case 'get_broadcast_list':
                broadcastListUpdate();
                break;

            default:
                console.warn(`Unknown message type: ${data.type}`);
        }
    });

    ws.on('close', () => {
        const senderInfo = activeConnections.get(ws);
        if (!senderInfo) return;

        let listNeedsUpdate = false;
        spectateRooms.forEach((room, roomId) => {
            if (ws === room.broadcaster) {
                console.log(`Broadcaster for room ${roomId} disconnected. Closing room.`);
                room.spectators.forEach(sWs => {
                    if (sWs.readyState === WebSocket.OPEN) sWs.send(JSON.stringify({ type: 'broadcast_stopped', roomId, message: '配信者が切断しました。' }));
                });
                spectateRooms.delete(roomId);
                listNeedsUpdate = true;
            } else if (room.spectators.has(ws)) {
                room.spectators.delete(ws);
            }
        });
        if(listNeedsUpdate) broadcastListUpdate();

        if (senderInfo.user_id) {
            if (userToWsId.get(senderInfo.user_id) === senderInfo.ws_id) userToWsId.delete(senderInfo.user_id);
            waitingPlayers = waitingPlayers.filter(id => id !== senderInfo.user_id);
        }
        activeConnections.delete(ws);
        wsIdToWs.delete(senderInfo.ws_id);
        console.log(`Client disconnected: ${senderInfo.ws_id}. Total: ${activeConnections.size}`);
    });

    ws.on('error', (error) => console.error(`WebSocket error:`, error));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
