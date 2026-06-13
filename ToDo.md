# サウンドテーブルテニス (STT) ゲーム開発 ToDo リスト (Goバックエンド版)

サウンドテーブルテニス（STT）の公式ルールに準拠し、Go（WebSocket）バックエンドとWeb Audio API（フロントエンド）を組み合わせた、オンライン対戦も可能なブラウザゲームの開発ToDoリストです。

## [x] 1. プロジェクトの初期設定
- [x] 1.1 `go.mod` の初期化と依存ライブラリ (`github.com/gorilla/websocket` 等) の導入
- [x] 1.2 ライセンスファイル (`LICENSE`) の作成 (MITライセンス)
- [x] 1.3 `README.md` の作成 (プロジェクト概要、起動方法、Go/JSの構成説明)
- [x] 1.4 `ToDo.md` の更新 (このファイル)

## [x] 2. Goバックエンドの構築
- [x] 2.1 静的ファイル (フロントエンド) をサーブするHTTPサーバーの実装
- [x] 2.2 WebSocketハンドラーの実装 (接続管理、ルーム作成・マッチング機能)
- [x] 2.3 オンライン対戦時のゲームステート同期プロトコルの設計 (JSON形式など)
  - [x] 2.3.1 プレイヤーの準備完了、「いきます」「はい」の発声同期
  - [x] 2.3.2 ボールの位置・速度、ラケット位置の同期
  - [x] 2.3.3 スコア、サーブ権、フォルトなどの判定同期

## [x] 3. フロントエンド HTML/CSS の土台作成
- [x] 3.1 セマンティックなHTML構造の設計 (スクリーンリーダー対応、ARIA属性)
- [x] 3.2 プレミアムデザインのCSS作成 (ダークモード、ネオン調のテーブル、レスポンシブ対応)
- [x] 3.3 モード選択画面 (「CPU対戦」「オンライン対戦」) および操作説明画面の構築

## [x] 4. Web Audio API 音響システムの構築 (フロントエンド)
- [x] 4.1 `AudioContext` と音響生成クラスの初期化
- [x] 4.2 金属球入りボールの転がり音 (ループ音) の合成 (シャラシャラ音)
- [x] 4.3 打球音 (木製ラケットの「コン」) およびフレーム衝突音 (「カツ」) の合成
- [x] 4.6 打球音（「コン」）の音響調整（サイン波・三角波の二重オシレーター化、ゲインとアタックエンベロープの最適化により明瞭度を強化）
- [x] 4.4 ネット接触音・アウト・停止などの効果音合成
- [x] 4.5 `PannerNode` を用いた3次元音響 (左右のパン、および音量/フィルターによる奥行きの定位) の実装
- [x] 4.7 プレイヤーの移動音（足音）の合成（シューズの床摩擦音「キュッキュッ」）の追加

## [x] 5. ゲーム物理とオンライン同期の実装
- [x] 5.1 ローカルCPU戦用の物理エンジン (ボールの摩擦、速度、衝突判定) の実装
- [x] 5.2 オンライン対戦用のWebSocketクライアントの実装 (Goサーバーとのデータ送受信、レイテンシ補正)
- [x] 5.3 STT公式ルールに基づくゲームフローの実装 (「いきます」「はい」の制限時間、デュース、マッチ勝敗判定)
- [x] 5.4 3ゲームス2セット先取マッチへのルール変更（ゲームカウント管理・リセット処理、スコアボードへのゲームカウント表示の追加）

## [x] 6. アクセシビリティ (スクリーンリーダー対応) と音声合成
- [x] 6.1 Web Speech API (`SpeechSynthesis`) による実況・審判コールの実装 (「プレー」「フォルト」「ポイント」などの自動発声)
- [x] 6.2 キーボードによる完全操作対応 (左右矢印キーでのみラケットが移動可能であることを確認・制限、スペースキーでサーブ・返答などのアクション)
- [x] 6.3 画面の読み上げ補助 (`aria-live`, `tabindex` の最適化)

