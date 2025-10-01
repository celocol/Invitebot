# Invitebot

Invitebot is a Telegram bot for tracking and managing group invitations. It helps group owners and members visualize who is inviting new users and promotes group growth through friendly competition.

## Features

- **Automatic Invitation Tracking**: Records who invited whom when new members are added.
- **User Commands**
  - `/start` — Shows bot info and available commands.
  - `/help` — Displays help and usage.
  - `/misinvitaciones` — Shows your individual invite stats and position.
- **Admin Commands**
  - `/ranking` — Displays the top 10 inviters (admins only).
- **Temporary Messages**: Sends ephemeral greetings and ranking updates to reduce chat clutter.

## How It Works

When a member adds a new person to the Telegram group, Invitebot automatically logs the invitation, updates rankings, and provides statistics. Admins can see the group’s top inviters, while everyone can check their own stats.

## Installation

1. **Clone the repo:**
   ```sh
   git clone https://github.com/celocol/Invitebot.git
   cd Invitebot
   ```
2. **Install dependencies:**
   ```sh
   npm install
   ```
3. **Environment setup:**
   - Create a `.env` file with your Telegram bot token and MySQL database credentials:
     ```
     BOT_TOKEN=your-telegram-token
     DB_CONFIG_HOST=your-db-host
     DB_CONFIG_USER=your-db-user
     DB_CONFIG_PASSWORD=your-db-password
     DB_CONFIG_DATABASE=your-db-name
     DB_CONFIG_PORT=your-db-port
     ```
4. **Run the bot:**
   ```sh
   npm start
   ```

## Commands

| Command              | Description                                    | Who can use      |
|----------------------|------------------------------------------------|------------------|
| `/start`             | Info and commands                              | Everyone         |
| `/help`              | Help and usage                                 | Everyone         |
| `/misinvitaciones`   | View your invitation stats                     | Everyone         |
| `/ranking`           | See top 10 inviters (leaderboard)              | Admins only      |

## Database

Invitebot uses MySQL to store invitations and user rankings. Tables are automatically created on startup.

## License

MIT License © 2025 Celo Colombia

---

Feel free to contribute or open issues!