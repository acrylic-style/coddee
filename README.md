# Discord Codex Bot

`discord.js` と `@openai/codex-sdk` を使って、Discord からローカル Codex に会話を投げる Bot です。

## Setup

1. `npm install`
2. `.env.example` を `.env` にコピーして値を設定
3. `npm run dev`

進捗要約に通常のOpenAIモデルを使う場合は、`.env`に`OPENAI_API_KEY`を設定します。モデルは`PROGRESS_SUMMARY_MODEL`で変更でき、既定値は`gpt-5.6-luna`です。APIキーがない場合は、安全な固定文へ自動的にフォールバックします。

## Commands

- `@bot <prompt>`: Codex に会話を送る
- `@bot status`: セッション状態を確認
- `@bot reset`: セッションを破棄
- `@bot voice join`: コマンドを送ったユーザーのボイスチャンネルへ接続
- `@bot voice leave`: ボイスチャンネルから退出
- `@bot voice character <設定>`: 参加中のVC専用キャラ設定を保存（引数なしで表示、`clear`で削除）
- `@bot voice memory`: 参加中のVCの長期memoryを表示
- `@bot voice memory reset`: 会話memoryを削除（キャラ設定は保持）
- 自然言語によるリマインドの作成・一覧・更新・削除
  - 例: `@bot 毎日9時に朝会とリマインドして`
  - 例: `@bot このチャンネルのリマインドを一覧にして`
  - 例: `@bot 朝会のリマインドを10時に変更して`
  - 例: `@bot 朝会のリマインドを削除して`

## Notes

- 同一チャンネルのリクエストは FIFO で直列処理されます。
- 長文応答は Discord 制限に合わせて自動分割されます。
- Codex の進捗は同じ Discord 返信へ随時反映され、完了時に最終回答へ置き換わります。内部推論、コマンド出力、ツール引数・出力は中継しません。
- `OPENAI_API_KEY`が設定されている場合、2秒ごとに新着イベントを確認し、更新があったときだけCodexセッションごとの直近15件をツールなしのResponses APIへ渡して進捗文を再生成します。送信内容はイベント種類・状態・許可済みコマンド名・ローカルでサニタイズしたコマンド概要に限り、認証情報、接続先、URL、絶対パス、長い不透明な値は送信前に伏せます。失敗時や出力の安全検査不合格時は固定文を使います。
- ユーザーがツール出力画像の送信を明示した場合、対応画像を Discord の添付ファイルとして送信します。
- Codex の thread ID は `data/session-state.json` に保存され、Bot 再起動後も会話再開を試みます。
- リマインドは `data/reminders.json` に保存され、指示されたチャンネルへ投稿されます。
- Bot は毎分リマインドを確認します。時刻の解釈には `REMINDER_TIME_ZONE`（既定値: `Asia/Tokyo`）を使います。
- ボイス入力は `REALTIME_SESSION_MODEL`（既定値: `gpt-realtime-2.1-mini`）で Realtime セッションへ接続し、`REALTIME_TRANSCRIPTION_MODEL`（既定値: `gpt-live-transcribe`）で発話中から逐次文字起こしして、`VOICE_CONVERSATION_MODEL`（既定値: `gpt-5.6-luna`）へ渡します。会話モデルは必要に応じて Responses API の `web_search` を直接使い、検索回答と出典を操作元のテキストチャンネルへ投稿します。
- 読み上げにはローカルの VOICEVOX REST API を使います。`VOICEVOX_BASE_URL`（既定値: `http://127.0.0.1:50021`）と `VOICEVOX_SPEAKER_ID`（既定値: `3`）で接続先と話者を変更できます。VOICEVOX に接続できない場合も回答本文をテキストチャンネルへ投稿します。
- Bot と人間一人だけのボイスチャンネルではウェイクワードなしで応答します。人間が二人以上いる場合は、発話の先頭に `Codex`（「コーデックス」などの文字起こし表記も許容）が必要です。誰かが話し始めると現在の読み上げを中断します。
- Bot が接続中のボイスチャンネル内蔵チャットでは、同じボイスチャンネルに参加中の許可ユーザーが Bot をメンションするか Bot の発言へリプライすると、テキストを音声入力と同じ会話へ渡して VOICEVOX で読み上げます。このテキスト入力にはウェイクワードは不要です。
- VCごとのキャラ設定、長期memory、未要約の直近会話は `data/voice-memory.json` に保存します。直近会話は毎ターン保存し、10ターンまたは約12,000文字ごと、およびVC退出時に会話モデルで要約します。Bot再起動後は保存済みmemoryと直近8ターンを新しい会話へ渡します。キャラ設定は口調・人格表現にのみ適用され、ツール選択や書き込み承認規則を上書きできません。
- ボイス経由の調査は、ネットワークを無効にした Codex の `read-only` サンドボックスで実行されます。ファイル変更、ビルド、テスト、インストールなど状態を変え得る操作は直ちには実行されず、操作元のテキストチャンネルへ5分間有効な承認ボタンを表示します。依頼した本人が「実行を承認」を押した場合だけ、`workspace-write` サンドボックスで実行します。
- ボイス入力は許可ユーザーだけを受信します。音声は発話中から Realtime transcription API へ送信され、Bot のローカルファイルには保存しません。
- `LOG_LEVEL=debug` にすると、文字起こし結果（最大1,000文字）、ウェイクワード判定、VC内の人間人数をデバッグログで確認できます。音声内容がログへ残るため、調査後は通常のログレベルへ戻してください。
- 同じく `LOG_LEVEL=debug` では、VOICEVOXへ渡す直前の分割済み読み上げ文字列も確認できます。

# 会話の長期記憶

通常テキストとVCでは、会話の要点候補と詳細を `data/conversation-memory.json` に保存します。関連候補は最大4件です。Bot宛ての `memory search <検索語>` と `memory open <ID>` で要約から詳細・子ノードへたどれます。

既定では保存元チャンネル内だけを検索します。`CONVERSATION_MEMORY_SCOPE=global` に設定して再起動すると、許可ユーザーがすべてのチャンネルの記憶を検索・閲覧でき、別チャンネルでの応答にも使われます。