## [x] 7. 健常者向けビジュアル表現の強化
- [x] 7.1 Canvas を用いたリアルタイム描画 (テーブル、ボール、ラケットの美麗な描画)
- [x] 7.2 音波エフェクト (衝突時の波紋、ボールの光る軌跡) の追加
- [x] 7.3 視覚的なスコアボードおよび通信状態 (Ping) インジケータ
- [x] 7.4 STT公式コート規格・寸法ガイドの可視化 (Canvas上のネオン寸法線およびネット断面図、右側サイドパネルでのSVG図解)

## [x] 8. テストと公開準備
- [x] 8.1 ローカル環境でのGoサーバー起動と複数ブラウザ接続テスト
- [x] 8.2 スクリーンリーダー環境での操作性と音響効果の最終調整
- [x] 8.3 コードコメントの徹底整理 (Go/JS両方の可読性向上)

## [x] 9. オンライン対戦バグ修正 (2026-06-03)

調査の結果、オンライン対戦が正常に動作しない原因として以下の4件のバグを発見・修正した。

- [x] 9.1 **[server] ping/pong 未実装バグの修正** (`main_server.go`)
  - クライアントが送る `ping` メッセージがサーバー側でインターセプトされず、対戦相手にブロードキャストされてしまっていた。
  - `Room.Run()` の broadcast ループ内で `msg.Type === "ping"` を検出したら送信者本人にのみ `pong` を返す処理を追加。これによりレイテンシ計測が正常に機能するようになった。

- [x] 9.2 **[client] パドル同期の無制限送信バグの修正** (`docs/app.js` - `syncPaddlePosition`)
  - `syncPaddlePosition()` にスロットルが実装されておらず、コメントには「30ms制限を設けられる」とあるが実際は毎フレーム（約60回/秒）WebSocketメッセージを送信していた。
  - `NetworkSystem` に `paddleLastSent` プロパティを追加し、前回送信から30ms未満の場合はスキップするスロットルを実装した。

- [x] 9.3 **[client] Player2がボール物理を独自計算してしまうバグの修正** (`docs/app.js` - `updatePhysics`)
  - オンライン対戦時、両プレイヤーがそれぞれローカルで `updatePhysics()` を実行してボール移動を計算するため、ネット遅延によってボール位置が両者間でズレていた。
  - WASM物理ブロックとJSフォールバックの両方に `shouldComputeBall` フラグを追加。`mode === 'online' && role === 2`（Player2クライアント）の場合はボール移動計算をスキップし、`serve` / `ball_hit` 受信イベントでのみボール位置を更新するよう修正した。

- [x] 9.4 **[client] Player2はscore判定が意図せず実行されるバグの修正** (`docs/app.js` - `updatePhysics` イベント処理)
  - WASM物理から返る `score` イベントをPlayer2がローカルで処理してしまい、`awardPointTo` が呼ばれなくても音を止める等の副作用が発生していた。
  - `score` イベント処理の先頭で `mode === 'online' && role === 2` の場合は音だけ処理してすぐ `return` するよう修正し、Player1(ホスト)からの `point` メッセージでのみ得点を更新する設計を明確化した。

## [x] 10. スマホチルト操作の比例制御と簡単モードのラリー練習特化 (2026-06-06)

スマホのチルト操作の泼用性を改善し、初心者向けの簡単モードを「打ち負かす」設計から「ラリー練習」設計に変更した。

- [x] 10.1 **[チルト操作] ±30度の比例制御の実装** (`docs/app.js` - `handleDeviceOrientation`)
  - 従来はデッドゾーン(±4度)を越えたかどうかの2値制御（オン/オフ）だったため、傾けた瞬間に最大速度で動き、細かい速度調整ができなかった。
  - `handleDeviceOrientation` にリニアスケール処理を追加。±4度のデッドゾーン外的の傾きを `(傾き角度 - 4度) / (30度 - 4度)` で正規化した `tiltRatio`（0.0〜1.0）を算出。フルスケールは±30度に設定した。
  - `updatePhysics` のラケット移動処理で `this.tiltSpeed`（0.0〜1.0）を参照し、`maxSpeed(7px) × tiltRatio` の比例速度で移動するよう変更。

