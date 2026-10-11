import { readSetting, writeSetting } from './settings-storage.js?v=3.31.47';

export class SpeechSystem {
  constructor() {
    this.synth = window.speechSynthesis;
    this.voice = null;
    this.srAnnouncer = document.getElementById('sr-announcer');
    this.refereeMessage = document.getElementById('referee-message');
    const savedMode = readSetting('stt_speech_mode');
    this.speechMode = savedMode === 'screen-reader' ? 'screen-reader' : 'builtin';
    this.announcementTimer = null;
    this.announcementId = 0;
    this.announcementQueue = [];
    this.utterances = new Set();
    this.isAndroid = /Android/i.test(window.navigator?.userAgent || '');
    this.diagnostics = [];
    this.utteranceId = 0;
    this.testUtterance = null;
    this.watchdogs = new Map();
    this.diagnosticsEnabled = false;
    this.diagnosticsObserver = null;
    this.diagnosticTestId = null;
    this.diagnosticTestKind = null;
    // Feature #8: 音声速度設定の初期読み込み
    this.speechRate = this.normalizeSpeechRate(Number(readSetting('stt_speech_rate') || '1.2'));

    // 日本語の音声を検索してセットする
    if (this.synth) {
      // 音声リストの変更イベントをリッスン (Chrome等の遅延ロード対策)
      this.synth.onvoiceschanged = () => this.loadVoice();
      this.loadVoice();
    }
  }

  loadVoice() {
    let voices;
    try {
      voices = this.synth.getVoices();
    } catch (error) {
      this.recordSpeech('voices-error', { error: String(error) });
      return;
    }
    const japanese = voices.filter(v => /^ja(?:[-_]|$)/i.test(v.lang));
    // AndroidではGoogleという名前だけで固定せず、端末の設定を尊重する。
    // voice=null と lang=ja-JP の組み合わせでブラウザに日本語音声を選ばせる。
    this.voice = this.isAndroid ? japanese.find(v => v.default) || null
      : voices.find(v => v.lang === 'ja-JP' && v.name.includes('Google')) ||
        voices.find(v => v.lang === 'ja-JP') || null;
    this.recordSpeech('voices', {
      android: this.isAndroid, selectedVoice: this.describeVoice(this.voice),
      voices: voices.map(v => this.describeVoice(v))
    });
  }

  describeVoice(voice) {
    return voice ? { name: voice.name, lang: voice.lang, default: voice.default,
      localService: voice.localService, voiceURI: voice.voiceURI } : null;
  }

  recordSpeech(type, details = {}) {
    if (!this.diagnosticsEnabled) return;
    const entry = { type, timestamp: Date.now(), mode: this.speechMode,
      speaking: this.synth?.speaking ?? null, pending: this.synth?.pending ?? null,
      paused: this.synth?.paused ?? null, activeUtterances: this.utterances.size,
      testUtteranceRemaining: this.testUtterance !== null,
      testUtteranceId: this.testUtterance?.sttSpeechId ?? null,
      testId: this.diagnosticTestId, testKind: this.diagnosticTestKind, ...details };
    this.diagnostics.push(entry);
    if (this.diagnostics.length > 100) this.diagnostics.shift();
    // 専用診断ページではイベントごとに全履歴を保存。通常は未登録。
    if (this.diagnosticsObserver) {
      try { this.diagnosticsObserver(JSON.parse(JSON.stringify(entry))); }
      catch (error) { console.warn('Speech diagnostic observer failed:', error); }
    }
    console.debug('[STT speech]', entry);
  }

  getDiagnostics() {
    return JSON.parse(JSON.stringify(this.diagnostics));
  }

  setDiagnosticsEnabled(enabled) {
    this.diagnosticsEnabled = enabled === true;
    this.diagnostics.length = 0;
    if (this.diagnosticsEnabled && this.synth) this.loadVoice();
  }

  testSpeech() {
    this.recordSpeech('test-request');
    if (this.speechMode === 'builtin' && this.testUtterance) {
      this.recordSpeech('test-already-active', { id: this.testUtterance.sttSpeechId,
        rejected: true, reason: 'test-utterance-remains' });
      return;
    }
    if (this.speechMode === 'builtin' && this.synth) {
      this.loadVoice();
      // ユーザーのクリック内でのみ再開。発声中のcancel/resumeの反復は避ける。
      try {
        if (this.synth.paused) {
          this.recordSpeech('test-resume');
          this.synth.resume();
        }
      } catch (error) {
        this.recordSpeech('resume-error', { error: String(error) });
      }
    }
    this.speak('音声案内のテストです。', true, true);
  }

