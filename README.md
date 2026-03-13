# Telegram 狼人杀机器人（小白可跑版）

这是一个 **简化版狼人杀 1.0** 的 MVP：

- 群里用命令玩：`/newgame`、`/join`、`/startgame`、`/vote`、`/tally`、`/end`
- WebApp（Telegram 小程序）是一个 **展示页**：显示房间状态与玩家存活情况

## 运行前准备（Windows）

1. 安装 Node.js（建议 LTS 版本）。
2. 在本项目目录运行依赖安装：
   - `npm install`
3. 创建 `.env`：
   - 复制 `.env.example` 为 `.env`
   - 填好 `BOT_TOKEN=...`

## 启动

- `npm run dev`

启动后：

- Bot 会以 long polling 方式运行
- Web 页面地址：`http://localhost:3000`

## WebApp（小程序）提示

Telegram 的 WebApp 按钮 **必须是公网 https 地址**。

本地开发建议使用 `ngrok` 或 `cloudflared` 把 `http://localhost:3000` 映射成 `https://xxx`，然后把：

- `.env` 里的 `PUBLIC_URL` 设置成该 `https://xxx`

之后在群里发 `/miniapp` 就能出现 “打开小程序” 的按钮。

