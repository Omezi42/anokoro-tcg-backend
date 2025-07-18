/*
 * Supabase & WebSocket Server: Full Feature Integration
 * Version: 1.3.0 - Bug Fixed & Full Implementation
 * Description: 以前のバージョンで指摘されたバグを修正し、コメントアウトされていた機能を完全に実装しました。
 * - レート計算ロジックを実装。
 * - ユーザーデータ（メモ、戦績、デッキ）の保存・更新APIを実装。
 * - 安定性と堅牢性を向上。
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
const connections = new Map(); // ws -> { wsId, userId, username, matchId, opponentWsId }
const wsIdToWs = new Map();
const userToWsId = new Map();
let waitingPlayers = [];
const spectateRooms = new Map(); // roomId -> { roomId, broadcasterWsId, broadcasterUsername, spectators: Map<wsId, ws> }
const BCRYPT_SALT_ROUNDS = 10;

// =================================================================
// HELPER FUNCTIONS
// =================================================================
async function getUserData(userId) {
    if (!supabase) return null;
    const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).single();
    if (error && error.code !== 'PGRST116') { // PGRST116: no rows returned
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

// キューの人数を全クライアントにブロードキャストする関数
function broadcastQueueCount() {
    const message = JSON.stringify({ type: 'queue_count_update', count: waitingPlayers.length });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
    console.log(`Broadcasted queue count: ${waitingPlayers.length}`);
}

async function tryMatchPlayers() {
    if (waitingPlayers.length < 2) return;
    const player1Id = waitingPlayers.shift();
    const player2Id = waitingPlayers.shift();
    
    const ws1Id = userToWsId.get(player1Id);
    const ws2Id = userToWsId.get(player2Id);
    const ws1 = wsIdToWs.get(ws1Id);
    const ws2 = wsIdToWs.get(ws2Id);

    if (ws1 && ws2 && ws1.readyState === WebSocket.OPEN && ws2.readyState === WebSocket.OPEN) {
        const matchId = uuidv4();
        const conn1 = connections.get(ws1);
        const conn2 = connections.get(ws2);

        conn1.matchId = matchId;
        conn1.opponentWsId = ws2Id;
        conn2.matchId = matchId;
        conn2.opponentWsId = ws1Id;
        
        await updateUserData(player1Id, { currentMatchId: matchId });
        await updateUserData(player2Id, { currentMatchId: matchId });
        await supabase.from('matches').insert([{ match_id: matchId, player1_id: player1Id, player2_id: player2Id }]);

        ws1.send(JSON.stringify({ type: 'match_found', matchId, opponentUserId: player2Id, opponentUsername: conn2.username, isInitiator: true }));
        ws2.send(JSON.stringify({ type: 'match_found', matchId, opponentUserId: player1Id, opponentUsername: conn1.username, isInitiator: false }));
        console.log(`Matched ${conn1.username} with ${conn2.username}`);
        broadcastQueueCount(); // マッチング成功時に更新
    } else {
        if (ws1?.readyState === WebSocket.OPEN) waitingPlayers.unshift(player1Id);
        if (ws2?.readyState === WebSocket.OPEN) waitingPlayers.unshift(player2Id);
        broadcastQueueCount(); // マッチング失敗時（プレイヤーが切断されていた場合など）にも更新
    }
}

function broadcastListUpdate() {
    const broadcastList = Array.from(spectateRooms.values()).map(room => ({
        roomId: room.roomId,
        broadcasterUsername: room.broadcasterUsername
    }));
    const message = JSON.stringify({ type: 'broadcast_list_update', list: broadcastList });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
    console.log(`Broadcast list updated. Sent to ${wss.clients.size} clients.`);
}

wss.on('connection', ws => {
    const wsId = uuidv4();
    connections.set(ws, { wsId, userId: null, username: null, matchId: null, opponentWsId: null });
    wsIdToWs.set(wsId, ws);
    console.log(`Client connected: ${wsId}. Total: ${connections.size}`);
    
    ws.send(JSON.stringify({ type: 'broadcast_list_update', list: Array.from(spectateRooms.values()).map(r => ({ roomId: r.roomId, broadcasterUsername: r.broadcasterUsername })) }));
    broadcastQueueCount(); // 新規接続時に現在のキュー人数を送信

    ws.on('message', async message => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }

        const conn = connections.get(ws);
        if (!conn) return;

        console.log(`MSG from ${conn.username || conn.wsId}: ${data.type}`);

        switch (data.type) {
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
            case 'auto_login':
                const { userId: loginUserId, username: loginUsername, password: loginPassword } = data;
                let userData;
                if (data.type === 'login') {
                    const foundUserId = await getUserIdByUsername(loginUsername);
                    if (!foundUserId) return ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'ユーザー名またはパスワードが間違っています。' }));
                    userData = await getUserData(foundUserId);
                    if (!userData || !(await bcrypt.compare(loginPassword, userData.password_hash))) {
                        return ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'ユーザー名またはパスワードが間違っています。' }));
                    }
                } else { // auto_login
                    userData = await getUserData(loginUserId);
                    if (!userData || userData.username !== loginUsername) {
                        return ws.send(JSON.stringify({ type: 'auto_login_response', success: false, message: '自動ログインに失敗しました。' }));
                    }
                }
                
                conn.userId = userData.user_id;
                conn.username = userData.username;
                userToWsId.set(conn.userId, wsId);
                ws.send(JSON.stringify({ type: `${data.type}_response`, success: true, message: 'ログインしました！', ...formatUserDataForClient(userData) }));
                break;

            case 'logout':
                if (conn.userId) {
                    userToWsId.delete(conn.userId);
                    conn.userId = null;
                    conn.username = null;
                    ws.send(JSON.stringify({ type: 'logout_response', success: true, message: 'ログアウトしました。' }));
                }
                break;

            case 'update_user_data':
                if (!conn.userId) return ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                try {
                    await updateUserData(conn.userId, data);
                    const updatedUserData = await getUserData(conn.userId);
                    ws.send(JSON.stringify({ type: 'update_user_data_response', success: true, message: 'ユーザーデータを更新しました。', userData: formatUserDataForClient(updatedUserData) }));
                } catch (dbErr) {
                    ws.send(JSON.stringify({ type: 'update_user_data_response', success: false, message: 'データベース更新エラー。' }));
                }
                break;

            case 'change_username':
                if (!conn.userId) return ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                const { newUsername } = data;
                if (!newUsername || newUsername.length < 3 || newUsername.length > 15) {
                    return ws.send(JSON.stringify({ type: 'change_username_response', success: false, message: 'ユーザー名は3文字以上15文字以下にしてください。' }));
                }
                try {
                    const { data: existingUser } = await supabase.from('users').select('user_id').eq('username', newUsername).single();
                    if (existingUser && existingUser.user_id !== conn.userId) {
                        return ws.send(JSON.stringify({ type: 'change_username_response', success: false, message: 'そのユーザー名は既に使用されています。' }));
                    }
                    await supabase.from('users').update({ username: newUsername }).eq('user_id', conn.userId);
                    conn.username = newUsername;
                    ws.send(JSON.stringify({ type: 'change_username_response', success: true, newUsername: newUsername, message: 'ユーザー名を変更しました！' }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'change_username_response', success: false, message: 'ユーザー名の変更中にエラーが発生しました。' }));
                }
                break;

            case 'join_queue':
                if (conn.userId && !waitingPlayers.includes(conn.userId)) {
                    waitingPlayers.push(conn.userId);
                    ws.send(JSON.stringify({ type: 'queue_status', message: '対戦相手を検索中です...' }));
                    broadcastQueueCount(); // キュー参加時に更新
                    tryMatchPlayers();
                }
                break;

            case 'leave_queue':
                waitingPlayers = waitingPlayers.filter(id => id !== conn.userId);
                ws.send(JSON.stringify({ type: 'queue_status', message: 'マッチングをキャンセルしました。' }));
                broadcastQueueCount(); // キュー離脱時に更新
                break;

            case 'webrtc_signal':
                if (conn.opponentWsId) {
                    const opponentWs = wsIdToWs.get(conn.opponentWsId);
                    if (opponentWs?.readyState === WebSocket.OPEN) {
                        opponentWs.send(JSON.stringify({ type: 'webrtc_signal', signal: data.signal }));
                    }
                }
                break;

            case 'report_result':
                const { matchId: reportedMatchId, result: reportedResult } = data;
                if (!conn.userId || !reportedMatchId || !reportedResult) return;
                try {
                    const { data: match, error: matchError } = await supabase.from('matches').select('*').eq('match_id', reportedMatchId).single();
                    if (matchError || !match) return;

                    const isPlayer1 = match.player1_id === conn.userId;
                    const updateField = isPlayer1 ? 'player1_report' : 'player2_report';
                    const opponentReportField = isPlayer1 ? 'player2_report' : 'player1_report';
                    const opponentId = isPlayer1 ? match.player2_id : match.player1_id;

                    await supabase.from('matches').update({ [updateField]: reportedResult }).eq('match_id', reportedMatchId);
                    
                    const { data: updatedMatch } = await supabase.from('matches').select('*').eq('match_id', reportedMatchId).single();
                    const opponentReport = updatedMatch[opponentReportField];

                    if (opponentReport) {
                        // Both players have reported, resolve the match
                        const player1Data = await getUserData(match.player1_id);
                        const player2Data = await getUserData(match.player2_id);

                        let p1_result = updatedMatch.player1_report;
                        let p2_result = updatedMatch.player2_report;
                        let p1_newRate = player1Data.rate;
                        let p2_newRate = player2Data.rate;
                        let resolutionMessage = "対戦結果が確定しました！";

                        // Calculate new rates only if reports are consistent (win/loss)
                        if ((p1_result === 'win' && p2_result === 'lose') || (p1_result === 'lose' && p2_result === 'win')) {
                            const K = 32; // Elo K-factor
                            const p1_expected = 1 / (1 + Math.pow(10, (player2Data.rate - player1Data.rate) / 400));
                            const p2_expected = 1 / (1 + Math.pow(10, (player1Data.rate - player2Data.rate) / 400));
                            
                            const p1_score = p1_result === 'win' ? 1 : 0;
                            const p2_score = p2_result === 'win' ? 1 : 0;
                            
                            p1_newRate = Math.round(player1Data.rate + K * (p1_score - p1_expected));
                            p2_newRate = Math.round(player2Data.rate + K * (p2_score - p2_expected));
                        } else {
                            resolutionMessage = "対戦結果の報告が一致しなかったため、レートは変動しません。";
                        }
                        
                        const p1History = [...player1Data.match_history, `${new Date().toLocaleString()} vs ${player2Data.username}: ${p1_result} (${p1_newRate})`];
                        const p2History = [...player2Data.match_history, `${new Date().toLocaleString()} vs ${player1Data.username}: ${p2_result} (${p2_newRate})`];

                        // Update user data in Supabase
                        await updateUserData(match.player1_id, { rate: p1_newRate, currentMatchId: null, matchHistory: p1History });
                        await updateUserData(match.player2_id, { rate: p2_newRate, currentMatchId: null, matchHistory: p2History });
                        
                        // Mark match as resolved
                        await supabase.from('matches').update({ resolved_at: new Date().toISOString(), resolution: p1_result === p2_result ? 'draw/cancel' : 'resolved' }).eq('match_id', reportedMatchId);

                        // Notify both players
                        const ws1 = wsIdToWs.get(userToWsId.get(match.player1_id));
                        const ws2 = wsIdToWs.get(userToWsId.get(match.player2_id));
                        
                        if(ws1) ws1.send(JSON.stringify({ type: 'report_result_response', success: true, message: resolutionMessage, result: 'resolved', myNewRate: p1_newRate, myMatchHistory: p1History }));
                        if(ws2) ws2.send(JSON.stringify({ type: 'report_result_response', success: true, message: resolutionMessage, result: 'resolved', myNewRate: p2_newRate, myMatchHistory: p2History }));

                    } else {
                        ws.send(JSON.stringify({ type: 'report_result_response', success: true, message: '結果を報告しました。相手の報告を待っています。', result: 'pending' }));
                    }
                } catch (reportErr) {
                    console.error("Error reporting result:", reportErr);
                    ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '結果報告中にエラーが発生しました。' }));
                }
                break;

            case 'get_ranking':
                try {
                    const { data: rankingData, error } = await supabase.from('users').select('username, rate').order('rate', { ascending: false }).limit(100);
                    if (error) throw error;
                    ws.send(JSON.stringify({ type: 'ranking_data', success: true, data: rankingData }));
                } catch (err) {
                    console.error("Error fetching ranking:", err);
                    ws.send(JSON.stringify({ type: 'ranking_data', success: false, message: 'ランキングの取得に失敗しました。' }));
                }
                break;

            // Spectate cases remain unchanged
            case 'start_broadcast': {
                if (!conn.userId) break;
                const roomId = `room_${uuidv4().substring(0, 8)}`;
                spectateRooms.set(roomId, { roomId, broadcasterWsId: wsId, broadcasterUsername: conn.username, spectators: new Map() });
                console.log(`Room created: ${roomId} by ${conn.username}`);
                ws.send(JSON.stringify({ type: 'broadcast_started', roomId }));
                broadcastListUpdate();
                break;
            }

            case 'stop_broadcast': {
                const room = spectateRooms.get(data.roomId);
                if (room && room.broadcasterWsId === wsId) {
                    room.spectators.forEach(spectatorWs => {
                        spectatorWs.send(JSON.stringify({ type: 'broadcast_stopped', roomId: data.roomId }));
                    });
                    spectateRooms.delete(data.roomId);
                    console.log(`Room closed: ${data.roomId}`);
                    broadcastListUpdate();
                }
                break;
            }

            case 'join_spectate_room': {
                const room = spectateRooms.get(data.roomId);
                if (room) {
                    room.spectators.set(wsId, ws);
                    const broadcasterWs = wsIdToWs.get(room.broadcasterWsId);
                    if (broadcasterWs) {
                        broadcasterWs.send(JSON.stringify({ type: 'new_spectator', spectatorId: wsId }));
                    }
                }
                break;
            }
            
            case 'webrtc_signal_to_spectator': {
                const room = spectateRooms.get(data.roomId);
                const spectatorWs = room?.spectators.get(data.spectatorId);
                if (spectatorWs) {
                    spectatorWs.send(JSON.stringify({ type: 'broadcast_signal', from: 'broadcaster', signal: data.signal }));
                }
                break;
            }

            case 'webrtc_signal_to_broadcaster': {
                const room = spectateRooms.get(data.roomId);
                const broadcasterWs = wsIdToWs.get(room?.broadcasterWsId);
                if (broadcasterWs) {
                    broadcasterWs.send(JSON.stringify({ type: 'broadcast_signal', from: wsId, signal: data.signal }));
                }
                break;
            }

            case 'get_broadcast_list':
                broadcastListUpdate();
                break;
        }
    });

    ws.on('close', () => {
        const conn = connections.get(ws);
        if (!conn) return;

        let roomToDelete = null;
        let listNeedsUpdate = false;
        spectateRooms.forEach((room, roomId) => {
            if (room.broadcasterWsId === conn.wsId) {
                roomToDelete = roomId;
                listNeedsUpdate = true;
            } else if (room.spectators.has(wsId)) {
                room.spectators.delete(wsId);
                const broadcasterWs = wsIdToWs.get(room.broadcasterWsId);
                if (broadcasterWs) {
                    broadcasterWs.send(JSON.stringify({ type: 'spectator_left', spectatorId: conn.wsId }));
                }
            }
        });
        if (roomToDelete) {
            const room = spectateRooms.get(roomToDelete);
            room.spectators.forEach(spectatorWs => {
                spectatorWs.send(JSON.stringify({ type: 'broadcast_stopped', roomId: roomToDelete }));
            });
            spectateRooms.delete(roomToDelete);
        }
        if (listNeedsUpdate) broadcastListUpdate();

        if (conn.userId) {
            if (userToWsId.get(conn.userId) === conn.wsId) userToWsId.delete(conn.userId);
            waitingPlayers = waitingPlayers.filter(id => id !== conn.userId);
            broadcastQueueCount(); // クライアント切断時に更新
        }
        connections.delete(ws);
        wsIdToWs.delete(wsId);
        console.log(`Client disconnected: ${wsId}. Total: ${connections.size}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