- [x] 10.2 **[簡単モード] CPUサーブを低速・ほぼ直進に変更しラリー練習重視設計に変更** (`docs/app.js` - `handleActionInput` / CPU AI)
  - 従来の簡午モードは CPUの移動速度を下げて大きなブレを加える「打ち負かす」設計で、STTのラリー感覧が得られなかった。
  - CPUサーブを「低速(±0.4の微小な横成分、縦速度3.5px)」に変更。また CPU AIの追従速度を上げ(4.5px)てミスを減らし、ブレを最小限にして「当たりやすいラリー」を長させる設計に変更。
  - 『ラリーを続ける』達成感を优先し、STT初心者が音響・操作誓を様向けに設計されたモード。

## [x] 11. プレイ集中モード実装 ＆ ボール接近ビープ音ガイドの追加 (2026-06-06)

プレイ中のUI改善と音によるタイミングガイドを実装した。

- [x] 11.1 **[UI] プレイ中のplay-instructions非表示化** (`docs/app.js` - `prepareServeSequence`)
  - 従来はプレイ中も画面に「スペースキーを押して…」などの操作説明テキストが表示され、スクリーンリーダー使用者にとって余計な視覚情報となっていた。
  - `prepareServeSequence()` 呼び出し時に `play-instructions` 要素に `hidden` クラスを付与して非表示化。試合終了・ゲーム中断時に再表示するよう `quitGame()` と `finishMatch()` にも処理を追加した。
  - 案内はすべて `narrator.speak()` 経由の音声と `sr-announcer` のaria-liveテキストで行う設計に統一。

- [x] 11.2 **[UI] プレイ画面全体タップ対応** (`docs/app.js` - `setupEventListeners`)
  - 従来はcanvas-container内のタップのみアクションが発火し、スコアボードや枠外タップでは反応しなかった。
  - `screen-play` セクション全体に click / touchend イベントを追加。ボタン・input・ラベル等の除外リストを設け誤爆を防止。canvas-containerにも後方互換としてイベントを残した。

- [x] 11.3 **[音響] ボール接近ビープ音 `playBeep()` メソッド追加** (`docs/app.js` - `SoundSystem`)
  - ラリー中にボールが自分の守備ラインへ近づいたとき、3段階の「ぴ」音でタイミングを伝える機能を新設。
  - stage=`far`(880Hz/0.18音量)・`near`(1320Hz/0.28音量)・`hit`(1760Hz/0.40音量) と段階的に周波数・音量を上げる設計。
  - `SoundSystem.playBeep(stage)` として実装し、WebAudio APIのOscillatorNodeで純音正弦波を合成。

- [x] 11.4 **[物理] `updateApproachBeep()` メソッドの追加** (`docs/app.js` - `GameEngine`)
  - 毎フレーム `updatePhysics()` から呼ばれ、ボールの進行方向とY座標から接近段階（far/near/hit）を判定する。
  - 守備ライン120px圏内でfar、60px圏内でnear、30px圏内でhitに昇格（降格はしない）。
  - ビープの最低間隔は200msに制限し、過剰発火を防止。
  - hitゾーンへの初回到達時は `sr-announcer` のaria-liveで「今です！タップまたはスペースキーで打ち返してください。」をアナウンス。
  - WASM物理ブロックとJSフォールバックの両方に呼び出しを追加し、どちらの経路でも動作することを確認。

## [x] 12. ラケット移動音のステレオ定位・音色変化の強化 (2026-06-06)

ラケット移動時に、自分がどの位置にいるかを音で直感的に把握できるよう改善した。

- [x] 12.1 **[音響] `playFootstepSound` に位置依存の音色変化を追加** (`docs/app.js` - `SoundSystem`)
  - 従来は移動速度によるピッチ変化のみだったが、ラケットのX座標から求めた `panVal` (-1〜1) に応じたピッチシフト (`positionShift`) を追加。
  - 中央付近 (`panVal=0`) ほどQ値を上げて音をクリアにし、プレイヤーがスピーカーのちょうど真ん中（パン値0）でボールを待ち構えやすくした。

