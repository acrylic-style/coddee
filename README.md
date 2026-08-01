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
