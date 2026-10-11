import { narrator } from './speech-system.js?v=diagnostics-1';

// 専用ページだけで使用する。ゲームのnarrator・設定保存には触れない。
export class SpeechDiagnostics {
  constructor(speech, changed = () => {}) {
    this.speech = speech;
    this.changed = changed;
    this.events = [];
    this.tests = [];
    this.active = false;
    this.directUtterance = null; // 終了通知が欠落しても次の明示停止まで保持。
    this.metadata = {};
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.metadata = { startedAt: new Date().toISOString(),
      userAgent: window.navigator?.userAgent || '', url: window.location?.href || '',
      savedSpeechMode: this.speech.speechMode, rate: this.speech.speechRate,
      note: '発声イベントは実際の聴取成功を保証しません。Bに監視・再試行はありません。' };
    // このページ専用のインスタンス。setSpeechModeは保存するので使用しない。
    this.speech.speechMode = 'builtin';
    this.speech.diagnosticsObserver = entry => {
      this.events.push({ ...entry, directUtteranceRemaining: this.directUtterance !== null });
      this.changed();
    };
    this.speech.setDiagnosticsEnabled(true);
    this.record('diagnosis-started');
  }

  record(type, details = {}) { this.speech.recordSpeech(type, details); }

  context(test) {
    this.speech.diagnosticTestId = test?.id ?? null;
    this.speech.diagnosticTestKind = test?.kind ?? null;
  }

  stop(reason = 'diagnostic-user-stop') {
    const oldDirect = this.directUtterance;
    this.speech.stop(reason, 'diagnostic-stop');
    this.directUtterance = null;
    if (oldDirect) this.record('direct-reference-released', { reason });
  }

  run(kind) {
    if (!this.active) return;
    const previous = this.tests.at(-1);
    const test = { id: this.tests.length + 1, kind, heard: 'not-recorded', observation: '' };
    this.tests.push(test);
    this.context(test);
    this.record('test-button', { buttonPressed: true });
    // Aの繰り返しは通常のテストボタンと同じ経路。事前cancelで残存参照を隠さない。
    // Bの直接キューとAを切り替える場合だけ、前の発声を明示停止して分離する。
    const normalTestPath = kind === 'A' && (!previous || previous.kind === 'A') && !this.directUtterance;
    let cancelFailed = false;
    if (!normalTestPath) {
      this.context(previous);
      const beforeStop = this.events.length;
      this.stop(`diagnostic-before-test:${test.id}:${kind}`);
      cancelFailed = this.events.slice(beforeStop).some(e => e.type === 'cancel-exception');
    }
    this.context(test);
    const reject = reason => this.record('test-rejected', { rejected: true, reason });
    if (cancelFailed) return reject('previous-cancel-failed');
    if (!this.speech.synth || typeof SpeechSynthesisUtterance === 'undefined') return reject('web-speech-api-unavailable');
    if (!normalTestPath && (this.speech.synth.speaking || this.speech.synth.pending)) return reject('native-queue-still-busy-after-cancel');
    if (!['A', 'B'].includes(kind)) return reject('unknown-test-kind');
    if (kind === 'A') {
      const beforeSpeak = this.events.length;
      this.speech.testSpeech();
      if (!this.events.slice(beforeSpeak).some(e => e.type === 'speak-called')) {
        return reject(this.speech.testUtterance ? 'test-utterance-remains' : 'stt-did-not-call-speak');
      }
      this.record('test-dispatched');
      return;
    }
    try {
      this.speech.loadVoice();
      const u = new SpeechSynthesisUtterance('音声案内のテストです。');
      u.lang = 'ja-JP';
      if (this.speech.voice) u.voice = this.speech.voice;
      u.rate = this.speech.speechRate;
      u.pitch = 1;
      this.directUtterance = u;
      const log = (type, event = {}, extra = {}) => this.record(type, {
        testId: test.id, testKind: 'B', text: u.text, rate: u.rate, pitch: u.pitch,
        lang: u.lang, voice: this.speech.describeVoice(u.voice),
        charIndex: event.charIndex, elapsedTime: event.elapsedTime, ...extra
      });
      const finish = () => { if (this.directUtterance === u) this.directUtterance = null; };
      u.onstart = event => log('start', event);
      u.onend = event => { finish(); log('end', event); };
      u.onerror = event => { finish(); log('error', event, { error: event.error }); };
      log('speak-called');
      try {
        this.speech.synth.speak(u);
        log('speak-returned');
      } catch (error) {
        finish();
        log('speak-exception', {}, { error: String(error) });
      }
    } catch (error) {
      this.record('test-rejected', { rejected: true, reason: 'direct-setup-exception', error: String(error) });
    }
  }

