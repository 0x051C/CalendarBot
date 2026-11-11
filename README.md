# CalendarBot

[![CI](https://github.com/0x051C/CalendarBot/actions/workflows/ci.yml/badge.svg)](https://github.com/0x051C/CalendarBot/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)

A Discord bot that turns a server's **Scheduled Events** into something people actually show up to.
It posts a reminder shortly before each event, @mentions everyone who marked themselves as interested,
lets members RSVP with buttons, and keeps an up-to-date **iCalendar (`.ics`) feed** of the server's
events that can be imported into Google Calendar, Apple Calendar, Outlook, or any phone calendar app.

## Features

- **Event reminders**: N minutes before an event starts, the bot posts an alert in the first text
  channel it can write to. The alert includes a link to the event, a relative countdown
  (`<t:…:R>`), and mentions for every subscriber.
- **RSVP buttons**: *Will join* / *Can't join* buttons update a live attendee list in the
  message embed. An *Event link* button jumps straight to the voice/stage channel.
- **Creator cancel**: if the event's creator presses *Can't join*, the event is deleted and the
  alert is marked as cancelled.
- **iCalendar export**: one `.ics` file per server, regenerated on every create, update, and delete.
  Updates bump the event `SEQUENCE` and mark it `TENTATIVE`; deletions are kept as `CANCELLED`, so
  subscribed calendar clients pick up changes instead of showing stale entries.
- **`/alert [minutes]` slash command**: view or change the reminder lead time at runtime. All
  pending reminders are rescheduled immediately.
- **Graceful degradation**: if the bot lacks *Embed Links* it falls back to plain text with buttons.
  If components fail, it falls back to a plain message. Permission diagnostics are logged per server.
- **Long-range scheduling**: reminders for events more than ~24.8 days away work despite the
  32-bit `setTimeout` limit, by chaining timers.

## How it works

```text
Discord Gateway ──► index.ts (event wiring)
                       │
                       ▼
             EventHandler (src/calendar/event_handler.ts)
               ├─ keeps one ICalCalendar per guild ──► write_file.ts ──► ICAL_PATH/<guild>/<file>.ics
               ├─ schedules a GuildScheduledEventAlert per event (src/calendar/alert.ts)
               │     └─ fires at (start − lead time): posts embed + RSVP buttons
               ├─ handles button interactions (RSVP / creator cancel)
               └─ handles /alert slash command
```

| Path | Responsibility |
| --- | --- |
| `index.ts` | Logs in and routes gateway events / interactions to the handler |
| `src/calendar/event_handler.ts` | Per-guild state: calendars, alerts, slash command registration, button handling |
| `src/calendar/alert.ts` | A single scheduled reminder: timer management and message composition |
| `src/calendar/convert_event_data.ts` | Maps a Discord `GuildScheduledEvent` to `ical-generator` event data |
| `src/env_config.ts` | Environment-based configuration |
| `src/write_file.ts` | Writes calendar files to disk |

## Getting started

### 1. Create the Discord application

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications)
   and add a bot user.
2. Under **Bot → Privileged Gateway Intents**, enable **Server Members Intent** and
   **Message Content Intent**.
3. Invite the bot with the `bot` and `applications.commands` scopes and these permissions:
   *View Channels*, *Send Messages*, *Embed Links*, *Manage Events* (needed for creator-cancel).

### 2. Run locally

Requires [Bun](https://bun.sh) 1.x.

```bash
git clone https://github.com/0x051C/CalendarBot.git
cd CalendarBot
bun install
cp .env.example .env    # then set DISCORD_TOKEN
bun start               # or `bun dev` for watch mode
```

### 3. Or run with Docker

```bash
docker build -t calendarbot .
docker run -d --name calendarbot \
  -e DISCORD_TOKEN=your-token \
  -v calendarbot-data:/data \
  calendarbot
```

Tagged releases are also published to GHCR: `ghcr.io/0x051c/calendarbot:latest`.

### Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token (**required**) |
| `ALERT_LEAD_TIME` | `5` | Minutes before the event start to post the reminder |
| `ICAL_PATH` | `./ical` (`/data/ical` in Docker) | Directory for generated calendar files (one sub-folder per server) |
| `ICAL_EVENT_DURATION` | `1800` | Event length in seconds used for the calendar end time (Discord events often have none) |
| `CB_FILENAME` | `treehouse.ics` | File name of each server's calendar |

> **Tip:** serve `ICAL_PATH` with any static web server (nginx, Caddy, …) and subscribe to the URL
> from your calendar app to get a live, auto-updating feed of your server's events.

## Development

```bash
bun run typecheck   # strict TypeScript check
bun run build       # bundle to release/index.mjs (runs on Node ≥ 22)
node release/index.mjs
```

CI (GitHub Actions) runs the typecheck, bundle, and Docker build on every push and pull request.
Pushing a `v*` tag publishes the Docker image to GHCR and creates a GitHub Release.

## Tech stack

TypeScript (strict) · [Bun](https://bun.sh) · [discord.js v14](https://discord.js.org) ·
[ical-generator](https://github.com/sebbo2002/ical-generator) · Docker · GitHub Actions
