# Discord Codex Bot

`discord.js` と `@openai/codex-sdk` を使って、Discord からローカル Codex に会話を投げる Bot です。

## Setup

1. `npm install`
2. `.env.example` を `.env` にコピーして値を設定
3. `npm run dev`

進捗要約に通常のOpenAIモデルを使う場合は、`.env`に`OPENAI_API_KEY`を設定します。モデルは`PROGRESS_SUMMARY_MODEL`で変更でき、既定値は`gpt-6.2-sol`です。APIキーがない場合は、安全な固定文へ自動的にフォールバックします。

## Commands

- `@bot <prompt>`: Codex に会話を送る
- `@bot status`: セッション状態を確認
- `@bot reset`: セッションを破棄
- `@bot voice join`: 参加中のVCで議事録を開始
- `@bot voice leave`: 記録を終了して議事録を投稿
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

## ボイスチャンネルの議事録

1. 記録先のチャンネルで、許可ユーザーが対象VCに入った状態で `@bot voice join` を送ります。Bot はVCの内蔵チャットに記録開始を告知します。
2. 開始者か、記録対象のVCに参加中の許可ユーザーが `@bot voice leave` を送ると記録を終了します。音声接続が切れた場合も、取得済みの発言から議事録を作ります。
3. 要約と時刻・話者付きの発言録を、開始コマンドを送ったチャンネルへ Markdown ファイルで投稿します。要約が失敗した場合も発言録を返し、投稿に失敗した場合は `@bot voice leave` で再試行できます。

- 記録中は Bot を除く参加者の音声を OpenAI に送り、日本語で文字起こしします。音声はローカルファイルに保存せず、Bot を再起動すると記録中・投稿待ちのデータは失われます。
- `OPENAI_API_KEY` と Bot のVC接続・VC内蔵チャットへの投稿・開始チャンネルへのファイル添付権限が必要です。
- `REALTIME_SESSION_MODEL` と `REALTIME_TRANSCRIPTION_MODEL` は文字起こし、`MEETING_MINUTES_MODEL` は議事録の要約に使います。
- VC内蔵チャットの Bot コマンドは議事録専用です。Codex はテキストチャンネルで使えます。

# 会話の長期記憶

テキストチャンネルでは、会話の要点候補と詳細を `data/conversation-memory.json` に保存します。関連候補は最大4件です。Bot宛ての `memory search <検索語>` と `memory open <ID>` で要約から詳細・子ノードへたどれます。

既定では保存元チャンネル内だけを検索します。`CONVERSATION_MEMORY_SCOPE=global` に設定して再起動すると、許可ユーザーがすべてのチャンネルの記憶を検索・閲覧でき、別チャンネルでの応答にも使われます。

# Cloudflare Access のサイト取得

`.env` の `CF_SERVICE_TOKENS` にホスト名とサービス​​トークンを設定すると、許可ユーザーが `@Bot fetch https://example.domain/path` で取得できます。取得結果は依頼者にDMで送ります。HTTPSの登録ホストにだけ認証ヘッダーを付け、リダイレクトは追跡しません。

通常のCodexテキスト依頼でも「https://example.domain/path を読んで要約して」のように指定できます。取得結果はDM、Codexの回答は依頼元チャンネルに届きます。HTMLは `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN`（Browser Run - Edit）を使用してBrowser Runへ送信し、Markdownに変換します。取得HTMLは最大512 KiB、変換結果は先頭8 KiBです。