## [x] 13. 試合終了時の歓声音の追加 (2026-06-06)

ゲームが終わった際に達成感を演出するため、観客の歓声音（拍手）を追加した。

- [x] 13.1 **[音響] `playCheerSound` メソッドの追加** (`docs/app.js` - `SoundSystem`)
  - ホワイトノイズにバンドパスフィルターをかけ、LFOで周波数を揺らすことで観客の歓声（ざわめき・拍手）のような音を合成。
  - 4秒間かけて徐々にフェードアウトするエンベロープを設定。
  - `finishMatch()` の呼び出し時に再生するよう追加。

## [x] 14. CPU戦のサーブ交代制の実装 (2026-06-13)

CPU戦においてもSTT本来の「いきます / はい」サーブシーケンスをプレイヤーが担う場面を設けた。

- [x] 14.1 **[ゲームロジック] Normal/Hardでのサーブ権交代** (`docs/app.js` - `awardPointTo`, `startNewMatch`)
  - Easy難易度はCPUサーブ固定（ラリー練習重視）のまま維持。
  - Normal/Hard難易度は2ポイントごとにサーブ権が交代するよう変更（オンライン対戦と同一ロジック）。
  - `startNewMatch()` でNormal/Hardの場合はサーブ権を `serverRole = 1`（プレイヤー先攻）から開始するよう変更。

## [x] 15. チャージサーブの実装 (2026-06-13)

スペースキーの長押し時間に応じてサーブ速度が変化するチャージサーブを実装した。

- [x] 15.1 **[ゲームロジック] チャージ状態管理** (`docs/app.js` - `GameEngine`)
  - `chargeStartTime`, `isCharging`, `chargeInterval` の3変数をコンストラクタに追加。
  - `STATE_SERVE_WAITING` かつ自分のサーブターン中にスペースキーを押し続けると `isCharging = true` に遷移。

- [x] 15.2 **[音響] `playChargeBeep(chargeRatio)` メソッドの追加** (`docs/app.js` - `SoundSystem`)
  - チャージ率（0.0〜1.0）に応じて400Hz〜1200Hzに上昇するサイン波ビープを150msごとに再生。
  - チャージ率が高いほど音が高くなりプレイヤーに蓄積状況をフィードバック。

- [x] 15.3 **[ゲームロジック] チャージ量をサーブ速度に反映** (`docs/app.js` - `handleActionInput`)
  - スペースキーリリース時に長押し時間から `chargeRatio`（0.0〜1.0）を算出（最大1.5秒）。
  - vy = 4.5 + chargeRatio × 3.5 として初速度を設定（速度範囲: 4.5〜8.0）。

## [x] 16. 打ち返し判定の難易度別調整 ＆ ミス方向音声 (2026-06-13)

難易度に合わせた打ち返し判定幅の調整と、スクリーンリーダー向けのミス方向フィードバックを追加した。

- [x] 16.1 **[ゲームロジック] 打ち返し判定幅の難易度別設定** (`docs/app.js` - `handleActionInput`)
  - Easy: 50px / Normal: 30px / Hard: 20px に判定幅を変更。

- [x] 16.2 **[アクセシビリティ] ミス方向アナウンス** (`docs/app.js` - `updatePhysics`)
  - ボールがプレイヤーの守備ラインを通過して失点した際、X座標から左/中央/右を判定し sr-announcer 経由でアナウンス。

## [x] 17. インターバルスキップ機能の実装 (2026-06-13)

得点後の待機時間をスペースキー／タップでスキップできる機能を追加した。

- [x] 17.1 **[ゲームロジック] スキップコールバック管理** (`docs/app.js` - `awardPointTo`, `handleActionInput`)
  - `intervalSkipCallback` と `currentIntervalTimer` をコンストラクタに追加。
  - `awardPointTo()` 内でコールバックを格納し、スキップ時に `clearTimeout` → 即実行。
  - `handleActionInput()` の先頭で `STATE_POINT_WON` 時のスキップ処理を追加。
  - タッチイベントの `activeStates` にも `STATE_POINT_WON` を追加。

