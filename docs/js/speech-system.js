import { readSetting, writeSetting } from './settings-storage.js?v=3.31.26';

export class SpeechSystem {
  constructor() {
    this.synth = window.speechSynthesis;
    this.voice = null;
    this.srAnnouncer = document.getElementById('sr-announcer');
    this.refereeMessage = document.getElementById('referee-message');
    const savedMode = readSetting('stt_speech_mode');
    this.speechMode = savedMode === 'screen-reader' ? 'screen-reader' : 'builtin';
    this.announcementTimer = null;
    // Feature #8: 音声速度設定の初期読み込み
    this.speechRate = parseFloat(readSetting('stt_speech_rate') || '1.2');

    // 日本語の音声を検索してセットする
    if (this.synth) {
      // 音声リストの変更イベントをリッスン (Chrome等の遅延ロード対策)
      this.synth.onvoiceschanged = () => this.loadVoice();
      this.loadVoice();
    }
  }

  loadVoice() {
    const voices = this.synth.getVoices();
    // Googleの日本語音声、または日本語のデフォルト音声を優先的に選択
    this.voice = voices.find(v => v.lang === 'ja-JP' && v.name.includes('Google')) ||
                 voices.find(v => v.lang === 'ja-JP') ||
                 null;
  }

  /**
   * 案内は選択された方式だけで出力し、審判コールは画面にも表示します。
   * @param {string} text 発声するテキスト
   * @param {boolean} isReferee 主審としての発声かどうか (主審は少し高く、低テンポ)
   */
  speak(text, isReferee = true) {
    this.stop();
    // 1. スクリーンリーダーのテキストを更新 (最優先で読み上げさせる)
    try {
      if (this.srAnnouncer && (this.speechMode === 'screen-reader' || !this.synth)) {
        this.srAnnouncer.textContent = ''; // 一度クリアして確実に変更を検知させる
        this.announcementTimer = setTimeout(() => {
          this.announcementTimer = null;
          this.srAnnouncer.textContent = text;
        }, 50);
      }
    } catch (e) {
      console.warn("Failed to announce to screen reader:", e);
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

        this.synth.speak(utterance);
      }
    } catch (e) {
      console.warn("Web Speech API failed to speak:", e);
    }
  }

  /**
   * 音声の出力を強制停止します。
   */
  stop() {
    if (this.announcementTimer !== null) {
      clearTimeout(this.announcementTimer);
      this.announcementTimer = null;
    }
    if (this.srAnnouncer) this.srAnnouncer.textContent = '';
    try {
      if (this.synth) this.synth.cancel();
    } catch (error) {
      console.warn('Failed to stop built-in speech:', error);
    }
  }

  setSpeechMode(mode) {
    if (!['builtin', 'screen-reader'].includes(mode)) return;
    this.stop();
    this.speechMode = mode;
    writeSetting('stt_speech_mode', mode);
  }

  /**
   * 音声読み上げ速度を変更して保存します。(Feature #8)
   */
  setSpeechRate(rate) {
    this.speechRate = rate;
    writeSetting('stt_speech_rate', rate);
  }
}

export const narrator = new SpeechSystem();