  observe(id, heard, observation) {
    const test = this.tests.find(t => t.id === id);
    if (!test) return;
    test.heard = heard;
    test.observation = observation;
    this.record('listening-observation', { testId: test.id, testKind: test.kind, heard, observation });
  }

  report(environment = '') {
    const tests = this.tests.map(test => {
      const events = this.events.filter(e => e.testId === test.id);
      const count = type => events.filter(e => e.type === type).length;
      return { ...test, buttonPressed: count('test-button') > 0,
        speakCalls: count('speak-called'), speakReturned: count('speak-returned'),
        onstart: count('start') + count('start-ignored'),
        onend: count('end') + count('end-ignored'), onerror: count('error') + count('error-ignored'),
        rejected: events.filter(e => e.rejected),
        note: '0は記録時点でイベント未受信。無音・成功は聴取結果を参照。' };
    });
    return 'STT Android speech diagnostics / format 1\n' + JSON.stringify({
      metadata: { ...this.metadata, environment }, tests,
      current: { speaking: this.speech.synth?.speaking ?? null,
        pending: this.speech.synth?.pending ?? null, paused: this.speech.synth?.paused ?? null,
        testUtteranceRemaining: this.speech.testUtterance !== null,
        directUtteranceRemaining: this.directUtterance !== null },
      lastSpeechDiagnostic: this.speech.getDiagnostics().at(-1) ?? null, events: this.events
    }, null, 2);
  }
}

const byId = id => document.getElementById(id);
if (byId('start')) {
  const refresh = () => {
    byId('report').value = diagnostics.report(byId('environment').value);
    byId('state').textContent = `診断中。テスト ${diagnostics.tests.length} 件、記録 ${diagnostics.events.length} 件。`;
    for (const test of diagnostics.tests) {
      if (![...byId('test-result-id').options].some(o => o.value === String(test.id))) {
        const option = document.createElement('option');
        option.value = String(test.id);
        option.textContent = `テスト ${test.id}：${test.kind}`;
        byId('test-result-id').append(option);
        byId('test-result-id').value = option.value;
        byId('heard').value = 'not-recorded';
        byId('observation').value = '';
      }
    }
    byId('test-result-id').disabled = byId('save-observation').disabled = !diagnostics.tests.length;
  };
  const diagnostics = new SpeechDiagnostics(narrator, refresh);
  byId('start').addEventListener('click', () => {
    diagnostics.start();
    byId('start').disabled = true;
    for (const id of ['test-a', 'test-b', 'stop', 'snapshot', 'copy']) byId(id).disabled = false;
  });
  for (const kind of ['A', 'B']) byId(`test-${kind.toLowerCase()}`).addEventListener('click', () => diagnostics.run(kind));
  byId('stop').addEventListener('click', () => { diagnostics.stop(); diagnostics.record('manual-stop-completed'); });
  byId('snapshot').addEventListener('click', () => diagnostics.record('manual-state-snapshot'));
  byId('environment').addEventListener('input', () => { if (diagnostics.active) refresh(); });
  byId('test-result-id').addEventListener('change', () => {
    const test = diagnostics.tests.find(t => t.id === Number(byId('test-result-id').value));
    byId('heard').value = test.heard;
    byId('observation').value = test.observation;
  });
  byId('save-observation').addEventListener('click', () => diagnostics.observe(
    Number(byId('test-result-id').value), byId('heard').value, byId('observation').value));
  byId('copy').addEventListener('click', async () => {
    diagnostics.record('copy-state-snapshot');
    const report = byId('report');
    try {
      await window.navigator.clipboard.writeText(report.value);
      byId('copy-status').textContent = '診断結果をコピーしました。ChatGPTに貼り付けてください。';
    } catch {
      report.focus();
      report.select();
      byId('copy-status').textContent = '自動コピーが利用できません。診断結果のテキスト欄をすべて選択し、コピーしてください。';
    }
  });
  window.addEventListener('pagehide', () => {
    if (!diagnostics.active) return;
    diagnostics.stop('diagnostic-pagehide');
  });
}