  /**
   * 案内は選択された方式だけで出力し、審判コールは画面にも表示します。
   * @param {string} text 発声するテキスト
   * @param {boolean} isReferee 主審としての発声かどうか (主審は少し高く、低テンポ)
   */
  speak(text, isReferee = true, isTest = false) {
    const announcementId = this.announcementId;
    let fallbackSent = false;
    const announceFallback = () => {
      if (announcementId !== this.announcementId || fallbackSent) return;
      fallbackSent = true;
      this.announceToScreenReader(text, announcementId);
    };
    if (this.speechMode === 'screen-reader') announceFallback();
    if (this.speechMode === 'builtin' && !this.synth) {
      this.recordSpeech('synthesis-unavailable');
    }

    // 2. ビジュアルの審判コールテキストを更新
    try {
      if (isReferee && this.refereeMessage) {
        this.refereeMessage.textContent = `「 ${text} 」`;
        this.refereeMessage.classList.remove('fade-in');
        void this.refereeMessage.offsetWidth; // リフローをトリガーしてアニメーションをリセット
        this.refereeMessage.classList.add('fade-in');
      }
    } catch (e) {
      console.warn("Failed to update visual call text:", e);
    }

    // 3. Web Speech APIによる発声 (シークレットモード等の制限に備えtry-catch保護)
    try {
      if (this.synth && this.speechMode === 'builtin') {

        const utterance = new SpeechSynthesisUtterance(text);
        if (this.voice) {
          utterance.voice = this.voice;
        }
        utterance.lang = 'ja-JP';
        // Feature #8: 設定された speechRate を適用
        utterance.rate = isReferee ? this.speechRate : Math.max(0.7, this.speechRate - 0.2);
        utterance.pitch = isReferee ? 1.0 : 1.1;

        const id = ++this.utteranceId;
        const testId = this.diagnosticTestId;
        const testKind = this.diagnosticTestKind;
        utterance.sttSpeechId = id;
        let startedAt = null;
        let settled = false;
        // テストのみ、通知欠落時にもAPI直後のbusy観測を監視の再開始をまたいで保持。
        let testObservedBusy = false;
        const observeTestBusy = () => {
          if (isTest && (this.synth.speaking === true || this.synth.pending === true)) testObservedBusy = true;
        };
        const logEvent = (type, event = {}, extra = {}) => this.recordSpeech(type, {
          id, testId, testKind, isTest, text, textLength: text.length, rate: utterance.rate, pitch: utterance.pitch,
          voice: this.describeVoice(utterance.voice), lang: utterance.lang,
          charIndex: event.charIndex, elapsedTime: event.elapsedTime,
          wallElapsedMs: startedAt === null ? null : Date.now() - startedAt,
          stale: announcementId !== this.announcementId, ...extra
        });
        const finish = () => {
          if (settled) return false;
          settled = true;
          this.utterances.delete(utterance);
          clearTimeout(this.watchdogs.get(utterance));
          this.watchdogs.delete(utterance);
          if (this.testUtterance === utterance) {
            this.testUtterance = null;
          }
          return true;
        };
        utterance.onstart = (event) => {
          if (settled) {
            if (testId !== null) logEvent('start-ignored', event, { eventReceived: 'onstart', reason: 'utterance-already-settled' });
            return;
          }
          if (announcementId !== this.announcementId) {
            logEvent('start', event, { category: 'after-stop' });
            return;
          }
          startedAt = Date.now();
          logEvent('start', event);
          if (this.isAndroid || isTest) watch(Math.max(30000, text.length * 1000 / utterance.rate + 10000));
        };
        utterance.onpause = (event) => logEvent('pause', event);
        utterance.onresume = (event) => logEvent('resume', event);
        utterance.onerror = (event) => {
          if (!finish()) {
            if (testId !== null) logEvent('error-ignored', event, { eventReceived: 'onerror', error: event.error, reason: 'utterance-already-settled' });
            return;
          }
          const category = announcementId !== this.announcementId ? utterance.sttStopCategory || 'explicit-stop'
            : ['canceled', 'interrupted'].includes(event.error) ? 'queue-interruption'
            : 'engine-error';
          logEvent('error', event, { error: event.error, category });
          // Androidのエンジン異常では古い待機コールを破棄。自動再発声はしない。
          if (this.isAndroid && announcementId === this.announcementId) this.stop(`speech-error:${event.error}`, 'recovery');
        };
        utterance.onend = (event) => {
          if (!finish()) {
            if (testId !== null) logEvent('end-ignored', event, { eventReceived: 'onend', reason: 'utterance-already-settled' });
            return;
          }
          // 時間やcharIndexだけでは完読を保証できない。短い終了は疑いとして記録する。
          logEvent('end', event, { category: announcementId !== this.announcementId
            ? utterance.sttStopCategory || 'explicit-stop' : startedAt !== null && text.length >= 8 && Date.now() - startedAt < 300
              ? 'possible-early-end' : 'end-reported' });
        };
        // ネイティブの発声キューを使い、通常案内で前の発声を取り消さない。
        this.utterances.add(utterance);
        const watch = (delay) => {
          clearTimeout(this.watchdogs.get(utterance));
          observeTestBusy();
          let deadline = Date.now() + delay;
          let idleSince = null;
          let observedBusy = this.synth.speaking === true || this.synth.pending === true;
          const check = () => {
            this.watchdogs.delete(utterance);
            if (settled || announcementId !== this.announcementId) return;
            // 後続の待ち時間で、前の正常な発声を取り消さない。
            if (this.utterances.values().next().value !== utterance) {
              deadline = Date.now() + delay;
              idleSince = null;
            } else {
              observedBusy ||= this.synth.speaking === true || this.synth.pending === true;
              observeTestBusy();
              // Androidの終了通知欠落を補完。開始通知と実際のbusy観測が必要。
              // テストは開始通知も欠け得るため、busy観測後の安定した空状態で参照だけ解放。
              // 通常の審判コールは従来の条件を維持する。
              // 単発のfalseやpauseを終了とせず、空状態が1秒続いたら参照だけ解放する。
              const idle = this.isAndroid && (isTest ? testObservedBusy : startedAt !== null && observedBusy)
                && this.synth.speaking === false && this.synth.pending === false
                && this.synth.paused === false;
              if (idle) {
                idleSince ??= Date.now();
                if (Date.now() - idleSince >= 1000) {
                  finish();
                  logEvent('speech-idle-recovered', {}, { category: 'terminal-event-not-received' });
                  return;
                }
              } else idleSince = null;
              if (Date.now() >= deadline) {
                logEvent('speech-timeout', {}, { category: this.synth.paused ? 'queue-paused'
                  : startedAt === null ? 'start-not-received' : 'terminal-event-not-received' });
                // フラグも固まった場合は保守的な上限で一度だけ破棄。自動再発声しない。
                this.stop(this.isAndroid ? 'android-speech-timeout' : 'test-speech-timeout', 'recovery');
                return;
              }
            }
            schedule();
          };
          const schedule = () => {
            this.watchdogs.set(utterance, setTimeout(check, this.isAndroid ? 500 : delay));
          };
          schedule();
        };
        if (isTest) this.testUtterance = utterance;
        if (this.isAndroid || isTest) watch(30000);
        logEvent('queued');
        try {
          logEvent('speak-called');
          this.synth.speak(utterance);
          observeTestBusy();
          logEvent('speak-returned');
        } catch (error) {
          finish();
          logEvent('speak-exception', {}, { category: 'engine-error', error: String(error) });
          if (this.isAndroid) this.stop('speech-exception', 'recovery');
        }
      }
    } catch (e) {
      console.warn("Web Speech API failed to speak:", e);
      this.recordSpeech('speak-exception', { category: 'engine-error', error: String(e) });
    }
  }