## [x] 18. ミス方向ガイド音（パンニング付きmissSound）の実装 (2026-06-13)

失点時のミス音にX座標パンニングを付加し、「どちら側でミスしたか」が音で分かるようにした。

- [x] 18.1 **[音響] `playMissSound(x)` のパンニング対応** (`docs/app.js` - `SoundSystem`)
  - 引数 `x`（デフォルト400）を追加し、StereoPannerNode 経由でパンニングを適用。
  - 既存の全呼び出し箇所を `sounds.playMissSound(this.ball.x)` に更新。

## [x] 19. ボール停止位置音の実装 (2026-06-13)

ボールが停止した際に停止X座標にパンニングした位置音を再生し、停止位置を音で把握できるようにした。

- [x] 19.1 **[音響] `playBallStopSound(x)` メソッドの追加** (`docs/app.js` - `SoundSystem`)
  - 三角波オシレーター（280→120Hzスウィープ、0.2秒）を StereoPanner 経由で再生。
  - `updatePhysics()` のボール停止検知箇所（速度 < 0.12）でインターフェース呼び出しを追加。

## [x] 20. 音量ダイナミクスの対数スケール化 (2026-06-13)

ボール転がり音の音量計算を線形スケールから対数スケールに変更し、低速域の表現を豊かにした。

- [x] 20.1 **[音響] `updateBallSound()` 音量計算式の変更** (`docs/app.js` - `SoundSystem`)
  - `let targetVolume = (speed / 10) * 0.45;` から `Math.log1p(speed * 0.8) / Math.log1p(8) * 0.5` に変更。

## [x] 21. 音声速度設定スライダーの実装 (2026-06-13)

スクリーンリーダー利用者が読み上げ速度を自分好みに調整できるスライダーをウェルカム画面に追加した。

- [x] 21.1 **[HTML] 音声速度パネルの追加** (`docs/index.html`)
  - `#screen-welcome` 内にスライダー（min=0.5, max=2.0, step=0.1）と現在値ラベルを含む `.speech-rate-panel` を追加。

- [x] 21.2 **[CSS] `.speech-rate-panel` のスタイル定義** (`docs/styles.css`)
  - ダッシュボーダーパネル、スライダーのアクセントカラー指定などを追加。

- [x] 21.3 **[JS] `SpeechSystem` の動的レート対応** (`docs/app.js` - `SpeechSystem`)
  - コンストラクタに `this.speechRate = parseFloat(localStorage.getItem('stt_speech_rate') || '1.2')` を追加。
  - `speak()` 内のハードコードされたレートをプロパティ参照に変更。
  - `setSpeechRate(rate)` メソッドを追加しlocalStorageに保存。

## [x] 22. 試合結果画面の改善 (2026-06-13)

試合終了後に勝者・スコアを表示し、「もう一度プレイ」「メニューに戻る」を選択できる結果画面を実装した。

- [x] 22.1 **[ゲームロジック] `finishMatch()` の改善** (`docs/app.js` - `GameEngine`)
  - 従来の `setTimeout(() => quitGame(), 6000)` を廃止。
  - `play-instructions` 要素に `.match-result-overlay` を含むHTMLを挿入。
  - 「もう一度プレイ」ボタンで `startNewMatch()`、「メニューに戻る」で `quitGame()` を呼び出す。

- [x] 22.2 **[CSS] 試合結果オーバーレイのスタイル定義** (`docs/styles.css`)
  - `.match-result-overlay`, `.match-result-title`, `.match-result-winner`, `.match-result-score`, `.match-result-buttons` を追加。

## [x] 23. リマッチ機能の実装 (2026-06-13)

オンライン対戦終了後、同じWebSocket接続のまま再試合を開始できるリマッチ機能を実装した。

