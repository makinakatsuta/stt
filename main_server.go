//go:build !js

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// アップグレーダーの設定。許容するオリジンをすべて許可します（開発・公開用）。
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// Client は接続された個々のプレイヤーを表します。
type Client struct {
	conn *websocket.Conn // WebSocketコネクション
	send chan []byte     // クライアントへ送信するメッセージのチャネル
	room *Room           // 所属している部屋
	id   string          // プレイヤーID (UUID的な文字列)
	role int             // プレイヤーの役割 (1: サーバー/Player1, 2: レシーバー/Player2)
}

// Message はクライアント間で送受信されるデータの標準フォーマットです。
type Message struct {
	Type    string          `json:"type"`    // メッセージの種類 ("init", "join", "state", "action", etc.)
	Sender  string          `json:"sender"`  // 送信者のID
	Payload json.RawMessage `json:"payload"` // 任意のJSONデータ
}

// Room は対戦が行われる部屋を表します。
type Room struct {
	id         string             // 部屋ID
	players    map[string]*Client // 部屋に参加しているプレイヤー（最大2名）
	register   chan *Client       // 参加用チャネル
	unregister chan *Client       // 退出用チャネル
	broadcast  chan []byte        // ブロードキャスト用チャネル
	mu         sync.Mutex         // 部屋内の排他制御用
}

// NewRoom は新しい対戦部屋を作成します。
func NewRoom(id string) *Room {
	return &Room{
		id:         id,
		players:    make(map[string]*Client),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan []byte),
	}
}

// Run は部屋のイベントループを開始します。登録、退出、メッセージの転送を処理します。
func (r *Room) Run() {
	for {
		select {
		case client := <-r.register:
			r.mu.Lock()
			// 部屋には最大2人まで参加可能
			if len(r.players) < 2 {
				r.players[client.id] = client
				log.Printf("Player %s joined room %s. Total players in room: %d", client.id, r.id, len(r.players))

				// 役割の割り当て (空いている役割を割り当てる)
				role1Taken := false
				for _, p := range r.players {
					if p.role == 1 {
						role1Taken = true
					}
				}
				if !role1Taken {
					client.role = 1
				} else {
					client.role = 2
				}

				// 本人に初期化情報を送信
				initPayload, _ := json.Marshal(map[string]interface{}{
					"role":   client.role,
					"roomId": r.id,
					"id":     client.id,
				})
				client.send <- mustMarshal(Message{Type: "init", Sender: "server", Payload: initPayload})

				// 相手プレイヤーがいる場合は、お互いに相手の参加を通知
				if len(r.players) == 2 {
					log.Printf("Match ready in Room %s! Notifying players...", r.id)
					for _, p := range r.players {
						oppRole := 2
						if p.role == 2 {
							oppRole = 1
						}
						joinPayload, _ := json.Marshal(map[string]interface{}{
							"opponentJoined": true,
							"opponentRole":   oppRole,
						})
						p.send <- mustMarshal(Message{Type: "opponent_joined", Sender: "server", Payload: joinPayload})
					}
				}
			} else {
				// 満員の場合はエラーメッセージを返す
				log.Printf("Room %s is full (currently %d players). Rejecting Player %s", r.id, len(r.players), client.id)
				errPayload, _ := json.Marshal(map[string]string{"message": "Room is full"})
				client.send <- mustMarshal(Message{Type: "error", Sender: "server", Payload: errPayload})
				client.conn.Close()
			}
			r.mu.Unlock()

		case client := <-r.unregister:
			r.mu.Lock()
			if _, ok := r.players[client.id]; ok {
				delete(r.players, client.id)
				close(client.send)
				log.Printf("Player %s left room %s", client.id, r.id)

				// 相手が残っている場合、相手に退出を通知
				for _, p := range r.players {
					leavePayload, _ := json.Marshal(map[string]string{"message": "Opponent disconnected"})
					p.send <- mustMarshal(Message{Type: "opponent_left", Sender: "server", Payload: leavePayload})
				}
			}
			// 部屋が空になったらマネージャー側で削除されるようにします
			r.mu.Unlock()

		case message := <-r.broadcast:
			// メッセージをパースして種類に応じて処理を分岐する
			var msg Message
			if err := json.Unmarshal(message, &msg); err == nil {

				// ping メッセージは broadcast せず、送信者本人に pong を返す
				if msg.Type == "ping" {
					r.mu.Lock()
					if sender, ok := r.players[msg.Sender]; ok {
						pongPayload := msg.Payload // sendTime をそのまま返す
						select {
						case sender.send <- mustMarshal(Message{Type: "pong", Sender: "server", Payload: pongPayload}):
						default:
						}
					}
					r.mu.Unlock()
					continue
				}

				// それ以外は部屋内の全プレイヤーに転送 (送信者以外)
				r.mu.Lock()
				for id, p := range r.players {
					if id != msg.Sender {
						select {
						case p.send <- message:
						default:
							close(p.send)
							delete(r.players, id)
						}
					}
				}
				r.mu.Unlock()
			}
		}
	}
}