  /**
   * 音声の出力を強制停止します。
   */
  stop(reason = 'explicit-stop', category = 'explicit-stop') {
    this.recordSpeech('stop', { category, reason,
      ids: [...this.utterances].map(u => u.sttSpeechId) });
    for (const utterance of this.utterances) utterance.sttStopCategory = category;
    this.announcementId++;
    this.announcementQueue.length = 0;
    this.utterances.clear();
    this.testUtterance = null;
    for (const timer of this.watchdogs.values()) clearTimeout(timer);
    this.watchdogs.clear();
    if (this.announcementTimer !== null) {
      clearTimeout(this.announcementTimer);
      this.announcementTimer = null;
    }
    if (this.srAnnouncer) this.srAnnouncer.textContent = '';
    try {
      if (this.synth) {
        this.recordSpeech('cancel-called', { reason, category });
        this.synth.cancel();
      }
      this.recordSpeech('cancel-returned', { reason });
    } catch (error) {
      console.warn('Failed to stop built-in speech:', error);
      this.recordSpeech('cancel-exception', { reason, error: String(error) });
    }
  }

  announceToScreenReader(text, announcementId) {
    if (!this.srAnnouncer || announcementId !== this.announcementId) return;
    this.announcementQueue.push({ text, announcementId });
    if (this.announcementTimer === null) this.processAnnouncementQueue();
  }

  processAnnouncementQueue() {
    const next = this.announcementQueue.shift();
    if (!next) return;
    // 同一文の繰り返しも通知できるよう、次の通知を出すときだけクリア。
    // 後続の speak() は現在の通知とタイマーを上書きしない。
    this.srAnnouncer.textContent = '';
    this.announcementTimer = setTimeout(() => {
      if (next.announcementId !== this.announcementId) return;
      this.srAnnouncer.textContent = next.text;
      // aria-live には読み上げ完了イベントがないため、通知間隔を確保する。
      this.announcementTimer = setTimeout(() => {
        this.announcementTimer = null;
        if (next.announcementId === this.announcementId) this.processAnnouncementQueue();
      }, Math.max(1200, next.text.length * 100));
    }, 50);
  }

  setSpeechMode(mode) {
    if (!['builtin', 'screen-reader'].includes(mode)) return;
    this.stop('speech-mode-change');
    this.speechMode = mode;
    writeSetting('stt_speech_mode', mode);
  }

  /**
   * 音声読み上げ速度を変更して保存します。(Feature #8)
   */
  setSpeechRate(rate) {
    this.speechRate = this.normalizeSpeechRate(rate);
    writeSetting('stt_speech_rate', this.speechRate.toFixed(1));
  }

  normalizeSpeechRate(rate) {
    return Number.isFinite(rate) ? Math.max(0.5, Math.min(2.0, Math.round(rate * 10) / 10)) : 1.2;
  }
}

export const narrator = new SpeechSystem();
