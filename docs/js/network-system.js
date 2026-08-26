export class NetworkSystem {
  constructor(onMessageCallback) {
    this.ws = null;
    this.clientId = 'p-' + Math.random().toString(36).substr(2, 9);
    this.roomId = '';
    this.onMessage = onMessageCallback;
    this.onDisconnect = null;
    this.onError = null;
    this.pingInterval = null;
    this.latency = 0;
    // パドル同期のスロットル用（30ms 以内の重複送信を防止）
    this.paddleLastSent = 0;
    // 改善②: onerror → onclose の二重発火によるダブル quitGame を防ぐフラグ
    this.disconnectHandled = false;
  }

  /**
   * WebSocketサーバーへ接続します。
   * @param {string} roomId 部屋ID
   * @param {string} serverAddr ユーザーが手入力したサーバーアドレス (例: http://192.168.1.15:8080)
   */
  connect(roomId, serverAddr) {
    this.roomId = roomId || 'lobby';

    let proto = 'ws:';
    let host = 'localhost:8080'; // デフォルトのフォールバック

    if (serverAddr && serverAddr.trim() !== '') {
      // ユーザーが明示的にサーバーアドレスを指定した場合はそちらを優先する
      try {
        const url = new URL(serverAddr.trim());
        proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
        host = url.host;
        console.log(`Using user-specified server: ${proto}//${host}`);
      } catch (e) {
        console.error('Invalid server address:', serverAddr, e);
        // 不正な形式でもフォールバックで続行
      }
    } else if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      // サーバーアドレス未指定の場合は現在のページのホストに接続
      proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      host = window.location.host;
    } else {
      console.warn('File protocol detected. Falling back to localhost:8080');
    }

    const wsUrl = `${proto}//${host}/ws?room=${this.roomId}&id=${this.clientId}`;
    console.log('Connecting to:', wsUrl);

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('Connected to Game Server');
      // Pingによるレイテンシ測定を開始
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      // 複数メッセージが改行区切りで送られてくる可能性があるため分割して処理
      const lines = event.data.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          // サーバからの内部的なPingレスポンスを処理
          if (msg.type === 'pong') {
            const sendTime = parseInt(msg.payload.sendTime, 10);
            this.latency = Date.now() - sendTime;
            continue;
          }

          // その他のゲームメッセージはコールバックへ
          this.onMessage(msg);
        } catch (e) {
          console.error('Error parsing WS message:', e, line);
        }
      }
    };

    this.ws.onclose = () => {
      console.log('Disconnected from Game Server');
      this.stopPing();
      if (this.onDisconnect) this.onDisconnect();
    };

    this.ws.onerror = (err) => {
      console.error('WS Error:', err);
      if (this.onError) this.onError(err);
    };
  }

  /**
   * サーバーにメッセージを送信します。
   * @param {string} type メッセージタイプ
   * @param {object} payload 送信するオブジェクト
   */
  send(type, payload = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = {
        type: type,
        sender: this.clientId,
        payload: payload
      };
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * 接続を遮断します。
   */
  disconnect() {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  startPing() {
    this.pingInterval = setInterval(() => {
      this.send('ping', { sendTime: Date.now().toString() });
    }, 3000);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
