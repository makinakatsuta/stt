# Android内蔵音声：診断と実機確認（v3.31.56）

## 画面だけで実行する専用診断（今回の追加）

この変更を含むローカル実行ファイル／配信先の `/speech-diagnostics.html` を開く。未公開のため既存の公開サイトにはまだ追加されていない。WindowsサーバーをAndroidから利用する場合は、同じネットワークからPCのSTTサーバーURL末尾に `speech-diagnostics.html` を付ける。

1. ゲームを終了し、他のSTTタブを閉じる。この診断は独立ページでゲームを起動せず、保存済み設定を読み取るだけで変更しない。
2. Android／Chromeのバージョン、TTS設定、TalkBackのオン・オフを任意入力し、「診断を開始する」を押す。
3. A（現在のSTTのtestSpeech）を終了を待って5回、B（Web Speech API直接）を同じ条件で5回実行する。両者は同じ文章・日本語音声の選択規則・保存済み速度・pitch=1を使用する。voice=nullの場合、実際に選ばれた音声名はAPIでは取得できない。
4. 各回でテスト番号を選び、「最後まで聞こえた」「無音だった」「途中まで聞こえた」と補足を記録する。start／end通知は聴取の成功を保証しない。未受信のイベントは集計で0になる。
5. 無音が続く場合は、数秒後に「現在の音声状態を記録」を押す。Bには監視・自動リトライ・resumeがないため、終了通知の欠落やpaused状態がそのまま残る。次のテストまたは停止ボタンで明示停止する。
6. 「診断結果をテキストとしてコピー」を押し、全文をChatGPTに貼り付ける。HTTPやクリップボード拒否時はテキスト欄を長押ししてすべて選択・コピーする。

各テストボタンはtestUtterance残存状態を記録する。Aの繰り返しは通常の「読み上げをテスト」と同じ経路を通り、事前stop／cancelはしない。発声中の連打による拒否も診断結果に残る。AとBの切り替え、Bの再実行では前の発声をstop／cancelする。停止の理由は `diagnostic-before-test:番号:A/B`、手動停止は `diagnostic-user-stop`。cancel例外、cancel後もspeaking／pendingがtrueの場合は新しいテストを拒否し、その理由を記録する。

今回の再実行修正はテスト発声に限定する。Androidで開始・終了通知が欠けても、API復帰直後・onstart内・監視中のいずれかでspeaking／pendingのtrueを観測し、その後speaking=false、pending=false、paused=falseが1秒継続したら、古いテスト参照だけを解放する。cancel／自動リトライはしない。busyを一度も観測できない場合、pending／speaking／pausedが残る場合は、この早期解放をしない。30秒等の従来の監視上限は短縮していない。古い発声は既存の発声参照・settled・announcementIdで識別する。通常の審判コールの解放条件・キュー・文言は変更しない。

実機完了条件：通常画面の「読み上げをテスト」で5回連続の全文聴取、その後の試合中の審判コールを確認する。診断Aでも同じ5回を記録し、無音時のログと聴取結果をコピーする。TalkBackオン・オフ、速度1.0／保存済み速度も比較する。Android実機の結果がない段階では修正完了としない。

既存getDiagnosticsは直近100件を保つ。専用ページはrecordSpeechのイベント通知から全件を保持し、テスト番号・A/B・ボタン押下・API呼び出し／復帰・start/end/error・speaking/pending/paused・日本語音声情報／速度・stop/cancel理由・拒否理由・聴取結果をテキストに含める。遅延イベントも元のテストに帰属する。ページのログにはUAとページURL、任意入力も含まれる。ログはサーバーへ送信せず、保存設定にも書き込まない。コピー前に入力情報を確認し、ページを閉じる前にコピーする。