// Server はすべての部屋を管理するゲームサーバーです。
type Server struct {
	rooms map[string]*Room // 部屋ID -> 部屋のマップ
	mu    sync.Mutex       // サーバー全体の排他制御用
}

var serverInstance = &Server{
	rooms: make(map[string]*Room),
}

// GetOrCreateRoom は指定されたIDの部屋を取得するか、存在しない場合は新しく作成します。
func (s *Server) GetOrCreateRoom(id string) *Room {
	s.mu.Lock()
	defer s.mu.Unlock()

	room, ok := s.rooms[id]
	if !ok {
		room = NewRoom(id)
		s.rooms[id] = room
		go room.Run() // 部屋ごとのイベントループをゴルーチンで起動
		log.Printf("Created new room: %s", id)
	}
	return room
}

// CleanEmptyRooms は定期的に空になった部屋をクリーンアップしてメモリを節約します。
func (s *Server) CleanEmptyRooms() {
	for {
		time.Sleep(30 * time.Second)
		s.mu.Lock()
		for id, room := range s.rooms {
			room.mu.Lock()
			if len(room.players) == 0 {
				log.Printf("Cleaning up empty room: %s", id)
				delete(s.rooms, id)
				// チャネルのクローズ等はGCに任せます
			}
			room.mu.Unlock()
		}
		s.mu.Unlock()
	}
}

// readPump は WebSocket からメッセージを読み込み、Room のブロードキャストチャネルへ流します。
func (c *Client) readPump() {
	defer func() {
		c.room.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(512 * 1024) // 最大メッセージサイズ
	// ポン応答の設定など、接続維持のヘルスチェックを設定可能ですが、ここではシンプルにします。

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("error: %v", err)
			}
			break
		}

		// メッセージをパースして送信者IDを埋め込む
		var msg Message
		if err := json.Unmarshal(message, &msg); err == nil {
			msg.Sender = c.id
			rawMsg, err := json.Marshal(msg)
			if err == nil {
				c.room.broadcast <- rawMsg
			}
		}
	}
}

// writePump は Client の送信チャネルからメッセージを取り出し、WebSocket へ書き込みます。
func (c *Client) writePump() {
	defer func() {
		c.conn.Close()
	}()
	for {
		select {
		case message, ok := <-c.send:
			if !ok {
				// チャンネルがクローズされた場合は切断処理
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// 詰まっているメッセージがあればまとめて送る
			n := len(c.send)
			for i := 0; i < n; i++ {
				w.Write([]byte{'\n'})
				w.Write(<-c.send)
			}

			if err := w.Close(); err != nil {
				return
			}
		}
	}
}

// serveWs は WebSocket 接続要求をハンドリングします。
func serveWs(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket Upgrade Error:", err)
		return
	}

	// クエリパラメータから部屋IDとプレイヤーIDを取得します。
	// なければ自動でデフォルトルームやランダムな部屋を割り当てます。
	roomId := r.URL.Query().Get("room")
	if roomId == "" {
		roomId = "lobby" // デフォルトのロビー
	}
	clientId := r.URL.Query().Get("id")
	if clientId == "" {
		clientId = fmt.Sprintf("p-%d", time.Now().UnixNano()) // 簡易的なID生成
	}

	log.Printf("Incoming WS Connection: ClientID=%s, RoomID=%s", clientId, roomId)
	room := serverInstance.GetOrCreateRoom(roomId)

	client := &Client{
		conn: conn,
		send: make(chan []byte, 256),
		room: room,
		id:   clientId,
	}

	room.register <- client

	// 読み書きの処理をそれぞれ別ゴルーチンで開始します
	go client.writePump()
	go client.readPump()
}

// ユーティリティ: Message構造体をシリアライズする際のラッパー
func mustMarshal(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		log.Panic(err)
	}
	return b
}

// openBrowser は指定されたURLをシステムのデフォルトブラウザで開きます。
func openBrowser(url string) {
	var err error
	switch runtime.GOOS {
	case "linux":
		err = exec.Command("xdg-open", url).Start()
	case "windows":
		// Windows環境でブラウザを開くコマンド
		err = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		err = exec.Command("open", url).Start()
	default:
		err = fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}
	if err != nil {
		log.Printf("Failed to open browser: %v", err)
	}
}

func main() {
	// 静的ファイルの配信設定 (docs ディレクトリ以下をルートとしてサーブ)
	fs := http.FileServer(http.Dir("./docs"))
	http.Handle("/", fs)

	// WebSocket エンドポイントの登録
	http.HandleFunc("/ws", serveWs)

	// バックグラウンドで空き部屋のクリーンアップ処理を起動
	go serverInstance.CleanEmptyRooms()

	// サーバーの起動
	port := ":8080"
	log.Printf("STT Game Server starting on http://localhost%s", port)

	// サーバーが正常に起動してからブラウザを自動で開く (別スレッド)
	go func() {
		time.Sleep(200 * time.Millisecond) // サーバーソケットが完全にListenするのを待つ
		openBrowser("http://localhost:8080")
	}()

	if err := http.ListenAndServe(port, nil); err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}
