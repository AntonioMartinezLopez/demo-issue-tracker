# Issue Tracker

A minimal kanban-style issue tracker built with Next.js. Issues are stored in memory and reset on server restart.

## Setup

```bash
bun install
bun run dev
```

Open http://localhost:3000.

## API

- `GET /api/issues`
- `POST /api/issues` — `{ title, description?, status? }`
- `PATCH /api/issues/:id` — `{ title?, description?, status?, order? }`
- `DELETE /api/issues/:id`
- `PUT /api/columns/:status/reorder` — `{ orderedIds: string[] }`

## Claude code Plugin

IMPORTANT: Skills and hooks should be placed in the root repository directory, not inside the plugin directory itself. Everything in the root repository will get bundled into the plugin. This is is just for demo