切り分け：両方でspeak-calledがあり、Bもstart/endが欠落・error・無音ならブラウザ／TTS側を調査する根拠になる。Aだけ失敗ならAの残存参照・拒否・監視停止・resumeなどとBを比較する。ただしcancel自体の影響やTalkBackとの音声競合もあるため、イベントだけで原因を断定しない。Android実機の発声とTalkBackでの操作は、実機で確認するまで未検証。

自動検証：`node --test tests/*.test.cjs`、`node tests/speech-diagnostics-browser.cjs`（既存Playwright環境のNODE_PATHを使用）。後者はモックAPIで実ボタン、コピー成功／拒否、ラベル、タッチ、設定保持、通常画面に診断がないことを確認する。

## 検証の範囲

### 2回目以降が無音になる問題の追加調査（2026-10-11）

対象ZIP `stt(4).zip` は作業フォルダーとユーザーのDownloadsで見つからず、ZIPとの一致は未確認。今回の調査・修正は既存の未コミット変更を含む作業フォルダーのソースに対して実施した。

確認した事実：`testUtterance` が残存すると `test-already-active` でreturnし、次の `speechSynthesis.speak()` は実行されない。`onend`／`onerror` の正常通知時には参照と監視タイマーが解放される。Androidの終了通知が欠落すると、音声が終了していても従来は長い監視期限まで再テストが拒否される。Android以外はテスト監視の期限到達時に参照を解放していなかった。これらの経路はソースとモックで確認できる。

実機に関する仮説：Android Chromeまたは端末TTSが終了イベントを返していない可能性、speaking／pending／pausedが実際の再生状態と食い違う可能性、ネイティブキューが閉塞している可能性。実機ログなしでいずれも断定できない。30秒を超えて無音が継続する実機症状の原因も未確定。

修正：Androidでは500ms間隔で先頭発声を監視し、開始通知に加えてspeaking／pendingのtrueを観測した後、speaking=false、pending=false、paused=falseが1秒継続した場合、終了通知欠落として参照を解放する。これは実際の全文聴取を保証する判定ではない。単発のfalse、開始通知なし、busy観測なし、待機中、pause中はこの解放を行わない。空状態の確認ではcancelも自動再発声もしない。フラグが固まった場合や開始通知も来ない場合は従来の長い上限を維持し、一度だけキューを取り消して次の要求を受け付ける。PC／iOSのテスト監視にも期限到達時の復旧を適用する。正常終了や通常のPC／iOS審判コールの処理は維持する。

意図的停止は `explicit-stop`、異常の復旧停止は `recovery` に分類。古い発声の遅延イベントも停止時の分類を保持し、新しいテストの参照やキューを取り消さない。発声中の連打は引き続き拒否する。`speak-called` はAPI呼び出し直前、`speech-idle-recovered` は終了通知なしの参照解放を記録する。