- [x] 23.1 **[ネットワーク] `rematch_offer` / `rematch_accept` アクションの追加** (`docs/app.js`)
  - `finishMatch()` でオンラインモード時に `rematch_offer` を送信。
  - `handleOpponentAction()` で `rematch_accept` を受信したら `startNewMatch()` を実行。
  - 「もう一度プレイ」ボタンをオンライン時は `rematch_accept` 送信に、CPU時は直接 `startNewMatch()` に振り分け。

## [x] 24. 切断時の5秒再接続猶予の実装 (2026-06-13)

対戦相手が切断した際に即終了せず、5秒間の再接続を待つ機能をサーバーに実装した。

- [x] 24.1 **[サーバー] `Room` 構造体の拡張** (`main_server.go`)
  - `disconnectedPlayers map[string]*Client`, `reconnectTimers map[string]*time.Timer` フィールドを追加。
  - `NewRoom()` で両マップを初期化。

- [x] 24.2 **[サーバー] `unregister` ハンドラの変更** (`main_server.go` - `Room.Run()`)
  - 切断クライアントを `disconnectedPlayers` に移動し、残存プレイヤーに `opponent_disconnected`（countdown=5）を送信。
  - `time.AfterFunc(5s, ...)` でタイマーを開始し、5秒後も再接続がない場合に `opponent_left` を送信してクリーンアップ。

- [x] 24.3 **[サーバー] `register` ハンドラの再接続処理** (`main_server.go` - `Room.Run()`)
  - 参加要求のクライアントIDが `disconnectedPlayers` に存在する場合、タイマーをキャンセルしてプレイヤーを復元。
  - 残存プレイヤーと全観戦者に `opponent_reconnected` を送信。

## [x] 25. 観戦モード（Observer）の実装 (2026-06-13)

試合中のルームに第三者が観戦者として参加できる機能をサーバーに実装した。

- [x] 25.1 **[サーバー] `Room` 構造体の拡張** (`main_server.go`)
  - `observers map[string]*Client` フィールドを追加。
  - `NewRoom()` で初期化。

- [x] 25.2 **[サーバー] 観戦者の入室処理** (`main_server.go` - `Room.Run()` の `register` ハンドラ)
  - 部屋に既に2名のプレイヤーがいる場合、新規接続を `role: 3`（観戦者）として `observers` マップに追加。
  - 観戦者数が5名を超える場合は `{type: "error", message: "Observer slots full"}` を返して拒否。

- [x] 25.3 **[サーバー] ブロードキャストの観戦者転送** (`main_server.go` - `Room.Run()` の `broadcast` ハンドラ)
  - 通常メッセージをプレイヤーに転送後、すべての観戦者にも転送するよう処理を追加。

- [x] 25.4 **[サーバー] 観戦者メッセージのフィルタリング** (`main_server.go` - `Client.readPump()`)
  - `client.role == 3` の場合はメッセージをブロードキャストチャネルに流さず破棄。

## [x] 26. 設定の永続化（localStorage）(2026-06-13)

難易度・チルト設定・サーバーアドレス・音声速度をlocalStorageに保存し次回起動時に自動復元する機能を実装した。

- [x] 26.1 **[設定保存] 難易度の保存と復元** (`docs/app.js` - `setupEventListeners`)
  - 難易度ボタンクリック時に `localStorage.setItem('stt_last_difficulty', this.difficulty)` を追加。

- [x] 26.2 **[設定保存] チルトON/OFFの保存と復元** (`docs/app.js` - `setupEventListeners`)
  - チルトチェックボックス変更時に `localStorage.setItem('stt_use_tilt', e.target.checked)` を追加。
  - `btn-enable-audio` クリック時にlocalStorageから復元してチェックボックスの状態を初期化。

- [x] 26.3 **[設定保存] サーバーアドレスの保存と復元** (`docs/app.js` - `setupEventListeners`)
  - `input-server-addr` の初期値をlocalStorageから復元。
  - ルームに入る際に入力値をlocalStorageに保存。

- [x] 26.4 **[設定保存] 音声速度の保存と復元** (`docs/app.js` - `SpeechSystem`)
  - コンストラクタでlocalStorageから速度を読み込み。
  - スライダー変更時に `narrator.setSpeechRate(rate)` 経由で保存。