仕様参照：[Web Speech API](https://webaudio.github.io/web-speech-api/#tts-section)。フラグはブラウザが報告する状態であり、実際の音声の聴取結果とは分けて記録する。

NodeのAPIモックとPC ChromeのDOM／アクセシビリティ検査は、端末の音声エンジンや実際の聴取を保証しない。今回のAndroid Chrome、NVDA、TalkBack、VoiceOver、iPhone Safariの実機再確認は未実施。

ソース上、「読み上げをテスト」のclickはtestSpeechのみを呼び、直後のcancelはない。既存stopは方式切替、ヘルプ終了、メニュー復帰、試合終了。既存のpause呼び出しはない。今回のresumeはテストのユーザー操作時にpausedの場合だけ。速度変更・ゲーム開始・通常コールの追加はcancelしない。

Google名の音声を既定設定より優先していたことと、内蔵音声エラー時にaria-liveへ通知していたことは確認できた。Google音声と端末TTSの不整合、ブラウザ／エンジンの初期化・出力異常は仮説。実機ログなしで原因や改善を断定しない。

## ログの有効化と取得

Android ChromeのUSBリモートデバッグで対象ページのConsoleを開く。同じページのPC Chromeでも以下を使用できる。コードはページのルートURLで実行する。

```js
const { narrator } = await import('./js/speech-system.js?v=3.31.56');
narrator.setDiagnosticsEnabled(true);
```

その後、ページの「読み上げをテスト」を押す。Consoleに`[STT speech]`で出力される。試験後に以下で直近100件を取得する。

```js
JSON.stringify(narrator.getDiagnostics(), null, 2);
// 終了時はログを消して無効化する（保存／送信は行わない）。
narrator.setDiagnosticsEnabled(false);
```

診断は再読み込みで無効になる。ログにはアプリが発声する文章のみを記録し、UAや端末識別子・個人情報は収集しない。発声ID、文章、選択音声のname/lang/default/localService/voiceURI、rate/pitch、charIndex/elapsedTime、実測経過時間、speaking/pending/paused、停止理由を確認する。voiceがnullの場合、ブラウザが実際に選んだ音声名はAPIから取得できない。

| ログ | 解釈・次の確認 |
| --- | --- |
| voices | Androidでは既定の日本語音声を優先。それがなければvoice=null、lang=ja-JP。音声一覧の遅延時はvoiceschangedで再取得。非日本語音声を明示選択しない。 |
| queued → start → end | ブラウザが開始／終了を通知した。実際の全文聴取は別途確認する。 |
| speak-called | 該当IDのspeechSynthesis.speak()を呼び出す直前。2回目の無音でこのログがあるか確認する。 |
| test-already-active | 既存のテスト参照が残っているため要求を拒否。IDと直前のstart／end／error／復旧ログを照合する。 |
| speech-idle-recovered | 開始とbusy観測後、キューの空状態が継続したため参照を解放。cancel／自動再発声はしない。 |
| possible-early-end | 8文字以上の文章が開始後300ms未満で終了。診断用の疑いであり、これだけでは原因も完読も判定しない。自動再発声しない。 |
| error / explicit-stop | アプリのstop後の古いイベント。stopのreasonと対象IDを照合する。 |
| stop／error／end / recovery | タイムアウトやエンジン異常に対する復旧停止と、それに伴う古い終了イベント。意図的停止と区別する。 |
| error / queue-interruption | アプリのstop以外のcanceled/interrupted。外部エンジン・ブラウザの関与を調べる。 |
| error / engine-error | エラーコードを記録。Androidは待機キューを破棄し、次のユーザー操作・コールを受け付ける。 |
| speech-timeout | 開始待ち30秒、開始後はmax(30秒, 文章長×1000/rate＋10秒)。queue-paused／start-not-received／terminal-event-not-receivedを区別。Androidは古いキューを取消し、再発声しない。 |
| pause / resume / test-resume | ブラウザのイベントとテスト操作による再開を区別。 |

タイムアウトは発声前の固定遅延ではなく、イベント欠落時の保守的な監視上限。後続は先頭の発声を待ち、正常な前の発声を後続の待ち時間で取り消さない。長い文章・極端に遅い端末では上限調整が必要になる可能性がある。cancel自体がエンジンを復旧させる保証はない。新しい発声も失敗する場合は端末のTTS設定・日本語データ・Chromeの状態をログと併せて調査する。

## Android実機チェック（すべて未確認）

- [ ] TalkBackオフ＋内蔵音声で、初期速度1.2倍と1.0倍それぞれ、終了を待ってテストを少なくとも5回連続実行し、毎回「音声案内のテストです。」を最後まで全文聴取。
- [ ] TalkBackオン＋内蔵音声で同じ5回連続試験。エラー時にaria-live通知が追加されないこと。
- [ ] テスト連打で重複しないこと。終了後の再テストが再生されること。
- [ ] 起動直後と音声一覧取得後を比較。既定日本語音声あり／なし、端末TTSの日本語データ有無を記録。
- [ ] Easy／Normal／HardのCPU対戦でサーブ案内・審判コール・連続得点／判定を聴取。文言・順序・操作・ルールに変化がないこと。
- [ ] 速度変更、方式切替、ページ再読み込み後に設定が復元され、内蔵音声が再生されること。
- [ ] ヘルプ終了・メニュー復帰・試合終了のstop理由を確認。古いコールが遅れて再生されないこと。
- [ ] スクリーンリーダー方式でTalkBackの通知順序、同一案内の繰り返し、キーボード・タッチ・傾き操作を確認。
- [ ] イベント欠落／エラー後の手動再テストを確認。失敗が続く場合は復旧できたと判定しない。

原因分析用にChrome／AndroidのバージョンとTTS設定を手動で記録し、音声一覧・発声イベント・停止理由と、聞こえた文章の範囲／無音になるタイミングを併記する。TalkBackオン／オフ、速度1.0／1.2の同条件で比較する。

Google音声の関与を調べる開発者限定の比較では、端末に存在する日本語Google音声を一時的にnarrator.voiceへ指定し、narrator.speak('音声案内のテストです。')を呼ぶ（testSpeechは設定を再取得するため比較には使わない）。ユーザー操作による発声と条件をそろえ、1回ずつ完了を待つ。比較後はnarrator.loadVoice()で戻す。音声がない端末で代替の非日本語音声を指定しない。

## PC／iOS回帰と自動テスト

- [ ] Windows Chrome＋NVDA：内蔵音声の全文聴取、スクリーンリーダー方式、連続コール、方式切替、速度保存・復元。
- [ ] iPhone Safari＋VoiceOver：同じ音声・設定確認。Google優先など既存のPC／iOS選択は変更しない。

自動テスト：`node --test tests/*.test.cjs`。音声単体試験は正常な開始・終了、遅延一覧、音声なし、API例外／エラー、意図的停止、短時間終了、連続キュー、設定・速度保存、SR通知順序、Androidの監視・破棄・次回発声、ログ無効化を対象とする。固定balance snapshotは書き換えない。

`node tests/welcome-settings-browser.cjs`（既存のPlaywright環境を使用）はPC Chromeの設定・保存・アクセシビリティツリーと、モック音声エンジンによる実ボタンの重複防止・イベント記録・方式切替を検査する。AndroidのUA・音声一覧をモックする試験は、実機音声の検証とは区別する。

前回の2026-10-11の実行結果：全11回帰ファイル成功（JS／WASMの3難易度対戦、180,000回サーブ検査を含む）。最終変更後の音声・サーブ案内・balance snapshot関連3ファイルも成功。PC Chrome設定ブラウザ検査、go test ./...、git diff --check成功。Windows x64版を再ビルドしstt.exe --versionでSTT v3.31.56を確認。Androidの全文聴取・原因特定を意味しない。

今回の追加修正後の実行結果（2026-10-11）：`node --test tests/*.test.cjs` は全12ファイル・29件成功、失敗／スキップ0件。追加した `speech-recovery.test.cjs` は18件で、Android／Windows／iOSの5回連続正常終了、終了通知なしの空状態復旧、フラグ固着、開始通知欠落、連打、キュー中断／エンジンエラー、stop後と古いイベントの隔離、長い先頭コールを待つテストを検証した。Normal／Easy／Hardの既存スナップショットは変更せず成功。JS／WASMの対戦・180,000回のサーブ検査も成功。PC Chromeの `welcome-settings-browser.cjs` 成功。`go test ./...` は成功（Goテストファイルなし）。`git diff --check` 成功。`GOOS=windows`／`GOARCH=amd64` で最新ソースから `go build -trimpath -o stt.exe main_server.go` を実行し、`stt.exe --version` が `STT v3.31.56` を表示して終了コード0を確認。`main_wasm.go` は変更していないためWASM再ビルドは不要。Android／Windows／iOSでの実際の全文聴取は未検証。ZIPとの一致も未確認。push／タグ作成／Release公開は行っていない。
